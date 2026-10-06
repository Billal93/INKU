// Transitions, ouverture, abonne-toi, logo, SFX : placement À L'IMAGE PRÈS et contrôles (§ 2.4, 2.5, 2.7).
// Fonctions pures sur l'EDL : (doc, asset analysé) → clip(s) + avertissements. Rien n'est imposé : le Studio propose
// et l'utilisateur valide (annuler possible). Un overlay n'est JAMAIS accéléré ni ralenti : image k du projet =
// image frameMap(k) du fichier ; toute boucle est bornée à la fin de la vidéo.
import { makeClip, clipEnd } from './edl.js';
import { frameMap } from '../render/keying.js';
import { histDistance } from './framing.js';

/**
 * @typedef {{ id: string, kind: string, name: string, fps: number, frames: number, width: number, height: number,
 *   hasAudio: boolean, image?: boolean, keying: { method: 'luma'|'chroma'|'alpha'|'none', lo?: number, hi?: number, color?: number[] },
 *   analysis: ReturnType<typeof import('../render/keying.js').coverWindow> }} OverlayAsset
 */

export const ROLE_Z = { transition: 1, opening: 2, logo: 3, subscribe: 4, overlay: 4 };
export const MIN_VISIBLE_SEC = 1, TRANSITION_GAP_SEC = 8, NEIGHBOR_SEC = 10, WORD_LEAD_FRAMES = 2;
export const SFX_SPACING_SEC = 0.4;

/** Fin du contenu (voix, clips, sous-titres, fin de vidéo) : durée de la vidéo. Les overlays n'allongent jamais. */
export function contentEnd(doc) {
  let m = 0;
  for (const c of doc.clips) if (c.track === 'V1' || c.track === 'A1' || c.track === 'T1' || c.track === 'A5') m = Math.max(m, clipEnd(c));
  return m;
}

/** Image de l'overlay affichée à l'image `frame` du projet (−1 = rien). Boucle bornée à la fin de la vidéo. */
export function overlayFrameAt(clip, frame, end) {
  if (frame < clip.start || frame >= clipEnd(clip) || frame >= end) return -1;
  if (clip.still) return 0;   // image fixe (logo PNG)
  const fm = frameMap(clip.assetFps || 30, 30);
  const k = frame - clip.start;
  const n = clip.assetFrames || Infinity;
  let i = (clip.srcFrame || 0) + fm.toAsset(k);
  if (clip.loop && Number.isFinite(n)) i = i % n;
  return i < n ? i : -1;
}

/** Fenêtre de couverture totale de l'overlay en images du projet, relative au début du clip. */
function coverInProject(asset, srcFrame = 0) {
  const a = asset.analysis;
  if (!a || a.fullStart < 0) return null;
  const fm = frameMap(asset.fps, 30);
  const s = fm.toProject(a.fullStart - srcFrame), e = fm.toProjectEnd(a.fullEnd - srcFrame);
  return e >= s ? [s, e] : null;
}

function baseOverlay(asset, role, fields) {
  const clip = makeClip({
    track: 'V2', role, assetId: asset.id, assetName: asset.name, assetFps: asset.fps, assetFrames: asset.frames,
    srcFrame: 0, keying: { ...asset.keying }, loop: false, gainDb: 0, audio: !!asset.hasAudio, still: !!asset.image, ...fields,
  });
  delete clip.crop; delete clip.srcId; delete clip.srcIn;
  return clip;
}

const v1 = (doc) => doc.clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start);

/**
 * Ouverture : la PREMIÈRE image de la vidéo est l'image de couverture totale ; le fichier est coupé à l'image près
 * (fondu audio de 5 ms si le son est coupé net). Les sous-titres attendent que la couverture passe sous 60 %.
 * @param {any} doc @param {OverlayAsset} asset
 */
export function placeOpening(doc, asset) {
  const a = asset.analysis;
  const warnings = [];
  const srcFrame = a && a.fullStart >= 0 ? a.fullStart : 0;
  if (!a || a.fullStart < 0) warnings.push(`« ${asset.name} » ne couvre jamais tout l'écran : posé depuis sa première image.`);
  const fm = frameMap(asset.fps, 30);
  const dur = fm.toProject(asset.frames - srcFrame);
  const subsFrom = a && a.below60 >= 0 ? fm.toProject(a.below60 - srcFrame) : 0;
  const clip = baseOverlay(asset, 'opening', { start: 0, dur, srcFrame, subsFrom, audioFadeIn: srcFrame > 0 ? 0.005 : 0, cover: coverInProject(asset, srcFrame) });
  return { clip, warnings };
}

/** Image de fin d'affichage des sous-titres masqués par l'ouverture (premier sous-titre après 60 % de découverte). */
export function subtitlesHiddenUntil(doc) {
  const op = doc.clips.find((c) => c.track === 'V2' && c.role === 'opening');
  return op ? op.start + (op.subsFrom || 0) : 0;
}

/**
 * Transition sur la coupe `cutFrame` : la coupe tombe sur l'image du MILIEU de la fenêtre de couverture totale.
 * Début = coupe − position de la couverture dans le fichier. Pendant la couverture, le calque est opaque.
 * @param {any} doc @param {OverlayAsset} asset @param {number} cutFrame
 */
export function placeTransition(doc, asset, cutFrame) {
  const cover = coverInProject(asset);
  const fm = frameMap(asset.fps, 30);
  const dur = fm.toProject(asset.frames);
  if (!cover) {
    return { clip: null, errors: [`« ${asset.name} » n'a aucune image qui couvre tout l'écran : impossible de caler une coupe dessous.`], warnings: [] };
  }
  const mid = Math.floor((cover[0] + cover[1]) / 2);
  const clip = baseOverlay(asset, 'transition', { start: cutFrame - mid, dur, cover, cut: cutFrame });
  return { clip, errors: [], warnings: [] };
}

/**
 * Contrôles d'une transition posée (pures, sur l'EDL) : coupe dans la couverture, plans avant/après visibles ≥ 1 s,
 * pas de chevauchement avec l'ouverture, écart ≥ 8 s avec une autre transition, plans avant/après nettement
 * différents (histogramme + passages voisins du même trailer < 10 s).
 * @param {any} doc @param {any} clip @param {{ getSource?: (id: string) => any }} [ctx]
 * @returns {{ code: string, level: 'err'|'warn', msg: string, fix?: string }[]}
 */
export function checkTransition(doc, clip, ctx = {}) {
  const out = [];
  const fps = doc.project.fps;
  const sec = (f) => (f / fps).toFixed(1).replace('.', ',');
  const cut = clip.cut ?? (clip.cover ? clip.start + Math.floor((clip.cover[0] + clip.cover[1]) / 2) : null);
  if (!clip.cover || cut === null) { out.push({ code: 'transition-sans-couverture', level: 'err', msg: 'Transition sans image de couverture totale.' }); return out; }
  const c0 = clip.start + clip.cover[0], c1 = clip.start + clip.cover[1];
  const clips = v1(doc);
  const A = clips.find((c) => clipEnd(c) === cut), B = clips.find((c) => c.start === cut);
  if (!A || !B) {
    const real = clips.map((c) => clipEnd(c)).filter((f) => f >= c0 && f <= c1 + 1);
    if (real.length) out.push({ code: 'transition-decalee', level: 'warn', msg: `La coupe des clips (${sec(real[0])} s) n'est pas au milieu de la couverture (${sec(cut)} s).`, fix: 'realign-transition' });
    else out.push({ code: 'transition-sans-coupe', level: 'err', msg: `Aucune coupe entre deux clips sous la transition (couverture ${sec(c0)}–${sec(c1 + 1)} s).`, fix: 'realign-transition' });
  }
  if (A && c0 - A.start < MIN_VISIBLE_SEC * fps) out.push({ code: 'transition-avant-court', level: 'warn', msg: `Le plan avant la transition n'est visible que ${sec(Math.max(0, c0 - A.start))} s (minimum 1 s).` });
  if (B && clipEnd(B) - (c1 + 1) < MIN_VISIBLE_SEC * fps) out.push({ code: 'transition-apres-court', level: 'warn', msg: `Le plan après la transition n'est visible que ${sec(Math.max(0, clipEnd(B) - c1 - 1))} s (minimum 1 s).` });
  const op = doc.clips.find((c) => c.track === 'V2' && c.role === 'opening');
  if (op && clip.start < clipEnd(op)) out.push({ code: 'transition-ouverture', level: 'err', msg: 'La transition chevauche l\'ouverture.', fix: 'remove-overlay' });
  const others = doc.clips.filter((c) => c.track === 'V2' && c.role === 'transition' && c.id !== clip.id && c.cut !== undefined);
  const near = others.find((o) => Math.abs(o.cut - cut) < TRANSITION_GAP_SEC * fps && o.cut < cut);
  if (near) out.push({ code: 'transitions-proches', level: 'warn', msg: `Deux transitions à ${sec(Math.abs(cut - near.cut))} s d'écart (moins de 8 s) : celle-ci peut devenir une coupe franche.`, fix: 'remove-overlay' });
  if (A && B && ctx.getSource) {
    const sa = ctx.getSource(A.srcId), sb = ctx.getSource(B.srcId);
    const tA = A.srcIn + A.dur / fps, tB = B.srcIn;
    if (A.srcId === B.srcId && Math.abs(tB - tA) < NEIGHBOR_SEC) out.push({ code: 'transition-plans-voisins', level: 'warn', msg: `Plans avant/après tirés de passages voisins du même trailer (${Math.abs(tB - tA).toFixed(1).replace('.', ',')} s d'écart) : la transition ne marquera pas de changement.` });
    const shotAt = (s, t) => (s && s.shots || []).find((x) => t >= x.start - 1e-3 && t < x.end + 1e-3);
    const ha = shotAt(sa, Math.max(0, tA - 0.05)), hb = shotAt(sb, tB);
    const d = histDistance(ha && ha.hist, hb && hb.hist);
    if (d !== null) {
      const dl = Math.abs((ha.luma ?? 0) - (hb.luma ?? 0));
      if (d < 0.35 && dl < 0.12) out.push({ code: 'transition-plans-semblables', level: 'warn', msg: `Plans avant/après trop semblables (écart de couleurs ${d.toFixed(2)}, de luminosité ${(dl * 100).toFixed(0)} %) : choisissez un plan nettement différent.` });
    }
  }
  return out;
}

/** Recale une transition sur la coupe la plus proche de sa couverture (après déplacement des clips). */
export function realignTransition(doc, clip) {
  const mid = Math.floor((clip.cover[0] + clip.cover[1]) / 2);
  const want = clip.start + mid;
  const cuts = v1(doc).slice(1).map((c) => c.start);
  if (!cuts.length) return false;
  const best = cuts.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
  clip.cut = best; clip.start = best - mid;
  return true;
}

/** Mots de la voix (T1) avec leur image de début sur la timeline. */
export function timelineWords(doc) {
  const fps = doc.project.fps;
  const out = [];
  for (const c of doc.clips.filter((x) => x.track === 'T1' && x.sub).sort((a, b) => a.start - b.start)) {
    c.sub.words.forEach((w, k) => out.push({ w: w.w, frame: w.t0 !== undefined ? Math.round(w.t0 * fps) : c.start, sentence: c.sub.sentence, clipId: c.id, k }));
  }
  return out;
}

const norm = (w) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9-]/g, '');
/** Premier mot « abonne » (abonne, abonne-toi, abonnez-vous, abonnes…). */
export function findSubscribeWord(doc) {
  return timelineWords(doc).find((w) => /^abonn(e|ez|es)?(-|$)/.test(norm(w.w))) || null;
}

/**
 * Abonne-toi : la partie VISIBLE de l'animation commence PILE au début du mot « abonne » (première occurrence).
 * @param {any} doc @param {OverlayAsset} asset
 */
export function placeSubscribe(doc, asset) {
  const w = findSubscribeWord(doc);
  if (!w) return { clip: null, warnings: ['Le mot « abonne » n\'est jamais prononcé : l\'animation abonne-toi n\'a pas été ajoutée.'] };
  const fm = frameMap(asset.fps, 30);
  const vis = Math.max(0, asset.analysis ? asset.analysis.firstVisible : 0);
  const visP = fm.toProject(vis);
  let start = w.frame - visP, srcFrame = 0;
  if (start < 0) { srcFrame = fm.toAsset(-start); start = 0; }
  const dur = fm.toProject(asset.frames - srcFrame);
  const clip = baseOverlay(asset, 'subscribe', { start, dur, srcFrame, word: w.w, wordFrame: w.frame });
  return { clip, warnings: [] };
}

/**
 * Logo : du début à la fin, coupé à la durée exacte de la vidéo (ou bouclé proprement), son ignoré.
 * Image fixe (PNG) : posée en haut à droite dans la marge de sécurité TikTok.
 */
export function placeLogo(doc, asset) {
  const end = contentEnd(doc);
  const fm = frameMap(asset.fps || 30, 30);
  const own = asset.image ? Infinity : fm.toProject(asset.frames);
  const clip = baseOverlay(asset, 'logo', { start: 0, dur: Math.max(1, end), loop: !asset.image && own < end, audio: false });
  if (asset.image || asset.width / asset.height > 0.6 || asset.width / asset.height < 0.5) clip.place = logoBox(asset);
  return { clip, warnings: [] };
}

/** Boîte du logo (unités 1080×1920) : en haut à droite, marges de sécurité TikTok (≈ 60 px à droite, 140 px en haut). */
export function logoBox(asset, maxW = 220, maxH = 220) {
  const k = Math.min(maxW / asset.width, maxH / asset.height);
  const w = asset.width * k, h = asset.height * k;
  return { x: 1080 - 60 - w, y: 140, w, h };
}

/**
 * Boîte d'un overlay qui n'est pas en 9:16 : contenu entier, centré, jamais déformé.
 */
export function fitBox(w, h, W = 1080, H = 1920) {
  const k = Math.min(W / w, H / h);
  return { x: (W - w * k) / 2, y: (H - h * k) / 2, w: w * k, h: h * k };
}

/** Garde la longueur du logo et des overlays bouclés égale à la durée de la vidéo (après toute modification). */
export function boundLoops(doc) {
  const end = contentEnd(doc);
  for (const c of doc.clips) if (c.track === 'V2' && (c.role === 'logo' || c.loop)) { c.start = Math.min(c.start, Math.max(0, end - 1)); c.dur = Math.max(1, end - c.start); }
  for (const c of doc.clips) if (c.track === 'A2' && c.loop) c.dur = Math.max(1, end - c.start);
}

/**
 * SFX : un « click » sur chaque groupe contenant un mot important (jaune), un « pop » sur le texte impact, calés sur
 * l'image du pop (apparition du groupe). Espacement minimal 0,4 s : si deux mots importants se suivent de près, seul
 * le premier garde son son.
 * @param {any} doc @param {{ click?: OverlayAsset | null, pop?: OverlayAsset | null }} sfx
 */
export function sfxClips(doc, sfx) {
  const fps = doc.project.fps;
  const hideUntil = subtitlesHiddenUntil(doc);
  const evs = [];
  for (const c of doc.clips.filter((x) => x.track === 'T1' && x.sub).sort((a, b) => a.start - b.start)) {
    const kinds = new Set(c.sub.words.map((w) => w.kind));
    const role = kinds.has('impact') ? 'pop' : kinds.has('important') ? 'click' : null;
    if (role) evs.push({ frame: Math.max(c.start, hideUntil), role });
  }
  const kept = [], skipped = [];
  let last = -Infinity;
  for (const e of evs) { if (e.frame - last >= SFX_SPACING_SEC * fps - 1e-9) { kept.push(e); last = e.frame; } else skipped.push(e); }
  const clips = [];
  for (const e of kept) {
    const a = sfx[e.role] || sfx.click || sfx.pop;
    if (!a) continue;
    const dur = Math.max(1, Math.ceil(a.duration * fps));
    const clip = makeClip({ track: 'A3', role: 'sfx', sfx: e.role, assetId: a.id, assetName: a.name, start: e.frame, dur, srcIn: 0, gainDb: 0, auto: true });
    delete clip.crop; delete clip.srcId;
    clips.push(clip);
  }
  return { clips, skipped };
}

/**
 * Emplacements proposés pour une transition : début de chaque phrase (après la première), coupe ≈ 2 images AVANT le
 * premier mot. Retourne aussi la coupe V1 existante la plus proche.
 */
export function transitionSuggestions(doc) {
  const words = timelineWords(doc);
  const cuts = v1(doc).slice(1).map((c) => c.start);
  const out = [];
  let prev = null;
  for (const w of words) {
    if (w.sentence !== undefined && w.sentence !== prev && prev !== null) {
      const f = Math.max(0, w.frame - WORD_LEAD_FRAMES);
      const near = cuts.length ? cuts.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a)) : null;
      out.push({ frame: f, word: w.w, sentence: w.sentence, nearestCut: near });
    }
    prev = w.sentence;
  }
  return out;
}
