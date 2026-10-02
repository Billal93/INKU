// Analyses de sources : bandes noires, couverture d'une transition, cartons de texte.
import { CanvasSink } from '../vendor/mediabunny.min.mjs';

function smallCtx(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c.getContext('2d', { willReadFrequently: true });
}

// Bandes noires (letterbox) : lignes/colonnes continues quasi noires aux bords, valable sur
// PLUSIEURS images (on garde le minimum observé = la valeur sûre) + marge de sécurité de 2 px.
export async function detectLetterbox(videoTrack, timestamps, margin = 2) {
  const sink = new CanvasSink(videoTrack);
  const W = videoTrack.displayWidth, H = videoTrack.displayHeight;
  let top = Infinity, bottom = Infinity, left = Infinity, right = Infinity;
  const strip = smallCtx(64, H); // largeur réduite, hauteur complète (les bandes se mesurent en px réels)
  const side = smallCtx(W, 64);
  for await (const wc of sink.canvasesAtTimestamps(timestamps)) {
    if (!wc) continue;
    strip.clearRect(0, 0, 64, H);
    strip.drawImage(wc.canvas, 0, 0, W, H, 0, 0, 64, H);
    const d = strip.getImageData(0, 0, 64, H).data;
    // Tolérant aux artefacts de compression (ringing aux bords des blocs) : on juge sur la
    // MOYENNE de la ligne, avec un plafond sur le max pour ne pas avaler un vrai contenu clair.
    const rowIsBlack = (y) => {
      let sum = 0, max = 0;
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        const m = Math.max(d[i], d[i + 1], d[i + 2]);
        sum += m; if (m > max) max = m;
      }
      return sum / 64 <= 26 && max <= 110;
    };
    let t = 0; while (t < H / 3 && rowIsBlack(t)) t++;
    let b = 0; while (b < H / 3 && rowIsBlack(H - 1 - b)) b++;
    top = Math.min(top, t); bottom = Math.min(bottom, b);

    side.clearRect(0, 0, W, 64);
    side.drawImage(wc.canvas, 0, 0, W, H, 0, 0, W, 64);
    const e = side.getImageData(0, 0, W, 64).data;
    const colIsBlack = (x) => {
      let sum = 0, max = 0;
      for (let y = 0; y < 64; y++) {
        const i = (y * W + x) * 4;
        const m = Math.max(e[i], e[i + 1], e[i + 2]);
        sum += m; if (m > max) max = m;
      }
      return sum / 64 <= 26 && max <= 110;
    };
    let l = 0; while (l < W / 3 && colIsBlack(l)) l++;
    let r = 0; while (r < W / 3 && colIsBlack(W - 1 - r)) r++;
    left = Math.min(left, l); right = Math.min(right, r);
  }
  const add = (v) => (v > 0 && Number.isFinite(v) ? v + margin : 0);
  top = add(top); bottom = add(bottom); left = add(left); right = add(right);
  return {
    top, bottom, left, right,
    usable: { x: left, y: top, w: W - left - right, h: H - top - bottom },
    source: { w: W, h: H },
  };
}

// Couverture par image d'une transition (fraction de pixels non noirs).
// Fenêtre de couverture totale = images dont la couverture dépasse `fullThreshold`.
// L'image de COUPE = image du milieu de cette fenêtre (en numéro d'image, pas en secondes arrondies).
export async function analyzeTransition(videoTrack, fps, fullThreshold = 0.985) {
  const sink = new CanvasSink(videoTrack);
  const ctx = smallCtx(54, 96);
  const coverage = [];
  const n = Math.floor((await videoTrack.computeDuration()) * fps + 1e-6);
  const ts = Array.from({ length: n }, (_, i) => (i + 0.5) / fps);
  for await (const wc of sink.canvasesAtTimestamps(ts)) {
    if (!wc) { coverage.push(0); continue; }
    ctx.drawImage(wc.canvas, 0, 0, 54, 96);
    const d = ctx.getImageData(0, 0, 54, 96).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) > 16) lit++;
    coverage.push(lit / (54 * 96));
  }
  const full = coverage.map((c, i) => (c >= fullThreshold ? i : -1)).filter((i) => i >= 0);
  if (!full.length) return { coverage, frames: n, fullStart: -1, fullEnd: -1, cutFrame: -1, ok: false };
  const fullStart = full[0], fullEnd = full[full.length - 1];
  return { coverage, frames: n, fullStart, fullEnd, windowFrames: fullEnd - fullStart + 1,
    cutFrame: Math.floor((fullStart + fullEnd) / 2), ok: true };
}

// Carton de texte : image à dominante claire avec très peu d'encre (texte noir sur fond blanc).
export function looksLikeTextCard(canvas) {
  const ctx = smallCtx(64, 36);
  ctx.drawImage(canvas, 0, 0, 64, 36);
  const d = ctx.getImageData(0, 0, 64, 36).data;
  let bright = 0, dark = 0;
  const px = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    if (l > 215) bright++; else if (l < 60) dark++;
  }
  return bright / px > 0.7 && dark / px < 0.12;
}
