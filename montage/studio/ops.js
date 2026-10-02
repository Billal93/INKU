// Opérations de montage (pures vis-à-vis de l'interface) : toutes passent par store.commit pour l'historique.
import { makeClip, clipEnd, findClip, nearestFreeStart, pushRight, uid } from './edl.js';

const R = (v) => Math.round(v);

// Ajoute un plan (ou une portion de plan) de la bibliothèque à V1.
// range = { start, end } en secondes dans la source ; sinon on prend le plan `shotIdx` avec les marges de la méthode.
export function addToV1(store, lib, srcId, { shotIdx = 0, range = null, atFrame = null } = {}) {
  const doc = store.doc;
  const rec = lib.get(srcId);
  if (!rec || !rec.shots || !rec.shots.length) return null;
  const fps = doc.project.fps, rules = doc.project.rules;
  const sfps = rec.fps || 24;
  let srcIn, srcOut;
  if (range) { srcIn = range.start; srcOut = range.end; }
  else {
    const shot = rec.shots[shotIdx];
    // décalage de 2-3 images À L'INTÉRIEUR du plan : jamais pile sur la coupe, jamais les 1res/dernières images
    const m = rules.trimInShot / sfps;
    srcIn = shot.start + m;
    srcOut = Math.min(shot.end - m, srcIn + rules.clipTarget);
  }
  srcIn = Math.max(0, srcIn);
  let durF = Math.max(1, R((srcOut - srcIn) * fps));
  durF = Math.min(durF, R(rules.clipMax * fps));
  let start = atFrame === null ? store.ui.playhead : atFrame;
  const under = doc.clips.find((c) => c.track === 'V1' && start >= c.start && start < clipEnd(c));
  if (under) start = clipEnd(under); // jamais au milieu d'un clip : juste après
  let id = null;
  store.commit('Ajouter un plan', (d) => {
    const hit = d.clips.some((c) => c.track === 'V1' && c.start < start + durF && clipEnd(c) > start);
    if (hit) pushRight(d, 'V1', start, durF); // insertion : les clips suivants se décalent
    const clip = makeClip({ track: 'V1', start, dur: durF, srcId, srcIn });
    d.clips.push(clip); id = clip.id;
    if (!d.sources[srcId]) d.sources[srcId] = sourceRef(rec);
  });
  store.ui.selection = [id];
  return id;
}

export function sourceRef(rec) {
  return {
    id: rec.id, name: rec.name, kind: rec.kind, fingerprint: rec.fingerprint, duration: rec.duration,
    width: rec.width, height: rec.height, fps: rec.fps, hasAudio: rec.hasAudio, letterbox: rec.letterbox ? { top: rec.letterbox.top, bottom: rec.letterbox.bottom, left: rec.letterbox.left, right: rec.letterbox.right } : null,
    shots: (rec.shots || []).map((s) => [+s.start.toFixed(4), +s.end.toFixed(4)]),
  };
}

// Place un fichier audio entier sur une piste audio (voix sur A1 par défaut).
export function addAudio(store, lib, srcId, trackId = 'A1', atFrame = 0) {
  const rec = lib.get(srcId);
  if (!rec) return null;
  const fps = store.doc.project.fps;
  const dur = Math.max(1, R(rec.duration * fps));
  let id = null;
  store.commit('Ajouter un audio', (d) => {
    const start = nearestFreeStart(d, trackId, dur, atFrame);
    const clip = makeClip({ track: trackId, start, dur, srcId, srcIn: 0, gainDb: 0, crop: undefined });
    delete clip.crop; d.clips.push(clip); id = clip.id;
    if (!d.sources[srcId]) d.sources[srcId] = sourceRef(rec);
  });
  store.ui.selection = [id];
  return id;
}

// Coupe à l'image `frame` : les clips sélectionnés qui la croisent, sinon tous les clips déverrouillés.
export function splitAt(store, frame, onlyIds = null) {
  const doc = store.doc;
  const locked = new Set(doc.tracks.filter((t) => t.locked).map((t) => t.id));
  const targets = doc.clips.filter((c) => !locked.has(c.track) && frame > c.start && frame < clipEnd(c) && (!onlyIds || !onlyIds.length || onlyIds.includes(c.id)));
  if (!targets.length) return [];
  const created = [];
  store.commit('Couper', (d) => {
    for (const t of targets) {
      const c = findClip(d, t.id);
      const k = frame - c.start;
      const right = JSON.parse(JSON.stringify(c));
      right.id = uid('clip'); right.start = frame; right.dur = c.dur - k;
      right.srcIn = c.srcIn + k / d.project.fps;
      if (c.crop && c.crop.mode === 'travel' && c.crop.travel) {
        const u = c.dur > 1 ? k / (c.dur - 1) : 0;
        const mid = c.crop.travel.from + (c.crop.travel.to - c.crop.travel.from) * (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
        right.crop.travel = { from: mid, to: c.crop.travel.to };
        c.crop.travel = { from: c.crop.travel.from, to: mid };
      }
      c.dur = k;
      d.clips.push(right); created.push(right.id);
    }
  });
  return created;
}

export function deleteClips(store, ids, ripple = false) {
  if (!ids.length) return;
  const locked = new Set(store.doc.tracks.filter((t) => t.locked).map((t) => t.id));
  store.commit('Supprimer', (d) => {
    const del = d.clips.filter((c) => ids.includes(c.id) && !locked.has(c.track)).sort((a, b) => b.start - a.start);
    for (const c of del) {
      d.clips.splice(d.clips.indexOf(c), 1);
      if (ripple) for (const o of d.clips) if (o.track === c.track && o.start >= clipEnd(c)) o.start -= c.dur;
    }
  });
  store.ui.selection = store.ui.selection.filter((id) => !ids.includes(id));
}

export function duplicateClips(store, ids) {
  const out = [];
  store.commit('Dupliquer', (d) => {
    for (const id of ids) {
      const c = findClip(d, id);
      if (!c) continue;
      const copy = JSON.parse(JSON.stringify(c));
      copy.id = uid('clip');
      copy.start = nearestFreeStart(d, c.track, c.dur, clipEnd(c));
      d.clips.push(copy); out.push(copy.id);
    }
  });
  if (out.length) store.ui.selection = out;
  return out;
}

// Applique des changements de position pour un ensemble de clips (déplacement de groupe, sans chevauchement).
export function applyMove(store, ids, delta, ripple = false) {
  if (!delta) return false;
  const locked = new Set(store.doc.tracks.filter((t) => t.locked).map((t) => t.id));
  const moving = store.doc.clips.filter((c) => ids.includes(c.id) && !locked.has(c.track));
  if (!moving.length) return false;
  // réduit le delta jusqu'à ce que le groupe tienne sans chevaucher les clips immobiles (hors ripple)
  const others = store.doc.clips.filter((c) => !ids.includes(c.id));
  const fits = (dl) => moving.every((m) => m.start + dl >= 0 && others.every((o) => o.track !== m.track || o.start >= m.start + dl + m.dur || clipEnd(o) <= m.start + dl));
  let d = delta;
  if (!ripple) {
    const step = d > 0 ? -1 : 1;
    // cherche d'abord un delta valide vers 0
    let probe = d;
    while (probe !== 0 && !fits(probe)) probe += step;
    if (probe === 0 && !fits(0)) return false;
    if (probe === 0) {
      // pas de place proche : pour un clip seul, on cherche la place libre la plus proche de la cible
      if (moving.length === 1) {
        const m = moving[0];
        const pos = nearestFreeStart(store.doc, m.track, m.dur, m.start + delta, [m.id]);
        d = pos - m.start;
      } else return false;
    } else d = probe;
  }
  if (!d) return false;
  store.commit('Déplacer', (doc) => {
    for (const m of moving) {
      const c = findClip(doc, m.id);
      if (ripple && moving.length === 1) {
        // sort le clip (ferme le trou), puis insère à la nouvelle place en décalant les suivants
        for (const o of doc.clips) if (o.track === c.track && o.id !== c.id && o.start >= clipEnd(c)) o.start -= c.dur;
        const target = Math.max(0, c.start + d);
        const hit = doc.clips.some((o) => o.id !== c.id && o.track === c.track && o.start < target + c.dur && clipEnd(o) > target);
        if (hit) pushRight(doc, c.track, target, c.dur, [c.id]);
        c.start = target;
      } else c.start += d;
    }
  });
  return true;
}

// Ajustement d'entrée/sortie. side 'L' | 'R' ; delta en images ; roll : déplace aussi le point de coupe du voisin.
export function applyTrim(store, lib, id, side, delta, { roll = false, ripple = false } = {}) {
  const doc = store.doc;
  const c = findClip(doc, id);
  if (!c || !delta) return false;
  if (doc.tracks.find((t) => t.id === c.track).locked) return false;
  const fps = doc.project.fps;
  const rec = lib.get(c.srcId);
  const srcDur = rec ? rec.duration : Infinity;
  const same = doc.clips.filter((o) => o.track === c.track && o.id !== c.id);
  const prev = same.filter((o) => clipEnd(o) <= c.start).sort((a, b) => clipEnd(b) - clipEnd(a))[0];
  const next = same.filter((o) => o.start >= clipEnd(c)).sort((a, b) => a.start - b.start)[0];
  let ok = false;
  store.commit('Ajuster', (d) => {
    const cc = findClip(d, id);
    if (side === 'L') {
      let dl = delta;
      dl = Math.max(dl, -Math.floor(cc.srcIn * fps));                 // pas avant le début de la source
      dl = Math.min(dl, cc.dur - 1);                                   // au moins 1 image
      const touching = prev && clipEnd(prev) === cc.start;
      if (!(roll && touching) && !ripple && prev) dl = Math.max(dl, clipEnd(prev) - cc.start); // pas de chevauchement
      if (!(roll && touching) && !prev) dl = Math.max(dl, -cc.start);
      if (roll && touching) {
        const pp = findClip(d, prev.id);
        dl = Math.max(dl, -(pp.dur - 1)); // le voisin garde ≥ 1 image
        const recP = lib.get(pp.srcId);
        const room = !recP || (pp.srcIn + (pp.dur + dl) / fps) <= recP.duration + 1e-6;
        if (!room) dl = Math.min(dl, 0);
        pp.dur += dl;
      }
      if (!dl) return;
      cc.start += dl; cc.srcIn += dl / fps; cc.dur -= dl; ok = true;
    } else {
      let dl = delta;
      dl = Math.max(dl, -(cc.dur - 1));
      dl = Math.min(dl, Math.floor((srcDur - cc.srcIn) * fps) - cc.dur);
      const touching = next && next.start === clipEnd(cc);
      if (!(roll && touching) && !ripple && next) dl = Math.min(dl, next.start - clipEnd(cc));
      if (roll && touching) {
        const nn = findClip(d, next.id);
        dl = Math.min(dl, nn.dur - 1);
        dl = Math.max(dl, -Math.floor(nn.srcIn * fps)); // le voisin ne remonte pas avant le début de sa source
        nn.start += dl; nn.srcIn += dl / fps; nn.dur -= dl;
      } else if (ripple && dl) {
        for (const o of d.clips) if (o.track === cc.track && o.id !== cc.id && o.start >= clipEnd(cc)) o.start += dl;
      }
      if (!dl) return;
      cc.dur += dl; ok = true;
    }
  });
  return ok;
}

// Glissement (slip) : change le contenu visible sans bouger le clip.
export function applySlip(store, lib, id, deltaFrames) {
  const doc = store.doc; const c = findClip(doc, id); if (!c || !deltaFrames) return false;
  const rec = lib.get(c.srcId); const fps = doc.project.fps;
  const max = rec ? rec.duration - c.dur / fps : Infinity;
  const next = Math.max(0, Math.min(max, c.srcIn + deltaFrames / fps));
  if (Math.abs(next - c.srcIn) < 1e-9) return false;
  store.commit('Glisser le contenu', (d) => { findClip(d, id).srcIn = next; });
  return true;
}

export function setTrackFlag(store, trackId, key, value) {
  store.commit('Piste', (d) => { const t = d.tracks.find((x) => x.id === trackId); if (t) t[key] = value === undefined ? !t[key] : value; });
}

export function addMarker(store, frame) {
  if (store.doc.markers.some((m) => m.frame === frame)) return;
  store.commit('Marqueur', (d) => d.markers.push({ id: uid('mk'), frame, label: '' }));
}

export function setCropX(store, id, x) {
  store.commit('Cadrage', (d) => { const c = findClip(d, id); if (c && c.crop) { c.crop.mode = 'fixed'; c.crop.x = Math.max(0, Math.min(1, x)); } });
}

export function pasteAttrs(store, ids, attrs) {
  if (!attrs) return;
  store.commit('Coller le cadrage', (d) => { for (const id of ids) { const c = findClip(d, id); if (c && c.track === 'V1') c.crop = JSON.parse(JSON.stringify(attrs.crop)); } });
}

// Corrections en un geste proposées par le linting.
export function applyFix(store, lib, issue) {
  const doc = store.doc; const c = findClip(doc, issue.clipId); if (!c) return false;
  const fps = doc.project.fps, rules = doc.project.rules;
  const rec = lib.get(c.srcId);
  if (issue.fix === 'trim-max') { store.commit('Raccourcir', (d) => { findClip(d, c.id).dur = R(rules.clipMax * fps); }); return true; }
  if (issue.fix === 'extend') {
    const want = R(rules.clipMin * fps);
    const next = doc.clips.filter((o) => o.track === c.track && o.start >= clipEnd(c)).sort((a, b) => a.start - b.start)[0];
    const room = next ? next.start - clipEnd(c) : Infinity;
    const srcRoom = rec ? Math.floor((rec.duration - c.srcIn) * fps) - c.dur : Infinity;
    const add = Math.min(want - c.dur, Math.max(room, 0), Math.max(srcRoom, 0));
    if (add <= 0) return false;
    store.commit('Allonger', (d) => { findClip(d, c.id).dur += add; }); return true;
  }
  if (issue.fix === 'trim-source') { store.commit('Raccourcir', (d) => { const x = findClip(d, c.id); x.dur = Math.max(1, Math.floor((rec.duration - x.srcIn) * fps)); }); return true; }
  if (issue.fix === 'close-gap') {
    const prev = doc.clips.filter((o) => o.track === c.track && clipEnd(o) <= c.start).sort((a, b) => clipEnd(b) - clipEnd(a))[0];
    const to = prev ? clipEnd(prev) : 0;
    const dl = c.start - to; if (dl <= 0) return false;
    store.commit('Fermer le trou', (d) => { for (const o of d.clips) if (o.track === c.track && o.start >= c.start) o.start -= dl; }); return true;
  }
  if (issue.fix === 'trim-shot' && rec) {
    const shot = rec.shots.find((s) => c.srcIn >= s.start - 1e-3 && c.srcIn < s.end);
    if (!shot) return false;
    const m = rules.trimInShot / (rec.fps || 24);
    const newDur = Math.max(1, Math.floor((shot.end - m - c.srcIn) * fps));
    store.commit('Rester dans le plan', (d) => { findClip(d, c.id).dur = Math.min(findClip(d, c.id).dur, newDur); }); return true;
  }
  return false;
}
