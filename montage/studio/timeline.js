// Timeline multipistes : rendu DOM + gestes (souris, tactile, pincement, appui long) + magnétisme.
// Le DOM n'est reconstruit qu'au changement de document ; pendant un geste on ne bouge que des styles,
// puis UN SEUL commit à la fin (un pas d'annulation).
import { clipEnd, findClip, totalFrames } from './edl.js';
import { applyMove, applyTrim, applySlip, splitAt, setTrackFlag } from './ops.js';
import { lintDoc } from './lint.js';

const MIN_PX = 6, MAX_PX = 700;
const LONGPRESS_MS = 280;

export function createTimeline({ store, lib, player, scrollEl, contentEl, toast, onSelect }) {
  const ui = store.ui;
  let g = null;                      // geste en cours
  const pointers = new Map();        // pointerId -> {x, y, type}
  let pinch = null;
  let lastTap = { t: 0, x: 0, y: 0, id: null };
  const snapLine = document.createElement('div'); snapLine.className = 'snapline';
  const playhead = document.createElement('div'); playhead.className = 'playhead';

  const doc = () => store.doc;
  const fps = () => store.doc.project.fps;
  const ppf = () => ui.pxPerSec / fps();
  const hdW = () => { const h = contentEl.querySelector('.hd'); return h ? h.offsetWidth : 44; };
  const frameFromX = (cx) => Math.max(0, Math.round((cx - contentEl.getBoundingClientRect().left - hdW()) / ppf()));

  // ── Rendu ──
  function lanePx() {
    const endF = Math.max(totalFrames(doc()), fps() * 10) + fps() * 6;
    const viewF = Math.ceil((scrollEl.clientWidth - hdW()) / ppf());
    return Math.max(endF, viewF) * ppf();
  }

  function tickStep() {
    const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    return steps.find((s) => s * ui.pxPerSec >= 72) || 60;
  }

  function drawWave(canvas, rec, clip) {
    const wf = rec && rec.waveform;
    if (!wf) return;
    const w = Math.max(1, Math.round(clip.dur * ppf())), h = canvas.clientHeight || 40;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    const t0 = clip.srcIn * wf.perSec, t1 = (clip.srcIn + clip.dur / fps()) * wf.perSec;
    for (let x = 0; x < w; x++) {
      const a = Math.floor(t0 + ((t1 - t0) * x) / w), b = Math.max(a + 1, Math.floor(t0 + ((t1 - t0) * (x + 1)) / w));
      let m = 0;
      for (let i = a; i < b && i < wf.peaks.length; i++) if (wf.peaks[i] > m) m = wf.peaks[i];
      const bar = Math.max(1, Math.min(1, m) * h * 0.9);
      ctx.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }

  function render() {
    const d = doc(), P = ppf();
    const issues = lintDoc(d, (id) => lib.get(id));
    const byClip = new Map();
    for (const i of issues) { if (!byClip.has(i.clipId)) byClip.set(i.clipId, []); byClip.get(i.clipId).push(i); }
    const W = Math.round(lanePx());
    contentEl.style.width = (W + hdW()) + 'px';
    contentEl.innerHTML = '';

    // règle
    const ruler = document.createElement('div'); ruler.className = 'row ruler';
    ruler.innerHTML = '<div class="hd"></div>';
    const rl = document.createElement('div'); rl.className = 'lane'; rl.style.width = W + 'px';
    const step = tickStep();
    for (let s = 0; s * ui.pxPerSec <= W; s += step) {
      const t = document.createElement('span'); t.className = 'tick'; t.style.left = (s * ui.pxPerSec) + 'px';
      const mm = Math.floor(s / 60), ss = s % 60;
      t.textContent = step < 1 ? (mm + ':' + ss.toFixed(2).padStart(5, '0')) : (mm + ':' + String(Math.round(ss)).padStart(2, '0'));
      rl.appendChild(t);
    }
    if (P >= 5) for (let f = 0; f * P <= W; f += 5) if (f % fps() !== 0) { const t = document.createElement('span'); t.className = 'tick minor'; t.style.left = (f * P) + 'px'; rl.appendChild(t); }
    for (const m of d.markers) { const mk = document.createElement('span'); mk.className = 'marker'; mk.style.left = (m.frame * P) + 'px'; mk.dataset.frame = m.frame; rl.appendChild(mk); }
    if (ui.inPoint !== null || ui.outPoint !== null) {
      const a = (ui.inPoint ?? 0) * P, b = (ui.outPoint ?? totalFrames(d)) * P;
      const band = document.createElement('div'); band.style.cssText = `position:absolute;left:${a}px;width:${Math.max(2, b - a)}px;top:0;height:5px;background:var(--warn);opacity:.9;pointer-events:none`;
      rl.appendChild(band);
    }
    ruler.appendChild(rl); contentEl.appendChild(ruler);

    // pistes
    for (const tr of d.tracks) {
      const row = document.createElement('div'); row.className = 'row'; row.dataset.track = tr.id;
      const hd = document.createElement('div'); hd.className = 'hd';
      hd.innerHTML = `<span class="nm">${tr.name}</span><span class="mini"><button data-flag="locked" class="${tr.locked ? 'on' : ''}" aria-label="Verrouiller ${tr.name}" title="Verrouiller">${tr.locked ? '🔒' : '🔓'}</button><button data-flag="muted" class="${tr.muted ? 'on' : ''}" aria-label="Muet ${tr.name}" title="Muet">M</button><button data-flag="solo" class="${tr.solo ? 'on' : ''}" aria-label="Solo ${tr.name}" title="Solo">S</button></span>`;
      const lane = document.createElement('div'); lane.className = 'lane h-' + tr.id.toLowerCase(); lane.style.width = W + 'px';
      if (tr.muted) lane.style.opacity = '.45';
      for (const c of d.clips.filter((x) => x.track === tr.id)) lane.appendChild(clipEl(c, tr, byClip.get(c.id), P));
      row.appendChild(hd); row.appendChild(lane); contentEl.appendChild(row);
    }
    contentEl.appendChild(snapLine);
    contentEl.appendChild(playhead);
    updatePlayhead(false);
    if (onSelect) onSelect();
  }

  function clipEl(c, tr, issues, P) {
    const el = document.createElement('div');
    const aud = tr.id.startsWith('A');
    el.className = 'clip ' + tr.id.toLowerCase() + (ui.selection.includes(c.id) ? ' sel' : '');
    el.dataset.id = c.id;
    el.style.left = (c.start * P) + 'px'; el.style.width = Math.max(4, c.dur * P) + 'px';
    const rec = lib.get(c.srcId);
    if (tr.id === 'V1' && rec) {
      const shotIdx = (rec.shots || []).findIndex((s) => c.srcIn >= s.start - 1e-3 && c.srcIn < s.end);
      const url = shotIdx >= 0 ? lib.thumbUrl(rec.id, shotIdx) : null;
      if (url) { const t = document.createElement('div'); t.className = 'thumbs'; t.style.cssText = `background:url(${url}) left center/auto 100% repeat-x;opacity:.8;`; el.appendChild(t); }
    }
    if (aud && rec) { const cv = document.createElement('canvas'); cv.className = 'wave'; el.appendChild(cv); requestAnimationFrame(() => drawWave(cv, rec, c)); el.classList.add('a1'); }
    const nm = document.createElement('span'); nm.className = 'nm';
    nm.textContent = tr.id === 'V1' ? (doc().clips.filter((x) => x.track === 'V1').sort((a, b) => a.start - b.start).findIndex((x) => x.id === c.id) + 1) + ' · ' + (c.dur / fps()).toFixed(1).replace('.', ',') + ' s' : (rec ? rec.name : '');
    if (c.dur * P > 36) el.appendChild(nm);
    if (issues && issues.length) { const b = document.createElement('span'); b.className = 'badge' + (issues.some((i) => i.level === 'err') ? ' err' : ''); b.textContent = issues.length > 1 ? issues.length : '!'; el.appendChild(b); }
    if (!tr.locked) {
      for (const side of ['l', 'r']) { const h = document.createElement('div'); h.className = 'h ' + side; h.dataset.side = side.toUpperCase(); el.appendChild(h); }
    }
    return el;
  }

  function updatePlayhead(follow = true) {
    const x = hdW() + ui.playhead * ppf();
    playhead.style.left = x + 'px';
    if (follow && ui.playing) {
      const vx = x - scrollEl.scrollLeft;
      if (vx > scrollEl.clientWidth - 70 || vx < hdW()) scrollEl.scrollLeft = x - hdW() - 40;
    }
  }

  // ── Magnétisme ──
  function snapPoints(excludeIds) {
    const pts = new Set([0, ui.playhead]);
    for (const c of doc().clips) if (!excludeIds.includes(c.id)) { pts.add(c.start); pts.add(clipEnd(c)); }
    for (const m of doc().markers) pts.add(m.frame);
    if (ui.inPoint !== null) pts.add(ui.inPoint);
    if (ui.outPoint !== null) pts.add(ui.outPoint);
    return Array.from(pts);
  }
  function snap(frames, pts, thr) {
    if (!doc().settings.snap) return { delta: 0, at: null };
    let best = null;
    for (const f of frames) for (const p of pts) { const dd = p - f; if (Math.abs(dd) <= thr && (!best || Math.abs(dd) < Math.abs(best.delta))) best = { delta: dd, at: p }; }
    return best || { delta: 0, at: null };
  }
  function showSnap(at) { if (at === null) { snapLine.style.display = 'none'; return; } snapLine.style.display = 'block'; snapLine.style.left = (hdW() + at * ppf()) + 'px'; }

  // ── Sélection ──
  function select(id, additive) {
    if (!id) { ui.selection = []; }
    else if (additive || ui.multi) ui.selection = ui.selection.includes(id) ? ui.selection.filter((x) => x !== id) : [...ui.selection, id];
    else ui.selection = [id];
    render();
  }

  // ── Menu de piste (mobile) ──
  let trackMenu = null;
  function closeTrackMenu() { if (trackMenu) { trackMenu.remove(); trackMenu = null; } }
  function openTrackMenu(trackId, anchor) {
    closeTrackMenu();
    const tr = doc().tracks.find((x) => x.id === trackId);
    const m = document.createElement('div'); m.className = 'trackmenu';
    m.innerHTML = `<div class="tm-t">Piste ${tr.name} · ${tr.label}</div>
      <button data-flag="locked">${tr.locked ? '🔒 Déverrouiller' : '🔓 Verrouiller'}</button>
      <button data-flag="muted">${tr.muted ? '🔇 Réactiver' : '🔈 Muet'}</button>
      <button data-flag="solo">${tr.solo ? '★ Retirer le solo' : '☆ Solo'}</button>`;
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.right + 6, innerWidth - 190) + 'px';
    m.style.top = Math.max(8, Math.min(r.top, innerHeight - 190)) + 'px';
    m.addEventListener('click', (ev) => { const b = /** @type {HTMLElement} */ (ev.target).closest('button[data-flag]'); if (b instanceof HTMLElement) { setTrackFlag(store, trackId, b.dataset.flag); closeTrackMenu(); } });
    document.body.appendChild(m); trackMenu = m;
    setTimeout(() => document.addEventListener('pointerdown', (ev) => { if (trackMenu && !trackMenu.contains(/** @type {Node} */ (ev.target))) closeTrackMenu(); }, { once: true, capture: true }), 0);
  }

  // ── Zoom ──
  function setZoom(px, anchorClientX) {
    const old = ppf();
    const ax = anchorClientX ?? (scrollEl.getBoundingClientRect().left + scrollEl.clientWidth / 2);
    const anchorFrame = (ax - contentEl.getBoundingClientRect().left - hdW()) / old;
    ui.pxPerSec = Math.max(MIN_PX, Math.min(MAX_PX, px));
    render();
    scrollEl.scrollLeft += (hdW() + anchorFrame * ppf()) - (ax - contentEl.getBoundingClientRect().left);
    store.notify('zoom');
  }
  function fit() {
    const total = Math.max(totalFrames(doc()) / fps(), 5);
    setZoom(((scrollEl.clientWidth - hdW() - 24) / total), undefined); scrollEl.scrollLeft = 0;
  }

  // ── Gestes ──
  function liveShift(ids, dpx) {
    for (const id of ids) { const el = contentEl.querySelector(`.clip[data-id="${id}"]`); if (el) el.style.transform = `translateX(${dpx}px)`; }
  }

  contentEl.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    const touchCount = Array.from(pointers.values()).filter((p) => p.type === 'touch').length;
    if (touchCount === 2) { // pincement : zoom
      cancelGesture();
      const [a, b] = Array.from(pointers.values());
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), px0: ui.pxPerSec };
      return;
    }
    const flagBtn = e.target.closest('button[data-flag]');
    if (flagBtn) { const row = flagBtn.closest('.row'); setTrackFlag(store, row.dataset.track, flagBtn.dataset.flag); return; }
    const mk = e.target.closest('.marker');
    if (mk) { player.seek(Number(mk.dataset.frame)); return; }
    const hd = e.target.closest('.hd');
    if (hd) { // petit écran : les réglages de piste s'ouvrent dans un menu aux grandes cibles tactiles
      const row = hd.closest('.row');
      if (row && row.dataset.track && matchMedia('(max-width: 899px)').matches) openTrackMenu(row.dataset.track, hd);
      return;
    }

    const handle = e.target.closest('.h');
    const clipNode = e.target.closest('.clip');
    const ruler = e.target.closest('.row.ruler');
    const t0 = performance.now();

    if (handle && clipNode) {
      const id = clipNode.dataset.id;
      if (!ui.selection.includes(id)) { ui.selection = [id]; clipNode.classList.add('sel'); }
      g = { type: 'trim', side: handle.dataset.side, id, startX: e.clientX, pid: e.pointerId, pts: snapPoints([id]), delta: 0, el: clipNode, o: { ...findClip(doc(), id) }, alt: e.altKey };
      store.beginGesture('Ajuster'); contentEl.setPointerCapture(e.pointerId); e.preventDefault(); return;
    }
    if (clipNode) {
      const id = clipNode.dataset.id;
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      const wasSel = ui.selection.includes(id);
      g = { type: 'move', id, startX: e.clientX, startY: e.clientY, pid: e.pointerId, t0, tap: true, additive, wasSel, touch: e.pointerType !== 'mouse', delta: 0, armed: e.pointerType === 'mouse', grab: false, slip: e.altKey && e.shiftKey, roll: e.altKey };
      if (g.touch) {
        g.timer = setTimeout(() => {
          if (!g || g.moved) return;
          if (!ui.selection.includes(id)) { ui.selection = [id]; render(); }
          g.grab = true; g.armed = true; g.tap = false;
          const el = contentEl.querySelector(`.clip[data-id="${id}"]`); if (el) el.classList.add('grab');
          if (navigator.vibrate) navigator.vibrate(12);
        }, LONGPRESS_MS);
      } else {
        if (!wasSel && !additive && !ui.multi) { ui.selection = [id]; contentEl.querySelectorAll('.clip.sel').forEach((n) => n.classList.remove('sel')); clipNode.classList.add('sel'); }
        g.pts = snapPoints(ui.selection.includes(id) ? ui.selection : [id]);
        contentEl.setPointerCapture(e.pointerId);
      }
      return;
    }
    if (ruler || e.target.closest('.lane')) {
      g = { type: 'scrub', pid: e.pointerId, startX: e.clientX, startY: e.clientY, touch: e.pointerType !== 'mouse', ruler: !!ruler, moved: false, tapFrame: frameFromX(e.clientX) };
      if (!g.touch || g.ruler) { player.seek(g.tapFrame); contentEl.setPointerCapture(e.pointerId); }
      if (!g.touch && !g.ruler) { ui.selection = []; render(); }
    }
  });

  contentEl.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (pinch) {
      const [a, b] = Array.from(pointers.values());
      if (b) { const d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch.d0 > 0) setZoom(pinch.px0 * (d / pinch.d0), (a.x + b.x) / 2); }
      return;
    }
    if (!g || g.pid !== e.pointerId) return;
    const dx = e.clientX - g.startX, dy = e.clientY - (g.startY ?? e.clientY);

    if (g.type === 'scrub') {
      if (g.touch && !g.ruler) { return; }               // le tactile fait défiler nativement
      g.moved = true; player.seek(frameFromX(e.clientX)); return;
    }
    if (g.type === 'trim') {
      let d = Math.round(dx / ppf());
      const o = g.o;
      const edge = g.side === 'L' ? o.start + d : clipEnd(o) + d;
      const s = snap([edge], g.pts, Math.max(1, Math.round(8 / ppf())));
      d += s.delta; showSnap(s.at);
      g.delta = d;
      const P = ppf();
      if (g.side === 'L') { g.el.style.left = ((o.start + d) * P) + 'px'; g.el.style.width = Math.max(4, (o.dur - d) * P) + 'px'; }
      else g.el.style.width = Math.max(4, (o.dur + d) * P) + 'px';
      return;
    }
    if (g.type === 'move') {
      if (!g.armed) {
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) { g.moved = true; clearTimeout(g.timer); }   // le navigateur défile : on abandonne l'appui long
        return;
      }
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) g.moved = true;
      if (!g.moved) return;
      g.tap = false;
      const ids = ui.selection.includes(g.id) ? ui.selection : [g.id];
      if (!g.pts) g.pts = snapPoints(ids);
      store.beginGesture('Déplacer');
      let d = Math.round(dx / ppf());
      const c0 = findClip(doc(), g.id);
      if (g.slip || (e.altKey && e.shiftKey)) { g.slipDelta = d; liveShift([g.id], 0); return; }
      const s = snap([c0.start + d, clipEnd(c0) + d], g.pts, Math.max(1, Math.round(8 / ppf())));
      d += s.delta; showSnap(s.at);
      g.delta = d; g.ids = ids;
      liveShift(ids, d * ppf());
    }
  });

  const finish = (e) => {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    if (!g || g.pid !== e.pointerId) return;
    clearTimeout(g.timer);
    const gg = g; g = null; showSnap(null);
    try { contentEl.releasePointerCapture(e.pointerId); } catch (err) { /* déjà relâché */ }
    if (e.type === 'pointercancel') { store.cancelGesture(); render(); return; }

    if (gg.type === 'scrub') {
      if (gg.touch && !gg.ruler && !gg.moved) { player.seek(gg.tapFrame); ui.selection = []; render(); }
      return;
    }
    if (gg.type === 'trim') {
      store.endGesture();
      const ok = applyTrim(store, lib, gg.id, gg.side, gg.delta, { roll: e.altKey || ui.roll, ripple: doc().settings.ripple });
      if (!ok && gg.delta) toast('Limite atteinte (source ou clip voisin)');
      player.invalidate(); player.seek(gg.side === 'L' ? findClip(doc(), gg.id).start : clipEnd(findClip(doc(), gg.id)) - 1);
      render(); return;
    }
    if (gg.type === 'move') {
      const wasGesture = store.inGesture;
      if (wasGesture) store.endGesture();
      if (gg.tap && !gg.moved) {
        const now = performance.now();
        const dbl = lastTap.id === gg.id && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24;
        lastTap = { t: now, x: e.clientX, y: e.clientY, id: gg.id };
        if (dbl) { // double-tap : couper à la tête de lecture (ou à l'endroit touché si elle est hors du clip)
          const c = findClip(doc(), gg.id);
          let f = ui.playhead;
          if (!(f > c.start && f < clipEnd(c))) { f = frameFromX(e.clientX); player.seek(f); }
          splitAt(store, f, [gg.id]); player.invalidate(); render(); return;
        }
        select(gg.id, gg.additive);
        const c = findClip(doc(), gg.id);
        if (c && (ui.playhead < c.start || ui.playhead >= clipEnd(c))) player.seek(c.start);
        else player.refresh();
        return;
      }
      if (gg.slip || (e.altKey && e.shiftKey)) {
        applySlip(store, lib, gg.id, -Math.round((e.clientX - gg.startX) / ppf())); player.invalidate(); player.refresh(); render(); return;
      }
      const ids = gg.ids || [gg.id];
      if (gg.delta) {
        const ok = applyMove(store, ids, gg.delta, doc().settings.ripple);
        if (!ok) toast('Pas de place ici : le clip reste où il était');
      }
      render(); player.refresh();
    }
  };
  contentEl.addEventListener('pointerup', finish);
  contentEl.addEventListener('pointercancel', finish);

  contentEl.addEventListener('dblclick', (e) => {
    const clipNode = e.target.closest('.clip');
    if (!clipNode || e.pointerType === 'touch') return;
    const id = clipNode.dataset.id; const c = findClip(doc(), id);
    let f = ui.playhead;
    if (!(f > c.start && f < clipEnd(c))) { f = frameFromX(e.clientX); player.seek(f); }
    splitAt(store, f, [id]); player.invalidate(); render();
  });

  // Empêche le défilement natif uniquement pendant un geste actif (appui long, pincement, poignée).
  scrollEl.addEventListener('touchmove', (ev) => { if ((g && (g.grab || g.type === 'trim')) || pinch) ev.preventDefault(); }, { passive: false });
  scrollEl.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(ui.pxPerSec * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX); } }, { passive: false });

  function cancelGesture() { if (g) { clearTimeout(g.timer); if (store.inGesture) store.cancelGesture(); g = null; showSnap(null); render(); } }

  store.subscribe((kind) => {
    if (kind === 'doc' || kind === 'zoom-refresh') render();
    else if (kind === 'playhead') updatePlayhead(true);
  });
  new ResizeObserver(() => { if (!g) render(); }).observe(scrollEl);

  render();
  return { render, setZoom, fit, zoomIn: () => setZoom(ui.pxPerSec * 1.4), zoomOut: () => setZoom(ui.pxPerSec / 1.4), select, frameFromX, updatePlayhead };
}
