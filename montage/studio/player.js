// Lecteur d'aperçu : composition image par image à partir des PROXIES (le rendu final retourne aux originaux).
// Horloge maître = l'horloge audio quand une voix joue, sinon l'horloge système. Si le décodage décroche,
// on affiche la dernière image disponible (images sautées) sans jamais décaler l'audio.
import { Input, ALL_FORMATS, BlobSource, CanvasSink } from '../vendor/mediabunny.min.mjs';
import { createCompositor } from '../lib/compositor.js';
import { decodeAudio } from '../lib/audio.js';
import { cropWindow, totalFrames } from './edl.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LRU {
  constructor(n) { this.n = n; this.m = new Map(); }
  get(k) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k, v) { this.m.delete(k); this.m.set(k, v); while (this.m.size > this.n) this.m.delete(this.m.keys().next().value); }
  clear() { this.m.clear(); }
}

export class Player {
  constructor({ store, library, mount, onFrame }) {
    this.store = store; this.lib = library; this.onFrame = onFrame || (() => {});
    this.H = library.proxyHeight; this.W = Math.round((this.H * 9) / 16);
    this.comp = createCompositor(this.W, this.H);
    this.comp.canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;';
    mount.appendChild(this.comp.canvas);
    this.handles = new Map();         // `${srcId}:${kind}` -> { input, sink, kind, usable, track }
    this.cache = new LRU(10);
    this.token = 0; this.pending = null; this.rendering = false;
    this.playing = false; this.raf = 0;
    this.pump = null; this.nextPump = null;
    this.actx = null; this.audioNodes = []; this.audioBuffers = new Map();
    this.lastDrawn = null;
    this.stats = { dropped: 0, drawn: 0, lastSource: '' };
    this.comp.begin();
  }

  get fps() { return this.store.doc.project.fps; }

  // ── Sources ──
  async _handle(srcId) {
    const rec = this.lib.get(srcId);
    if (!rec) return null;
    const wantProxy = rec.proxy === 'ready';
    const key = srcId + ':' + (wantProxy ? 'proxy' : 'media');
    if (this.handles.has(key)) return this.handles.get(key);
    const file = await this.lib.getFile(srcId, wantProxy ? 'proxy' : 'media');
    if (!file) return null;
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const h = { input, track, sink: new CanvasSink(track, { poolSize: 0 }), kind: wantProxy ? 'proxy' : 'media', usable: rec.letterbox.usable, rec };
    this.handles.set(key, h);
    return h;
  }

  // Passe une fenêtre de cadrage (coordonnées originales) en coordonnées du canvas décodé.
  _toFrameRect(h, rect, canvas) {
    if (h.kind === 'proxy') {
      const s = canvas.height / h.usable.h;
      return { x: (rect.x - h.usable.x) * s, y: (rect.y - h.usable.y) * s, w: rect.w * s, h: rect.h * s };
    }
    return rect;
  }

  async frameAt(srcId, t) {
    const h = await this._handle(srcId);
    if (!h) return null;
    const key = srcId + ':' + h.kind + ':' + Math.round(t * 1000);
    const hit = this.cache.get(key);
    if (hit) return { canvas: hit, h };
    const wc = await h.sink.getCanvas(Math.max(0, t));
    if (!wc) return null;
    this.cache.set(key, wc.canvas);
    return { canvas: wc.canvas, h };
  }

  videoClipAt(frame) {
    const doc = this.store.doc;
    const tr = doc.tracks.find((x) => x.id === 'V1');
    if (tr && tr.muted) return null;
    return doc.clips.find((c) => c.track === 'V1' && frame >= c.start && frame < c.start + c.dur) || null;
  }

  _draw(frameObj, clip, frame) {
    this.comp.begin();
    if (frameObj) {
      const k = frame - clip.start;
      const rect = cropWindow(clip, k, frameObj.h.usable);
      this.comp.drawClip(frameObj.canvas, this._toFrameRect(frameObj.h, rect, frameObj.canvas));
      this.stats.drawn++;
      this.stats.lastSource = frameObj.h.kind;
    }
    this.onFrame(frame, clip);
  }

  // ── Image fixe (défilement / pas à pas) : le dernier appel gagne ──
  seek(frame) {
    this.store.ui.playhead = Math.max(0, Math.round(frame));
    this.store.notify('playhead');
    if (this.playing) { this.pause(); this.play(); return; }
    this.pending = this.store.ui.playhead;
    this._pump();
  }

  async _pump() {
    if (this.rendering) return;
    this.rendering = true;
    try {
      while (this.pending !== null) {
        const f = this.pending; this.pending = null;
        await this.renderStill(f);
      }
    } finally { this.rendering = false; }
  }

  async renderStill(frame) {
    const clip = this.videoClipAt(frame);
    if (!clip) { this.comp.begin(); this.onFrame(frame, null); return; }
    const t = clip.srcIn + (frame - clip.start) / this.fps;
    const fo = await this.frameAt(clip.srcId, t);
    if (this.pending !== null) return; // un nouveau déplacement est arrivé : inutile de dessiner
    this._draw(fo, clip, frame);
  }

  refresh() { this.cache.clear(); this.pending = this.store.ui.playhead; this._pump(); }
  redraw() { this.pending = this.store.ui.playhead; this._pump(); }   // sans vider le cache (ex. cadrage glissé)
  invalidate() { this.cache.clear(); }

  // ── Lecture ──
  async _audioFor(srcId) {
    if (this.audioBuffers.has(srcId)) return this.audioBuffers.get(srcId);
    const file = await this.lib.getFile(srcId, 'media');
    if (!file) return null;
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const dec = await decodeAudio(track, 0, Infinity);
    const buf = dec ? dec.buffer : null;
    this.audioBuffers.set(srcId, buf);
    return buf;
  }

  async _scheduleAudio(startFrame) {
    const doc = this.store.doc;
    if (!this.actx) this.actx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.actx.state === 'suspended') await this.actx.resume();
    this.audioNodes.forEach((n) => { try { n.stop(); } catch (e) { /* déjà arrêté */ } });
    this.audioNodes = [];
    const solo = doc.tracks.some((t) => t.solo);
    const base = this.actx.currentTime + 0.06;
    for (const clip of doc.clips) {
      const tr = doc.tracks.find((t) => t.id === clip.track);
      if (!tr || !tr.id.startsWith('A') || tr.muted || (solo && !tr.solo)) continue;
      const endF = clip.start + clip.dur;
      if (endF <= startFrame) continue;
      const buf = await this._audioFor(clip.srcId);
      if (!buf) continue;
      const node = this.actx.createBufferSource();
      node.buffer = buf;
      const g = this.actx.createGain(); g.gain.value = Math.pow(10, (clip.gainDb || 0) / 20);
      node.connect(g).connect(this.actx.destination);
      const offF = Math.max(0, startFrame - clip.start);
      const when = base + Math.max(0, clip.start - startFrame) / this.fps;
      const dur = (clip.dur - offF) / this.fps;
      node.start(when, clip.srcIn + offF / this.fps, dur);
      this.audioNodes.push(node);
    }
    return base;
  }

  async play() {
    if (this.playing) return;
    const end = totalFrames(this.store.doc);
    let start = this.store.ui.playhead;
    if (end > 0 && start >= end - 1) start = this.store.ui.inPoint ?? 0;
    this.playing = true; this.store.ui.playing = true; this.store.notify('transport');
    this.f0 = start;
    this._stopPumps();
    let audioBase = null;
    try { audioBase = await this._scheduleAudio(start); } catch (e) { console.warn('[player] audio', e); }
    if (!this.playing) return;
    const perf0 = performance.now();
    this.clock = audioBase !== null ? { audio: true, t0: audioBase, lastA: -1, lastChange: perf0, started: perf0 } : { audio: false, t0: performance.now() / 1000 };
    this.store.ui.playhead = start;
    const loop = () => {
      if (!this.playing) return;
      let now = this.clock.audio ? this.actx.currentTime : performance.now() / 1000;
      if (this.clock.audio) {
        // Filet de sécurité : si l'horloge audio ne progresse pas (contexte suspendu, pas de sortie audio),
        // on bascule sur l'horloge système à l'image courante, sans saut visible.
        const pn = performance.now();
        if (now !== this.clock.lastA) { this.clock.lastA = now; this.clock.lastChange = pn; }
        else if (pn - this.clock.lastChange > 350 && pn - this.clock.started > 600) {
          this.f0 = Math.floor(this.f0 + Math.max(0, now - this.clock.t0) * this.fps);
          this.clock = { audio: false, t0: pn / 1000 };
          this.stats.clockFallback = true;
          now = pn / 1000;
        }
      }
      const frame = Math.floor(this.f0 + Math.max(0, now - this.clock.t0) * this.fps);
      const outP = this.store.ui.outPoint;
      const limit = outP !== null && outP > start ? outP : end;
      if (frame >= limit) {
        if (this.store.ui.inPoint !== null && outP !== null) { this.seek(this.store.ui.inPoint); this.play(); return; }
        this.pause(); this.store.ui.playhead = Math.max(0, limit - 1); this.store.notify('playhead'); this.refresh(); return;
      }
      if (frame !== this.store.ui.playhead) { this.store.ui.playhead = frame; this.store.notify('playhead'); }
      this._playbackFrame(frame);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false; this.store.ui.playing = false;
    cancelAnimationFrame(this.raf);
    this.audioNodes.forEach((n) => { try { n.stop(); } catch (e) { /* déjà arrêté */ } });
    this.audioNodes = [];
    this._stopPumps();
    this.store.notify('transport');
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  _stopPumps() {
    for (const p of [this.pump, this.nextPump]) if (p) p.stop = true;
    this.pump = null; this.nextPump = null;
  }

  async _startPump(clip, fromFrame) {
    const p = { clipId: clip.id, srcId: clip.srcId, queue: [], stop: false, ready: false };
    try {
      const h = await this._handle(clip.srcId);
      if (!h) { p.stop = true; return p; }
      p.h = h;
      const startT = clip.srcIn + (fromFrame - clip.start) / this.fps;
      const endT = clip.srcIn + clip.dur / this.fps + 0.1;
      // Avec poolSize 0 chaque image est un canvas neuf ; on garde ≤ 4 images d'avance.
      const it = h.sink.canvases(Math.max(0, startT), endT);
      (async () => {
        try {
          for await (const wc of it) {
            if (p.stop) break;
            p.queue.push(wc);
            p.ready = true;
            while (!p.stop && p.queue.length >= 4) await sleep(6);
          }
        } catch (e) { console.warn('[player] pump', e); }
        p.done = true;
      })();
    } catch (e) { console.warn('[player] startPump', e); p.stop = true; }
    return p;
  }

  _playbackFrame(frame) {
    const clip = this.videoClipAt(frame);
    if (!clip) { if (this.lastDrawn !== 'black') { this.comp.begin(); this.lastDrawn = 'black'; this.onFrame(frame, null); } return; }
    if (!this.pump || this.pump.clipId !== clip.id) {
      if (this.pump) this.pump.stop = true;
      if (this.nextPump && this.nextPump.clipId === clip.id) { this.pump = this.nextPump; this.nextPump = null; }
      else { const pending = this._startPump(clip, frame); this.pump = { clipId: clip.id, queue: [], stop: false, ready: false, loading: pending }; pending.then((real) => { if (this.pump && this.pump.clipId === clip.id && this.pump.loading === pending) this.pump = real; else real.stop = true; }); }
    }
    // Préchargement du clip suivant ~0,4 s avant la coupe
    if (!this.nextPump && clip.start + clip.dur - frame <= Math.round(this.fps * 0.4)) {
      const nxt = this.store.doc.clips.filter((c) => c.track === 'V1' && c.start >= clip.start + clip.dur).sort((a, b) => a.start - b.start)[0];
      if (nxt && nxt.start - (clip.start + clip.dur) <= 2) { const pend = this._startPump(nxt, nxt.start); this.nextPump = { clipId: nxt.id, queue: [], stop: false, loading: pend }; pend.then((real) => { if (this.nextPump && this.nextPump.clipId === nxt.id) this.nextPump = real; else real.stop = true; }); }
    }
    const p = this.pump;
    const ts = clip.srcIn + (frame - clip.start) / this.fps;
    let cur = null;
    if (p && p.queue) {
      while (p.queue.length > 1 && p.queue[1].timestamp <= ts + 1e-4) { p.queue.shift(); this.stats.dropped++; }
      if (p.queue.length && p.queue[0].timestamp <= ts + 0.25) cur = p.queue[0];
    }
    if (!cur) return; // pas encore d'image : on garde l'affichage précédent
    if (this.lastDrawn === cur && this._lastClip === clip.id && this._lastCrop === JSON.stringify(clip.crop)) { this.onFrame(frame, clip); return; }
    this.lastDrawn = cur; this._lastClip = clip.id; this._lastCrop = JSON.stringify(clip.crop);
    this._draw({ canvas: cur.canvas, h: p.h }, clip, frame);
  }

  destroy() {
    this.pause();
    for (const h of this.handles.values()) { try { h.input.dispose && h.input.dispose(); } catch (e) { /* ignoré */ } }
    this.handles.clear(); this.cache.clear();
    if (this.actx) this.actx.close().catch(() => {});
  }
}
