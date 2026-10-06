// Retrait de fond des overlays et transitions (§ 2.5) : fonctions PURES, réplique exacte (sur CPU) de ce que fait le
// shader du compositeur, pour analyser les fichiers image par image et tester l'absence de halo.
//  - fond noir : alpha = luminosité (max des voies) adoucie entre lo et hi, couleur DÉCONTAMINÉE (on retire le noir
//    mélangé avant de prémultiplier : un bord blanc antialiasé reste blanc, jamais gris → aucun halo sombre) ;
//  - fond vert : chroma key à seuils serrés sur la distance de chrominance (YCbCr), suppression du débordement vert ;
//  - alpha réel (WebM VP9 alpha, PNG) : utilisé tel quel.

export const KEY_DEFAULTS = { luma: { lo: 0.04, hi: 0.30 }, chroma: { lo: 0.10, hi: 0.18 } };

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const cbcr = (r, g, b) => [-0.168736 * r - 0.331264 * g + 0.5 * b, 0.5 * r - 0.418688 * g - 0.081312 * b];

/**
 * Pixel keyé (valeurs 0..1), sortie prémultipliée [r, g, b, a].
 * @param {number} r @param {number} g @param {number} b @param {number} a alpha source
 * @param {{ method: 'luma'|'chroma'|'alpha'|'none', lo?: number, hi?: number, color?: number[] }} k
 */
export function keyPixel(r, g, b, a, k) {
  if (k.method === 'none') return [r, g, b, 1];
  if (k.method === 'alpha') return [r * a, g * a, b * a, a];
  if (k.method === 'chroma') {
    const [kc, kr] = cbcr(...(/** @type {[number, number, number]} */ (k.color || [0, 1, 0])));
    const [pc, pr] = cbcr(r, g, b);
    const d = Math.hypot(pc - kc, pr - kr);
    const al = smooth(k.lo ?? KEY_DEFAULTS.chroma.lo, k.hi ?? KEY_DEFAULTS.chroma.hi, d);
    const gg = Math.min(g, Math.max(r, b));            // débordement vert supprimé
    return [r * al, gg * al, b * al, al];
  }
  const m = Math.max(r, g, b);
  const al = smooth(k.lo ?? KEY_DEFAULTS.luma.lo, k.hi ?? KEY_DEFAULTS.luma.hi, m);
  const s = m > 1e-4 ? 1 / m : 0;                       // décontamination
  return [Math.min(1, r * s) * al, Math.min(1, g * s) * al, Math.min(1, b * s) * al, al];
}

/**
 * Méthode de retrait de fond d'après les bords de plusieurs images (RGBA 0..255).
 * @param {{ data: Uint8ClampedArray | Uint8Array, width: number, height: number }[]} frames
 * @returns {{ method: 'luma'|'chroma'|'alpha'|'none', color?: number[], why: string }}
 */
export function detectBackground(frames) {
  let transparent = 0, n = 0;
  const border = [];
  for (const f of frames) {
    const { data: d, width: w, height: h } = f;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] < 250) transparent++;
      n++;
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) border.push([d[i], d[i + 1], d[i + 2], d[i + 3]]);
    }
  }
  if (transparent / Math.max(1, n) > 0.02) return { method: 'alpha', why: 'canal alpha présent' };
  if (!border.length) return { method: 'luma', why: 'par défaut' };
  const med = [0, 1, 2].map((c) => border.map((p) => p[c]).sort((a, b) => a - b)[border.length >> 1]);
  const [r, g, b] = med;
  if (Math.max(r, g, b) < 30) return { method: 'luma', why: `fond noir (bords ${r},${g},${b})` };
  if (g > 90 && g > r + 40 && g > b + 40) return { method: 'chroma', color: [r / 255, g / 255, b / 255], why: `fond vert (bords ${r},${g},${b})` };
  if (b > 90 && b > r + 40 && b > g + 20) return { method: 'chroma', color: [r / 255, g / 255, b / 255], why: `fond bleu (bords ${r},${g},${b})` };
  return { method: 'none', why: `fond opaque non uni (bords ${r},${g},${b}) : posé tel quel` };
}

/**
 * Couverture d'une image keyée : part des pixels qui MASQUENT le plan dessous (alpha ≥ 0,98) et part des pixels
 * visibles (alpha > 0,02).
 */
export function coverage(d, w, h, k) {
  let full = 0, vis = 0;
  for (let i = 0; i < w * h * 4; i += 4) {
    const a = keyPixel(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, d[i + 3] / 255, k)[3];
    if (a >= 0.98) full++;
    if (a > 0.02) vis++;
  }
  return { full: full / (w * h), visible: vis / (w * h) };
}

/**
 * Analyse temporelle d'un overlay à partir de sa couverture par image.
 * Fenêtre de couverture totale = plus longue suite d'images où ≥ `fullThreshold` des pixels masquent le dessous.
 * @param {{ full: number, visible: number }[]} cov @param {number} [fullThreshold]
 */
export function coverWindow(cov, fullThreshold = 0.985) {
  let best = null, cur = null;
  cov.forEach((c, i) => {
    if (c.full >= fullThreshold) { if (!cur) cur = { start: i, end: i }; else cur.end = i; if (!best || cur.end - cur.start > best.end - best.start) best = { ...cur }; }
    else cur = null;
  });
  // Première image avec du contenu visible (≥ 0,1 % des pixels : une animation commence souvent toute petite).
  const firstVisible = cov.findIndex((c) => c.visible > 0.001);
  let lastVisible = -1; for (let i = cov.length - 1; i >= 0; i--) if (cov[i].visible > 0.001) { lastVisible = i; break; }
  const out = { frames: cov.length, firstVisible, lastVisible, fullStart: -1, fullEnd: -1, cutFrame: -1, windowFrames: 0, below60: -1 };
  if (best) {
    out.fullStart = best.start; out.fullEnd = best.end; out.windowFrames = best.end - best.start + 1;
    out.cutFrame = Math.floor((best.start + best.end) / 2);
    // Ouverture : premier sous-titre seulement quand le plan dessous est découvert à plus de 40 %.
    out.below60 = cov.findIndex((c, i) => i > best.end && c.full < 0.6);
    if (out.below60 < 0) out.below60 = cov.length;
  }
  return out;
}

/**
 * Convertit des numéros d'image de l'overlay (fps propre) en images du projet SANS changer la vitesse.
 * Décimation exacte (60 → 30 : une image sur deux) ; autre rapport : image la plus proche, jamais de mélange.
 * @param {number} assetFps @param {number} fps
 */
export function frameMap(assetFps, fps) {
  const r = assetFps / fps;
  return {
    /** image du projet k (relative au début de l'overlay) → image de l'overlay */
    toAsset: (k) => Math.floor(k * r + 1e-6),
    /** image de l'overlay → première image du projet qui l'affiche */
    toProject: (i) => Math.ceil(i / r - 1e-6),
    /** dernière image du projet qui affiche encore l'image i de l'overlay */
    toProjectEnd: (i) => Math.ceil((i + 1) / r - 1e-6) - 1,
    exact: Math.abs(r - Math.round(r)) < 1e-6,
  };
}
