// Analyse d'un élément de marque, une seule fois puis mémorisée dans le manifeste (brand.json, sur l'appareil) :
// vidéo → fps, nombre d'images exact, méthode de retrait de fond (noir / vert / alpha), couverture image par image
// (fenêtre de couverture totale, image de coupe, première image visible, passage sous 60 %) ; image → dimensions et
// transparence ; son → durée, crête et sonie.
import { Input, ALL_FORMATS, BlobSource, CanvasSink, EncodedPacketSink } from '../vendor/mediabunny.min.mjs';
import { detectBackground, coverage, coverWindow } from '../render/keying.js';
import { brandFile, updateAsset } from './brand.js';
import { decodeAudio } from '../lib/audio.js';
import { measureLoudness, truePeak } from '../audio/loudness.js';

export const ANALYSIS_VERSION = 1;
const AW = 54, AH = 96;   // taille d'analyse (9:16)

/** @param {Blob} blob @param {string} name */
async function analyzeVideo(blob, name) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const atrack = await input.getPrimaryAudioTrack();
  if (!track) throw new Error(`« ${name} » : aucune piste vidéo`);
  let alpha = false;
  try { alpha = await track.canBeTransparent(); } catch { /* ancienne version */ }
  // Nombre d'images exact (paquets) et fps.
  let frames = 0;
  for await (const p of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) { if (p) frames++; }
  const duration = await track.computeDuration();
  const fpsRaw = frames / Math.max(1e-6, duration);
  const fps = [24, 25, 30, 50, 60].find((f) => Math.abs(f - fpsRaw) < 0.6) || Math.round(fpsRaw * 100) / 100;
  // Couverture image par image (petite taille), un seul passage du décodeur.
  const sink = new CanvasSink(track, { width: AW, height: AH, fit: 'fill', poolSize: 0, alpha });
  const ctx = new OffscreenCanvas(AW, AH).getContext('2d', { willReadFrequently: true });
  const imgs = [];
  for await (const wc of sink.canvases()) {
    ctx.clearRect(0, 0, AW, AH);
    ctx.drawImage(wc.canvas, 0, 0);
    imgs.push(ctx.getImageData(0, 0, AW, AH));
  }
  const probe = [imgs[0], imgs[Math.floor(imgs.length / 2)], imgs[imgs.length - 1]].filter(Boolean);
  // Le fond se juge sur les images où il est le plus visible (début et fin d'une transition).
  /** @type {any} */
  const keying = alpha ? { method: 'alpha', why: 'canal alpha présent' } : detectBackground(probe);
  const cov = imgs.map((im) => coverage(im.data, AW, AH, keying));
  const analysis = { ...coverWindow(cov), coverage: cov.map((c) => +c.full.toFixed(3)) };
  return {
    fps, frames: imgs.length || frames, duration, width: track.displayWidth, height: track.displayHeight,
    hasAudio: !!atrack, keying: { method: keying.method, ...(keying.color ? { color: keying.color } : {}) }, keyingWhy: keying.why, analysis,
  };
}

async function analyzeImage(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(Math.min(128, bmp.width), Math.min(128, bmp.height));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const k = detectBackground([g.getImageData(0, 0, c.width, c.height)]);
  const out = { image: true, fps: 30, frames: 1, duration: 0, width: bmp.width, height: bmp.height, hasAudio: false, keying: { method: k.method === 'alpha' ? 'alpha' : 'none' }, keyingWhy: k.method === 'alpha' ? k.why : 'image opaque posée telle quelle', analysis: { frames: 1, firstVisible: 0, lastVisible: 0, fullStart: -1, fullEnd: -1, cutFrame: -1, windowFrames: 0, below60: -1 } };
  bmp.close();
  return out;
}

async function analyzeSound(blob, name) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error(`« ${name} » : aucune piste audio`);
  const dec = await decodeAudio(track, 0, Infinity);
  if (!dec) throw new Error(`« ${name} » : audio illisible`);
  const ch = Array.from({ length: dec.buffer.numberOfChannels }, (_, i) => dec.buffer.getChannelData(i));
  const L = measureLoudness(ch, dec.buffer.sampleRate);
  const tp = Math.max(...ch.map((c) => truePeak(c, dec.buffer.sampleRate).dBTP));
  return { duration: dec.buffer.duration, rate: dec.buffer.sampleRate, lufs: +L.integrated.toFixed(1), truePeakDb: +tp.toFixed(1) };
}

/**
 * Analyse (si besoin) et mémorise. Retourne l'élément complété.
 * @param {import('./brand.js').BrandAsset & Record<string, any>} asset
 */
export async function ensureAnalyzed(asset, { force = false } = {}) {
  if (!force && asset.analyzed === ANALYSIS_VERSION) return asset;
  const blob = await brandFile(asset.file);
  let r;
  if (asset.kind === 'sfx' || asset.kind === 'music') r = await analyzeSound(blob, asset.name);
  else if (/\.(png|jpe?g|webp|gif)$/i.test(asset.file)) r = await analyzeImage(blob);
  else r = await analyzeVideo(blob, asset.name);
  const patch = { ...r, analyzed: ANALYSIS_VERSION };
  // Un réglage manuel du retrait de fond est conservé.
  if (asset.keying && asset.keyingManual) delete patch.keying;
  await updateAsset(asset.id, patch);
  return { ...asset, ...patch };
}
