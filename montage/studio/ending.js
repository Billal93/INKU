// Fin de vidéo (§ 2.9), fonctions PURES : durées (cible = voix + climax + miniature, jamais de ralenti ni de blanc),
// proposition de climax classée (3 meilleurs candidats, l'utilisateur choisit), remplacement des cartons de texte par
// des plans voisins du même trailer (l'audio du trailer reste continu), construction des clips de fin.
import { makeClip, clipEnd, intervalUsage } from './edl.js';

export const END_DEFAULTS = { thumbSec: 1.75, thumbMin: 1.5, thumbMax: 2.0, climaxMin: 6, climaxMax: 10 };

/** Fin de la voix nettoyée (images) : dernier clip A1, sinon dernier sous-titre. */
export function voiceEnd(doc) {
  let m = 0;
  for (const c of doc.clips) if (c.track === 'A1') m = Math.max(m, clipEnd(c));
  if (!m) for (const c of doc.clips) if (c.track === 'T1') m = Math.max(m, clipEnd(c));
  return m;
}

/**
 * Durées de la fin : climax = cible − voix − miniature. Si le climax sort de 6-10 s, la miniature absorbe d'abord
 * (1,5 à 2 s), puis on borne le climax et on le dit, avec une proposition.
 * @param {any} doc @param {Partial<typeof END_DEFAULTS>} [opt]
 */
export function endDurations(doc, opt = {}) {
  const o = { ...END_DEFAULTS, ...opt };
  const fps = doc.project.fps;
  const startF = voiceEnd(doc);
  const targetF = Math.round(doc.project.target.duration * fps);
  let thumbF = Math.round(o.thumbSec * fps);
  let climaxF = targetF - startF - thumbF;
  const warnings = [];
  const minC = Math.round(o.climaxMin * fps), maxC = Math.round(o.climaxMax * fps);
  if (climaxF < minC) { thumbF = Math.max(Math.round(o.thumbMin * fps), thumbF - (minC - climaxF)); climaxF = targetF - startF - thumbF; }
  if (climaxF > maxC) { thumbF = Math.min(Math.round(o.thumbMax * fps), thumbF + (climaxF - maxC)); climaxF = targetF - startF - thumbF; }
  let suggestion = null;
  if (climaxF < minC) {
    const over = (minC - climaxF) / fps;
    warnings.push(`Climax de ${(climaxF / fps).toFixed(1).replace('.', ',')} s seulement (minimum 6 s) : la voix est trop longue pour la cible.`);
    suggestion = `Climax gardé à 6 s : vidéo de ${((startF + minC + thumbF) / fps).toFixed(1).replace('.', ',')} s (+${over.toFixed(1).replace('.', ',')} s sur la cible), ou raccourcir la voix d'autant.`;
    climaxF = minC;
  } else if (climaxF > maxC) {
    const under = (climaxF - maxC) / fps;
    warnings.push(`Climax de ${(climaxF / fps).toFixed(1).replace('.', ',')} s (maximum 10 s) : la voix est courte pour la cible.`);
    suggestion = `Climax gardé à 10 s : vidéo de ${((startF + maxC + thumbF) / fps).toFixed(1).replace('.', ',')} s (−${under.toFixed(1).replace('.', ',')} s sous la cible), ou ajouter une phrase à la voix.`;
    climaxF = maxC;
  }
  return { startF, climaxF, thumbF, thumbStartF: startF + climaxF, totalF: startF + climaxF + thumbF, targetF, warnings, suggestion };
}

/** Plages (secondes) d'un indicateur échantillonné à `rate` Hz (1 = vrai), fusionnées. */
function ranges(flags, rate, t0, t1, pad = 1) {
  const out = [];
  const a = Math.max(0, Math.floor(t0 * rate)), b = Math.min(flags.length, Math.ceil(t1 * rate));
  for (let i = a; i < b; i++) {
    if (!flags[i]) continue;
    const s = Math.max(t0, (i - pad) / rate);
    let j = i; while (j + 1 < b && flags[j + 1]) j++;
    const e = Math.min(t1, (j + 1 + pad) / rate);
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
    i = j;
  }
  return out;
}
const hasCard = (feat, a, b) => { for (let i = Math.max(0, Math.floor(a * feat.rate)); i < Math.min(feat.card.length, Math.ceil(b * feat.rate)); i++) if (feat.card[i]) return true; return false; };

/**
 * Morceaux visuels du climax : le segment choisi, sauf les cartons de texte, remplacés par un passage du même trailer
 * sans carton, de préférence juste AVANT le climax (puis juste après), jamais déjà utilisé ailleurs.
 * @param {any} doc @param {{ id: string, duration: number, feat?: { rate: number, card: number[] } }} rec
 * @param {number} startSec @param {number} durF
 * @returns {{ pieces: { k: number, dur: number, srcIn: number, replaces?: [number, number] }[], warnings: string[], cards: [number, number][] }}
 */
export function climaxPieces(doc, rec, startSec, durF) {
  const fps = doc.project.fps;
  const endSec = startSec + durF / fps;
  const warnings = [];
  const feat = rec.feat;
  const cards = feat ? ranges(feat.card, feat.rate, startSec, endSec) : [];
  if (endSec > rec.duration + 1e-6) warnings.push(`Le trailer se termine ${(endSec - rec.duration).toFixed(1).replace('.', ',')} s avant la fin voulue du climax : choisissez un départ plus tôt.`);
  if (cards.length && feat && Math.abs(cards[cards.length - 1][1] - endSec) < 1e-6 && hasCard(feat, endSec, Math.min(rec.duration, endSec + 2)))
    warnings.push('Le climax arrive sur des cartons / crédits à la fin : départ plus tôt conseillé.');
  const pieces = [];
  const used = [];   // remplacements déjà pris (pas de doublon visible)
  let cur = 0;
  const pushPiece = (k0, k1, srcIn, rep) => { if (k1 > k0) pieces.push({ k: k0, dur: k1 - k0, srcIn: +srcIn.toFixed(4), ...(rep ? { replaces: rep } : {}) }); };
  for (const [a, b] of cards) {
    const k0 = Math.round((a - startSec) * fps), k1 = Math.round((b - startSec) * fps);
    pushPiece(cur, k0, startSec + cur / fps);
    const L = (k1 - k0) / fps;
    const free = (s) => s >= 0 && s + L <= rec.duration && !(s < endSec && s + L > startSec) && !(feat && hasCard(feat, s, s + L))
      && !intervalUsage(doc, rec.id, s, s + L).length && !used.some(([u0, u1]) => s < u1 && s + L > u0);
    let rs = null;
    for (let d = 0; d < 60 && rs === null; d += 0.25) { if (free(startSec - L - d)) rs = startSec - L - d; else if (free(endSec + d)) rs = endSec + d; }
    if (rs === null) { warnings.push(`Carton de texte à ${a.toFixed(1).replace('.', ',')} s du trailer sans plan de remplacement libre : conservé.`); pushPiece(k0, k1, startSec + k0 / fps); }
    else { pushPiece(k0, k1, rs, [+a.toFixed(3), +b.toFixed(3)]); used.push([rs, rs + L]); }
    cur = k1;
  }
  pushPiece(cur, durF, startSec + cur / fps);
  return { pieces, warnings, cards };
}

/**
 * Clips de la fin : climax (paysage au centre sur fond flou, cartons remplacés), son du trailer en CONTINU sur A5 (fondu
 * de sortie pendant la miniature), miniature 1,5-2 s. Les clips V1 qui dépassent la fin de la voix sont raccourcis.
 * @param {any} doc @param {{ rec: any, startSec: number, thumbRec?: any, thumbSec?: number }} o
 */
export function buildEnd(doc, o) {
  const fps = doc.project.fps;
  const dur = endDurations(doc, o.thumbSec ? { thumbSec: o.thumbSec } : {});
  const warnings = [...dur.warnings];
  const { pieces, warnings: w2 } = climaxPieces(doc, o.rec, o.startSec, dur.climaxF);
  warnings.push(...w2);
  const clips = pieces.map((p) => { const c = makeClip({ track: 'V1', role: 'climax', layout: 'fit-blur', start: dur.startF + p.k, dur: p.dur, srcId: o.rec.id, srcIn: p.srcIn }); if (p.replaces) c.replaces = p.replaces; return c; });
  const audio = makeClip({ track: 'A5', role: 'climax', srcId: o.rec.id, srcIn: o.startSec, start: dur.startF, dur: dur.climaxF + (o.thumbRec ? dur.thumbF : 0), fadeOut: o.thumbRec ? dur.thumbF / fps : 0.3, gainDb: 0 });
  delete audio.crop;
  clips.push(audio);
  if (o.thumbRec) clips.push(makeClip({ track: 'V1', role: 'thumbnail', start: dur.thumbStartF, dur: dur.thumbF, srcId: o.thumbRec.id, srcIn: 0 }));
  else warnings.push('Aucune miniature choisie : la vidéo se termine sur le climax.');
  return { clips, dur, warnings, info: { climaxStartSec: dur.startF / fps, thumbStartSec: dur.thumbStartF / fps, totalSec: (o.thumbRec ? dur.totalF : dur.thumbStartF) / fps } };
}

/** Remplace la fin existante par `built` (dans une mutation de store.commit). */
export function applyEnd(d, built, endMeta) {
  d.clips = d.clips.filter((c) => !(c.role === 'climax' || c.role === 'thumbnail'));
  const start = built.dur.startF;
  // la dernière phrase garde son plan jusqu'à la fin de la voix, pas au-delà
  for (const c of d.clips) if (c.track === 'V1' && c.start < start && clipEnd(c) > start) c.dur = start - c.start;
  d.clips = d.clips.filter((c) => !(c.track === 'V1' && c.start >= start));
  d.clips.push(...built.clips);
  d.end = endMeta;
}

/**
 * Propose un climax : fenêtres de `durSec` dans la seconde moitié du trailer (bonus dans le dernier tiers), classées par
 * énergie sonore, montée de la musique, rythme des coupes et mouvement ; pénalités : cartons/crédits, passages calmes,
 * images sombres. Retourne les 3 meilleures, sans chevauchement de plus de la moitié.
 * @param {{ duration: number, shots: { start: number, end: number }[], feat: { rate: number, d: number[], luma: number[], card: number[] } }} rec
 * @param {Float32Array | number[]} envDb énergie sonore du trailer en dB, même cadence que feat (8/s)
 * @param {number} durSec
 */
export function suggestClimax(rec, envDb, durSec) {
  const f = rec.feat, rate = f.rate, n = f.d.length;
  const L = Math.max(1, Math.round(durSec * rate));
  const sorted = Array.from(envDb).filter(Number.isFinite).sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? -60, p90 = sorted[Math.floor(sorted.length * 0.9)] ?? -10;
  const norm = (v) => Math.max(0, Math.min(1, (v - p10) / Math.max(1, p90 - p10)));
  const cutTimes = rec.shots.slice(1).map((s) => s.start);
  const motionMax = Math.max(1e-6, ...f.d.map((x) => Math.min(x, 0.4)));
  const mean = (a, b, get) => { let s = 0, k = 0; for (let i = Math.max(0, a); i < Math.min(n, b); i++) { const v = get(i); if (Number.isFinite(v)) { s += v; k++; } } return k ? s / k : 0; };
  const cands = [];
  const first = Math.floor(n * 0.5), last = n - L;
  for (let s = first; s <= last; s += Math.max(1, Math.round(rate / 2))) {
    const e = s + L;
    const E = mean(s, e, (i) => norm(envDb[i]));
    const before = mean(s - 3 * rate, s, (i) => norm(envDb[i])), head = mean(s, s + 2 * rate, (i) => norm(envDb[i]));
    const R = Math.max(0, head - before);
    const cuts = cutTimes.filter((t) => t >= s / rate && t < e / rate).length / (L / rate);
    const C = Math.min(1, cuts / 1.2);
    const M = mean(s, e, (i) => Math.min(f.d[i], 0.4)) / motionMax;
    const K = mean(s, e, (i) => f.card[i]);
    const D = mean(s, e, (i) => (f.luma[i] < 0.08 ? 1 : 0));
    const calm = E < 0.35 ? 1 : 0;
    const lastThird = s / n >= 2 / 3 ? 1 : 0;
    const score = 0.35 * E + 0.2 * R + 0.2 * C + 0.25 * M - 0.8 * K - 0.3 * D - 0.2 * calm + 0.1 * lastThird;
    const why = [];
    if (E > 0.6) why.push('son fort'); if (R > 0.15) why.push('montée'); if (C > 0.5) why.push('coupes rapides'); if (M > 0.5) why.push('mouvement');
    if (K > 0.05) why.push('cartons de texte'); if (calm) why.push('passage calme'); if (D > 0.3) why.push('images sombres');
    cands.push({ start: s / rate, score: +score.toFixed(3), why, parts: { E: +E.toFixed(2), R: +R.toFixed(2), C: +C.toFixed(2), M: +M.toFixed(2), K: +K.toFixed(2) } });
  }
  cands.sort((a, b) => b.score - a.score);
  const top = [];
  for (const c of cands) { if (top.every((t) => Math.abs(t.start - c.start) >= durSec / 2)) top.push(c); if (top.length === 3) break; }
  return top;
}
