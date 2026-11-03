// Voix nettoyée = suite de morceaux de la voix brute, posés bout à bout sur la timeline.
// - chaque morceau dure un nombre ENTIER d'images (aucune dérive : la voix reste calée à l'image près) ; l'arrondi se
//   fait dans la marge de silence, sans jamais déborder sur un mot coupé ni manger un mot gardé ;
// - les bords de coupe sont placés sur un minimum d'énergie puis un passage par zéro, avec un micro-fondu (5-10 ms) ;
// - la correspondance temps source ↔ timeline est EXACTE (table des coupes) : les mots, les sous-titres, les SFX se
//   recalculent sans approximation (leçon n°6 du brief).
// Fonctions pures, testées dans tests/unit/edits.test.mjs.

/**
 * @typedef {{ srcIn: number, srcOut: number, tl: number, frames: number, fadeIn: number, fadeOut: number }} Piece
 *   srcIn/srcOut en secondes sur la source, tl = image de début sur la timeline, frames = durée en images
 */

/**
 * @param {{ t0: number, t1: number, minOut?: number, maxOut?: number, minIn?: number, maxIn?: number }[]} segs
 *   passages gardés (source). minOut : le morceau ne peut pas finir avant (fin du dernier mot gardé) ; maxOut : ni après
 *   (début du mot coupé suivant). Idem pour le début.
 * @param {{ fps?: number, fadeMs?: number, startFrame?: number, snap?: (t: number, lo: number, hi: number) => number }} [opt]
 *   snap : déplace un bord de coupe vers le meilleur point (énergie minimale, passage par zéro) dans [lo, hi]
 * @returns {Piece[]}
 */
export function buildPieces(segs, opt = {}) {
  const fps = opt.fps ?? 30, fade = (opt.fadeMs ?? 8) / 1000;
  const snap = opt.snap || ((t) => t);
  const pieces = [];
  let tl = opt.startFrame ?? 0;
  for (const s of segs) {
    const minIn = s.minIn ?? s.t0 - 0.02, maxIn = s.maxIn ?? s.t0 + 0.02;
    const minOut = s.minOut ?? s.t1 - 0.02, maxOut = s.maxOut ?? s.t1 + 0.02;
    const srcIn = snap(s.t0, Math.max(0, Math.min(minIn, s.t0)), Math.max(maxIn, s.t0));
    let srcOut = snap(s.t1, Math.min(minOut, s.t1), Math.max(maxOut, s.t1));
    // Durée entière en images : on choisit l'arrondi (inférieur ou supérieur) qui reste dans [minOut, maxOut].
    const d = srcOut - srcIn;
    const lo = Math.floor(d * fps + 1e-9), hi = Math.ceil(d * fps - 1e-9);
    const cand = [Math.round(d * fps), lo, hi].filter((f) => f >= 1);
    let frames = cand.find((f) => srcIn + f / fps >= minOut - 1e-9 && srcIn + f / fps <= maxOut + 1e-9);
    if (frames === undefined) frames = Math.max(1, hi);         // marge trop étroite : on préfère ne rien couper du mot
    srcOut = srcIn + frames / fps;
    pieces.push({ srcIn, srcOut, tl, frames, fadeIn: fade, fadeOut: fade });
    tl += frames;
  }
  return pieces;
}

/** Temps source → temps timeline (secondes), ou null si ce passage a été coupé. @param {Piece[]} pieces @param {number} t @param {number} [fps] */
export function srcToTimeline(pieces, t, fps = 30) {
  for (const p of pieces) if (t >= p.srcIn - 1e-9 && t <= p.srcOut + 1e-9) return p.tl / fps + (t - p.srcIn);
  return null;
}

/** Temps timeline (s) → temps source (s), ou null hors voix. @param {Piece[]} pieces @param {number} T @param {number} [fps] */
export function timelineToSrc(pieces, T, fps = 30) {
  for (const p of pieces) {
    const a = p.tl / fps, b = (p.tl + p.frames) / fps;
    if (T >= a - 1e-9 && T < b - 1e-9) return p.srcIn + (T - a);
  }
  return null;
}

/**
 * Recalcule les mots gardés sur la timeline (temps exacts). Un mot à cheval sur une coupe est une erreur : il est
 * signalé (ne doit jamais arriver si les coupes respectent les bornes des mots).
 * @param {{ w: string, t0: number, t1: number }[]} words @param {Piece[]} pieces @param {number} [fps]
 */
export function mapWords(words, pieces, fps = 30) {
  const out = [], broken = [];
  words.forEach((w, i) => {
    const a = srcToTimeline(pieces, w.t0, fps), b = srcToTimeline(pieces, w.t1, fps);
    if (a === null && b === null) return;                      // mot coupé
    if (a === null || b === null || b - a > w.t1 - w.t0 + 1e-6) { broken.push(i); return; }
    out.push({ ...w, src: i, t0: a, t1: b });
  });
  return { words: out, broken };
}

/**
 * Rendu de la voix nettoyée : copie des morceaux, micro-fondus en cosinus aux raccords (pas aux extrémités
 * de la voix entière si le morceau commence à 0).
 * @param {Piece[]} pieces @param {Float32Array[]} channels source @param {number} fs @param {number} [fps]
 * @returns {Float32Array[]}
 */
export function renderPieces(pieces, channels, fs, fps = 30) {
  const total = pieces.length ? Math.round(((pieces[pieces.length - 1].tl + pieces[pieces.length - 1].frames) / fps) * fs) : 0;
  return channels.map((src) => {
    const out = new Float32Array(total);
    for (const p of pieces) {
      const o = Math.round((p.tl / fps) * fs), a = Math.round(p.srcIn * fs);
      const n = Math.min(Math.round((p.frames / fps) * fs), total - o);
      const fi = Math.round(p.fadeIn * fs), fo = Math.round(p.fadeOut * fs);
      for (let k = 0; k < n; k++) {
        let g = 1;
        if (k < fi) g = 0.5 - 0.5 * Math.cos(Math.PI * (k + 0.5) / fi);
        if (n - 1 - k < fo) g = Math.min(g, 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - k + 0.5) / fo));
        const v = src[a + k];
        out[o + k] = v === undefined ? 0 : v * g;
      }
    }
    return out;
  });
}

/**
 * Point de coupe optimal : minimum d'énergie (fenêtres de 5 ms) dans [lo, hi], puis passage par zéro le plus proche.
 * @param {Float32Array} x mono source @param {number} fs
 */
export function makeSnapper(x, fs) {
  const w = Math.max(1, Math.round(0.005 * fs));
  return (/** @type {number} */ t, /** @type {number} */ lo, /** @type {number} */ hi) => {
    const a = Math.max(0, Math.round(lo * fs)), b = Math.min(x.length - w, Math.round(hi * fs));
    if (b <= a) return t;
    let best = Math.round(t * fs), bestE = Infinity;
    for (let i = a; i <= b; i += Math.max(1, w >> 1)) {
      let e = 0; for (let k = 0; k < w; k++) e += x[i + k] * x[i + k];
      // Léger biais vers la position demandée pour ne pas sauter loin pour un gain d'énergie négligeable.
      e *= 1 + 0.5 * Math.abs(i + w / 2 - t * fs) / ((b - a) || 1);
      if (e < bestE) { bestE = e; best = i + (w >> 1); }
    }
    for (let d = 0; d < w; d++) for (const i of [best - d, best + d]) if (i > 0 && i < x.length && (x[i - 1] <= 0) !== (x[i] <= 0)) return i / fs;
    return best / fs;
  };
}
