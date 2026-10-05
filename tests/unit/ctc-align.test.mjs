import test from 'node:test';
import assert from 'node:assert/strict';
import { ctcForcedAlign, logSoftmaxRows } from '../../montage/speech/ctc-align.js';

/** Émissions synthétiques : chaque trame « émet » fortement un jeton connu (0 = blanc). */
function emissions(seq, V) {
  const T = seq.length, x = new Float32Array(T * V);
  seq.forEach((tok, t) => { for (let v = 0; v < V; v++) x[t * V + v] = v === tok ? 5 : 0; });
  return logSoftmaxRows(x, T, V);
}

test('CTC : retrouve les trames de chaque jeton, y compris jetons répétés', () => {
  //            t: 0 1 2 3 4 5 6 7 8 9 10 11
  const seq = [0, 1, 1, 0, 2, 0, 2, 2, 0, 3, 0, 0];
  const r = ctcForcedAlign(emissions(seq, 5), seq.length, 5, [1, 2, 2, 3], 0);
  assert.deepEqual(r.spans, [[1, 2], [4, 4], [6, 7], [9, 9]]);
  assert.ok(r.tokenScores.every((s) => s > -0.1));
});

test('CTC : alignement forcé même quand les émissions contredisent (jeton absent)', () => {
  const seq = [0, 1, 1, 0, 0, 3, 3, 0];      // le jeton 2 n'est jamais émis
  const r = ctcForcedAlign(emissions(seq, 5), seq.length, 5, [1, 2, 3], 0);
  assert.equal(r.spans.length, 3);
  for (let k = 1; k < 3; k++) assert.ok(r.spans[k][0] > r.spans[k - 1][1]);
  assert.ok(r.tokenScores[1] < -3, 'le jeton forcé a une mauvaise confiance');
});

test('CTC : impossible si trop peu de trames (jetons identiques séparés par un blanc)', () => {
  assert.equal(ctcForcedAlign(emissions([1, 1], 3), 2, 3, [1, 1], 0), null);
  assert.ok(ctcForcedAlign(emissions([1, 0, 1], 3), 3, 3, [1, 1], 0));
});

test('CTC : 60 s d\'audio à 50 trames/s, 900 caractères en < 300 ms', () => {
  const T = 3000, V = 40, toks = Array.from({ length: 900 }, (_, i) => 1 + (i * 7) % 39);
  const x = new Float32Array(T * V).map(() => Math.random());
  logSoftmaxRows(x, T, V);
  const t0 = performance.now();
  const r = ctcForcedAlign(x, T, V, toks, 0);
  const ms = performance.now() - t0;
  console.log(`CTC 3000×900 : ${ms.toFixed(0)} ms`);
  assert.ok(r && ms < 300);
});
