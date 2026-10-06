import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { speechSegments, planChunks, sileroProbs, FRAME_SEC } from '../../montage/speech/vad.js';
import { decodeWav } from '../../montage/audio/wav.js';

const BENCH = process.env.INKU_BENCH || 'C:/Users/cybersecurite/Downloads/INKU-bench';

test('segments : hystérésis, durée minimale, marge', () => {
  const p = new Float32Array(200).fill(0.02);
  p.fill(0.9, 20, 60);           // 1,28 s de parole
  p.fill(0.4, 60, 62);           // creux bref au-dessus du seuil bas → même segment
  p.fill(0.9, 62, 80);
  p.fill(0.9, 120, 124);         // 0,128 s : trop court (< 0,25 s) → ignoré
  p.fill(0.8, 150, 190);
  const s = speechSegments(p);
  assert.equal(s.length, 2);
  assert.ok(Math.abs(s[0].start - (20 * FRAME_SEC - 0.03)) < 1e-9);
  assert.ok(Math.abs(s[0].end - (80 * FRAME_SEC + 0.03)) < 1e-9);
  assert.ok(Math.abs(s[1].start - (150 * FRAME_SEC - 0.03)) < 1e-9);
});

test('morceaux : ≤ 28 s, coupés dans les silences, silences longs exclus', () => {
  const segs = [];
  for (let t = 0; t < 70; t += 4) segs.push({ start: t, end: t + 3.2 });   // phrases de 3,2 s, pauses de 0,8 s
  segs.push({ start: 100, end: 103 });                                   // après 30 s de silence
  const c = planChunks(segs);
  for (const k of c) assert.ok(k.end - k.start <= 28 + 1e-9, `morceau ${k.start}-${k.end}`);
  for (let i = 1; i < c.length; i++) assert.ok(c[i].start >= c[i - 1].end - 1e-9);
  assert.ok(c.every((k) => !(k.start < 90 && k.end > 75)), 'le long silence n\'est pas transcrit');
  assert.deepEqual(c.flatMap((k) => k.segs), segs.map((_, i) => i));       // chaque segment une seule fois
});

const model = `${BENCH}/models/silero.onnx`;
test('Silero v5 (onnxruntime-node) sur une voix FLEURS entourée de silence et de bruit', { skip: !existsSync(model) && 'modèle absent (hors dépôt)' }, async () => {
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(model);
  const dir = `${BENCH}/fleurs/dev`;
  const f = readdirSync(dir).filter((x) => x.endsWith('.wav')).sort()[3];
  const voice = decodeWav(readFileSync(`${dir}/${f}`).buffer).channels[0];
  // 2 s de bruit faible (−50 dBFS), la voix, 3 s de bruit.
  const N = 16000 * 2, M = 16000 * 3, x = new Float32Array(N + voice.length + M);
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.0063;
  for (let i = 0; i < x.length; i++) x[i] = rnd();
  x.set(voice.map((v, i) => v + x[N + i]), N);
  const t0 = performance.now();
  const probs = await sileroProbs(ort, session, x);
  const ms = performance.now() - t0;
  const segs = speechSegments(probs);
  console.log(`VAD : ${(x.length / 16000).toFixed(1)} s en ${ms.toFixed(0)} ms ; segments ${segs.map((s) => s.start.toFixed(2) + '-' + s.end.toFixed(2)).join(' ')}`);
  assert.ok(segs.length >= 1);
  assert.ok(segs[0].start >= 1.8, 'pas de parole détectée dans le bruit initial');
  assert.ok(segs[segs.length - 1].end <= (N + voice.length) / 16000 + 0.6, 'pas de parole dans le bruit final');
  const covered = segs.reduce((a, s) => a + s.end - s.start, 0);
  assert.ok(covered > 0.6 * voice.length / 16000, 'la voix est couverte');
});
