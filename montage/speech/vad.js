// Détection d'activité vocale (VAD) avec Silero VAD v5 (MIT) : une probabilité de parole toutes les 32 ms.
// Sert à ne transcrire QUE la parole (Whisper invente du texte sur le silence, les respirations, la musique) et
// à découper l'audio en morceaux ≤ 28 s coupés dans des silences.
// `sileroProbs` reçoit le module ONNX Runtime (onnxruntime-web dans le navigateur, onnxruntime-node en test) ;
// le reste est pur et testé (tests/unit/vad.test.mjs).

export const VAD_RATE = 16000, VAD_FRAME = 512, VAD_CTX = 64;
export const FRAME_SEC = VAD_FRAME / VAD_RATE;   // 0,032 s

/**
 * Probabilités de parole par trame de 32 ms (protocole officiel v5 : 64 échantillons de contexte devant chaque trame).
 * @param {any} ort module ONNX Runtime @param {any} session InferenceSession du modèle Silero
 * @param {Float32Array} audio mono 16 kHz
 * @returns {Promise<Float32Array>}
 */
export async function sileroProbs(ort, session, audio) {
  const n = Math.ceil(audio.length / VAD_FRAME);
  const probs = new Float32Array(n);
  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(VAD_RATE)]), []);
  const buf = new Float32Array(VAD_CTX + VAD_FRAME);
  for (let i = 0; i < n; i++) {
    const s = i * VAD_FRAME;
    buf.fill(0);
    buf.set(audio.subarray(Math.max(0, s - VAD_CTX), s), VAD_CTX - Math.min(VAD_CTX, s));
    buf.set(audio.subarray(s, Math.min(audio.length, s + VAD_FRAME)), VAD_CTX);
    const out = await session.run({ input: new ort.Tensor('float32', buf.slice(), [1, buf.length]), state, sr });
    probs[i] = out.output.data[0];
    state = out.stateN;
  }
  return probs;
}

/**
 * Segments de parole à partir des probabilités (hystérésis comme l'implémentation de référence de Silero).
 * @param {Float32Array} probs
 * @param {{ threshold?: number, minSpeech?: number, minSilence?: number, pad?: number }} [opt] durées en secondes
 * @returns {{ start: number, end: number, p: number }[]} en secondes ; p = probabilité moyenne
 */
export function speechSegments(probs, opt = {}) {
  const thr = opt.threshold ?? 0.5, neg = thr - 0.15;
  const minSpeech = opt.minSpeech ?? 0.25, minSilence = opt.minSilence ?? 0.1, pad = opt.pad ?? 0.03;
  const segs = [];
  let on = false, start = 0, silenceAt = -1, sum = 0, cnt = 0;
  const close = (endFrame) => {
    const s = start * FRAME_SEC, e = endFrame * FRAME_SEC;
    if (e - s >= minSpeech) segs.push({ start: s, end: e, p: sum / Math.max(1, cnt) });
  };
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (!on) {
      if (p >= thr) { on = true; start = i; silenceAt = -1; sum = p; cnt = 1; }
      continue;
    }
    sum += p; cnt++;
    if (p >= thr) { silenceAt = -1; continue; }
    if (p < neg) {
      if (silenceAt < 0) silenceAt = i;
      if ((i - silenceAt) * FRAME_SEC >= minSilence) { close(silenceAt); on = false; }
    }
  }
  if (on) close(probs.length);
  // Marge autour de la parole (sans chevauchement entre segments voisins).
  const total = probs.length * FRAME_SEC;
  for (let k = 0; k < segs.length; k++) {
    const prevEnd = k ? segs[k - 1].end : 0, nextStart = k + 1 < segs.length ? segs[k + 1].start : total;
    segs[k].start = Math.max(prevEnd, segs[k].start - pad);
    segs[k].end = Math.min(nextStart, segs[k].end + pad);
  }
  return segs;
}

/**
 * Regroupe les segments de parole en morceaux pour la transcription : chaque morceau ≤ maxSec, coupé au milieu
 * d'un silence, avec une petite marge. Les silences longs ne sont jamais envoyés au modèle.
 * @param {{ start: number, end: number }[]} segs @param {{ maxSec?: number, joinGap?: number, margin?: number }} [opt]
 * @returns {{ start: number, end: number, segs: number[] }[]}
 */
export function planChunks(segs, opt = {}) {
  const maxSec = opt.maxSec ?? 28, joinGap = opt.joinGap ?? 1.2, margin = opt.margin ?? 0.15;
  const chunks = [];
  let cur = null;
  segs.forEach((s, i) => {
    if (cur && s.start - cur.end <= joinGap && s.end - cur.start + 2 * margin <= maxSec) { cur.end = s.end; cur.segs.push(i); return; }
    if (cur) chunks.push(cur);
    cur = { start: s.start, end: s.end, segs: [i] };
    // Un segment unique plus long que maxSec est découpé à intervalles réguliers (rare : 28 s sans pause).
    while (cur.end - cur.start + 2 * margin > maxSec) {
      chunks.push({ start: cur.start, end: cur.start + maxSec - 2 * margin, segs: [i] });
      cur.start += maxSec - 2 * margin;
    }
  });
  if (cur) chunks.push(cur);
  return chunks.map((c, k) => ({
    ...c,
    start: Math.max(k ? (chunks[k - 1].end + c.start) / 2 : 0, c.start - margin),
    end: k + 1 < chunks.length ? Math.min((c.end + chunks[k + 1].start) / 2, c.end + margin) : c.end + margin,
  }));
}
