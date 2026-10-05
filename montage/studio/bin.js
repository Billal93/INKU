// Panneau Sources : import multiple, bandes de plans (vignettes), plans utilisés, recherche/filtres,
// ajout par « + », glisser-déposer vers la timeline, visionneuse de portion d'un plan.
import { intervalUsage, fmtTime } from './edl.js';
import { addToV1, addAudio } from './ops.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const STAGES = { queued: 'En attente', copy: 'Copie locale…', probe: 'Lecture…', letterbox: 'Bandes noires…', shots: 'Détection des plans…', thumbs: 'Vignettes…', wave: 'Forme d\'onde…', done: 'Prêt' };
const fmtDur = (s) => { const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };

export function createBin({ el, store, lib, player, toast, timeline }) {
  const filters = { q: '', unused: false, min1: false, hideBlack: true };
  let openViewer = null; // { srcId, idx, in, out, t }

  el.innerHTML = `
    <div class="bin-filters" style="display:flex;flex-wrap:wrap;margin:-3px 0 8px">
      <input type="search" id="binQ" placeholder="Rechercher…" aria-label="Rechercher une source" style="flex:1 1 120px;margin:3px;font-size:16px;padding:8px 10px;border-radius:9px;border:1px solid var(--line);background:var(--panel2);color:var(--text)">
      <label class="chip" style="margin:3px"><input type="checkbox" id="fUnused"> Non utilisés</label>
      <label class="chip" style="margin:3px"><input type="checkbox" id="fMin1"> ≥ 1 s</label>
      <label class="chip" style="margin:3px"><input type="checkbox" id="fBlack" checked> Sans noirs</label>
    </div>
    <div id="binList"></div>
    <div class="empty" id="binEmpty">Importez vos trailers, extraits et audios (sélection multiple ou glisser-déposer).<br>Ils restent sur cet appareil.</div>`;
  const list = el.querySelector('#binList'), empty = el.querySelector('#binEmpty');
  el.querySelector('#binQ').addEventListener('input', (e) => { filters.q = e.target.value.toLowerCase(); renderAll(); });
  el.querySelector('#fUnused').addEventListener('change', (e) => { filters.unused = e.target.checked; renderAll(); });
  el.querySelector('#fMin1').addEventListener('change', (e) => { filters.min1 = e.target.checked; renderAll(); });
  el.querySelector('#fBlack').addEventListener('change', (e) => { filters.hideBlack = e.target.checked; renderAll(); });

  const blocks = new Map();

  function shotUsed(rec, s) { return intervalUsage(store.doc, rec.id, s.start, s.end).length > 0; }

  function buildBlock(rec) {
    const b = document.createElement('div'); b.className = 'src'; b.dataset.id = rec.id;
    const analyzing = rec.status === 'analyzing' || rec.status === 'queued';
    const meta = rec.status === 'ready'
      ? (rec.kind === 'video' ? `${fmtDur(rec.duration)} · ${rec.shots.length} plans · bandes ${rec.letterbox.top}/${rec.letterbox.bottom} px` : `${fmtDur(rec.duration)} · audio`)
      : rec.status === 'error' ? `<span style="color:var(--err)">${esc(rec.error || 'Erreur')}</span>` : esc(STAGES[rec.stage] || '…');
    const proxy = rec.kind === 'video' && rec.status === 'ready' ? (rec.proxy === 'ready' ? ' · proxy ✓' : rec.proxy === 'building' ? ` · proxy ${Math.round((rec.proxyProgress || 0) * 100)} %` : rec.proxy === 'queued' ? ' · proxy en attente' : rec.proxy === 'error' ? ' · proxy ✗ (originaux utilisés)' : '') : '';
    b.innerHTML = `<div class="src-h"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(rec.name)}</span><small>${meta}${proxy}</small><span class="sp"></span>${rec.status === 'error' ? '<button class="ibtn" data-act="retry" aria-label="Relancer l\'analyse" style="min-width:36px;min-height:34px">↻</button>' : ''}<button class="ibtn" data-act="remove" aria-label="Supprimer la source" style="min-width:36px;min-height:34px">✕</button></div>
      <div class="prog"><i style="width:${Math.round((analyzing ? rec.progress : rec.proxy === 'building' ? (rec.proxyProgress || 0) : 1) * 100)}%"></i></div>`;
    if (rec.status === 'ready' && rec.kind === 'video') {
      const strip = document.createElement('div'); strip.className = 'strip';
      rec.shots.forEach((s, i) => {
        const len = s.end - s.start;
        if (filters.min1 && len < 1) return;
        if (filters.hideBlack && s.black) return;
        const used = shotUsed(rec, s);
        if (filters.unused && used) return;
        const d = document.createElement('div'); d.className = 'shot' + (used ? ' used' : ''); d.dataset.idx = i; d.dataset.src = rec.id;
        const url = lib.thumbUrl(rec.id, i);
        d.innerHTML = `${url ? `<img alt="" src="${url}" draggable="false">` : '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">'}<span class="meta">${len.toFixed(1).replace('.', ',')} s</span><button class="add" aria-label="Ajouter à la timeline" data-act="add">+</button>`;
        strip.appendChild(d);
      });
      if (!strip.children.length) strip.innerHTML = '<div class="empty" style="padding:8px">Aucun plan avec ces filtres.</div>';
      b.appendChild(strip);
      if (openViewer && openViewer.srcId === rec.id) b.appendChild(viewerEl(rec));
    }
    if (rec.status === 'ready' && rec.kind === 'audio') {
      const row = document.createElement('div'); row.style.cssText = 'display:flex;flex-wrap:wrap;margin:4px -3px 0';
      for (const [tr, lab] of [['A1', 'Voix (A1)'], ['A2', 'Musique (A2)'], ['A3', 'SFX (A3)']]) row.insertAdjacentHTML('beforeend', `<button class="bigbtn sec" style="flex:1 1 90px;margin:3px;min-height:40px;font-size:.7rem" data-act="audio" data-track="${tr}">${lab}</button>`);
      b.appendChild(row);
    }
    return b;
  }

  function viewerEl(rec) {
    const v = openViewer; const shot = rec.shots[v.idx];
    const w = document.createElement('div'); w.className = 'viewer'; w.style.cssText = 'background:var(--panel2);border-radius:12px;padding:8px;margin-top:6px';
    w.innerHTML = `<canvas width="320" height="180" style="width:100%;border-radius:8px;background:#000;display:block"></canvas>
      <input type="range" min="0" max="1000" value="${Math.round(((v.t - shot.start) / (shot.end - shot.start)) * 1000)}" style="width:100%;margin-top:6px" aria-label="Parcourir le plan">
      <div style="display:flex;align-items:center;flex-wrap:wrap;font-size:.72rem;font-weight:700;margin-top:4px">
        <button class="bigbtn sec" data-act="vin" style="flex:1 1 80px;margin:3px;min-height:38px;font-size:.68rem">Début ▸</button>
        <button class="bigbtn sec" data-act="vout" style="flex:1 1 80px;margin:3px;min-height:38px;font-size:.68rem">◂ Fin</button>
        <button class="bigbtn" data-act="vadd" style="flex:1 1 110px;margin:3px;min-height:38px;font-size:.68rem">Ajouter la portion</button>
      </div><div class="vinfo" style="color:var(--muted);font-size:.7rem;margin:2px 4px"></div>`;
    setTimeout(() => paintViewer(w, rec), 0);
    return w;
  }

  async function paintViewer(w, rec) {
    const v = openViewer; if (!v) return;
    const cv = w.querySelector('canvas'); const ctx = cv.getContext('2d');
    const fo = await player.frameAt(rec.id, v.t);
    if (fo) {
      const us = rec.letterbox.usable;
      if (fo.h.kind === 'proxy') ctx.drawImage(fo.canvas, 0, 0, fo.canvas.width, fo.canvas.height, 0, 0, 320, 180);
      else ctx.drawImage(fo.canvas, us.x, us.y, us.w, us.h, 0, 0, 320, 180);
    }
    const info = w.querySelector('.vinfo');
    const i = v.in ?? rec.shots[v.idx].start, o = v.out ?? rec.shots[v.idx].end;
    info.textContent = `Position ${v.t.toFixed(2).replace('.', ',')} s · portion ${i.toFixed(2).replace('.', ',')} → ${o.toFixed(2).replace('.', ',')} s (${(o - i).toFixed(2).replace('.', ',')} s)`;
  }

  function renderBlock(rec) {
    const nb = buildBlock(rec);
    const old = blocks.get(rec.id);
    if (old && old.parentNode) old.replaceWith(nb); else list.appendChild(nb);
    blocks.set(rec.id, nb);
  }

  function renderAll() {
    list.innerHTML = ''; blocks.clear();
    const recs = lib.list.filter((r) => !filters.q || r.name.toLowerCase().includes(filters.q));
    for (const r of recs) renderBlock(r);
    empty.style.display = lib.list.length ? 'none' : 'block';
  }

  // Mises à jour : progression seule -> petite mise à jour ; sinon reconstruction du bloc concerné.
  const lastKey = new Map();
  let raf = 0; const dirty = new Set();
  lib.addEventListener('change', (e) => {
    const id = e.detail.id;
    if (!id) { renderAll(); return; }
    dirty.add(id);
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      for (const did of dirty) {
        const rec = lib.get(did);
        if (!rec) { renderAll(); continue; }
        const key = rec.status + ':' + rec.stage + ':' + rec.proxy + ':' + (rec.shots ? rec.shots.length : 0) + ':' + Math.round((rec.proxyProgress || 0) * 20) + ':' + (rec.error || '');
        const blk = blocks.get(did);
        if (blk && lastKey.get(did) === key && (rec.status === 'analyzing' || rec.proxy === 'building')) {
          const i = blk.querySelector('.prog i'); if (i) i.style.width = Math.round(((rec.status === 'analyzing' ? rec.progress : (rec.proxyProgress || 0))) * 100) + '%';
        } else renderBlock(rec);
        lastKey.set(did, key);
      }
      dirty.clear();
      empty.style.display = lib.list.length ? 'none' : 'block';
    });
  });
  store.subscribe((kind) => { if (kind === 'doc') refreshUsed(); });
  function refreshUsed() {
    for (const [id, blk] of blocks) {
      const rec = lib.get(id); if (!rec || rec.kind !== 'video') continue;
      blk.querySelectorAll('.shot').forEach((sh) => { const s = rec.shots[Number(sh.dataset.idx)]; if (s) sh.classList.toggle('used', shotUsed(rec, s)); });
    }
    if (filters.unused) renderAll();
  }

  function add(srcId, idx, range, atFrame = null) {
    const rec = lib.get(srcId);
    const a = range ? range.start : rec.shots[idx].start, b = range ? range.end : rec.shots[idx].end;
    const before = intervalUsage(store.doc, srcId, a, b).length;
    const id = addToV1(store, lib, srcId, { shotIdx: idx, range, atFrame });
    if (!id) { toast("Impossible d'ajouter ce plan"); return; }
    const c = store.doc.clips.find((x) => x.id === id);
    player.invalidate(); player.seek(c.start);
    toast(before ? `Ajouté en ${fmtTime(c.start)} — attention : passage déjà utilisé` : `Ajouté en ${fmtTime(c.start)}`);
  }

  // ── Interactions ──
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    const blk = e.target.closest('.src'); const srcId = blk && blk.dataset.id;
    if (act) {
      const a = act.dataset.act;
      if (a === 'remove') { if (confirm('Supprimer cette source de la bibliothèque ?')) { const used = store.doc.clips.some((c) => c.srcId === srcId); if (used) toast('Cette source est utilisée dans la timeline : ses clips deviendront introuvables.'); lib.remove(srcId); } return; }
      if (a === 'retry') { lib.reanalyze(srcId); return; }
      if (a === 'add') { const sh = e.target.closest('.shot'); add(srcId, Number(sh.dataset.idx)); e.stopPropagation(); return; }
      if (a === 'audio') { const id = addAudio(store, lib, srcId, act.dataset.track, act.dataset.track === 'A1' ? 0 : store.ui.playhead); toast(id ? 'Audio placé sur ' + act.dataset.track : 'Impossible'); player.invalidate(); return; }
      if (openViewer) {
        const rec = lib.get(openViewer.srcId);
        if (a === 'vin') { openViewer.in = openViewer.t; if (openViewer.out !== null && openViewer.out <= openViewer.in) openViewer.out = null; paintViewer(blk.querySelector('.viewer'), rec); return; }
        if (a === 'vout') { openViewer.out = openViewer.t; if (openViewer.in !== null && openViewer.in >= openViewer.out) openViewer.in = null; paintViewer(blk.querySelector('.viewer'), rec); return; }
        if (a === 'vadd') { const sh = rec.shots[openViewer.idx]; const i = openViewer.in ?? sh.start + 0.1, o = openViewer.out ?? Math.min(sh.end - 0.1, i + 2.5); if (o - i < 0.1) { toast('Portion trop courte'); return; } add(rec.id, openViewer.idx, { start: i, end: o }); return; }
      }
    }
    const shot = e.target.closest('.shot');
    if (shot && !e.target.closest('.add')) {
      const idx = Number(shot.dataset.idx); const rec = lib.get(shot.dataset.src);
      if (openViewer && openViewer.srcId === rec.id && openViewer.idx === idx) openViewer = null;
      else { const s = rec.shots[idx]; openViewer = { srcId: rec.id, idx, t: s.start + 0.1, in: null, out: null }; }
      renderBlock(rec);
    }
  });
  el.addEventListener('input', (e) => {
    if (e.target.matches('.viewer input[type=range]') && openViewer) {
      const rec = lib.get(openViewer.srcId); const s = rec.shots[openViewer.idx];
      openViewer.t = s.start + (Number(e.target.value) / 1000) * (s.end - s.start - 0.05);
      paintViewer(e.target.closest('.viewer'), rec);
    }
  });

  // Glisser un plan vers V1 (souris : immédiat ; tactile : appui long). Sur mobile on préfère « + ».
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    const sh = e.target.closest('.shot'); if (!sh || e.target.closest('.add')) return;
    drag = { sh, startX: e.clientX, startY: e.clientY, pid: e.pointerId, active: false, touch: e.pointerType !== 'mouse' };
    if (drag.touch) drag.timer = setTimeout(() => { if (drag) beginDrag(e); }, 320);
  });
  function beginDrag(e) {
    drag.active = true;
    const g = document.createElement('div'); g.className = 'ghost';
    const img = drag.sh.querySelector('img'); g.style.backgroundImage = `url(${img.src})`;
    document.body.appendChild(g); drag.ghost = g;
    if (navigator.vibrate) navigator.vibrate(10);
  }
  window.addEventListener('pointermove', (e) => {
    if (!drag || drag.pid !== e.pointerId) return;
    if (!drag.active) {
      if (!drag.touch && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 6) beginDrag(e);
      else if (drag.touch && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 10) { clearTimeout(drag.timer); drag = null; }
      return;
    }
    drag.ghost.style.left = (e.clientX - 48) + 'px'; drag.ghost.style.top = (e.clientY - 27) + 'px';
    e.preventDefault();
  }, { passive: false });
  window.addEventListener('pointerup', (e) => {
    if (!drag || drag.pid !== e.pointerId) return;
    clearTimeout(drag.timer);
    const d = drag; drag = null;
    if (!d.active) return;
    d.ghost.remove();
    d.sh.dataset.justDragged = '1'; setTimeout(() => delete d.sh.dataset.justDragged, 50);
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const lane = under && under.closest('.row[data-track="V1"] .lane');
    if (lane) add(d.sh.dataset.src, Number(d.sh.dataset.idx), null, timeline.frameFromX(e.clientX));
    else toast('Déposez sur la piste V1');
  });
  renderAll();
  return { renderAll, add };
}
