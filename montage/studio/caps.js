// Capacités du navigateur pour le Montage (détection RÉELLE des API, jamais par nom de navigateur).
// Cible (docs/decisions.md D15) : iPhone 17+ / iOS 26+ (Safari 26+), Chrome/Edge à jour, Safari 26+ sur Mac,
// Firefox 130+ en best-effort. En dessous : message clair, export de l'EDL sauvegardé, rien d'autre.

/**
 * @typedef {{ ok: boolean, missing: string[], warnings: string[] }} Support
 */

/** Vérification synchrone et bon marché, au démarrage. @returns {Support} */
export function checkSupport() {
  const missing = [], warnings = [];
  const g = /** @type {any} */ (globalThis);
  if (typeof g.VideoDecoder === 'undefined' || typeof g.VideoEncoder === 'undefined') missing.push('WebCodecs vidéo');
  if (typeof g.AudioDecoder === 'undefined') missing.push('WebCodecs audio');
  if (typeof Worker === 'undefined') missing.push('Web Workers');
  if (typeof OffscreenCanvas === 'undefined') missing.push('OffscreenCanvas');
  if (!(navigator.storage && navigator.storage.getDirectory)) missing.push('stockage OPFS');
  if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('importmap')) missing.push('import maps');
  if (typeof structuredClone !== 'function' || !Array.prototype.findLast) missing.push('JavaScript récent');
  let gl = false;
  try { gl = !!document.createElement('canvas').getContext('webgl2'); } catch { }
  if (!gl && !navigator.gpu) missing.push('WebGL2 ou WebGPU');
  if (typeof g.AudioEncoder === 'undefined') warnings.push('Pas d\'encodeur audio natif : export AAC par WebAssembly (plus lent).');
  if (!navigator.gpu) warnings.push('WebGPU absent : transcription et composition plus lentes (WebAssembly / WebGL2).');
  if (!window.crossOriginIsolated) warnings.push('Isolation cross-origin inactive : calcul WebAssembly sur un seul cœur.');
  return { ok: missing.length === 0, missing, warnings };
}

/** Détails coûteux (asynchrones) pour l'écran Autotest : codecs réellement acceptés, GPU, mémoire. */
export async function detectCapabilities() {
  const g = /** @type {any} */ (globalThis);
  const caps = {
    when: new Date().toISOString(),
    userAgent: navigator.userAgent,
    crossOriginIsolated: !!window.crossOriginIsolated,
    cores: navigator.hardwareConcurrency || null,
    deviceMemoryGB: navigator.deviceMemory || null,
    jsHeapLimitMB: performance.memory ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : null,
    webgpu: null,
    h264: /** @type {{res:string, codec:string, hw:boolean, sw:boolean}[]} */ ([]),
    aac: { native: false, sampleRates: /** @type {number[]} */ ([]), maxBitrate: 0 },
    wakeLock: !!(navigator.wakeLock && navigator.wakeLock.request),
    shareFiles: !!(navigator.canShare && (() => { try { return navigator.canShare({ files: [new File([''], 'a.mp4', { type: 'video/mp4' })] }); } catch { return false; } })()),
    persisted: navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null,
    quotaMB: null,
  };
  try { const e = await navigator.storage.estimate(); caps.quotaMB = Math.round((e.quota || 0) / 1048576); } catch { }
  if (navigator.gpu) {
    try {
      const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (a) {
        const info = /** @type {Partial<GPUAdapterInfo>} */ (a.info || {});
        caps.webgpu = {
          vendor: info.vendor || '', architecture: info.architecture || '', description: info.description || '',
          f16: a.features.has('shader-f16'),
          maxBufferSizeMB: Math.round(a.limits.maxBufferSize / 1048576),
          maxStorageBindingMB: Math.round(a.limits.maxStorageBufferBindingSize / 1048576),
        };
      }
    } catch (e) { caps.webgpu = { error: String(e && e.message || e) }; }
  }
  if (typeof g.VideoEncoder !== 'undefined') {
    for (const [w, h] of [[1080, 1920], [720, 1280], [540, 960]]) {
      for (const codec of ['avc1.640028', 'avc1.4D0028']) {
        const t = async (hw) => {
          try { return !!(await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate: 16e6, framerate: 30, hardwareAcceleration: hw })).supported; } catch { return false; }
        };
        const hw = await t('prefer-hardware'), sw = await t('prefer-software');
        if (hw || sw) { caps.h264.push({ res: `${w}x${h}`, codec, hw, sw }); break; }
      }
    }
  }
  // AAC : débit le plus élevé accepté (le brief demande 192 à 320 kb/s ; Windows plafonne à 192 kb/s).
  if (typeof g.AudioEncoder !== 'undefined') {
    for (const sampleRate of [48000, 44100]) {
      for (const bitrate of [320000, 256000, 192000, 160000, 128000]) {
        try {
          const r = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: 2, bitrate });
          if (r.supported) { caps.aac.native = true; caps.aac.sampleRates.push(sampleRate); caps.aac.maxBitrate = Math.max(caps.aac.maxBitrate || 0, bitrate); break; }
        } catch { }
      }
    }
  }
  return caps;
}
