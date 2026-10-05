// Tests unitaires du cœur pur du Montage (sans navigateur) : node --test tests/unit/
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, makeClip, clipEnd, nearestFreeStart, freeSlots, pushRight, validate, intervalUsage, totalFrames, fmtTime } from '../../montage/studio/edl.js';
import { createStore } from '../../montage/studio/store.js';

test('EDL : nouveau projet valide, pistes fixes et nommées', () => {
  const d = newProject();
  assert.deepEqual(validate(d), []);
  assert.deepEqual(d.tracks.map((t) => t.id), ['V1', 'V2', 'T1', 'A1', 'A2', 'A3', 'A4']);
  assert.equal(d.project.fps, 30);
  assert.equal(d.project.width, 1080);
});

test('EDL : positions valides les plus proches (sans chevauchement)', () => {
  const d = newProject();
  d.clips.push(makeClip({ id: 'a', start: 0, dur: 60, srcId: 's' }), makeClip({ id: 'b', start: 100, dur: 60, srcId: 's' }));
  assert.equal(nearestFreeStart(d, 'V1', 30, 10), 60);    // chevauche a -> la place libre la plus proche est après a
  assert.equal(nearestFreeStart(d, 'V1', 30, 70), 70);    // déjà libre (entre 60 et 100)
  assert.equal(nearestFreeStart(d, 'V1', 50, 70), 160);   // trou de 40 images trop petit -> après b
  assert.deepEqual(freeSlots(d, 'V1', 30).map(([s, e]) => [s, e]), [[60, 100], [160, Infinity]]);
});

test('EDL : insertion décale les clips suivants', () => {
  const d = newProject();
  d.clips.push(makeClip({ id: 'a', start: 0, dur: 60 }), makeClip({ id: 'b', start: 60, dur: 60 }));
  pushRight(d, 'V1', 60, 45);
  assert.equal(d.clips.find((c) => c.id === 'b').start, 105);
  assert.equal(totalFrames(d), 165);
});

test('EDL : utilisation par INTERVALLE, pas par plan entier (leçon n°7)', () => {
  const d = newProject();
  d.clips.push(makeClip({ id: 'a', srcId: 's1', srcIn: 10, dur: 30 })); // utilise 10,0 → 11,0 s
  assert.equal(intervalUsage(d, 's1', 12, 15).length, 0);   // autre partie du même plan : libre
  assert.equal(intervalUsage(d, 's1', 10.5, 13).length, 1); // recouvrement réel
  assert.equal(intervalUsage(d, 's1', 10.95, 13).length, 0); // moins de 3 images : toléré
  assert.equal(intervalUsage(d, 's1', 10.5, 13, 'a').length, 0); // le clip lui-même est ignoré
});

test('EDL : détecte les clips invalides', () => {
  const d = newProject();
  d.clips.push(makeClip({ id: 'x', dur: 0 }));
  assert.ok(validate(d).length > 0);
  assert.ok(validate({ schema: 'autre' }).length > 0);
});

test('Format du temps', () => { assert.equal(fmtTime(30 * 83 + 7), '01:23:07'); });

test('Store : annuler/rétablir, un geste = un seul pas', () => {
  const s = createStore(newProject());
  s.commit('ajout', (d) => d.clips.push(makeClip({ id: 'a', start: 0, dur: 60 })));
  s.beginGesture('déplacement');
  for (let i = 1; i <= 10; i++) s.commit('x', (d) => { d.clips[0].start = i * 5; });
  s.endGesture();
  assert.equal(s.doc.clips[0].start, 50);
  assert.ok(s.undo()); assert.equal(s.doc.clips[0].start, 0);   // le geste entier est annulé d'un coup
  assert.ok(s.undo()); assert.equal(s.doc.clips.length, 0);
  assert.equal(s.undo(), false);
  assert.ok(s.redo()); assert.ok(s.redo()); assert.equal(s.doc.clips[0].start, 50);
});

test('Store : sérialisation/restauration exactes (reprise après fermeture)', () => {
  const s = createStore(newProject());
  s.commit('a', (d) => d.clips.push(makeClip({ id: 'a', start: 3, dur: 45, srcId: 'z' })));
  s.ui.playhead = 77;
  const data = JSON.parse(JSON.stringify(s.serialize()));
  const s2 = createStore(newProject());
  s2.restore(data);
  assert.deepEqual(s2.doc.clips, s.doc.clips);
  assert.equal(s2.ui.playhead, 77);
  assert.ok(s2.undo()); assert.equal(s2.doc.clips.length, 0);
});

test('Store : historique plafonné', () => {
  const s = createStore(newProject(), { maxHistory: 5 });
  for (let i = 0; i < 20; i++) s.commit('c', (d) => { d.markers.push({ id: 'm' + i, frame: i }); });
  let n = 0; while (s.undo()) n++;
  assert.equal(n, 5);
});

test('Store : annuler un geste interrompu restaure l\'état', () => {
  const s = createStore(newProject());
  s.commit('a', (d) => d.clips.push(makeClip({ id: 'a', start: 0, dur: 30 })));
  s.beginGesture('g'); s.commit('x', (d) => { d.clips[0].start = 99; }); s.cancelGesture();
  assert.equal(s.doc.clips[0].start, 0);
});

test('clipEnd', () => { assert.equal(clipEnd(makeClip({ start: 10, dur: 5 })), 15); });

import { cropWindow } from '../../montage/studio/edl.js';
test('Cadrage 9:16 : fixe, centré, borné à la zone utile', () => {
  const usable = { x: 0, y: 23, w: 1920, h: 1034 };
  const c = makeClip({ crop: { mode: 'fixed', x: 0.5, travel: null } });
  const r = cropWindow(c, 0, usable);
  assert.ok(Math.abs(r.w / r.h - 9 / 16) < 1e-9);
  assert.equal(r.h, 1034);
  assert.ok(Math.abs(r.x - (1920 - r.w) / 2) < 1e-9);
  const left = cropWindow(makeClip({ crop: { mode: 'fixed', x: 0, travel: null } }), 0, usable);
  const right = cropWindow(makeClip({ crop: { mode: 'fixed', x: 1, travel: null } }), 0, usable);
  assert.equal(left.x, 0); assert.ok(Math.abs(right.x + right.w - 1920) < 1e-9);
});
test('Travelling : position décimale (sous-pixel), ease-in-out, extrémités exactes', () => {
  const usable = { x: 0, y: 0, w: 1920, h: 1080 };
  const c = makeClip({ dur: 90, crop: { mode: 'travel', x: 0.5, travel: { from: 0.4, to: 0.5 } } });
  const a = cropWindow(c, 0, usable).x, m = cropWindow(c, 45, usable).x, z = cropWindow(c, 89, usable).x;
  assert.ok(a < m && m < z);
  assert.ok(Number.isFinite(m) && m !== Math.round(m));
  const free = 1920 - (1080 * 9) / 16;
  assert.ok(Math.abs(a - 0.4 * free) < 1e-6 && Math.abs(z - 0.5 * free) < 1e-6);
});

import { addToV1, splitAt, deleteClips, duplicateClips, applyMove, applyTrim, applySlip } from '../../montage/studio/ops.js';
import { lintDoc } from '../../montage/studio/lint.js';
const fakeLib = (recs) => ({ get: (id) => recs[id] || null });
const rec = (over = {}) => ({ id: 's', name: 'trailer.mp4', kind: 'video', duration: 20, fps: 24, width: 1920, height: 1080, fingerprint: 'x', hasAudio: true, letterbox: { top: 23, bottom: 24, left: 0, right: 0, usable: { x: 0, y: 23, w: 1920, h: 1034 } }, shots: [{ start: 0, end: 3, luma: .5, motion: .05 }, { start: 3, end: 5.5, luma: .5, motion: .05 }, { start: 5.5, end: 6.2, luma: .5, motion: .05 }], ...over });
const mk = () => { const store = createStore(newProject()); const lib = fakeLib({ s: rec() }); return { store, lib }; };

test('Ops : ajout d\'un plan avec marge intérieure (3 images) et durée cible ≤ 3 s', () => {
  const { store, lib } = mk();
  const id = addToV1(store, lib, 's', { shotIdx: 0, atFrame: 0 });
  const c = store.doc.clips.find((x) => x.id === id);
  assert.ok(Math.abs(c.srcIn - 3 / 24) < 1e-9);           // jamais pile sur la coupe
  assert.equal(c.dur, 75);                                 // 2,5 s à 30 fps
  assert.deepEqual(store.doc.sources.s.shots[0], [0, 3]);  // l'EDL référence la source (nom, empreinte, plans)
});

test('Ops : insérer au milieu d\'un clip -> juste après ; les suivants se décalent', () => {
  const { store, lib } = mk();
  addToV1(store, lib, 's', { shotIdx: 0, atFrame: 0 });          // 0..75
  addToV1(store, lib, 's', { shotIdx: 1, atFrame: 75 });         // 75..150
  const mid = addToV1(store, lib, 's', { shotIdx: 2, atFrame: 10 }); // dans le clip 1 -> après lui (75), pousse le suivant
  const cs = store.doc.clips.slice().sort((a, b) => a.start - b.start);
  assert.equal(cs[1].id, mid);
  assert.equal(cs[1].start, 75);
  assert.ok(cs[2].start >= cs[1].start + cs[1].dur);        // aucun chevauchement
});

test('Ops : coupe à l\'image près, srcIn recalé, annulable', () => {
  const { store, lib } = mk();
  const id = addToV1(store, lib, 's', { shotIdx: 0, atFrame: 0 });
  const created = splitAt(store, 30, [id]);
  assert.equal(created.length, 1);
  const [a, b] = store.doc.clips.slice().sort((x, y) => x.start - y.start);
  assert.equal(a.dur, 30); assert.equal(b.start, 30); assert.equal(b.dur, 45);
  assert.ok(Math.abs(b.srcIn - (a.srcIn + 1)) < 1e-9);      // 30 images à 30 fps = 1 s
  store.undo(); assert.equal(store.doc.clips.length, 1);
});

test('Ops : suppression avec ou sans recalage (ripple)', () => {
  const { store, lib } = mk();
  const a = addToV1(store, lib, 's', { shotIdx: 0, atFrame: 0 }); const b = addToV1(store, lib, 's', { shotIdx: 1, atFrame: 75 });
  deleteClips(store, [a], false);
  assert.equal(store.doc.clips.find((c) => c.id === b).start, 75);
  store.undo(); deleteClips(store, [a], true);
  assert.equal(store.doc.clips.find((c) => c.id === b).start, 0);
});

test('Ops : déplacement jamais en chevauchement ; piste verrouillée refusée', () => {
  const { store, lib } = mk();
  const a = addToV1(store, lib, 's', { shotIdx: 0, atFrame: 0 }); const b = addToV1(store, lib, 's', { shotIdx: 1, atFrame: 75 });
  assert.ok(applyMove(store, [a], 200));
  assert.ok(store.doc.clips.find((c) => c.id === a).start >= 150); // a été placé après b
  store.doc.tracks[0].locked = true;
  assert.equal(applyMove(store, [b], 10), false);
});

test('Ops : ajustement bornées par la source et les voisins ; roll déplace la coupe des deux clips', () => {
  const { store, lib } = mk();
  const a = addToV1(store, lib, 's', { shotIdx: 0, atFrame: 0 }); const b = addToV1(store, lib, 's', { shotIdx: 1, atFrame: 75 });
  const A = () => store.doc.clips.find((c) => c.id === a), B = () => store.doc.clips.find((c) => c.id === b);
  assert.equal(applyTrim(store, lib, a, 'R', 20), false);                       // bute sur le voisin
  const sumBefore = A().dur + B().dur;
  assert.ok(applyTrim(store, lib, a, 'R', -10, { roll: true }));                // roll : a raccourci, b rallongé... 
  assert.equal(A().dur + B().dur, sumBefore);                                   // le point de coupe bouge, pas la durée totale
  assert.equal(B().start, A().start + A().dur);                                 // toujours jointifs
});

test('Ops : glissement (slip) borné à la durée de la source', () => {
  const { store, lib } = mk();
  const a = addToV1(store, lib, 's', { shotIdx: 0, atFrame: 0 });
  assert.ok(applySlip(store, lib, a, 30));
  assert.ok(store.doc.clips[0].srcIn > 1);
  assert.equal(applySlip(store, lib, a, 99999), true);
  const c = store.doc.clips[0];
  assert.ok(c.srcIn + c.dur / 30 <= 20 + 1e-9);
});

test('Linting : clip court, plan réutilisé, trou — jamais bloquant', () => {
  const { store, lib } = mk();
  const a = addToV1(store, lib, 's', { shotIdx: 0, atFrame: 0 });
  duplicateClips(store, [a]);                                  // même passage deux fois
  store.commit('court', (d) => { d.clips[0].dur = 20; });      // 0,67 s
  const issues = lintDoc(store.doc, (id) => lib.get(id));
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes('clip-court'));
  assert.ok(codes.includes('plan-reutilise'));
});
