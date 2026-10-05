// Worker d'analyse : copie dans le stockage privé (OPFS), sonde, bandes noires, plans (shots), vignettes,
// forme d'onde, proxy 720p. Une seule tâche lourde à la fois (un seul décodeur actif).
import {
  Input, ALL_FORMATS, BlobSource, CanvasSink, AudioSampleSink, Conversion, Output, Mp4OutputFormat, StreamTarget, BufferTarget,
} from '../vendor/mediabunny.min.mjs';
import { detectLetterbox } from '../lib/analysis.js';

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (id, stage, p) => post({ type: 'progress', id, stage, progress: Math.max(0, Math.min(1, p)) });

async function opfsDir(kind) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(kind, { create: true });
}

async function copyToOpfs(kind, id, file, onp) {
  if (!(navigator.storage && navigator.storage.getDirectory)) return { ok: false, reason: 'OPFS indisponible' };
  let ah = null;
  try {
    const d = await opfsDir(kind);
    const fh = await d.getFileHandle(id, { create: true });
    ah = await fh.createSyncAccessHandle();
    ah.truncate(0);
    const reader = file.stream().getReader();
    let pos = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      ah.write(value, { at: pos });
      pos += value.byteLength;
      onp(pos / file.size);
    }
    ah.flush(); ah.close(); ah = null;
    return { ok: true };
  } catch (e) {
    try { if (ah) ah.close(); } catch (e2) { /* ignoré */ }
    return { ok: false, reason: e && e.name === 'QuotaExceededError' ? 'Stockage plein' : (e && e.message) || 'échec de copie' };
  }
}

async function readOpfs(kind, id) {
  const d = await opfsDir(kind);
  const fh = await d.getFileHandle(id);
  return fh.getFile();
}

async function fingerprint(file) {
  const head = await file.slice(0, 1 << 20).arrayBuffer();
  const tail = file.size > (2 << 20) ? await file.slice(file.size - (1 << 20)).arrayBuffer() : new ArrayBuffer(0);
  const meta = new TextEncoder().encode(file.size + ':' + file.name);
  const all = new Uint8Array(head.byteLength + tail.byteLength + meta.byteLength);
  all.set(new Uint8Array(head), 0); all.set(new Uint8Array(tail), head.byteLength); all.set(meta, head.byteLength + tail.byteLength);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return Array.from(h.slice(0, 12)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Plans (shots) ──
const BINS = 16;
function histOf(canvas, ctx, w, h) {
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const hist = new Float32Array(BINS * 3);
  let luma = 0;
  const n = w * h;
  for (let i = 0; i < d.length; i += 4) {
    hist[(d[i] >> 4)]++; hist[BINS + (d[i + 1] >> 4)]++; hist[2 * BINS + (d[i + 2] >> 4)]++;
    luma += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= n;
  return { hist, luma: luma / (n * 255) };
}
const l1 = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / 3; }; // 0..2

async function detectShots(vTrack, duration, usable, onp) {
  const W = 64, H = 36;
  // Un seul passage de décodage : images de 480 px (zone utile) réduites à 64x36 pour l'histogramme,
  // et conservées en JPEG pour le défilement instantané (cache d'images basse définition).
  const SW = 480, SH = Math.max(2, Math.round((SW * usable.h) / usable.w));
  const sink = new CanvasSink(vTrack, { width: SW, height: SH, fit: 'fill', crop: { left: usable.x, top: usable.y, width: usable.w, height: usable.h } });
  const ctx = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
  const scrubPerSec = duration > 600 ? 2 : 4;
  const everyN = 8 / scrubPerSec;
  const scrubFrames = [];
  const SR = 8;
  const n = Math.max(1, Math.floor(duration * SR));
  const ts = Array.from({ length: n }, (_, i) => i / SR);
  let prev = null, i = 0;
  const samples = []; // { t, luma, d }
  for await (const wc of sink.canvasesAtTimestamps(ts)) {
    if (wc) {
      const cur = histOf(wc.canvas, ctx, W, H);
      samples.push({ t: ts[i], luma: cur.luma, d: prev ? l1(prev.hist, cur.hist) : 0 });
      prev = cur;
      if (i % everyN === 0) {
        const blob = await /** @type {OffscreenCanvas} */ (wc.canvas).convertToBlob({ type: 'image/jpeg', quality: 0.62 });
        scrubFrames[i / everyN] = await blob.arrayBuffer();
      }
    }
    i++;
    if (i % 8 === 0) onp(i / n);
  }
  const TH = 0.4;
  const cands = samples.map((s, k) => ({ k, ...s })).filter((s) => s.k > 0 && s.d > TH);

  // Affinage à l'image près : on décode toutes les images de l'intervalle précédent le saut.
  const cuts = [];
  for (const c of cands) {
    const a = Math.max(0, samples[c.k - 1].t), b = c.t + 1e-4;
    let last = null, best = { d: -1, t: c.t };
    for await (const wc of sink.canvases(a, b)) {
      const cur = histOf(wc.canvas, ctx, W, H);
      if (last) { const d = l1(last.hist, cur.hist); if (d > best.d) best = { d, t: wc.timestamp }; }
      last = cur;
    }
    cuts.push({ t: best.t, d: best.d >= 0 ? best.d : c.d });
  }
  // Fusion des coupes trop rapprochées (< 0,4 s) : on garde la plus marquée.
  const kept = [];
  for (const c of cuts) {
    const l = kept[kept.length - 1];
    if (l && c.t - l.t < 0.4) { if (c.d > l.d) kept[kept.length - 1] = c; } else kept.push(c);
  }
  const bounds = [0, ...kept.map((c) => c.t), duration];
  const shots = [];
  for (let s = 0; s < bounds.length - 1; s++) {
    const start = bounds[s], end = bounds[s + 1];
    if (end - start < 0.1) continue;
    const inside = samples.filter((x) => x.t >= start && x.t < end);
    const luma = inside.length ? inside.reduce((a, x) => a + x.luma, 0) / inside.length : 0;
    // mouvement = écart d'histogramme moyen entre échantillons du plan, hors saut de coupe
    const motion = inside.length > 1 ? inside.slice(1).reduce((a, x) => a + Math.min(x.d, TH), 0) / (inside.length - 1) : 0;
    shots.push({ start, end, luma, motion, black: luma < 0.06 });
  }
  return { shots, scrub: { perSec: scrubPerSec, width: SW, height: SH, frames: scrubFrames } };
}

async function makeThumbs(vTrack, shots, usable) {
  const sink = new CanvasSink(vTrack, { width: 192, height: 108, fit: 'cover', crop: { left: usable.x, top: usable.y, width: usable.w, height: usable.h } });
  const out = [];
  for (const s of shots) {
    const t = Math.min(s.end - 0.05, s.start + (s.end - s.start) * 0.4);
    const wc = await sink.getCanvas(Math.max(0, t));
    if (!wc) { out.push(null); continue; }
    const blob = await /** @type {OffscreenCanvas} */ (wc.canvas).convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    out.push(await blob.arrayBuffer());
  }
  return out;
}

async function waveformOf(aTrack, duration, onp) {
  const PER_SEC = 200;
  const peaks = new Float32Array(Math.ceil(duration * PER_SEC) + 2);
  const sink = new AudioSampleSink(aTrack);
  for await (const sample of sink.samples()) {
    const rate = sample.sampleRate, nF = sample.numberOfFrames;
    const buf = new Float32Array(nF);
    sample.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
    const base = sample.timestamp * rate;
    const per = rate / PER_SEC;
    for (let i = 0; i < nF; i++) {
      const b = Math.floor((base + i) / per);
      const a = Math.abs(buf[i]);
      if (b >= 0 && b < peaks.length && a > peaks[b]) peaks[b] = a;
    }
    sample.close();
    onp(Math.min(1, sample.timestamp / Math.max(duration, 0.01)));
  }
  return { peaks, perSec: PER_SEC };
}

async function ingest(m) {
  const { id, file } = m;
  progress(id, 'copy', 0);
  // skipCopy : le fichier vient déjà de l'OPFS (ré-analyse) — le recopier sur lui-même le tronquerait.
  const copy = m.skipCopy ? { ok: true } : await copyToOpfs('media', id, file, (p) => progress(id, 'copy', p));
  const blob = copy.ok ? await readOpfs('media', id) : file;
  const fp = await fingerprint(file);
  progress(id, 'probe', 0);
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const vTrack = await input.getPrimaryVideoTrack();
  const aTrack = await input.getPrimaryAudioTrack();
  if (!vTrack && !aTrack) throw new Error('Format non reconnu ou fichier illisible');
  const duration = await input.computeDuration();
  const meta = {
    id, name: file.name, kind: vTrack ? 'video' : 'audio', size: file.size, fingerprint: fp, duration,
    hasAudio: !!aTrack, persisted: copy.ok, persistReason: copy.ok ? null : copy.reason,
  };
  const result = { type: 'ingested', id, meta };
  const transfer = [];

  if (vTrack) {
    let fps = 30;
    try { const st = await vTrack.computePacketStats(150); if (st.averagePacketRate > 1) fps = Math.round(st.averagePacketRate * 100) / 100; } catch (e) { /* fps par défaut */ }
    Object.assign(meta, { fps, width: vTrack.displayWidth, height: vTrack.displayHeight, codec: vTrack.codec });
    progress(id, 'letterbox', 0);
    const times = [0.5, 0.3, 0.6, 0.4, 0.2].map((f) => f * Math.max(1, duration - 1));
    const lb = await detectLetterbox(vTrack, times);
    meta.letterbox = lb;
    const { shots, scrub } = await detectShots(vTrack, duration, lb.usable, (p) => progress(id, 'shots', p));
    progress(id, 'thumbs', 0);
    const thumbs = await makeThumbs(vTrack, shots, lb.usable);
    result.shots = shots; result.thumbs = thumbs; result.scrub = scrub;
    for (const t of thumbs) if (t) transfer.push(t);
    for (const f of scrub.frames) if (f) transfer.push(f);
  } else {
    progress(id, 'wave', 0);
    const wf = await waveformOf(aTrack, duration, (p) => progress(id, 'wave', p));
    result.waveform = wf; transfer.push(wf.peaks.buffer);
  }
  if (!copy.ok) result.file = file; // pas de stockage privé : la session garde le File en mémoire
  input.dispose && input.dispose();
  post(result, transfer);
}

async function makeProxy(m) {
  const { id, height, usable } = m;
  progress(id, 'proxy', 0);
  const blob = m.file || await readOpfs('media', id);
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const canOpfs = !!(navigator.storage && navigator.storage.getDirectory);
  let handle = null, target, buffer = null;
  if (canOpfs) {
    try {
      const d = await opfsDir('proxy');
      const fh = await d.getFileHandle(id, { create: true });
      handle = await fh.createSyncAccessHandle();
      handle.truncate(0);
      const h = handle;
      target = new StreamTarget(new WritableStream({ write(chunk) { h.write(chunk.data, { at: chunk.position }); } }));
    } catch (e) { handle = null; }
  }
  if (!handle) { buffer = new BufferTarget(); target = buffer; }
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
  const conv = await Conversion.init({
    input, output,
    video: { crop: { left: usable.x, top: usable.y, width: usable.w, height: usable.h }, height, codec: 'avc', bitrate: 3_000_000, keyFrameInterval: 0.25, forceTranscode: true },
    audio: { discard: true },
  });
  if (!conv.isValid) throw new Error('Proxy impossible : ' + JSON.stringify(conv.discardedTracks.map((t) => t.reason)));
  conv.onProgress = (p) => progress(id, 'proxy', p);
  await conv.execute();
  if (handle) { handle.flush(); handle.close(); post({ type: 'proxied', id, persisted: true, height }); }
  else { post({ type: 'proxied', id, persisted: false, height, blob: new Blob([buffer.buffer], { type: 'video/mp4' }) }); }
}

let busy = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  busy = busy.then(async () => {
    try {
      if (m.cmd === 'ingest') await ingest(m);
      else if (m.cmd === 'proxy') await makeProxy(m);
    } catch (err) {
      post({ type: 'error', id: m.id, stage: m.cmd, message: (err && err.message) || String(err) });
    }
  });
};
post({ type: 'ready' });
