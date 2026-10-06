// Autotest et benchmark de l'appareil (écran montage/autotest.html) : capacités réelles, rendu de 5 s en 1080×1920
// avec sous-titres (même compositeur que l'aperçu et l'export), encodage H.264 + AAC et relecture du MP4 produit,
// transcription d'un extrait de référence (WER, vitesse). Produit un rapport texte à copier-coller.
import { detectCapabilities, checkSupport } from './caps.js';
import { Compositor } from '../render/compositor.js';
import { SubtitleLayer } from '../render/subtitle-layer.js';
import { makeMeasure } from '../render/text-raster.js';
import { layoutGroup, baseFontSize } from '../subs/layout.js';
import { tagWords, groupWords } from '../subs/groups.js';
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, Input, ALL_FORMATS, BufferSource, EncodedPacketSink } from '../vendor/mediabunny.min.mjs';
import { SpeechClient } from '../speech/client.js';
import { decodeWav } from '../audio/wav.js';
import { wer } from '../speech/text.js';
import { sha256Hex } from '../speech/sha256.js';

const $ = (id) => /** @type {any} */ (document.getElementById(id));
const FPS = 30;
const report = { app: 'INKU Montage autotest', version: 1, date: new Date().toISOString(), steps: {} };

function step(name) {
  const el = document.createElement('div'); el.className = 'row';
  el.innerHTML = `<b>${name}</b><div class="st">en cours…</div>`;
  $('steps').appendChild(el);
  const st = el.querySelector('.st');
  return {
    set: (txt, cls = '') => { st.textContent = txt; st.className = 'st ' + cls; },
  };
}

/** Image de fond synthétique (dégradé animé) : teste la composition sans fichier de l'utilisateur. */
function background(f) {
  const c = new OffscreenCanvas(480, 270);
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 480, 270);
  gr.addColorStop(0, `hsl(${(f * 3) % 360},70%,40%)`); gr.addColorStop(1, `hsl(${(f * 3 + 120) % 360},70%,25%)`);
  g.fillStyle = gr; g.fillRect(0, 0, 480, 270);
  g.fillStyle = '#fff'; g.fillRect((f * 7) % 480, 120, 30, 30);
  return c;
}

async function testRender(s) {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const comp = new Compositor(canvas, 1080, 1920);
  await document.fonts.load('800 64px "Plus Jakarta Sans"');
  const measure = makeMeasure('Plus Jakarta Sans', 800);
  const words = 'Deux garçons de huit ans inséparables grandissent ensemble au Japon'.split(' ').map((w, i) => ({ w, t0: 0.2 + i * 0.4, t1: 0.5 + i * 0.4 }));
  const tagged = tagWords(words, [{ text: 'inséparables', kind: 'important' }]);
  const base = baseFontSize(['inséparables'], words.map((w) => w.w), measure);
  const groups = groupWords(tagged).map((idx, i, all) => ({ id: 'g' + i, index: i, start: Math.round(tagged[idx[0]].t0 * FPS), end: i + 1 < all.length ? Math.round(tagged[all[i + 1][0]].t0 * FPS) : 150, layout: layoutGroup(idx.map((k) => tagged[k]), base, measure) }));
  const subs = new SubtitleLayer({ family: 'Plus Jakarta Sans', weight: 800 });
  subs.setGroups(groups);
  const frame = (f) => { comp.begin(); comp.drawClip(background(f), null); subs.draw(comp, f, FPS); };
  const times = [];
  for (let f = 0; f < 150; f++) { const t0 = performance.now(); frame(f); comp.gl.finish(); times.push(performance.now() - t0); }
  // Déterminisme : la même image rendue deux fois (après d'autres) donne exactement les mêmes pixels.
  frame(40); const h1 = sha256Hex(comp.readPixels()); frame(90); frame(40); const h2 = sha256Hex(comp.readPixels());
  times.sort((a, b) => a - b);
  const r = { frames: 150, msPerFrameMedian: +times[75].toFixed(2), msPerFrameP95: +times[142].toFixed(2), deterministic: h1 === h2 };
  s.set(`${r.frames} images 1080×1920 avec sous-titres : ${r.msPerFrameMedian} ms/image (p95 ${r.msPerFrameP95} ms). Rendu déterministe : ${r.deterministic ? 'oui' : 'NON'}.`, r.deterministic ? 'ok' : 'err');
  return { r, comp, frame, canvas };
}

async function testEncode(s, render) {
  const caps = report.steps.capabilities;
  const aac = caps && caps.aac && caps.aac.native;
  const target = new BufferTarget();
  const out = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const video = new CanvasSource(render.canvas, { codec: 'avc', bitrate: 16e6, keyFrameInterval: 1 });
  out.addVideoTrack(video, { frameRate: FPS });
  let audio = null;
  if (aac) { audio = new AudioBufferSource({ codec: 'aac', bitrate: caps.aac.maxBitrate || 192000 }); out.addAudioTrack(audio); }
  const t0 = performance.now();
  await out.start();
  for (let f = 0; f < 150; f++) { render.frame(f); await video.add(f / FPS, 1 / FPS); }
  if (audio) {
    const ab = new AudioBuffer({ length: 48000 * 5, sampleRate: 48000, numberOfChannels: 2 });
    for (let c = 0; c < 2; c++) { const d = ab.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = 0.2 * Math.sin(2 * Math.PI * 440 * i / 48000); }
    await audio.add(ab);
  }
  await out.finalize();
  const ms = performance.now() - t0;
  const buf = target.buffer;
  // Relecture : nombre d'images et durées.
  const input = new Input({ source: new BufferSource(buf), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  let n = 0, last = -1, irregular = 0;
  for await (const p of new EncodedPacketSink(vt).packets()) { if (last >= 0 && Math.abs(p.timestamp - last - 1 / FPS) > 1e-3) irregular++; last = p.timestamp; n++; }
  const at = await input.getPrimaryAudioTrack();
  const r = {
    seconds: +(ms / 1000).toFixed(2), realtimeFactor: +((ms / 1000) / 5).toFixed(2), sizeMB: +(buf.byteLength / 1048576).toFixed(2),
    videoFrames: n, irregularTimestamps: irregular, codec: await vt.getCodecParameterString(), audio: at ? await at.getCodecParameterString() : 'aucune (pas d\'AAC natif)',
    durationVideo: +(await vt.computeDuration()).toFixed(3), durationAudio: at ? +(await at.computeDuration()).toFixed(3) : null,
  };
  const ok = n === 150 && irregular === 0;
  s.set(`5 s encodées en ${r.seconds} s (×${r.realtimeFactor} le temps réel), ${r.sizeMB} Mo, ${r.codec} / ${r.audio}. Relecture : ${n} images, ${irregular} écart(s) de timestamps. Durées vidéo ${r.durationVideo} s, audio ${r.durationAudio ?? '—'} s.`, ok ? 'ok' : 'err');
  return r;
}

async function testAsr(s) {
  const sc = new SpeechClient();
  try {
    const t0 = performance.now();
    await sc.call('ensure', { model: 'fastconformer-fr' }, (p) => { if (p.total) s.set(`Téléchargement du modèle : ${Math.round(p.loaded / 1048576)} / ${Math.round(p.total / 1048576)} Mo (vérifié pendant l'écriture)`); });
    const dl = performance.now() - t0;
    const load = await sc.call('load', { model: 'fastconformer-fr', device: 'auto' });
    const wav = decodeWav(await (await fetch(new URL('../autotest/voix-fr-reference.wav', import.meta.url))).arrayBuffer());
    let audio = wav.channels[0];
    // 4 répétitions de l'extrait (≈ 23 s) pour une mesure de vitesse stable.
    const rep = new Float32Array(audio.length * 4); for (let k = 0; k < 4; k++) rep.set(audio, k * audio.length); audio = rep;
    await sc.call('transcribe', { audio: audio.slice(0, 16000 * 2), opt: {} });
    const r1 = await sc.call('transcribe', { audio, opt: { words: true } });
    const ref = Array(4).fill('L\'Amazone est également le fleuve le plus large de la planète, atteignant parfois 10 km de large.').join(' ');
    const w = wer([{ ref, hyp: r1.text }], { spelled: true });
    const sec = audio.length / 16000;
    const r = { model: 'fastconformer-fr', downloadSec: +(dl / 1000).toFixed(1), loadSec: +(load.ms / 1000).toFixed(1), audioSec: +sec.toFixed(1), secPerMinAudio: +((r1.ms / 1000) / (sec / 60)).toFixed(2), werPercent: +(w.wer * 100).toFixed(1), text: r1.text.slice(0, 160) };
    s.set(`Transcription : ${r.secPerMinAudio} s de calcul par minute d'audio, ${r.werPercent} % d'erreurs sur l'extrait de référence (chargement ${r.loadSec} s).`, r.werPercent < 15 ? 'ok' : 'warn');
    return r;
  } finally { sc.terminate(); }
}

async function memory() {
  try { if (performance.measureUserAgentSpecificMemory) { const m = await performance.measureUserAgentSpecificMemory(); return Math.round(m.bytes / 1048576); } } catch { }
  return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
}

async function run() {
  $('run').disabled = true;
  $('steps').innerHTML = '';
  const s0 = step('Compatibilité');
  const sup = checkSupport();
  const caps = await detectCapabilities();
  report.steps.support = sup; report.steps.capabilities = caps;
  s0.set(sup.ok ? `Montage compatible. ${sup.warnings.join(' ')}` : `Non compatible : ${sup.missing.join(', ')}`, sup.ok ? 'ok' : 'err');
  const s1 = step('Écran');
  report.steps.screen = { css: `${innerWidth}×${innerHeight}`, dpr: devicePixelRatio, standalone: matchMedia('(display-mode: standalone)').matches };
  s1.set(`${report.steps.screen.css} px, densité ${devicePixelRatio}, ${report.steps.screen.standalone ? 'application installée' : 'dans le navigateur'}`, 'ok');
  if (sup.ok) {
    const s2 = step('Rendu (compositeur commun aperçu / export)');
    let render = null;
    try { render = await testRender(s2); report.steps.render = render.r; } catch (e) { s2.set('Échec : ' + e.message, 'err'); report.steps.render = { error: String(e.message || e) }; }
    if (render) {
      const s3 = step('Encodage MP4 (H.264 + AAC) et relecture');
      try { report.steps.encode = await testEncode(s3, render); } catch (e) { s3.set('Échec : ' + e.message, 'err'); report.steps.encode = { error: String(e.message || e) }; }
      render.comp.destroy(); render.canvas.remove();
    }
    if ($('withAsr').checked) {
      const s4 = step('Transcription (FastConformer, sur l\'appareil)');
      try { report.steps.asr = await testAsr(s4); } catch (e) { s4.set('Échec : ' + e.message, 'err'); report.steps.asr = { error: String(e.message || e) }; }
    }
  }
  report.steps.memoryMB = await memory();
  const s5 = step('Rapport');
  s5.set('Terminé. Copiez le rapport ci-dessous.', 'ok');
  $('report').value = JSON.stringify(report, null, 1);
  $('copy').disabled = false; $('run').disabled = false;
  /** @type {any} */ (window).__autotest = report;
}

$('run').onclick = run;
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('report').value); $('copy').textContent = 'Copié ✓'; } catch { $('report').select(); document.execCommand('copy'); }
};
if (new URLSearchParams(location.search).has('auto')) run();
