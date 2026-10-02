// Linting : les règles de la méthode deviennent des alertes. Aucune règle ne bloque.
// Fonction pure : (doc, getSource) -> [{ id, clipId, level:'warn'|'err', code, msg, fix? }]
import { intervalUsage } from './edl.js';

export function lintDoc(doc, getSource) {
  const out = [];
  const fps = doc.project.fps;
  const rules = doc.project.rules;
  const v1 = doc.clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start);
  v1.forEach((c, i) => {
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
    const prev = v1[i - 1];
    if (prev && c.start - (prev.start + prev.dur) > 0) out.push({ id: c.id + ':gap', clipId: c.id, level: 'warn', code: 'trou', msg: `Trou de ${((c.start - prev.start - prev.dur) / fps).toFixed(1).replace('.', ',')} s avant le clip ${n}.`, fix: 'close-gap' });
  });
  return out;
}
