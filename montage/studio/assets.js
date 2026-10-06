// Éléments de marque dans le Studio : manifeste en mémoire, lecteurs d'images (aperçu réduit ou pleine taille pour
// l'export) et PCM 48 kHz des sons (SFX, musiques, sons intégrés aux overlays). Tout reste sur l'appareil (OPFS).
import { loadManifest, brandFile, brandEvents } from '../brand/brand.js';
import { ensureAnalyzed } from '../brand/analyze.js';
import { openMedia } from '../render/frames.js';
import { decodeAudio } from '../lib/audio.js';
import { resample } from '../audio/resample.js';
import { Input, ALL_FORMATS, BlobSource } from '../vendor/mediabunny.min.mjs';

export const MIX_RATE = 48000;

export class BrandAssets extends EventTarget {
  constructor() {
    super();
    /** @type {import('../brand/brand.js').BrandManifest | null} */ this.manifest = null;
    this.readers = new Map(); this.pending = new Map(); this.pcmCache = new Map();
    brandEvents.addEventListener('change', () => this.load());
  }

  async load() {
    this.manifest = await loadManifest();
    this.dispatchEvent(new Event('change'));
    return this.manifest;
  }

  /** @param {string} id */
  get(id) { return this.manifest ? this.manifest.assets.find((a) => a.id === id) || null : null; }
  /** @param {string} kind */
  byKind(kind) { return this.manifest ? this.manifest.assets.filter((a) => a.kind === kind) : []; }

  /** Élément analysé (fps, images, couverture, retrait de fond). */
  async analyzed(id) {
    const a = this.get(id);
    if (!a) throw new Error('Élément de marque introuvable');
    const r = await ensureAnalyzed(/** @type {any} */ (a));
    Object.assign(a, r);
    return /** @type {any} */ (a);
  }

  /** Lecteur d'images, créé à la première demande (null tant qu'il se prépare). */
  readerSync(id, maxHeight = 0) {
    const key = id + ':' + maxHeight;
    if (this.readers.has(key)) return this.readers.get(key);
    if (!this.pending.has(key)) this.pending.set(key, this.reader(id, maxHeight).catch((e) => { console.warn('[assets]', e); return null; }));
    return null;
  }

  async reader(id, maxHeight = 0) {
    const key = id + ':' + maxHeight;
    if (this.readers.has(key)) return this.readers.get(key);
    const a = this.get(id);
    if (!a) return null;
    const m = await openMedia(await brandFile(a.file), a.file, { maxHeight: maxHeight || undefined, alpha: a.keying && a.keying.method === 'alpha' });
    this.readers.set(key, m.reader);
    this.pending.delete(key);
    this.dispatchEvent(new Event('reader'));
    return m.reader;
  }

  /** Son d'un élément (ou d'un overlay) en PCM 48 kHz, voies séparées. null si muet. */
  async pcm(id) {
    if (this.pcmCache.has(id)) return this.pcmCache.get(id);
    const a = this.get(id);
    if (!a) return null;
    const p = (async () => {
      const input = new Input({ source: new BlobSource(await brandFile(a.file)), formats: ALL_FORMATS });
      const track = await input.getPrimaryAudioTrack();
      if (!track) return null;
      const dec = await decodeAudio(track, 0, Infinity);
      if (!dec) return null;
      const b = dec.buffer;
      return Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, c) => (b.sampleRate === MIX_RATE ? b.getChannelData(c).slice() : resample(b.getChannelData(c), b.sampleRate, MIX_RATE)));
    })();
    this.pcmCache.set(id, p);
    return p;
  }

  closeReaders() {
    for (const r of this.readers.values()) r.close();
    this.readers.clear();
  }
}
