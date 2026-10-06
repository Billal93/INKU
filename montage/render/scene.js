// Scène : ce qu'on voit à l'image N, dans l'ordre des calques de la méthode (§ 2.5), du bas vers le haut :
//   1. fond (clip recadré 9:16, ou paysage sur fond flou : climax, miniature)   2. transition   3. ouverture
//   4. logo   5. abonne-toi (et autres overlays)   6. copyright   7. sous-titres (toujours tout en haut).
// `needs(doc, f)` dit quelles images décoder ; `draw(comp, doc, f, media)` compose de façon SYNCHRONE et pure.
// L'aperçu (lecteur) et l'export (rendu final) appellent exactement ces deux fonctions.
import { SubtitleLayer } from './subtitle-layer.js';
import { makeMeasure, SS } from './text-raster.js';
import { layoutGroup, baseFontSize } from '../subs/layout.js';
import { cropWindow, clipEnd } from '../studio/edl.js';
import { overlayFrameAt, contentEnd, subtitlesHiddenUntil, ROLE_Z, fitBox } from '../studio/overlays.js';

export const COPYRIGHT_DEFAULT = { enabled: true, text: '', size: 24, opacity: 0.8, bottom: 14 };

/** Le fond d'un clip V1 est-il composé « paysage au centre sur fond flou » ? */
export function isFitBlur(clip, src) {
  if (clip.layout === 'fit-blur') return true;
  if (clip.layout === 'crop') return false;
  // Image fixe (miniature) qui n'est pas en 9:16 : jamais déformée → fond flou.
  if (src && src.kind === 'image') return Math.abs(src.width / src.height - 9 / 16) > 0.01;
  return false;
}

export class Scene {
  constructor() {
    this.font = { family: 'Plus Jakarta Sans', weight: 800, brand: false };
    this.subs = null; this.subsKey = ''; this.subsBase = 0;
    this.copyKey = '';
  }

  setFont(font) { this.font = font; this.subsKey = ''; this.copyKey = ''; }

  /** Image du fond à l'image `frame` : clip V1 et temps dans la source (null = noir). */
  bgAt(doc, frame) {
    const tr = doc.tracks.find((x) => x.id === 'V1');
    if (tr && tr.muted) return null;
    const clip = doc.clips.find((c) => c.track === 'V1' && frame >= c.start && frame < c.start + c.dur);
    if (!clip) return null;
    return { clip, srcId: clip.srcId, t: clip.srcIn + (frame - clip.start) / doc.project.fps };
  }

  /** Overlays visibles à l'image `frame`, triés par calque. */
  overlaysAt(doc, frame) {
    const tr = doc.tracks.find((x) => x.id === 'V2');
    if (tr && tr.muted) return [];
    const end = contentEnd(doc);
    const out = [];
    for (const c of doc.clips) {
      if (c.track !== 'V2' || !c.assetId) continue;
      const index = overlayFrameAt(c, frame, end);
      if (index < 0) continue;
      const k = frame - c.start;
      out.push({ clip: c, assetId: c.assetId, index, t: (index + 0.5) / (c.assetFps || 30), cover: !!(c.cover && k >= c.cover[0] && k <= c.cover[1]) });
    }
    return out.sort((a, b) => (ROLE_Z[a.clip.role] ?? 4) - (ROLE_Z[b.clip.role] ?? 4) || a.clip.start - b.clip.start);
  }

  /** Médias à décoder pour l'image `frame`. */
  needs(doc, frame) { return { bg: this.bgAt(doc, frame), overlays: this.overlaysAt(doc, frame) }; }

  /** Calque des sous-titres (recalculé seulement si T1, la police ou l'ouverture ont changé). */
  subtitleLayer(doc) {
    const t1 = doc.tracks.find((t) => t.id === 'T1');
    if (t1 && t1.muted) return null;
    const clips = doc.clips.filter((c) => c.track === 'T1' && c.sub).sort((a, b) => a.start - b.start);
    const hide = subtitlesHiddenUntil(doc);
    const key = this.font.family + '|' + hide + '|' + ((doc.subtitles && doc.subtitles.preset) || '') + '|' + JSON.stringify(clips.map((c) => [c.id, c.start, c.dur, c.sub.words]));
    if (key !== this.subsKey) {
      this.subsKey = key;
      if (!clips.length) { this.subs = null; return null; }
      const measure = makeMeasure(this.font.family, this.font.weight);
      const all = clips.flatMap((c) => c.sub.words);
      const base = baseFontSize(all.filter((w) => w.kind === 'important').map((w) => w.w), all.map((w) => w.w), measure, { impactWords: all.filter((w) => w.kind === 'impact').map((w) => w.w) });
      this.subs = new SubtitleLayer({ family: this.font.family, weight: this.font.weight, preset: (doc.subtitles && doc.subtitles.preset) || 'pop rapide' });
      // Ouverture : un groupe qui commencerait sous l'explosion apparaît (avec son pop) quand le plan est découvert.
      const groups = clips.map((c, i) => ({ id: c.id + ':' + i, index: c.sub.index ?? i, start: Math.max(c.start, hide), end: clipEnd(c), layout: layoutGroup(c.sub.words, base, measure) })).filter((g) => g.end > g.start);
      this.subs.setGroups(groups);
      this.subsBase = base;
    }
    return this.subs;
  }

  /** Ligne de copyright : petite, blanche à 80 %, ombre discrète, centrée, à ~14 px du bas. */
  _copyright(comp, doc) {
    const cfg = { ...COPYRIGHT_DEFAULT, ...(doc.copyright || {}) };
    if (!cfg.enabled || !cfg.text) return;
    const key = 'copy:' + this.font.family + ':' + cfg.size + ':' + cfg.text;
    if (key !== this.copyKey || !comp.sprites.has(key)) {
      for (const k of [...comp.sprites.keys()]) if (k.startsWith('copy:') && k !== key) comp.releaseSprite(k);
      const px = cfg.size * SS, pad = 6 * SS;
      const m = new OffscreenCanvas(8, 8).getContext('2d');
      m.font = `${Math.min(700, this.font.weight)} ${px}px "${this.font.family}"`;
      const tm = m.measureText(cfg.text);
      const w = Math.ceil(tm.width) + 2 * pad, h = Math.ceil(px * 1.3) + 2 * pad;
      const cv = new OffscreenCanvas(w, h);
      const g = cv.getContext('2d');
      g.font = m.font; g.textBaseline = 'alphabetic'; g.textAlign = 'center';
      g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 2 * SS; g.shadowOffsetY = 1 * SS;
      g.fillStyle = '#FFFFFF';
      const base = pad + px;
      g.fillText(cfg.text, w / 2, base);
      comp.uploadSprite(key, cv);
      this.copyKey = key;
      this.copyRect = { x: 0, y: 0, w, h, cx: w / 2, cy: base, ascent: tm.actualBoundingBoxAscent, descent: tm.actualBoundingBoxDescent };
    }
    const r = this.copyRect;
    // Bord inférieur des lettres à `bottom` px du bas de l'image.
    comp.drawSprite(key, r, 540, 1920 - cfg.bottom - r.descent / SS, 1, SS, cfg.opacity);
  }

  /**
   * Compose l'image `frame` (synchrone). Les images décodées sont fournies par l'appelant :
   * media.bg = { canvas, toCanvas(rect) → rect dans le canvas décodé, usable } ; media.overlays = Map(clipId → canvas).
   * @param {import('./compositor.js').Compositor} comp @param {any} doc @param {number} frame
   * @param {{ bg?: { canvas: any, toCanvas: (r: any) => any, usable: any, src?: any } | null, overlays?: Map<string, any>, assets?: Map<string, any> }} media
   */
  draw(comp, doc, frame, media) {
    comp.begin();
    const fps = doc.project.fps;
    const bg = this.bgAt(doc, frame);
    if (bg && media.bg && media.bg.canvas) {
      const clip = bg.clip;
      if (isFitBlur(clip, media.bg.src)) comp.drawFitBlur(media.bg.canvas, media.bg.toCanvas(media.bg.usable));
      else comp.drawClip(media.bg.canvas, media.bg.toCanvas(cropWindow(clip, frame - clip.start, media.bg.usable)));
    }
    for (const o of this.overlaysAt(doc, frame)) {
      const cv = media.overlays && media.overlays.get(o.clip.id);
      if (!cv) continue;
      const w = cv.displayWidth || cv.width, h = cv.displayHeight || cv.height;
      const box = o.clip.place || (Math.abs(w / h - 9 / 16) > 0.01 ? fitBox(w, h) : null);
      comp.drawKeyedOverlay(cv, o.clip.keying || { method: 'luma' }, { cover: o.cover, box });
    }
    this._copyright(comp, doc);
    // Pas de sous-titres pendant la fin de vidéo (climax, miniature).
    if (!(bg && (bg.clip.role === 'climax' || bg.clip.role === 'thumbnail'))) {
      const subs = this.subtitleLayer(doc);
      if (subs) subs.draw(comp, frame, fps);
    }
  }
}
