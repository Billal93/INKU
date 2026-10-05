// Analyse complète d'une voix brute (dans le worker « parole ») :
// 16 kHz → VAD → morceaux ≤ 28 s → transcription par mot (relance avec température si suspect) → suppression des
// hallucinations → recalage acoustique → glossaire → descripteurs → défauts, prises, proposition de coupes.
// Rien n'est appliqué ici : le Studio montre la proposition, l'utilisateur valide.
import { resample } from '../audio/resample.js';
import { energy, pitchYin, detectClicks } from '../audio/features.js';
import { measureLoudness, truePeak } from '../audio/loudness.js';
import { sileroProbs, speechSegments, planChunks, VAD_RATE, VAD_FRAME } from './vad.js';
import { mergeChunks, filterHallucinations, needsRetry, refineWordTimes, applyGlossary, uncoveredSpeech, ctcWordEnds } from './asr-post.js';
import { splitSentences, wordIssues, acousticIssues, groupTakes, takeScore, keptSegments, pitchRangeSemitones, abandonedSentences, DEFAULTS } from './clean.js';

/**
 * @param {{ pcm: Float32Array, sampleRate: number, transcriber: import('./asr.js').Transcriber,
 *   vad: { ort: any, session: any }, glossary?: { text: string, kind?: string, variants?: string[] }[],
 *   onProgress?: (p: { stage: string, done: number, total: number }) => void, settings?: Partial<typeof DEFAULTS> }} o
 */
export async function analyzeVoice(o) {
  const t00 = performance.now();
  const timing = {};
  const step = async (name, fn) => { const t = performance.now(); const r = await fn(); timing[name] = Math.round(performance.now() - t); return r; };
  const prog = o.onProgress || (() => { });
  const settings = { ...DEFAULTS, ...(o.settings || {}) };

  prog({ stage: 'Préparation de l’audio', done: 0, total: 1 });
  const a16 = await step('resample', () => resample(o.pcm, o.sampleRate, 16000));
  const duration = a16.length / 16000;
  const level = await step('niveau', () => {
    const L = measureLoudness([o.pcm], o.sampleRate, { dualMono: true });
    const tp = truePeak(o.pcm, o.sampleRate);
    return { lufs: +L.integrated.toFixed(2), lra: +L.lra.toFixed(1), truePeakDb: +tp.dBTP.toFixed(2), samplePeakDb: +(20 * Math.log10(tp.samplePeak || 1e-9)).toFixed(2) };
  });

  prog({ stage: 'Détection de la parole', done: 0, total: 1 });
  const probs = await step('vad', () => sileroProbs(o.vad.ort, o.vad.session, a16));
  const speech = speechSegments(probs);
  const chunks = planChunks(speech);

  const results = [];
  const retries = [];
  await step('transcription', async () => {
    for (let i = 0; i < chunks.length; i++) {
      prog({ stage: 'Transcription', done: i, total: chunks.length });
      const c = chunks[i];
      const piece = a16.subarray(Math.floor(c.start * 16000), Math.min(a16.length, Math.ceil(c.end * 16000)));
      const speechSec = c.segs.reduce((s, k) => s + speech[k].end - speech[k].start, 0);
      let r = await o.transcriber.transcribe(piece, { words: true });
      // Repli en température (comme Whisper « long-form ») si le texte est suspect.
      for (const temp of [0.2, 0.4]) {
        const why = needsRetry(r.text, speechSec);
        if (!why) break;
        const r2 = await o.transcriber.transcribe(piece, { words: true, temperature: temp });
        retries.push({ chunk: i, why, temperature: temp, before: r.text.slice(0, 80), after: r2.text.slice(0, 80) });
        if (!needsRetry(r2.text, speechSec)) { r = r2; break; }
      }
      results.push({ start: c.start, words: r.words || [], text: r.text });
    }
    prog({ stage: 'Transcription', done: chunks.length, total: chunks.length });
  });

  // Parole entendue mais non transcrite (phrase « sautée ») : retranscription de la zone seule.
  const recovered = [];
  await step('rattrapage', async () => {
    const holes = uncoveredSpeech(mergeChunks(results), speech);
    for (const [h0, h1] of holes) {
      prog({ stage: 'Vérification des passages sautés', done: recovered.length, total: holes.length });
      const a = Math.max(0, h0 - 0.15), b = Math.min(duration, h1 + 0.15);
      const r = await o.transcriber.transcribe(a16.subarray(Math.floor(a * 16000), Math.ceil(b * 16000)), { words: true });
      const ws = (r.words || []).filter((w) => a + (w.t0 + w.t1) / 2 >= h0 - 0.1 && a + (w.t0 + w.t1) / 2 <= h1 + 0.1);
      if (ws.length) { results.push({ start: a, words: ws, text: r.text }); recovered.push({ t0: h0, t1: h1, words: ws.length }); }
    }
    results.sort((x, y) => x.start - y.start);
  });

  prog({ stage: 'Analyse des mots et des défauts', done: 0, total: 1 });
  const merged = mergeChunks(results).sort((x, y) => x.t0 - y.t0);
  const { words: kept, removed } = filterHallucinations(merged, speech);
  const feats = await step('descripteurs', () => {
    const e = energy(a16, 16000);
    const p = pitchYin(a16, 16000);
    // Bruits de bouche = clics dans les SILENCES (dans un mot, une consonne explosive ressemble à un clic).
    const sorted = Array.from(e.db).filter((x) => x > -60).sort((x, y) => x - y);
    const speechDb = sorted.length ? sorted[Math.floor(sorted.length * 0.7)] : -30;
    const clicks = detectClicks(a16, 16000).filter((t) => (e.db[Math.max(0, Math.round(t / 0.01) - 1)] ?? 0) < speechDb - 15);
    return { db: e.db, zcr: e.zcr, f0: p.f0, clarity: p.clarity, clicks };
  });
  // Modèle CTC : fins de mots calculées sur l'énergie ; puis recalage fin de toutes les bornes.
  const ends = kept.length && kept[0].ctc ? ctcWordEnds(kept, feats.db) : kept;
  const refined = refineWordTimes(ends, feats.db);
  const words = applyGlossary(refined, o.glossary || []);

  const sentences = splitSentences(words, settings);
  const issues = [
    ...wordIssues(words, settings),
    ...acousticIssues(words, { db: feats.db, f0: feats.f0, clarity: feats.clarity, probs, probRate: VAD_RATE / VAD_FRAME }),
  ].sort((a, b) => a.t0 - b.t0);
  const ac = {
    pitchRange: (t0, t1) => pitchRangeSemitones(feats.f0, feats.clarity, t0, t1),
    clicks: (t0, t1) => feats.clicks.filter((t) => t >= t0 && t <= t1).length,
  };
  const takes = groupTakes(words, sentences, (s) => takeScore(words, s, issues, ac), settings, abandonedSentences(sentences, issues));
  const proposal = proposeCuts(words, sentences, issues, takes, settings);

  timing.total = Math.round(performance.now() - t00);
  return {
    duration, level, speech, chunks: chunks.map((c) => ({ start: c.start, end: c.end })), retries, recovered,
    words, removedWords: removed.map((r) => ({ ...r.w, reason: r.reason })),
    sentences, issues, takes, proposal, timing,
    clicks: feats.clicks,
    // Enveloppe d'énergie (10 ms) pour l'affichage de la forme d'onde et les coupes.
    envelope: feats.db,
  };
}

/**
 * Proposition de coupes : mots des défauts « à couper » + prises non retenues (en entier). Les fragments acoustiques
 * (hors mots) sont des intervalles à exclure.
 * @returns {{ cutWords: number[], cutRanges: { t0: number, t1: number, reason: string }[], kept: ReturnType<typeof keptSegments> }}
 */
export function proposeCuts(words, sentences, issues, takes, settings = DEFAULTS) {
  const cut = new Set();
  for (const x of issues) if (x.action === 'cut') x.words.forEach((i) => cut.add(i));
  for (const g of takes) for (const m of g.members) if (m !== g.best) { const s = sentences[m]; for (let i = s.a; i <= s.b; i++) cut.add(i); }
  const cutRanges = issues.filter((x) => x.action === 'cut' && !x.words.length).map((x) => ({ t0: x.t0, t1: x.t1, reason: x.reason }));
  return { cutWords: [...cut].sort((a, b) => a - b), cutRanges, kept: keptSegments(words, cut, sentences, settings, cutRanges) };
}
