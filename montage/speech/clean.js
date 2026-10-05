// Nettoyage de la voix : détection des défauts et proposition de coupes (l'automatique PROPOSE, l'utilisateur VALIDE).
// Entrées : mots horodatés (temps de la SOURCE, en secondes) + descripteurs acoustiques. Sorties : phrases, prises
// regroupées avec la meilleure choisie et expliquée, défauts (avec raison), liste des passages gardés.
// Règles du brief (section 2.2) : prises multiples → une seule gardée (la meilleure, la DERNIÈRE en cas d'égalité),
// jamais de phrase recomposée à partir de plusieurs prises, coupes jamais au milieu d'un mot, marge 0,08 s,
// blancs > 0,25 s supprimés, micro-pause ≈ 0,1 s entre phrases. Fonctions pures, testées (tests/unit/clean.test.mjs).

import { normalizeWords, alignWords } from './text.js';

/** @typedef {{ w: string, t0: number, t1: number, conf?: number }} Word */
/** @typedef {{ type: string, t0: number, t1: number, words: number[], action: 'cut'|'listen', reason: string }} Issue */

export const DEFAULTS = {
  hesitations: ['euh', 'euhh', 'heu', 'hum', 'hmm', 'mmh', 'mh', 'em', 'eum'],
  softHesitations: ['ben', 'bah', 'bon', 'beh'],          // parfois de vrais mots : signalés, pas coupés
  micTest: ['test', 'tests', 'testing', 'allo', 'allô', 'micro'],
  sentenceGap: 0.6,          // pause qui sépare deux phrases sans ponctuation (s)
  takeSimilarity: 0.6,       // similarité de texte pour regrouper deux prises
  takeWindow: 4,             // une reprise est cherchée dans les 4 phrases suivantes
  margin: 0.08,              // marge autour d'un mot gardé (s)
  maxPause: 0.25,            // blanc maximal conservé dans une phrase (s)
  sentencePause: 0.10,       // micro-pause entre deux phrases (s)
  lowConf: 0.45,             // confiance sous laquelle un mot est « à écouter »
};

const END = /[.!?…]$/;
const key = (/** @type {string} */ w) => normalizeWords(w).join(' ');

/**
 * Découpe en phrases : ponctuation finale du modèle, ou pause longue.
 * @param {Word[]} words @param {typeof DEFAULTS} [o]
 * @returns {{ a: number, b: number }[]} indices de mots [a, b] inclus
 */
export function splitSentences(words, o = DEFAULTS) {
  const out = [];
  let a = 0;
  for (let i = 0; i < words.length; i++) {
    const last = i === words.length - 1;
    const gap = last ? Infinity : words[i + 1].t0 - words[i].t1;
    if (last || END.test(words[i].w.trim()) || gap >= o.sentenceGap) { out.push({ a, b: i }); a = i + 1; }
  }
  return out;
}

/**
 * Similarité de deux suites de mots (1 = identiques), et « préfixe » : la plus courte est le début de l'autre.
 * @param {string[]} x @param {string[]} y
 */
export function similarity(x, y) {
  if (!x.length || !y.length) return { sim: 0, prefix: false };
  const d = alignWords(x, y).dist;
  const sim = 1 - d / Math.max(x.length, y.length);
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  let p = 0; while (p < s.length && s[p] === l[p]) p++;
  // Faux départ : la plus courte (au moins 1 mot) est un début (presque) exact de la plus longue.
  const prefix = s.length < l.length && p >= Math.max(1, Math.ceil(s.length * 0.75));
  return { sim, prefix };
}

/**
 * Défauts au niveau des mots : hésitations, répétitions immédiates (mot ou groupe de 2 à 4 mots), mot amorcé
 * (« p- pour », « pou pour »), test de micro en début, mots de faible confiance.
 * @param {Word[]} words @param {typeof DEFAULTS} [o]
 * @returns {Issue[]}
 */
export function wordIssues(words, o = DEFAULTS) {
  const issues = [];
  const k = words.map((w) => key(w.w));
  for (let i = 0; i < words.length; i++) {
    const w = k[i];
    if (o.hesitations.includes(w)) issues.push({ type: 'hésitation', t0: words[i].t0, t1: words[i].t1, words: [i], action: 'cut', reason: `« ${words[i].w.trim()} »` });
    else if (o.softHesitations.includes(w) && (i === 0 || words[i].t0 - words[i - 1].t1 > 0.15)) issues.push({ type: 'hésitation', t0: words[i].t0, t1: words[i].t1, words: [i], action: 'listen', reason: `« ${words[i].w.trim()} » (peut-être voulu)` });
    // Mot amorcé : « p- », « pou » juste avant « pour » (préfixe strict d'au moins 1 lettre, collé au suivant).
    if (i + 1 < words.length && w && k[i + 1].startsWith(w) && w.length < k[i + 1].length && w.length <= 4
      && (/-$/.test(words[i].w.trim()) || words[i + 1].t0 - words[i].t1 < 0.35)) {
      issues.push({ type: 'bégaiement', t0: words[i].t0, t1: words[i].t1, words: [i], action: 'cut', reason: `« ${words[i].w.trim()} » avant « ${words[i + 1].w.trim()} »` });
    }
    if (words[i].conf !== undefined && words[i].conf < o.lowConf) issues.push({ type: 'douteux', t0: words[i].t0, t1: words[i].t1, words: [i], action: 'listen', reason: `faible confiance (${Math.round(words[i].conf * 100)} %)` });
  }
  // Répétitions immédiates de n-grammes (n = 4 → 1) : on coupe la PREMIÈRE occurrence (la reprise est la bonne).
  const taken = new Set();
  for (let n = 4; n >= 1; n--) {
    for (let i = 0; i + 2 * n <= words.length; i++) {
      let same = true;
      for (let j = 0; j < n; j++) if (!k[i + j] || k[i + j] !== k[i + n + j]) { same = false; break; }
      if (!same) continue;
      const idx = Array.from({ length: n }, (_, j) => i + j);
      if (idx.some((x) => taken.has(x))) continue;
      // « nous nous » ou « vous vous » peuvent être corrects : signalés seulement pour un mot de ce type.
      const legit = n === 1 && ['nous', 'vous', 'que', 'si', 'très'].includes(k[i]);
      if (words[i + n].t0 - words[i + n - 1].t1 > 1.5) continue;     // trop éloignés : pas une répétition immédiate
      idx.forEach((x) => taken.add(x));
      issues.push({ type: 'répétition', t0: words[i].t0, t1: words[i + n - 1].t1, words: idx, action: legit ? 'listen' : 'cut', reason: `« ${idx.map((x) => words[x].w.trim()).join(' ')} » répété` });
    }
  }
  // Test de micro : premiers mots (avant 10 s) contenant « test », « un deux trois »…
  const head = words.findIndex((w) => w.t0 > 10);
  const lim = head < 0 ? words.length : head;
  for (let i = 0; i < lim; i++) {
    if (o.micTest.includes(k[i]) || (k[i] === 'un' && k[i + 1] === 'deux')) {
      const s = splitSentences(words, o).find((x) => x.a <= i && i <= x.b);
      issues.push({ type: 'test micro', t0: words[s.a].t0, t1: words[s.b].t1, words: range(s.a, s.b), action: 'cut', reason: 'test de micro avant le texte' });
      break;
    }
  }
  return issues.sort((a, b) => a.t0 - b.t0);
}

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/**
 * Regroupe les prises d'une même phrase et choisit la meilleure.
 * @param {Word[]} words @param {{ a: number, b: number }[]} sents
 * @param {(s: { a: number, b: number }) => { score: number, notes: string[] }} scoreTake qualité (0-100) d'une prise
 * @param {typeof DEFAULTS} [o]
 * @returns {{ members: number[], best: number, scores: number[], reason: string, partial: boolean[] }[]}
 */
export function groupTakes(words, sents, scoreTake, o = DEFAULTS) {
  const toks = sents.map((s) => words.slice(s.a, s.b + 1).flatMap((w) => normalizeWords(w.w)).filter((w) => !o.hesitations.includes(w)));
  const group = new Int32Array(sents.length).fill(-1);
  const groups = [];
  for (let i = 0; i < sents.length; i++) {
    if (group[i] >= 0) continue;
    const g = [i]; group[i] = groups.length;
    // Une reprise est une phrase PROCHE dans le temps qui dit la même chose (ou dont l'une est le début de l'autre).
    for (let j = i + 1; j < Math.min(sents.length, g[g.length - 1] + 1 + o.takeWindow); j++) {
      if (group[j] >= 0) continue;
      const last = g[g.length - 1];
      const s = similarity(toks[last], toks[j]);
      const s0 = similarity(toks[i], toks[j]);
      if (s.sim >= o.takeSimilarity || s.prefix || s0.sim >= o.takeSimilarity) { g.push(j); group[j] = groups.length; }
    }
    groups.push(g);
  }
  return groups.map((g) => {
    const lens = g.map((i) => toks[i].length);
    const maxLen = Math.max(...lens);
    // Une prise nettement plus courte que la plus longue est un faux départ : jamais choisie.
    const partial = g.map((i, k) => g.length > 1 && lens[k] < maxLen * 0.75);
    const sc = g.map((i) => scoreTake(sents[i]));
    let best = -1;
    g.forEach((_, k) => {
      if (partial[k]) return;
      if (best < 0 || sc[k].score >= sc[best].score - 2) best = k;   // égalité (±2 points) → la DERNIÈRE
    });
    if (best < 0) best = g.length - 1;
    let reason = 'prise unique';
    if (g.length > 1) {
      const others = g.map((_, k) => k).filter((k) => k !== best);
      const tie = others.every((k) => partial[k] || sc[k].score < sc[best].score - 2) ? '' : ' (égalité : la dernière)';
      reason = `prise ${best + 1}/${g.length} gardée${tie} : ${sc[best].notes.join(', ') || 'propre'}`
        + others.map((k) => ` ; prise ${k + 1} : ${partial[k] ? 'faux départ' : sc[k].notes.join(', ') || 'moins bonne'} (${Math.round(sc[k].score)})`).join('');
    }
    return { members: g, best: g[best], scores: sc.map((s) => s.score), reason, partial };
  });
}

/**
 * Qualité d'une prise (0-100) à partir des défauts qu'elle contient et de descripteurs acoustiques.
 * @param {Word[]} words @param {{ a: number, b: number }} s @param {Issue[]} issues
 * @param {{ rms?: (t0: number, t1: number) => number, pitchRange?: (t0: number, t1: number) => number, clicks?: (t0: number, t1: number) => number }} [ac]
 */
export function takeScore(words, s, issues, ac = {}) {
  const t0 = words[s.a].t0, t1 = words[s.b].t1;
  const inside = issues.filter((x) => x.t0 >= t0 - 0.01 && x.t1 <= t1 + 0.01);
  const notes = [];
  let score = 100;
  const pen = (n, p, label) => { if (n > 0) { score -= n * p; notes.push(`${n} ${label}`); } };
  pen(inside.filter((x) => x.type === 'bégaiement').length, 18, 'bégaiement(s)');
  pen(inside.filter((x) => x.type === 'répétition').length, 15, 'répétition(s)');
  pen(inside.filter((x) => x.type === 'hésitation').length, 10, 'hésitation(s)');
  pen(inside.filter((x) => x.type === 'fragment').length, 14, 'fragment(s) non transcrit(s)');
  pen(inside.filter((x) => x.type === 'douteux').length, 5, 'mot(s) douteux');
  // Débit régulier : écart-type des pauses entre mots.
  const gaps = [];
  for (let i = s.a + 1; i <= s.b; i++) gaps.push(Math.max(0, words[i].t0 - words[i - 1].t1));
  const long = gaps.filter((g) => g > 0.35).length;
  pen(long, 4, 'pause(s) hésitante(s)');
  if (ac.pitchRange) {   // intonation : étendue de hauteur en demi-tons (voix plate = moins énergique)
    const st = ac.pitchRange(t0, t1);
    if (st < 3) { score -= 6; notes.push('intonation plate'); }
  }
  if (ac.clicks) pen(ac.clicks(t0, t1), 3, 'bruit(s) de bouche');
  if (!END.test(words[s.b].w.trim()) && s.b - s.a < 3) { score -= 10; notes.push('phrase inachevée'); }
  return { score: Math.max(0, score), notes };
}

/**
 * Passages gardés (temps source) après nettoyage : mots gardés regroupés, marges, blancs réduits.
 * @param {Word[]} words @param {Set<number>} cut indices des mots coupés @param {{ a: number, b: number }[]} sents
 * @param {typeof DEFAULTS} [o]
 * @returns {{ t0: number, t1: number, words: number[] }[]}
 */
export function keptSegments(words, cut, sents, o = DEFAULTS) {
  const sentOf = new Int32Array(words.length);
  sents.forEach((s, k) => { for (let i = s.a; i <= s.b; i++) sentOf[i] = k; });
  const segs = [];
  let cur = null;
  for (let i = 0; i < words.length; i++) {
    if (cut.has(i)) { if (cur) { segs.push(cur); cur = null; } continue; }
    const w = words[i];
    if (cur) {
      const gap = w.t0 - words[cur.words[cur.words.length - 1]].t1;
      const newSentence = sentOf[i] !== sentOf[cur.words[cur.words.length - 1]];
      if (gap <= (newSentence ? o.sentencePause : o.maxPause)) { cur.t1 = w.t1 + o.margin; cur.words.push(i); continue; }
      segs.push(cur);
    }
    cur = { t0: w.t0 - o.margin, t1: w.t1 + o.margin, words: [i] };
  }
  if (cur) segs.push(cur);
  // Les marges ne doivent jamais empiéter sur un mot coupé voisin ni se chevaucher.
  for (let k = 0; k < segs.length; k++) {
    const first = segs[k].words[0], last = segs[k].words[segs[k].words.length - 1];
    if (first > 0) segs[k].t0 = Math.max(segs[k].t0, (words[first - 1].t1 + words[first].t0) / 2, words[first - 1].t1);
    if (last + 1 < words.length) segs[k].t1 = Math.min(segs[k].t1, (words[last].t1 + words[last + 1].t0) / 2);
    segs[k].t0 = Math.max(0, segs[k].t0);
  }
  return segs;
}
