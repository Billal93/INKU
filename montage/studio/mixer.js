// Mixage du projet dans le navigateur : plan (audio-plan.js) → PCM 48 kHz de chaque son → mixdown (audio/mix.js).
// Le même résultat sert à l'écoute dans le Studio et à l'export (aperçu = export, aussi pour le son).
import { audioPlan, planKey } from './audio-plan.js';
import { MIX_DEFAULTS } from '../audio/mix.js';
import { decodeAudio } from '../lib/audio.js';
import { resample } from '../audio/resample.js';
import { Input, ALL_FORMATS, BlobSource } from '../vendor/mediabunny.min.mjs';
import { MIX_RATE } from './assets.js';

export class ProjectMixer {
  /** @param {{ lib: any, assets: import('./assets.js').BrandAssets }} o */
  constructor({ lib, assets }) {
    this.lib = lib; this.assets = assets;
    this.srcPcm = new Map();
    this.last = null;      // { key, channels, report }
    this.running = null;
    this.worker = null; this.seq = 0; this.waiting = new Map(); this.sent = new Set();
  }

  _call(msg, transfer = []) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./mix.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => { const w = this.waiting.get(e.data.id); if (w) { this.waiting.delete(e.data.id); e.data.ok ? w.res(e.data) : w.rej(new Error(e.data.error)); } };
    }
    const id = ++this.seq;
    return new Promise((res, rej) => { this.waiting.set(id, { res, rej }); this.worker.postMessage({ ...msg, id }, transfer); });
  }

  /** PCM 48 kHz d'une source de la bibliothèque (voix, son du trailer). */
  async sourcePcm(srcId) {
    if (this.srcPcm.has(srcId)) return this.srcPcm.get(srcId);
    const p = (async () => {
      const file = await this.lib.getFile(srcId, 'media');
      if (!file) return null;
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
      const track = await input.getPrimaryAudioTrack();
      if (!track) return null;
      const dec = await decodeAudio(track, 0, Infinity);
      if (!dec) return null;
      const b = dec.buffer;
      // décodage à partir du premier échantillon : décalage éventuel du premier paquet compensé
      const lead = Math.max(0, Math.round(dec.startTimestamp * MIX_RATE));
      return Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, c) => {
        const x = b.sampleRate === MIX_RATE ? b.getChannelData(c) : resample(b.getChannelData(c), b.sampleRate, MIX_RATE);
        if (!lead) return x.slice();
        const y = new Float32Array(x.length + lead); y.set(x, lead); return y;
      });
    })();
    this.srcPcm.set(srcId, p);
    return p;
  }

  /** Signature du son du projet (le mixage est-il à jour ?). */
  keyFor(doc) { return planKey(audioPlan(doc), { ...(doc.mix || {}) }); }

  forget(srcId) { this.srcPcm.delete(srcId); this.sent.delete('s:' + srcId); }

  /**
   * Mixe le projet (ou renvoie le dernier mixage s'il est encore valable).
   * @param {any} doc @returns {Promise<{ key: string, channels: Float32Array[], report: any, ms: number }>}
   */
  async mix(doc) {
    const plan = audioPlan(doc);
    const opt = { ...(doc.mix || {}) };
    const key = planKey(plan, opt);
    if (this.last && this.last.key === key) return this.last;
    if (this.running && this.running.key === key) return this.running.p;
    const p = (async () => {
      const t0 = performance.now();
      const items = [];
      const missing = [];
      for (const it of plan.items) {
        const pcmKey = it.ref.assetId ? 'a:' + it.ref.assetId : 's:' + it.ref.srcId;
        if (!this.sent.has(pcmKey)) {
          const ch = it.ref.assetId ? await this.assets.pcm(it.ref.assetId) : await this.sourcePcm(it.ref.srcId);
          if (!ch) { missing.push(it.label); continue; }
          // copie envoyée une fois au worker (le cache local reste utilisable)
          await this._call({ op: 'put', key: pcmKey, channels: ch });   // copie (clonage) : le cache local reste utilisable
          this.sent.add(pcmKey);
        }
        items.push({ ...it, pcmKey });
      }
      const r = await this._call({ op: 'mix', items, duration: Math.max(0.05, plan.duration), opt: { ...MIX_DEFAULTS, ...opt } });
      if (missing.length) r.report.warnings.push('Sons introuvables : ' + missing.join(', '));
      r.report.computeMs = r.ms;
      const out = { key, channels: r.channels, report: r.report, ms: Math.round(performance.now() - t0) };
      this.last = out;
      return out;
    })();
    this.running = { key, p };
    try { return await p; } finally { if (this.running && this.running.key === key) this.running = null; }
  }

  /** AudioBuffer du mixage (écoute). */
  static toAudioBuffer(m) {
    const b = new AudioBuffer({ length: m.channels[0].length, sampleRate: MIX_RATE, numberOfChannels: 2 });
    b.copyToChannel(/** @type {Float32Array<ArrayBuffer>} */ (m.channels[0]), 0); b.copyToChannel(/** @type {Float32Array<ArrayBuffer>} */ (m.channels[1]), 1);
    return b;
  }
}
