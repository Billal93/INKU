import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceState, voicePieces, voiceClips, subtitleClips, cleaningReport, replaceVoiceAndSubs, levelMatch } from '../../montage/studio/voice-model.js';
import { splitSentences, wordIssues, groupTakes, takeScore } from '../../montage/speech/clean.js';
import { newProject } from '../../montage/studio/edl.js';

/** Analyse synthétique : deux prises de la même phrase, une hésitation, un fragment non transcrit. */
function analysis() {
  const mk = (text, t) => text.split(' ').map((w) => { const o = { w, t0: +t.toFixed(3), t1: +(t + 0.3).toFixed(3) }; t += 0.35; return o; });
  const words = [
    ...mk('Deux garçons de huit ans.', 0.5),        // prise 1 (0..4)
    ...mk('Deux garçons de huit ans.', 3.0),        // prise 2 (5..9)
    ...mk('Ils sont euh inséparables.', 6.0),       // 10..13
  ];
  const sentences = splitSentences(words);
  const issues = [...wordIssues(words), { type: 'bégaiement', t0: 5.4, t1: 5.55, words: [], action: 'cut', reason: 'son non transcrit' }];
  const takes = groupTakes(words, sentences, (s) => takeScore(words, s, issues));
  return { duration: 8, level: { lufs: -20, truePeakDb: -3 }, words, sentences, issues, takes, removedWords: [] };
}

test('état : prise non retenue coupée, hésitation coupée, choix de l\'utilisateur prioritaire', () => {
  const an = analysis();
  const st = voiceState(an);
  assert.ok([0, 1, 2, 3, 4].every((i) => st.cut.has(i)), 'prise 1 coupée (égalité : la dernière)');
  assert.ok(![5, 6, 7, 8, 9].some((i) => st.cut.has(i)));
  assert.ok(st.cut.has(12), '« euh » coupé');
  const st2 = voiceState(an, { best: { 0: 0 }, cut: { 12: false }, text: { 13: 'inséparables !' } });
  assert.ok(![0, 1, 2, 3, 4].some((i) => st2.cut.has(i)) && [5, 6, 7, 8, 9].every((i) => st2.cut.has(i)));
  assert.ok(!st2.cut.has(12));
  assert.equal(st2.words[13].w, 'inséparables !');
  // le fragment acoustique coupé limite le passage gardé
  assert.ok(st.kept.every((k) => !(k.t0 < 5.55 && k.t1 > 5.4)));
});

test('morceaux A1 contigus en images entières ; sous-titres sur les mots gardés, sans mot coupé', () => {
  const an = analysis();
  const st = voiceState(an);
  const pieces = voicePieces(st, { fps: 30 });
  let f = 0;
  for (const p of pieces) { assert.equal(p.tl, f); f += p.frames; }
  const clips = voiceClips(pieces, 'src1');
  assert.ok(clips.every((c) => c.track === 'A1' && c.fadeIn > 0));
  const subs = subtitleClips(st, pieces, { fps: 30, glossary: [{ text: 'inséparables', kind: 'important' }] });
  assert.deepEqual(subs.broken, []);
  const text = subs.clips.flatMap((c) => c.sub.words.map((w) => w.w)).join(' ');
  assert.equal(text, 'Deux garçons de huit ans Ils sont inséparables');
  assert.ok(subs.clips.some((c) => c.sub.words.some((w) => w.kind === 'important')));
  for (let i = 1; i < subs.clips.length; i++) assert.ok(subs.clips[i].start >= subs.clips[i - 1].start + subs.clips[i - 1].dur, 'pas de chevauchement');
  // aucun sous-titre ne commence avant la voix correspondante ni après la fin de la voix
  assert.ok(subs.clips[subs.clips.length - 1].start < f);
  const doc = newProject();
  replaceVoiceAndSubs(doc, 'src1', clips, subs.clips);
  assert.equal(doc.clips.filter((c) => c.track === 'T1').length, subs.clips.length);
  assert.match(cleaningReport(an, st), /prises trouvées/);
});

test('niveau : une prise enregistrée 9 dB plus bas est remontée (borné à ±6 dB), écart < 1,5 dB ignoré', () => {
  const env = new Float32Array(3000).fill(-70);
  env.fill(-20, 0, 1000); env.fill(-29, 1000, 2000); env.fill(-21, 2000, 3000);   // 3 morceaux de 10 s
  const pieces = [0, 10, 20].map((t, i) => ({ srcIn: t, srcOut: t + 10, tl: i * 300, frames: 300, fadeIn: 0, fadeOut: 0 }));
  const g = levelMatch(pieces, env);
  assert.equal(g[0], 0);
  assert.equal(g[1], 6);       // 9 dB demandés, plafonnés à 6
  assert.equal(g[2], 0);       // 1 dB : ignoré
  assert.equal(voiceClips(pieces, 's', g)[1].gainDb, 6);
});
