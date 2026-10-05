import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeChunks, filterHallucinations, needsRetry, refineWordTimes, applyGlossary, initialPrompt } from '../../montage/speech/asr-post.js';

test('assemblage : temps absolus, doublon au raccord retiré', () => {
  const w = mergeChunks([
    { start: 0, words: [{ w: ' Bonjour', t0: 0.5, t1: 0.9 }, { w: ' à', t0: 0.9, t1: 1.0 }, { w: ' tous', t0: 27.6, t1: 27.95 }] },
    { start: 27.5, words: [{ w: ' tous', t0: 0.1, t1: 0.45 }, { w: ' ici', t0: 0.6, t1: 0.9 }] },
  ]);
  assert.deepEqual(w.map((x) => x.w), ['Bonjour', 'à', 'tous', 'ici']);
  assert.ok(Math.abs(w[3].t0 - 28.1) < 1e-9);
});

test('hallucinations : mots hors parole retirés, boucle supprimée, phrase parasite signalée', () => {
  const speech = [{ start: 0, end: 3 }];
  const words = [
    { w: 'Le', t0: 0.1, t1: 0.3 }, { w: 'film', t0: 0.3, t1: 0.6 },
    { w: 'Sous-titrage', t0: 5.0, t1: 5.5 }, { w: 'ST', t0: 5.5, t1: 5.8 },      // dans le silence
  ];
  const r = filterHallucinations(words, speech);
  assert.deepEqual(r.words.map((x) => x.w), ['Le', 'film']);
  assert.equal(r.removed.length, 2);
  const loop = Array.from({ length: 10 }, (_, i) => ({ w: 'merci', t0: 0.2 * i, t1: 0.2 * i + 0.15 }));
  assert.equal(filterHallucinations(loop, [{ start: 0, end: 3 }]).words.length, 1);
  const p = filterHallucinations([{ w: 'Merci', t0: 0, t1: 0.3 }, { w: 'd’avoir', t0: 0.3, t1: 0.6 }, { w: 'regardé', t0: 0.6, t1: 1 }], speech);
  assert.ok(p.words.every((x) => x.flags && x.flags.includes('parasite')), 'dans la parole : signalé, pas retiré');
});

test('relance : texte répétitif, trop peu ou trop de mots', () => {
  assert.ok(needsRetry('oui oui oui oui oui oui oui oui oui oui oui oui oui', 6));
  assert.ok(needsRetry('bonjour', 8));
  assert.equal(needsRetry('Deux garçons de huit ans, inséparables, grandissent ensemble au Japon.', 4), null);
});

test('recalage : début du mot sur l\'attaque d\'énergie, jamais sur le mot voisin', () => {
  const db = new Float32Array(300).fill(-70);
  for (let i = 100; i < 140; i++) db[i] = -20;      // mot réel de 1,01 s à 1,40 s
  const [w] = refineWordTimes([{ w: 'film', t0: 0.95, t1: 1.35 }], db);
  assert.ok(Math.abs(w.t0 - 1.005) < 0.011, `début ${w.t0}`);
  assert.ok(Math.abs(w.t1 - 1.405) < 0.011, `fin ${w.t1}`);
  // Énergie plate (pas d'attaque nette) : on ne touche à rien.
  const flat = new Float32Array(300).fill(-20);
  const [u] = refineWordTimes([{ w: 'x', t0: 1.0, t1: 1.3 }], flat);
  assert.equal(u.t0, 1.0);
});

test('glossaire : variantes et accents corrigés, ponctuation conservée', () => {
  const w = applyGlossary([{ w: 'tsubassa,', t0: 0, t1: 1 }, { w: 'film', t0: 1, t1: 2 }], [{ text: 'Tsubasa' }]);
  assert.equal(w[0].w, 'Tsubasa,');
  assert.deepEqual(w[0].flags, ['glossaire']);
  assert.equal(w[1].w, 'film');
  assert.match(initialPrompt([{ text: 'Tsubasa' }]), /Euh.*Tsubasa/);
});

test('parole non transcrite : la phrase « sautée » par Whisper est retrouvée', async () => {
  const { uncoveredSpeech } = await import('../../montage/speech/asr-post.js');
  const speech = [{ start: 0, end: 4 }, { start: 5, end: 12 }];
  const words = [{ t0: 0.2, t1: 3.8 }, { t0: 5.1, t1: 7.0 }];   // 7,0 → 12,0 s jamais transcrit
  const h = uncoveredSpeech(words, speech);
  assert.equal(h.length, 1);
  assert.ok(Math.abs(h[0][0] - 7.0) < 1e-9 && Math.abs(h[0][1] - 12) < 1e-9);
  assert.deepEqual(uncoveredSpeech(words, [{ start: 0, end: 4 }]), []);
});
