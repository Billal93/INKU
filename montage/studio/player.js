// Lecteur d'aperçu : composition image par image à partir des PROXIES (le rendu final retourne aux originaux).
// Horloge maître = l'horloge audio quand une voix joue, sinon l'horloge système. Si le décodage décroche,
// on affiche la dernière image disponible (images sautées) sans jamais décaler l'audio.
import { Input, ALL_FORMATS, BlobSource, CanvasSink } from '../vendor/mediabunny.min.mjs';
import { Compositor } from '../render/compositor.js';
import { Scene } from '../render/scene.js';
import { decodeAudio } from '../lib/audio.js';
import { ProjectMixer } from './mixer.js';
import { contentEnd } from './overlays.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LRU {
  constructor(n) { this.n = n; this.m = new Map(); }
  get(k) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k, v) { this.m.delete(k); this.m.set(k, v); while (this.m.size > this.n) this.m.delete(this.m.keys().next().value); }
  clear() { this.m.clear(); }
}

export class Player {
  constructor({ store, library, mount, onFrame, assets }) {
    this.store = store; this.lib = library; this.onFrame = onFrame || (() => {});
    this.assets = assets;
    this.scene = new Scene();
    this.mixer = new ProjectMixer({ lib: library, assets });
    this.mixBuffer = null;    // { key, buffer } : mixage complet du projet (même calcul que l'export)
    if (assets) assets.addEventListener('reader', () => this.redraw());
    this.H = library.proxyHeight; this.W = Math.round((this.H * 9) / 16);
    // Compositeur commun aperçu / export ; la résolution suit la taille affichée × densité de l'écran (≤ 1080×1920).
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;';
    mount.appendChild(canvas);
    const size = () => {
      const h = Math.max(480, Math.min(1920, Math.round((mount.clientHeight || 640) * (window.devicePixelRatio || 1))));
      return /** @type {[number, number]} */ ([Math.round((h * 9) / 16), h]);
    };
    this.comp = new Compositor(canvas, ...size());
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => { const [w, h] = size(); if (Math.abs(h - this.comp.height) > 40) { this.comp.resize(w, h); this.redraw(); } }).observe(mount);
    }
    this.mount = mount;
    this.font = { family: 'Plus Jakarta Sans', weight: 800, brand: false };
    this.handles = new Map();         // `${srcId}:${kind}` -> { input, sink, kind, usable, track }
    this.cache = new LRU(10);
    this.scrubBitmaps = new LRU(48);   // images basse définition décodées (ImageBitmap) pour le défilement instantané
    this.lastSeekAt = 0;
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
    if (rec.kind === 'image') {
      const key = srcId + ':image';
      if (this.handles.has(key)) return this.handles.get(key);
      const file = await this.lib.getFile(srcId, 'media');
      if (!file) return null;
      const h = { kind: 'image', bmp: await createImageBitmap(file), usable: rec.letterbox.usable, rec, input: null, sink: null };
      this.handles.set(key, h);
      return h;
    }
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
    if (h.kind === 'proxy' && h.usable) {
      const s = canvas.height / h.usable.h;
      return { x: (rect.x - h.usable.x) * s, y: (rect.y - h.usable.y) * s, w: rect.w * s, h: rect.h * s };
    }
    return rect;
  }

  async frameAt(srcId, t) {
    const h = await this._handle(srcId);
    if (!h) return null;
    if (h.kind === 'image') return { canvas: h.bmp, h };
    const key = srcId + ':' + h.kind + ':' + Math.round(t * 1000);
    const hit = this.cache.get(key);
    if (hit) return { canvas: hit, h };
    const wc = await h.sink.getCanvas(Math.max(0, t));
    if (!wc) return null;
    this.cache.set(key, wc.canvas);
    return { canvas: wc.canvas, h };
  }

  videoClipAt(frame) {
    const b = this.scene.bgAt(this.store.doc, frame);
    return b ? b.clip : null;
  }

  /** Police des sous-titres : celle de la marque si chargée, sinon police de remplacement SIGNALÉE (export bloqué). */
  async setSubtitleFont(font) {
    try { await document.fonts.load(`${font.weight} 64px "${font.family}"`, 'ÉÀÇŒ'); } catch { }
    this.font = font; this.scene.setFont(font);
    let w = this.mount.querySelector('.fontwarn');
    if (!font.brand) {
      if (!w) { w = document.createElement('div'); w.className = 'fontwarn'; this.mount.appendChild(w); }
      w.textContent = 'Police de la marque absente : aperçu en police de remplacement (export bloqué)';
    } else if (w) w.remove();
    this.redraw();
  }

  /** Images des overlays à l'image `frame` : exactes (image fixe) ou dernière prête (lecture temps réel). */
  async _overlaysExact(frame) {
    const m = new Map();
    if (!this.assets) return m;
    for (const o of this.scene.overlaysAt(this.store.doc, frame)) {
      const r = await this.assets.reader(o.assetId, this.comp.height);
      const cv = r ? await r.at(o.t) : null;
      if (cv) m.set(o.clip.id, cv);
    }
    return m;
  }
  _overlaysLive(frame) {
    const m = new Map();
    if (!this.assets) return m;
    for (const o of this.scene.overlaysAt(this.store.doc, frame)) {
      const r = this.assets.readerSync(o.assetId, this.comp.height);
      const cv = r ? r.peek(o.t) : null;
      if (cv) m.set(o.clip.id, cv);
    }
    return m;
  }

  /** Composition de l'image (calques de la méthode, même code que l'export). */
  _draw(frameObj, clip, frame, overlays) {
    const bg = frameObj ? { canvas: frameObj.canvas, usable: frameObj.h.usable, src: frameObj.h.rec, toCanvas: (r) => this._toFrameRect(frameObj.h, r, frameObj.canvas) } : null;
    this.scene.draw(this.comp, this.store.doc, frame, { bg, overlays: overlays || this._overlaysLive(frame) });
    if (frameObj) { this.stats.drawn++; this.stats.lastSource = frameObj.h.kind; }
    this.onFrame(frame, clip);
  }

  // Image approximative issue du cache basse définition (instantanée, ~ms) ; null si indisponible.
  async scrubFrame(srcId, t) {
    const rec = this.lib.get(srcId);
    if (!rec || !rec.scrub || !rec.scrub.frames.length) return null;
    const idx = Math.max(0, Math.min(rec.scrub.frames.length - 1, Math.round(t * rec.scrub.perSec)));
    const key = srcId + ':' + idx;
    let bmp = this.scrubBitmaps.get(key);
    if (!bmp) {
      const buf = rec.scrub.frames[idx];
      if (!buf) return null;
      bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
      this.scrubBitmaps.set(key, bmp);
    }
    return { canvas: bmp, h: { kind: 'proxy', usable: rec.letterbox.usable } };
  }

  // ── Image fixe (défilement / pas à pas) : le dernier appel gagne ──
  // Pendant un défilement, l'image basse définition est dessinée tout de suite, sans attendre un décodage
  // exact en cours (qui peut prendre 100-300 ms) ; l'image exacte est demandée 90 ms après le dernier mouvement.
  seek(frame) {
    const now = performance.now();
    clearTimeout(this.refineTimer);
    this.scrubbing = now - this.lastSeekAt < 260;   // appels rapprochés = on fait défiler
    this.lastSeekAt = now;
    this.seq = (this.seq || 0) + 1;
    this.store.ui.playhead = Math.max(0, Math.round(frame));
    this.store.notify('playhead');
    if (this.playing) { this.pause(); this.play(); return; }
    if (this.scrubbing) {
      this._approx(this.store.ui.playhead, this.seq);
      this.refineTimer = setTimeout(() => { this.scrubbing = false; this.pending = this.store.ui.playhead; this._pump(); }, 90);
      return;
    }
    this.pending = this.store.ui.playhead;
    this._pump();
  }

  async _approx(f, seq) {
    const clip = this.videoClipAt(f);
    const ap = clip ? await this.scrubFrame(clip.srcId, clip.srcIn + (f - clip.start) / this.fps) : null;
    if (seq !== this.seq) return;                       // un mouvement plus récent est arrivé
    if (!ap) { this.pending = f; this._pump(); return; } // pas d'image basse définition : image exacte
    this._draw(ap, clip, f);
    this.stats.approx = (this.stats.approx || 0) + 1;
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
    const seq = this.seq;
    const clip = this.videoClipAt(frame);
    const ov = await this._overlaysExact(frame);
    if (!clip) { if (this.pending !== null || seq !== this.seq) return; this._draw(null, null, frame, ov); return; }
    const t = clip.srcIn + (frame - clip.start) / this.fps;
    const fo = await this.frameAt(clip.srcId, t);
    if (this.pending !== null || seq !== this.seq) return; // un nouveau déplacement est arrivé : inutile de dessiner
    this._draw(fo, clip, frame, ov);
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

  /** Mixage complet du projet (même calcul que l'export), recalculé en arrière-plan quand le son change. */
  async prepareMix() {
    try {
      const m = await this.mixer.mix(this.store.doc);
      if (!this.mixBuffer || this.mixBuffer.key !== m.key) this.mixBuffer = { key: m.key, buffer: ProjectMixer.toAudioBuffer(m), report: m.report, ms: m.ms };
      return this.mixBuffer;
    } catch (e) { console.warn('[player] mixage', e); return null; }
  }

  async _scheduleAudio(startFrame) {
    const doc = this.store.doc;
    if (!this.actx) this.actx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.actx.state === 'suspended') await this.actx.resume();
    this.audioNodes.forEach((n) => { try { n.stop(); } catch (e) { /* déjà arrêté */ } });
    this.audioNodes = [];
    const base = this.actx.currentTime + 0.06;
    // Mixage complet prêt (le cas normal, calculé en arrière-plan après chaque modification) : un seul tampon,
    // identique au son exporté. Sinon on joue les clips séparément sans attendre, et le mixage se prépare.
    const mix = this.mixBuffer && this.mixBuffer.key === this.mixer.keyFor(doc) ? this.mixBuffer : null;
    if (!mix) this.prepareMix();
    if (mix && mix.buffer) {
      const node = this.actx.createBufferSource();
      node.buffer = mix.buffer;
      node.connect(this.actx.destination);
      const off = startFrame / this.fps, at = this.actx.currentTime + 0.06;
      if (off < mix.buffer.duration) { node.start(at, off); this.audioNodes.push(node); }
      return at;
    }
    // Repli (mixage pas encore prêt) : chaque clip audio de la bibliothèque joué séparément.
    const solo = doc.tracks.some((t) => t.solo);
    for (const clip of doc.clips) {
      const tr = doc.tracks.find((t) => t.id === clip.track);
      if (!tr || !tr.id.startsWith('A') || tr.muted || (solo && !tr.solo) || !clip.srcId) continue;
      const endF = clip.start + clip.dur;
      if (endF <= startFrame) continue;
      const buf = await this._audioFor(clip.srcId);
      if (!buf) continue;
      const node = this.actx.createBufferSource();
      node.buffer = buf;
      const g = this.actx.createGain();
      const level = Math.pow(10, (clip.gainDb || 0) / 20);
      node.connect(g).connect(this.actx.destination);
      const offF = Math.max(0, startFrame - clip.start);
      const when = base + Math.max(0, clip.start - startFrame) / this.fps;
      const dur = (clip.dur - offF) / this.fps;
      // Micro-fondus aux raccords (voix nettoyée) : mêmes valeurs que le rendu final.
      const fi = offF === 0 ? (clip.fadeIn || 0) : 0, fo = Math.min(clip.fadeOut || 0, dur);
      g.gain.setValueAtTime(fi ? 0 : level, when);
      if (fi) g.gain.linearRampToValueAtTime(level, when + fi);
      if (fo) { g.gain.setValueAtTime(level, when + dur - fo); g.gain.linearRampToValueAtTime(0, when + dur); }
      node.start(when, clip.srcIn + offF / this.fps, dur);
      this.audioNodes.push(node);
    }
    return base;
  }

  async play() {
    if (this.playing) return;
    const end = contentEnd(this.store.doc);
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
    if (!clip) { this._draw(null, null, frame); this.lastDrawn = 'black'; return; }
    const rec = this.lib.get(clip.srcId);
    if (rec && rec.kind === 'image') {
      const h = this.handles.get(clip.srcId + ':image');
      if (!h) { this._handle(clip.srcId); return; }
      this._draw({ canvas: h.bmp, h }, clip, frame);
      return;
    }
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
    if (!cur) { if (this.lastFrameObj && this.lastFrameObj.clipId === clip.id) cur = this.lastFrameObj.cur; else return; } // image pas encore prête : la précédente
    // Sans calque animé, inutile de redessiner une image identique.
    const animated = this.scene.subtitleLayer(this.store.doc) || this.scene.overlaysAt(this.store.doc, frame).length || (this.store.doc.copyright && this.store.doc.copyright.enabled);
    if (!animated && this.lastDrawn === cur && this._lastClip === clip.id && this._lastCrop === JSON.stringify(clip.crop)) { this.onFrame(frame, clip); return; }
    this.lastFrameObj = { clipId: clip.id, cur };
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
