// Seuils de performance (à lancer sur une machine au repos : npm run montage:perf). Les valeurs mesurées sont
// affichées pour suivre les régressions ; les tests fonctionnels sont dans tests/unit/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Sha256 } from '../../montage/speech/sha256.js';
import { measureLoudness, truePeak } from '../../montage/audio/loudness.js';
import { ctcForcedAlign, logSoftmaxRows } from '../../montage/speech/ctc-align.js';
import { resample } from '../../montage/audio/resample.js';
import { energy, pitchYin } from '../../montage/audio/features.js';

const time = (fn) => { const t0 = performance.now(); const r = fn(); return [performance.now() - t0, r]; };

test('SHA-256 : ≥ 80 Mo/s (modèle de 600 Mo vérifié en < 8 s)', () => {
  const big = randomBytes(128 * 1048576);
  const [ms, hex] = time(() => { const h = new Sha256(); for (let i = 0; i < big.length; i += 1 << 20) h.update(big.subarray(i, i + (1 << 20))); return h.hex(); });
  assert.equal(hex, createHash('sha256').update(big).digest('hex'));
  console.log(`sha256 : ${(128 / (ms / 1000)).toFixed(0)} Mo/s`);
  assert.ok(128 / (ms / 1000) >= 80);
});

test('sonie + true peak : 60 s stéréo 48 kHz en < 1,5 s', () => {
  const n = 60 * 48000, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.1 * Math.sin(2 * Math.PI * 440 * i / 48000) + 0.05 * Math.sin(2 * Math.PI * 3100 * i / 48000);
  const [ms] = time(() => { measureLoudness([x, x], 48000); truePeak(x, 48000); truePeak(x, 48000); });
  console.log(`sonie + true peak 60 s stéréo : ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1500);
});

test('alignement CTC : 3000 trames × 900 jetons en < 300 ms', () => {
  const T = 3000, V = 40, toks = Array.from({ length: 900 }, (_, i) => 1 + (i * 7) % 39);
  const x = new Float32Array(T * V).map(() => Math.random());
  logSoftmaxRows(x, T, V);
  const [ms, r] = time(() => ctcForcedAlign(x, T, V, toks, 0));
  console.log(`CTC : ${ms.toFixed(0)} ms`);
  assert.ok(r && ms < 300);
});

test('préparation d\'une voix de 60 s (48 k → 16 k, énergie, hauteur) en < 2 s', () => {
  const n = 60 * 48000, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.2 * Math.sin(2 * Math.PI * (140 + 30 * Math.sin(i / 48000)) * i / 48000);
  const [ms] = time(() => { const y = resample(x, 48000, 16000); energy(y, 16000); pitchYin(y, 16000); });
  console.log(`préparation voix 60 s : ${ms.toFixed(0)} ms`);
  assert.ok(ms < 2000);
});
