// Modèles NVIDIA NeMo FastConformer (CTC) : prétraitement mel identique à NeMo (vérifié contre onnx-asr,
// tests/unit/nemo.test.mjs), décodage CTC glouton et horodatage des mots (trames de 80 ms, sous-échantillonnage ×8).
// Un seul passage dans le réseau (pas de génération mot à mot) : beaucoup plus rapide que Whisper.

const SR = 16000, N_FFT = 512, WIN = 400, HOP = 160, PREEMPH = 0.97, LOG_GUARD = 2 ** -24;

/** Filtres mel « slaney » (comme librosa.filters.mel(norm='slaney', htk=False)). @returns {Float32Array[]} nMels × (N_FFT/2+1) */
export function melFilterbank(nMels = 80, sr = SR, nFft = N_FFT, fmin = 0, fmax = sr / 2) {
  const hzToMel = (f) => { const fs = 200 / 3, minLog = 1000, logStep = Math.log(6.4) / 27; return f < minLog ? f / fs : minLog / fs + Math.log(f / minLog) / logStep; };
  const melToHz = (m) => { const fs = 200 / 3, minLog = 1000, minLogMel = minLog / fs, logStep = Math.log(6.4) / 27; return m < minLogMel ? fs * m : minLog * Math.exp(logStep * (m - minLogMel)); };
  const nBins = nFft / 2 + 1;
  const fftFreqs = Array.from({ length: nBins }, (_, i) => (i * sr) / nFft);
  const mMin = hzToMel(fmin), mMax = hzToMel(fmax);
  const pts = Array.from({ length: nMels + 2 }, (_, i) => melToHz(mMin + ((mMax - mMin) * i) / (nMels + 1)));
  return Array.from({ length: nMels }, (_, m) => {
    const f = new Float32Array(nBins);
    const lo = pts[m], c = pts[m + 1], hi = pts[m + 2], enorm = 2 / (hi - lo);
    for (let k = 0; k < nBins; k++) {
      const up = (fftFreqs[k] - lo) / (c - lo), down = (hi - fftFreqs[k]) / (hi - c);
      f[k] = Math.max(0, Math.min(up, down)) * enorm;
    }
    return f;
  });
}

/** FFT réelle (radix 2, en place) → puissance |X|² des N/2+1 premières fréquences. */
export function powerSpectrum(re, im, out) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
}

let fbCache = null;
/**
 * Caractéristiques d'entrée NeMo : [nMels × T] (ligne = bande mel), normalisées par bande sur les trames valides.
 * @param {Float32Array} x mono 16 kHz @param {number} [nMels]
 * @returns {{ data: Float32Array, frames: number, valid: number, nMels: number }}
 */
export function nemoFeatures(x, nMels = 80) {
  fbCache ||= new Map();
  if (!fbCache.has(nMels)) fbCache.set(nMels, melFilterbank(nMels));
  const fb = fbCache.get(nMels);
  const n = x.length;
  // Préaccentuation, puis zéros de part et d'autre (centrage de la fenêtre).
  const y = new Float32Array(n + N_FFT);
  for (let i = 0; i < n; i++) y[i + N_FFT / 2] = x[i] - (i ? PREEMPH * x[i - 1] : 0);
  const frames = Math.floor(n / HOP) + 1, valid = Math.floor(n / HOP);
  const win = new Float64Array(N_FFT), off = (N_FFT - WIN) / 2;
  for (let i = 0; i < WIN; i++) win[off + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1));   // np.hanning (symétrique)
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT), pw = new Float64Array(N_FFT / 2 + 1);
  const data = new Float32Array(nMels * frames);
  for (let t = 0; t < frames; t++) {
    const o = t * HOP;
    for (let k = 0; k < N_FFT; k++) { re[k] = y[o + k] * win[k]; im[k] = 0; }
    powerSpectrum(re, im, pw);
    for (let m = 0; m < nMels; m++) {
      const f = fb[m];
      let s = 0;
      for (let k = 0; k < pw.length; k++) if (f[k]) s += f[k] * pw[k];
      data[m * frames + t] = Math.log(s + LOG_GUARD);
    }
  }
  // Normalisation par bande (moyenne / écart-type non biaisé sur les trames valides), trames au-delà à 0.
  for (let m = 0; m < nMels; m++) {
    const row = data.subarray(m * frames, (m + 1) * frames);
    let mean = 0; for (let t = 0; t < valid; t++) mean += row[t]; mean /= Math.max(1, valid);
    let v = 0; for (let t = 0; t < valid; t++) v += (row[t] - mean) ** 2; v /= Math.max(1, valid - 1);
    const sd = Math.sqrt(v) + 1e-5;
    for (let t = 0; t < frames; t++) row[t] = t < valid ? (row[t] - mean) / sd : 0;
  }
  return { data, frames, valid, nMels };
}

/** Vocabulaire « <jeton> <id> » par ligne (▁ = espace, <blk> = blanc CTC). @param {string} text */
export function parseVocab(text) {
  const tokens = [];
  let blank = -1;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(.*) (\d+)$/);
    if (!m) continue;
    tokens[Number(m[2])] = m[1];
    if (m[1] === '<blk>') blank = Number(m[2]);
  }
  if (blank < 0) blank = tokens.length;   // convention NeMo : blanc = dernier indice
  return { tokens, blank };
}

/**
 * Décodage CTC glouton + mots horodatés.
 * @param {Float32Array} logp [T × V] log-probabilités @param {number} T @param {number} V
 * @param {{ tokens: string[], blank: number }} vocab @param {number} [frameSec] durée d'une trame de sortie (0,08 s)
 * @returns {{ text: string, words: { w: string, t0: number, t1: number, conf: number }[] }}
 */
export function ctcGreedyWords(logp, T, V, vocab, frameSec = 0.08) {
  const words = [];
  let cur = null, prev = -1;
  const flush = () => { if (cur && cur.w.trim()) words.push({ w: cur.w.trim(), t0: cur.t0, t1: cur.t1, conf: Math.exp(cur.lp / cur.n) }); cur = null; };
  for (let t = 0; t < T; t++) {
    let best = 0, bv = -Infinity;
    const o = t * V;
    for (let v = 0; v < V; v++) if (logp[o + v] > bv) { bv = logp[o + v]; best = v; }
    if (best === vocab.blank) { prev = best; continue; }
    if (best === prev) { if (cur) { cur.t1 = (t + 1) * frameSec; cur.lp += bv; cur.n++; } continue; }
    prev = best;
    const tok = vocab.tokens[best] || '';
    if (tok.startsWith('▁') || !cur) {
      flush();
      cur = { w: tok.replace(/^▁/, ''), t0: t * frameSec, t1: (t + 1) * frameSec, lp: bv, n: 1 };
    } else { cur.w += tok; cur.t1 = (t + 1) * frameSec; cur.lp += bv; cur.n++; }
  }
  flush();
  // Ponctuation détachée (jeton « , » après un espace) : rattachée au mot précédent.
  const out = [];
  for (const w of words) {
    if (/^[,.;:!?…]+$/.test(w.w) && out.length) { out[out.length - 1].w += w.w; continue; }
    out.push(w);
  }
  return { text: out.map((w) => w.w).join(' '), words: out };
}
