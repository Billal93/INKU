// Contrôleur de la voix : lance l'analyse dans le worker « parole », garde le résultat en cache local (IndexedDB,
// hors historique d'annulation), applique les décisions de l'utilisateur à la timeline (A1 + sous-titres T1).
import { SpeechClient } from '../speech/client.js';
import { makeSnapper } from '../speech/edits.js';
import { kvGet, kvSet } from './storage.js';
import { voiceState, voicePieces, voiceClips, subtitleClips, replaceVoiceAndSubs, cleaningReport, levelMatch } from './voice-model.js';
import { sourceRef } from './ops.js';

export const DEFAULT_MODEL = 'whisper-turbo';   // choisi par mesure : docs/decisions.md D18

/**
 * @param {{ store: any, lib: any, player: any }} o
 */
export function createVoice({ store, lib, player }) {
  let client = null;
  /** @type {Map<string, any>} */
  const memo = new Map();
  const key = (srcId, model) => `voice:${srcId}:${model}`;

  const voice = {
    /** Analyse en cours : { srcId, stage, done, total } ou null */
    running: null,

    /** Analyse en cache pour la voix courante du projet (ou null). */
    async analysis(srcId = store.doc.voice && store.doc.voice.srcId, model = store.doc.voice && store.doc.voice.model) {
      if (!srcId || !model) return null;
      const k = key(srcId, model);
      if (memo.has(k)) return memo.get(k);
      const a = await kvGet(k);
      if (a) memo.set(k, a);
      return a || null;
    },

    /** Lance l'analyse complète d'une source comme voix. @param {(p: any) => void} onProgress */
    async analyze(srcId, onProgress, model = DEFAULT_MODEL) {
      const rec = lib.get(srcId);
      if (!rec) throw new Error('Source introuvable');
      const buf = await player._audioFor(srcId);
      if (!buf) throw new Error('Cette source ne contient pas d\'audio lisible');
      // Mono : moyenne des voies (copie transférée au worker).
      const n = buf.length, pcm = new Float32Array(n);
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) pcm[i] += d[i] / buf.numberOfChannels; }
      client ||= new SpeechClient();
      this.running = { srcId, stage: 'Démarrage', done: 0, total: 1 };
      try {
        const glossary = (store.doc.subtitles && store.doc.subtitles.glossary) || [];
        const r = await client.call('analyze', { pcm, sampleRate: buf.sampleRate, model, device: 'auto', glossary }, (p) => { this.running = { srcId, ...p }; onProgress && onProgress(p); }, [pcm.buffer]);
        r.srcId = srcId; r.analyzedAt = new Date().toISOString();
        await kvSet(key(srcId, model), r);
        memo.set(key(srcId, model), r);
        store.commit('Analyse de la voix', (d) => {
          d.voice = { srcId, model, edits: {}, applied: false };
          if (!d.sources[srcId]) d.sources[srcId] = sourceRef(rec);
        });
        return r;
      } finally { this.running = null; }
    },

    /** Change une décision (couper / garder un mot, choisir une prise, corriger un mot). */
    edit(label, fn) {
      store.commit(label, (d) => { d.voice.edits ||= {}; fn(d.voice.edits); d.voice.applied = false; });
    },

    /** État courant (analyse + décisions). */
    async state() {
      const v = store.doc.voice;
      if (!v) return null;
      const an = await this.analysis(v.srcId, v.model);
      return an ? { an, st: voiceState(an, (store.doc.voice && store.doc.voice.edits) || {}) } : null;
    },

    /** Pose la voix nettoyée sur A1 (images entières) et régénère les sous-titres T1. */
    async apply() {
      const s = await this.state();
      if (!s) throw new Error('Aucune voix analysée');
      const fps = store.doc.project.fps;
      const buf = await player._audioFor(s.an.srcId);
      const snap = buf ? makeSnapper(buf.getChannelData(0), buf.sampleRate) : undefined;
      const pieces = voicePieces(s.st, { fps, snap });
      const subs = subtitleClips(s.st, pieces, { fps, glossary: (store.doc.subtitles && store.doc.subtitles.glossary) || [], punctuation: (store.doc.subtitles && store.doc.subtitles.punctuation) || 'retirée' });
      store.commit('Appliquer la voix nettoyée', (d) => {
        replaceVoiceAndSubs(d, s.an.srcId, voiceClips(pieces, s.an.srcId, levelMatch(pieces, s.an.envelope)), subs.clips);
        d.voice.applied = true;
        d.voice.pieces = pieces.length;
      });
      player.invalidate(); player.refresh();
      return { pieces: pieces.length, subs: subs.clips.length, broken: subs.broken.length, seconds: pieces.reduce((a, p) => a + p.frames, 0) / fps };
    },

    async report() { const s = await this.state(); return s ? cleaningReport(s.an, s.st) : ''; },

    /** Joue un passage de la source (secondes), pour écouter un mot ou une prise. */
    async listen(srcId, t0, t1) {
      const buf = await player._audioFor(srcId);
      if (!buf) return;
      if (!player.actx) player.actx = new AudioContext();
      if (player.actx.state === 'suspended') await player.actx.resume();
      if (voice._node) try { voice._node.stop(); } catch { }
      const node = player.actx.createBufferSource();
      node.buffer = buf; node.connect(player.actx.destination);
      node.start(0, Math.max(0, t0), Math.max(0.05, t1 - t0));
      voice._node = node;
    },
    _node: null,
  };
  return voice;
}
