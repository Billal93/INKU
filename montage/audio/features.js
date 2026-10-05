// Descripteurs acoustiques courts (trames de 10 ms) pour le nettoyage de la voix : énergie, passages par zéro,
// flux spectral (attaques), hauteur (YIN) et voisement. Fonctions pures, testées dans tests/unit/features.test.mjs.
// Ils complètent le texte : un modèle de transcription « gomme » souvent les bégaiements, l'audio ne ment pas.

export const HOP = 0.01;   // 10 ms

/**
 * Énergie RMS en dBFS par trame (fenêtre 20 ms, pas 10 ms) et taux de passages par zéro.
 * @param {Float32Array} x mono @param {number} fs
 * @returns {{ db: Float32Array, zcr: Float32Array, hop: number }}
 */
export function energy(x, fs) {
  const hop = Math.round(HOP * fs), win = 2 * hop;
  const n = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  const db = new Float32Array(n), zcr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * hop;
    let e = 0, z = 0;
    for (let k = 0; k < win; k++) {
      const v = x[o + k]; e += v * v;
      if (k && (v >= 0) !== (x[o + k - 1] >= 0)) z++;
    }
    db[i] = 10 * Math.log10(e / win + 1e-12);
    zcr[i] = z / win;
  }
  return { db, zcr, hop: HOP };
}

/** Trame (10 ms) → temps du CENTRE de sa fenêtre en secondes. @param {number} i */
export const frameTime = (i) => i * HOP + HOP;

/**
 * Hauteur fondamentale par YIN (de Cheveigné & Kawahara, 2002) sur un signal ramené à 8 kHz.
 * @param {Float32Array} x mono @param {number} fs
 * @param {{ fmin?: number, fmax?: number, threshold?: number }} [opt]
 * @returns {{ f0: Float32Array, clarity: Float32Array }} f0 = 0 si non voisé ; clarity ∈ [0,1] (1 = très périodique)
 */
export function pitchYin(x, fs, opt = {}) {
  const fmin = opt.fmin ?? 70, fmax = opt.fmax ?? 450, thr = opt.threshold ?? 0.15;
  // Décimation simple par moyenne (le filtre passe-bas suffit pour la hauteur de la voix).
  const D = Math.max(1, Math.round(fs / 8000)), sr = fs / D;
  const y = new Float32Array(Math.floor(x.length / D));
  for (let i = 0; i < y.length; i++) { let s = 0; for (let k = 0; k < D; k++) s += x[i * D + k]; y[i] = s / D; }
  const hop = Math.round(HOP * sr), W = Math.round(0.03 * sr);
  const tMin = Math.floor(sr / fmax), tMax = Math.ceil(sr / fmin);
  const n = Math.max(0, Math.floor((y.length - W - tMax) / hop) + 1);
  const f0 = new Float32Array(n), clarity = new Float32Array(n);
  const d = new Float32Array(tMax + 1);
  for (let i = 0; i < n; i++) {
    const o = i * hop;
    let e = 0; for (let k = 0; k < W; k++) e += y[o + k] * y[o + k];
    if (e / W < 1e-7) continue;                     // silence (< −70 dBFS)
    for (let tau = 1; tau <= tMax; tau++) {
      let s = 0;
      for (let k = 0; k < W; k++) { const v = y[o + k] - y[o + k + tau]; s += v * v; }
      d[tau] = s;
    }
    // Différence normalisée cumulée.
    let run = 0, best = -1;
    for (let tau = 1; tau <= tMax; tau++) {
      run += d[tau];
      d[tau] = run > 0 ? (d[tau] * tau) / run : 1;
    }
    for (let tau = tMin; tau <= tMax; tau++) {
      if (d[tau] < thr) { while (tau + 1 <= tMax && d[tau + 1] < d[tau]) tau++; best = tau; break; }
    }
    if (best < 0) continue;
    // Interpolation parabolique pour une hauteur sous-échantillon.
    const a = d[best - 1] ?? d[best], b = d[best], c = d[best + 1] ?? d[best];
    const den = a - 2 * b + c;
    const t = best + (den ? (a - c) / (2 * den) : 0);
    f0[i] = sr / t;
    clarity[i] = Math.max(0, 1 - b);
  }
  return { f0, clarity };
}

/**
 * Force d'attaque par trame de 10 ms : hausse positive de l'énergie (dB) d'une trame à la suivante.
 * Repère le début des syllabes (utile pour détecter une syllabe répétée « p- p- pour »).
 * @param {Float32Array} x mono @param {number} fs
 */
export function onsetStrength(x, fs) {
  const { db } = energy(x, fs);
  const out = new Float32Array(db.length);
  for (let i = 1; i < db.length; i++) out[i] = Math.max(0, db[i] - db[i - 1]);
  return out;
}

/**
 * Plus faible énergie (dBFS) dans une fenêtre [t0, t1] en secondes, et l'instant où elle est atteinte.
 * @param {Float32Array} db énergie par trame de 10 ms @param {number} t0 @param {number} t1
 */
export function energyMin(db, t0, t1) {
  let a = Math.max(0, Math.floor((t0 - HOP) / HOP)), b = Math.min(db.length - 1, Math.ceil((t1 - HOP) / HOP));
  if (b < a) [a, b] = [b, a];
  let m = a;
  for (let i = a; i <= b; i++) if (db[i] < db[m]) m = i;
  return { db: db[m], t: frameTime(m) };
}

/**
 * Passage par zéro le plus proche de t (en échantillons), dans ±maxMs : point de coupe sans clic.
 * @param {Float32Array} x @param {number} fs @param {number} t secondes @param {number} [maxMs]
 */
export function nearestZeroCrossing(x, fs, t, maxMs = 5) {
  const c = Math.round(t * fs), r = Math.round((maxMs / 1000) * fs);
  for (let d = 0; d <= r; d++) {
    for (const i of [c - d, c + d]) {
      if (i > 0 && i < x.length && (x[i - 1] <= 0) !== (x[i] <= 0)) return Math.abs(x[i - 1]) < Math.abs(x[i]) ? i - 1 : i;
    }
  }
  return c;
}
