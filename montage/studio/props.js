// Panneau Propriétés contextuel + liste des alertes (linting).
import { findClip, clipEnd, fmtTime, totalFrames } from './edl.js';
import { applyTrim, applySlip, pasteAttrs, deleteClips, duplicateClips, splitAt, applyFix } from './ops.js';
import { lintDoc } from './lint.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fr = (n, d = 1) => Number(n).toFixed(d).replace('.', ',');

export function createProps({ el, titleEl, store, lib, player, timeline, toast }) {
  const ui = store.ui;
  const doc = () => store.doc;

  function lintHtml(issues, global) {
    if (!issues.length) return `<div class="empty" style="padding:12px">${global ? 'Aucune alerte. Les règles de la méthode sont respectées.' : 'Aucune alerte sur ce clip.'}</div>`;
    return issues.map((i) => `<div class="lint ${i.level === 'err' ? 'err' : ''}" data-clip="${i.clipId}"><span class="sp">${esc(i.msg)}</span>${i.fix ? `<button data-fix="${i.id}">Corriger</button>` : ''}</div>`).join('');
  }

  function render() {
    const d = doc();
    const issues = lintDoc(d, (id) => lib.get(id));
    const sel = ui.selection.map((id) => findClip(d, id)).filter(Boolean);
    const fps = d.project.fps;
    let html = '';

    if (sel.length === 1) {
      const c = sel[0];
      const rec = lib.get(c.srcId);
      const isV = c.track === 'V1';
      const n = isV ? d.clips.filter((x) => x.track === 'V1').sort((a, b) => a.start - b.start).findIndex((x) => x.id === c.id) + 1 : '';
      titleEl.textContent = (isV ? 'Clip ' + n : (rec ? rec.name : 'Clip')) + ' · ' + c.track;
      html += `<div class="field"><label>Début</label><input type="text" value="${fmtTime(c.start, fps)}" readonly></div>
        <div class="field"><label for="pDur">Durée (s)</label><input id="pDur" type="number" step="0.1" min="0.04" value="${fr(c.dur / fps, 2).replace(',', '.')}"></div>
        <div class="field"><label>Source</label><span style="font-size:.74rem;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${rec ? esc(rec.name) : '—'}</span></div>
        <div class="field pro-only"><label for="pIn">Début dans la source (s)</label><input id="pIn" type="number" step="0.04" min="0" value="${c.srcIn.toFixed(3)}"></div>`;
      if (isV) {
        const mode = c.crop.mode;
        html += `<div class="field"><label for="pMode">Cadrage 9:16</label><select id="pMode"><option value="fixed" ${mode === 'fixed' ? 'selected' : ''}>Fixe</option><option value="travel" ${mode === 'travel' ? 'selected' : ''}>Travelling</option></select></div>
          <div class="field"><label for="pX">${mode === 'travel' ? 'Départ' : 'Position'}</label><input id="pX" type="range" min="0" max="100" value="${Math.round((mode === 'travel' ? c.crop.travel.from : c.crop.x) * 100)}" style="width:120px"></div>
          ${mode === 'travel' ? `<div class="field"><label for="pTo">Arrivée</label><input id="pTo" type="range" min="0" max="100" value="${Math.round(c.crop.travel.to * 100)}" style="width:120px"></div>` : ''}
          <p style="font-size:.7rem;color:var(--muted);margin:2px 0 8px">Astuce : glissez horizontalement sur l'aperçu pour cadrer.</p>
          <div style="display:flex;flex-wrap:wrap;margin:0 -3px"><button class="bigbtn sec" data-do="copyAttrs" style="flex:1 1 100px;margin:3px;min-height:40px;font-size:.68rem">Copier le cadrage</button><button class="bigbtn sec" data-do="pasteAttrs" style="flex:1 1 100px;margin:3px;min-height:40px;font-size:.68rem" ${ui.clipboardAttrs ? '' : 'disabled'}>Coller le cadrage</button></div>`;
      } else {
        html += `<div class="field"><label for="pGain">Gain (dB)</label><input id="pGain" type="number" step="0.5" value="${c.gainDb || 0}"></div>`;
      }
      html += `<div style="display:flex;flex-wrap:wrap;margin:6px -3px 0"><button class="bigbtn sec" data-do="split" style="flex:1 1 90px;margin:3px;min-height:40px;font-size:.68rem">Couper ici</button><button class="bigbtn sec" data-do="dup" style="flex:1 1 90px;margin:3px;min-height:40px;font-size:.68rem">Dupliquer</button><button class="bigbtn sec" data-do="del" style="flex:1 1 90px;margin:3px;min-height:40px;font-size:.68rem;color:var(--err)">Supprimer</button></div>`;
      const mine = issues.filter((i) => i.clipId === c.id);
      html += `<div class="panel-h" style="padding-left:0;margin-top:10px">Alertes du clip</div>${lintHtml(mine, false)}`;
    } else if (sel.length > 1) {
      titleEl.textContent = sel.length + ' clips sélectionnés';
      html += `<div style="display:flex;flex-wrap:wrap;margin:0 -3px"><button class="bigbtn sec" data-do="pasteAttrs" style="flex:1 1 120px;margin:3px;min-height:40px;font-size:.68rem" ${ui.clipboardAttrs ? '' : 'disabled'}>Coller le cadrage</button><button class="bigbtn sec" data-do="dup" style="flex:1 1 120px;margin:3px;min-height:40px;font-size:.68rem">Dupliquer</button><button class="bigbtn sec" data-do="del" style="flex:1 1 120px;margin:3px;min-height:40px;font-size:.68rem;color:var(--err)">Supprimer</button></div>`;
    } else {
      titleEl.textContent = 'Projet';
      const total = totalFrames(d) / fps;
      html += `<div class="field"><label for="pName">Nom</label><input id="pName" type="text" value="${esc(d.project.name)}"></div>
        <div class="field"><label>Durée</label><span style="font-weight:800">${fr(total)} s</span></div>
        <div class="field"><label>Cible</label><span>${fr(d.project.target.duration)} s (${fr(d.project.target.min)}–${fr(d.project.target.max)})</span></div>
        <div class="field pro-only"><label>Images / seconde</label><span>${d.project.fps} (constant)</span></div>
        <div class="field pro-only"><label>Sortie</label><span>${d.project.width}×${d.project.height}</span></div>
        <div class="panel-h" style="padding-left:0;margin-top:10px">Alertes (${issues.length})</div>${lintHtml(issues, true)}
        <p style="font-size:.7rem;color:var(--muted);margin-top:14px;line-height:1.5">Les droits des extraits et trailers restent à leurs ayants droit ; le copyright affiché ne remplace pas une autorisation.</p>`;
    }
    el.innerHTML = html;
    window.__lintCount = issues.length;
  }

  el.addEventListener('change', (e) => {
    const c = ui.selection.length === 1 ? findClip(doc(), ui.selection[0]) : null;
    const fps = doc().project.fps;
    if (e.target.id === 'pName') { store.commit('Nom', (d) => { d.project.name = e.target.value.trim() || 'Nouveau montage'; }); return; }
    if (!c) return;
    if (e.target.id === 'pDur') {
      const want = Math.max(1, Math.round(Number(e.target.value) * fps));
      if (!applyTrim(store, lib, c.id, 'R', want - c.dur, { ripple: doc().settings.ripple })) toast('Durée limitée par la source ou le clip voisin');
      player.invalidate(); player.refresh();
    }
    if (e.target.id === 'pIn') { applySlip(store, lib, c.id, Math.round((Number(e.target.value) - c.srcIn) * fps)); player.invalidate(); player.refresh(); }
    if (e.target.id === 'pGain') store.commit('Gain', (d) => { findClip(d, c.id).gainDb = Number(e.target.value) || 0; });
    if (e.target.id === 'pMode') {
      store.commit('Mode de cadrage', (d) => { const x = findClip(d, c.id); if (e.target.value === 'travel') { x.crop.mode = 'travel'; const f = x.crop.x; x.crop.travel = { from: Math.max(0, f - 0.06), to: Math.min(1, f + 0.06) }; } else { x.crop.mode = 'fixed'; x.crop.travel = null; } });
      player.redraw();
    }
  });
  // Curseurs de cadrage : geste continu (mutation silencieuse, un seul pas d'historique à la fin),
  // sinon le panneau se reconstruirait sous le doigt à chaque valeur.
  el.addEventListener('input', (e) => {
    if (e.target.id !== 'pX' && e.target.id !== 'pTo') return;
    const c = ui.selection.length === 1 ? findClip(doc(), ui.selection[0]) : null;
    if (!c) return;
    const v = Number(e.target.value) / 100;
    store.beginGesture('Cadrage');
    if (e.target.id === 'pX') { if (c.crop.mode === 'travel') c.crop.travel.from = v; else { c.crop.mode = 'fixed'; c.crop.x = v; } }
    else c.crop.travel.to = v;
    player.redraw();
  });
  el.addEventListener('change', (e) => { if (e.target.id === 'pX' || e.target.id === 'pTo') store.endGesture(); });

  el.addEventListener('click', (e) => {
    const fix = e.target.closest('[data-fix]');
    if (fix) {
      const issue = lintDoc(doc(), (id) => lib.get(id)).find((i) => i.id === fix.dataset.fix);
      if (issue) { if (!applyFix(store, lib, issue)) toast('Ce correctif ne peut pas s\'appliquer ici'); player.invalidate(); player.refresh(); }
      return;
    }
    const lint = e.target.closest('.lint');
    if (lint && !e.target.closest('button')) {
      const c = findClip(doc(), lint.dataset.clip); if (c) { ui.selection = [c.id]; player.seek(c.start); timeline.render(); }
      return;
    }
    const act = e.target.closest('[data-do]'); if (!act) return;
    const ids = ui.selection.slice();
    const c = ids.length === 1 ? findClip(doc(), ids[0]) : null;
    switch (act.dataset.do) {
      case 'copyAttrs': ui.clipboardAttrs = { crop: JSON.parse(JSON.stringify(c.crop)) }; toast('Cadrage copié'); render(); break;
      case 'pasteAttrs': pasteAttrs(store, ids, ui.clipboardAttrs); player.redraw(); toast('Cadrage collé'); break;
      case 'split': { const f = ui.playhead > c.start && ui.playhead < clipEnd(c) ? ui.playhead : c.start + Math.floor(c.dur / 2); player.seek(f); splitAt(store, f, [c.id]); player.invalidate(); break; }
      case 'dup': duplicateClips(store, ids); break;
      case 'del': deleteClips(store, ids, doc().settings.ripple); player.refresh(); break;
      default: break;
    }
  });

  store.subscribe((kind) => { if (kind === 'doc') render(); });
  render();
  return { render };
}
