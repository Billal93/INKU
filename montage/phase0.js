// Phase 0 — test de faisabilité : 3 clips 9:16, sous-titre (police de marque), transition avec
// retrait de fond, mixage relatif à la voix, export 15 s 1080x1920 @30 fps. Tout local.
import {
  Input, ALL_FORMATS, BlobSource, CanvasSink, Output, Mp4OutputFormat, BufferTarget,
  CanvasSource, AudioBufferSource, EncodedPacketSink,
} from './vendor/mediabunny.min.mjs';
import { detectCapabilities } from './lib/caps.js';
import { createCompositor } from './lib/compositor.js';
import { SUB_DEFAULTS, ensureFont, computeBaseSize, renderSubtitles } from './lib/subtitles.js';
import { detectLetterbox, analyzeTransition } from './lib/analysis.js';
import { decodeAudio, mixProject, makeClick, makePop, makeTestVoice, peakDb } from './lib/audio.js';

const FPS = 30;
const SEC = 15;
const N = FPS * SEC;
const CLIP_FRAMES = 150;
const FONT_URL = '../assets/fonts/plus-jakarta-sans-800.woff2'; // police de SUBSTITUTION (Clash Display Bold non fournie)
const FONT_FAMILY = 'MontageSub';

const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const ms = (t0) => Math.round(performance.now() - t0);

async function openInput(blob) {
  return new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
}

function pickEncoder(caps, resolution, hwPref) {
  const resKey = resolution.w + 'x' + resolution.h;
  const list = caps.h264.filter((x) => x.res === resKey);
  if (!list.length) return null;
  const pref = hwPref === 'prefer-software' ? list.filter((x) => x.sw) : hwPref === 'prefer-hardware' ? list.filter((x) => x.hw) : list;
  return (pref.length ? pref : list)[0];
}

// Rapide test de repli niveau D : enregistrement temps réel du canvas (on dessine pendant l'enregistrement,
// sinon captureStream n'émet aucune image).
async function testMediaRecorder(comp) {
  const canvas = comp.canvas;
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) return { ok: false, reason: 'MediaRecorder/captureStream absent' };
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime) return { ok: false, reason: 'aucun type supporté' };
  try {
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start();
    const t0 = performance.now();
    while (performance.now() - t0 < 900) {
      const hue = ((performance.now() / 600) % 1);
      comp.fillColor(hue, 1 - hue, 0.5);
      await new Promise((r) => setTimeout(r, 33));
    }
    rec.stop();
    await done;
    const size = chunks.reduce((a, b) => a + b.size, 0);
    return { ok: size > 0, mime, bytes: size };
  } catch (e) { return { ok: false, reason: e.message }; }
}

export async function runPhase0(opts, log, progress) {
  const R = { version: 1, startedAt: new Date().toISOString(), checks: [], timings: {}, warnings: [] };
  const check = (name, ok, detail) => { R.checks.push({ name, ok: !!ok, detail: detail || '' }); log((ok ? '✅ ' : '❌ ') + name + (detail ? ' — ' + detail : '')); };
  const T0 = performance.now();
  let wake = null;

  // 1. Capacités réelles
  let t = performance.now();
  const caps = await detectCapabilities();
  R.caps = caps; R.timings.capsMs = ms(t);
  log('Niveau détecté : ' + caps.level + ' · H.264 ' + (caps.h264.length ? 'oui' : 'NON') + ' · AAC natif ' + (caps.aacNative ? 'oui' : 'non') + ' · WebGL2 ' + (caps.webgl2 ? 'oui' : 'non'));
  if (!caps.videoEncoder) { check('WebCodecs VideoEncoder', false, 'absent : niveau C/D requis (non testé en phase 0)'); R.verdict = 'NO-GO (WebCodecs absent)'; return R; }

  // 2. Résolution / encodeur
  const wanted = opts.resolution === 'auto' || !opts.resolution ? caps.maxResolution : { w: Number(opts.resolution.split('x')[0]), h: Number(opts.resolution.split('x')[1]) };
  const enc = wanted && pickEncoder(caps, wanted, opts.hardware);
  if (!enc) { check('Encodeur H.264 ' + (wanted ? wanted.w + 'x' + wanted.h : ''), false, 'aucune config supportée'); R.verdict = 'NO-GO (H.264)'; return R; }
  const W = wanted.w, H = wanted.h;
  R.chosen = { resolution: W + 'x' + H, codec: enc.codec, profile: enc.profile, hw: enc.hw, sw: enc.sw };
  check('Encodeur H.264 ' + W + 'x' + H, true, enc.profile + (enc.hw ? ' (matériel dispo)' : ' (logiciel)'));
  if (W !== 1080) R.warnings.push('Repli de résolution automatique : ' + W + 'x' + H + ' au lieu de 1080x1920');

  // 3. AAC : natif sinon extension WASM
  let aacMode = 'natif';
  if (!caps.aacNative) {
    try {
      const m = await import('./vendor/mediabunny-aac-encoder.min.mjs');
      m.registerAacEncoder();
      aacMode = 'wasm (libavcodec)';
    } catch (e) { check('AAC (repli WASM)', false, e.message); R.verdict = 'NO-GO (AAC)'; return R; }
  }
  R.aacMode = aacMode;
  check('AAC', true, aacMode);

  // 4. Police de marque : vérifiée ET utilisée, sinon on bloque
  try {
    const f = await ensureFont(FONT_FAMILY, FONT_URL, 800);
    check('Police chargée et utilisée', true, 'substitut Plus Jakarta Sans 800 (Clash Display Bold à fournir)');
    R.font = f;
  } catch (e) { check('Police chargée et utilisée', false, e.message); R.verdict = 'BLOQUÉ (police)'; return R; }

  // 5. Entrées
  t = performance.now();
  const trailerIn = await openInput(opts.trailer);
  const vTrack = await trailerIn.getPrimaryVideoTrack();
  const aTrackTrailer = await trailerIn.getPrimaryAudioTrack();
  if (!vTrack) { check('Trailer décodable', false, 'aucune piste vidéo lisible'); R.verdict = 'NO-GO (décodage)'; return R; }
  const trailerDur = await trailerIn.computeDuration();
  const transIn = await openInput(opts.transition);
  const tTrack = await transIn.getPrimaryVideoTrack();
  const tAudio = await transIn.getPrimaryAudioTrack();
  R.source = { trailer: vTrack.displayWidth + 'x' + vTrack.displayHeight, trailerDur, codec: vTrack.codec };
  check('Trailer décodable', true, R.source.trailer + ' · ' + vTrack.codec + ' · ' + trailerDur.toFixed(1) + ' s');
  R.timings.openMs = ms(t);

  // 6. Analyses : bandes noires + couverture de la transition
  t = performance.now();
  const lbTimes = [0.5, 0.3, 0.6, 0.4, 0.2].map((f) => f * Math.max(1, trailerDur - 1));
  const lb = await detectLetterbox(vTrack, lbTimes);
  check('Bandes noires détectées', lb.top > 0 || lb.bottom > 0 || lb.left > 0 || lb.right > 0,
    'haut ' + lb.top + ' px, bas ' + lb.bottom + ' px (marge 2 px incluse) → zone utile ' + lb.usable.w + 'x' + lb.usable.h);
  const cover = await analyzeTransition(tTrack, FPS);
  check('Couverture totale de la transition', cover.ok,
    cover.ok ? 'fenêtre images ' + cover.fullStart + '–' + cover.fullEnd + ' (' + cover.windowFrames + ' images), coupe = image ' + cover.cutFrame : 'aucune image 100 % couvrante');
  if (!cover.ok) { R.verdict = 'NO-GO (transition)'; return R; }
  R.timings.analysisMs = ms(t);

  // 7. Plan : 3 clips de 5 s, transition calée sur la coupe A→B (image 150)
  const maxStart = Math.max(0, trailerDur - 5.2);
  const starts = [2, 8, 13].map((s) => Math.min(s, maxStart));
  const cutFrame = CLIP_FRAMES;
  const transStart = cutFrame - cover.cutFrame;
  const usable = lb.usable;
  const cropW = Math.min(usable.w, (usable.h * 9) / 16);
  const cropH = usable.h;
  const amp = 0.12 * usable.w;
  const cropFor = (clipIdx, k) => {
    const cx = usable.x + (usable.w - cropW) / 2;
    if (clipIdx !== 1) return { x: cx, y: usable.y, w: cropW, h: cropH }; // recadrage FIXE
    // travelling horizontal doux (ease-in-out), position décimale au sous-pixel, jamais hors zone utile
    const x = cx + amp * (ease(k / (CLIP_FRAMES - 1)) - 0.5);
    return { x: Math.max(usable.x, Math.min(usable.x + usable.w - cropW, x)), y: usable.y, w: cropW, h: cropH };
  };
  R.plan = { fps: FPS, frames: N, clipStarts: starts, cutFrame, transitionStartFrame: transStart, crop: { w: Math.round(cropW), h: cropH } };

  // 8. Sous-titres (fonctions pures du numéro d'image)
  const style = { ...SUB_DEFAULTS, width: 1080, height: 1920 };
  const measure = document.createElement('canvas').getContext('2d');
  const baseSize = computeBaseSize(measure, FONT_FAMILY, 800, ['INSÉPARABLES'], style);
  const font = { family: FONT_FAMILY, weight: 800, baseSize };
  const groups = [
    { startFrame: 9, endFrame: 54, phase: 0, dir: 1, lines: [[{ t: 'un', kind: 'normal' }, { t: 'nouveau', kind: 'normal' }], [{ t: 'film', kind: 'important' }]] },
    { startFrame: 54, endFrame: 120, phase: 1.9, dir: -1, lines: [[{ t: 'deux', kind: 'normal' }, { t: 'garçons', kind: 'normal' }], [{ t: 'inséparables', kind: 'important' }]] },
    { startFrame: 170, endFrame: 260, phase: 3.1, dir: 1, lines: [[{ t: 'sortie', kind: 'normal' }, { t: 'le', kind: 'normal' }], [{ t: '12 mars', kind: 'impact' }]] },
    { startFrame: 290, endFrame: 440, phase: 0.7, dir: -1, lines: [[{ t: 'abonne', kind: 'normal' }, { t: 'toi', kind: 'normal' }]] },
  ];

  // 9. Audio : voix, lit musical (audio du trailer), audio de transition, SFX
  t = performance.now();
  let voiceBuf;
  if (opts.voice) {
    const vIn = await openInput(opts.voice);
    const vA = await vIn.getPrimaryAudioTrack();
    const dec = vA ? await decodeAudio(vA, 0, SEC) : null;
    voiceBuf = dec ? dec.buffer : makeTestVoice(48000, SEC);
    check('Voix décodée', !!dec, dec ? dec.buffer.duration.toFixed(1) + ' s' : 'repli voix synthétique');
  } else { voiceBuf = makeTestVoice(48000, SEC); log('Pas de voix fournie : voix synthétique de test.'); }
  const layers = [];
  if (aTrackTrailer) {
    const dec = await decodeAudio(aTrackTrailer, 0, Math.min(trailerDur, SEC + 2));
    if (dec) layers.push({ name: 'musique (audio du trailer)', buffer: dec.buffer, at: 0, srcOffset: 0, srcDuration: SEC, gainDb: -16, fadeOut: 1.5 });
  }
  if (tAudio) {
    const dec = await decodeAudio(tAudio, 0, 2.1);
    if (dec) layers.push({ name: 'transition (son intégré)', buffer: dec.buffer, at: transStart / FPS, srcOffset: 0, gainDb: 0, capDb: 10 });
  }
  const click = makeClick(48000), pop = makePop(48000);
  let lastSfx = -1;
  for (const g of groups) {
    for (const line of g.lines) for (const w of line) {
      if ((w.kind === 'important' || w.kind === 'impact') && g.startFrame / FPS - lastSfx >= 0.4) {
        layers.push({ name: w.kind === 'impact' ? 'SFX pop' : 'SFX click', buffer: w.kind === 'impact' ? pop : click, at: g.startFrame / FPS, srcOffset: 0, gainDb: 0, capDb: 14 });
        lastSfx = g.startFrame / FPS;
      }
    }
  }
  const mix = await mixProject({ duration: SEC, rate: 48000, voice: { buffer: voiceBuf, gainDb: 4.6 }, layers });
  R.audio = mix.report; R.timings.audioMixMs = ms(t);
  const worst = Math.max(...mix.report.stems.filter((s) => s.name !== 'voix').map((s) => s.relToVoiceDb));
  check('Niveaux relatifs à la voix', worst <= 0, 'couche la plus forte : ' + worst.toFixed(1) + ' dB vs voix ; crête finale ' + mix.report.finalPeakDb.toFixed(1) + ' dBFS');

  // 10. Rendu image par image
  const comp = createCompositor(W, H, opts.compositor === 'auto' ? undefined : opts.compositor);
  R.compositor = comp.kind + (comp.degraded ? ' (dégradé : pas d\'alpha réel)' : '');
  log('Compositeur : ' + R.compositor);
  const ov = document.createElement('canvas'); ov.width = W; ov.height = H;
  const octx = ov.getContext('2d');
  const sc = W / 1080;

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const bitrate = W >= 1080 ? 16_000_000 : W >= 720 ? 8_000_000 : 5_000_000;
  const vSource = new CanvasSource(comp.canvas, {
    codec: 'avc', bitrate, keyFrameInterval: 1, fullCodecString: enc.codec,
    hardwareAcceleration: opts.hardware || 'no-preference', latencyMode: 'quality',
  });
  output.addVideoTrack(vSource, { frameRate: FPS });
  const aSource = new AudioBufferSource({ codec: 'aac', bitrate: 192_000 });
  output.addAudioTrack(aSource);

  try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { R.warnings.push('Wake Lock refusé : garder l\'écran allumé'); }

  await output.start();
  await aSource.add(mix.buffer);

  const vSink = new CanvasSink(vTrack);
  const tSink = new CanvasSink(tTrack);
  let clipIter = null, curClip = -1, transIter = null;
  const watchdog = Math.max(45, SEC * 3) * 1000; // garde-fou : arrêt si > 3x la durée attendue
  const tRender = performance.now();
  let tDec = 0, tComp = 0, tEnc = 0;
  let coverDiffMax = 0, coverFramesChecked = 0, subOverflow = false;
  const diffCtxA = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const diffCtxB = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  diffCtxA.canvas.width = diffCtxB.canvas.width = 27; diffCtxA.canvas.height = diffCtxB.canvas.height = 48;

  for (let f = 0; f < N; f++) {
    if (performance.now() - tRender > watchdog) throw new Error('Garde-fou : rendu > 3x la durée attendue (' + Math.round(watchdog / 1000) + ' s). Arrêté.');
    const ci = Math.min(2, Math.floor(f / CLIP_FRAMES));
    const k = f - ci * CLIP_FRAMES;
    let s = performance.now();
    if (ci !== curClip) {
      if (clipIter) await clipIter.return();
      curClip = ci;
      clipIter = vSink.canvasesAtTimestamps(Array.from({ length: CLIP_FRAMES }, (_, i) => starts[ci] + i / FPS));
    }
    const bg = (await clipIter.next()).value;
    const ti = f - transStart;
    let tr = null;
    if (ti >= 0 && ti < cover.frames) {
      if (ti === 0) transIter = tSink.canvasesAtTimestamps(Array.from({ length: cover.frames }, (_, i) => (i + 0.5) / FPS));
      tr = (await transIter.next()).value;
      if (ti === cover.frames - 1) { await transIter.return(); transIter = null; }
    }
    tDec += performance.now() - s; s = performance.now();

    comp.begin();
    if (bg) comp.drawClip(bg.canvas, cropFor(ci, k));
    const inCover = tr && ti >= cover.fullStart && ti <= cover.fullEnd;
    if (tr) comp.drawKeyed(tr.canvas, { cover: inCover });

    octx.setTransform(sc, 0, 0, sc, 0, 0);
    octx.clearRect(0, 0, 1080, 1920);
    // logo (haut droite) + copyright (bas centre) : posés sous les sous-titres
    octx.fillStyle = '#d91b81'; octx.beginPath(); octx.arc(1080 - 100, 150, 52, 0, Math.PI * 2); octx.fill();
    octx.fillStyle = '#fff'; octx.font = '800 56px "' + FONT_FAMILY + '"'; octx.textAlign = 'center'; octx.textBaseline = 'middle'; octx.fillText('K', 1080 - 100, 152);
    octx.font = '800 24px "' + FONT_FAMILY + '"'; octx.textBaseline = 'bottom'; octx.shadowColor = 'rgba(0,0,0,0.45)'; octx.shadowBlur = 3; octx.shadowOffsetY = 1;
    octx.fillStyle = 'rgba(255,255,255,0.8)'; octx.fillText('© TEST INKU STUDIO', 540, 1920 - 14);
    octx.shadowColor = 'transparent';
    const sub = renderSubtitles(octx, f, groups, style, font, true);
    if (sub && sub.overflow) subOverflow = true;
    comp.drawOverlay(ov);
    tComp += performance.now() - s; s = performance.now();

    // Contrôle : pendant la couverture totale, le résultat DOIT ressembler à la transition seule
    if (inCover && tr && coverFramesChecked < 6) {
      diffCtxA.drawImage(comp.canvas, 0, 0, 27, 48); diffCtxB.drawImage(tr.canvas, 0, 0, 27, 48);
      const a = diffCtxA.getImageData(0, 0, 27, 48).data, b = diffCtxB.getImageData(0, 0, 27, 48).data;
      let sum = 0, cnt = 0;
      // on ignore la bande où peuvent se trouver logo/sous-titres : on compare le tiers gauche médian
      for (let y = 16; y < 32; y++) for (let x = 0; x < 9; x++) { const i = (y * 27 + x) * 4; sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); cnt += 3; }
      coverDiffMax = Math.max(coverDiffMax, sum / cnt);
      coverFramesChecked++;
    }

    await vSource.add(f / FPS, 1 / FPS, f % FPS === 0 ? { keyFrame: true } : undefined);
    tEnc += performance.now() - s;
    if (f % 15 === 0) progress(f / N, 'Rendu ' + Math.round((f / N) * 100) + ' %');
  }
  if (clipIter) await clipIter.return();
  await output.finalize();
  const renderMs = ms(tRender);
  const blob = new Blob([target.buffer], { type: 'video/mp4' });
  R.timings.renderMs = renderMs; R.timings.decodeMs = Math.round(tDec); R.timings.composeMs = Math.round(tComp); R.timings.encodeMs = Math.round(tEnc);
  R.render = { fps: +(N / (renderMs / 1000)).toFixed(1), xRealtime: +((SEC * 1000) / renderMs).toFixed(2), fileBytes: blob.size, bitrateTargetMbps: bitrate / 1e6 };
  if (performance.memory) R.memory = { jsHeapUsedMB: Math.round(performance.memory.usedJSHeapSize / 1048576) };
  check('Rendu terminé', renderMs <= SEC * 3000, 'rendu en ' + (renderMs / 1000).toFixed(1) + ' s pour ' + SEC + ' s de vidéo (×' + R.render.xRealtime + ' temps réel) · ' + (blob.size / 1048576).toFixed(1) + ' Mo');
  check('Transition : plan A/B masqué pendant la couverture', coverFramesChecked > 0 && coverDiffMax < 12, 'écart moyen vs transition seule : ' + coverDiffMax.toFixed(1) + '/255 sur ' + coverFramesChecked + ' images' + (comp.degraded ? ' (compositeur dégradé)' : ''));
  check('Sous-titres dans les marges de sécurité', !subOverflow, 'taille de base constante ' + baseSize + ' px');

  // 11. Vérification du fichier produit : relecture complète, régularité des timestamps, durée audio/vidéo
  t = performance.now();
  const outIn = await openInput(blob);
  const ov0 = await outIn.getPrimaryVideoTrack();
  const oa0 = await outIn.getPrimaryAudioTrack();
  const stamps = [];
  for await (const p of new EncodedPacketSink(ov0).packets()) stamps.push(p.timestamp);
  stamps.sort((a, b) => a - b);
  let maxDev = 0;
  for (let i = 1; i < stamps.length; i++) maxDev = Math.max(maxDev, Math.abs(stamps[i] - stamps[i - 1] - 1 / FPS));
  const vDur = await ov0.computeDuration();
  const aDur = oa0 ? await oa0.computeDuration() : 0;
  R.output = { frames: stamps.length, videoDur: vDur, audioDur: aDur, maxTimestampDeviationS: maxDev, codec: ov0.codec, size: ov0.displayWidth + 'x' + ov0.displayHeight, audioCodec: oa0 && oa0.codec };
  check('Aucune image perdue/dupliquée (CFR)', stamps.length === N && maxDev < 0.0005, stamps.length + '/' + N + ' images, écart max ' + (maxDev * 1000).toFixed(3) + ' ms');
  check('Audio = vidéo (écart ≤ 1 image)', Math.abs(vDur - aDur) <= 1 / FPS + 0.02, 'vidéo ' + vDur.toFixed(3) + ' s · audio ' + aDur.toFixed(3) + ' s');
  check('Sortie ' + W + 'x' + H + ' H.264 + AAC', ov0.displayWidth === W && ov0.displayHeight === H && ov0.codec === 'avc' && (!oa0 || oa0.codec === 'aac'), ov0.codec + ' / ' + (oa0 && oa0.codec));

  // lecture par le navigateur
  const url = URL.createObjectURL(blob);
  const playback = await new Promise((resolve) => {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto';
    const to = setTimeout(() => resolve({ ok: false, reason: 'délai dépassé' }), 8000);
    v.onerror = () => { clearTimeout(to); resolve({ ok: false, reason: 'erreur ' + (v.error && v.error.code) }); };
    v.onloadeddata = () => { clearTimeout(to); resolve({ ok: v.videoWidth === W, w: v.videoWidth, h: v.videoHeight, duration: v.duration }); };
    v.src = url;
  });
  R.playback = playback;
  check('Fichier lisible par le navigateur', playback.ok, playback.ok ? playback.w + 'x' + playback.h + ' · ' + playback.duration.toFixed(2) + ' s' : playback.reason);
  R.timings.verifyMs = ms(t);
  R.mediaRecorder = await testMediaRecorder(comp);
  log('Niveau D (MediaRecorder) : ' + (R.mediaRecorder.ok ? 'OK ' + R.mediaRecorder.mime : 'non : ' + R.mediaRecorder.reason));

  R.timings.totalMs = ms(T0);
  const failed = R.checks.filter((c) => !c.ok);
  R.verdict = failed.length ? 'À EXAMINER (' + failed.length + ' contrôle(s) en échec)' : 'GO sur cet appareil';
  R.blobUrl = url; R.blob = blob;
  if (wake) { try { await wake.release(); } catch (e) { /* ignoré */ } }
  return R;
}
