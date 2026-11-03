// Panneau « Habillage » : éléments de marque (analysés une fois : fps, couverture, retrait de fond), pose des
// transitions sur une coupe (à l'image près, emplacements proposés en début de phrase), ouverture, abonne-toi sur le
// mot « abonne », logo, copyright, SFX sur les mots importants, musique de fond ; contrôle du son (crêtes de chaque type
// de son par rapport à la voix, drops de la musique, sonie finale). Tout se valide et s'annule (historique).
import { KINDS, importBrandFiles, removeAsset, updateAsset } from '../brand/brand.js';
import { makeClip, clipEnd, fmtTime } from './edl.js';
import { placeOpening, placeTransition, placeSubscribe, placeLogo, sfxClips, checkTransition, transitionSuggestions, findSubscribeWord, contentEnd, realignTransition } from './overlays.js';
import { MIX_DEFAULTS } from '../audio/mix.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fr = (n, d = 1) => Number(n).toFixed(d).replace('.', ',');
const KEY_LABEL = { luma: 'fond noir', chroma: 'fond vert', alpha: 'alpha', none: 'opaque' };

/** @param {{ el: HTMLElement, store: any, lib: any, player: any, assets: import('./assets.js').BrandAssets, toast: (m: string) => void }} o */
export function createDressPanel({ el, store, lib, player, assets, toast }) {
  let busy = '', mixInfo = null;
  const sel = { transition: '', opening: '', subscribe: '', logo: '', music: '' };

  const fps = () => store.doc.project.fps;
  const sec = (f) => fr(f / fps(), 2);
  const opts = (kind, cur) => assets.byKind(kind).map((a) => `<option value="${a.id}" ${a.id === cur ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  const pick = (kind) => sel[kind] && assets.get(sel[kind]) ? sel[kind] : (assets.byKind(kind)[0] || { id: '' }).id;

  function assetLine(a) {
    const an = a.analysis;
    let info;
    if (a.kind === 'sfx' || a.kind === 'music') info = a.duration ? `${fr(a.duration, 2)} s · ${a.lufs ?? '—'} LUFS` : 'à analyser';
    else if (a.analyzed) info = `${a.image ? 'image' : `${a.frames} img · ${a.fps} i/s`} · ${KEY_LABEL[a.keying && a.keying.method] || '?'}${an && an.fullStart >= 0 ? ` · couverture totale ${an.fullStart}–${an.fullEnd}` : ''}${a.hasAudio ? ' · son' : ''}`;
    else info = 'à analyser';
    return `<div class="brow"><div class="bname">${esc(a.name)}<div class="muted">${esc(info)}</div></div>
      <select data-role="${a.id}" aria-label="Rôle">${Object.entries(KINDS).filter(([k]) => k !== 'font').map(([k, v]) => `<option value="${k}" ${k === a.kind ? 'selected' : ''}>${v}</option>`).join('')}</select>
      ${a.kind !== 'sfx' && a.kind !== 'music' && !a.image ? `<select data-key="${a.id}" aria-label="Retrait de fond">${['luma', 'chroma', 'alpha', 'none'].map((k) => `<option value="${k}" ${a.keying && a.keying.method === k ? 'selected' : ''}>${KEY_LABEL[k]}</option>`).join('')}</select>` : ''}
      <button class="ibtn" data-rm="${a.id}" aria-label="Retirer du pack">✕</button></div>`;
  }

  function placedHtml() {
    const d = store.doc;
    const v2 = d.clips.filter((c) => c.track === 'V2').sort((a, b) => a.start - b.start);
    if (!v2.length) return '<p class="hint">Aucun overlay posé.</p>';
    return v2.map((c) => {
      const issues = c.role === 'transition' ? checkTransition(d, c, { getSource: (id) => lib.get(id) }) : [];
      const at = c.role === 'transition' && c.cut !== undefined ? `coupe à ${sec(c.cut)} s (image ${c.cut})` : `${sec(c.start)} → ${sec(clipEnd(c))} s`;
      return `<div class="placed"><b>${esc({ transition: 'Transition', opening: 'Ouverture', subscribe: 'Abonne-toi', logo: 'Logo', overlay: 'Overlay' }[c.role] || c.role)}</b> · ${esc(c.assetName)} · ${at}
        <button class="ibtn" data-go="${c.start + (c.cover ? c.cover[0] : 0)}">Voir</button><button class="ibtn" data-del="${c.id}">Retirer</button>
        ${issues.map((x) => `<div class="${x.level === 'err' ? 'err' : 'warn'}">⚠ ${esc(x.msg)}${x.fix === 'realign-transition' ? ` <button class="ibtn" data-realign="${c.id}">Recaler</button>` : ''}</div>`).join('')}</div>`;
    }).join('');
  }

  function mixHtml() {
    const m = mixInfo;
    const mx = { ...MIX_DEFAULTS, ...(store.doc.mix || {}) };
    let h = `<div class="mixset"><label>Voix <input type="number" step="0.1" data-mix="voiceGainDb" value="${mx.voiceGainDb}"> dB</label>
      <label>Musique <input type="number" step="1" data-mix="musicRelDb" value="${mx.musicRelDb}"> dB / voix</label>
      <label>Ducking <input type="number" step="1" data-mix="duckDb" value="${mx.duckDb}"> dB</label></div>`;
    if (!m) return h + '<button class="bigbtn sec" data-do="mix">Mesurer le mixage</button>';
    const r = m.report;
    const name = { voice: 'Voix', music: 'Musique', sfx: 'SFX', transition: 'Transitions', opening: 'Ouverture', subscribe: 'Abonne-toi', overlay: 'Overlays', trailer: 'Son du climax' };
    h += `<table class="mixtab"><tr><th>Son</th><th>Crête / voix</th><th>Plafond</th></tr>
      <tr><td>Voix</td><td>${fr(r.voice.peakDb)} dBFS</td><td>−1 dBTP</td></tr>
      ${Object.entries(r.peaksRelVoice).map(([k, v]) => `<tr><td>${name[k] || k}</td><td>${Number.isFinite(v) ? fr(v) + ' dB' : '—'}</td><td>${MIX_DEFAULTS.caps[k] !== undefined ? '−' + MIX_DEFAULTS.caps[k] + ' dB' : '−16 LU'}</td></tr>`).join('')}</table>
      <div class="muted">Mix final : ${fr(r.lufs)} LUFS · true peak ${fr(r.truePeakDb)} dBTP · limiteur −${fr(r.limiter.maxReductionDb)} dB max · calcul ${m.ms} ms</div>
      ${r.stems.filter((s) => s.capped).length ? `<div class="muted">Baissés automatiquement (jamais montés) : ${r.stems.filter((s) => s.capped).map((s) => esc(s.label) + ' ' + fr(s.gainDb) + ' dB').join(', ')}</div>` : ''}
      ${r.drops.map((d) => `<div class="warn">Musique : passage fort à ${fr(d.t)} s atténué de ${fr(-d.db)} dB pendant ${fr(d.dur)} s</div>`).join('')}
      ${r.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
      <button class="bigbtn sec" data-do="mix">Remesurer</button>`;
    return h;
  }

  let deferred = false;
  function render() {
    // Jamais pendant une saisie (le champ serait remplacé) : rendu différé à la sortie du champ.
    const ae = document.activeElement;
    if (ae && el.contains(ae) && ae.matches('input[type=text], input[type=number]')) { deferred = true; return; }
    const d = store.doc;
    const list = assets.manifest ? assets.manifest.assets : [];
    const sugg = transitionSuggestions(d);
    const abo = findSubscribeWord(d);
    const cr = d.copyright || { enabled: true, text: '' };
    el.innerHTML = `
      ${busy ? `<div class="vsum">${esc(busy)}…</div>` : ''}
      <div class="panel-h" style="padding-left:0">Pack de marque</div>
      <p class="hint">Vos overlays, sons et logo restent sur cet appareil. Chaque fichier est analysé une fois (images, couverture, retrait de fond).</p>
      ${list.map(assetLine).join('') || '<p class="hint">Pack vide : importez vos transitions, ouverture, abonne-toi, logo, sons et musiques.</p>'}
      <div class="vbtns"><button class="bigbtn sec" data-do="import">Ajouter au pack</button>${list.some((a) => !a.analyzed) ? '<button class="bigbtn sec" data-do="analyze">Analyser</button>' : ''}</div>

      <div class="panel-h" style="padding-left:0;margin-top:10px">Ouverture</div>
      <div class="vrow"><select data-sel="opening">${opts('opening', pick('opening')) || '<option value="">(aucune)</option>'}</select><button class="ibtn primary" data-do="opening">Poser à 0</button></div>
      <p class="hint">La première image de la vidéo est l'image où l'explosion couvre tout l'écran ; les sous-titres attendent que le plan soit découvert (couverture &lt; 60 %).</p>

      <div class="panel-h" style="padding-left:0;margin-top:10px">Transitions</div>
      <div class="vrow"><select data-sel="transition">${opts('transition', pick('transition')) || '<option value="">(aucune)</option>'}</select><button class="ibtn primary" data-do="transition">Sur la coupe la plus proche</button></div>
      ${sugg.length ? `<p class="hint">Emplacements proposés (début de phrase, 2 images avant le mot) :</p><div class="chips">${sugg.slice(0, 12).map((s) => `<button class="chip" data-sugg="${s.frame}" title="${s.nearestCut !== null ? 'coupe existante à ' + sec(s.nearestCut) + ' s' : 'aucune coupe'}">${sec(s.frame)} s · « ${esc(s.word)} »</button>`).join('')}</div>` : '<p class="hint">Les emplacements proposés apparaissent quand la voix est posée.</p>'}

      <div class="panel-h" style="padding-left:0;margin-top:10px">Abonne-toi</div>
      <div class="vrow"><select data-sel="subscribe">${opts('subscribe', pick('subscribe')) || '<option value="">(aucune)</option>'}</select><button class="ibtn primary" data-do="subscribe" ${abo ? '' : 'disabled'}>Poser sur « ${esc(abo ? abo.w : 'abonne')} »</button></div>
      ${abo ? `<p class="hint">Mot « ${esc(abo.w)} » à ${sec(abo.frame)} s : la partie visible de l'animation commence pile sur ce mot.</p>` : '<p class="warn">Le mot « abonne » n\'est pas (encore) dans la voix posée.</p>'}

      <div class="panel-h" style="padding-left:0;margin-top:10px">Logo et copyright</div>
      <div class="vrow"><select data-sel="logo">${opts('logo', pick('logo')) || '<option value="">(aucun)</option>'}</select><button class="ibtn primary" data-do="logo">Poser (toute la vidéo)</button></div>
      <div class="vrow"><label class="chk"><input type="checkbox" id="crOn" ${cr.enabled ? 'checked' : ''}> Copyright</label><input id="crText" type="text" placeholder="© NOM DU STUDIO, NOM DU CO-PRODUCTEUR" value="${esc(cr.text)}" style="flex:1"></div>
      <p class="hint">Rappel : le copyright affiché ne remplace pas une autorisation ; les droits des extraits restent à leurs ayants droit.</p>

      <div class="panel-h" style="padding-left:0;margin-top:10px">Sons</div>
      <div class="vbtns"><button class="bigbtn sec" data-do="sfx">Poser les click / pop</button></div>
      <p class="hint">« click » sur chaque groupe avec un mot important (jaune), « pop » sur le texte impact (rouge), à l'image du pop, au moins 0,4 s d'écart.</p>
      <div class="vrow"><select data-sel="music">${opts('music', pick('music')) || '<option value="">(aucune)</option>'}</select><button class="ibtn primary" data-do="music">Musique de fond</button></div>

      <div class="panel-h" style="padding-left:0;margin-top:10px">Posés sur la timeline</div>
      ${placedHtml()}

      <div class="panel-h" style="padding-left:0;margin-top:10px">Niveaux (mixage)</div>
      ${mixHtml()}`;
  }

  async function withAsset(id, fn) {
    if (!id) { toast('Ajoutez d\'abord cet élément au pack de marque'); return; }
    busy = 'Analyse de l\'élément'; render();
    try { const a = await assets.analyzed(id); busy = ''; await fn(a); } catch (e) { busy = ''; toast(String(e.message || e)); }
    render();
  }

  const place = (label, clip, replaceRole = null) => store.commit(label, (d) => {
    if (replaceRole) d.clips = d.clips.filter((c) => !(c.track === 'V2' && c.role === replaceRole));
    d.clips.push(clip);
  });

  /** Coupe V1 la plus proche d'une image (ou null). */
  const nearestCut = (f) => {
    const cuts = store.doc.clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start).slice(1).map((c) => c.start);
    return cuts.length ? cuts.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a)) : null;
  };

  async function putTransition(at) {
    await withAsset(pick('transition'), (a) => {
      const cut = nearestCut(at);
      if (cut === null) { toast('Posez d\'abord au moins deux clips sur V1'); return; }
      const r = placeTransition(store.doc, a, cut);
      if (!r.clip) { toast(r.errors[0]); return; }
      place('Transition', r.clip);
      const issues = checkTransition(store.doc, r.clip, { getSource: (id) => lib.get(id) });
      toast(issues.length ? '⚠ ' + issues[0].msg : `Transition calée : coupe à ${sec(cut)} s, au milieu de la couverture totale`);
      player.seek(cut);
    });
  }

  el.addEventListener('click', async (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!b) return;
    const doIt = b.dataset.do;
    if (doIt === 'import') {
      const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true;
      inp.accept = '.zip,video/*,audio/*,image/*,.woff,.woff2,.ttf,.otf';
      inp.onchange = async () => {
        busy = 'Import'; render();
        try { const r = await importBrandFiles(Array.from(inp.files || [])); r.warnings.forEach(toast); await assets.load(); for (const x of r.added) { busy = 'Analyse de ' + x.name; render(); try { await assets.analyzed(x.id); } catch (err) { toast(String(err.message || err)); } } }
        finally { busy = ''; render(); }
      };
      inp.click(); return;
    }
    if (doIt === 'analyze') { for (const a of assets.manifest.assets.filter((x) => !x.analyzed)) { busy = 'Analyse de ' + a.name; render(); try { await assets.analyzed(a.id); } catch (err) { toast(String(err.message || err)); } } busy = ''; render(); return; }
    if (doIt === 'opening') return withAsset(pick('opening'), (a) => { const r = placeOpening(store.doc, a); place('Ouverture', r.clip, 'opening'); r.warnings.forEach(toast); player.seek(0); });
    if (doIt === 'transition') return putTransition(store.ui.playhead);
    if (doIt === 'subscribe') return withAsset(pick('subscribe'), (a) => { const r = placeSubscribe(store.doc, a); if (!r.clip) { toast(r.warnings[0]); return; } place('Abonne-toi', r.clip, 'subscribe'); toast(`Abonne-toi calé sur « ${r.clip.word} » à ${sec(r.clip.wordFrame)} s`); player.seek(r.clip.wordFrame); });
    if (doIt === 'logo') return withAsset(pick('logo'), (a) => { const r = placeLogo(store.doc, a); place('Logo', r.clip, 'logo'); });
    if (doIt === 'sfx') {
      const sfx = assets.byKind('sfx');
      const click = sfx.find((a) => a.role === 'click') || sfx[0], pop = sfx.find((a) => a.role === 'pop') || click;
      if (!click) { toast('Ajoutez un son « click » et un son « pop » au pack de marque'); return; }
      for (const a of new Set([click, pop])) await assets.analyzed(a.id);
      const r = sfxClips(store.doc, { click: /** @type {any} */ (assets.get(click.id)), pop: /** @type {any} */ (assets.get(pop.id)) });
      store.commit('SFX', (d) => { d.clips = d.clips.filter((c) => !(c.track === 'A3' && c.auto)); d.clips.push(...r.clips); });
      toast(`${r.clips.length} son(s) posé(s)${r.skipped.length ? `, ${r.skipped.length} ignoré(s) (moins de 0,4 s d'écart)` : ''}`);
      return;
    }
    if (doIt === 'music') return withAsset(pick('music'), (a) => {
      const end = contentEnd(store.doc);
      if (!end) { toast('La timeline est vide'); return; }
      const clip = makeClip({ track: 'A2', role: 'music', assetId: a.id, assetName: a.name, start: 0, dur: end, srcIn: 0, loop: a.duration * fps() < end, gainDb: 0 });
      delete clip.crop; delete clip.srcId;
      store.commit('Musique', (d) => { d.clips = d.clips.filter((c) => c.track !== 'A2'); d.clips.push(clip); });
      toast('Musique posée : −16 dB par rapport à la voix, ducking, fondu de sortie 1,5 s');
    });
    if (doIt === 'mix') { busy = 'Mixage'; render(); mixInfo = await player.prepareMix(); busy = ''; render(); return; }
    if (b.dataset.sugg) return putTransition(Number(b.dataset.sugg));
    if (b.dataset.go) { player.seek(Number(b.dataset.go)); return; }
    if (b.dataset.del) { store.commit('Retirer l\'overlay', (d) => { d.clips = d.clips.filter((c) => c.id !== b.dataset.del); }); return; }
    if (b.dataset.realign) { store.commit('Recaler la transition', (d) => { const c = d.clips.find((x) => x.id === b.dataset.realign); if (c) realignTransition(d, c); }); return; }
    if (b.dataset.rm) { if (confirm('Retirer cet élément du pack de marque (sur cet appareil) ?')) { await removeAsset(b.dataset.rm); await assets.load(); } }
  });

  el.addEventListener('change', async (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.dataset.sel) { sel[t.dataset.sel] = t.value; return; }
    if (t.dataset.role) { await updateAsset(t.dataset.role, { kind: t.value }); await assets.load(); return; }
    if (t.dataset.key) {
      const id = t.dataset.key, a = assets.get(id);
      const keying = { ...(a.keying || {}), method: /** @type {any} */ (t.value) };
      await updateAsset(id, { keying, keyingManual: true, analyzed: 0 });
      await assets.load(); await assets.analyzed(id);
      // Les overlays déjà posés reprennent la méthode choisie.
      store.commit('Retrait de fond', (d) => { for (const c of d.clips) if (c.assetId === id) c.keying = { ...keying }; });
      return;
    }
    if (t.dataset.mix) { const k = t.dataset.mix, v = Number(t.value); store.commit('Mixage', (d) => { d.mix = { ...(d.mix || {}), [k]: v }; }); mixInfo = null; render(); return; }
    if (t.id === 'crOn' || t.id === 'crText') {
      const on = /** @type {HTMLInputElement} */ (el.querySelector('#crOn')).checked, text = /** @type {HTMLInputElement} */ (el.querySelector('#crText')).value.trim();
      store.commit('Copyright', (d) => { d.copyright = { ...(d.copyright || {}), enabled: on, text }; });
      player.redraw();
    }
  });

  el.addEventListener('focusout', () => { if (deferred) { deferred = false; setTimeout(render, 0); } });
  let timer = null;
  store.subscribe((k) => { if (k !== 'doc') return; mixInfo = null; clearTimeout(timer); timer = setTimeout(render, 150); });
  assets.addEventListener('change', render);
  render();
  return { render, fmt: fmtTime };
}
