// Audio : décodage (Mediabunny), mixage (OfflineAudioContext), mesures de crêtes relatives à la voix.
import { AudioBufferSink } from '../vendor/mediabunny.min.mjs';

export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

export function peakLin(buffer, from = 0, to = buffer.length) {
  let p = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = from; i < to && i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a; }
  }
  return p;
}
export const peakDb = (buffer, from, to) => linToDb(peakLin(buffer, from, to));

// Décode [start, end) d'une piste audio en UN AudioBuffer (au taux natif de la piste).
export async function decodeAudio(audioTrack, start, end) {
  const sink = new AudioBufferSink(audioTrack);
  const parts = [];
  for await (const wb of sink.buffers(start, end)) parts.push(wb);
  if (!parts.length) return null;
  const rate = parts[0].buffer.sampleRate;
  const ch = parts[0].buffer.numberOfChannels;
  const first = parts[0].timestamp;
  const total = Math.round(((parts[parts.length - 1].timestamp + parts[parts.length - 1].duration) - first) * rate);
  const out = new AudioBuffer({ length: Math.max(1, total), sampleRate: rate, numberOfChannels: ch });
  for (const p of parts) {
    const offset = Math.round((p.timestamp - first) * rate);
    for (let c = 0; c < ch; c++) {
      const src = p.buffer.getChannelData(Math.min(c, p.buffer.numberOfChannels - 1));
      const room = out.length - offset;
      if (room > 0) out.getChannelData(c).set(room >= src.length ? src : src.subarray(0, room), Math.max(0, offset));
    }
  }
  return { buffer: out, startTimestamp: first };
}

function envelopeBuffer(rate, freq, seconds, decay, amp) {
  const n = Math.round(rate * seconds);
  const b = new AudioBuffer({ length: n, sampleRate: rate, numberOfChannels: 1 });
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate) * Math.exp(-i / (rate * decay));
  return b;
}
export const makeClick = (rate) => envelopeBuffer(rate, 1900, 0.08, 0.015, 0.9);
export const makePop = (rate) => envelopeBuffer(rate, 520, 0.18, 0.05, 0.9);

// Voix de test synthétique (quand aucun fichier de voix n'est fourni).
export function makeTestVoice(rate, seconds) {
  const n = Math.round(rate * seconds);
  const b = new AudioBuffer({ length: n, sampleRate: rate, numberOfChannels: 1 });
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const gate = Math.sin(2 * Math.PI * 2.2 * t) > -0.3 ? 1 : 0.0;
    d[i] = 0.5 * gate * Math.sin(2 * Math.PI * (140 + 40 * Math.sin(t * 3)) * t);
  }
  return b;
}

// Mixage. Aucune couche ne couvre la voix : chaque couche est plafonnée par rapport à la crête de la voix.
// spec = { duration, rate, voice:{buffer, gainDb}, layers:[{name, buffer, at, srcOffset, srcDuration, gainDb, capDb, fadeOut}] }
export async function mixProject(spec) {
  const rate = spec.rate || 48000;
  const length = Math.ceil(spec.duration * rate);
  const ctx = new OfflineAudioContext(2, length, rate);
  const report = { rate, stems: [] };

  const voiceGain = dbToLin(spec.voice.gainDb);
  const voicePeakDb = peakDb(spec.voice.buffer) + spec.voice.gainDb;
  report.voicePeakDb = voicePeakDb;

  const add = (name, buffer, at, gainLin, srcOffset = 0, srcDuration, fadeOutSec) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gainLin;
    if (fadeOutSec) {
      const end = Math.min(spec.duration, at + (srcDuration ?? buffer.duration - srcOffset));
      g.gain.setValueAtTime(gainLin, Math.max(0, end - fadeOutSec));
      g.gain.linearRampToValueAtTime(0, end);
    }
    src.connect(g).connect(ctx.destination);
    if (srcDuration !== undefined) src.start(at, srcOffset, srcDuration); else src.start(at, srcOffset);
  };

  add('voix', spec.voice.buffer, 0, voiceGain, 0, Math.min(spec.voice.buffer.duration, spec.duration));
  report.stems.push({ name: 'voix', peakDb: voicePeakDb, relToVoiceDb: 0, gainDb: spec.voice.gainDb });

  for (const L of spec.layers) {
    const fromS = Math.round(L.srcOffset * L.buffer.sampleRate);
    const toS = L.srcDuration !== undefined ? fromS + Math.round(L.srcDuration * L.buffer.sampleRate) : L.buffer.length;
    const rawPeakDb = peakDb(L.buffer, fromS, toS);
    let gainDb = L.gainDb;
    let capped = false;
    if (L.capDb !== undefined) {
      // plafond : crête <= crête de la voix - capDb ; on BAISSE seulement, jamais on n'augmente
      const maxGain = (voicePeakDb - L.capDb) - rawPeakDb;
      if (gainDb > maxGain) { gainDb = maxGain; capped = true; }
    }
    add(L.name, L.buffer, L.at, dbToLin(gainDb), L.srcOffset, L.srcDuration, L.fadeOut);
    report.stems.push({ name: L.name, peakDb: rawPeakDb + gainDb, relToVoiceDb: rawPeakDb + gainDb - voicePeakDb, gainDb, capped });
  }

  const rendered = await ctx.startRendering();
  // Sécurité : crête max -1 dBFS (mise à l'échelle globale ; vrai limiteur = phase 4).
  const finalPeak = peakDb(rendered);
  report.finalPeakDbBefore = finalPeak;
  if (finalPeak > -1) {
    const k = dbToLin(-1 - finalPeak);
    for (let c = 0; c < rendered.numberOfChannels; c++) {
      const d = rendered.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
    report.safetyScaledDb = -1 - finalPeak;
  }
  report.finalPeakDb = peakDb(rendered);
  return { buffer: rendered, report };
}
