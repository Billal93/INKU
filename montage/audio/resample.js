// Rééchantillonnage de qualité (interpolation à bande limitée, méthode de J. O. Smith) : sinus cardinal fenêtré
// de Kaiser, rapport quelconque (48 k → 16 k, 44,1 k → 16 k…). Fonction pure, utilisable en worker.
// Mesuré (tests/unit/resample.test.mjs) : amplitude conservée à ±0,05 dB jusqu'à 0,8 × la nouvelle fréquence de
// Nyquist, repliement (aliasing) atténué de plus de 70 dB.

function besselI0(x) { let s = 1, t = 1; for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; }

/**
 * @param {Float32Array} x signal d'entrée
 * @param {number} fsIn @param {number} fsOut
 * @param {{ zeros?: number, beta?: number, rolloff?: number }} [opt] zeros = demi-largeur du noyau en passages par zéro
 * @returns {Float32Array}
 */
export function resample(x, fsIn, fsOut, opt = {}) {
  if (fsIn === fsOut) return x.slice();
  const zeros = opt.zeros ?? 24, beta = opt.beta ?? 9, rolloff = opt.rolloff ?? 0.94;
  const ratio = fsOut / fsIn;
  const cut = Math.min(1, ratio) * rolloff;        // coupure relative à fsIn/2
  const nOut = Math.floor(x.length * ratio);
  const out = new Float32Array(nOut);
  // Noyau tabulé finement (512 points par passage par zéro) puis interpolé linéairement.
  const RES = 512, half = zeros / cut;            // demi-largeur en échantillons d'entrée
  const tab = new Float64Array(zeros * RES + 2);
  const i0b = besselI0(beta);
  for (let i = 0; i < tab.length; i++) {
    const u = i / RES;                              // en passages par zéro
    const r = u / zeros;
    const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    tab[i] = r >= 1 ? 0 : sinc * besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
  }
  const kern = (/** @type {number} */ d) => {        // d en échantillons d'entrée
    const u = Math.abs(d) * cut * RES;
    const i = Math.floor(u);
    if (i >= tab.length - 1) return 0;
    const f = u - i;
    return tab[i] + (tab[i + 1] - tab[i]) * f;
  };
  for (let n = 0; n < nOut; n++) {
    const t = n / ratio;                            // instant en échantillons d'entrée
    const lo = Math.max(0, Math.ceil(t - half)), hi = Math.min(x.length - 1, Math.floor(t + half));
    let s = 0;
    for (let k = lo; k <= hi; k++) s += x[k] * kern(t - k);
    out[n] = s * cut;
  }
  return out;
}

/** Mélange multi-voies → mono (moyenne). @param {Float32Array[]} channels */
export function toMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length, out = new Float32Array(n), g = 1 / channels.length;
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] * g;
  return out;
}
