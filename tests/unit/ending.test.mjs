// Fin de vidéo : durées (cible atteinte en ADDITIONNANT), climax proposé, cartons de texte remplacés, clips de fin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, makeClip } from '../../montage/studio/edl.js';
import { endDurations, climaxPieces, buildEnd, applyEnd, suggestClimax, voiceEnd } from '../../montage/studio/ending.js';

function doc(voiceSec) {
  const d = newProject();
  d.clips.push(makeClip({ track: 'A1', start: 0, dur: Math.round(voiceSec * 30), srcId: 'voice', srcIn: 0 }));
  d.clips.push(makeClip({ track: 'V1', start: 0, dur: Math.round(voiceSec * 30) + 40, srcId: 'tr', srcIn: 0 }));
  return d;
}
const rec = (dur, cards = []) => {
  const n = dur * 8, card = new Array(n).fill(0);
  for (const [a, b] of cards) for (let i = a * 8; i < b * 8; i++) card[i] = 1;
  return { id: 'tr', duration: dur, shots: [{ start: 0, end: dur }], feat: { rate: 8, d: new Array(n).fill(0.1), luma: new Array(n).fill(0.4), card } };
};

test('durées : climax = cible − voix − miniature, cible 61,4 s atteinte', () => {
  const r = endDurations(doc(51.65));
  assert.equal(r.startF, 1550); assert.equal(r.thumbF, 53); assert.equal(r.climaxF, 1842 - 1550 - 53);
  assert.equal(r.totalF, 1842); assert.deepEqual(r.warnings, []);
});

test('durées : voix trop longue → miniature réduite, puis climax borné à 6 s et signalé', () => {
  const r = endDurations(doc(53.8));
  assert.equal(r.thumbF, 48); assert.equal(r.climaxF, 180); assert.equal(r.totalF, 1842); assert.deepEqual(r.warnings, []);
  const r2 = endDurations(doc(57));
  assert.equal(r2.climaxF, 180); assert.ok(r2.warnings.length && r2.suggestion);
  const r3 = endDurations(doc(40));
  assert.equal(r3.climaxF, 300); assert.equal(r3.thumbF, 60); assert.match(r3.suggestion, /10 s/);
});

test('cartons de texte remplacés par un plan voisin sans carton, audio continu', () => {
  const d = doc(51.65);
  const R = rec(120, [[83, 84.5]]);
  const { pieces, cards } = climaxPieces(d, R, 80, 239);
  assert.equal(cards.length, 1);
  assert.equal(pieces.reduce((a, p) => a + p.dur, 0), 239);
  const rep = pieces.find((p) => p.replaces);
  assert.ok(rep);
  assert.ok(rep.srcIn + rep.dur / 30 <= 80 + 1e-6, 'remplacement pris juste avant le climax');
  // aucun morceau ne montre le carton
  for (const p of pieces) { const a = p.srcIn, b = p.srcIn + p.dur / 30; assert.ok(!(a < 84.5 && b > 83 && !p.replaces) || false, `morceau ${a}-${b}`); }
});

test('clips de fin : climax en fond flou, son A5 continu avec fondu sur la miniature, plans V1 raccourcis à la voix', () => {
  const d = doc(51.65);
  const b = buildEnd(d, { rec: rec(120), startSec: 70, thumbRec: { id: 'thumb' } });
  applyEnd(d, b, { climax: { srcId: 'tr', start: 70 } });
  const v1 = d.clips.filter((c) => c.track === 'V1').sort((a, c) => a.start - c.start);
  assert.equal(v1[0].start + v1[0].dur, 1550);
  const cl = v1.filter((c) => c.role === 'climax');
  assert.equal(cl[0].start, 1550); assert.equal(cl[0].layout, 'fit-blur');
  const th = v1.find((c) => c.role === 'thumbnail');
  assert.equal(th.start + th.dur, 1842);
  const a5 = d.clips.find((c) => c.track === 'A5');
  assert.equal(a5.start, 1550); assert.equal(a5.dur, 1842 - 1550); assert.ok(Math.abs(a5.fadeOut - 53 / 30) < 1e-9);
  assert.equal(b.info.climaxStartSec, 1550 / 30);
  assert.equal(voiceEnd(d), 1550);
});

test('climax proposé : le passage fort, rapide et animé du dernier tiers gagne ; cartons pénalisés', () => {
  const R = rec(90, [[60, 64]]);
  const env = new Float32Array(90 * 8).fill(-35);
  for (let i = 70 * 8; i < 79 * 8; i++) { env[i] = -12; R.feat.d[i] = 0.35; }
  for (let i = 60 * 8; i < 64 * 8; i++) env[i] = -10;   // fort mais carton
  R.shots = [{ start: 0, end: 70 }, ...Array.from({ length: 12 }, (_, k) => ({ start: 70 + k * 0.75, end: 70.75 + k * 0.75 })), { start: 79, end: 90 }];
  const top = suggestClimax(R, env, 8);
  assert.equal(top.length, 3);
  assert.ok(top[0].start >= 69 && top[0].start <= 72, 'départ ' + top[0].start);
  assert.ok(top[0].why.includes('son fort'));
  for (const t of top) assert.ok(!(t.start > 56 && t.start < 64 && t.parts.K > 0.3) || t !== top[0]);
});
