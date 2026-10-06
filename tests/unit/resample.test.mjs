import test from 'node:test';
import assert from 'node:assert/strict';
import { resample } from '../../montage/audio/resample.js';
import { encodeWav, decodeWav } from '../../montage/audio/wav.js';

/** Amplitude d'une sinusoïde de fréquence f dans x (projection sur sin/cos, partie centrale). */
function amp(x, fs, f) {
  let re = 0, im = 0; const a = Math.floor(x.length * 0.2), b = Math.floor(x.length * 0.8);
  for (let i = a; i < b; i++) { re += x[i] * Math.cos(2 * Math.PI * f * i / fs); im += x[i] * Math.sin(2 * Math.PI * f * i / fs); }
  return 2 * Math.hypot(re, im) / (b - a);
}
const tone = (fs, f, sec = 1) => { const x = new Float32Array(fs * sec); for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / fs); return x; };

test('48 k et 44,1 k → 16 k : amplitude conservée (±0,05 dB) dans la bande utile', () => {
  for (const fsIn of [48000, 44100]) {
    for (const f of [100, 1000, 3000, 6000]) {
      const y = resample(tone(fsIn, f), fsIn, 16000);
      const db = 20 * Math.log10(amp(y, 16000, f) / 0.5);
      assert.ok(Math.abs(db) < 0.05, `${fsIn}→16k ${f} Hz : ${db.toFixed(3)} dB`);
    }
  }
});

test('repliement : une sinusoïde à 10 kHz disparaît à 16 kHz (> 70 dB)', () => {
  const y = resample(tone(48000, 10000), 48000, 16000);
  let e = 0; for (let i = 3200; i < 12800; i++) e += y[i] * y[i];
  const rms = Math.sqrt(e / 9600);
  assert.ok(20 * Math.log10(rms / (0.5 / Math.SQRT2)) < -70, `résidu ${20 * Math.log10(rms / 0.354)} dB`);
});

test('longueur et alignement temporel (aucun décalage)', () => {
  const x = new Float32Array(48000); x[24000] = 1;   // impulsion à 0,5 s
  const y = resample(x, 48000, 16000);
  assert.equal(y.length, 16000);
  let m = 0; for (let i = 1; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[m])) m = i;
  assert.equal(m, 8000);
});

test('WAV : aller-retour 32 bits flottant exact, 16 bits à 1/32768 près', () => {
  const x = tone(16000, 440, 0.1);
  const a = decodeWav(encodeWav([x], 16000, 32));
  assert.equal(a.sampleRate, 16000); assert.deepEqual(Array.from(a.channels[0]), Array.from(x));
  const b = decodeWav(encodeWav([x, x], 48000, 16));
  assert.equal(b.channels.length, 2);
  for (let i = 0; i < x.length; i++) assert.ok(Math.abs(b.channels[1][i] - x[i]) <= 1 / 32768);
});
