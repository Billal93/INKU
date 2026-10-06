import test from 'node:test';
import assert from 'node:assert/strict';
import { upperFr, typoFr, foldWord, wordsToNumber } from '../../montage/subs/french.js';
import { tagWords, groupWords, sameWord } from '../../montage/subs/groups.js';
import { layoutGroup, baseFontSize, STYLE } from '../../montage/subs/layout.js';
import { popScale, blockMotion, groupState, shake, PRESETS } from '../../montage/subs/anim.js';

const measure = (text, size) => ({ width: [...text].length * size * 0.6, capHeight: size * 0.7 });
const W = (s) => s.split(' ').map((w, i) => ({ w, t0: i * 0.3, t1: i * 0.3 + 0.25 }));

test('typographie : majuscules accentuées, Œ, apostrophe et espaces insécables', () => {
  assert.equal(upperFr('élève à ça œuvre'), 'ÉLÈVE À ÇA ŒUVRE');
  assert.equal(typoFr("l'été !"), 'l’été\u202f!');
  assert.equal(typoFr('Titre : "Film"'), 'Titre\u00a0: «\u00a0Film\u00a0»');
  assert.equal(typoFr(typoFr("c'est ?")), typoFr("c'est ?"));     // idempotent
  assert.equal(foldWord('Été'), 'ete');
  assert.equal(wordsToNumber('vingt-cinq'), 25);
  assert.equal(wordsToNumber('quatre-vingt-dix'), 90);
});

test('variantes : casse, accents, chiffres/lettres, petite faute sur un mot long', () => {
  assert.ok(sameWord('tsubasa', 'Tsubasa'));
  assert.ok(sameWord('Tsubassa', 'Tsubasa'));          // faute de transcription d'une lettre
  assert.ok(!sameWord('Lune', 'Luna'));                // mot court : pas de tolérance
  assert.ok(sameWord('25', 'vingt-cinq'));
});

test('mots importants / impact, expression sur plusieurs mots, reconnue même écrite en lettres', () => {
  const words = W('le film sort le vingt cinq décembre avec Tsubasa');
  const t = tagWords(words, [{ text: '25 décembre', kind: 'impact' }, { text: 'Tsubasa', kind: 'important' }]);
  assert.deepEqual(t.map((w) => w.kind), ['normal', 'normal', 'normal', 'normal', 'impact', 'impact', 'impact', 'normal', 'important']);
  assert.ok(t[4].expr && t[4].expr === t[6].expr);
});

test('groupes : 2-3 mots, pas de mot outil en fin de groupe, expression gardée (≤ 4 mots)', () => {
  const t = tagWords(W('deux garçons de huit ans inséparables qui grandissent ensemble'), [{ text: 'inséparables', kind: 'important' }]);
  const g = groupWords(t);
  for (const x of g) assert.ok(x.length >= 1 && x.length <= 3, JSON.stringify(g));
  assert.deepEqual(g.flat(), t.map((_, i) => i));
  for (const x of g.slice(0, -1)) assert.ok(!['de', 'qui'].includes(t[x[x.length - 1]].w), `groupe finissant par « ${t[x[x.length - 1]].w} »`);
  const e = tagWords(W('sortie le vingt cinq décembre'), [{ text: '25 décembre', kind: 'impact' }]);
  const ge = groupWords(e);
  assert.ok(ge.some((x) => x.length >= 3 && x.every((i) => e[i].kind === 'impact')), JSON.stringify(ge));
});

test('mise en page : mot important sur la ligne suivante, bloc centré, taille constante', () => {
  const base = 80;
  const l = layoutGroup([{ w: 'deux' }, { w: 'garçons' }, { w: 'inséparables', kind: 'important' }], base, measure);
  assert.equal(l.lines, 2);
  const imp = l.words.find((w) => w.kind === 'important');
  assert.equal(imp.size, base * STYLE.importantScale);
  assert.ok(imp.y > l.words[0].y, 'le mot important est sur la 2e ligne');
  assert.ok(l.words.filter((w) => w.kind === 'normal').every((w) => w.size === base), 'taille normale jamais réduite');
  for (const w of l.words) assert.ok(w.x - w.w / 2 >= 90 - 1e-6 && w.x + w.w / 2 <= 990 + 1e-6);
  const ys = l.words.map((w) => w.y);
  assert.ok(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - 960) < 0.75 * base, 'bloc centré verticalement');
});

test('mise en page : groupe trop large → 2 lignes équilibrées, jamais de réduction', () => {
  const l = layoutGroup([{ w: 'extraordinairement' }, { w: 'magnifique' }, { w: 'aventure' }], 80, measure);
  assert.equal(l.lines, 2);
  assert.ok(l.words.every((w) => w.size === 80));
  const base = baseFontSize(['INSÉPARABLES'], ['extraordinairement'], measure);
  assert.ok(measure('INSÉPARABLES', base).width * 1.25 <= 900 + 1e-6);
});

test('animation : pop 60 → 120 → 100 % en 6 images, valeurs continues, aucune rotation', () => {
  assert.equal(popScale(0, 'normal'), 0.6);
  assert.ok(Math.abs(popScale(3, 'normal') - 1.2) < 1e-12);
  assert.equal(popScale(6, 'normal'), 1);
  assert.ok(Math.abs(popScale(3, 'important') - 1.35) < 1e-12);
  assert.ok(Math.abs(popScale(3, 'impact') - 1.6) < 1e-12);
  // continuité : aucune marche entre deux instants proches
  for (let k = 0; k < 8; k += 0.01) assert.ok(Math.abs(popScale(k + 0.01, 'normal') - popScale(k, 'normal')) < 0.03);
  // tremblement de l'impact : ±4 px max, 0,15 s après le pop
  let mx = 0; for (let k = 0; k < 20; k += 0.25) { const s = shake(k, 30); mx = Math.max(mx, Math.abs(s.dx), Math.abs(s.dy)); }
  assert.ok(mx > 1 && mx <= 4);
  assert.deepEqual(shake(5, 30), { dx: 0, dy: 0 });
});

test('mouvement circulaire : rayon 5 px, période 1,6 s, départ au centre, sens alterné, zoom 100 → 103 %', () => {
  const m0 = blockMotion(0, 2, 0);
  assert.ok(Math.abs(m0.dx) < 1e-12 && Math.abs(m0.dy) < 1e-12 && m0.zoom === 1);
  let maxD = 0;
  for (let t = 0; t < 1.6; t += 0.01) { const m = blockMotion(t, 2, 0); maxD = Math.max(maxD, Math.hypot(m.dx, m.dy)); }
  assert.ok(Math.abs(maxD - 10) < 0.05, `diamètre ${maxD}`);
  const p = blockMotion(1.6, 2, 0);
  assert.ok(Math.hypot(p.dx, p.dy) < 1e-9, 'revient au départ après une période');
  assert.ok(Math.abs(blockMotion(2, 2, 0).zoom - 1.03) < 1e-12);
  // sens alterné : groupes pairs et impairs tournent dans des sens opposés (produit vectoriel de signe opposé)
  const cross = (i) => { const a = blockMotion(0.05, 2, i), b = blockMotion(0.1, 2, i); return a.dx * b.dy - a.dy * b.dx; };
  assert.ok(Math.sign(cross(0)) !== Math.sign(cross(1)));
});

test('état d\'un groupe : hors intervalle = rien ; positions décimales (sous-pixel)', () => {
  const l = layoutGroup([{ w: 'bonjour' }, { w: 'à' }, { w: 'tous' }], 80, measure);
  const g = { start: 30, end: 75, index: 3 };
  assert.equal(groupState(l, g, 29, 30), null);
  assert.equal(groupState(l, g, 75, 30), null);
  const s = groupState(l, g, 40.5, 30, PRESETS['pop rapide']);
  assert.equal(s.length, 3);
  assert.ok(s.some((w) => !Number.isInteger(w.x)));
});
