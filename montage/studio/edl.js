// EDL v1 : modèle de projet du Montage, JSON versionné, indépendant du moteur de rendu.
// Unités : la timeline est en IMAGES entières (grille du fps projet) ; les positions dans les sources
// sont en secondes (flottants) car chaque source a son propre fps. Les fichiers de l'utilisateur ne sont
// jamais embarqués : ils sont référencés par identifiant, nom et empreinte.

export const SCHEMA = 'inku-montage-edl';
export const VERSION = 1;
export const FPS = 30;

export const TRACK_DEFS = [
  { id: 'V1', kind: 'video', name: 'V1', label: 'Clips' },
  { id: 'V2', kind: 'overlay', name: 'V2', label: 'Overlays' },
  { id: 'T1', kind: 'subtitle', name: 'T1', label: 'Sous-titres' },
  { id: 'A1', kind: 'voice', name: 'A1', label: 'Voix' },
  { id: 'A2', kind: 'music', name: 'A2', label: 'Musique' },
  { id: 'A3', kind: 'sfx', name: 'A3', label: 'SFX' },
  { id: 'A4', kind: 'overlay-audio', name: 'A4', label: 'Sons overlays' },
];

export const PRESETS = {
  'inku-actu-anime': {
    name: 'INKU actu anime',
    target: { duration: 61.4, min: 61.0, max: 61.8 },
    rules: { clipMin: 1.0, clipMax: 3.0, clipTarget: 2.5, stillMax: 1.5, travelQuota: 0.2, transitionGap: 8, trimInShot: 3 },
  },
};

let counter = 0;
export function uid(prefix = 'id') {
  counter = (counter + 1) % 1679616;
  return prefix + '_' + Date.now().toString(36) + counter.toString(36);
}

export function newProject(presetId = 'inku-actu-anime') {
  const preset = PRESETS[presetId] || PRESETS['inku-actu-anime'];
  return {
    schema: SCHEMA, version: VERSION, id: uid('proj'),
    project: { name: 'Nouveau montage', fps: FPS, width: 1080, height: 1920, target: { ...preset.target }, preset: presetId, rules: { ...preset.rules } },
    tracks: TRACK_DEFS.map((t) => ({ ...t, locked: false, muted: false, solo: false })),
    sources: {},   // id -> { id, name, kind, fingerprint, duration, width, height, fps, hasAudio, letterbox, shots:[[start,end]] }
    clips: [],     // voir makeClip
    markers: [],   // { id, frame, label }
    settings: { snap: true, ripple: false, mode: 'simple' },
  };
}

export function makeClip(fields) {
  return {
    id: uid('clip'), track: 'V1', start: 0, dur: 75, srcId: null, srcIn: 0,
    // cadrage 9:16 : x = position de la fenêtre dans la zone utile (0 = gauche, 1 = droite, .5 = centré)
    crop: { mode: 'fixed', x: 0.5, travel: null },
    ...fields,
  };
}

export const clipEnd = (c) => c.start + c.dur;
export const framesToSec = (f, fps = FPS) => f / fps;
export const secToFrames = (s, fps = FPS) => Math.round(s * fps);

export function trackClips(doc, trackId) {
  return doc.clips.filter((c) => c.track === trackId).sort((a, b) => a.start - b.start);
}

export function findClip(doc, id) { return doc.clips.find((c) => c.id === id) || null; }

// Durée totale (images) : fin du dernier élément de la timeline.
export function totalFrames(doc) {
  let m = 0;
  for (const c of doc.clips) m = Math.max(m, clipEnd(c));
  return m;
}

// Intervalles de source déjà utilisés par des clips V1 (suivi PAR INTERVALLE, jamais par plan entier).
export function usedIntervals(doc, srcId, ignoreClipId = null) {
  const fps = doc.project.fps;
  return doc.clips
    .filter((c) => c.track === 'V1' && c.srcId === srcId && c.id !== ignoreClipId)
    .map((c) => [c.srcIn, c.srcIn + c.dur / fps, c.id]);
}

export function overlapSeconds(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

// Un plan est « utilisé » si un clip V1 recouvre une part significative (> 3 images) de l'intervalle.
export function intervalUsage(doc, srcId, start, end, ignoreClipId = null) {
  const eps = 3 / doc.project.fps;
  return usedIntervals(doc, srcId, ignoreClipId).filter(([s, e]) => overlapSeconds(s, e, start, end) > eps);
}

// Plages libres d'une piste pouvant accueillir `dur` images (hors clip ignoré).
export function freeSlots(doc, trackId, dur, ignoreIds = []) {
  const cl = doc.clips.filter((c) => c.track === trackId && !ignoreIds.includes(c.id)).sort((a, b) => a.start - b.start);
  const slots = [];
  let cursor = 0;
  for (const c of cl) {
    if (c.start - cursor >= dur) slots.push([cursor, c.start]);
    cursor = Math.max(cursor, clipEnd(c));
  }
  slots.push([cursor, Infinity]);
  return slots;
}

// Position valide la plus proche de `desired` pour un clip de `dur` images (sans chevauchement).
export function nearestFreeStart(doc, trackId, dur, desired, ignoreIds = []) {
  let best = null;
  for (const [s, e] of freeSlots(doc, trackId, dur, ignoreIds)) {
    const hi = e === Infinity ? Infinity : e - dur;
    const pos = Math.min(Math.max(desired, s), hi);
    const d = Math.abs(pos - desired);
    if (!best || d < best.d) best = { pos, d };
  }
  return best ? best.pos : desired;
}

// Insère de la place : décale vers la droite tous les clips d'une piste à partir de `at` de `by` images.
export function pushRight(doc, trackId, at, by, ignoreIds = []) {
  for (const c of doc.clips) if (c.track === trackId && c.start >= at && !ignoreIds.includes(c.id)) c.start += by;
}

// Valide la structure d'un EDL importé. Retourne la liste des problèmes (vide = valide).
export function validate(doc) {
  const errs = [];
  if (!doc || doc.schema !== SCHEMA) errs.push('schéma inconnu');
  else if (doc.version > VERSION) errs.push('version ' + doc.version + ' plus récente que ' + VERSION);
  if (!doc || !Array.isArray(doc.clips) || !Array.isArray(doc.tracks)) { errs.push('clips/pistes manquants'); return errs; }
  const ids = new Set();
  for (const c of doc.clips) {
    if (ids.has(c.id)) errs.push('identifiant de clip dupliqué ' + c.id);
    ids.add(c.id);
    if (!Number.isInteger(c.start) || !Number.isInteger(c.dur) || c.dur < 1) errs.push('clip ' + c.id + ' : début/durée invalides');
    if (!doc.tracks.some((t) => t.id === c.track)) errs.push('clip ' + c.id + ' : piste inconnue ' + c.track);
  }
  return errs;
}

export function migrate(doc) {
  // Point d'extension : v1 est la première version publiée. Les futures migrations s'ajoutent ici.
  return doc;
}

export const fmtTime = (frames, fps = FPS) => {
  const s = Math.floor(frames / fps);
  const f = frames % fps;
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') + ':' + String(f).padStart(2, '0');
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
export const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

// Fenêtre de cadrage 9:16 d'un clip, en coordonnées de la source ORIGINALE (zone utile + décalage).
// `k` = numéro d'image dans le clip. Fonction pure : aperçu et rendu final utilisent la même.
export function cropWindow(clip, k, usable, outAspect = 9 / 16) {
  let h = usable.h, w = h * outAspect;
  if (w > usable.w) { w = usable.w; h = w / outAspect; }
  const free = usable.w - w;
  let f = clip.crop ? clip.crop.x : 0.5;
  if (clip.crop && clip.crop.mode === 'travel' && clip.crop.travel) {
    const { from, to } = clip.crop.travel;
    const u = clamp01(clip.dur > 1 ? k / (clip.dur - 1) : 0);
    f = from + (to - from) * easeInOut(u);
  }
  return { x: usable.x + clamp01(f) * free, y: usable.y + (usable.h - h) / 2, w, h };
}
