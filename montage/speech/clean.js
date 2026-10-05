// Nettoyage de la voix : détection des défauts et proposition de coupes (l'automatique PROPOSE, l'utilisateur VALIDE).
// Entrées : mots horodatés (temps de la SOURCE, en secondes) + descripteurs acoustiques. Sorties : phrases, prises
// regroupées avec la meilleure choisie et expliquée, défauts (avec raison), liste des passages gardés.
// Règles du brief (section 2.2) : prises multiples → une seule gardée (la meilleure, la DERNIÈRE en cas d'égalité),
// jamais de phrase recomposée à partir de plusieurs prises, coupes jamais au milieu d'un mot, marge 0,08 s,
// blancs > 0,25 s supprimés, micro-pause ≈ 0,1 s entre phrases. Fonctions pures, testées (tests/unit/clean.test.mjs).

import { normalizeWords, alignWords } from './text.js';
import { sameWord } from '../subs/groups.js';

/** @typedef {{ w: string, t0: number, t1: number, conf?: number }} Word */
/** @typedef {{ type: string, t0: number, t1: number, words: number[], action: 'cut'|'listen', reason: string }} Issue */

const TIE = 10;   // écart de score sous lequel deux prises sont jugées équivalentes (points sur 100)

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
    // Majuscule après une pause (le modèle met des majuscules en début de phrase mais oublie parfois le point).
    const capital = !last && gap >= 0.3 && /^[A-ZÀ-ÖØ-Þ]/.test(words[i + 1].w.trim()) && !/^[A-ZÀ-ÖØ-Þ]{2,}/.test(words[i + 1].w.trim());
    if (last || END.test(words[i].w.trim()) || gap >= o.sentenceGap || capital) { out.push({ a, b: i }); a = i + 1; }
  }
  return out;
}

/** Même mot à l'élision près (« afrique » / « l afrique ») ou à une lettre près sur un mot long (« veuillez » / « veillez »). */
function looseEq(a, b) {
  if (a === b || sameWord(a, b)) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 4 && l.endsWith(' ' + s);
}

/**
 * Reprises (« reparandum / repair ») : un début de phrase redit peu après, en général après une pause ou un mot
 * coupé (« La prononci… La prononciation est… », prise abandonnée puis reprise). Tout ce qui précède la reprise
 * depuis la première occurrence est proposé à la coupe ; on garde la DERNIÈRE version.
 * @param {Word[]} words @returns {Issue[]}
 */
export function restarts(words) {
  const k = words.map((w) => key(w.w));
  const issues = [];
  let covered = -1;
  for (let j = 1; j < words.length; j++) {
    const pause = words[j].t0 - words[j - 1].t1;
    let best = null;
    for (let i = Math.max(0, j - 40); i < j; i++) {
      if (i <= covered || words[j].t0 - words[i].t0 > 25) continue;
      // Longueur de la correspondance (le dernier mot de la 1re occurrence peut être coupé : préfixe).
      let n = 0, prefixEnd = false;
      while (i + n < j && j + n < words.length) {
        if (k[i + n] && looseEq(k[i + n], k[j + n])) { n++; continue; }
        if (k[i + n] && k[i + n].length >= 2 && k[j + n].startsWith(k[i + n]) && i + n + 1 === j) { n++; prefixEnd = true; }
        break;
      }
      if (!n) continue;
      const reachesRestart = i + n === j;           // la 1re occurrence s'arrête juste avant la reprise
      const strong = n >= 3 || (n >= 2 && (pause >= 0.25 || prefixEnd)) || (prefixEnd && k[j].length >= 5);
      if (!strong || (!reachesRestart && pause < 0.25)) continue;
      // Bloc répété banal (« de la », « il y a ») sans pause : ignoré.
      if (n <= 2 && pause < 0.25 && !prefixEnd) continue;
      if (!best || n > best.n || (n === best.n && i < best.i)) best = { i, n, prefixEnd };
    }
    if (!best) continue;
    const idx = range(best.i, j - 1);
    issues.push({ type: 'reprise', t0: words[best.i].t0, t1: words[j - 1].t1, words: idx, action: 'cut',
      reason: `« ${words.slice(best.i, Math.min(j, best.i + 6)).map((w) => w.w.trim()).join(' ')}${j - best.i > 6 ? '…' : ''} » recommencé ensuite` });
    covered = j - 1;
  }
  return issues;
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
    if (i + 1 < words.length && w && k[i + 1].startsWith(w) && w.length < k[i + 1].length && w.length <= 4 && (w.length >= 2 || /-$/.test(words[i].w.trim()))
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
  // Reprises (faux départs, prises recommencées dans la même « phrase »).
  const taken2 = new Set(issues.flatMap((x) => x.words));
  for (const r of restarts(words)) if (!r.words.every((i) => taken2.has(i))) issues.push(r);
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
 * Défauts que le TEXTE ne montre pas (le modèle « gomme » souvent bégaiements et « euh ») : on cherche de la parole
 * entre les mots transcrits. Un fragment juste avant un mot est un bégaiement / faux départ probable ; une voyelle
 * tenue, stable et voisée est un « euh ».
 * @param {Word[]} words
 * @param {{ db: Float32Array, f0: Float32Array, clarity: Float32Array, probs: Float32Array, probRate: number }} ac
 *   db/f0/clarity par trame de 10 ms ; probs = VAD (une valeur toutes les 1/probRate s)
 * @returns {Issue[]}
 */
export function acousticIssues(words, ac) {
  const HOPS = 0.01;
  const issues = [];
  const speechDb = words.length ? median(words.flatMap((w) => sliceFrames(ac.db, w.t0, w.t1))) : -30;
  const prob = (t) => ac.probs[Math.min(ac.probs.length - 1, Math.max(0, Math.floor(t * ac.probRate)))] || 0;
  const gaps = [];
  if (words.length) gaps.push([Math.max(0, words[0].t0 - 2), words[0].t0, 0]);
  for (let i = 0; i + 1 < words.length; i++) gaps.push([words[i].t1, words[i + 1].t0, i + 1]);
  for (const [g0, g1, nextIdx] of gaps) {
    const a = g0 + 0.03, b = g1 - 0.03;
    if (b - a < 0.08) continue;
    // Régions continues de « parole » dans le trou : VAD ≥ 0,5 et énergie proche de celle de la voix.
    let start = -1;
    const regions = [];
    for (let t = a; t <= b + 1e-9; t += HOPS) {
      const i = Math.round(t / HOPS - 1);
      const on = prob(t) >= 0.5 && ac.db[i] >= speechDb - 20;
      if (on && start < 0) start = t;
      if ((!on || t + HOPS > b) && start >= 0) { const e = on ? t + HOPS : t; if (e - start >= 0.08) regions.push([start, e]); start = -1; }
    }
    for (const [r0, r1] of regions) {
      const fr = sliceIdx(r0, r1);
      const voiced = fr.filter((i) => ac.clarity[i] > 0.7 && ac.f0[i] > 0);
      const stable = voiced.length >= 0.7 * fr.length && semitoneStd(voiced.map((i) => ac.f0[i])) < 1;
      if (stable && r1 - r0 >= 0.25) {
        issues.push({ type: 'hésitation', t0: r0, t1: r1, words: [], action: 'cut', reason: `« euh » probable (voyelle tenue ${(r1 - r0).toFixed(2).replace('.', ',')} s, non transcrite)` });
      } else {
        const beforeWord = nextIdx < words.length && words[nextIdx].t0 - r1 < 0.5;
        issues.push({ type: beforeWord ? 'bégaiement' : 'fragment', t0: r0, t1: r1, words: [], action: beforeWord && r1 - r0 < 0.35 ? 'cut' : 'listen',
          reason: beforeWord ? `son non transcrit juste avant « ${words[nextIdx].w.trim()} » (faux départ ou bégaiement probable)` : 'parole non transcrite : à écouter' });
      }
    }
  }
  // Mot anormalement long pour sa taille (voyelle allongée « leeee… »).
  words.forEach((w, i) => {
    const letters = w.w.replace(/[^\p{L}]/gu, '').length;
    if (letters && letters <= 4 && w.t1 - w.t0 > 0.6) issues.push({ type: 'hésitation', t0: w.t0, t1: w.t1, words: [i], action: 'listen', reason: `« ${w.w.trim()} » allongé (${(w.t1 - w.t0).toFixed(2).replace('.', ',')} s)` });
  });
  return issues;

  function sliceIdx(t0, t1) { const out = []; for (let i = Math.max(0, Math.round(t0 / HOPS - 1)); i <= Math.min(ac.db.length - 1, Math.round(t1 / HOPS - 1)); i++) out.push(i); return out; }
  function sliceFrames(arr, t0, t1) { return sliceIdx(t0, t1).map((i) => arr[i]); }
}

function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
function semitoneStd(f) {
  if (f.length < 2) return 99;
  const st = f.map((x) => 12 * Math.log2(x / 100));
  const m = st.reduce((p, q) => p + q, 0) / st.length;
  return Math.sqrt(st.reduce((p, q) => p + (q - m) ** 2, 0) / st.length);
}

/** Étendue de hauteur (demi-tons, centiles 10-90) entre t0 et t1 : une intonation plate sonne moins énergique. */
export function pitchRangeSemitones(f0, clarity, t0, t1) {
  const v = [];
  for (let i = Math.max(0, Math.round(t0 / 0.01 - 1)); i <= Math.min(f0.length - 1, Math.round(t1 / 0.01 - 1)); i++) if (f0[i] > 0 && clarity[i] > 0.6) v.push(12 * Math.log2(f0[i] / 100));
  if (v.length < 10) return 0;
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length * 0.9)] - v[Math.floor(v.length * 0.1)];
}

/**
 * Regroupe les prises d'une même phrase et choisit la meilleure.
 * @param {Word[]} words @param {{ a: number, b: number }[]} sents
 * @param {(s: { a: number, b: number }) => { score: number, notes: string[] }} scoreTake qualité (0-100) d'une prise
 * @param {typeof DEFAULTS} [o]
 * @param {Set<number>} [abandoned] phrases déjà reconnues comme abandonnées (reprises) : jamais retenues
 * @returns {{ members: number[], best: number, scores: number[], reason: string, partial: boolean[] }[]}
 */
export function groupTakes(words, sents, scoreTake, o = DEFAULTS, abandoned = new Set()) {
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
    const partial = g.map((i, k) => g.length > 1 && (lens[k] < maxLen * 0.75 || abandoned.has(i)));
    const sc = g.map((i) => scoreTake(sents[i]));
    let best = -1;
    g.forEach((_, k) => {
      if (partial[k]) return;
      if (best < 0 || sc[k].score >= sc[best].score - TIE) best = k;   // quasi-égalité → la DERNIÈRE (on refait une prise après un raté)
    });
    if (best < 0) best = g.length - 1;
    let reason = 'prise unique';
    if (g.length > 1) {
      const others = g.map((_, k) => k).filter((k) => k !== best);
      const tie = others.every((k) => partial[k] || sc[k].score < sc[best].score - TIE) ? '' : ' (égalité : la dernière)';
      reason = `prise ${best + 1}/${g.length} gardée${tie} : ${sc[best].notes.join(', ') || 'propre'}`
        + others.map((k) => ` ; prise ${k + 1} : ${abandoned.has(g[k]) ? 'recommencée' : partial[k] ? 'faux départ' : sc[k].notes.join(', ') || 'moins bonne'} (${Math.round(sc[k].score)})`).join('');
    }
    return { members: g, best: g[best], scores: sc.map((s) => s.score), reason, partial };
  });
}

/**
 * Phrases abandonnées : plus de 60 % de leurs mots sont dans une reprise (« recommencé ensuite »).
 * @param {{ a: number, b: number }[]} sents @param {Issue[]} issues
 */
export function abandonedSentences(sents, issues) {
  const inRestart = new Set(issues.filter((x) => x.type === 'reprise').flatMap((x) => x.words));
  const out = new Set();
  sents.forEach((s, k) => { let n = 0; for (let i = s.a; i <= s.b; i++) if (inRestart.has(i)) n++; if (n > 0.6 * (s.b - s.a + 1)) out.add(k); });
  return out;
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
  // Défauts que la coupe retire proprement (répétition, « euh » isolé) : faible pénalité ; défauts qui restent
  // audibles (bégaiement collé, parole confuse, mots douteux) : forte pénalité.
  const removable = (x) => x.action === 'cut' && (x.type === 'répétition' || x.type === 'hésitation' || x.type === 'reprise');
  pen(inside.filter((x) => x.type === 'bégaiement').length, 12, 'bégaiement(s)');
  pen(inside.filter(removable).length, 3, 'défaut(s) retiré(s) à la coupe');
  pen(inside.filter((x) => x.type === 'hésitation' && x.action === 'listen').length, 6, 'hésitation(s) à écouter');
  pen(inside.filter((x) => x.type === 'fragment').length, 10, 'passage(s) non transcrit(s)');
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
 * @param {{ t0: number, t1: number }[]} [cutRanges] intervalles à exclure hors mots (fragments, « euh » non transcrits)
 * @returns {{ t0: number, t1: number, words: number[] }[]}
 */
export function keptSegments(words, cut, sents, o = DEFAULTS, cutRanges = []) {
  const sentOf = new Int32Array(words.length);
  sents.forEach((s, k) => { for (let i = s.a; i <= s.b; i++) sentOf[i] = k; });
  const segs = [];
  let cur = null;
  for (let i = 0; i < words.length; i++) {
    if (cut.has(i)) { if (cur) { segs.push(cur); cur = null; } continue; }
    const w = words[i];
    if (cur) {
      const gap = w.t0 - words[cur.words[cur.words.length - 1]].t1;
      const prevEnd = words[cur.words[cur.words.length - 1]].t1;
      const newSentence = sentOf[i] !== sentOf[cur.words[cur.words.length - 1]];
      const blocked = cutRanges.some((r) => r.t1 > prevEnd && r.t0 < w.t0);
      if (!blocked && gap <= (newSentence ? o.sentencePause : o.maxPause)) { cur.t1 = w.t1 + o.margin; cur.words.push(i); continue; }
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
    for (const r of cutRanges) {
      if (r.t1 <= words[first].t0 + 1e-9 && r.t1 > segs[k].t0) segs[k].t0 = r.t1;
      if (r.t0 >= words[last].t1 - 1e-9 && r.t0 < segs[k].t1) segs[k].t1 = r.t0;
    }
    segs[k].t0 = Math.max(0, segs[k].t0);
  }
  return segs;
}
