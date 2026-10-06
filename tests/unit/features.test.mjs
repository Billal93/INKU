import test from 'node:test';
import assert from 'node:assert/strict';
import { energy, pitchYin, energyMin, nearestZeroCrossing, frameTime } from '../../montage/audio/features.js';

const FS = 16000;
/** Voyelle synthétique : harmoniques d'une fondamentale f0 (glissement possible), amplitude A. */
function vowel(sec, f0a, f0b = f0a, A = 0.3) {
  const n = Math.round(sec * FS), x = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = f0a + (f0b - f0a) * i / n; ph += 2 * Math.PI * f / FS;
    x[i] = A * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.2 * Math.sin(4 * ph)) / 2;
  }
  return x;
}

test('énergie : niveau d\'une sinusoïde et silence', () => {
  const x = new Float32Array(FS);
  for (let i = 0; i < FS / 2; i++) x[i] = 0.1 * Math.sin(2 * Math.PI * 440 * i / FS);   // −20 dBFS crête → −23 dB RMS
  const { db } = energy(x, FS);
  assert.ok(Math.abs(db[20] - (20 * Math.log10(0.1 / Math.SQRT2))) < 0.2);
  assert.ok(db[80] < -100);
  const m = energyMin(db, 0.2, 0.9);
  assert.ok(m.t >= 0.5 && m.db < -100);
});

test('YIN : hauteur à ±1 % sur voix synthétique (homme 110 Hz, femme 220 Hz), silence non voisé', () => {
  for (const f of [110, 220, 300]) {
    const x = new Float32Array(FS); x.set(vowel(0.5, f), 0);
    const { f0, clarity } = pitchYin(x, FS);
    const mid = f0.slice(10, 40);
    for (const v of mid) assert.ok(Math.abs(v - f) / f < 0.01, `${f} Hz : ${v.toFixed(1)}`);
    assert.ok(clarity[20] > 0.8);
    assert.equal(f0[80], 0);
  }
});

test('YIN : suit un glissement de hauteur (intonation)', () => {
  const { f0 } = pitchYin(vowel(1, 150, 250), FS);
  assert.ok(f0[10] < f0[50] && f0[50] < f0[85]);
});

test('passage par zéro : coupe sans clic au plus près', () => {
  const x = new Float32Array(FS); for (let i = 0; i < FS; i++) x[i] = Math.sin(2 * Math.PI * 100 * i / FS);
  const i = nearestZeroCrossing(x, FS, 0.0031);
  assert.ok(Math.abs(x[i]) < 0.04, `|x| = ${Math.abs(x[i])}`);
  assert.ok(Math.abs(i / FS - 0.0031) < 0.0026);
  assert.equal(frameTime(0), 0.01);
});
