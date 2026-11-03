// Éléments de marque SYNTHÉTIQUES (générés à la volée, jamais de fichier de l'utilisateur) pour l'autotest et les
// tests : transition (disque qui couvre tout l'écran images 10 à 16), ouverture (couverture totale au début),
// abonne-toi (4 images noires puis animation), logo PNG transparent, sons click / pop / musique (avec un « drop »).
// La vérité terrain est connue : l'analyse et la composition se vérifient par calcul.
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource } from '../vendor/mediabunny.min.mjs';
import { encodeWav } from '../audio/wav.js';

export const SYNTH = { W: 270, H: 480, FPS: 30, FRAMES: 30, transition: { fullStart: 10, fullEnd: 16, cut: 13 }, subscribe: { firstVisible: 4 }, opening: { fullEnd: 5 } };
export const ORANGE = [255, 140, 0];

/** Image i d'un overlay synthétique (fond noir). */
function drawFrame(g, kind, i) {
  const { W, H } = SYNTH;
  const R = Math.hypot(W / 2, H / 2);
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.fillStyle = `rgb(${ORANGE.join(',')})`;
  let r = 0;
  if (kind === 'transition') r = i < 10 ? (i + 1) / 11 * R * 0.9 : i <= 16 ? R * 1.05 : (1 - (i - 16) / 14) * R * 0.92;
  else if (kind === 'opening') r = i <= 5 ? R * 1.05 : Math.max(0, (1 - (i - 5) / 18)) * R * 0.92;
  else if (kind === 'subscribe') {
    if (i >= 4) { g.fillStyle = '#e00000'; const s = Math.min(1, (i - 3) / 6); g.fillRect(W / 2 - 90 * s, H * 0.7 - 24 * s, 180 * s, 48 * s); }
    return;
  }
  if (r > 0) { g.beginPath(); g.arc(W / 2, H / 2, r, 0, Math.PI * 2); g.fill(); }
}

/** Bruit « whoosh » (son intégré aux overlays). */
function whoosh(sec, amp) {
  const n = Math.round(48000 * sec), b = new AudioBuffer({ length: n, sampleRate: 48000, numberOfChannels: 2 });
  let s = 12345;
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let k = 0; k < n; k++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[k] = amp * ((s / 0x7fffffff) * 2 - 1) * Math.sin(Math.PI * k / n); } }
  return b;
}

/** Overlay vidéo synthétique en MP4 (H.264, avec un son AAC si l'appareil sait l'encoder). */
export async function synthOverlay(kind, { audio = true } = {}) {
  const { W, H, FPS, FRAMES } = SYNTH;
  const cv = new OffscreenCanvas(W, H);
  const g = cv.getContext('2d');
  const target = new BufferTarget();
  const out = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const vs = new CanvasSource(cv, { codec: 'avc', bitrate: 4e6, keyFrameInterval: 1 });
  out.addVideoTrack(vs, { frameRate: FPS });
  let as = null;
  if (audio && kind !== 'subscribe-mute') {
    try { if (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }).then((r) => r.supported)) { as = new AudioBufferSource({ codec: 'aac', bitrate: 128000 }); out.addAudioTrack(as); } } catch { /* sans son */ }
  }
  await out.start();
  for (let i = 0; i < FRAMES; i++) { drawFrame(g, kind, i); await vs.add(i / FPS, 1 / FPS); }
  if (as) await as.add(whoosh(FRAMES / FPS, 0.9));
  await out.finalize();
  return new File([target.buffer], `${kind === 'opening' ? 'ouverture-explosion' : kind === 'subscribe' ? 'abonne-toi' : 'transition'}-synth.mp4`, { type: 'video/mp4' });
}

/** Logo PNG transparent 240×120. */
export async function synthLogo() {
  const cv = new OffscreenCanvas(240, 120), g = cv.getContext('2d');
  g.fillStyle = '#ffffff'; g.font = '800 64px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('LOGO', 120, 62);
  return new File([await cv.convertToBlob({ type: 'image/png' })], 'logo-synth.png', { type: 'image/png' });
}

function tone(sec, f, amp, decay) {
  const n = Math.round(48000 * sec), x = new Float32Array(n);
  for (let k = 0; k < n; k++) x[k] = amp * Math.sin(2 * Math.PI * f * k / 48000) * Math.exp(-k / (48000 * decay));
  return x;
}
/** Sons : click (2 kHz), pop (520 Hz), musique 8 s avec un passage +12 dB entre 4 et 5 s. */
export function synthSounds() {
  const music = new Float32Array(48000 * 8);
  for (let k = 0; k < music.length; k++) { const t = k / 48000; music[k] = 0.08 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277 * t) + Math.sin(2 * Math.PI * 330 * t)) * (t >= 4 && t < 5 ? 4 : 1); }
  const wav = (x, name) => new File([encodeWav([x], 48000, 16)], name, { type: 'audio/wav' });
  return [wav(tone(0.08, 2000, 0.9, 0.015), 'click-synth.wav'), wav(tone(0.18, 520, 0.9, 0.05), 'pop-synth.wav'), wav(music, 'musique-synth.wav')];
}
