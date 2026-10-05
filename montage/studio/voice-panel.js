// Panneau « Voix » : choix de la voix, analyse (progression), transcription mot à mot éditable (toucher un mot =
// le couper / le garder ; appui long = l'écouter), prises regroupées avec la retenue (★) et sa raison, défauts
// signalés, rapport de nettoyage, glossaire du projet, application à la timeline.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fr = (n, d = 1) => Number(n).toFixed(d).replace('.', ',');

import { importBrandFiles, exportBrandZip, loadBrandFont, loadManifest } from '../brand/brand.js';

/** @param {{ el: HTMLElement, store: any, lib: any, voice: ReturnType<typeof import('./voice.js').createVoice>, toast: (m: string) => void, onFont: (f: any) => void }} o */
export function createVoicePanel({ el, store, lib, voice, toast, onFont }) {
  let brand = { font: null, assets: [] }, fontStatus = { ok: false, family: null, reason: '' };
  async function refreshBrand() {
    try { brand = await loadManifest(); fontStatus = await loadBrandFont(); } catch (e) { fontStatus = { ok: false, family: null, reason: String(e.message || e) }; }
    onFont(fontStatus.ok ? { family: fontStatus.family, weight: brand.font.weight || 700, brand: true } : { family: 'Plus Jakarta Sans', weight: 800, brand: false });
    render();
  }
  let progress = null, error = null, showReport = false;

  async function render() {
    const d = store.doc;
    const v = d.voice;
    if (voice.running || progress) { el.innerHTML = progressHtml(); return; }
    const s = v ? await voice.state() : null;
    if (!s) { el.innerHTML = pickHtml(); return; }
    const { an, st } = s;
    const issuesByWord = new Map();
    for (const x of an.issues) for (const i of x.words) { if (!issuesByWord.has(i)) issuesByWord.set(i, []); issuesByWord.get(i).push(x); }
    const removed = an.duration - st.keptSec;
    let html = `<div class="vsum"><b>${fr(an.duration)} s</b> brut → <b>${fr(st.keptSec)} s</b> nettoyé <span class="muted">(−${fr(Math.max(0, removed))} s)</span>
      <div class="muted">${an.words.length} mots · ${an.takes.filter((g) => g.members.length > 1).length} phrase(s) à prises multiples · ${an.issues.filter((x) => x.action === 'cut').length} défaut(s) coupé(s) · ${an.issues.filter((x) => x.action === 'listen').length} à écouter</div>
      <div class="vbtns"><button class="bigbtn" data-do="apply">${v.applied ? 'Réappliquer' : 'Appliquer à la timeline'}</button><button class="bigbtn sec" data-do="report">${showReport ? 'Transcription' : 'Rapport'}</button></div>
      ${v.applied ? '<div class="muted ok">✓ Voix nettoyée et sous-titres posés sur la timeline.</div>' : '<div class="muted warn">Modifications pas encore appliquées à la timeline.</div>'}</div>`;
    if (showReport) {
      html += `<pre class="report">${esc(await voice.report())}</pre>`;
    } else {
      html += '<p class="hint">Touchez un mot pour le couper ou le garder ; appui long pour l\'écouter. ★ = prise gardée.</p>';
      an.takes.forEach((g0, gi) => {
        const g = st.takes[gi];
        const multi = g.members.length > 1;
        html += `<div class="vgroup ${multi ? 'multi' : ''}">`;
        if (multi) html += `<div class="vgh">Phrase ${gi + 1} · ${g.members.length} prises <span class="muted">${esc(g.chosenByUser ? 'choix manuel' : g.reason.split(' ; ')[0])}</span></div>`;
        for (const m of g.members) {
          const sen = an.sentences[m];
          const isBest = m === g.best;
          html += `<div class="vsent ${multi && !isBest ? 'other' : ''}" data-sent="${m}">`;
          if (multi) html += `<button class="star ${isBest ? 'on' : ''}" data-best="${gi}:${m}" aria-label="Garder cette prise">${isBest ? '★' : '☆'}</button>`;
          html += `<button class="play" data-play="${an.words[sen.a].t0}:${an.words[sen.b].t1}" aria-label="Écouter la phrase">▶</button>`;
          for (let i = sen.a; i <= sen.b; i++) {
            // fragments acoustiques coupés juste avant ce mot
            for (const r of st.ranges) if (r.t1 <= an.words[i].t0 + 1e-6 && (i === sen.a ? r.t0 >= an.words[i].t0 - 1.5 : r.t0 >= an.words[i - 1].t1 - 1e-6)) html += `<button class="frag ${r.cut ? 'cut' : ''}" data-range="${r.k}" title="${esc(r.reason)}">${r.type === 'hésitation' ? 'euh' : '…'} ${fr(r.t1 - r.t0, 2)} s</button>`;
            const iss = issuesByWord.get(i) || [];
            const cls = ['w', st.cut.has(i) ? 'cut' : '', iss.some((x) => x.action === 'cut') ? 'icut' : iss.length ? 'ilisten' : '', st.words[i].edited ? 'edited' : ''].join(' ');
            html += `<span class="${cls}" data-w="${i}" title="${esc(iss.map((x) => x.type + ' : ' + x.reason).join('\n'))}">${esc(st.words[i].w)}</span> `;
          }
          html += '</div>';
        }
        html += '</div>';
      });
      if (an.removedWords && an.removedWords.length) html += `<p class="hint">${an.removedWords.length} mot(s) inventé(s) par le modèle sur du silence ont été retirés.</p>`;
    }
    html += glossaryHtml();
    html += `<p class="hint">Modèle : ${esc(an.model)} · analyse en ${fr((an.wallMs || 0) / 1000)} s (${fr(((an.wallMs || 0) / 1000) / Math.max(1, an.duration / 60))} s par minute d'audio). <button class="linkbtn" data-do="reanalyze">Réanalyser</button></p>`;
    el.innerHTML = html;
  }

  function pickHtml() {
    const audios = lib.list.filter((r) => r.status === 'ready' && (r.kind === 'audio' || r.hasAudio));
    let html = `<div class="vsum"><b>Voix</b><div class="muted">Choisissez votre enregistrement brut : il est transcrit et nettoyé sur l'appareil (rien n'est envoyé). Le modèle de transcription (≈ 0,7 Go) est téléchargé une seule fois depuis Hugging Face puis vérifié.</div></div>`;
    if (!audios.length) html += '<div class="empty" style="padding:12px">Importez d\'abord votre voix (onglet Sources).</div>';
    for (const r of audios) html += `<div class="vsrc"><span class="sp">${esc(r.name)} <span class="muted">${fr(r.duration || 0)} s</span></span><button class="bigbtn" data-analyze="${r.id}">Analyser comme voix</button></div>`;
    if (error) html += `<div class="lint err">${esc(error)}</div>`;
    return html + glossaryHtml();
  }

  function progressHtml() {
    const p = voice.running || progress || {};
    const pct = p.total ? Math.round((100 * (p.loaded !== undefined ? p.loaded / p.total : p.done / p.total))) : 0;
    return `<div class="vsum"><b>${esc(p.stage || 'Analyse')}</b><div class="bar"><i style="width:${pct}%"></i></div>
      <div class="muted">${p.loaded !== undefined ? fr(p.loaded / 1048576, 0) + ' / ' + fr(p.total / 1048576, 0) + ' Mo' : p.total > 1 ? p.done + ' / ' + p.total : ''}</div>
      <p class="hint">Vous pouvez continuer à monter pendant l'analyse.</p></div>`;
  }

  function glossaryHtml() {
    const g = (store.doc.subtitles && store.doc.subtitles.glossary) || [];
    return brandHtml() + `<div class="panel-h" style="padding-left:0;margin-top:12px">Noms et mots importants</div>
      <p class="hint">Un par ligne. Ils aident la transcription et s'affichent en jaune dans les sous-titres. Commencez par « ! » pour le texte impact rouge (ex. « !25 décembre »).</p>
      <textarea id="vGloss" rows="4" style="width:100%">${esc(g.map((x) => (x.kind === 'impact' ? '!' : '') + x.text).join('\n'))}</textarea>`;
  }

  function brandHtml() {
    const f = fontStatus.ok ? `<span class="muted ok">✓ ${esc(fontStatus.family)}</span>` : `<span class="muted warn">${esc(fontStatus.reason || 'aucune police')}</span>`;
    return `<div class="panel-h" style="padding-left:0;margin-top:12px">Pack de marque</div>
      <div class="field"><label>Police des sous-titres</label>${f}</div>
      <p class="hint">Police, overlays, sons et logo restent sur cet appareil (jamais en ligne). Un seul fichier ZIP permet de les transférer sur un autre appareil. ${brand.assets.length} élément(s) en plus de la police.</p>
      <div class="vbtns"><button class="bigbtn sec" data-do="brandImport">Importer (ZIP ou fichiers)</button><button class="bigbtn sec" data-do="brandExport" ${brand.font || brand.assets.length ? '' : 'disabled'}>Exporter le pack (ZIP)</button></div>`;
  }

  async function brandImport() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    inp.accept = '.zip,.woff2,.woff,.ttf,.otf,video/*,audio/*,image/*';
    inp.onchange = async () => {
      try {
        const r = await importBrandFiles(Array.from(inp.files || []));
        r.warnings.forEach((w) => toast(w));
        toast(`Pack de marque : ${r.added.length} élément(s) ajouté(s)${r.manifest.font ? ', police « ' + r.manifest.font.family + ' »' : ''}`);
      } catch (e) { toast('Import impossible : ' + (e.message || e)); }
      refreshBrand();
    };
    inp.click();
  }

  async function brandExport() {
    const blob = await exportBrandZip();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pack-marque-inku.zip';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ── Interactions ──
  let lp = null;
  el.addEventListener('pointerdown', (e) => {
    const w = /** @type {HTMLElement} */ (e.target).closest('[data-w]');
    if (!w) return;
    lp = { i: Number(/** @type {HTMLElement} */ (w).dataset.w), t: setTimeout(async () => { lp.long = true; const s = await voice.state(); const x = s.an.words[lp.i]; voice.listen(s.an.srcId, x.t0 - 0.25, x.t1 + 0.25); }, 450), long: false };
  });
  const endLp = () => { if (lp) clearTimeout(lp.t); };
  el.addEventListener('pointerup', endLp); el.addEventListener('pointercancel', () => { endLp(); lp = null; });
  el.addEventListener('contextmenu', (e) => { if (/** @type {HTMLElement} */ (e.target).closest('[data-w]')) e.preventDefault(); });

  el.addEventListener('click', async (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const w = t.closest('[data-w]');
    if (w) {
      if (lp && lp.long) { lp = null; return; }
      lp = null;
      const i = Number(/** @type {HTMLElement} */ (w).dataset.w);
      const s = await voice.state();
      const nowCut = s.st.cut.has(i);
      voice.edit(nowCut ? 'Garder un mot' : 'Couper un mot', (ed) => { ed.cut ||= {}; ed.cut[i] = !nowCut; });
      return;
    }
    const b = /** @type {HTMLElement} */ (t.closest('button'));
    if (!b) return;
    if (b.dataset.analyze) return analyze(b.dataset.analyze);
    if (b.dataset.best) { const [g, m] = b.dataset.best.split(':').map(Number); voice.edit('Choisir une prise', (ed) => { ed.best ||= {}; ed.best[g] = m; }); return; }
    if (b.dataset.range) { const k = Number(b.dataset.range); const s = await voice.state(); const r = s.st.ranges.find((x) => x.k === k); voice.edit('Fragment', (ed) => { ed.ranges ||= {}; ed.ranges[k] = !r.cut; }); return; }
    if (b.dataset.play) { const [a, z] = b.dataset.play.split(':').map(Number); voice.listen(store.doc.voice.srcId, a - 0.1, z + 0.2); return; }
    if (b.dataset.do === 'apply') {
      try { const r = await voice.apply(); toast(`Voix posée : ${r.pieces} morceaux, ${fr(r.seconds)} s ; ${r.subs} sous-titres`); } catch (err) { toast(String(err.message || err)); }
      return;
    }
    if (b.dataset.do === 'report') { showReport = !showReport; render(); return; }
    if (b.dataset.do === 'reanalyze') { analyze(store.doc.voice.srcId); return; }
    if (b.dataset.do === 'brandImport') { brandImport(); return; }
    if (b.dataset.do === 'brandExport') { brandExport(); }
  });

  el.addEventListener('change', (e) => {
    const t = /** @type {HTMLTextAreaElement} */ (e.target);
    if (t.id !== 'vGloss') return;
    const list = t.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith('!') ? { text: l.slice(1).trim(), kind: 'impact' } : { text: l, kind: 'important' }));
    store.commit('Glossaire', (d) => { d.subtitles ||= {}; d.subtitles.glossary = list; if (d.voice) d.voice.applied = false; });
  });

  async function analyze(srcId) {
    error = null; progress = { stage: 'Démarrage', done: 0, total: 1 }; render();
    try {
      await voice.analyze(srcId, (p) => { progress = p; render(); });
      toast('Voix analysée : vérifiez les coupes proposées puis « Appliquer »');
    } catch (err) { error = 'Analyse impossible : ' + (err.message || err); toast(error); }
    progress = null; render();
  }

  store.subscribe((k) => { if (k === 'doc') render(); });
  lib.addEventListener('change', () => { if (!store.doc.voice) render(); });
  render();
  refreshBrand();
  return { render, refreshBrand };
}
