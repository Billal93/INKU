// Voix dans le projet : combinaison PURE de l'analyse (lourde, en cache local, non versionnée dans l'historique)
// et des décisions de l'utilisateur (légères, dans l'EDL : mots coupés/gardés, prise choisie, corrections de texte).
// Produit : mots finaux, passages gardés, morceaux de la piste A1 (images entières), sous-titres T1, rapport.
// Testé dans tests/unit/voice-model.test.mjs.
import { keptSegments, DEFAULTS } from '../speech/clean.js';
import { buildPieces, mapWords } from '../speech/edits.js';
import { tagWords, groupWords } from '../subs/groups.js';
import { makeClip } from './edl.js';

/** @typedef {{ cut?: Record<number, boolean>, ranges?: Record<number, boolean>, best?: Record<number, number>, text?: Record<number, string> }} VoiceEdits
 *   cut[i] : choix explicite pour le mot i (true = coupé) ; ranges[k] : fragment k coupé ou non ; best[g] : prise choisie
 *   (indice de phrase) pour le groupe g ; text[i] : mot corrigé */

/**
 * État courant de la voix.
 * @param {any} an analyse (speech/voice-pipeline.js) @param {VoiceEdits} [ed]
 */
export function voiceState(an, ed = {}) {
  const settings = { ...DEFAULTS, ...(an.settings || {}) };
  const words = an.words.map((w, i) => (ed.text && ed.text[i] !== undefined ? { ...w, w: ed.text[i], edited: true } : w));
  const cut = new Set();
  const takes = an.takes.map((g, gi) => ({ ...g, best: ed.best && ed.best[gi] !== undefined && g.members.includes(ed.best[gi]) ? ed.best[gi] : g.best, chosenByUser: !!(ed.best && ed.best[gi] !== undefined) }));
  // Phrases explicitement choisies par l'utilisateur : une « reprise » détectée ne les coupe plus.
  const chosen = new Set();
  for (const g of takes) if (g.chosenByUser) { const s = an.sentences[g.best]; for (let i = s.a; i <= s.b; i++) chosen.add(i); }
  // 1) défauts « à couper » proposés
  for (const x of an.issues) if (x.action === 'cut') x.words.forEach((i) => { if (!(x.type === 'reprise' && chosen.has(i))) cut.add(i); });
  // 2) prises : tout sauf la prise retenue (choix de l'utilisateur prioritaire)
  for (const g of takes) for (const m of g.members) if (m !== g.best) { const s = an.sentences[m]; for (let i = s.a; i <= s.b; i++) cut.add(i); }
  // 3) choix explicites mot par mot
  for (const [k, v] of Object.entries(ed.cut || {})) { const i = Number(k); if (v) cut.add(i); else cut.delete(i); }
  const ranges = an.issues.filter((x) => !x.words.length && (x.type === 'hésitation' || x.type === 'bégaiement' || x.type === 'fragment'))
    .map((x, k) => ({ ...x, k, cut: ed.ranges && ed.ranges[k] !== undefined ? ed.ranges[k] : x.action === 'cut' }));
  const kept = keptSegments(words, cut, an.sentences, settings, ranges.filter((r) => r.cut), ranges.filter((r) => !r.cut));
  const keptSec = kept.reduce((a, s) => a + s.t1 - s.t0, 0);
  return { words, cut, takes, ranges, kept, keptSec, settings, sentences: an.sentences };
}

/**
 * Morceaux de voix sur A1 (images entières, coupes sur minimum d'énergie / passage par zéro, micro-fondus).
 * @param {ReturnType<typeof voiceState>} st @param {{ fps: number, startFrame?: number, snap?: (t: number, lo: number, hi: number) => number, fadeMs?: number }} o
 */
export function voicePieces(st, o) {
  const W = st.words;
  const segs = st.kept.map((s) => {
    const first = s.words[0], last = s.words[s.words.length - 1];
    const prevEnd = first > 0 ? W[first - 1].t1 : 0;
    const nextStart = last + 1 < W.length ? W[last + 1].t0 : Infinity;
    const rangeAfter = st.ranges.filter((r) => r.cut && r.t0 >= W[last].t1).map((r) => r.t0);
    const rangeBefore = st.ranges.filter((r) => r.cut && r.t1 <= W[first].t0).map((r) => r.t1);
    return {
      t0: s.t0, t1: s.t1,
      minIn: Math.max(prevEnd + 0.005, ...rangeBefore, s.t0 - 0.03), maxIn: W[first].t0 - 0.02,
      minOut: W[last].t1 + 0.02, maxOut: Math.min(nextStart - 0.005, ...rangeAfter, s.t1 + 0.03),
    };
  });
  return buildPieces(segs, { fps: o.fps, startFrame: o.startFrame ?? 0, fadeMs: o.fadeMs ?? 8, snap: o.snap });
}

/**
 * Harmonisation du niveau entre morceaux collés (prises enregistrées plus ou moins fort) : niveau de PAROLE de chaque
 * morceau (médiane des trames de 10 ms au-dessus du bruit de fond), cible = médiane pondérée par la durée,
 * correction bornée à ±6 dB et ignorée sous 1,5 dB d'écart (pas de pompage : un gain constant par morceau, les
 * micro-fondus assurent la transition). @param {import('../speech/edits.js').Piece[]} pieces
 * @param {Float32Array | number[]} envelope énergie dBFS par trame de 10 ms (analyse) @returns {number[]} gains en dB
 */
export function levelMatch(pieces, envelope) {
  if (!envelope || !envelope.length) return pieces.map(() => 0);
  const lv = pieces.map((p) => {
    const a = Math.max(0, Math.round(p.srcIn / 0.01) - 1), b = Math.min(envelope.length, Math.round(p.srcOut / 0.01));
    const v = Array.from(envelope.slice(a, b)).filter((x) => x > -50).sort((x, y) => x - y);
    return v.length >= 10 ? v[Math.floor(v.length * 0.5)] : null;
  });
  const valid = pieces.map((p, i) => ({ l: lv[i], w: p.frames })).filter((x) => x.l !== null).sort((x, y) => x.l - y.l);
  if (!valid.length) return pieces.map(() => 0);
  let half = valid.reduce((s, x) => s + x.w, 0) / 2, target = valid[0].l;
  for (const x of valid) { half -= x.w; target = x.l; if (half <= 0) break; }
  return lv.map((l) => {
    if (l === null) return 0;
    const d = target - l;
    return Math.abs(d) < 1.5 ? 0 : Math.round(Math.max(-6, Math.min(6, d)) * 10) / 10;
  });
}

/**
 * Clips A1 de la voix à partir des morceaux. @param {import('../speech/edits.js').Piece[]} pieces @param {string} srcId
 * @param {number[]} [gains] correction de niveau par morceau (dB)
 */
export function voiceClips(pieces, srcId, gains = []) {
  return pieces.map((p, i) => {
    const c = makeClip({ track: 'A1', start: p.tl, dur: p.frames, srcId, srcIn: p.srcIn, gainDb: gains[i] || 0, fadeIn: p.fadeIn, fadeOut: p.fadeOut, voice: true });
    delete c.crop;
    return c;
  });
}

const STRIP = /[,.;:…]+$/;   // ponctuation retirée à l'affichage (style TikTok) ; « ! » et « ? » gardés

/**
 * Sous-titres : mots gardés recalés exactement sur la timeline, marqués (importants / impact), groupés.
 * @param {ReturnType<typeof voiceState>} st @param {import('../speech/edits.js').Piece[]} pieces
 * @param {{ fps: number, glossary?: { text: string, kind: 'important'|'impact', variants?: string[] }[], punctuation?: 'retirée'|'gardée', hold?: number, maxWords?: number }} o
 */
export function subtitleClips(st, pieces, o) {
  const fps = o.fps;
  const kept = st.words.map((w, i) => ({ ...w, i })).filter((w) => !st.cut.has(w.i));
  const { words: mapped, broken } = mapWords(kept, pieces, fps);
  const tagged = tagWords(mapped.map((w) => ({ ...w, w: o.punctuation === 'gardée' ? w.w : w.w.replace(STRIP, '') })).filter((w) => w.w), o.glossary || []);
  // Groupes par phrase (jamais à cheval sur deux phrases).
  const clips = [];
  let a = 0;
  while (a < tagged.length) {
    let b = a;
    const sid = sentenceIndex(st, mapped[a].src);
    while (b + 1 < tagged.length && sentenceIndex(st, mapped[b + 1].src) === sid) b++;
    const sent = tagged.slice(a, b + 1);
    for (const g of groupWords(sent, { maxWords: o.maxWords ?? 3 })) {
      const ws = g.map((k) => sent[k]);
      clips.push({ ws, start: Math.round(ws[0].t0 * fps) });
    }
    a = b + 1;
  }
  const hold = Math.round((o.hold ?? 0.5) * fps);
  return {
    broken,
    clips: clips.map((c, k) => {
      const lastEnd = Math.round(c.ws[c.ws.length - 1].t1 * fps) + hold;
      const next = k + 1 < clips.length ? clips[k + 1].start : Infinity;
      const end = Math.max(c.start + 1, Math.min(next, lastEnd));
      const clip = makeClip({ track: 'T1', start: c.start, dur: end - c.start, sub: { index: k, words: c.ws.map((w) => ({ w: w.w, kind: w.kind || 'normal', expr: w.expr })) } });
      delete clip.crop;
      return clip;
    }),
  };
}

const sentIdxCache = new WeakMap();
/** Phrase d'un mot (index source). */
function sentenceIndex(st, wordIdx) {
  let idx = sentIdxCache.get(st);
  if (!idx) {
    idx = new Int32Array(st.words.length);
    st.sentences.forEach((s, k) => { for (let i = s.a; i <= s.b; i++) idx[i] = k; });
    sentIdxCache.set(st, idx);
  }
  return idx[wordIdx];
}

/**
 * Rapport de nettoyage lisible (équivalent d'un « cuts.md ») : par phrase, prises trouvées, prise choisie et
 * pourquoi, ce qui est coupé, durée supprimée, passages à écouter.
 * @param {any} an @param {ReturnType<typeof voiceState>} st
 */
export function cleaningReport(an, st) {
  const fmt = (t) => t.toFixed(2).replace('.', ',') + ' s';
  const lines = [`# Rapport de nettoyage`, '', `Voix brute : ${fmt(an.duration)} → voix nettoyée : ${fmt(st.keptSec)} (−${fmt(Math.max(0, an.duration - st.keptSec))}).`,
    `Niveau brut : ${an.level.lufs.toFixed(1).replace('.', ',')} LUFS, crête ${an.level.truePeakDb.toFixed(1).replace('.', ',')} dBTP.`, ''];
  an.takes.forEach((g0, gi) => {
    const g = st.takes[gi];
    const s = an.sentences[g.best];
    const text = st.words.slice(s.a, s.b + 1).filter((_, k) => !st.cut.has(s.a + k)).map((w) => w.w).join(' ');
    lines.push(`## Phrase ${gi + 1} : « ${text} »`);
    if (g.members.length > 1) lines.push(`- ${g.members.length} prises trouvées. ${g.chosenByUser ? 'Prise choisie par vous.' : g.reason}`);
    const issues = an.issues.filter((x) => x.t0 >= an.words[an.sentences[g.members[0]].a].t0 - 0.5 && x.t1 <= an.words[an.sentences[g.members[g.members.length - 1]].b].t1 + 0.5);
    for (const x of issues) lines.push(`- ${x.action === 'cut' ? 'Coupé' : 'À écouter'} (${fmt(x.t0)}) : ${x.type} — ${x.reason}`);
    lines.push('');
  });
  const listen = an.issues.filter((x) => x.action === 'listen');
  lines.push(`Passages à écouter : ${listen.length}. Mots retirés car hors parole (hallucinations) : ${(an.removedWords || []).length}.`);
  return lines.join('\n');
}

/**
 * Clips de sous-titres : nouvelle liste (remplace T1) et clips de voix (remplace les clips A1 de cette voix).
 * @param {any} doc @param {any[]} voice @param {any[]} subs
 */
export function replaceVoiceAndSubs(doc, srcId, voice, subs) {
  doc.clips = doc.clips.filter((c) => !(c.track === 'A1' && c.srcId === srcId) && c.track !== 'T1');
  doc.clips.push(...voice, ...subs);
}
