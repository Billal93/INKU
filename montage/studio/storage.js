// Stockage local privé : IndexedDB (métadonnées, projet) + OPFS (fichiers volumineux).
// Rien ne quitte l'appareil. Si OPFS est indisponible, les fichiers restent en mémoire pour la session.

const DB_NAME = 'inku-montage';
const DB_VERSION = 1;
let dbp = null;

function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k));
export const kvSet = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));
export const kvDel = (k) => tx('kv', 'readwrite', (s) => s.delete(k));
export const srcGetAll = () => tx('sources', 'readonly', (s) => s.getAll());
export const srcPut = (rec) => tx('sources', 'readwrite', (s) => s.put(rec));
export const srcDel = (id) => tx('sources', 'readwrite', (s) => s.delete(id));

export function opfsAvailable() {
  return !!(navigator.storage && navigator.storage.getDirectory);
}

async function dir(name) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

// Lit un fichier du stockage privé (kind: 'media' | 'proxy'). Retourne un File ou null.
export async function opfsRead(kind, id) {
  if (!opfsAvailable()) return null;
  try {
    const d = await dir(kind);
    const fh = await d.getFileHandle(id);
    return await fh.getFile();
  } catch (e) { return null; }
}

export async function opfsRemove(kind, id) {
  if (!opfsAvailable()) return;
  try { const d = await dir(kind); await d.removeEntry(id); } catch (e) { /* absent */ }
}

export async function usage() {
  try {
    const est = await navigator.storage.estimate();
    return { used: est.usage || 0, quota: est.quota || 0 };
  } catch (e) { return { used: 0, quota: 0 }; }
}

export async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { /* ignoré */ }
  return false;
}
