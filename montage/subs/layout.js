// Mise en page d'un groupe de sous-titres (fonction pure ; la mesure du texte est injectée pour être testable).
// Brief 2.6 : TAILLE CONSTANTE (jamais réduite), centre exact de l'image, marges latérales de 90 px, mot important
// sur la ligne suivante DANS LE MÊME BLOC, deux lignes maximum centrées ensemble, interligne serré.
import { upperFr, typoFr } from './french.js';

export const STYLE = {
  width: 1080, height: 1920, sideMargin: 90,
  importantScale: 1.25, impactScale: 1.4,
  lineAdvance: 1.04,              // distance entre lignes de base / taille de police (majuscules : pas de jambages)
  colors: { normal: '#FFFFFF', important: '#FFEA00', impact: '#FF2424' },
  stroke: { width: 1, color: 'rgba(0,0,0,0.7)' },
  shadow: { dx: 3, dy: 3, blur: 4, color: 'rgba(0,0,0,0.45)' },
};

/** @typedef {(text: string, sizePx: number) => { width: number, capHeight: number, left?: number, right?: number }} Measure
 *   left/right : étendue de l'encre de part et d'autre de l'origine (actualBoundingBoxLeft/Right) */
/** @typedef {{ text: string, kind: string, size: number, x: number, y: number, w: number }} PlacedWord
 *   x, y = CENTRE du mot (px, image 1080×1920) ; y = centre des majuscules */

/**
 * Taille de base : le plus long mot important du projet, à ×1,25, tient dans maxImportantWidth (≈ 900 px), et aucun mot
 * normal ne dépasse la largeur utile. Calculée UNE fois pour toute la vidéo (taille constante).
 * @param {string[]} importantWords @param {string[]} allWords @param {Measure} measure
 * Les mots sont mesurés TELS QU'AFFICHÉS (typographie, ponctuation) et le texte impact à ×1,4 tient aussi.
 * @param {{ maxImportantWidth?: number, maxSize?: number, impactWords?: string[] }} [opt]
 */
export function baseFontSize(importantWords, allWords, measure, opt = {}) {
  const usable = STYLE.width - 2 * STYLE.sideMargin;
  const target = opt.maxImportantWidth ?? 900, maxSize = opt.maxSize ?? 110;
  let size = maxSize;
  const ref = 100;
  const wd = (w) => measure(upperFr(typoFr(w.trim())), ref).width;
  for (const w of importantWords) size = Math.min(size, (target / (wd(w) * STYLE.importantScale)) * ref);
  for (const w of opt.impactWords || []) size = Math.min(size, (usable / (wd(w) * STYLE.impactScale)) * ref);
  for (const w of allWords) size = Math.min(size, (usable / wd(w)) * ref);
  return Math.floor(size * 10) / 10;
}

/**
 * Place les mots d'un groupe. Ne réduit JAMAIS la taille : si une ligne est trop large, retour à la ligne équilibré ;
 * si c'est encore impossible (mot isolé plus large que l'écran), `overflow` est vrai (alerte « texte hors cadre »).
 * @param {{ w: string, kind?: string }[]} words @param {number} base taille de base (px) @param {Measure} measure
 * @returns {{ words: PlacedWord[], lines: number, width: number, height: number, overflow: boolean }}
 */
export function layoutGroup(words, base, measure) {
  const usable = STYLE.width - 2 * STYLE.sideMargin;
  const items = words.map((w) => {
    const kind = w.kind || 'normal';
    const size = base * (kind === 'important' ? STYLE.importantScale : kind === 'impact' ? STYLE.impactScale : 1);
    const text = upperFr(typoFr(w.w.trim()));
    const m = measure(text, size);
    return { text, kind, size, w: m.width, cap: m.capHeight, inkL: m.left ?? 0, inkR: m.right ?? m.width, space: measure(' ', size).width };
  });
  const lineWidth = (/** @type {typeof items} */ l) => l.reduce((a, it, i) => a + it.w + (i ? Math.max(l[i - 1].space, it.space) : 0), 0);
  // 1) mot(s) important(s) / impact : sur leur propre ligne dans le même bloc (si le groupe mélange les styles).
  let lines;
  const firstEm = items.findIndex((it) => it.kind !== 'normal');
  const mixed = firstEm >= 0 && items.some((it) => it.kind === 'normal');
  if (mixed) {
    let lastEm = firstEm;
    while (lastEm + 1 < items.length && items[lastEm + 1].kind !== 'normal') lastEm++;
    if (firstEm > 0) lines = [items.slice(0, firstEm), items.slice(firstEm)];
    else lines = [items.slice(0, lastEm + 1), items.slice(lastEm + 1)];
  } else lines = [items];
  // 2) trop large : coupure équilibrée en 2 lignes (la plus large des deux la plus courte possible).
  if (lines.length === 1 && lineWidth(lines[0]) > usable && items.length > 1) {
    let best = null;
    for (let k = 1; k < items.length; k++) {
      const a = items.slice(0, k), b = items.slice(k), m = Math.max(lineWidth(a), lineWidth(b));
      if (!best || m < best.m) best = { m, l: [a, b] };
    }
    lines = best.l;
  }
  // Une ligne trop large même ainsi : on tente de déplacer un mot vers l'autre ligne.
  if (lines.length === 2) {
    for (let guard = 0; guard < 4 && lineWidth(lines[1]) > usable && lines[1].length > 1; guard++) lines = [[...lines[0], lines[1][0]], lines[1].slice(1)];
    for (let guard = 0; guard < 4 && lineWidth(lines[0]) > usable && lines[0].length > 1; guard++) lines = [lines[0].slice(0, -1), [lines[0][lines[0].length - 1], ...lines[1]]];
  }
  // 3) positions : bloc centré à (540, 960) ; lignes centrées ; centre des majuscules.
  const lineSize = lines.map((l) => Math.max(...l.map((it) => it.size)));
  const capOf = (l) => Math.max(...l.map((it) => it.cap));
  const centers = [0];
  for (let i = 1; i < lines.length; i++) centers.push(centers[i - 1] + STYLE.lineAdvance * lineSize[i] - (capOf(lines[i]) - capOf(lines[i - 1])) / 2);
  const top = centers[0] - capOf(lines[0]) / 2, bottom = centers[lines.length - 1] + capOf(lines[lines.length - 1]) / 2;
  const shiftY = STYLE.height / 2 - (top + bottom) / 2;
  const placed = [];
  let overflow = false, width = 0;
  lines.forEach((l, li) => {
    const lw = lineWidth(l);
    width = Math.max(width, lw);
    if (lw > usable + 0.5) overflow = true;
    // Centrage sur l'ENCRE visible (et non sur la chasse) : une ligne qui finit par « ! » reste au centre exact.
    const inkStart = -l[0].inkL, inkEnd = lw - l[l.length - 1].w + l[l.length - 1].inkR;
    let x = STYLE.width / 2 - (inkStart + inkEnd) / 2;
    l.forEach((it, i) => {
      if (i) x += Math.max(l[i - 1].space, it.space);
      placed.push({ text: it.text, kind: it.kind, size: it.size, x: x + it.w / 2, y: centers[li] + shiftY, w: it.w });
      x += it.w;
    });
  });
  return { words: placed, lines: lines.length, width, height: bottom - top, overflow };
}
