// Panneau « Fin » : climax (source + départ choisis par l'utilisateur, ou 3 propositions classées), cartons de texte
// remplacés, miniature 1,5-2 s, durées en continu (cible = voix + climax + miniature) et secondes exactes de début du
// climax et de la miniature.
import { endDurations, buildEnd, applyEnd, suggestClimax } from './ending.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fr = (n, d = 1) => Number(n).toFixed(d).replace('.', ',');
const mmss = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0').replace('.', ',')}`;
/** « 0:35 », « 35,5 », « 1:02.4 » → secondes. */
export function parseTime(v) {
  const t = String(v).trim().replace(',', '.');
  const m = t.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? (Number(m[1] || 0) * 60 + Number(m[2])) : NaN;
}

/** @param {{ el: HTMLElement, store: any, lib: any, player: any, toast: (m: string) => void }} o */
export function createEndPanel({ el, store, lib, player, toast }) {
  let sugg = null, busy = '', last = null;
  const state = { srcId: '', start: '', thumbId: '', thumbSec: 1.75 };

  function render() {
    const ae = document.activeElement;
    if (ae && el.contains(ae) && ae.matches('input[type=text], input[type=number]')) return;
    const d = store.doc, fps = d.project.fps;
    const vids = lib.list.filter((r) => r.kind === 'video' && r.status === 'ready');
    const imgs = lib.list.filter((r) => r.kind === 'image' && r.status === 'ready');
    if (d.end && d.end.climax && !state.srcId) { state.srcId = d.end.climax.srcId; state.start = fr(d.end.climax.start, 2); }
    if (d.end && d.end.thumbnail && !state.thumbId) { state.thumbId = d.end.thumbnail.srcId; state.thumbSec = d.end.thumbnail.sec || 1.75; }
    if (!state.srcId && vids[0]) state.srcId = vids[0].id;
    if (!state.thumbId && imgs[0]) state.thumbId = imgs[0].id;
    const dur = endDurations(d, { thumbSec: state.thumbSec });
    const placed = d.clips.filter((c) => c.role === 'climax' && c.track === 'V1').sort((a, b) => a.start - b.start);
    const th = d.clips.find((c) => c.role === 'thumbnail');
    el.innerHTML = `
      ${busy ? `<div class="vsum">${esc(busy)}…</div>` : ''}
      <div class="vsum"><b>Voix ${fr(dur.startF / fps)} s</b> + climax ${fr(dur.climaxF / fps)} s + miniature ${fr(dur.thumbF / fps, 2)} s = <b>${fr(dur.totalF / fps)} s</b> <span class="muted">(cible ${fr(d.project.target.min)}–${fr(d.project.target.max)} s)</span>
        ${dur.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}${dur.suggestion ? `<div class="muted">Proposition : ${esc(dur.suggestion)}</div>` : ''}</div>
      <div class="panel-h" style="padding-left:0">Climax</div>
      <div class="vrow"><select id="eSrc" aria-label="Trailer">${vids.map((r) => `<option value="${r.id}" ${r.id === state.srcId ? 'selected' : ''}>${esc(r.name)}</option>`).join('') || '<option value="">(aucun trailer)</option>'}</select>
        <label class="chk">départ <input id="eStart" type="text" inputmode="decimal" placeholder="0:35" value="${esc(state.start)}" style="width:76px"></label></div>
      <div class="vbtns"><button class="bigbtn sec" data-do="suggest" ${vids.length ? '' : 'disabled'}>Proposer 3 climax</button><button class="bigbtn" data-do="place" ${vids.length ? '' : 'disabled'}>Poser la fin</button></div>
      ${sugg ? `<div class="chips">${sugg.map((s, i) => `<button class="chip" data-pick="${s.start}" title="${esc(JSON.stringify(s.parts))}">${i + 1}. ${mmss(s.start)} · score ${fr(s.score, 2)}${s.why.length ? ' · ' + esc(s.why.join(', ')) : ''}</button>`).join('')}</div><p class="hint">Vous décidez : touchez une proposition pour la reprendre comme départ, puis « Poser la fin ».</p>` : ''}
      <div class="panel-h" style="padding-left:0;margin-top:10px">Miniature</div>
      <div class="vrow"><select id="eThumb" aria-label="Miniature">${imgs.map((r) => `<option value="${r.id}" ${r.id === state.thumbId ? 'selected' : ''}>${esc(r.name)}</option>`).join('') || '<option value="">(importez une image)</option>'}</select>
        <label class="chk">durée <input id="eThumbSec" type="number" min="1.5" max="2" step="0.05" value="${state.thumbSec}" style="width:64px"> s</label></div>
      <p class="hint">Image en 9:16 posée plein écran ; sinon centrée sur fond flou, jamais déformée. Pas de sous-titre ni d'abonne-toi ; logo et copyright restent ; le son du trailer s'efface.</p>
      ${placed.length ? `<div class="panel-h" style="padding-left:0;margin-top:10px">Fin posée</div>
        <div class="placed">Climax à <b>${fr(placed[0].start / fps, 2)} s</b> (image ${placed[0].start}) · ${placed.length} morceau(x)${placed.filter((c) => c.replaces).map((c) => ` · carton ${fr(c.replaces[0])}–${fr(c.replaces[1])} s remplacé`).join('')}
        <button class="ibtn" data-go="${placed[0].start}">Voir</button></div>
        ${th ? `<div class="placed">Miniature à <b>${fr(th.start / fps, 2)} s</b> (image ${th.start}) pendant ${fr(th.dur / fps, 2)} s <button class="ibtn" data-go="${th.start}">Voir</button></div>` : ''}
        ${last ? last.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('') : ''}` : ''}`;
  }

  async function envelope(srcId, rate = 8) {
    const pcm = await player.mixer.sourcePcm(srcId);
    if (!pcm) return null;
    const x = pcm[0], hop = Math.round(48000 / rate), n = Math.floor(x.length / hop), env = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let k = i * hop; k < (i + 1) * hop; k++) { let v = x[k]; if (pcm[1]) v = (v + pcm[1][k]) / 2; s += v * v; } env[i] = 10 * Math.log10(s / hop + 1e-12); }
    return env;
  }

  el.addEventListener('click', async (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!b) return;
    if (b.dataset.go) { player.seek(Number(b.dataset.go)); return; }
    if (b.dataset.pick) { state.start = fr(Number(b.dataset.pick), 2); render(); return; }
    if (b.dataset.do === 'suggest') {
      const rec = lib.get(state.srcId);
      if (!rec || !rec.feat) { toast('Trailer pas encore analysé (ou à réanalyser pour la fin de vidéo)'); return; }
      busy = 'Analyse du trailer'; render();
      try {
        const env = await envelope(rec.id);
        const dur = endDurations(store.doc, { thumbSec: state.thumbSec });
        sugg = suggestClimax(rec, env || new Float32Array(rec.feat.d.length).fill(-30), dur.climaxF / store.doc.project.fps);
        if (!env) toast('Ce trailer n\'a pas de son : proposition sur l\'image seulement');
      } finally { busy = ''; render(); }
      return;
    }
    if (b.dataset.do === 'place') {
      const rec = lib.get(state.srcId);
      const start = parseTime(state.start);
      if (!rec) { toast('Choisissez le trailer du climax'); return; }
      if (!Number.isFinite(start)) { toast('Indiquez le départ du climax (ex. 0:35) ou utilisez « Proposer »'); return; }
      const thumbRec = lib.get(state.thumbId) || null;
      const built = buildEnd(store.doc, { rec, startSec: start, thumbRec, thumbSec: state.thumbSec });
      store.commit('Fin de vidéo', (d) => applyEnd(d, built, { climax: { srcId: rec.id, start }, thumbnail: thumbRec ? { srcId: thumbRec.id, sec: state.thumbSec } : null }));
      last = built;
      built.warnings.forEach((w) => toast(w));
      toast(`Fin posée : climax à ${fr(built.info.climaxStartSec, 2)} s, miniature à ${fr(built.info.thumbStartSec, 2)} s, total ${fr(built.info.totalSec)} s`);
      player.seek(built.dur.startF);
    }
  });

  el.addEventListener('change', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.id === 'eSrc') { state.srcId = t.value; sugg = null; }
    if (t.id === 'eStart') state.start = t.value;
    if (t.id === 'eThumb') state.thumbId = t.value;
    if (t.id === 'eThumbSec') state.thumbSec = Math.max(1.5, Math.min(2, Number(t.value) || 1.75));
    render();
  });
  el.addEventListener('focusout', () => setTimeout(render, 0));

  let timer = null;
  store.subscribe((k) => { if (k === 'doc') { clearTimeout(timer); timer = setTimeout(render, 150); } });
  lib.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(render, 150); });
  render();
  return { render };
}
