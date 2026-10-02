// Sauvegarde automatique continue du projet (EDL + historique) dans IndexedDB ; reprise exacte au chargement.
import { kvGet, kvSet } from './storage.js';
import { migrate, validate } from './edl.js';

const KEY = 'project:current';

export async function loadSaved() {
  try {
    const data = await kvGet(KEY);
    if (!data || !data.doc) return null;
    const doc = migrate(JSON.parse(data.doc));
    const problems = validate(doc);
    if (problems.length) { console.warn('[persist] projet sauvegardé invalide :', problems); return null; }
    return data;
  } catch (e) { console.warn('[persist] lecture', e); return null; }
}

export function startAutosave(store, onState) {
  let timer = null;
  const save = async () => {
    timer = null;
    try { await kvSet(KEY, store.serialize()); onState && onState('saved'); }
    catch (e) { console.warn('[persist] écriture', e); onState && onState('error', e); }
  };
  const unsub = store.subscribe((kind) => {
    if (kind !== 'doc' && kind !== 'playhead') return;
    onState && onState('dirty');
    clearTimeout(timer);
    timer = setTimeout(save, kind === 'playhead' ? 1500 : 400);
  });
  // Dernier recours à la fermeture : on tente une écriture immédiate.
  const flush = () => { if (timer) { clearTimeout(timer); save(); } };
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  return () => { unsub(); clearTimeout(timer); };
}
