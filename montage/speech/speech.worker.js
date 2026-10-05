// Worker « parole » : téléchargement vérifié des modèles, chargement, transcription. Un seul modèle chargé à la fois.
// Messages entrants : { id, op: 'status'|'ensure'|'load'|'transcribe'|'unload'|'remove', ... } ; réponses { id, ok, result|error }.
import { getModel, modelStatus, ensureModel, removeModel } from './model-store.js';
import { Transcriber } from './asr.js';

/** @type {Transcriber | null} */
let current = null;
const ctx = /** @type {DedicatedWorkerGlobalScope} */ (/** @type {unknown} */ (self));

const ops = {
  async status({ model }) { return modelStatus(await getModel(model)); },
  async ensure({ model }, id) {
    let last = 0;
    await ensureModel(await getModel(model), (p) => {
      const now = performance.now();
      if (now - last > 200 || p.loaded === p.total) { last = now; ctx.postMessage({ id, progress: p }); }
    });
    return modelStatus(await getModel(model));
  },
  async load({ model, device }) {
    if (current && current.spec.id === model && current.device === device) return { ms: 0 };
    if (current) await current.dispose();
    current = new Transcriber(await getModel(model), device);
    try { return { ms: await current.load() }; } catch (e) { current = null; throw e; }
  },
  async transcribe({ audio, opt }) {
    if (!current) throw new Error('Aucun modèle chargé');
    return current.transcribe(audio, opt);
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
