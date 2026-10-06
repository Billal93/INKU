import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPieces, srcToTimeline, timelineToSrc, mapWords, renderPieces, makeSnapper } from '../../montage/speech/edits.js';

test('morceaux : durées entières en images, contigus, sans dérive', () => {
  const segs = [{ t0: 0.123, t1: 1.457 }, { t0: 2.011, t1: 3.333 }, { t0: 5.5, t1: 7.77 }];
  const p = buildPieces(segs, { fps: 30 });
  let tl = 0;
  for (const x of p) {
    assert.equal(x.tl, tl); assert.ok(Number.isInteger(x.frames));
    assert.ok(Math.abs((x.srcOut - x.srcIn) * 30 - x.frames) < 1e-9);
    tl += x.frames;
  }
  // Après 3 morceaux, la position d'un instant source est exacte (aucune dérive cumulée).
  const t = srcToTimeline(p, 6.0);
  assert.ok(Math.abs(t - ((p[2].tl / 30) + (6.0 - p[2].srcIn))) < 1e-12);
  assert.equal(srcToTimeline(p, 1.8), null);            // passage coupé
  assert.ok(Math.abs(timelineToSrc(p, t) - 6.0) < 1e-12);
});

test('arrondi dans la marge : jamais au-delà du mot coupé suivant ni avant la fin du mot gardé', () => {
  const s = [{ t0: 1.0, t1: 1.51, minOut: 1.50, maxOut: 1.52 }];   // marge très étroite
  const p = buildPieces(s, { fps: 30 });
  assert.ok(p[0].srcOut >= 1.50 - 1e-9 && p[0].srcOut <= 1.52 + 1e-9, `fin ${p[0].srcOut}`);
});

test('mots recalés exactement à travers la table des coupes ; mot coupé absent', () => {
  const words = [{ w: 'a', t0: 0.2, t1: 0.5 }, { w: 'euh', t0: 0.8, t1: 1.2 }, { w: 'b', t0: 1.6, t1: 1.9 }];
  const p = buildPieces([{ t0: 0.12, t1: 0.58, maxOut: 0.7 }, { t0: 1.52, t1: 1.98 }], { fps: 30 });
  const m = mapWords(words, p);
  assert.deepEqual(m.broken, []);
  assert.deepEqual(m.words.map((w) => w.w), ['a', 'b']);
  assert.ok(Math.abs((m.words[1].t1 - m.words[1].t0) - 0.3) < 1e-12, 'durée du mot conservée');
  assert.ok(Math.abs(m.words[1].t0 - (p[1].tl / 30 + (1.6 - p[1].srcIn))) < 1e-12);
});

test('rendu : micro-fondus aux raccords, aucun saut d\'amplitude (clic)', () => {
  const fs = 48000, x = new Float32Array(fs * 3);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / fs);   // signal continu (pire cas)
  const p = buildPieces([{ t0: 0.1, t1: 0.9 }, { t0: 1.7, t1: 2.4 }], { fps: 30, fadeMs: 8 });
  const [y] = renderPieces(p, [x], fs);
  let maxJump = 0;
  for (let i = 1; i < y.length; i++) maxJump = Math.max(maxJump, Math.abs(y[i] - y[i - 1]));
  const natural = 0.5 * 2 * Math.PI * 220 / fs;        // pente maximale du sinus
  assert.ok(maxJump <= natural * 1.05, `saut ${maxJump} > ${natural}`);
  assert.equal(y.length, Math.round(((p[1].tl + p[1].frames) / 30) * fs));
});

test('point de coupe : minimum d\'énergie puis passage par zéro', () => {
  const fs = 16000, x = new Float32Array(fs);
  for (let i = 0; i < fs; i++) x[i] = (i > 6000 && i < 7000 ? 0.01 : 0.5) * Math.sin(2 * Math.PI * 200 * i / fs);
  const t = makeSnapper(x, fs)(0.35, 0.3, 0.5);
  assert.ok(t > 6000 / fs && t < 7000 / fs, `coupe à ${t}`);
  const i = Math.round(t * fs);
  assert.ok(Math.abs(x[i]) < 0.005);
});
