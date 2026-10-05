// Rastérisation des mots d'un groupe de sous-titres en HAUTE RÉSOLUTION (suréchantillonnage ×2) dans un atlas,
// avec contour 1 px et ombre exacts à la taille finale. Le GPU affiche ensuite chaque mot à l'échelle et à la position
// voulues (sous-pixel, mipmaps) : pas de crénelage, pas de scintillement, pas de palier.
// Thread principal (les polices importées sont dans document.fonts ; Safari ne les expose pas aux workers).
import { STYLE } from '../subs/layout.js';

export const SS = 2;             // facteur de suréchantillonnage
// L’échelle maximale (pop impact 1,6 × zoom 1,03) reste ≤ SS : le GPU ne fait que réduire la texture.

/** Mesure de texte (largeur et hauteur des majuscules) pour une police donnée. @param {string} family @param {number} [weight] */
export function makeMeasure(family, weight = 700) {
  const ctx = new OffscreenCanvas(8, 8).getContext('2d');
  const cache = new Map();
  return (/** @type {string} */ text, /** @type {number} */ size) => {
    const k = text + '\u0000' + size;
    let r = cache.get(k);
    if (!r) {
      ctx.font = `${weight} ${size}px "${family}"`;
      const m = ctx.measureText(text);
      const cap = ctx.measureText('H');
      r = { width: m.width, capHeight: cap.actualBoundingBoxAscent };
      cache.set(k, r);
    }
    return r;
  };
}

/**
 * Vérifie que la police de la marque est RÉELLEMENT utilisée (jamais de police de secours silencieuse) :
 * la FontFace doit être chargée et le rendu doit différer de celui de deux polices génériques.
 * @param {string} family
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkFont(family, weight = 700) {
  const faces = [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === family);
  if (!faces.length) return { ok: false, reason: `La police « ${family} » n'est pas importée.` };
  if (!faces.some((f) => f.status === 'loaded')) return { ok: false, reason: `La police « ${family} » n'est pas encore chargée.` };
  const ctx = new OffscreenCanvas(8, 8).getContext('2d');
  const sample = 'ÉÀÇŒ HAMBURGEFONSTIV 0123456789';
  const width = (f) => { ctx.font = `${weight} 100px ${f}`; return ctx.measureText(sample).width; };
  const w = width(`"${family}", monospace`), w2 = width(`"${family}", serif`);
  if (Math.abs(w - width('monospace')) < 0.5 || Math.abs(w2 - width('serif')) < 0.5 || Math.abs(w - w2) > 0.5) {
    return { ok: false, reason: `La police « ${family} » ne s'applique pas (rendu identique à une police de secours).` };
  }
  return { ok: true, reason: '' };
}

/**
 * Atlas d'un groupe : chaque mot rastérisé à sa taille finale × SS, avec contour et ombre.
 * @param {import('../subs/layout.js').PlacedWord[]} words @param {string} family
 * @returns {{ canvas: OffscreenCanvas, rects: { x: number, y: number, w: number, h: number, cx: number, cy: number }[] }}
 *   rects : rectangle du mot dans l'atlas (px atlas) et position de son centre (centre des majuscules) dans ce rectangle
 */
export function rasterGroup(words, family, weight = 700) {
  const st = STYLE, pad = Math.ceil((st.shadow.blur * 2 + Math.max(Math.abs(st.shadow.dx), Math.abs(st.shadow.dy)) + st.stroke.width + 2) * SS);
  const meas = new OffscreenCanvas(8, 8).getContext('2d');
  const boxes = words.map((w) => {
    meas.font = `${weight} ${w.size * SS}px "${family}"`;
    const m = meas.measureText(w.text);
    const asc = Math.ceil(m.actualBoundingBoxAscent), desc = Math.ceil(m.actualBoundingBoxDescent);
    const left = Math.ceil(m.actualBoundingBoxLeft), right = Math.ceil(m.actualBoundingBoxRight);
    const cap = meas.measureText('H').actualBoundingBoxAscent;
    return { w: left + right + 2 * pad, h: asc + desc + 2 * pad, left, asc, cap, advance: m.width };
  });
  // Rangement simple en lignes (atlas d'au plus 4096 px de large).
  const maxW = Math.min(4096, Math.max(...boxes.map((b) => b.w)) * 2);
  let x = 0, y = 0, rowH = 0;
  const rects = boxes.map((b) => {
    if (x + b.w > maxW) { x = 0; y += rowH; rowH = 0; }
    const r = { x, y, w: b.w, h: b.h, cx: 0, cy: 0 };
    x += b.w; rowH = Math.max(rowH, b.h);
    return r;
  });
  const canvas = new OffscreenCanvas(Math.max(1, maxW), Math.max(1, y + rowH));
  const ctx = canvas.getContext('2d');
  words.forEach((w, i) => {
    const b = boxes[i], r = rects[i];
    // Origine du texte : début de la chasse (x) et ligne de base (y).
    const ox = r.x + pad + b.left, oy = r.y + pad + b.asc;
    ctx.font = `${weight} ${w.size * SS}px "${family}"`;
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    const color = st.colors[w.kind] || st.colors.normal;
    // 1) ombre seule (texte + contour), 2) contour 1 px EXTÉRIEUR (trait de 2 px dont la moitié intérieure est
    //    recouverte), 3) remplissage.
    ctx.save();
    ctx.shadowColor = st.shadow.color; ctx.shadowBlur = st.shadow.blur * SS;
    ctx.shadowOffsetX = st.shadow.dx * SS; ctx.shadowOffsetY = st.shadow.dy * SS;
    ctx.fillStyle = '#000'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2 * st.stroke.width * SS;
    // L'ombre est dessinée par un texte hors champ décalé : seule l'ombre retombe dans l'atlas.
    const far = 100000;
    ctx.shadowOffsetX += far;
    ctx.strokeText(w.text, ox - far, oy); ctx.fillText(w.text, ox - far, oy);
    ctx.restore();
    ctx.strokeStyle = st.stroke.color; ctx.lineWidth = 2 * st.stroke.width * SS;
    ctx.strokeText(w.text, ox, oy);
    ctx.fillStyle = color;
    ctx.fillText(w.text, ox, oy);
    // Centre du mot dans l'atlas : milieu de la chasse, milieu des majuscules.
    r.cx = ox + b.advance / 2 - r.x;
    r.cy = oy - b.cap / 2 - r.y;
  });
  return { canvas, rects };
}
