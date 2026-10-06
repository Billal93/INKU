// Linting : les règles de la méthode deviennent des alertes. Aucune règle ne bloque (seul l'export refuse une police
// absente). Fonction pure : (doc, getSource) -> [{ id, clipId, level:'warn'|'err'|'info', code, msg, fix? }]
import { intervalUsage, clipEnd } from './edl.js';
import { checkTransition, findSubscribeWord, contentEnd, SFX_SPACING_SEC } from './overlays.js';
import { endDurations } from './ending.js';

export function lintDoc(doc, getSource) {
  const out = [];
  const fps = doc.project.fps;
  const rules = doc.project.rules;
  const v1 = doc.clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start);
  v1.filter((c) => !c.role).forEach((c, i) => {
    const sec = c.dur / fps;
    const n = i + 1;
    if (sec < rules.clipMin - 1e-9) out.push({ id: c.id + ':min', clipId: c.id, level: 'err', code: 'clip-court', msg: `Clip ${n} : ${sec.toFixed(1).replace('.', ',')} s, sous le minimum de ${rules.clipMin.toString().replace('.', ',')} s.`, fix: 'extend' });
    if (sec > rules.clipMax + 1e-9) out.push({ id: c.id + ':max', clipId: c.id, level: 'warn', code: 'clip-long', msg: `Clip ${n} : ${sec.toFixed(1).replace('.', ',')} s, au-dessus du maximum de ${rules.clipMax.toString().replace('.', ',')} s.`, fix: 'trim-max' });
    const src = getSource(c.srcId);
    if (!src) { out.push({ id: c.id + ':src', clipId: c.id, level: 'err', code: 'source-absente', msg: `Clip ${n} : source introuvable.` }); return; }
    if (src.duration && c.srcIn + sec > src.duration + 0.05) out.push({ id: c.id + ':end', clipId: c.id, level: 'err', code: 'hors-source', msg: `Clip ${n} : dépasse la fin de la source.`, fix: 'trim-source' });
    const reused = intervalUsage(doc, c.srcId, c.srcIn, c.srcIn + sec, c.id);
    if (reused.length) out.push({ id: c.id + ':reuse', clipId: c.id, level: 'warn', code: 'plan-reutilise', msg: `Clip ${n} : réutilise un passage déjà employé de « ${src.name} ».`, fix: 'other-shot' });
    const shot = (src.shots || []).find((s) => c.srcIn >= s.start - 1e-3 && c.srcIn < s.end);
    if (shot && shot.black) out.push({ id: c.id + ':black', clipId: c.id, level: 'warn', code: 'plan-noir', msg: `Clip ${n} : plan quasi noir.` });
    if (shot && shot.motion < 0.008 && sec > rules.stillMax) out.push({ id: c.id + ':still', clipId: c.id, level: 'warn', code: 'plan-immobile', msg: `Clip ${n} : plan quasi immobile pendant ${sec.toFixed(1).replace('.', ',')} s (max ${rules.stillMax.toString().replace('.', ',')} s sans mouvement).`, fix: 'trim-still' });
    // un plan qui chevauche une coupe source : le clip contient un changement de plan
    if (shot && c.srcIn + sec > shot.end + 2 / fps) out.push({ id: c.id + ':cut', clipId: c.id, level: 'warn', code: 'coupe-source', msg: `Clip ${n} : contient un changement de plan de la source.`, fix: 'trim-shot' });
    // Carton de texte dans le clip (titre, date, crédits) : à éviter sauf choix explicite.
    if (src.feat && !c.allowText) {
      const a = Math.floor(c.srcIn * src.feat.rate), b = Math.ceil((c.srcIn + sec) * src.feat.rate);
      let k = 0; for (let j = Math.max(0, a); j < Math.min(src.feat.card.length, b); j++) k += src.feat.card[j];
      if (k >= 2) out.push({ id: c.id + ':card', clipId: c.id, level: 'warn', code: 'carton-texte', msg: `Clip ${n} : contient un carton de texte (titre, date ou crédits).`, fix: 'other-shot' });
    }
    const prev = v1[i - 1];
    if (prev && c.start - (prev.start + prev.dur) > 0) out.push({ id: c.id + ':gap', clipId: c.id, level: 'warn', code: 'trou', msg: `Trou de ${((c.start - prev.start - prev.dur) / fps).toFixed(1).replace('.', ',')} s avant le clip ${n}.`, fix: 'close-gap' });
  });
  out.push(...lintProject(doc, getSource));
  return out;
}

const fr1 = (v) => v.toFixed(1).replace('.', ',');

/** Règles globales : durée, fin de vidéo, transitions, abonne-toi, sous-titres, sources. */
export function lintProject(doc, getSource) {
  const out = [];
  const fps = doc.project.fps, t = doc.project.target;
  const total = contentEnd(doc) / fps;
  const hasEnd = doc.clips.some((c) => c.role === 'climax');
  if (doc.clips.length && (total < t.min - 1e-6 || total > t.max + 1e-6)) {
    out.push({ id: 'g:duree', clipId: null, level: 'warn', code: 'duree-hors-cible', msg: `Durée ${fr1(total)} s hors de la cible ${fr1(t.min)}–${fr1(t.max)} s.`, fix: hasEnd ? 'fit-end' : undefined });
  }
  if (hasEnd) {
    const climax = doc.clips.filter((c) => c.role === 'climax' && c.track === 'V1').reduce((a, c) => a + c.dur, 0) / fps;
    if (climax < 6 - 1e-6 || climax > 10 + 1e-6) out.push({ id: 'g:climax', clipId: null, level: 'warn', code: 'climax-duree', msg: `Climax de ${fr1(climax)} s (attendu entre 6 et 10 s). ${endDurations(doc).suggestion || ''}`.trim() });
  }
  for (const c of doc.clips.filter((x) => x.track === 'V2' && x.role === 'transition')) {
    for (const x of checkTransition(doc, c, { getSource })) out.push({ id: c.id + ':' + x.code, clipId: c.id, level: x.level, code: x.code, msg: x.msg, fix: x.fix });
  }
  const t1 = doc.clips.filter((x) => x.track === 'T1' && x.sub).sort((a, b) => a.start - b.start);
  if (t1.length && !doc.clips.some((x) => x.role === 'subscribe') && !findSubscribeWord(doc)) out.push({ id: 'g:abonne', clipId: null, level: 'info', code: 'abonne-absent', msg: 'Le mot « abonne » n’est jamais prononcé : pas d’animation abonne-toi.' });
  let lastImp = null;
  for (const c of t1) {
    if (c.sub.words.length > 4) out.push({ id: c.id + ':long', clipId: c.id, level: 'warn', code: 'sous-titre-long', msg: `Groupe de sous-titres de ${c.sub.words.length} mots (2 à 3 conseillés).` });
    if (c.sub.words.some((w) => w.kind === 'important' || w.kind === 'impact')) {
      if (lastImp && c.start - lastImp.start < SFX_SPACING_SEC * fps) out.push({ id: c.id + ':imp', clipId: c.id, level: 'info', code: 'mots-importants-colles', msg: 'Deux mots importants à moins de 0,4 s : un seul « click » sera joué.' });
      lastImp = c;
    }
  }
  const srcs = new Set(doc.clips.filter((c) => c.track === 'V1' && c.srcId).map((c) => c.srcId));
  for (const id of srcs) {
    const s = getSource(id);
    if (s && s.hdr) out.push({ id: id + ':hdr', clipId: null, level: 'info', code: 'source-hdr', msg: `« ${s.name} » est en HDR : converti en SDR par le navigateur (couleurs à vérifier).` });
    if (s && s.vfr) out.push({ id: id + ':vfr', clipId: null, level: 'info', code: 'source-vfr', msg: `« ${s.name} » a une fréquence d’images variable : convertie une seule fois en 30 i/s constants.` });
  }
  const v1 = doc.clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start);
  const voice = doc.clips.filter((c) => c.track === 'A1').reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  const covered = v1.length ? clipEnd(v1[v1.length - 1]) : 0;
  if (voice && covered < voice) out.push({ id: 'g:trou-fin', clipId: null, level: 'warn', code: 'images-manquantes', msg: `Pas d’image de ${fr1(covered / fps)} s à ${fr1(voice / fps)} s (la voix continue).`, fix: 'fill' });
  return out;
}
