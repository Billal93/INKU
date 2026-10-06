// Post-traitement de la transcription (fonctions pures, tests/unit/asr-post.test.mjs) :
// - assemblage des morceaux (temps absolus) ;
// - suppression des « hallucinations » de Whisper : mots hors parole (VAD), boucles de répétition, phrases
//   parasites typiques des sous-titres d'entraînement ; décision de relancer un morceau avec température ;
// - recalage acoustique des bornes de mots (attaque / fin d'énergie) ;
// - correction par glossaire du projet (noms propres, titres : variantes, accents, chiffres/lettres).
import { normalizeWords } from './text.js';
import { sameWord } from '../subs/groups.js';
import { HOP } from '../audio/features.js';

/** @typedef {{ w: string, t0: number, t1: number, conf?: number, flags?: string[], ctc?: boolean }} Word */

/**
 * @param {{ start: number, words: { w: string, t0: number, t1: number }[] }[]} chunks résultats par morceau
 * @returns {Word[]}
 */
export function mergeChunks(chunks) {
  const out = [];
  for (const c of chunks) {
    for (const w of c.words) {
      const t0 = c.start + w.t0, t1 = c.start + Math.max(w.t0, w.t1);
      if (out.length && t0 < out[out.length - 1].t1 - 0.05 && normalizeWords(w.w).join() === normalizeWords(out[out.length - 1].w).join()) continue; // doublon au raccord
      out.push({ ...w, w: w.w.trim(), t0, t1 });
    }
  }
  return out.filter((w) => w.w.length);
}

// Phrases inventées par Whisper sur du silence ou de la musique (issues des sous-titres de son entraînement).
const PARASITES = [
  /sous[- ]titr(es|age)/i, /amara\.org/i, /radio[- ]canada/i, /merci d.avoir regard/i, /^\(?musique\)?$/i,
  /^\[.*\]$/, /^\(.*\)$/, /^♪/, /abonnez[- ]vous à (la|notre) cha[iî]ne/i,
];

/**
 * Supprime ce qui n'a pas été dit. Un mot dont le milieu tombe hors de toute zone de parole (± tolérance) est retiré ;
 * une phrase parasite connue n'est retirée QUE si elle est hors parole (« abonne-toi » dit pour de vrai est gardé).
 * @param {Word[]} words @param {{ start: number, end: number }[]} speech segments de parole (VAD)
 * @param {{ tolerance?: number }} [opt]
 * @returns {{ words: Word[], removed: { w: Word, reason: string }[] }}
 */
export function filterHallucinations(words, speech, opt = {}) {
  const tol = opt.tolerance ?? 0.25;
  const inSpeech = (t) => speech.some((s) => t >= s.start - tol && t <= s.end + tol);
  const removed = [], kept = [];
  for (const w of words) {
    const mid = (w.t0 + w.t1) / 2;
    if (!inSpeech(mid)) { removed.push({ w, reason: 'hors parole' }); continue; }
    kept.push(w);
  }
  // Phrases parasites typiques DANS la parole : on ne les retire pas (elles ont peut-être été dites), on les signale.
  for (let i = 0; i < kept.length; i++) {
    for (let n = 1; n <= 6 && i + n <= kept.length; n++) {
      const phrase = kept.slice(i, i + n).map((w) => w.w).join(' ');
      if (PARASITES.some((re) => re.test(phrase))) {
        for (let j = i; j < i + n; j++) kept[j] = { ...kept[j], flags: [...(kept[j].flags || []), 'parasite'] };
        break;
      }
    }
  }
  // Boucles : un groupe de 1 à 4 mots répété au moins 4 fois de suite (au-delà d'un bégaiement réel).
  const k = kept.map((w) => normalizeWords(w.w).join(' '));
  const drop = new Set();
  for (let n = 1; n <= 4; n++) {
    for (let i = 0; i + n * 4 <= kept.length; i++) {
      let reps = 1;
      while (i + (reps + 1) * n <= kept.length && Array.from({ length: n }, (_, j) => k[i + j] === k[i + reps * n + j]).every(Boolean)) reps++;
      if (reps >= 4) for (let j = i + n; j < i + reps * n; j++) drop.add(j);
    }
  }
  const out = kept.filter((w, i) => { if (drop.has(i)) { removed.push({ w, reason: 'boucle de répétition' }); return false; } return true; });
  return { words: out, removed };
}

/**
 * Zones de parole (VAD) que la transcription n'a pas couvertes : Whisper « saute » parfois une phrase entière sur
 * un long morceau. Ces zones sont retranscrites seules. Renvoie des intervalles [début, fin] (s) de plus de minSec.
 * @param {{ t0: number, t1: number }[]} words @param {{ start: number, end: number }[]} speech
 * @param {{ minSec?: number, maxCover?: number }} [opt]
 */
export function uncoveredSpeech(words, speech, opt = {}) {
  // Un trou de plus de 1,2 s DANS une zone de parole n'est pas une pause entre deux mots : c'est de la parole manquée.
  const minSec = opt.minSec ?? 1.2, maxCover = opt.maxCover ?? 1;
  const out = [];
  for (const s of speech) {
    const len = s.end - s.start;
    if (len < minSec) continue;
    let cov = 0;
    for (const w of words) cov += Math.max(0, Math.min(s.end, w.t1) - Math.max(s.start, w.t0));
    if (cov / len >= maxCover) continue;
    // Zone non couverte la plus longue dans le segment (entre deux mots transcrits).
    const inside = words.filter((w) => w.t1 > s.start && w.t0 < s.end).sort((a, b) => a.t0 - b.t0);
    let a = s.start, best = null;
    for (const w of [...inside, { t0: s.end, t1: s.end }]) {
      if (w.t0 - a >= minSec && (!best || w.t0 - a > best[1] - best[0])) best = [a, w.t0];
      a = Math.max(a, w.t1);
    }
    if (best) out.push(best);
  }
  return out;
}

/**
 * Faut-il relancer ce morceau (température plus élevée) ? Texte trop répétitif (taux de compression) ou trop
 * peu de mots pour la durée de parole.
 * @param {string} text @param {number} speechSec durée de parole du morceau
 */
export function needsRetry(text, speechSec) {
  const toks = normalizeWords(text);
  if (toks.length >= 12) {
    const uniq = new Set(toks).size;
    if (uniq / toks.length < 0.4) return 'texte trop répétitif';
  }
  if (speechSec > 3 && toks.length / speechSec < 0.6) return 'trop peu de mots pour la parole entendue';
  if (toks.length / Math.max(speechSec, 0.5) > 7) return 'trop de mots pour la durée';
  return null;
}

/**
 * Recalage acoustique : déplace le début d'un mot vers l'attaque d'énergie la plus proche, et sa fin vers la chute
 * d'énergie, dans une fenêtre limitée, sans croiser les mots voisins. Les modèles de transcription donnent des
 * bornes à ±50-100 ms ; l'énergie situe l'attaque à ±10 ms quand elle est nette (sinon on ne touche à rien).
 * @param {Word[]} words @param {Float32Array} db énergie (dBFS) par trame de 10 ms
 * @param {{ before?: number, after?: number, rise?: number }} [opt]
 * @returns {Word[]}
 */
export function refineWordTimes(words, db, opt = {}) {
  return refineEnds(refineOnsets(words, db, opt), db, opt);
}

/**
 * Débuts de mots sur l'attaque d'énergie, de gauche à droite.
 * - Un mot annoncé dans le SILENCE (cas fréquent d'un modèle CTC, qui « devance » souvent le son, parfois de tout
 *   un mot court) est déplacé à la prochaine attaque (front montant), jusqu'à 350 ms plus loin.
 * - Un mot annoncé dans la parole n'est ajusté que s'il existe un front montant proche (−120 / +80 ms).
 * - L'ordre est garanti : un mot commence au plus tôt après la durée minimale du précédent (selon ses lettres).
 * @param {Word[]} words @param {Float32Array} db @param {{ before?: number, after?: number, rise?: number }} [opt]
 */
export function refineOnsets(words, db, opt = {}) {
  const before = opt.before ?? 0.12, after = opt.after ?? 0.08, rise = opt.rise ?? 10;
  const at = (t) => Math.max(0, Math.min(db.length - 1, Math.round(t / HOP - 1)));
  const tt = (i) => (i + 1) * HOP;
  const out = words.map((w) => ({ ...w }));
  const minDur = (w) => 0.05 + 0.025 * Math.min(12, w.w.replace(/[^\p{L}\p{N}]/gu, '').length);
  for (let k = 0; k < out.length; k++) {
    const w = out[k], prev = k ? out[k - 1] : null;
    const lo = Math.max(0, w.t0 - before, prev ? prev.t0 + minDur(prev) : 0);
    // Bruit de fond local : minimum sur les 300 ms avant le début annoncé.
    let floor = Infinity;
    for (let i = at(w.t0 - 0.3); i <= at(w.t0); i++) floor = Math.min(floor, db[i]);
    const silentAt = (t) => { const i = at(t); return Math.max(db[i], db[Math.min(db.length - 1, i + 1)], db[Math.min(db.length - 1, i + 2)]) < floor + rise; };
    const edge = (from, to) => {
      for (let i = Math.max(at(from), 1); i <= at(to); i++) {
        if (db[i] <= floor + rise + 2) continue;
        let low = Infinity; for (let j = Math.max(0, i - 3); j < i; j++) low = Math.min(low, db[j]);
        if (low < floor + rise + 2) return tt(i) - HOP / 2;
      }
      return -1;
    };
    let t0 = w.t0;
    if (silentAt(w.t0)) { const e = edge(w.t0, w.t0 + 0.35); if (e >= 0) t0 = e; }
    else { const e = edge(Math.max(lo, w.t0 - before), w.t0 + after); if (e >= 0) t0 = e; }
    t0 = Math.max(t0, lo);
    if (t0 !== w.t0) {
      // Décalage d'un mot CTC : sa fin (dernier pic) suit d'autant.
      if (w.ctc) w.t1 = Math.max(w.t1 + (t0 - w.t0), t0 + 0.04);
      w.t0 = t0;
      if (w.t1 < w.t0 + 0.04) w.t1 = w.t0 + 0.04;
    }
  }
  // Fins jamais au-delà du début du mot suivant.
  for (let k = 0; k + 1 < out.length; k++) if (out[k].t1 > out[k + 1].t0 - 0.01) out[k].t1 = Math.max(out[k].t0 + 0.03, out[k + 1].t0 - 0.01);
  return out;
}

/** Fins de mots : dernière trame au-dessus du plancher suivant + rise, sans dépasser le mot suivant. */
export function refineEnds(words, db, opt = {}) {
  const before = opt.before ?? 0.12, after = opt.after ?? 0.08, rise = opt.rise ?? 10;
  const at = (t) => Math.max(0, Math.min(db.length - 1, Math.round(t / HOP - 1)));
  const tt = (i) => (i + 1) * HOP;
  const out = words.map((w) => ({ ...w }));
  for (let k = 0; k < out.length; k++) {
    const w = out[k];
    const nextT0 = k + 1 < out.length ? out[k + 1].t0 : w.t1 + 0.2;
    const a = at(Math.max(w.t0 + 0.03, w.t1 - after)), b = at(Math.min(nextT0, w.t1 + before));
    if (b <= a) continue;
    let floorEnd = Infinity;
    for (let i = at(w.t1); i <= b; i++) floorEnd = Math.min(floorEnd, db[i]);
    let off = -1;
    for (let i = b; i >= a; i--) if (db[i] > floorEnd + rise) { off = i; break; }
    if (off >= 0) w.t1 = Math.max(w.t0 + 0.03, Math.min(nextT0, tt(off) + HOP / 2));
  }
  return out;
}

/**
 * Fin réelle des mots d'un modèle CTC : le modèle ne donne que le « pic » de chaque jeton (début de mot fiable,
 * fin inconnue). La fin est la PREMIÈRE chute d'énergie jusqu'au bruit de fond (+8 dB, sur 30 ms) après le
 * dernier pic ; sans chute avant le mot suivant (parole liée), le mot va jusqu'au suivant. Ainsi un « euh », une
 * syllabe bégayée ou un faux départ non transcrits restent HORS des mots, donc détectables.
 * @param {(Word & { spikeEnd?: number })[]} words t1 = fin du dernier pic @param {Float32Array} db énergie (10 ms)
 */
export function ctcWordEnds(words, db) {
  const at = (t) => Math.max(0, Math.min(db.length - 1, Math.round(t / HOP - 1)));
  return words.map((w, k) => {
    const next = k + 1 < words.length ? words[k + 1].t0 : w.t1 + 1.0;
    let peak = -Infinity;
    for (let i = at(w.t0); i <= at(w.t1); i++) peak = Math.max(peak, db[i]);
    const lim = at(Math.max(w.t1, next - 0.02));
    // Seuil relatif au BRUIT DE FOND local (et non au pic) : les consonnes finales faibles (« s », « f ») restent dans le mot.
    let floor = Infinity;
    for (let i = at(w.t1); i <= Math.min(db.length - 1, lim + 30); i++) floor = Math.min(floor, db[i]);
    const thr = Math.max(peak - 30, floor + 8);
    let end = -1;
    for (let i = at(w.t1); i + 2 <= lim; i++) {
      if (db[i] < thr && db[i + 1] < thr && db[i + 2] < thr) { end = i; break; }
    }
    const t1 = end >= 0 ? (end + 1) * HOP : Math.max(w.t1, next - 0.02);
    return { ...w, t1: Math.max(w.t0 + 0.04, Math.min(t1, next - 0.01)) };
  });
}

/**
 * Corrige l'orthographe des noms du glossaire (« tsubassa » → « Tsubasa », « vingt-cinq » reste tel quel pour
 * l'audio mais l'affichage suit l'entrée du glossaire si elle est en chiffres).
 * @param {Word[]} words @param {{ text: string, variants?: string[] }[]} glossary
 */
export function applyGlossary(words, glossary) {
  const single = glossary.filter((g) => !/\s/.test(g.text.trim()));
  return words.map((w) => {
    const core = w.w.replace(/^[«"“(]+|[»"”),.;:!?…]+$/g, '');
    for (const g of single) {
      const forms = [g.text, ...(g.variants || [])];
      if (forms.some((f) => sameWord(core, f)) && core !== g.text) {
        return { ...w, w: w.w.replace(core, g.text), flags: [...(w.flags || []), 'glossaire'] };
      }
    }
    return w;
  });
}

/** Prompt initial pour Whisper : hésitations (pour qu'il les écrive) et noms du projet. @param {{ text: string }[]} glossary */
export function initialPrompt(glossary) {
  const names = glossary.map((g) => g.text).slice(0, 30).join(', ');
  return `Euh, bon, alors, euh… ${names ? names + '.' : ''}`.trim();
}
