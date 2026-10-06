// Sonie EBU R128 et true peak : cas de référence de l'EBU Tech 3341 (sonie) et 3342 (LRA), signaux synthétisés.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureLoudness, truePeak, kWeightingCoefs } from '../../montage/audio/loudness.js';

const FS = 48000;
/** Suite de segments sinusoïdaux 1 kHz [dBFS, secondes], stéréo identique. */
function tones(segs, freq = 1000) {
  const n = segs.reduce((a, [, s]) => a + Math.round(s * FS), 0);
  const x = new Float32Array(n);
  let i = 0;
  for (const [db, sec] of segs) {
    const A = Math.pow(10, db / 20), m = Math.round(sec * FS);
    for (let k = 0; k < m; k++, i++) x[i] = A * Math.sin(2 * Math.PI * freq * i / FS);
  }
  return [x, x.slice()];
}
const near = (v, ref, tol, msg) => assert.ok(Math.abs(v - ref) <= tol, `${msg} : ${v.toFixed(3)} au lieu de ${ref} ± ${tol}`);

test('pondération K à 48 kHz = coefficients de la norme BS.1770-4', () => {
  const [sh, hp] = kWeightingCoefs(48000);
  near(sh.b[0], 1.53512485958697, 1e-9, 'b0'); near(sh.b[1], -2.69169618940638, 1e-9, 'b1'); near(sh.b[2], 1.19839281085285, 1e-9, 'b2');
  near(sh.a[1], -1.69065929318241, 1e-9, 'a1'); near(sh.a[2], 0.73248077421585, 1e-9, 'a2');
  near(hp.a[1], -1.99004745483398, 1e-9, 'hp a1'); near(hp.a[2], 0.99007225036621, 1e-9, 'hp a2');
});

test('EBU Tech 3341 cas 1-2 : sinus 1 kHz −23 et −33 dBFS → −23,0 et −33,0 LUFS (±0,1)', () => {
  for (const db of [-23, -33]) {
    const r = measureLoudness(tones([[db, 20]]), FS);
    near(r.integrated, db, 0.1, 'intégrée'); near(r.momentaryMax, db, 0.1, 'momentary'); near(r.shortTermMax, db, 0.1, 'short-term');
  }
});

test('EBU Tech 3341 cas 3-5 : portes absolue et relative', () => {
  near(measureLoudness(tones([[-36, 10], [-23, 60], [-36, 10]]), FS).integrated, -23, 0.1, 'cas 3');
  near(measureLoudness(tones([[-72, 10], [-36, 10], [-23, 60], [-36, 10], [-72, 10]]), FS).integrated, -23, 0.1, 'cas 4');
  near(measureLoudness(tones([[-26, 20], [-20, 20.1], [-26, 20]]), FS).integrated, -23, 0.1, 'cas 5');
});

test('EBU Tech 3342 : plage de sonie LRA (±1 LU)', () => {
  near(measureLoudness(tones([[-20, 20], [-30, 20]]), FS).lra, 10, 1, 'cas 1');
  near(measureLoudness(tones([[-20, 20], [-15, 20]]), FS).lra, 5, 1, 'cas 2');
  near(measureLoudness(tones([[-40, 20], [-20, 20]]), FS).lra, 20, 1, 'cas 3');
  near(measureLoudness(tones([[-50, 20], [-35, 20], [-20, 20], [-35, 20], [-50, 20]]), FS).lra, 15, 1, 'cas 4');
});

test('mono compté en double mono = +3,01 dB', () => {
  const [l] = tones([[-23, 10]]);
  near(measureLoudness([l], FS, { dualMono: true }).integrated, -23, 0.1, 'double mono');
  near(measureLoudness([l], FS).integrated, -26.01, 0.1, 'mono simple');
});

test('true peak ×4 : pics inter-échantillons retrouvés (tolérance EBU 3341 : +0,2 / −0,4 dB)', () => {
  // Sinus à fs/4 déphasé de 45° : les échantillons valent A/√2 (−3 dB) alors que le vrai pic vaut A.
  for (const [freq, phase] of [[12000, Math.PI / 4], [997, 0.3], [5000, 1.1], [10000, 0.7], [15000, 2.0], [18000, 0.4]]) {
    const A = 0.5, n = FS;
    const x = new Float32Array(n);
    // Fondus de 10 ms : un démarrage brutal crée un vrai dépassement inter-échantillons (Gibbs), hors sujet ici.
    for (let i = 0; i < n; i++) x[i] = A * Math.min(1, i / 480, (n - 1 - i) / 480) * Math.sin(2 * Math.PI * freq * i / FS + phase);
    const r = truePeak(x, FS);
    const err = r.dBTP - 20 * Math.log10(A);
    assert.ok(err <= 0.2 && err >= -0.4, `${freq} Hz : erreur ${err.toFixed(3)} dB (pic échantillon ${(20 * Math.log10(r.samplePeak / A)).toFixed(2)} dB)`);
  }
  const x = new Float32Array(FS);
  for (let i = 0; i < FS; i++) x[i] = Math.min(1, i / 480, (FS - 1 - i) / 480) * Math.sin(2 * Math.PI * 12000 * i / FS + Math.PI / 4);
  const r = truePeak(x, FS);
  near(20 * Math.log10(r.samplePeak), -3.01, 0.01, 'pic échantillon');
  near(r.dBTP, 0, 0.1, 'true peak');
});

