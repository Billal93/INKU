// « Remplir la timeline » : PROPOSITION de plans pour les trous de V1 jusqu'à la fin de la voix (l'utilisateur garde la
// main : un seul pas d'annulation, chaque plan se remplace en un geste). Fonction pure.
// Règles : coupes calées ~2 images avant un mot (la voix est le métronome), clips de 1 à 3 s (cible 2,5 s), plans
// jamais réutilisés (suivi par INTERVALLE), pas de plan noir, quasi immobile trop long, ou carton de texte ; ordre du
// trailer conservé (il suit souvent l'histoire) ; cadrage 9:16 centré sur le point d'intérêt du plan.
import { makeClip, clipEnd, overlapSeconds } from './edl.js';
import { timelineWords } from './overlays.js';
import { voiceEnd } from './ending.js';
import { cropXForFocus } from './framing.js';

/** Trous de V1 dans [from, to). */
export function v1Gaps(doc, from, to) {
  const cl = doc.clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start);
  const gaps = [];
  let cur = from;
  for (const c of cl) { if (c.start > cur) gaps.push([cur, Math.min(c.start, to)]); cur = Math.max(cur, clipEnd(c)); if (cur >= to) break; }
  if (cur < to) gaps.push([cur, to]);
  return gaps.filter(([a, b]) => b - a > 0);
}

/**
 * @param {any} doc @param {any[]} sources enregistrements analysés (kind 'video', shots, letterbox)
 * @param {{ from?: number, to?: number }} [o]
 * @returns {{ clips: any[], warnings: string[] }}
 */
export function fillPlan(doc, sources, o = {}) {
  const fps = doc.project.fps, rules = doc.project.rules;
  const to = o.to ?? voiceEnd(doc), from = o.from ?? 0;
  const warnings = [];
  const minF = Math.round(rules.clipMin * fps), maxF = Math.round(rules.clipMax * fps), tgtF = Math.round(rules.clipTarget * fps);
  const cuts = [...new Set(timelineWords(doc).map((w) => Math.max(0, w.frame - 2)))].sort((a, b) => a - b);
  // Intervalles déjà utilisés (par source) + ceux que l'on ajoute au fur et à mesure.
  const used = new Map();
  for (const c of doc.clips) if (c.track === 'V1' && c.srcId) { if (!used.has(c.srcId)) used.set(c.srcId, []); used.get(c.srcId).push([c.srcIn, c.srcIn + c.dur / fps]); }
  const vids = sources.filter((s) => s.kind === 'video' && s.shots && s.shots.length);
  if (!vids.length) return { clips: [], warnings: ['Aucun trailer analysé à utiliser.'] };
  // Plans candidats, dans l'ordre des trailers.
  const shots = [];
  for (const s of vids) {
    const m = rules.trimInShot / (s.fps || 24);
    s.shots.forEach((sh, i) => {
      if (sh.black || (sh.cards || 0) > 0.2) return;
      const a = sh.start + m, b = sh.end - m;
      if (b - a < rules.clipMin) return;
      shots.push({ src: s, i, a, b, still: sh.motion < 0.008, focusX: sh.focusX ?? 0.5 });
    });
  }
  let si = 0;
  /** Portion libre d'un plan (la plus tôt), ou null. */
  const freeIn = (s, need) => {
    const u = used.get(s.src.id) || [];
    let a = s.a;
    for (const [x0, x1] of u.slice().sort((p, q) => p[0] - q[0])) if (overlapSeconds(a, a + need, x0, x1) > 1e-3) a = Math.max(a, x1 + 0.05);
    const len = Math.min(s.b - a, s.still ? rules.stillMax : Infinity);
    return len >= rules.clipMin ? { s, a, len } : null;
  };
  /** Prochain plan libre (ordre du trailer) ; on préfère un plan assez long pour couper sur un mot. */
  const nextShot = (need, okLen) => {
    let first = null;
    for (let k = 0; k < shots.length; k++) {
      const f = freeIn(shots[(si + k) % shots.length], need);
      if (!f) continue;
      if (!first) first = { f, k };
      if (okLen(f.len)) { si = (si + k + 1) % shots.length; return f; }
      if (k > 8) break;
    }
    if (first) si = (si + first.k + 1) % shots.length;
    return first ? first.f : null;
  };
  const clips = [];
  for (const [g0, g1] of v1Gaps(doc, from, to)) {
    let cur = g0, last = null;
    while (g1 - cur >= minF || (g1 - cur > 0 && !clips.length)) {
      // fin idéale : coupe sur un mot entre cur+1 s et cur+3 s, la plus proche de cur+2,5 s
      const lim = Math.min(g1, cur + maxF);
      // jamais de reste plus court qu'1 s au bout du trou
      const cands = cuts.filter((f) => f >= cur + minF && f <= lim && (g1 - f === 0 || g1 - f >= minF));
      let end = cands.length ? cands.reduce((p, q) => (Math.abs(q - cur - tgtF) < Math.abs(p - cur - tgtF) ? q : p)) : Math.min(g1, cur + tgtF);
      if (g1 - end < minF && g1 - cur <= maxF) end = g1;            // pas de reste trop court
      const wordWithin = (len) => { const room = Math.floor(len * fps); return end - cur <= room || cuts.some((f) => f >= cur + minF && f <= cur + room) || end === g1 && g1 - cur <= room; };
      const pick = nextShot(Math.min((end - cur) / fps, rules.clipMax), wordWithin);
      if (!pick) { warnings.push(`Plus de plan libre pour combler ${((g1 - cur) / fps).toFixed(1).replace('.', ',')} s à partir de ${(cur / fps).toFixed(1).replace('.', ',')} s.`); break; }
      // plan plus court que prévu : coupe sur le dernier mot qu'il permet d'atteindre
      const room = Math.floor(pick.len * fps);
      if (end - cur > room) {
        const fit = cuts.filter((f) => f >= cur + minF && f <= cur + room);
        end = fit.length ? fit[fit.length - 1] : cur + room;
      }
      const dur = Math.max(1, end - cur);
      const clip = makeClip({ track: 'V1', start: cur, dur, srcId: pick.s.src.id, srcIn: +pick.a.toFixed(4), auto: 'fill' });
      clip.crop = { mode: 'fixed', x: +cropXForFocus(pick.s.focusX, pick.s.src.letterbox ? pick.s.src.letterbox.usable : { w: 16, h: 9 }).toFixed(3), travel: null };
      clips.push(clip);
      if (!used.has(pick.s.src.id)) used.set(pick.s.src.id, []);
      used.get(pick.s.src.id).push([pick.a, pick.a + dur / fps]);
      cur += dur;
      last = { clip, room: Math.floor(pick.len * fps) };
    }
    // reste (< 1 s) : le dernier plan s'allonge s'il le peut, sinon un plan court (signalé par le linting)
    if (cur < g1 && last && last.clip.start + last.clip.dur === cur && last.clip.dur + (g1 - cur) <= Math.min(maxF, last.room)) { last.clip.dur += g1 - cur; cur = g1; }
    if (cur < g1) {
      // sinon le plan précédent cède quelques images pour qu'un dernier plan dure au moins 1 s
      const r = g1 - cur;
      if (last && last.clip.start + last.clip.dur === cur && last.clip.dur - (minF - r) >= minF) {
        const give = Math.max(0, minF - r);
        last.clip.dur -= give; cur -= give;
        const u = used.get(last.clip.srcId); if (u) u[u.length - 1][1] -= give / fps;
      }
      const pick = nextShot((g1 - cur) / fps, (len) => len * fps >= g1 - cur);
      if (pick) {
        const dur = Math.min(g1 - cur, Math.floor(pick.len * fps));
        const clip = makeClip({ track: 'V1', start: cur, dur, srcId: pick.s.src.id, srcIn: +pick.a.toFixed(4), auto: 'fill' });
        clip.crop = { mode: 'fixed', x: +cropXForFocus(pick.s.focusX, pick.s.src.letterbox ? pick.s.src.letterbox.usable : { w: 16, h: 9 }).toFixed(3), travel: null };
        clips.push(clip);
        if (!used.has(pick.s.src.id)) used.set(pick.s.src.id, []);
        used.get(pick.s.src.id).push([pick.a, pick.a + dur / fps]);
      }
    }
  }
  if (!clips.length && !warnings.length) warnings.push('Rien à remplir : V1 couvre déjà toute la voix.');
  return { clips, warnings };
}
