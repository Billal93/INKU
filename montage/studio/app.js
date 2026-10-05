// Studio : assemblage de l'écran unique (aperçu, sources, timeline, propriétés), raccourcis, import, autosave.
import { newProject, fmtTime, totalFrames, findClip } from './edl.js';
import { createStore } from './store.js';
import { Library } from './library.js';
import { Player } from './player.js';
import { createTimeline } from './timeline.js';
import { createBin } from './bin.js';
import { createProps } from './props.js';
import { createVoice } from './voice.js';
import { createVoicePanel } from './voice-panel.js';
import { splitAt, deleteClips, duplicateClips, addMarker } from './ops.js';
import { loadSaved, startAutosave } from './persist.js';
import { requestPersistence, usage, opfsAvailable } from './storage.js';
import { checkSupport } from './caps.js';

/** @type {(id: string) => any} */
const $ = (id) => document.getElementById(id);
const fr = (n, d = 1) => Number(n).toFixed(d).replace('.', ',');

let toastTimer = undefined;
/** @param {string} msg */
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/** Appareil trop ancien : message clair et, si un projet est sauvegardé, export de son EDL. */
async function showUnsupported(missing) {
  const box = $('compat');
  box.hidden = false;
  box.innerHTML = '<b>Ce navigateur ne peut pas faire tourner le Montage</b> (manque : ' + missing.join(', ') + ').<br>'
    + 'Appareils pris en charge : iPhone avec iOS 26 ou plus récent (Safari 26), ordinateur avec Chrome ou Edge à jour, Safari 26 sur Mac, Firefox 130+ (sans garantie). '
    + 'Le reste d\'INKU Studio fonctionne normalement.';
  $('studio').style.display = 'none';
  try {
    const saved = await loadSaved();
    if (saved) {
      const b = document.createElement('button');
      b.className = 'ibtn primary'; b.textContent = 'Exporter le projet sauvegardé (EDL)';
      b.style.marginTop = '12px';
      b.onclick = () => downloadEdl(JSON.parse(saved.doc));
      box.append(document.createElement('br'), b);
    }
  } catch { }
}

function downloadEdl(doc) {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (doc.project.name || 'montage') + '.edl.json';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function boot() {
  const theme = new URLSearchParams(location.search).get('theme') || localStorage.getItem('inku-montage-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

  const support = checkSupport();
  if (!support.ok) { await showUnsupported(support.missing); return; }
  for (const w of support.warnings) console.info('[montage]', w);

  const lib = new Library();
  await lib.init();
  const saved = await loadSaved();
  const store = createStore(saved ? JSON.parse(saved.doc) : newProject());
  if (saved) store.restore(saved);
  const studio = $('studio');
  studio.classList.toggle('pro', store.doc.settings.mode === 'pro');

  // ── Aperçu ──
  const frameEl = $('frame');
  const hud = $('hud');
  const player = new Player({
    store, library: lib, mount: frameEl,
    onFrame: (frame, clip) => {
      const fps = store.doc.project.fps;
      const n = clip && clip.track === 'V1' ? store.doc.clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start).findIndex((c) => c.id === clip.id) + 1 : 0;
      hud.textContent = fmtTime(frame, fps) + (clip ? ` · V1 clip ${n} · ${player.stats.lastSource === 'proxy' ? 'proxy' : 'original'}` : ' · aucun clip');
    },
  });
  window.__studio = { store, lib, player };

  // ── Timeline, sources, propriétés ──
  let props = null;
  const timeline = createTimeline({
    store, lib, player, scrollEl: $('tlScroll'), contentEl: $('tlContent'), toast,
    onSelect: () => { if (props) props.render(); syncTools(); },
  });
  props = createProps({ el: $('propsBody'), titleEl: $('propsTitle'), store, lib, player, timeline, toast });
  createBin({ el: $('binBody'), store, lib, player, toast, timeline });
  const voice = createVoice({ store, lib, player });
  createVoicePanel({ el: $('voiceBody'), store, lib, voice, toast, onFont: (f) => player.setSubtitleFont(f) });
  window.__studio.voice = voice;

  // ── Barre supérieure ──
  const durEl = $('dur');
  const updateDur = () => {
    const d = store.doc, tf = totalFrames(d) / d.project.fps, t = d.project.target;
    const delta = tf - t.duration;
    durEl.textContent = `${fr(tf)} s / ${fr(t.duration)} s · ${delta >= 0 ? '+' : '−'}${fr(Math.abs(delta))}`;
    durEl.className = 'dur ' + (tf >= t.min && tf <= t.max ? 'ok' : 'warn');
    $('projName').textContent = d.project.name + ' · preset « INKU actu anime »';
    $('btnUndo').disabled = !store.canUndo; $('btnRedo').disabled = !store.canRedo;
    $('btnUndo').style.opacity = store.canUndo ? '1' : '.35'; $('btnRedo').style.opacity = store.canRedo ? '1' : '.35';
  };
  const updateTc = () => { $('tc').textContent = fmtTime(store.ui.playhead, store.doc.project.fps); };
  function syncTools() {
    const s = store.doc.settings;
    $('tSnap').classList.toggle('on', s.snap); $('tRipple').classList.toggle('on', s.ripple);
    $('tMulti').classList.toggle('on', store.ui.multi); $('tRoll').classList.toggle('on', !!store.ui.roll);
    $('btnPlay').innerHTML = `<svg class="i"><use href="#i-${store.ui.playing ? 'pause' : 'play'}"/></svg>`;
  }
  store.subscribe((k) => { if (k === 'doc') updateDur(); if (k === 'playhead' || k === 'doc') updateTc(); if (k === 'transport' || k === 'doc') syncTools(); });
  updateDur(); updateTc(); syncTools();

  $('btnUndo').onclick = () => { store.undo(); player.invalidate(); player.refresh(); };
  $('btnRedo').onclick = () => { store.redo(); player.invalidate(); player.refresh(); };
  $('btnExport').onclick = () => {
    downloadEdl(store.doc);
    toast('EDL exporté (le rendu MP4 arrive en priorité 5)');
  };
  document.querySelectorAll(/** @type {'button'} */ ('.seg button')).forEach((b) => b.addEventListener('click', () => {
    const pro = b.dataset.mode === 'pro';
    store.doc.settings.mode = pro ? 'pro' : 'simple';
    document.querySelectorAll(/** @type {'button'} */ ('.seg button')).forEach((x) => x.classList.toggle('on', x === b));
    studio.classList.toggle('pro', pro); store.notify('doc');
  }));
  document.querySelectorAll(/** @type {'button'} */ ('.seg button')).forEach((x) => x.classList.toggle('on', x.dataset.mode === store.doc.settings.mode));

  // ── Transport ──
  $('btnPlay').onclick = () => player.toggle();
  $('btnPrev').onclick = () => { player.pause(); player.seek(store.ui.playhead - 1); };
  $('btnNext').onclick = () => { player.pause(); player.seek(store.ui.playhead + 1); };
  $('btnSafe').onclick = () => $('safe').classList.toggle('show');

  // ── Outils de timeline ──
  const cut = () => { const c = splitAt(store, store.ui.playhead, store.ui.selection); if (!c.length) toast('Rien à couper à la tête de lecture'); player.invalidate(); };
  const del = () => { if (!store.ui.selection.length) { toast('Sélectionnez un clip'); return; } deleteClips(store, store.ui.selection.slice(), store.doc.settings.ripple); player.refresh(); };
  const dup = () => { if (!store.ui.selection.length) { toast('Sélectionnez un clip'); return; } duplicateClips(store, store.ui.selection.slice()); };
  $('tCut').onclick = cut; $('tDel').onclick = del; $('tDup').onclick = dup;
  $('tSnap').onclick = () => { store.doc.settings.snap = !store.doc.settings.snap; store.notify('doc'); syncTools(); toast('Magnétisme ' + (store.doc.settings.snap ? 'activé' : 'désactivé')); };
  $('tRipple').onclick = () => { store.doc.settings.ripple = !store.doc.settings.ripple; store.notify('doc'); syncTools(); toast('Recalage (ripple) ' + (store.doc.settings.ripple ? 'activé' : 'désactivé')); };
  $('tRoll').onclick = () => { store.ui.roll = !store.ui.roll; syncTools(); toast('Roll ' + (store.ui.roll ? 'activé : ajuste le point de coupe entre deux clips' : 'désactivé')); };
  $('tMulti').onclick = () => { store.ui.multi = !store.ui.multi; syncTools(); toast('Sélection multiple ' + (store.ui.multi ? 'activée' : 'désactivée')); };
  $('tMark').onclick = () => { addMarker(store, store.ui.playhead); };
  $('tZin').onclick = () => timeline.zoomIn(); $('tZout').onclick = () => timeline.zoomOut(); $('tFit').onclick = () => timeline.fit();

  // ── Import ──
  const picker = $('filePicker');
  const doImport = (files) => {
    if (!files || !files.length) return;
    const ids = lib.ingest(files);
    toast(ids.length + ' fichier(s) en cours d\'analyse — en arrière-plan');
    requestPersistence();
  };
  document.querySelectorAll('[data-import]').forEach((b) => b.addEventListener('click', () => picker.click()));
  picker.addEventListener('change', () => { doImport(picker.files); picker.value = ''; });
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); $('dropHint').classList.add('show'); } });
  window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) $('dropHint').classList.remove('show'); });
  window.addEventListener('drop', (e) => { $('dropHint').classList.remove('show'); if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); doImport(e.dataTransfer.files); } });

  // ── Feuilles (mobile) ──
  const sheets = ['sheetSources', 'sheetVoice', 'sheetProps'];
  const toggleSheet = (id) => { sheets.forEach((s) => $(s).classList.toggle('open', s === id && !$(s).classList.contains('open'))); };
  // Onglets du panneau gauche (Sources / Voix) : sur ordinateur ils partagent la même colonne.
  const setActive = (id) => { for (const s of ['sheetSources', 'sheetVoice']) $(s).classList.toggle('active', s === id); };
  const showTab = (id) => {
    setActive(id);
    // Sur téléphone, un onglet touché dans une feuille ouverte ouvre l'autre feuille.
    if (!$(id).classList.contains('open') && sheets.some((s) => $(s).classList.contains('open'))) toggleSheet(id);
  };
  document.querySelectorAll(/** @type {'button'} */ ('[data-tab]')).forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.querySelectorAll(/** @type {'button'} */ ('[data-sheet]')).forEach((b) => b.addEventListener('click', () => { if (b.dataset.sheet !== 'sheetProps') setActive(b.dataset.sheet); toggleSheet(b.dataset.sheet); }));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('.sheet').classList.remove('open')));
  $('dCut').onclick = cut; $('dDel').onclick = del;

  // ── Cadrage en glissant sur l'aperçu ──
  let cg = null;
  frameEl.addEventListener('pointerdown', (e) => {
    const clip = player.videoClipAt(store.ui.playhead);
    if (!clip) return;
    const rec = lib.get(clip.srcId); if (!rec) return;
    const us = rec.letterbox.usable;
    const w = Math.min(us.w, (us.h * 9) / 16), free = us.w - w;
    if (free < 2) return;
    cg = { id: clip.id, x0: e.clientX, f0: clip.crop.mode === 'travel' ? clip.crop.travel.from : clip.crop.x, ratio: w / free, pid: e.pointerId, mode: clip.crop.mode };
    frameEl.setPointerCapture(e.pointerId);
  });
  frameEl.addEventListener('pointermove', (e) => {
    if (!cg || cg.pid !== e.pointerId) return;
    const dx = e.clientX - cg.x0; if (Math.abs(dx) < 2 && !store.inGesture) return;
    store.beginGesture('Cadrage');
    const c = findClip(store.doc, cg.id);
    const f = Math.max(0, Math.min(1, cg.f0 - (dx / frameEl.clientWidth) * cg.ratio));
    if (c.crop.mode === 'travel') c.crop.travel.from = f; else c.crop.x = f;
    player.redraw();
  });
  const endCg = (e) => { if (cg && cg.pid === e.pointerId) { cg = null; if (store.inGesture) store.endGesture(); } };
  frameEl.addEventListener('pointerup', endCg); frameEl.addEventListener('pointercancel', endCg);

  // ── Clavier (desktop) ──
  window.addEventListener('keydown', (e) => {
    if (/** @type {Element} */ (e.target).matches('input, textarea, select')) return;
    const k = e.key.toLowerCase(); const mod = e.ctrlKey || e.metaKey;
    const step = e.shiftKey ? store.doc.project.fps : 1;
    if (k === ' ') { e.preventDefault(); player.toggle(); }
    else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? $('btnRedo').click() : $('btnUndo').click(); }
    else if (mod && k === 'y') { e.preventDefault(); $('btnRedo').click(); }
    else if (mod && k === 'd') { e.preventDefault(); dup(); }
    else if (k === 'c' && !mod) cut();
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); del(); }
    else if (k === 'arrowleft') { e.preventDefault(); player.pause(); player.seek(store.ui.playhead - step); }
    else if (k === 'arrowright') { e.preventDefault(); player.pause(); player.seek(store.ui.playhead + step); }
    else if (k === 'home') player.seek(0);
    else if (k === 'end') player.seek(Math.max(0, totalFrames(store.doc) - 1));
    else if (k === 'k') player.pause();
    else if (k === 'l') player.play();
    else if (k === 'j') { player.seek(store.ui.playhead - store.doc.project.fps); }
    else if (k === 'i') { store.ui.inPoint = store.ui.playhead; if (store.ui.outPoint !== null && store.ui.outPoint <= store.ui.inPoint) store.ui.outPoint = null; timeline.render(); }
    else if (k === 'o') { store.ui.outPoint = store.ui.playhead; if (store.ui.inPoint !== null && store.ui.inPoint >= store.ui.outPoint) store.ui.inPoint = null; timeline.render(); }
    else if (k === 'm') addMarker(store, store.ui.playhead);
    else if (k === '+' || k === '=') timeline.zoomIn();
    else if (k === '-') timeline.zoomOut();
    else if (k === 'a' && mod) { e.preventDefault(); store.ui.selection = store.doc.clips.map((c) => c.id); timeline.render(); }
    else if (k === 'escape') { store.ui.selection = []; timeline.render(); }
  });

  // ── Sauvegarde automatique, stockage ──
  const saveEl = $('saveState');
  startAutosave(store, (s) => { saveEl.textContent = s === 'saved' ? 'Enregistré' : s === 'error' ? 'Sauvegarde impossible' : '…'; });
  usage().then((u) => { if (u.quota) $('storage').textContent = `Stockage local : ${(u.used / 1048576).toFixed(0)} Mo / ${(u.quota / 1048576 / 1024).toFixed(1)} Go`; });
  if (!opfsAvailable()) toast('Stockage privé indisponible : les fichiers ne seront pas conservés après fermeture.');

  // État initial de l'aperçu
  player.seek(store.ui.playhead);
  if (!lib.list.length) { if (matchMedia('(max-width: 899px)').matches) $('sheetSources').classList.add('open'); }
  $('boot').remove();
  window.__studioReady = true;
}

boot().catch((e) => { console.error(e); const b = $('boot'); if (b) b.textContent = 'Erreur de démarrage : ' + e.message; window.__studioError = e.message; });
