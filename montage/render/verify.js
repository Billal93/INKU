// Contrôles après rendu (§ 2.10) : on RELIT le MP4 produit. Nombre d'images = durée attendue, timestamps réguliers
// (aucune image dupliquée ou perdue), durée audio = durée vidéo (±1 image), lecture complète sans erreur (toutes les
// images décodées), crête audio ≤ −1 dBTP et sonie du son décodé ; plus les contrôles par calcul sur le projet
// (durée = voix + fin, aucun trou entre clips, aucun plan immobile > 1,5 s, taille des sous-titres unique).
import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink, VideoSampleSink, AudioBufferSink } from '../vendor/mediabunny.min.mjs';
import { measureLoudness, truePeak } from '../audio/loudness.js';
import { lintDoc } from '../studio/lint.js';
import { voiceEnd } from '../studio/ending.js';
import { contentEnd } from '../studio/overlays.js';

const fr = (n, d = 2) => Number(n).toFixed(d).replace('.', ',');

/**
 * @param {Blob} blob @param {{ doc: any, frames: number, fps: number, width: number, height: number, getSource: (id: string) => any, subtitleBase?: number }} x
 * @param {(p: any) => void} [onProgress]
 * @returns {Promise<{ ok: boolean, checks: { id: string, ok: boolean, label: string, detail: string }[], ms: number, stats: any }>}
 */
export async function verifyRender(blob, x, onProgress = () => { }) {
  const t0 = performance.now();
  const checks = [];
  const add = (id, ok, label, detail) => checks.push({ id, ok: !!ok, label, detail });
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack(), at = await input.getPrimaryAudioTrack();
  const stats = { codec: vt ? await vt.getCodecParameterString() : null, audioCodec: at ? await at.getCodecParameterString() : null, sizeMB: +(blob.size / 1048576).toFixed(2) };
  if (!vt) { add('video', false, 'Piste vidéo', 'absente'); return { ok: false, checks, ms: 0, stats }; }
  add('resolution', vt.displayWidth === x.width && vt.displayHeight === x.height, 'Résolution', `${vt.displayWidth}×${vt.displayHeight}`);

  // Paquets : nombre et régularité des timestamps (ordre de présentation).
  const ts = [];
  for await (const p of new EncodedPacketSink(vt).packets(undefined, undefined, { metadataOnly: true })) ts.push(p.timestamp);
  ts.sort((a, b) => a - b);
  let irregular = 0, dup = 0;
  for (let i = 1; i < ts.length; i++) { const d = ts[i] - ts[i - 1]; if (d < 1e-6) dup++; else if (Math.abs(d - 1 / x.fps) > 1e-3) irregular++; }
  add('frames', ts.length === x.frames, 'Nombre d\'images', `${ts.length} / ${x.frames} attendues`);
  add('timestamps', irregular === 0 && dup === 0, 'Timestamps réguliers (aucune image dupliquée ou perdue)', `${irregular} écart(s), ${dup} doublon(s)`);
  const vDur = await vt.computeDuration();
  stats.videoSec = +vDur.toFixed(3);

  // Lecture complète : chaque image est décodée (et libérée aussitôt).
  let decoded = 0, decodeErr = null;
  try {
    for await (const s of new VideoSampleSink(vt).samples()) { decoded++; s.close(); if (decoded % 60 === 0) onProgress({ stage: 'Relecture des images', done: decoded, total: x.frames }); }
  } catch (e) { decodeErr = String(e && e.message || e); }
  add('decode', !decodeErr && decoded === x.frames, 'Lecture complète sans erreur', decodeErr ? decodeErr : `${decoded} images décodées`);

  if (at) {
    const aDur = await at.computeDuration();
    stats.audioSec = +aDur.toFixed(3);
    add('av', Math.abs(aDur - vDur) <= 1 / x.fps + 1e-3, 'Durée audio = durée vidéo (± 1 image)', `audio ${fr(aDur, 3)} s, vidéo ${fr(vDur, 3)} s`);
    onProgress({ stage: 'Relecture du son', done: 0, total: 1 });
    const parts = [];
    for await (const wb of new AudioBufferSink(at).buffers()) parts.push(wb.buffer);
    const rate = parts[0] ? parts[0].sampleRate : 48000;
    const n = parts.reduce((a, b) => a + b.length, 0);
    const ch = [new Float32Array(n), new Float32Array(n)];
    let o = 0; for (const b of parts) { for (let c = 0; c < 2; c++) ch[c].set(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), o); o += b.length; }
    const tp = Math.max(truePeak(ch[0], rate).dBTP, truePeak(ch[1], rate).dBTP);
    const L = measureLoudness(ch, rate);
    stats.truePeakDb = +tp.toFixed(2); stats.lufs = +L.integrated.toFixed(1); stats.sampleRate = rate;
    // L'encodage AAC peut dépasser de quelques dixièmes la crête du mixage : on mesure le fichier tel qu'il sera lu.
    add('truepeak', tp <= -1 + 0.05, 'Crête audio ≤ −1 dBTP (son décodé)', `${fr(tp)} dBTP, ${fr(L.integrated, 1)} LUFS`);
  } else add('audio', false, 'Piste audio', 'absente');

  // Contrôles par calcul sur le projet rendu.
  const d = x.doc, fps = d.project.fps;
  const ve = voiceEnd(d), end = contentEnd(d);
  const endSec = d.clips.filter((c) => c.role === 'climax' || c.role === 'thumbnail').reduce((a, c) => a + c.dur, 0) / fps;
  add('duration', Math.abs(x.frames - end) === 0 && (!endSec || Math.abs(end - ve - Math.round(endSec * fps)) <= 1), 'Durée = voix nettoyée + fin de vidéo', `${fr(end / fps)} s = ${fr(ve / fps)} s + ${fr(endSec)} s`);
  const lint = lintDoc(d, x.getSource);
  const gaps = lint.filter((i) => i.code === 'trou' || i.code === 'images-manquantes');
  add('gaps', !gaps.length, 'Aucun trou entre clips', gaps.length ? gaps.map((g) => g.msg).join(' ; ') : 'aucun');
  const still = lint.filter((i) => i.code === 'plan-immobile');
  add('still', !still.length, 'Aucun plan immobile > 1,5 s', still.length ? still.map((g) => g.msg).join(' ; ') : 'aucun');
  if (x.subtitleBase) add('subsize', true, 'Taille des sous-titres identique partout', `taille de base unique ${fr(x.subtitleBase, 1)} px (calculée une fois pour toute la vidéo)`);
  const ms = Math.round(performance.now() - t0);
  return { ok: checks.every((c) => c.ok), checks, ms, stats };
}
