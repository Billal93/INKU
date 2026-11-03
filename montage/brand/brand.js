// Pack de marque (police, transitions, ouverture, abonne-toi, logo, SFX, musiques) : importé depuis l'appareil,
// stocké dans l'OPFS (jamais dans le dépôt public), exportable / importable en UN seul fichier ZIP pour passer
// d'un appareil à l'autre. Le manifeste mémorise le rôle de chaque fichier et sa méthode de retrait de fond.
import { readZip, writeZip } from './zip.js';

export const BRAND_SCHEMA = 'inku-brand', BRAND_VERSION = 1;
/** Événement « change » après chaque modification du pack (les panneaux se mettent à jour). */
export const brandEvents = new EventTarget();
export const KINDS = {
  font: 'Police', opening: 'Ouverture (explosion)', transition: 'Transition', subscribe: 'Abonne-toi', logo: 'Logo',
  overlay: 'Autre overlay', sfx: 'Son (SFX)', music: 'Musique', thumbnail: 'Miniature',
};

/** @typedef {{ id: string, kind: string, file: string, name: string, size: number, role?: string,
 *   keying?: { method: 'luma'|'chroma'|'alpha'|'none', lo?: number, hi?: number, color?: number[] }, keyingManual?: boolean, keyingWhy?: string,
 *   analysis?: any, analyzed?: number, fps?: number, frames?: number, width?: number, height?: number, duration?: number,
 *   hasAudio?: boolean, image?: boolean, lufs?: number, truePeakDb?: number, rate?: number }} BrandAsset */
/** @typedef {{ schema: string, version: number, name: string, font: { family: string, weight: number, file: string } | null, assets: BrandAsset[] }} BrandManifest */

/** Rôle probable d'un fichier d'après son nom et son type (modifiable ensuite). @param {string} name */
export function guessKind(name) {
  const n = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/\.(woff2?|ttf|otf)$/.test(n)) return { kind: 'font' };
  if (/abonn|subscri/.test(n)) return { kind: 'subscribe' };
  if (/explos|ouverture|opening|intro/.test(n)) return { kind: 'opening' };
  if (/transi/.test(n)) return { kind: 'transition' };
  if (/logo/.test(n)) return { kind: 'logo' };
  if (/\b(clic|click)/.test(n)) return { kind: 'sfx', role: 'click' };
  if (/\bpop/.test(n)) return { kind: 'sfx', role: 'pop' };
  if (/(musi|music|bgm|fond)/.test(n) && /\.(mp3|m4a|aac|wav|ogg|flac)$/.test(n)) return { kind: 'music' };
  if (/\.(mp3|m4a|aac|wav|ogg|flac)$/.test(n)) return { kind: 'sfx' };
  if (/\.(png|jpe?g|webp)$/.test(n)) return { kind: 'logo' };
  return { kind: 'overlay' };
}

/** Nom de famille d'une police à partir du nom de fichier (ex. « ClashDisplay-Bold.woff2 » → « Clash Display »). */
export function familyFromFile(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/[-_](bold|semibold|medium|regular|variable|black|light|extrabold|\d{3}).*$/i, '');
  return base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim();
}

async function dir(create = true) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('brand', { create });
}
async function filesDir(create = true) { return (await dir(create)).getDirectoryHandle('files', { create }); }

/** @returns {Promise<BrandManifest>} */
export async function loadManifest() {
  try {
    const f = await (await (await dir(false)).getFileHandle('brand.json')).getFile();
    return JSON.parse(await f.text());
  } catch { return { schema: BRAND_SCHEMA, version: BRAND_VERSION, name: 'Ma marque', font: null, assets: [] }; }
}
/** @param {BrandManifest} m */
async function saveManifest(m) {
  const h = await (await dir()).getFileHandle('brand.json', { create: true });
  const w = await h.createWritable();
  await w.write(JSON.stringify(m, null, 1)); await w.close();
  brandEvents.dispatchEvent(new Event('change'));
}

/** Lit un fichier du pack (Blob). @param {string} file */
export async function brandFile(file) {
  return (await (await filesDir(false)).getFileHandle(file)).getFile();
}

const safeName = (s) => s.normalize('NFC').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);

/**
 * Ajoute des fichiers au pack (ou un ZIP de pack complet).
 * @param {File[]} files
 * @returns {Promise<{ manifest: BrandManifest, added: BrandAsset[], warnings: string[] }>}
 */
export async function importBrandFiles(files) {
  const m = await loadManifest();
  const added = [], warnings = [];
  const fdir = await filesDir();
  const store = async (/** @type {string} */ name, /** @type {Blob} */ data) => {
    let file = safeName(name), k = 1;
    while (m.assets.some((a) => a.file === file) || (m.font && m.font.file === file)) file = safeName(name).replace(/(\.[^.]+)?$/, `-${++k}$1`);
    const w = await (await fdir.getFileHandle(file, { create: true })).createWritable();
    await w.write(data); await w.close();
    return file;
  };
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const entries = await readZip(f);
      const manEntry = entries.find((e) => e.name === 'brand.json');
      const zman = manEntry ? JSON.parse(new TextDecoder().decode(await manEntry.read())) : null;
      if (zman && zman.schema !== BRAND_SCHEMA) warnings.push('Le fichier brand.json du ZIP n\'est pas un pack INKU : rôles devinés d\'après les noms.');
      for (const e of entries) {
        if (e.name === 'brand.json' || e.name.endsWith('/')) continue;
        const data = new Blob([/** @type {BlobPart} */ (await e.read())]);
        const base = e.name.split('/').pop();
        const known = zman && zman.schema === BRAND_SCHEMA ? (zman.assets || []).find((a) => 'files/' + a.file === e.name || a.file === e.name) : null;
        const isFont = zman && zman.font && ('files/' + zman.font.file === e.name || zman.font.file === e.name);
        const file = await store(base, data);
        if (isFont || (!known && guessKind(base).kind === 'font')) {
          m.font = { family: (isFont && zman.font.family) || familyFromFile(base), weight: (isFont && zman.font.weight) || 700, file };
          continue;
        }
        const g = known || guessKind(base);
        const a = { ...g, id: crypto.randomUUID(), file, name: (known && known.name) || base, size: data.size };
        m.assets.push(a); added.push(a);
      }
      continue;
    }
    const g = guessKind(f.name);
    const file = await store(f.name, f);
    if (g.kind === 'font') { m.font = { family: familyFromFile(f.name), weight: 700, file }; continue; }
    const a = { ...g, id: crypto.randomUUID(), file, name: f.name, size: f.size };
    m.assets.push(a); added.push(a);
  }
  await saveManifest(m);
  return { manifest: m, added, warnings };
}

/** Change le rôle ou les réglages d'un élément. @param {string} id @param {Partial<BrandAsset>} patch */
export async function updateAsset(id, patch) {
  const m = await loadManifest();
  const a = m.assets.find((x) => x.id === id);
  if (a) Object.assign(a, patch);
  await saveManifest(m);
  return m;
}

/** @param {string} id */
export async function removeAsset(id) {
  const m = await loadManifest();
  const a = m.assets.find((x) => x.id === id);
  if (a) { try { await (await filesDir(false)).removeEntry(a.file); } catch { } m.assets = m.assets.filter((x) => x.id !== id); }
  await saveManifest(m);
  return m;
}

/** Exporte tout le pack en un seul ZIP (manifeste + fichiers). */
export async function exportBrandZip() {
  const m = await loadManifest();
  const files = [{ name: 'brand.json', data: new TextEncoder().encode(JSON.stringify(m, null, 1)) }];
  const list = [...(m.font ? [m.font.file] : []), ...m.assets.map((a) => a.file)];
  for (const f of list) files.push({ name: 'files/' + f, data: new Uint8Array(await (await brandFile(f)).arrayBuffer()) });
  return writeZip(files);
}

/**
 * Charge la police du pack dans document.fonts et vérifie qu'elle s'applique réellement.
 * @returns {Promise<{ ok: boolean, family: string | null, reason: string }>}
 */
export async function loadBrandFont() {
  const m = await loadManifest();
  if (!m.font) return { ok: false, family: null, reason: 'Aucune police dans le pack de marque.' };
  const { family, weight, file } = m.font;
  if (![...document.fonts].some((f) => f.family.replace(/["']/g, '') === family && f.status === 'loaded')) {
    const data = await (await brandFile(file)).arrayBuffer();
    const face = new FontFace(family, data, { weight: String(weight) });
    await face.load();
    document.fonts.add(face);
  }
  const { checkFont } = await import('../render/text-raster.js');
  const c = checkFont(family, weight);
  return { ok: c.ok, family, reason: c.reason };
}
