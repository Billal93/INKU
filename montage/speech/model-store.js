// Stockage local des modèles d'IA (à utiliser DANS un worker : écriture OPFS par createSyncAccessHandle,
// seule voie d'écriture disponible partout, Safari compris).
// - Téléchargement depuis Hugging Face à une révision figée (models.json), reprise d'un téléchargement interrompu
//   (en-tête Range), SHA-256 calculé pendant l'écriture : un fichier dont l'empreinte diffère est supprimé.
// - Sert ensuite les fichiers vérifiés à transformers.js via `env.customCache` : aucun accès réseau à l'inférence.
import { Sha256 } from './sha256.js';

export const HF = 'https://huggingface.co';
// Référence capturée au chargement : asr.js bloque ensuite fetch() vers Hugging Face pour transformers.js.
const netFetch = globalThis.fetch.bind(globalThis);

/** @typedef {{ path: string, size: number, sha256: string }} ModelFile */
/** @typedef {{ id: string, label: string, repo: string, revision: string, task: string, kind: string, license: string,
 *   dtype?: Record<string, string>, device?: Record<string, string>, files: ModelFile[], totalMB: number, lang?: string, wordTimestamps?: boolean }} ModelSpec */

let registry = /** @type {Promise<{ models: ModelSpec[] }> | null} */ (null);
/** @returns {Promise<ModelSpec[]>} */
export async function listModels() {
  registry ||= fetch(new URL('./models.json', import.meta.url)).then((r) => r.json());
  return (await registry).models;
}
/** @param {string} id */
export async function getModel(id) {
  const m = (await listModels()).find((x) => x.id === id);
  if (!m) throw new Error('Modèle inconnu : ' + id);
  return m;
}

/** URL de téléchargement figée, identique à celle que transformers.js construit (clé du cache). */
export const fileUrl = (/** @type {ModelSpec} */ m, /** @type {string} */ path) => `${HF}/${m.repo}/resolve/${m.revision}/${path}`;

/** @param {ModelSpec} m */
async function modelDir(m, create = true) {
  let d = await navigator.storage.getDirectory();
  for (const part of ['models', m.repo.replace('/', '__') + '@' + m.revision.slice(0, 12)]) d = await d.getDirectoryHandle(part, { create });
  return d;
}
/** @param {FileSystemDirectoryHandle} dir @param {string} path */
async function fileHandle(dir, path, create) {
  const parts = path.split('/');
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

/** Fichiers déjà vérifiés (marqueur `<fichier>.ok` contenant l'empreinte). @param {ModelSpec} m */
export async function modelStatus(m) {
  let have = 0, bytes = 0;
  try {
    const dir = await modelDir(m, false);
    for (const f of m.files) {
      try {
        const ok = await (await (await fileHandle(dir, f.path + '.ok', false)).getFile()).text();
        if (ok === f.sha256) { have++; bytes += f.size; }
      } catch { }
    }
  } catch { }
  return { complete: have === m.files.length, files: have, bytes, total: m.files.reduce((a, f) => a + f.size, 0) };
}

/**
 * Télécharge et vérifie tous les fichiers manquants d'un modèle.
 * @param {ModelSpec} m
 * @param {(p: { file: string, loaded: number, total: number }) => void} [onProgress] progression globale en octets
 * @param {AbortSignal} [signal]
 */
export async function ensureModel(m, onProgress, signal) {
  const dir = await modelDir(m);
  const total = m.files.reduce((a, f) => a + f.size, 0);
  let doneBytes = 0;
  for (const f of m.files) {
    try {
      const ok = await (await (await fileHandle(dir, f.path + '.ok', false)).getFile()).text();
      if (ok === f.sha256) { doneBytes += f.size; onProgress && onProgress({ file: f.path, loaded: doneBytes, total }); continue; }
    } catch { }
    await downloadFile(m, dir, f, (n) => onProgress && onProgress({ file: f.path, loaded: doneBytes + n, total }), signal);
    doneBytes += f.size;
  }
}

/** @param {ModelSpec} m @param {FileSystemDirectoryHandle} dir @param {ModelFile} f @param {(n:number)=>void} progress @param {AbortSignal} [signal] */
async function downloadFile(m, dir, f, progress, signal) {
  const fh = await fileHandle(dir, f.path, true);
  const access = await fh.createSyncAccessHandle();
  try {
    // Reprise : on rehache ce qui est déjà écrit, puis on demande la suite (Range).
    let hash = new Sha256();
    let have = access.getSize();
    if (have > f.size) { access.truncate(0); have = 0; }
    const chunk = new Uint8Array(4 << 20);
    for (let pos = 0; pos < have;) {
      const n = access.read(chunk.subarray(0, Math.min(chunk.length, have - pos)), { at: pos });
      if (n <= 0) break;
      hash.update(chunk.subarray(0, n)); pos += n;
    }
    progress(have);
    if (have < f.size) {
      const resp = await netFetch(fileUrl(m, f.path), { headers: have ? { Range: `bytes=${have}-` } : {}, signal, cache: 'no-store' });
      if (!(resp.ok || resp.status === 206)) throw new Error(`Téléchargement refusé (${resp.status}) : ${f.path}`);
      if (have && resp.status !== 206) { access.truncate(0); have = 0; hash = new Sha256(); }
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        access.write(value, { at: have });
        hash.update(value);
        have += value.length;
        progress(have);
      }
      access.flush();
    }
    const got = hash.hex();
    if (have !== f.size || got !== f.sha256) {
      access.truncate(0);
      throw new Error(`Fichier corrompu ou modifié (${f.path}) : empreinte ${got.slice(0, 12)}… attendue ${f.sha256.slice(0, 12)}…`);
    }
  } finally { access.close(); }
  const okh = await (await fileHandle(dir, f.path + '.ok', true)).createSyncAccessHandle();
  try { okh.truncate(0); okh.write(new TextEncoder().encode(f.sha256), { at: 0 }); okh.flush(); } finally { okh.close(); }
}

/** Supprime un modèle de l'appareil. @param {ModelSpec} m */
export async function removeModel(m) {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('models', { create: true });
  try { await root.removeEntry(m.repo.replace('/', '__') + '@' + m.revision.slice(0, 12), { recursive: true }); } catch { }
}

/**
 * Cache au format Web Cache API pour transformers.js : ne répond QUE pour les fichiers vérifiés des modèles
 * connus ; `put` est ignoré (aucun fichier non vérifié n'est jamais conservé).
 * @param {ModelSpec[]} models
 */
export function verifiedCache(models) {
  return {
    /** @param {string | Request} req */
    async match(req) {
      const url = typeof req === 'string' ? req : req.url;
      for (const m of models) {
        const prefix = `${HF}/${m.repo}/resolve/${m.revision}/`;
        if (!url.startsWith(prefix)) continue;
        const path = decodeURIComponent(url.slice(prefix.length));
        const f = m.files.find((x) => x.path === path);
        if (!f) return undefined;
        try {
          const dir = await modelDir(m, false);
          const ok = await (await (await fileHandle(dir, path + '.ok', false)).getFile()).text();
          if (ok !== f.sha256) return undefined;
          const file = await (await fileHandle(dir, path, false)).getFile();
          return new Response(file, { headers: { 'content-length': String(file.size) } });
        } catch { return undefined; }
      }
      return undefined;
    },
    async put() { },
  };
}
