// Calque des sous-titres : à partir des groupes (mise en page + images de début/fin), dessine l'image demandée.
// Même code pour l'aperçu et l'export. Les atlas de mots sont rastérisés à la demande (groupe courant + suivant)
// et libérés ensuite : la mémoire reste bornée quelle que soit la durée de la vidéo.
import { rasterGroup, SS } from './text-raster.js';
import { groupState, PRESETS } from '../subs/anim.js';

/** @typedef {{ id: string, start: number, end: number, index: number, layout: ReturnType<typeof import('../subs/layout.js').layoutGroup> }} SubGroup */

export class SubtitleLayer {
  /** @param {{ family: string, weight?: number, preset?: string }} opt */
  constructor(opt) {
    this.family = opt.family; this.weight = opt.weight ?? 700;
    this.preset = PRESETS[opt.preset || 'pop rapide'] || PRESETS['pop rapide'];
    /** @type {SubGroup[]} */ this.groups = [];
    /** @type {Map<string, ReturnType<typeof rasterGroup>>} */ this.atlases = new Map();
    this.enabled = true;
  }

  /** @param {SubGroup[]} groups triés par début */
  setGroups(groups) { this.groups = groups; this.atlases.clear(); this._uploaded = null; }

  /** Groupe affiché à l'image `frame` (recherche dichotomique). */
  groupAt(frame) {
    let lo = 0, hi = this.groups.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1, g = this.groups[m];
      if (frame < g.start) hi = m - 1; else if (frame >= g.end) lo = m + 1; else return g;
    }
    return null;
  }

  _atlas(g) {
    let a = this.atlases.get(g.id);
    if (!a) {
      a = rasterGroup(g.layout.words, this.family, this.weight);
      this.atlases.set(g.id, a);
      // Mémoire bornée : on ne garde que les 4 derniers atlas.
      while (this.atlases.size > 4) this.atlases.delete(this.atlases.keys().next().value);
    }
    return a;
  }

  /**
   * @param {import('./compositor.js').Compositor} comp @param {number} frame image (décimale permise)
   * @param {number} fps
   */
  draw(comp, frame, fps) {
    if (!this.enabled) return;
    const g = this.groupAt(frame);
    if (!g) return;
    const atlas = this._atlas(g);
    const key = 'sub:' + g.id;
    comp.uploadSprite(key, atlas.canvas);
    // Prépare le groupe suivant pendant l'affichage de celui-ci (pas d'à-coup à l'apparition).
    const next = this.groups[this.groups.indexOf(g) + 1];
    if (next && frame >= next.start - fps) this._atlas(next);
    const keep = new Set([key]);
    if (next) keep.add('sub:' + next.id);
    for (const k of comp.sprites.keys()) if (k.startsWith('sub:') && !keep.has(k)) comp.releaseSprite(k);
    const st = groupState(g.layout, g, frame, fps, this.preset);
    if (!st) return;
    st.forEach((s, i) => comp.drawSprite(key, atlas.rects[i], s.x, s.y, s.scale, SS));
  }
}
