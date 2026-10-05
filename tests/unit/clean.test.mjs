import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, wordIssues, groupTakes, takeScore, keptSegments, similarity, restarts, DEFAULTS } from '../../montage/speech/clean.js';

/** Mots réguliers à partir d'un texte : 0,3 s par mot, 0,05 s entre mots, pauses explicites « | » (0,8 s). */
function W(text, t = 0) {
  const out = [];
  for (const tok of text.split(' ')) {
    if (tok === '|') { t += 0.8; continue; }
    out.push({ w: tok, t0: +t.toFixed(3), t1: +(t + 0.3).toFixed(3) }); t += 0.35;
  }
  return out;
}

test('phrases : ponctuation ou pause longue', () => {
  const w = W('Bonjour à tous. Aujourd\'hui | on parle de Tsubasa');
  assert.deepEqual(splitSentences(w).map((s) => [s.a, s.b]), [[0, 2], [3, 3], [4, 7]]);
});

test('défauts : hésitation, répétition (1re occurrence coupée), mot amorcé, test micro', () => {
  const w = W('test un deux | Le le film sort euh en p- pour vous vous');
  const is = wordIssues(w);
  const types = is.map((x) => `${x.type}:${x.action}:${x.words.join(',')}`);
  assert.ok(types.includes('test micro:cut:0,1,2'), types.join(' '));
  assert.ok(types.includes('répétition:cut:3'), 'le premier « Le » est coupé');
  assert.ok(types.includes('hésitation:cut:7'));
  assert.ok(types.includes('bégaiement:cut:9'));
  assert.ok(types.includes('répétition:listen:11'), '« vous vous » peut être correct : à écouter');
});

test('répétition de groupe de mots : « il y a il y a »', () => {
  const is = wordIssues(W('il y a il y a deux garçons'));
  const r = is.find((x) => x.type === 'répétition');
  assert.deepEqual(r.words, [0, 1, 2]);
});

test('similarité et faux départ', () => {
  assert.ok(similarity(['deux', 'garçons', 'de', 'huit', 'ans'], ['deux', 'garçons', 'de', 'huit', 'ans']).sim === 1);
  assert.ok(similarity(['deux', 'garçons'], ['deux', 'garçons', 'de', 'huit', 'ans', 'inséparables']).prefix);
  assert.ok(!similarity(['le', 'film', 'sort'], ['deux', 'garçons', 'inséparables']).prefix);
});

test('prises : faux départ jamais choisi, meilleure prise, égalité → la dernière', () => {
  const w = [
    ...W('Deux garçons de huit ans.', 0),                         // prise 1 (avec un défaut injecté plus bas)
    ...W('Deux garçons.', 3),                                    // faux départ
    ...W('Deux garçons de huit ans.', 6),                         // prise 3 propre
    ...W('Ils sont inséparables.', 10),
  ];
  const sents = splitSentences(w);
  assert.equal(sents.length, 4);
  const issues = [{ type: 'bégaiement', t0: w[1].t0, t1: w[1].t1, words: [1], action: 'cut', reason: '' }];
  const g = groupTakes(w, sents, (s) => takeScore(w, s, issues));
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].members, [0, 1, 2]);
  assert.equal(g[0].best, 2);
  assert.deepEqual(g[0].partial, [false, true, false]);
  assert.match(g[0].reason, /prise 3\/3 gardée/);
  // Sans défaut : égalité → la dernière prise complète.
  const g2 = groupTakes(w, sents, (s) => takeScore(w, s, []));
  assert.equal(g2[0].best, 2);
  assert.match(g2[0].reason, /égalité/);
});

test('passages gardés : marges 0,08 s, blancs > 0,25 s supprimés, jamais sur un mot coupé', () => {
  const w = W('Bonjour à tous | euh le film');
  const sents = splitSentences(w);
  const segs = keptSegments(w, new Set([3]), sents, DEFAULTS);
  assert.equal(segs.length, 2);
  assert.ok(Math.abs(segs[0].t0 - Math.max(0, w[0].t0 - 0.08)) < 1e-9);
  assert.ok(segs[0].t1 <= w[3].t0, 'la marge s\'arrête avant le « euh » coupé');
  assert.ok(segs[1].t0 >= w[3].t1 - 1e-9);
  assert.deepEqual(segs.flatMap((s) => s.words), [0, 1, 2, 4, 5]);
});

test('reprises : faux départ avec mot coupé, prise recommencée dans la même phrase, pas de faux positif', () => {
  const a = restarts(W('La prononci | La prononciation est facile'));
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].words, [0, 1]);
  const b = restarts(W('souvent le fait est d’avoir subi des cours | souvent le fait est d’avoir subi des cours à l’étranger'));
  assert.deepEqual(b[0].words, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(restarts(W('il a fait de la plus belle façon de la plus haute importance')).length, 0, 'expression banale répétée');
  assert.equal(restarts(W('le chat dort et le chien joue')).length, 0);
});

test('phrases : majuscule après une pause sans ponctuation', () => {
  const w = [{ w: 'il', t0: 0, t1: 0.2 }, { w: 'part', t0: 0.25, t1: 0.5 }, { w: 'Ensuite', t0: 0.9, t1: 1.2 }, { w: 'il', t0: 1.25, t1: 1.4 }];
  assert.deepEqual(splitSentences(w).map((s) => [s.a, s.b]), [[0, 1], [2, 3]]);
});
