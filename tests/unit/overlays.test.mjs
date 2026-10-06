// Overlays : synchronisation de transition à l'image près, ouverture, abonne-toi, logo borné, SFX espacés, retrait de
// fond sans halo (réplique CPU du shader).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, makeClip } from '../../montage/studio/edl.js';
import { placeTransition, checkTransition, placeOpening, placeSubscribe, placeLogo, sfxClips, overlayFrameAt, contentEnd, transitionSuggestions, boundLoops, subtitlesHiddenUntil } from '../../montage/studio/overlays.js';
import { keyPixel, detectBackground, coverage, coverWindow, frameMap } from '../../montage/render/keying.js';

/** Couverture synthétique : montée sur `rise` images, `hold` images pleines, descente sur `fall` images. */
function cov(rise, hold, fall) {
  const out = [];
  for (let i = 0; i < rise; i++) out.push({ full: (i + 1) / (rise + 1), visible: 1 });
  for (let i = 0; i < hold; i++) out.push({ full: 1, visible: 1 });
  for (let i = 0; i < fall; i++) out.push({ full: 1 - (i + 1) / (fall + 1), visible: 1 - i / fall });
  return out;
}
const asset = (over) => ({ id: 'a1', kind: 'transition', name: 'transi.mp4', fps: 30, frames: 30, width: 1080, height: 1920, hasAudio: true, keying: { method: 'luma' }, analysis: coverWindow(cov(10, 7, 13)), ...over });

function doc2() {
  const d = newProject();
  d.clips.push(makeClip({ id: 'A', srcId: 's1', srcIn: 0, start: 0, dur: 90 }), makeClip({ id: 'B', srcId: 's2', srcIn: 20, start: 90, dur: 90 }));
  return d;
}

test('fenêtre de couverture : début, fin, image de coupe au milieu', () => {
  const w = coverWindow(cov(10, 7, 13));
  assert.equal(w.fullStart, 10); assert.equal(w.fullEnd, 16); assert.equal(w.cutFrame, 13); assert.equal(w.windowFrames, 7);
  assert.equal(w.firstVisible, 0);
});

test('transition : la coupe tombe sur l’image du milieu de la couverture totale, à l’image près', () => {
  const d = doc2();
  const { clip } = placeTransition(d, asset(), 90);
  assert.equal(clip.start, 90 - 13);
  assert.deepEqual(clip.cover, [10, 16]);
  assert.equal(clip.dur, 30);
  // pendant la couverture : l'image du milieu de la fenêtre correspond à la coupe
  assert.equal(overlayFrameAt(clip, 90, 1e9), 13);
  d.clips.push(clip);
  assert.deepEqual(checkTransition(d, clip), []);
});

test('transition 60 fps : décimation exacte (une image sur deux), jamais de changement de vitesse', () => {
  const a = asset({ fps: 60, frames: 60, analysis: coverWindow(cov(20, 14, 26)) });
  const { clip } = placeTransition(doc2(), a, 90);
  assert.equal(clip.dur, 30);
  assert.deepEqual(clip.cover, [10, 16]);
  for (let k = 0; k < 30; k++) assert.equal(overlayFrameAt(clip, clip.start + k, 1e9), 2 * k);
  const fm = frameMap(25, 30);
  assert.equal(fm.exact, false);
  assert.equal(fm.toAsset(6), 5);
});

test('transition : contrôles (plan court, coupe absente, transitions proches, plans voisins/semblables)', () => {
  const d = doc2();
  d.clips[0].dur = 80; d.clips[1].start = 80;   // coupe à 80
  const { clip } = placeTransition(d, asset(), 90);
  d.clips.push(clip);
  assert.ok(checkTransition(d, clip).some((x) => x.code === 'transition-decalee' || x.code === 'transition-sans-coupe'));
  const d2 = doc2();
  d2.clips[0].dur = 30; d2.clips[1].start = 30;
  const t2 = placeTransition(d2, asset(), 30).clip;
  d2.clips.push(t2);
  assert.ok(checkTransition(d2, t2).some((x) => x.code === 'transition-avant-court'));
  // transitions à moins de 8 s
  const d3 = doc2();
  d3.clips.push(makeClip({ id: 'C', srcId: 's3', srcIn: 0, start: 180, dur: 90 }));
  const a1 = placeTransition(d3, asset(), 90).clip, a2 = placeTransition(d3, asset({ id: 'a2' }), 180).clip;
  d3.clips.push(a1, a2);
  assert.ok(checkTransition(d3, a2).some((x) => x.code === 'transitions-proches'));
  // plans voisins du même trailer et semblables
  const d4 = doc2();
  d4.clips[1].srcId = 's1'; d4.clips[1].srcIn = 4;
  const t4 = placeTransition(d4, asset(), 90).clip; d4.clips.push(t4);
  const hist = new Array(48).fill(1 / 16);
  const src = { shots: [{ start: 0, end: 60, hist, luma: 0.4 }] };
  const codes = checkTransition(d4, t4, { getSource: () => src }).map((x) => x.code);
  assert.ok(codes.includes('transition-plans-voisins') && codes.includes('transition-plans-semblables'));
});

test('ouverture : première image = couverture totale, sous-titres après passage sous 60 %', () => {
  const a = asset({ kind: 'opening', analysis: coverWindow([...cov(0, 5, 20)]) });
  const d = newProject();
  const { clip } = placeOpening(d, a);
  assert.equal(clip.start, 0); assert.equal(clip.srcFrame, a.analysis.fullStart);
  assert.equal(overlayFrameAt(clip, 0, 1e9), a.analysis.fullStart);
  d.clips.push(clip);
  const below = a.analysis.below60;
  assert.ok(below > a.analysis.fullEnd);
  assert.equal(subtitlesHiddenUntil(d), below - a.analysis.fullStart);
});

test('abonne-toi : partie visible calée pile sur le mot « abonne » (première occurrence), absence signalée', () => {
  const d = newProject();
  d.clips.push(makeClip({ track: 'T1', start: 100, dur: 20, sub: { index: 0, sentence: 3, words: [{ w: 'avant', t0: 3.34 }, { w: 'Abonne-toi', t0: 3.9 }] } }));
  d.clips.push(makeClip({ track: 'T1', start: 200, dur: 20, sub: { index: 1, sentence: 5, words: [{ w: 'abonnez-vous', t0: 6.7 }] } }));
  const a = asset({ kind: 'subscribe', analysis: { ...coverWindow(cov(10, 7, 13)), firstVisible: 4 } });
  const { clip } = placeSubscribe(d, a);
  assert.equal(clip.start + 4, Math.round(3.9 * 30));
  assert.equal(overlayFrameAt(clip, Math.round(3.9 * 30), 1e9), 4);
  const none = placeSubscribe(newProject(), a);
  assert.equal(none.clip, null);
  assert.match(none.warnings[0], /jamais prononcé/);
});

test('logo : borné à la durée exacte de la vidéo, bouclé proprement, jamais de boucle infinie', () => {
  const d = doc2();
  const { clip } = placeLogo(d, asset({ kind: 'logo', frames: 45 }));
  assert.equal(clip.dur, contentEnd(d));
  assert.equal(clip.loop, true);
  assert.equal(overlayFrameAt(clip, 50, contentEnd(d)), 5);
  assert.equal(overlayFrameAt(clip, contentEnd(d), contentEnd(d)), -1);
  d.clips.push(clip);
  d.clips[1].dur = 30;   // la vidéo raccourcit
  boundLoops(d);
  assert.equal(clip.dur, contentEnd(d));
});

test('SFX : click sur mots importants, pop sur impact, espacement ≥ 0,4 s (le premier gagne)', () => {
  const d = newProject();
  const g = (start, kind) => makeClip({ track: 'T1', start, dur: 8, sub: { index: start, words: [{ w: 'X', kind }] } });
  d.clips.push(g(30, 'important'), g(36, 'important'), g(60, 'normal'), g(90, 'impact'));
  const click = { id: 'c', name: 'click.wav', duration: 0.1 }, pop = { id: 'p', name: 'pop.wav', duration: 0.2 };
  const { clips, skipped } = sfxClips(d, { click, pop });
  assert.deepEqual(clips.map((c) => [c.start, c.sfx]), [[30, 'click'], [90, 'pop']]);
  assert.equal(skipped.length, 1);
});

test('emplacements proposés : 2 images avant le premier mot de chaque phrase', () => {
  const d = doc2();
  d.clips.push(makeClip({ track: 'T1', start: 0, dur: 30, sub: { sentence: 0, words: [{ w: 'a', t0: 0 }] } }));
  d.clips.push(makeClip({ track: 'T1', start: 92, dur: 30, sub: { sentence: 1, words: [{ w: 'On', t0: 92 / 30 }] } }));
  const s = transitionSuggestions(d);
  assert.equal(s.length, 1); assert.equal(s[0].frame, 90); assert.equal(s[0].nearestCut, 90);
});

test('retrait de fond noir : aucun halo (bord blanc antialiasé jamais plus sombre que le fond ou le texte)', () => {
  // bord d'un disque blanc sur noir, antialiasé de 0 à 1 ; composé sur un fond gris moyen
  const bg = 0.5;
  for (let v = 0; v <= 1.0001; v += 0.01) {
    const [r, , , a] = keyPixel(v, v, v, 1, { method: 'luma' });
    const out = r + bg * (1 - a);
    assert.ok(out >= Math.min(bg, 1) - 1e-6, `halo sombre à ${v} : ${out}`);
  }
  // couleurs fidèles : un pixel saturé pleinement opaque est inchangé
  assert.deepEqual(keyPixel(1, 0.4, 0, 1, { method: 'luma' }).map((x) => +x.toFixed(4)), [1, 0.4, 0, 1]);
});

test('retrait de fond vert : fond retiré, sujet conservé, pas de débordement vert', () => {
  const k = { method: 'chroma', color: [0, 0.8, 0.1] };
  assert.ok(keyPixel(0, 0.8, 0.1, 1, k)[3] < 0.01);
  const skin = keyPixel(0.9, 0.7, 0.6, 1, k);
  assert.ok(skin[3] > 0.99);
  const edge = keyPixel(0.45, 0.75, 0.35, 1, k);   // pixel de bord teinté de vert
  assert.ok(edge[1] <= Math.max(edge[0], edge[2]) + 1e-9);
});

test('détection du fond : noir, vert, alpha', () => {
  const mk = (rgba) => { const d = new Uint8ClampedArray(16 * 16 * 4); for (let i = 0; i < d.length; i += 4) d.set(rgba, i); return { data: d, width: 16, height: 16 }; };
  assert.equal(detectBackground([mk([3, 3, 3, 255])]).method, 'luma');
  assert.equal(detectBackground([mk([20, 200, 40, 255])]).method, 'chroma');
  assert.equal(detectBackground([mk([0, 0, 0, 0])]).method, 'alpha');
  const c = coverage(mk([255, 255, 255, 255]).data, 16, 16, { method: 'luma' });
  assert.equal(c.full, 1);
});
