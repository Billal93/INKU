// Écran « Rendu » : rendu final ou aperçu rapide, progression par étape (estimation, annulation, écran maintenu allumé),
// contrôles après rendu, lecture, téléchargement, partage vers la galerie (Web Share), historique des rendus ;
// projet : export / import de l'EDL (sources ré-associées par empreinte), nouveau projet.
import { renderProject, RENDER_PRESETS } from '../render/export.js';
import { verifyRender } from '../render/verify.js';
import { kvGet, kvSet } from './storage.js';
import { validate, migrate, newProject } from './edl.js';
import { sourceRef } from './ops.js';
import { lintDoc } from './lint.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fr = (n, d = 1) => Number(n).toFixed(d).replace('.', ',');
const HKEY = 'renders';

/** Complète doc.sources pour toutes les sources utilisées (pour ré-associer les fichiers sur un autre appareil). */
export function completeSources(doc, lib) {
  for (const c of doc.clips) if (c.srcId && !doc.sources[c.srcId]) { const r = lib.get(c.srcId); if (r) doc.sources[c.srcId] = sourceRef(r); }
  return doc;
}

/**
 * EDL importé : identifiants de sources ré-associés aux fichiers de cette bibliothèque par empreinte (puis par nom).
 * @returns {{ doc: any, missing: string[] }}
 */
export function relinkSources(doc, lib) {
  const map = new Map(), missing = [];
  for (const [id, ref] of Object.entries(doc.sources || {})) {
    const hit = lib.list.find((r) => r.id === id) || lib.list.find((r) => ref.fingerprint && r.fingerprint === ref.fingerprint) || lib.list.find((r) => r.name === ref.name && Math.abs((r.duration || 0) - (ref.duration || 0)) < 0.05);
    if (hit) map.set(id, hit.id); else missing.push(ref.name || id);
  }
  for (const c of doc.clips) if (c.srcId && map.has(c.srcId)) c.srcId = map.get(c.srcId);
  if (doc.voice && doc.voice.srcId && map.has(doc.voice.srcId)) doc.voice.srcId = map.get(doc.voice.srcId);
  if (doc.end && doc.end.climax && map.has(doc.end.climax.srcId)) doc.end.climax.srcId = map.get(doc.end.climax.srcId);
  if (doc.end && doc.end.thumbnail && map.has(doc.end.thumbnail.srcId)) doc.end.thumbnail.srcId = map.get(doc.end.thumbnail.srcId);
  const sources = {};
  for (const [id, ref] of Object.entries(doc.sources || {})) sources[map.get(id) || id] = { ...ref, id: map.get(id) || id };
  doc.sources = sources;
  return { doc, missing };
}

function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

/** @param {{ el: HTMLElement, sheet: HTMLElement, store: any, lib: any, assets: any, player: any, toast: (m: string) => void }} o */
export function createRenderPanel({ el, sheet, store, lib, assets, player, toast }) {
  let job = null, result = null, history = [], url = null;
  /** @type {'final'|'draft'} */ let preset = 'final';

  async function loadHistory() { history = (await kvGet(HKEY).catch(() => null)) || []; render(); }
  async function saveHistory() { await kvSet(HKEY, history.slice(0, 20)).catch(() => {}); }
  async function fileOf(id) {
    if (result && result.render.id === id) return result.render.blob;
    try { const root = await navigator.storage.getDirectory(); return await (await (await root.getDirectoryHandle('renders')).getFileHandle(id + '.mp4')).getFile(); } catch { return null; }
  }
  const fileName = (h) => `${(store.doc.project.name || 'montage').replace(/[\\/:*?"<>|]+/g, '_')}-${h.width}x${h.height}-${h.id.slice(7, 26)}.mp4`;

  function render() {
    const d = store.doc;
    const errs = lintDoc(d, (id) => lib.get(id)).filter((i) => i.level === 'err');
    const font = player.scene.font;
    let html = `<div class="panel-h" style="padding-left:0">Rendu</div>`;
    if (job) {
      const p = job.p || { stage: 'Préparation', done: 0, total: 1 };
      const pct = Math.round((100 * p.done) / Math.max(1, p.total));
      html += `<div class="vsum"><b>${esc(p.stage)}</b> · ${pct} %${p.etaSec !== undefined ? ` · reste ≈ ${p.etaSec} s` : ''}${p.fps ? ` · ${fr(p.fps)} images/s` : ''}
        <div class="bar"><i style="width:${pct}%"></i></div>
        ${job.wake === false ? '<div class="warn">Gardez l\'écran allumé et l\'appli au premier plan pendant le rendu.</div>' : ''}
        ${p.hidden ? '<div class="warn">L\'appli est en arrière-plan : le rendu peut être suspendu par le système.</div>' : ''}
        <button class="bigbtn sec" data-do="cancel">Annuler</button></div>`;
    } else {
      html += `<div class="vrow">${Object.entries(RENDER_PRESETS).map(([k, v]) => `<label class="chk"><input type="radio" name="rp" value="${k}" ${k === preset ? 'checked' : ''}> ${v.label}</label>`).join('')}</div>
        ${!font.brand ? '<div class="warn">Police de la marque absente : le rendu est bloqué (importez-la dans le pack de marque).</div>' : ''}
        ${errs.length ? `<div class="warn">${errs.length} alerte(s) importante(s) : ${esc(errs[0].msg)}</div>` : ''}
        <button class="bigbtn" data-do="render" ${font.brand ? '' : 'disabled'}>Lancer le rendu</button>
        <p class="hint">Un seul encodage, à partir des fichiers originaux. Écran maintenu allumé si l'appareil le permet. Rendu arrêté automatiquement s'il dure plus de 3 fois l'estimation.</p>`;
    }
    if (result) {
      const r = result.render, v = result.verify;
      html += `<div class="vsum ${v && v.ok ? '' : 'bad'}"><b>${v ? (v.ok ? '✓ Contrôles réussis' : '✗ Contrôles en échec') : 'Contrôles…'}</b> · ${r.width}×${r.height}${r.fallback ? ' (repli : résolution maximale de l\'appareil)' : ''} · ${r.frames} images en ${fr(r.ms / 1000)} s (×${fr(r.ms / 1000 / (r.frames / r.fps), 2)} le temps réel) · AAC ${Math.round(r.audio.bitrate / 1000)} kb/s${r.audio.native ? '' : ' (encodeur embarqué)'}
        ${url ? `<video controls playsinline src="${url}" style="width:100%;max-height:46vh;margin-top:8px;background:#000;border-radius:10px"></video>` : ''}
        ${v ? `<ul class="checks">${v.checks.map((c) => `<li class="${c.ok ? 'ok' : 'ko'}">${c.ok ? '✓' : '✗'} ${esc(c.label)} <span class="muted">— ${esc(c.detail)}</span></li>`).join('')}</ul>` : ''}
        <div class="vbtns"><button class="bigbtn" data-dl="${r.id}">Télécharger</button>${navigator.canShare ? `<button class="bigbtn sec" data-share="${r.id}">Partager / galerie</button>` : ''}</div></div>`;
    }
    html += `<div class="panel-h" style="padding-left:0;margin-top:12px">Historique des rendus</div>
      ${history.length ? history.map((h) => `<div class="placed"><b>${new Date(h.date).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</b> · ${h.width}×${h.height} · ${fr(h.frames / h.fps)} s · ${fr(h.sizeMB)} Mo · ${h.ok ? '✓' : '✗'}
        <button class="ibtn" data-play="${h.id}">Voir</button><button class="ibtn" data-dl="${h.id}">Télécharger</button>${navigator.canShare ? `<button class="ibtn" data-share="${h.id}">Partager</button>` : ''}<button class="ibtn" data-rmh="${h.id}">Supprimer</button></div>`).join('') : '<p class="hint">Aucun rendu pour l\'instant.</p>'}
      <div class="panel-h" style="padding-left:0;margin-top:12px">Projet</div>
      <div class="vbtns"><button class="bigbtn sec" data-do="edl-export">Exporter le projet (EDL)</button><button class="bigbtn sec" data-do="edl-import">Importer un projet</button><button class="bigbtn sec" data-do="new">Nouveau projet</button></div>
      <p class="hint">L'EDL (fichier .json) décrit tout le montage sans contenir vos fichiers : sur un autre appareil, réimportez les mêmes vidéos, elles sont reconnues par leur empreinte.</p>
      <p class="hint">Les extraits de films et de trailers restent la propriété de leurs ayants droit ; le copyright affiché ne remplace pas une autorisation.</p>`;
    el.innerHTML = html;
  }

  async function start() {
    const ctrl = new AbortController();
    job = { ctrl, p: null, wake: null };
    result = null; if (url) { URL.revokeObjectURL(url); url = null; }
    render();
    player.pause();
    try {
      const r = await renderProject({ doc: store.doc, lib, assets, scene: player.scene, mixer: player.mixer, preset, signal: ctrl.signal, onProgress: (p) => { job.p = p; render(); } });
      job.wake = r.wakeLock;
      result = { render: r, verify: null };
      url = URL.createObjectURL(r.blob);
      job.p = { stage: 'Contrôles après rendu', done: 0, total: 1 }; render();
      const v = await verifyRender(r.blob, { doc: JSON.parse(JSON.stringify(store.doc)), frames: r.frames, fps: r.fps, width: r.width, height: r.height, getSource: (id) => lib.get(id), subtitleBase: player.scene.subsBase }, (p) => { job.p = p; render(); });
      result.verify = v;
      history.unshift({ id: r.id, date: Date.now(), width: r.width, height: r.height, frames: r.frames, fps: r.fps, ms: r.ms, sizeMB: +(r.blob.size / 1048576).toFixed(2), ok: v.ok, target: r.target, preset, failed: v.checks.filter((c) => !c.ok).map((c) => c.label) });
      await saveHistory();
      toast(v.ok ? 'Rendu terminé et contrôlé ✓' : 'Rendu terminé, mais des contrôles échouent : voir la liste');
      /** @type {any} */ (window).__lastRender = { render: { ...r, blob: undefined, size: r.blob.size }, verify: v };
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? 'Rendu annulé' : 'Rendu impossible : ' + (e.message || e);
      toast(msg);
      /** @type {any} */ (window).__lastRender = { error: msg };
    } finally { job = null; render(); }
  }

  async function share(id) {
    const blob = await fileOf(id);
    if (!blob) { toast('Fichier introuvable (rendu fait dans une session précédente sans stockage privé)'); return; }
    const h = history.find((x) => x.id === id) || (result && result.render);
    const file = new File([blob], fileName(h), { type: 'video/mp4' });
    try {
      if (!navigator.canShare || !navigator.canShare({ files: [file] })) { download(file, file.name); return; }
      await navigator.share({ files: [file], title: store.doc.project.name });
    } catch (e) { if (!e || e.name !== 'AbortError') toast('Partage impossible : ' + (e.message || e)); }
  }

  el.addEventListener('change', (e) => { const t = /** @type {HTMLInputElement} */ (e.target); if (t.name === 'rp') preset = t.value === 'draft' ? 'draft' : 'final'; });
  el.addEventListener('click', async (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!b) return;
    if (b.dataset.do === 'render') return start();
    if (b.dataset.do === 'cancel') { if (job) job.ctrl.abort(); return; }
    if (b.dataset.dl) { const blob = await fileOf(b.dataset.dl); const h = history.find((x) => x.id === b.dataset.dl) || result.render; if (blob) download(blob, fileName(h)); else toast('Fichier introuvable'); return; }
    if (b.dataset.share) return share(b.dataset.share);
    if (b.dataset.play) { const blob = await fileOf(b.dataset.play); if (!blob) { toast('Fichier introuvable'); return; } if (url) URL.revokeObjectURL(url); url = URL.createObjectURL(blob); const h = history.find((x) => x.id === b.dataset.play); result = { render: { ...h, blob, audio: { bitrate: 0, native: true }, fallback: false }, verify: { ok: h.ok, checks: (h.failed || []).map((l) => ({ ok: false, label: l, detail: 'lors du rendu' })) } }; render(); return; }
    if (b.dataset.rmh) {
      const id = b.dataset.rmh;
      try { const root = await navigator.storage.getDirectory(); await (await root.getDirectoryHandle('renders')).removeEntry(id + '.mp4'); } catch { /* absent */ }
      history = history.filter((x) => x.id !== id); await saveHistory(); render(); return;
    }
    if (b.dataset.do === 'edl-export') {
      const doc = completeSources(JSON.parse(JSON.stringify(store.doc)), lib);
      download(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), (doc.project.name || 'montage') + '.edl.json');
      return;
    }
    if (b.dataset.do === 'edl-import') {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
      inp.onchange = async () => {
        try {
          const doc = migrate(JSON.parse(await inp.files[0].text()));
          const errs = validate(doc);
          if (errs.length) { toast('EDL invalide : ' + errs[0]); return; }
          const { missing } = relinkSources(doc, lib);
          if (!confirm('Remplacer le projet en cours par « ' + doc.project.name + ' » ? (le projet actuel peut être exporté avant)')) return;
          store.replaceDoc(doc); player.invalidate(); player.refresh();
          toast(missing.length ? `Projet importé. Sources à réimporter : ${missing.join(', ')}` : 'Projet importé, toutes les sources sont reconnues');
        } catch (err) { toast('Import impossible : ' + (err.message || err)); }
      };
      inp.click(); return;
    }
    if (b.dataset.do === 'new') { if (confirm('Commencer un nouveau projet ? (le projet actuel est remplacé ; exportez-le avant si besoin)')) { store.replaceDoc(newProject()); player.refresh(); } }
  });

  return { render, open: () => { sheet.classList.add('open'); loadHistory(); }, start, loadHistory };
}
