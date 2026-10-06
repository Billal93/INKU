// Plan de mixage (fonction pure) : EDL → éléments du mixeur (montage/audio/mix.js). Même plan pour l'écoute dans le
// Studio et pour l'export. Les clips V1 (trailers) sont muets sauf l'audio du climax (piste A5), posé en continu.
import { contentEnd } from './overlays.js';

const TRACK_KIND = { A1: 'voice', A2: 'music', A3: 'sfx', A4: 'overlay', A5: 'trailer' };

/**
 * @param {any} doc
 * @returns {{ duration: number, items: { id: string, kind: string, ref: { srcId?: string, assetId?: string }, at: number, offset: number, dur: number, gainDb: number, fadeIn: number, fadeOut: number, loop: boolean, label: string }[] }}
 */
export function audioPlan(doc) {
  const fps = doc.project.fps;
  const end = contentEnd(doc);
  const solo = doc.tracks.some((t) => t.solo);
  const audible = (id) => { const t = doc.tracks.find((x) => x.id === id); return t && !t.muted && (!solo || t.solo); };
  const items = [];
  for (const c of doc.clips) {
    if (c.start >= end) continue;
    const dur = Math.min(c.dur, end - c.start);
    if (TRACK_KIND[c.track] && audible(c.track)) {
      const ref = c.assetId ? { assetId: c.assetId } : { srcId: c.srcId };
      if (!ref.assetId && !ref.srcId) continue;
      items.push({
        id: c.id, kind: TRACK_KIND[c.track], ref, at: c.start / fps, offset: c.srcIn || 0, dur: dur / fps,
        gainDb: c.gainDb || 0, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0, loop: !!c.loop, label: c.assetName || c.name || c.track,
      });
    } else if (c.track === 'V2' && c.assetId && c.audio && c.role !== 'logo' && audible('A4')) {
      // Son intégré à l'overlay : mixé tel quel, à partir de la même image que la vidéo (jamais décalé).
      items.push({
        id: c.id, kind: c.role === 'overlay' ? 'overlay' : c.role, ref: { assetId: c.assetId }, at: c.start / fps,
        offset: (c.srcFrame || 0) / (c.assetFps || 30), dur: dur / fps, gainDb: c.gainDb || 0, fadeIn: c.audioFadeIn || 0, fadeOut: 0, loop: false, label: c.assetName || c.role,
      });
    }
  }
  return { duration: end / fps, items };
}

/** Signature du plan (pour savoir si un mixage déjà calculé est encore valable). */
export function planKey(plan, opt = {}) { return JSON.stringify([plan, opt]); }
