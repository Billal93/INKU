// Détection de capacités RÉELLES (jamais par nom de navigateur).
import { canEncodeAudio } from '../vendor/mediabunny.min.mjs';

const H264_CANDIDATES = [
  { id: 'avc1.640028', label: 'High L4.0' },
  { id: 'avc1.64002A', label: 'High L4.2' },
  { id: 'avc1.4D0028', label: 'Main L4.0' },
  { id: 'avc1.42E01F', label: 'Baseline L3.1' },
];
const RESOLUTIONS = [
  { w: 1080, h: 1920 },
  { w: 720, h: 1280 },
  { w: 540, h: 960 },
];

async function testVideoEncoder(codec, w, h, hw) {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    const r = await VideoEncoder.isConfigSupported({
      codec, width: w, height: h, bitrate: 15_000_000, framerate: 30,
      hardwareAcceleration: hw,
    });
    return !!r.supported;
  } catch (e) { return false; }
}

export async function detectCapabilities() {
  const caps = {
    when: new Date().toISOString(),
    secureContext: window.isSecureContext,
    crossOriginIsolated: !!window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    videoEncoder: typeof VideoEncoder !== 'undefined',
    videoDecoder: typeof VideoDecoder !== 'undefined',
    audioEncoder: typeof AudioEncoder !== 'undefined',
    audioDecoder: typeof AudioDecoder !== 'undefined',
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    workers: typeof Worker !== 'undefined',
    webgl2: false,
    webgpu: !!navigator.gpu,
    opfs: !!(navigator.storage && navigator.storage.getDirectory),
    storagePersist: !!(navigator.storage && navigator.storage.persist),
    wakeLock: !!(navigator.wakeLock && navigator.wakeLock.request),
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    serviceWorker: 'serviceWorker' in navigator,
    deviceMemoryGB: navigator.deviceMemory || null,
    cores: navigator.hardwareConcurrency || null,
    h264: [],
    aacNative: false,
    maxResolution: null,
    hwH264: false,
  };

  try {
    const c = document.createElement('canvas');
    caps.webgl2 = !!c.getContext('webgl2');
  } catch (e) { /* webgl2 reste false */ }

  if (caps.videoEncoder) {
    for (const res of RESOLUTIONS) {
      for (const cand of H264_CANDIDATES) {
        const sw = await testVideoEncoder(cand.id, res.w, res.h, 'prefer-software');
        const hw = await testVideoEncoder(cand.id, res.w, res.h, 'prefer-hardware');
        if (sw || hw) {
          caps.h264.push({ res: res.w + 'x' + res.h, profile: cand.label, codec: cand.id, sw, hw });
          if (hw) caps.hwH264 = true;
        }
      }
      if (!caps.maxResolution && caps.h264.some(x => x.res === res.w + 'x' + res.h)) {
        caps.maxResolution = res;
      }
    }
  }

  try { caps.aacNative = await canEncodeAudio('aac'); } catch (e) { caps.aacNative = false; }

  // Niveau de repli (A = idéal, D = dernier recours)
  const has1080 = caps.maxResolution && caps.maxResolution.w === 1080;
  if (caps.videoEncoder && has1080 && caps.hwH264 && caps.webgl2 && caps.aacNative) caps.level = 'A';
  else if (caps.videoEncoder && caps.maxResolution && (caps.aacNative || caps.workers)) caps.level = 'B';
  else if (caps.workers && typeof WebAssembly !== 'undefined') caps.level = 'C';
  else caps.level = 'D';
  return caps;
}
