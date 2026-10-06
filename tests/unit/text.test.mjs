import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWords, alignWords, wer } from '../../montage/speech/text.js';

test('normalisation française pour le WER', () => {
  assert.deepEqual(normalizeWords("L’Amazone est, également, le fleuve le plus large !"), ['l', 'amazone', 'est', 'également', 'le', 'fleuve', 'le', 'plus', 'large']);
  assert.deepEqual(normalizeWords('Il a 10 000 fans… et 3,5 % de plus.'), ['il', 'a', '10000', 'fans', 'et', '3.5', '%', 'de', 'plus']);
  assert.deepEqual(normalizeWords('Où ? Ou à…'), ['où', 'ou', 'à']);            // accents conservés
  assert.deepEqual(normalizeWords('Sous-titres [Musique] (rires)'), ['sous', 'titres']);
});

test('alignement de Levenshtein : opérations et comptes', () => {
  const a = alignWords(['le', 'chat', 'dort'], ['le', 'le', 'chien', 'dort']);
  assert.equal(a.dist, 2);
  assert.equal(a.sub + a.ins + a.del, 2);
  assert.deepEqual(a.ops.map((o) => o.op).filter((o) => o !== 'ok').sort(), ['ins', 'sub']);
  assert.equal(alignWords([], ['a']).ins, 1);
  assert.equal(alignWords(['a'], []).del, 1);
});

test('WER cumulé', () => {
  const r = wer([{ ref: 'un deux trois quatre', hyp: 'un deux trois quatre' }, { ref: 'cinq six', hyp: 'cinq sept huit' }]);
  assert.equal(r.words, 6);
  assert.equal(r.errors, 2);
  assert.ok(Math.abs(r.wer - 2 / 6) < 1e-12);
});

test('nombres en lettres pour une comparaison équitable', async () => {
  const { numberToWordsFr, normalizeWordsSpelled } = await import('../../montage/speech/text.js');
  assert.equal(numberToWordsFr(71), 'soixante-et-onze');
  assert.equal(numberToWordsFr(80), 'quatre-vingts');
  assert.equal(numberToWordsFr(92), 'quatre-vingt-douze');
  assert.equal(numberToWordsFr(1999), 'mille-neuf-cent-quatre-vingt-dix-neuf');
  assert.equal(numberToWordsFr(200), 'deux-cents');
  assert.deepEqual(normalizeWordsSpelled('parfois 10 km'), ['parfois', 'dix', 'kilomètres']);
  assert.equal(wer([{ ref: 'parfois 10 km de large', hyp: 'parfois dix kilomètres de large' }], { spelled: true }).errors, 0);
});
