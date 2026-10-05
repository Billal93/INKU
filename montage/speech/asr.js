// Transcription (dans un worker) avec transformers.js 4.3 : Whisper (et, pour le banc d'essai, Moonshine, Cohere).
// Les fichiers viennent UNIQUEMENT du stockage local vérifié (model-store.js) : aucun réseau à l'inférence.
import { listModels, verifiedCache } from './model-store.js';
import { gunzip, ortWasmBinary, ORT_GLUE, wasmThreads, ort } from './runtime.js';
import { fileUrl } from './model-store.js';
import { nemoFeatures, parseVocab, ctcGreedyWords } from './nemo.js';

/** @type {typeof import('@huggingface/transformers') | null} */
let T = null;
/** transformers.js est stocké compressé (voir tools/montage-vendor.mjs) : chargé via une URL blob. */
async function transformers() {
  if (T) return T;
  const code = await (await gunzip('../vendor/transformers/transformers.js.gz')).text();
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try { T = await import(/* @vite-ignore */ url); } finally { URL.revokeObjectURL(url); }
  return T;
}

let configured = false;
async function configure() {
  if (configured) return;
  const { env } = await transformers();
  const models = await listModels();
  env.allowLocalModels = false;
  env.allowRemoteModels = true;   // nécessaire pour que transformers.js consulte le cache ; le réseau est bloqué ci-dessous
  env.useBrowserCache = false;
  // Garantie : transformers.js ne peut RIEN télécharger lui-même. Tout fichier de modèle doit venir du cache
  // vérifié ; une requête vers Hugging Face qui arrive jusqu'ici signale un fichier manquant dans models.json.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://huggingface.co/')) {
      return Promise.resolve(new Response('fichier de modèle non vérifié : ' + url, { status: 404 }));
    }
    return realFetch(input, init);
  };
  env.useCustomCache = true;
  env.customCache = /** @type {any} */ (verifiedCache(models));
  const onnx = /** @type {any} */ (env.backends.onnx);
  onnx.wasm.wasmBinary = await ortWasmBinary();
  onnx.wasm.wasmPaths = { mjs: ORT_GLUE };
  onnx.wasm.numThreads = wasmThreads();
  configured = true;
}

/** @typedef {{ w: string, t0: number, t1: number, conf?: number }} AsrWord */
/** @typedef {{ text: string, words: AsrWord[] | null, ms: number }} AsrResult */

export class Transcriber {
  /**
   * @param {import('./model-store.js').ModelSpec} spec
   * @param {'webgpu'|'wasm'|'auto'} device « auto » = répartition prévue par le modèle (ex. encodeur GPU + décodeur CPU)
   */
  constructor(spec, device) { this.spec = spec; this.device = device; this.pipe = null; }

  async load() {
    const t0 = performance.now();
    if (this.spec.kind === 'nemo-ctc') {
      // ONNX Runtime directement (pas de transformers.js) ; fichiers lus dans le stockage vérifié.
      const o = await ort();
      const cache = verifiedCache([this.spec]);
      const get = async (path) => { const r = await cache.match(fileUrl(this.spec, path)); if (!r) throw new Error('Fichier de modèle manquant : ' + path); return r; };
      this.vocab = parseVocab(await (await get('vocab.txt')).text());
      const bytes = new Uint8Array(await (await get('model.onnx')).arrayBuffer());
      const eps = this.device === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'];
      this.session = await o.InferenceSession.create(bytes, { executionProviders: eps, graphOptimizationLevel: 'all' });
      this.ort = o;
      return performance.now() - t0;
    }
    await configure();
    const { pipeline } = await transformers();
    this.pipe = await pipeline('automatic-speech-recognition', this.spec.repo, {
      revision: this.spec.revision, dtype: /** @type {any} */ (this.spec.dtype),
      device: /** @type {any} */ (this.device === 'auto' ? (this.spec.device || 'webgpu') : this.device),
    });
    return performance.now() - t0;
  }

  /**
   * Transcrit UN morceau (≤ 30 s pour Whisper).
   * @param {Float32Array} audio mono 16 kHz
   * @param {{ words?: boolean, temperature?: number, maxNewTokens?: number }} [opt]
   * @returns {Promise<AsrResult>}
   */
  async transcribe(audio, opt = {}) {
    const t0 = performance.now();
    const k = this.spec.kind;
    /** @type {any} */
    let out;
    if (k === 'nemo-ctc') {
      const f = nemoFeatures(audio);
      const o = this.ort;
      const r = await this.session.run({ audio_signal: new o.Tensor('float32', f.data, [1, 80, f.frames]), length: new o.Tensor('int64', BigInt64Array.from([BigInt(f.valid)]), [1]) });
      const lp = r.logprobs;
      const d = ctcGreedyWords(/** @type {Float32Array} */ (lp.data), lp.dims[1], lp.dims[2], this.vocab);
      lp.dispose && lp.dispose();
      // Les « pics » CTC marquent le début des mots ; la fin réelle est calculée ensuite sur l'énergie
      // (asr-post.ctcWordEnds) : t1 = fin du dernier pic, drapeau ctc.
      const words = d.words.map((w) => ({ w: w.w, t0: w.t0, t1: w.t1, conf: w.conf, ctc: true }));
      return { text: d.text, words: opt.words ? words : null, ms: performance.now() - t0 };
    }
    if (k === 'whisper') {
      const gen = /** @type {Record<string, any>} */ (opt.temperature ? { do_sample: true, temperature: opt.temperature, top_k: 0 } : {});
      if (opt.maxNewTokens) gen.max_new_tokens = opt.maxNewTokens;
      out = await this.pipe(audio, {
        language: 'french', task: 'transcribe',
        return_timestamps: opt.words && this.spec.wordTimestamps ? 'word' : false,
        chunk_length_s: audio.length > 30 * 16000 ? 30 : 0,
        ...gen,
      });
    } else if (k === 'cohere') {
      out = await this.pipe(audio, { language: 'fr' });
    } else {
      out = await this.pipe(audio);
    }
    const words = out.chunks ? out.chunks.map((/** @type {any} */ c) => ({ w: c.text, t0: c.timestamp[0], t1: c.timestamp[1] })) : null;
    return { text: String(out.text || '').trim(), words, ms: performance.now() - t0 };
  }

  async dispose() {
    if (this.pipe) { try { await this.pipe.dispose(); } catch { } }
    if (this.session) { try { await this.session.release(); } catch { } }
    this.pipe = null; this.session = null;
  }
}
