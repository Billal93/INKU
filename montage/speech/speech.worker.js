// Worker « parole » : téléchargement vérifié des modèles, chargement, transcription, analyse complète d'une voix.
// Un seul modèle de transcription chargé à la fois.
// Messages entrants : { id, op, ... } ; réponses { id, ok, result|error } et { id, progress }.
import { getModel, modelStatus, ensureModel, removeModel, verifiedCache, fileUrl } from './model-store.js';
import { Transcriber } from './asr.js';
import { ort } from './runtime.js';
import { analyzeVoice, verifyCleanVoice } from './voice-pipeline.js';

/** @type {Transcriber | null} */
let current = null;
let vad = /** @type {{ ort: any, session: any } | null} */ (null);
const ctx = /** @type {DedicatedWorkerGlobalScope} */ (/** @type {unknown} */ (self));

async function loadVad() {
  if (vad) return vad;
  const spec = await getModel('silero-vad');
  await ensureModel(spec);
  const resp = await verifiedCache([spec]).match(fileUrl(spec, spec.files[0].path));
  if (!resp) throw new Error('Modèle de détection de parole indisponible');
  const o = await ort();
  // Petit modèle appelé des milliers de fois (une trame de 32 ms par appel) : un seul fil, sans coût de synchronisation.
  const session = await o.InferenceSession.create(new Uint8Array(await resp.arrayBuffer()), { executionProviders: ['wasm'], intraOpNumThreads: 1, interOpNumThreads: 1 });
  vad = { ort: o, session };
  return vad;
}

async function load(model, device) {
  if (current && current.spec.id === model && current.device === device) return { ms: 0 };
  if (current) await current.dispose();
  current = new Transcriber(await getModel(model), device);
  try { return { ms: await current.load() }; } catch (e) { current = null; throw e; }
}

const ops = {
  async status({ model }) { return modelStatus(await getModel(model)); },
  async ensure({ model }, id) {
    let last = 0;
    await ensureModel(await getModel(model), (p) => {
      const now = performance.now();
      if (now - last > 200 || p.loaded === p.total) { last = now; ctx.postMessage({ id, progress: { stage: 'Téléchargement du modèle', ...p } }); }
    });
    return modelStatus(await getModel(model));
  },
  async load({ model, device }) { return load(model, device); },
  async transcribe({ audio, opt }) {
    if (!current) throw new Error('Aucun modèle chargé');
    return current.transcribe(audio, opt);
  },
  async analyze({ pcm, sampleRate, model, device, glossary, settings }, id) {
    const t0 = performance.now();
    ctx.postMessage({ id, progress: { stage: 'Préparation des modèles', done: 0, total: 1 } });
    await ops.ensure({ model }, id);
    const v = await loadVad();
    const loadInfo = await load(model, device || 'auto');
    const r = await analyzeVoice({
      pcm, sampleRate, transcriber: current, vad: v, glossary, settings,
      onProgress: (p) => ctx.postMessage({ id, progress: p }),
    });
    return { ...r, model, device: device || 'auto', loadMs: Math.round(loadInfo.ms), wallMs: Math.round(performance.now() - t0) };
  },
  async verify({ pcm, sampleRate, model, device, expected }, id) {
    ctx.postMessage({ id, progress: { stage: 'Vérification de la voix nettoyée', done: 0, total: 1 } });
    await ops.ensure({ model }, id);
    const v = await loadVad();
    await load(model, device || 'auto');
    return verifyCleanVoice({ pcm, sampleRate, expected, transcriber: current, vad: v });
  },
  async unload() { if (current) await current.dispose(); current = null; return true; },
  async remove({ model }) { if (current && current.spec.id === model) { await current.dispose(); current = null; } await removeModel(await getModel(model)); return true; },
};

ctx.onmessage = async (e) => {
  const { id, op, ...args } = e.data;
  try {
    const result = await ops[op](args, id);
    ctx.postMessage({ id, ok: true, result });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
