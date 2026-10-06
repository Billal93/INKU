// Remplir la timeline : trous comblés jusqu'à la fin de la voix, coupes sur les mots, durées 1-3 s, aucun plan réutilisé,
// plans noirs / cartons écartés ; cadrage sur le point d'intérêt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, makeClip, clipEnd, overlapSeconds } from '../../montage/studio/edl.js';
import { fillPlan, v1Gaps } from '../../montage/studio/fill.js';
import { focusPoint, cropXForFocus, textCard, histDistance, histogram } from '../../montage/studio/framing.js';

function project() {
  const d = newProject();
  d.clips.push(makeClip({ track: 'A1', start: 0, dur: 600, srcId: 'voice', srcIn: 0 }));
  const words = []; for (let f = 10; f < 600; f += 23) words.push({ w: 'mot', t0: f / 30 });
  d.clips.push(makeClip({ track: 'T1', start: 0, dur: 600, sub: { sentence: 0, words } }));
  d.clips.push(makeClip({ id: 'X', track: 'V1', start: 200, dur: 60, srcId: 'tr', srcIn: 10.2 }));
  return d;
}
const trailer = {
  id: 'tr', kind: 'video', fps: 24, letterbox: { usable: { x: 0, y: 0, w: 1920, h: 800 } },
  shots: [
    { start: 0, end: 4, motion: 0.05, focusX: 0.3 }, { start: 4, end: 6, black: true, motion: 0 }, { start: 6, end: 9, motion: 0.05, cards: 0.9 },
    { start: 9, end: 14, motion: 0.05, focusX: 0.7 }, { start: 14, end: 20, motion: 0.002 }, { start: 20, end: 40, motion: 0.04, focusX: 0.5 },
  ],
};

test('trous de V1', () => { assert.deepEqual(v1Gaps(project(), 0, 600), [[0, 200], [260, 600]]); });

test('remplissage : trous comblés à l\'image près, durées 1-3 s, coupes sur les mots, aucune réutilisation', () => {
  const d = project();
  const { clips, warnings } = fillPlan(d, [trailer]);
  assert.deepEqual(warnings, []);
  d.clips.push(...clips);
  assert.deepEqual(v1Gaps(d, 0, 600), []);
  const v1 = d.clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start);
  for (let i = 1; i < v1.length; i++) assert.equal(v1[i].start, clipEnd(v1[i - 1]));
  for (const c of clips) { assert.ok(c.dur >= 30 && c.dur <= 90, 'durée ' + c.dur); }
  const wordCuts = new Set(); for (let f = 10; f < 600; f += 23) wordCuts.add(f - 2);
  const onWord = clips.filter((c) => wordCuts.has(clipEnd(c)) || clipEnd(c) === 200 || clipEnd(c) === 600).length;
  assert.ok(onWord / clips.length >= 0.8, `${onWord}/${clips.length} coupes sur un mot`);
  // aucun intervalle de source utilisé deux fois ; jamais le plan noir ni le carton ; plan immobile ≤ 1,5 s
  const iv = v1.map((c) => [c.srcIn, c.srcIn + c.dur / 30]);
  for (let i = 0; i < iv.length; i++) for (let j = i + 1; j < iv.length; j++) assert.ok(overlapSeconds(iv[i][0], iv[i][1], iv[j][0], iv[j][1]) < 1e-6);
  for (const c of clips) {
    assert.ok(!(c.srcIn >= 4 && c.srcIn < 9), 'plan noir ou carton utilisé : ' + c.srcIn);
    if (c.srcIn >= 14 && c.srcIn < 20) assert.ok(c.dur <= 45);
  }
  assert.ok(clips[0].crop.x < 0.5);   // point d'intérêt à gauche
});

test('point d\'intérêt : un sujet détaillé à droite d\'un fond uni → fenêtre décalée à droite', () => {
  const w = 64, h = 36, d = new Uint8ClampedArray(w * h * 4).fill(40);
  for (let y = 10; y < 30; y++) for (let x = 44; x < 58; x++) { const i = (y * w + x) * 4; const v = (x + y) % 2 ? 250 : 10; d[i] = d[i + 1] = d[i + 2] = v; }
  const f = focusPoint(d, w, h);
  assert.ok(f.x > 0.7 && f.x < 0.85, 'x ' + f.x);
  assert.ok(cropXForFocus(f.x, { w: 1920, h: 800 }) > 0.8);
  assert.equal(cropXForFocus(0.5, { w: 1920, h: 800 }), 0.5);
});

test('carton de texte : texte noir sur blanc et crédits blancs sur noir détectés ; scène sombre non', () => {
  const w = 64, h = 36;
  const mk = (bg, ink, frac) => { const d = new Uint8ClampedArray(w * h * 4); for (let p = 0; p < w * h; p++) { const v = (p % 97) / 97 < frac ? ink : bg; d.set([v, v, v, 255], p * 4); } return d; };
  assert.equal(textCard(mk(240, 10, 0.06), w, h).card, true);
  assert.equal(textCard(mk(5, 245, 0.04), w, h).kind, 'sombre');
  const scene = new Uint8ClampedArray(w * h * 4); for (let p = 0; p < w * h; p++) scene.set([20 + (p % 40), 15 + (p % 30), 60, 255], p * 4);
  assert.equal(textCard(scene, w, h).card, false);
  const a = histogram(mk(240, 10, 0.06), w, h).hist, b = histogram(scene, w, h).hist;
  assert.equal(histDistance(a, a), 0); assert.ok(histDistance(a, b) > 1);
});
