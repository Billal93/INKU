// Sous-titres : repérage des mots importants / texte impact (avec variantes) et découpage en groupes de 2-3 mots.
// Règles du brief (2.6) : 2 à 3 mots par groupe, jamais plus, sauf une expression colorée (jusqu'à 4 mots sur 2 lignes) ;
// chaque mot d'une expression est coloré même si l'expression est coupée entre deux groupes.
// Fonctions pures (tests/unit/subs.test.mjs).
import { foldWord, wordsToNumber } from './french.js';

/** @typedef {{ text: string, kind: 'important'|'impact', variants?: string[] }} GlossaryEntry */
/** @typedef {{ w: string, t0: number, t1: number, kind?: 'normal'|'important'|'impact', expr?: number }} SubWord */

/** Distance d'édition bornée (Levenshtein) entre deux chaînes courtes. */
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Deux mots se valent-ils ? (casse, accents, chiffres/lettres, petite faute de transcription sur les mots longs) */
export function sameWord(a, b) {
  const x = foldWord(a), y = foldWord(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const nx = /^\d+$/.test(x) ? Number(x) : wordsToNumber(a), ny = /^\d+$/.test(y) ? Number(y) : wordsToNumber(b);
  if (nx !== null && nx === ny) return true;
  return Math.min(x.length, y.length) >= 5 && lev(x, y, 1) <= 1;
}

/**
 * Marque les mots importants / impact d'après le glossaire du projet (expressions de plusieurs mots incluses).
 * Une expression « 25 décembre » reconnaît aussi « vingt-cinq décembre ».
 * @param {SubWord[]} words @param {GlossaryEntry[]} glossary
 * @returns {SubWord[]} copie avec kind et expr (numéro d'expression) renseignés
 */
export function tagWords(words, glossary) {
  const out = words.map((w) => ({ ...w, kind: w.kind || 'normal' }));
  let exprId = 0;
  const forms = glossary.flatMap((g) => [g.text, ...(g.variants || [])].map((t) => ({ g, toks: t.split(/[\s]+/).filter(Boolean) })));
  forms.sort((a, b) => b.toks.length - a.toks.length);     // expressions les plus longues d'abord
  for (let i = 0; i < out.length; i++) {
    for (const f of forms) {
      // Un nombre écrit en lettres peut occuper plusieurs mots (« vingt-cinq » ou « vingt cinq ») : on tente 1 à 3 mots.
      const m = matchAt(out, i, f.toks);
      if (!m) continue;
      const id = ++exprId;
      for (let k = i; k < i + m; k++) if (out[k].kind === 'normal' || f.g.kind === 'impact') { out[k].kind = f.g.kind; out[k].expr = m > 1 ? id : undefined; }
      i += m - 1;
      break;
    }
  }
  return out;
}

/** Nombre de mots de `words` à partir de i qui correspondent à l'expression `toks`, sinon 0. */
function matchAt(words, i, toks) {
  let k = i;
  for (const t of toks) {
    if (k >= words.length) return 0;
    if (sameWord(words[k].w, t)) { k++; continue; }
    // « 25 » ↔ « vingt cinq » sur deux mots.
    if (/^\d+$/.test(foldWord(t)) && k + 1 < words.length && wordsToNumber(words[k].w + ' ' + words[k + 1].w) === Number(foldWord(t))) { k += 2; continue; }
    return 0;
  }
  return k - i;
}

const WEAK = new Set(['le', 'la', 'les', 'l', 'de', 'des', 'du', 'd', 'un', 'une', 'a', 'au', 'aux', 'en', 'et', 'ou', 'que', 'qu', 'qui', 'son', 'sa', 'ses', 'leur', 'leurs', 'ce', 'cet', 'cette', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'pour', 'par', 'sur', 'dans', 'avec', 'sans', 'ne', 'n', 'se', 's', 'je', 'j', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', 'est', 'c', 'y']);

/**
 * Découpage en groupes (programmation dynamique) : 2-3 mots idéalement, coupures de préférence aux virgules et aux
 * pauses, jamais sur un mot outil en fin de groupe si on peut l'éviter, expression gardée entière si possible.
 * @param {SubWord[]} words mots (déjà marqués) d'UNE phrase
 * @param {{ maxWords?: number }} [opt]
 * @returns {number[][]} groupes d'indices
 */
export function groupWords(words, opt = {}) {
  const maxW = opt.maxWords ?? 3, n = words.length;
  if (!n) return [];
  const cost = new Float64Array(n + 1).fill(Infinity), from = new Int32Array(n + 1).fill(-1);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    if (cost[i] === Infinity) continue;
    for (let len = 1; len <= 4 && i + len <= n; len++) {
      const g = words.slice(i, i + len);
      const exprInside = g[0].expr !== undefined && g.every((w) => w.expr === g[0].expr);
      if (len > maxW && !(len === 4 && exprInside)) continue;
      let c = 0;
      if (len === 1) c += n === 1 ? 0 : (g[0].kind !== 'normal' ? 1.5 : 4);
      if (len === maxW + 1) c += 0.5;
      const last = g[len - 1];
      if (i + len < n) {
        const next = words[i + len];
        if (WEAK.has(foldWord(last.w))) c += 2.5;                         // « LE » en fin de groupe
        if (last.expr !== undefined && next.expr === last.expr) c += 3;      // expression coupée
        if (/[,;:]$/.test(last.w)) c -= 1.5;                               // virgule : bonne coupure
        if (next.t0 - last.t1 > 0.3) c -= 1;                               // pause : bonne coupure
      }
      for (let k = 1; k < len; k++) if (g[k].t0 - g[k - 1].t1 > 0.45) c += 3; // longue pause DANS le groupe
      if (cost[i] + c < cost[i + len]) { cost[i + len] = cost[i] + c; from[i + len] = i; }
    }
  }
  const groups = [];
  for (let e = n; e > 0; e = from[e]) groups.push(Array.from({ length: e - from[e] }, (_, k) => from[e] + k));
  return groups.reverse();
}
