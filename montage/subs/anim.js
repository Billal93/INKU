// Animations des sous-titres : fonctions PURES du temps (image décimale), aucune valeur arrondie, aucun palier.
// Brief 2.6 : pop normal 60 → 120 → 100 % en 6 images (3 de montée avec dépassement, 3 de retour) ; important
// 50 → 135 → 100 % ; impact 40 → 160 → 100 % puis tremblement 0,15 s (translation ±4 px, aucune rotation) ;
// zoom lent 100 → 103 % sur la durée du groupe ; bloc en mouvement CIRCULAIRE : rayon 5 px, période 1,6 s,
// translation uniquement, phase de départ différente à chaque groupe, sens alterné.

export const PRESETS = {
  'pop rapide': {
    pop: { normal: [0.6, 1.2], important: [0.5, 1.35], impact: [0.4, 1.6] }, rise: 3, settle: 3,
    shake: { sec: 0.15, px: 4 }, zoom: 0.03, circle: { radius: 5, period: 1.6 },
  },
  doux: {
    pop: { normal: [0.85, 1.06], important: [0.8, 1.12], impact: [0.7, 1.2] }, rise: 4, settle: 5,
    shake: { sec: 0, px: 0 }, zoom: 0.02, circle: { radius: 3, period: 2.4 },
  },
  aucun: {
    pop: { normal: [1, 1], important: [1, 1], impact: [1, 1] }, rise: 1, settle: 1,
    shake: { sec: 0, px: 0 }, zoom: 0, circle: { radius: 0, period: 1.6 },
  },
};

const easeOutCubic = (x) => 1 - (1 - x) ** 3;
const easeInOutSine = (x) => 0.5 - 0.5 * Math.cos(Math.PI * x);

/**
 * Échelle d'apparition d'un mot, k images après son apparition (k décimal possible).
 * @param {number} k @param {'normal'|'important'|'impact'|string} kind @param {typeof PRESETS['pop rapide']} p
 */
export function popScale(k, kind, p = PRESETS['pop rapide']) {
  const [from, peak] = p.pop[kind] || p.pop.normal;
  if (k <= 0) return from;
  if (k < p.rise) return from + (peak - from) * easeOutCubic(k / p.rise);
  if (k < p.rise + p.settle) return peak + (1 - peak) * easeInOutSine((k - p.rise) / p.settle);
  return 1;
}

/** Tremblement du texte impact (translation pure, amortie), en px. @param {number} k images depuis l'apparition @param {number} fps */
export function shake(k, fps, p = PRESETS['pop rapide']) {
  const start = p.rise + p.settle, len = p.shake.sec * fps;
  if (!len || k < start || k >= start + len) return { dx: 0, dy: 0 };
  const u = (k - start) / len, amp = p.shake.px * (1 - u);
  return { dx: amp * Math.sin(u * Math.PI * 7), dy: amp * Math.cos(u * Math.PI * 5) * 0.6 };
}

/** Phase de départ propre à chaque groupe (déterministe). @param {number} i */
export function groupPhase(i) {
  const x = Math.sin((i + 1) * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 * Math.PI;
}

/**
 * Transformation du bloc à un instant : décalage circulaire (px) et zoom lent.
 * @param {number} t secondes depuis l'apparition du groupe @param {number} dur durée du groupe (s) @param {number} i numéro du groupe
 */
export function blockMotion(t, dur, i, p = PRESETS['pop rapide']) {
  const dir = i % 2 === 0 ? 1 : -1;
  const a = groupPhase(i) + dir * (2 * Math.PI * t) / p.circle.period;
  const r = p.circle.radius;
  // Décalage relatif à la position de départ : le bloc démarre au centre exact puis décrit son cercle.
  const a0 = groupPhase(i);
  return {
    dx: r * (Math.cos(a) - Math.cos(a0)),
    dy: r * (Math.sin(a) - Math.sin(a0)),
    zoom: 1 + p.zoom * Math.min(1, Math.max(0, dur > 0 ? t / dur : 0)),
  };
}

/**
 * État complet d'un groupe à l'image `frame` (décimale) : pour chaque mot, échelle et position finales.
 * @param {{ words: { x: number, y: number, kind: string }[] }} layout mise en page du groupe
 * @param {{ start: number, end: number, index: number }} g images de début / fin (fin exclue)
 * @param {number} frame @param {number} fps @param {typeof PRESETS['pop rapide']} [p]
 */
export function groupState(layout, g, frame, fps, p = PRESETS['pop rapide']) {
  if (frame < g.start || frame >= g.end) return null;
  const k = frame - g.start, t = k / fps, dur = (g.end - g.start) / fps;
  const m = blockMotion(t, dur, g.index, p);
  const cx = 540, cy = 960;
  return layout.words.map((w) => {
    const s = popScale(k, w.kind, p) * m.zoom;
    const sh = w.kind === 'impact' ? shake(k, fps, p) : { dx: 0, dy: 0 };
    return {
      scale: s,
      x: cx + (w.x - cx) * m.zoom + m.dx + sh.dx,
      y: cy + (w.y - cy) * m.zoom + m.dy + sh.dy,
    };
  });
}
