// Transcription (dans un worker) avec transformers.js 4.3 : Whisper, Moonshine, Cohere Transcribe.
// Les fichiers viennent UNIQUEMENT du stockage local vérifié (model-store.js) : aucun réseau à l'inférence.
import { listModels, verifiedCache } from './model-store.js';

/** Fichier embarqué compressé (gzip) → contenu décompressé. @param {string} rel */
async function gunzip(rel) {
  const resp = await fetch(new URL(rel, import.meta.url));
  if (!resp.ok) throw new Error('Bibliothèque introuvable : ' + rel);
  return new Response(resp.body.pipeThrough(new DecompressionStream('gzip')));
}

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
  // Moteur WebAssembly d'ONNX Runtime : stocké compressé (27 → 7 Mo), décompressé une fois puis fourni en mémoire.
  onnx.wasm.wasmBinary = await (await gunzip('../vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm.gz')).arrayBuffer();
  onnx.wasm.wasmPaths = { mjs: new URL('../vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href };
  onnx.wasm.numThreads = globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  configured = true;
}

/**
 * @typedef {{ text: string, words: { w: string, t0: number, t1: number }[] | null, ms: number }} AsrResult
 */

export class Transcriber {
  /** @param {import('./model-store.js').ModelSpec} spec @param {'webgpu'|'wasm'} device */
  constructor(spec, device) { this.spec = spec; this.device = device; this.pipe = null; }

  async load() {
    await configure();
    const t0 = performance.now();
    const { pipeline } = await transformers();
    this.pipe = await pipeline('automatic-speech-recognition', this.spec.repo, {
      revision: this.spec.revision, device: this.device, dtype: /** @type {any} */ (this.spec.dtype),
    });
    return performance.now() - t0;
  }

  /**
   * @param {Float32Array} audio mono 16 kHz
   * @param {{ words?: boolean, prompt?: string }} [opt]
   * @returns {Promise<AsrResult>}
   */
  async transcribe(audio, opt = {}) {
    const t0 = performance.now();
    const k = this.spec.kind;
    /** @type {any} */
    let out;
    if (k === 'whisper') {
      out = await this.pipe(audio, {
        language: 'french', task: 'transcribe',
        return_timestamps: opt.words && this.spec.wordTimestamps ? 'word' : false,
        chunk_length_s: audio.length > 30 * 16000 ? 30 : 0,
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
    this.pipe = null;
  }
}
