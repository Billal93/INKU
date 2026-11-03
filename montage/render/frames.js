// Lecture d'images d'un média pour la composition (overlays de la marque, et sources au rendu final).
// Décodage SÉQUENTIEL quand les temps demandés avancent (un seul passage du décodeur, comme une lecture), sinon
// repositionnement. Une image fixe (PNG du logo, miniature) est décodée une seule fois.
import { Input, ALL_FORMATS, BlobSource, CanvasSink } from '../vendor/mediabunny.min.mjs';

export class FrameReader {
  /**
   * @param {any} track piste vidéo Mediabunny
   * @param {{ width?: number, height?: number, alpha?: boolean, crop?: any }} [o] taille de sortie (aperçu : réduite)
   */
  constructor(track, o = {}) {
    this.track = track;
    const opt = { poolSize: 0, alpha: !!o.alpha };
    if (o.width) Object.assign(opt, { width: Math.round(o.width), height: Math.round(o.height), fit: 'fill' });
    if (o.crop) opt.crop = o.crop;
    this.sink = new CanvasSink(track, opt);
    this.it = null; this.cur = null; this.next = null; this.lastT = -1;
    this.busy = null; this.peeked = null;
  }

  async _restart(t) {
    if (this.it && this.it.return) { try { await this.it.return(); } catch { /* fermé */ } }
    this.it = this.sink.canvases(Math.max(0, t))[Symbol.asyncIterator]();
    const a = await this.it.next();
    this.cur = a.done ? null : a.value;
    const b = this.cur ? await this.it.next() : { done: true };
    this.next = b.done ? null : b.value;
  }

  /** Image affichée au temps `t` (timestamp ≤ t < suivant). Séquentiel si t avance de moins de 2 s. */
  async at(t) {
    const eps = 1e-4;
    if (!this.it || t < this.lastT - eps || t - this.lastT > 2 || (this.cur && t < this.cur.timestamp - eps)) await this._restart(t);
    while (this.next && this.next.timestamp <= t + eps) {
      this.cur = this.next;
      const r = await this.it.next();
      this.next = r.done ? null : r.value;
    }
    this.lastT = t;
    return this.cur ? this.cur.canvas : null;
  }

  /** Non bloquant (lecture temps réel) : dernière image prête ; lance le décodage de `t` en arrière-plan. */
  peek(t) {
    if (!this.busy) {
      this.busy = this.at(t).then((c) => { this.peeked = c; }).catch(() => { }).finally(() => { this.busy = null; });
    }
    return this.peeked;
  }

  async close() { if (this.it && this.it.return) { try { await this.it.return(); } catch { /* fermé */ } } this.it = null; }
}

/** Image fixe : toujours la même image. */
export class StillReader {
  /** @param {ImageBitmap} bmp */
  constructor(bmp) { this.bmp = bmp; this.width = bmp.width; this.height = bmp.height; }
  async at() { return this.bmp; }
  peek() { return this.bmp; }
  async close() { this.bmp.close(); }
}

const IMG = /\.(png|jpe?g|webp|gif)$/i;

/**
 * Ouvre un fichier (Blob) : image fixe ou vidéo. Pour l'aperçu, `maxHeight` réduit la taille décodée.
 * @param {Blob} blob @param {string} name @param {{ maxHeight?: number, alpha?: boolean }} [o]
 * @returns {Promise<{ reader: FrameReader | StillReader, input?: any, track?: any, width: number, height: number, image: boolean }>}
 */
export async function openMedia(blob, name, o = {}) {
  if (IMG.test(name) || /^image\//.test(blob.type)) {
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
    return { reader: new StillReader(bmp), width: bmp.width, height: bmp.height, image: true };
  }
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error(`« ${name} » ne contient pas d'image`);
  const W = track.displayWidth, H = track.displayHeight;
  let alpha = !!o.alpha;
  try { alpha = alpha || await track.canBeTransparent(); } catch { /* ancienne version */ }
  const k = o.maxHeight && H > o.maxHeight ? o.maxHeight / H : 1;
  const reader = new FrameReader(track, { alpha, ...(k < 1 ? { width: W * k, height: H * k } : {}) });
  return { reader, input, track, width: W, height: H, image: false };
}
