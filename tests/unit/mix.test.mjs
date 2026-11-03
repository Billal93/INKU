// Mixage : niveaux relatifs à la voix (plafonds), musique -16 dB relatif + ducking, drops, limiteur true peak.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mixdown, limit } from '../../montage/audio/mix.js';
import { truePeak } from '../../montage/audio/loudness.js';

const FS = 48000;
const sine = (sec, amp, f = 220, phase = 0) => { const x = new Float32Array(Math.round(sec * FS)); for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / FS + phase); return x; };
/** « Voix » : salves de 1,2 s séparées de 0,8 s de silence. */
function voice(sec) {
  const x = new Float32Array(Math.round(sec * FS));
  for (let i = 0; i < x.length; i++) { const t = i / FS; if (t % 2 < 1.2) x[i] = 0.3 * Math.sin(2 * Math.PI * 180 * t) * Math.sin(Math.PI * (t % 2) / 1.2); }
  return x;
}
const rmsDb = (x, a, b) => { let s = 0; for (let i = Math.round(a * FS); i < Math.round(b * FS); i++) s += x[i] * x[i]; return 10 * Math.log10(s / (Math.round(b * FS) - Math.round(a * FS))); };

test('limiteur : true peak ≤ -1 dBTP sur un signal saturé, sans toucher un signal déjà sous le plafond', () => {
  const x = sine(2, 1.6, 997); const y = sine(2, 1.6, 3001, 1);
  const r = limit([x, y], FS, -1);
  assert.ok(r.truePeakDb <= -1 + 1e-3, 'tp ' + r.truePeakDb);
  const q = sine(1, 0.5); const before = q.slice();
  limit([q], FS, -1);
  assert.deepEqual(q, before);
});

test('voix : +4,6 dB puis limitée à -1 dBTP ; mix déterministe', () => {
  const v = voice(6);
  const items = [{ id: 'v', kind: 'voice', channels: [v], at: 0, dur: 6 }];
  const a = mixdown(items, 6), b = mixdown(items, 6);
  assert.ok(a.report.truePeakDb <= -1 + 1e-3);
  assert.equal(a.report.voice.gainDb, 4.6);
  assert.deepEqual(a.channels[0], b.channels[0]);
});

test('SFX et sons d’overlay plafonnés sous la crête de la voix (baisse seulement, jamais de hausse)', () => {
  const v = voice(4);
  const items = [
    { id: 'v', kind: 'voice', channels: [v], at: 0, dur: 4 },
    { id: 'click', kind: 'sfx', channels: [sine(0.1, 0.9, 2000)], at: 0.5, dur: 0.1 },
    { id: 'tr', kind: 'transition', channels: [sine(1, 0.9)], at: 1.5, dur: 1 },
    { id: 'abo', kind: 'subscribe', channels: [sine(1, 0.9)], at: 2.5, dur: 1 },
    { id: 'faible', kind: 'sfx', channels: [sine(0.1, 0.001)], at: 3, dur: 0.1 },
  ];
  const { report } = mixdown(items, 4);
  const s = Object.fromEntries(report.stems.map((x) => [x.id, x]));
  assert.ok(Math.abs(s.click.peakRelVoiceDb + 14) < 0.05 && s.click.capped);
  assert.ok(Math.abs(s.tr.peakRelVoiceDb + 10) < 0.05);
  assert.ok(Math.abs(s.abo.peakRelVoiceDb + 14) < 0.05);
  assert.equal(s.faible.capped, false);
  assert.equal(s.faible.gainDb, 0);
  assert.ok(report.peaksRelVoice.sfx <= -14 + 1e-6);
});

test('musique : -16 dB relatif hors voix, ducking ≈ -6 dB sous la voix, fondu de sortie', () => {
  const dur = 10;
  const items = [
    { id: 'v', kind: 'voice', channels: [new Float32Array(Math.round(dur * FS)).fill(0).map((_, i) => (i / FS >= 4 && i / FS < 7 ? 0.3 * Math.sin(2 * Math.PI * 180 * i / FS) : 0))], at: 0, dur },
    { id: 'm', kind: 'music', channels: [sine(3, 0.2, 440)], at: 0, dur, loop: true },
  ];
  const { channels, report } = mixdown(items, dur);
  const m = report.stems.find((x) => x.id === 'm');
  assert.equal(m.loop, true);
  // Hors voix (1-3 s) : musique seule ; sous la voix (5-6 s) : voix + musique baissée de 6 dB.
  const musicOnly = rmsDb(channels[0], 1, 3);
  const expectedMusic = 20 * Math.log10(0.2 / Math.SQRT2) + m.gainDb;
  assert.ok(Math.abs(musicOnly - expectedMusic) < 0.3, `${musicOnly} vs ${expectedMusic}`);
  // Musique seule = voix -16 LU (même timbre approximatif) : gain dans une plage plausible.
  assert.ok(Math.abs(report.voice.lufs - 16 - (m.musicLufs + m.gainDb)) < 0.01);
  // Fin : fondu de sortie 1,5 s → les 50 dernières ms quasi muettes.
  assert.ok(rmsDb(channels[0], dur - 0.05, dur) < musicOnly - 25);
});

test('musique : un « drop » nettement plus fort est détecté, daté et atténué', () => {
  const dur = 8;
  const mus = sine(dur, 0.1, 440);
  for (let i = 4 * FS; i < 5 * FS; i++) mus[i] *= 4;   // +12 dB pendant 1 s
  const { report, channels } = mixdown([{ id: 'm', kind: 'music', channels: [mus], at: 0, dur }], dur);
  assert.ok(report.drops.length >= 1);
  const d = report.drops[0];
  assert.ok(d.t >= 3.4 && d.t <= 4.1, 'début ' + d.t);
  assert.ok(d.db <= -6, 'atténuation ' + d.db);
  // Le passage fort ressort de moins de +12 dB après atténuation.
  assert.ok(rmsDb(channels[0], 4.5, 4.9) - rmsDb(channels[0], 2, 3) < 7);
  assert.ok(truePeak(channels[0], FS).dBTP <= -1 + 1e-3);
});

test('audio du trailer (climax) : au plus 12 dB sous la crête de la voix, musique duckée pendant le climax', () => {
  const items = [
    { id: 'v', kind: 'voice', channels: [voice(4)], at: 0, dur: 4 },
    { id: 'tr', kind: 'trailer', channels: [sine(3, 0.8)], at: 4, dur: 3, fadeOut: 1 },
  ];
  const { report } = mixdown(items, 7);
  const t = report.stems.find((x) => x.id === 'tr');
  assert.ok(Math.abs(t.peakRelVoiceDb + 12) < 0.05);
});
