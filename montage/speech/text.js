// Texte français : normalisation pour la mesure (WER) et alignement mot à mot par distance d'édition.
// Fonctions pures, testées dans tests/unit/text.test.mjs.

const APOS = /[’‘ʼ´`]/g;

/**
 * Normalisation pour comparer deux transcriptions (pas pour l'affichage) : minuscules, apostrophes unifiées et
 * séparées (« l'amazone » → « l amazone »), ponctuation et tirets retirés, accents CONSERVÉS (en français ils
 * distinguent des mots : « a »/« à », « ou »/« où »).
 * @param {string} s
 * @returns {string[]} mots
 */
export function normalizeWords(s) {
  return s.normalize('NFC').toLowerCase()
    .replace(APOS, "'")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')        // annotations entre crochets/parenthèses
    .replace(/(\d)[\s\u00a0\u202f](?=\d{3}\b)/g, '$1') // 10 000 → 10000
    .replace(/(\d),(\d)/g, '$1.$2')                    // 3,5 → 3.5
    .replace(/'/g, ' ')
    .replace(/[^\p{L}\p{N}.%€$]+/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')                // points hors nombres
    .split(/\s+/).filter(Boolean);
}

const UNITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
const TENS = ['', 'dix', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];
/** Nombre entier (0 à 999 999) écrit en lettres, à la française (« soixante-et-onze », « quatre-vingt-dix »). @param {number} n */
export function numberToWordsFr(n) {
  if (n < 17) return UNITS[n];
  if (n < 100) {
    const t = Math.floor(n / 10), u = n % 10;
    if (t === 7 || t === 9) return TENS[t] + (u === 1 && t === 7 ? '-et-' : '-') + (u < 7 ? UNITS[10 + u] : 'dix-' + UNITS[u]);
    if (u === 0) return TENS[t] + (t === 8 ? 's' : '');
    return TENS[t] + (u === 1 && t < 8 ? '-et-' : '-') + UNITS[u];
  }
  if (n < 1000) {
    const c = Math.floor(n / 100), r = n % 100;
    return (c > 1 ? UNITS[c] + '-' : '') + 'cent' + (r ? '-' + numberToWordsFr(r) : c > 1 ? 's' : '');
  }
  const m = Math.floor(n / 1000), r = n % 1000;
  return (m > 1 ? numberToWordsFr(m) + '-' : '') + 'mille' + (r ? '-' + numberToWordsFr(r) : '');
}

/**
 * Comme normalizeWords, mais les nombres en chiffres sont écrits en lettres (« 10 » → « dix ») : comparaison
 * équitable entre un modèle qui écrit les chiffres et un autre qui les épelle.
 * @param {string} s
 */
export function normalizeWordsSpelled(s) {
  const UNIT = { km: ['kilomètres'], '%': ['pour', 'cent'], '€': ['euros'], '$': ['dollars'] };
  return normalizeWords(s).flatMap((w) => (/^\d+$/.test(w) && Number(w) < 1e6 ? numberToWordsFr(Number(w)).split('-') : UNIT[w] || w.split('-')));
}

/**
 * Alignement de Levenshtein entre deux suites de mots (coûts unitaires), avec la liste des opérations.
 * @param {string[]} ref @param {string[]} hyp
 * @returns {{ dist: number, sub: number, del: number, ins: number, ops: { op: 'ok'|'sub'|'del'|'ins', r: number, h: number }[] }}
 */
export function alignWords(ref, hyp) {
  const n = ref.length, m = hyp.length, W = m + 1;
  const d = new Uint32Array((n + 1) * W);
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    d[i * W] = i;
    for (let j = 1; j <= m; j++) {
      const c = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i * W + j] = Math.min(d[(i - 1) * W + j - 1] + c, d[(i - 1) * W + j] + 1, d[i * W + j - 1] + 1);
    }
  }
  const ops = [];
  let i = n, j = m, sub = 0, del = 0, ins = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i * W + j] === d[(i - 1) * W + j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      const ok = ref[i - 1] === hyp[j - 1];
      ops.push({ op: ok ? 'ok' : 'sub', r: i - 1, h: j - 1 }); if (!ok) sub++; i--; j--;
    } else if (i > 0 && d[i * W + j] === d[(i - 1) * W + j] + 1) { ops.push({ op: 'del', r: i - 1, h: -1 }); del++; i--; }
    else { ops.push({ op: 'ins', r: -1, h: j - 1 }); ins++; j--; }
  }
  ops.reverse();
  return { dist: d[n * W + m], sub, del, ins, ops };
}

/**
 * Taux d'erreur de mots (Word Error Rate) cumulé sur plusieurs paires.
 * @param {{ ref: string, hyp: string }[]} pairs @param {{ spelled?: boolean }} [opt] spelled : nombres comparés en lettres
 */
export function wer(pairs, opt = {}) {
  let errors = 0, words = 0, sub = 0, del = 0, ins = 0;
  const norm = opt.spelled ? normalizeWordsSpelled : normalizeWords;
  for (const p of pairs) {
    const r = norm(p.ref), h = norm(p.hyp);
    const a = alignWords(r, h);
    errors += a.dist; words += r.length; sub += a.sub; del += a.del; ins += a.ins;
  }
  return { wer: words ? errors / words : 0, errors, words, sub, del, ins };
}
