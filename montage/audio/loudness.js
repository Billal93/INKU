// Mesure de sonie EBU R128 / ITU-R BS.1770-4 et true peak, implémentée ici (fonctions pures, testées contre
// des signaux de référence dans tests/unit/loudness.test.mjs, cas de l'EBU Tech 3341/3342).
//  - pondération K : filtre en plateau + passe-haut, coefficients recalculés pour toute fréquence d'échantillonnage
//    (mêmes formules que libebur128 ; à 48 kHz on retrouve exactement les coefficients de la norme) ;
//  - momentary (400 ms), short-term (3 s), intégrée (blocs de 400 ms à 75 % de recouvrement, porte absolue
//    −70 LUFS puis porte relative −10 LU), plage de sonie LRA (EBU 3342 : porte relative −20 LU, centiles 10-95) ;
//  - true peak : suréchantillonnage ×4 par filtre polyphasé (sinus cardinal fenêtré de Kaiser, 4 × 48 coefficients).

/** Coefficients biquad de la pondération K pour une fréquence d'échantillonnage. @param {number} fs */
export function kWeightingCoefs(fs) {
  // Étage 1 : plateau haute fréquence (+4 dB), modèle de la tête.
  const G = 3.999843853973347;
  let f0 = 1681.974450955533, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
    a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0],
  };
  // Étage 2 : passe-haut (RLB).
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const hp = { b: [1, -2, 1], a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
  return [shelf, hp];
}

/** Filtre une voie par la pondération K (double précision, deux étages dans une seule boucle). @param {Float32Array} x @param {number} fs */
export function kWeight(x, fs) {
  const out = new Float64Array(x.length);
  const [{ b: b1, a: a1 }, { b: b2, a: a2 }] = kWeightingCoefs(fs);
  const p0 = b1[0], p1 = b1[1], p2 = b1[2], q1 = a1[1], q2 = a1[2];
  const r0 = b2[0], r1 = b2[1], r2 = b2[2], s1 = a2[1], s2 = a2[2];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = p0 * xi + p1 * x1 + p2 * x2 - q1 * y1 - q2 * y2;
    x2 = x1; x1 = xi;
    const z = r0 * y + r1 * y1 + r2 * y2 - s1 * z1 - s2 * z2;
    y2 = y1; y1 = y; z2 = z1; z1 = z;
    out[i] = z;
    if ((i & 4095) === 0) { if (Math.abs(y1) < 1e-150 && Math.abs(y2) < 1e-150) { y1 = 0; y2 = 0; } if (Math.abs(z1) < 1e-150 && Math.abs(z2) < 1e-150) { z1 = 0; z2 = 0; } }
  }
  return out;
}

const LOUD = (ms) => (ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity);

/**
 * Énergie pondérée K par tranches de 100 ms (somme des carrés), sans stocker le signal filtré : mémoire minime,
 * un seul passage. Les blocs de 400 ms (pas 100 ms) et de 3 s (pas 100 ms) sont des sommes de tranches.
 * @param {Float32Array} x @param {number} fs @param {number} hop
 */
function segmentEnergies(x, fs, hop) {
  const [{ b: b1, a: a1 }, { b: b2, a: a2 }] = kWeightingCoefs(fs);
  const p0 = b1[0], p1 = b1[1], p2 = b1[2], q1 = a1[1], q2 = a1[2];
  const r0 = b2[0], r1 = b2[1], r2 = b2[2], s1 = a2[1], s2 = a2[2];
  const nseg = Math.floor(x.length / hop);
  const e = new Float64Array(nseg);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0, acc = 0, k = 0, seg = 0;
  for (let i = 0; i < nseg * hop; i++) {
    const xi = x[i];
    const y = p0 * xi + p1 * x1 + p2 * x2 - q1 * y1 - q2 * y2;
    x2 = x1; x1 = xi;
    const z = r0 * y + r1 * y1 + r2 * y2 - s1 * z1 - s2 * z2;
    y2 = y1; y1 = y; z2 = z1; z1 = z;
    acc += z * z;
    if (++k === hop) {
      e[seg++] = acc; acc = 0; k = 0;
      // Silence : l'état du filtre décroît vers des nombres « dénormaux » (calcul jusqu'à 100× plus lent).
      // Remis à zéro bien avant (1e-150 ≪ toute valeur audible) : résultat inchangé.
      if (Math.abs(y1) < 1e-150 && Math.abs(y2) < 1e-150) { y1 = 0; y2 = 0; }
      if (Math.abs(z1) < 1e-150 && Math.abs(z2) < 1e-150) { z1 = 0; z2 = 0; }
    }
  }
  return e;
}

/** Puissances moyennes des blocs de `m` tranches (pas d'une tranche), voies sommées. */
function blocks(segs, m, hop) {
  const nseg = segs[0].length, out = [];
  for (let s = 0; s + m <= nseg; s++) {
    let z = 0;
    for (const e of segs) { let t = 0; for (let j = s; j < s + m; j++) t += e[j]; z += t / (m * hop); }
    out.push(z);
  }
  return out;
}

/**
 * Mesure complète EBU R128.
 * @param {Float32Array[]} channels voies (1 = mono, 2 = stéréo) @param {number} fs
 * @param {{ dualMono?: boolean }} [opt] dualMono : une voie mono est comptée comme si elle était jouée sur deux
 *   haut-parleurs (+3 dB), ce qui est le cas d'une voix mono placée au centre d'un mixage stéréo.
 */
export function measureLoudness(channels, fs, opt = {}) {
  const hop = Math.round(0.1 * fs);
  const segs = channels.map((c) => segmentEnergies(c, fs, hop));
  if (channels.length === 1 && opt.dualMono) segs.push(segs[0]);
  // Intégrée : blocs de 400 ms, pas de 100 ms.
  const z = blocks(segs, 4, hop);
  const abs = z.filter((p) => LOUD(p) > -70);
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  let integrated = -Infinity, relGate = -Infinity;
  if (abs.length) {
    relGate = LOUD(mean(abs)) - 10;
    const rel = abs.filter((p) => LOUD(p) > relGate);
    integrated = rel.length ? LOUD(mean(rel)) : -Infinity;
  }
  const momentary = z.map(LOUD);
  // Short-term (3 s) à 10 Hz et LRA (EBU Tech 3342).
  const st = blocks(segs, 30, hop);
  const shortTerm = st.map(LOUD);
  let lra = 0;
  const stAbs = st.filter((p) => LOUD(p) > -70);
  if (stAbs.length) {
    const g = LOUD(mean(stAbs)) - 20;
    const v = stAbs.map(LOUD).filter((l) => l > g).sort((a, b) => a - b);
    if (v.length) {
      const pct = (p) => v[Math.min(v.length - 1, Math.max(0, Math.round((p / 100) * (v.length - 1))))];
      lra = pct(95) - pct(10);
    }
  }
  return {
    integrated, lra,
    momentaryMax: momentary.length ? Math.max(...momentary) : -Infinity,
    shortTermMax: shortTerm.length ? Math.max(...shortTerm) : -Infinity,
    momentary, shortTerm,
  };
}

// ── True peak ──
const OS = 4, TAPS = 48;   // 4 phases × 48 coefficients
let tpFilter = /** @type {Float64Array[] | null} */ (null);
function besselI0(x) { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; }
/**
 * Filtre d'interpolation ×4 : pour la phase p (instant n + p/4), coefficient du voisin n + j :
 * sinc(p/4 − j) × Kaiser(β = 8) sur ±24 échantillons. Coupure à la fréquence de Nyquist d'origine.
 */
function truePeakFilter() {
  if (tpFilter) return tpFilter;
  const half = TAPS / 2, beta = 8;
  tpFilter = Array.from({ length: OS }, (_, p) => {
    const ph = new Float64Array(TAPS);
    for (let k = 0; k < TAPS; k++) {
      const j = k - half + 1;            // voisins n−23 … n+24
      const t = p / OS - j;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const r = t / (half + 1);
      ph[k] = sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / besselI0(beta);
    }
    return ph;
  });
  return tpFilter;
}

/**
 * True peak d'une voie (valeur linéaire), par suréchantillonnage ×4. Au-delà de 96 kHz pas de suréchantillonnage.
 * @param {Float32Array} x @param {number} fs
 * @returns {{ peak: number, dBTP: number, samplePeak: number, at: number }} at = index d'échantillon d'origine
 */
export function truePeak(x, fs) {
  let samplePeak = 0, at = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > samplePeak) { samplePeak = a; at = i; } }
  let peak = samplePeak;
  if (fs < 96000) {
    const ph = truePeakFilter();
    const half = TAPS / 2;
    // Le vrai pic d'un signal à bande limitée se trouve à moins d'un échantillon d'un maximum local de |x| :
    // on n'interpole qu'autour de ces maxima (et seulement s'ils dépassent −12 dB du pic), soit ~100× moins de
    // calcul qu'un suréchantillonnage complet pour le même résultat (vérifié par les tests de référence).
    const floor = samplePeak * 0.25;
    const at3 = (/** @type {number} */ n, /** @type {number} */ p) => {
      const h = ph[p], lo = n - half + 1;
      let s = 0;
      for (let k = 0; k < TAPS; k++) { const idx = lo + k; if (idx >= 0 && idx < x.length) s += h[k] * x[idx]; }
      return Math.abs(s);
    };
    for (let n = 0; n < x.length; n++) {
      const a = Math.abs(x[n]);
      if (a < floor || a < Math.abs(x[n - 1] || 0) || a < Math.abs(x[n + 1] || 0)) continue;
      for (const m of [n - 1, n]) {
        if (m < 0) continue;
        for (let p = 1; p < OS; p++) { const v = at3(m, p); if (v > peak) { peak = v; at = m; } }
      }
    }
  }
  return { peak, dBTP: 20 * Math.log10(peak || 1e-12), samplePeak, at };
}

/** @param {number} db */ export const dbToGain = (db) => Math.pow(10, db / 20);
/** @param {number} g */ export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));
