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
 * @param {{ ref: string, hyp: string }[]} pairs
 */
export function wer(pairs) {
  let errors = 0, words = 0, sub = 0, del = 0, ins = 0;
  for (const p of pairs) {
    const r = normalizeWords(p.ref), h = normalizeWords(p.hyp);
    const a = alignWords(r, h);
    errors += a.dist; words += r.length; sub += a.sub; del += a.del; ins += a.ins;
  }
  return { wer: words ? errors / words : 0, errors, words, sub, del, ins };
}
