// Rendu final (§ 2.10) : MÊME scène que l'aperçu (render/scene.js) mais à partir des fichiers ORIGINAUX, image par
// image (30 i/s constants, timestamps exacts k/30), un seul encodage avec perte à la fin (H.264 + AAC), écrit au fil de
// l'eau dans le stockage privé (mémoire bornée). Garde-fous : police de la marque obligatoire, repli de résolution
// (1080×1920 → 720×1280 → 540×960, toujours annoncé), écran maintenu allumé, arrêt si le rendu dépasse 3× la durée
// estimée, annulation à tout moment. Toutes les boucles sont bornées par le nombre d'images.
import { Output, Mp4OutputFormat, StreamTarget, BufferTarget, CanvasSource, AudioBufferSource, canEncodeVideo, canEncodeAudio } from '../vendor/mediabunny.min.mjs';
import { Compositor } from './compositor.js';
import { openMedia } from './frames.js';
import { contentEnd } from '../studio/overlays.js';
import { brandFile } from '../brand/brand.js';

export const RENDER_PRESETS = {
  final: { label: 'Final 1080×1920', height: 1920, bitrate: 16e6, audioBitrate: 320000 },
  draft: { label: 'Aperçu rapide 540×960', height: 960, bitrate: 4e6, audioBitrate: 128000 },
};
const LADDER = [1920, 1280, 960];

/** Plus haute résolution 9:16 encodable (H.264) ≤ `maxH`. */
export async function chooseResolution(maxH, bitrate) {
  for (const h of LADDER.filter((x) => x <= maxH)) {
    const w = Math.round((h * 9) / 16);
    try { if (await canEncodeVideo('avc', { width: w, height: h, bitrate: Math.min(bitrate, h >= 1920 ? 16e6 : 8e6) })) return { width: w, height: h, fallback: h !== maxH }; } catch { /* suivant */ }
  }
  return null;
}

/** Débit AAC le plus élevé accepté (192 à 320 kb/s visé) ; repli sur l'encodeur AAC embarqué (WASM) si besoin. */
async function aacConfig(wanted) {
  for (const b of [320000, 256000, 192000, 160000, 128000].filter((x) => x <= wanted)) {
    try { if (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: b })) return { bitrate: b, native: true }; } catch { /* suivant */ }
  }
  const { registerAacEncoder } = await import('../vendor/mediabunny-aac-encoder.min.mjs');
  registerAacEncoder();
  return { bitrate: Math.min(wanted, 192000), native: false };
}

class WakeLock {
  async on() {
    this.wanted = true;
    try { if (navigator.wakeLock) this.lock = await navigator.wakeLock.request('screen'); this.ok = !!this.lock; } catch { this.ok = false; }
    this.vis = async () => { if (this.wanted && document.visibilityState === 'visible' && navigator.wakeLock) { try { this.lock = await navigator.wakeLock.request('screen'); } catch { /* refusé */ } } };
    document.addEventListener('visibilitychange', this.vis);
    return this.ok;
  }
  off() { this.wanted = false; document.removeEventListener('visibilitychange', this.vis); try { if (this.lock) this.lock.release(); } catch { /* déjà relâché */ } }
}

/** Fichier de sortie dans le stockage privé (écriture en flux) ; repli en mémoire. */
async function openTarget(id) {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('renders', { create: true });
    const fh = await dir.getFileHandle(id + '.mp4', { create: true });
    if (typeof fh.createWritable === 'function') {
      const writable = await fh.createWritable();
      return { target: new StreamTarget(writable, { chunked: true }), kind: 'opfs', fh, writable };
    }
  } catch { /* mémoire */ }
  return { target: new BufferTarget(), kind: 'memory' };
}

/**
 * @param {{ doc: any, lib: any, assets: any, scene: import('./scene.js').Scene, mixer: any, preset?: 'final'|'draft',
 *   signal?: AbortSignal, onProgress?: (p: any) => void, canvas?: HTMLCanvasElement | OffscreenCanvas }} o
 * @returns {Promise<{ id: string, blob: Blob, width: number, height: number, frames: number, fps: number, ms: number, fallback: boolean, audio: any, wakeLock: boolean, target: string, mixReport: any }>}
 */
export async function renderProject(o) {
  const doc = JSON.parse(JSON.stringify(o.doc));          // instantané : l'édition continue sans changer le rendu
  const fps = doc.project.fps;
  const N = contentEnd(doc);
  const preset = RENDER_PRESETS[o.preset || 'final'];
  const prog = o.onProgress || (() => { });
  if (!N) throw new Error('La timeline est vide.');
  if (!o.scene.font.brand) throw new Error('Police de la marque absente ou non chargée : rendu bloqué (aucune police de secours silencieuse).');
  const res = await chooseResolution(preset.height, preset.bitrate);
  if (!res) throw new Error('Cet appareil ne sait encoder aucune résolution 9:16 en H.264.');
  const id = 'render-' + new Date().toISOString().replace(/[:.]/g, '-');
  const t0 = performance.now();
  const wake = new WakeLock();
  const wakeOk = await wake.on();
  const readers = new Map();     // clé → lecteur (un décodeur par fichier ouvert, fichiers originaux)
  const out = await openTarget(id);
  let output = null;
  try {
    prog({ stage: 'Mixage du son', done: 0, total: N });
    const mix = await o.mixer.mix(doc);
    const aac = await aacConfig(preset.audioBitrate);

    const canvas = o.canvas || new OffscreenCanvas(res.width, res.height);
    const comp = new Compositor(/** @type {any} */ (canvas), res.width, res.height);
    output = new Output({ format: new Mp4OutputFormat({ fastStart: out.kind === 'memory' ? 'in-memory' : false }), target: out.target });
    const video = new CanvasSource(/** @type {any} */ (canvas), { codec: 'avc', bitrate: res.height >= 1920 ? preset.bitrate : Math.min(preset.bitrate, 8e6), keyFrameInterval: 1, latencyMode: 'quality' });
    output.addVideoTrack(video, { frameRate: fps });
    const audio = new AudioBufferSource({ codec: 'aac', bitrate: aac.bitrate });
    output.addAudioTrack(audio);
    await output.start();

    // Son ajouté par tranches d'une seconde au fil de la vidéo (multiplexage entrelacé, mémoire bornée).
    const total = mix.channels[0].length;
    let audioPos = 0;
    const pushAudio = async (untilSec) => {
      const until = Math.min(total, Math.round(untilSec * 48000));
      while (audioPos < until) {
        const n = Math.min(48000, until - audioPos);
        const b = new AudioBuffer({ length: n, sampleRate: 48000, numberOfChannels: 2 });
        b.copyToChannel(/** @type {any} */ (mix.channels[0].subarray(audioPos, audioPos + n)), 0);
        b.copyToChannel(/** @type {any} */ (mix.channels[1].subarray(audioPos, audioPos + n)), 1);
        await audio.add(b);
        audioPos += n;
      }
    };

    const reader = async (key, open) => { if (!readers.has(key)) readers.set(key, await open()); return readers.get(key); };
    const tStart = performance.now();
    let guardMs = Infinity;
    for (let f = 0; f < N; f++) {
      if (o.signal && o.signal.aborted) throw new DOMException('Rendu annulé', 'AbortError');
      const need = o.scene.needs(doc, f);
      let bg = null;
      if (need.bg) {
        const rec = o.lib.get(need.bg.srcId);
        const r = rec && await reader('s:' + rec.id, async () => (await openMedia(await o.lib.getFile(rec.id, 'media'), rec.name)).reader);
        const cv = r ? await r.at(need.bg.t) : null;
        if (cv) bg = { canvas: cv, usable: rec.letterbox.usable, src: rec, toCanvas: (x) => x };
      }
      const ov = new Map();
      for (const x of need.overlays) {
        const a = o.assets.get(x.assetId);
        const r = a && await reader('a:' + x.assetId, async () => (await openMedia(await brandFile(a.file), a.file, { alpha: !!(a.keying && a.keying.method === 'alpha') })).reader);
        const cv = r ? await r.at(x.t) : null;
        if (cv) ov.set(x.clip.id, cv);
      }
      o.scene.draw(comp, doc, f, { bg, overlays: ov });
      await video.add(f / fps, 1 / fps);
      if (f % fps === fps - 1) await pushAudio((f + 1) / fps + 1);
      // Garde-fou : estimation après 2 s de vidéo rendues, arrêt au-delà de 3× (jamais de rendu sans fin).
      if (f === 2 * fps) guardMs = Math.max(60000, 3 * ((performance.now() - tStart) / (f + 1)) * N);
      if (performance.now() - tStart > guardMs) throw new Error(`Rendu arrêté : plus de 3 fois la durée estimée (${Math.round(guardMs / 3000)} s).`);
      if (f % 5 === 0 || f === N - 1) {
        const el = performance.now() - tStart, per = el / (f + 1);
        prog({ stage: 'Rendu des images', done: f + 1, total: N, etaSec: Math.round(((N - f - 1) * per) / 1000), fps: +(1000 / per).toFixed(1), hidden: document.visibilityState === 'hidden' });
      }
    }
    await pushAudio(N / fps);
    prog({ stage: 'Finalisation du fichier', done: N, total: N });
    await output.finalize();
    comp.destroy();
    const blob = out.kind === 'memory' ? new Blob([/** @type {BufferTarget} */ (out.target).buffer], { type: 'video/mp4' }) : await out.fh.getFile();
    return { id, blob, width: res.width, height: res.height, frames: N, fps, ms: Math.round(performance.now() - t0), fallback: res.fallback, audio: aac, wakeLock: wakeOk, target: out.kind, mixReport: mix.report };
  } catch (e) {
    if (output && output.state !== 'finalized') { try { await output.cancel(); } catch { /* déjà fermé */ } }
    if (out.kind === 'opfs') { try { const root = await navigator.storage.getDirectory(); await (await root.getDirectoryHandle('renders')).removeEntry(id + '.mp4'); } catch { /* absent */ } }
    throw e;
  } finally {
    wake.off();
    for (const r of readers.values()) { try { await r.close(); } catch { /* fermé */ } }
  }
}
