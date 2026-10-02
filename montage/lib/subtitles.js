// Sous-titres : TOUT est une fonction pure du numéro d'image (aperçu == rendu).
// Valeurs par défaut = méthode validée (section 2.6 du cahier des charges), toutes réglables.

export const SUB_DEFAULTS = {
  fps: 30,
  width: 1080, height: 1920,
  safeMargin: 90,           // px latéraux
  maxLongWordPx: 900,       // le plus long mot important (x emphase) doit tenir dans cette largeur
  emphasisScale: 1.25,
  colorNormal: '#FFFFFF', colorImportant: '#FFEA00', colorImpact: '#FF2424',
  impactScale: 1.4,
  strokePx: 1, strokeAlpha: 0.7,
  shadowOffset: 3, shadowBlur: 4, shadowAlpha: 0.45,
  popFrames: 6,
  popNormal: [0.6, 1.2, 1.0], popImportant: [0.5, 1.35, 1.0], popImpact: [0.4, 1.6, 1.0],
  zoomEnd: 1.03,
  circleRadius: 5, circlePeriod: 1.6,
  lineHeight: 1.0,
  preset: 'pop',            // 'pop' | 'doux' | 'aucun'
};

const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

// Échelle "pop" : montée rapide avec dépassement sur la 1re moitié, retour sur la 2e.
export function popScale(f, keys, popFrames, preset) {
  if (preset === 'aucun') return 1;
  const half = popFrames / 2;
  let from = keys[0], peak = keys[1], end = keys[2];
  if (preset === 'doux') { from = 0.9; peak = 1.05; end = 1.0; }
  if (f <= 0) return from;
  if (f >= popFrames) return end;
  if (f <= half) return lerp(from, peak, easeOut(f / half));
  return lerp(peak, end, easeInOut((f - half) / half));
}

// Mouvement circulaire du bloc : translation pure, aucune rotation ni changement d'échelle.
export function blockOffset(seconds, phase, dir, radius, period) {
  const a = (2 * Math.PI * seconds) / period + phase;
  return { x: radius * Math.cos(a), y: radius * Math.sin(a) * dir };
}

// Tremblement très court du texte impact (translation uniquement, ±4 px, 0,15 s).
export function impactShake(seconds) {
  if (seconds < 0 || seconds > 0.15) return { x: 0, y: 0 };
  const k = 1 - seconds / 0.15;
  return { x: 4 * k * Math.sin(seconds * 2 * Math.PI * 22), y: 4 * k * Math.cos(seconds * 2 * Math.PI * 17) };
}

// Charge la police ET vérifie qu'elle est réellement utilisée (jamais de substitution silencieuse).
export async function ensureFont(family, url, weight = 800) {
  const face = new FontFace(family, `url(${url})`, { weight: String(weight) });
  await face.load();
  document.fonts.add(face);
  const c = document.createElement('canvas').getContext('2d');
  const probe = 'WMwmQqÉÈ0123';
  c.font = `${weight} 100px "${family}", monospace`;
  const withFont = c.measureText(probe).width;
  c.font = `${weight} 100px monospace`;
  const fallback = c.measureText(probe).width;
  if (Math.abs(withFont - fallback) < 0.5) {
    throw new Error(`La police "${family}" est chargée mais n'est pas utilisée : rendu bloqué.`);
  }
  return { family, weight, probeWidth: withFont };
}

// Taille de base : le plus long mot important, agrandi, doit tenir dans maxLongWordPx.
export function computeBaseSize(ctx, family, weight, words, style) {
  const longest = words.reduce((a, b) => (b.length > a.length ? b : a), words[0] || 'AAAA');
  ctx.font = `${weight} 100px "${family}"`;
  const w100 = ctx.measureText(longest.toUpperCase()).width * style.emphasisScale;
  return Math.max(48, Math.min(150, Math.floor((100 * style.maxLongWordPx) / w100)));
}

// groups : [{ startFrame, endFrame, phase, dir, lines: [[{t, kind}, ...], ...] }]
export function renderSubtitles(ctx, frame, groups, style, font, keep = false) {
  const W = style.width, H = style.height;
  if (!keep) ctx.clearRect(0, 0, W, H);
  const g = groups.find((x) => frame >= x.startFrame && frame < x.endFrame);
  if (!g) return null;
  const f = frame - g.startFrame;
  const seconds = f / style.fps;
  const dur = (g.endFrame - g.startFrame) / style.fps;
  const base = font.baseSize;

  // Mise en page : toutes les lignes mesurées à taille FINALE (taille constante), centrées ensemble.
  const lineBoxes = g.lines.map((line) => {
    let total = 0;
    const items = line.map((w) => {
      const mult = w.kind === 'important' ? style.emphasisScale : w.kind === 'impact' ? style.impactScale : 1;
      const size = base * mult;
      ctx.font = `${font.weight} ${size}px "${font.family}"`;
      const text = w.t.toUpperCase();
      const width = ctx.measureText(text).width;
      return { text, size, width, kind: w.kind };
    });
    const gap = base * 0.28;
    total = items.reduce((a, b) => a + b.width, 0) + gap * (items.length - 1);
    return { items, total, gap, h: Math.max(...items.map((i) => i.size)) * style.lineHeight };
  });
  const blockH = lineBoxes.reduce((a, b) => a + b.h, 0);
  const maxW = Math.max(...lineBoxes.map((l) => l.total));
  const overflow = maxW > W - 2 * style.safeMargin;

  const zoom = lerp(1, style.zoomEnd, dur > 0 ? Math.min(1, seconds / dur) : 0);
  const circ = blockOffset(seconds, g.phase, g.dir, style.circleRadius, style.circlePeriod);
  const hasImpact = g.lines.some((l) => l.some((w) => w.kind === 'impact'));
  const shake = hasImpact ? impactShake(seconds) : { x: 0, y: 0 };

  ctx.save();
  ctx.translate(W / 2 + circ.x + shake.x, H / 2 + circ.y + shake.y); // centre exact de l'écran
  ctx.scale(zoom, zoom);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  let y = -blockH / 2;
  for (const lb of lineBoxes) {
    let x = -lb.total / 2;
    const cy = y + lb.h / 2;
    for (const it of lb.items) {
      const keys = it.kind === 'important' ? style.popImportant : it.kind === 'impact' ? style.popImpact : style.popNormal;
      const s = popScale(f, keys, style.popFrames, style.preset);
      const cx = x + it.width / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(s, s);
      ctx.font = `${font.weight} ${it.size}px "${font.family}"`;
      const color = it.kind === 'important' ? style.colorImportant : it.kind === 'impact' ? style.colorImpact : style.colorNormal;
      ctx.shadowColor = `rgba(0,0,0,${style.shadowAlpha})`;
      ctx.shadowOffsetX = style.shadowOffset; ctx.shadowOffsetY = style.shadowOffset; ctx.shadowBlur = style.shadowBlur;
      ctx.fillStyle = color;
      ctx.fillText(it.text, 0, 0);
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = style.strokePx;
      ctx.strokeStyle = `rgba(0,0,0,${style.strokeAlpha})`;
      ctx.strokeText(it.text, 0, 0);
      ctx.restore();
      x += it.width + lb.gap;
    }
    y += lb.h;
  }
  ctx.restore();
  return { overflow, maxLineWidth: maxW, baseSize: base, popFrame: f };
}
