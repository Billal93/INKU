// Descripteurs d'image (fonctions pures sur des pixels RGBA réduits) : point d'intérêt horizontal pour le cadrage 9:16,
// carton de texte, distance d'histogramme. Utilisés par l'analyse des sources (worker), les alertes de transition et
// la fin de vidéo. Pas de détection de visages : aucune API gratuite et commune à Safari/Chrome/Firefox (voir D21).

/**
 * Point d'intérêt horizontal (0 = bord gauche, 1 = bord droit) : centre de masse du contraste local (gradients de
 * luminosité), pondéré pour ignorer les bords vides. Un ciel ou un mur uni pèsent peu, un personnage beaucoup.
 * @param {Uint8ClampedArray | Uint8Array} d RGBA @param {number} w @param {number} h
 * @returns {{ x: number, spread: number, detail: number }}
 */
export function focusPoint(d, w, h) {
  const L = new Float32Array(w * h);
  for (let i = 0, p = 0; p < w * h; i += 4, p++) L[p] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const col = new Float64Array(w);
  let tot = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x;
    const g = Math.abs(L[p + 1] - L[p - 1]) + Math.abs(L[p + w] - L[p - w]);
    const e = g > 8 ? g : 0;   // le bruit de compression ne compte pas
    col[x] += e; tot += e;
  }
  if (tot <= 0) return { x: 0.5, spread: 1, detail: 0 };
  let m = 0;
  for (let x = 0; x < w; x++) m += (x + 0.5) / w * col[x];
  m /= tot;
  let v = 0;
  for (let x = 0; x < w; x++) v += ((x + 0.5) / w - m) ** 2 * col[x];
  return { x: m, spread: Math.sqrt(v / tot), detail: tot / ((w - 2) * (h - 2) * 255) };
}

/**
 * Position de la fenêtre 9:16 (crop.x de l'EDL, 0..1 dans la plage libre) qui centre le point d'intérêt.
 * @param {number} fx point d'intérêt (0..1 de la zone utile) @param {{ w: number, h: number }} usable
 */
export function cropXForFocus(fx, usable, outAspect = 9 / 16) {
  const ww = Math.min(1, (usable.h * outAspect) / usable.w);
  if (ww >= 1) return 0.5;
  return Math.max(0, Math.min(1, (fx - ww / 2) / (1 - ww)));
}

/**
 * Carton de texte (titre, crédits, date) : fond clair dominant avec peu d'encre, OU fond noir avec un peu de texte
 * clair et quasi aucun autre contenu (crédits). Seuils mesurés sur des images synthétiques et réelles (D21).
 * @returns {{ card: boolean, kind: 'clair'|'sombre'|null, bright: number, dark: number }}
 */
export function textCard(d, w, h) {
  let bright = 0, dark = 0, mid = 0, sat = 0;
  const n = w * h;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const s = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    if (l > 215) bright++; else if (l < 40) dark++; else mid++;
    if (s > 60) sat++;
  }
  bright /= n; dark /= n; mid /= n; sat /= n;
  if (bright > 0.7 && dark < 0.12) return { card: true, kind: 'clair', bright, dark };
  // Crédits : presque tout noir, un peu de blanc, pas de couleur ni de demi-teintes (une scène sombre en a).
  if (dark > 0.8 && bright > 0.004 && bright < 0.12 && mid < 0.1 && sat < 0.01) return { card: true, kind: 'sombre', bright, dark };
  return { card: false, kind: null, bright, dark };
}

/** Distance d'histogramme couleur (16 classes × 3 voies, normalisées) : 0 = identiques, 2 = disjoints. */
export function histDistance(a, b) {
  if (!a || !b) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / 3;
}

/** Histogramme 16×3 et luminosité moyenne. */
export function histogram(d, w, h, bins = 16) {
  const hist = new Float32Array(bins * 3);
  const sh = 8 - Math.log2(bins);
  let luma = 0;
  const n = w * h;
  for (let i = 0; i < d.length; i += 4) {
    hist[d[i] >> sh]++; hist[bins + (d[i + 1] >> sh)]++; hist[2 * bins + (d[i + 2] >> sh)]++;
    luma += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= n;
  return { hist, luma: luma / (n * 255) };
}
