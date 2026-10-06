// Mixage final (aperçu ET export : même fonction, même résultat). Fonction pure sur des PCM Float32 à 48 kHz.
// Règles de la méthode (§ 2.7) : la voix est la référence. Voix +4,6 dB avec limiteur (-1 dBTP) ; chaque autre son
// est plafonné par rapport à la CRÊTE de la voix (on baisse seulement, jamais d'augmentation) ; musique à -16 dB
// relatif (sonie), en boucle, ducking sous la voix et pendant le climax, « drops » atténués par rampe douce,
// fondu de sortie 1,5 s ; limiteur de sécurité sur le mix (plafond -1 dBTP, vérifié en true peak ×4).
import { measureLoudness, truePeak } from './loudness.js';

export const MIX_DEFAULTS = {
  rate: 48000,
  voiceGainDb: 4.6,
  ceilingDbtp: -1,
  musicRelDb: -16,          // sonie de la musique par rapport à celle de la voix
  duckDb: -6,               // atténuation supplémentaire pendant la voix et le climax
  duckAttack: 0.12, duckRelease: 0.45,
  musicFadeOut: 1.5,
  dropSlice: 0.5, dropThresholdDb: 4, dropRamp: 0.4,
  // Crête maximale de chaque type de son, en dB SOUS la crête de la voix.
  caps: { sfx: 14, transition: 10, opening: 10, subscribe: 14, overlay: 10, trailer: 12 },
};

/** @typedef {'voice'|'music'|'sfx'|'transition'|'opening'|'subscribe'|'overlay'|'trailer'} MixKind */
/**
 * @typedef {{ id: string, kind: MixKind, channels: Float32Array[], at: number, offset?: number, dur: number,
 *   gainDb?: number, fadeIn?: number, fadeOut?: number, loop?: boolean, label?: string }} MixItem
 * at / offset / dur en secondes ; channels au taux du mix (1 ou 2 voies).
 */

const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const lin = (d) => Math.pow(10, d / 20);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

/** Crête (échantillon) de la partie réellement utilisée d'un élément. */
function usedPeak(item, rate) {
  let p = 0;
  const n = Math.round(item.dur * rate);
  for (const ch of item.channels) {
    const len = ch.length;
    if (item.loop || Math.round((item.offset || 0) * rate) + n > len) { for (let i = 0; i < len; i++) { const a = Math.abs(ch[i]); if (a > p) p = a; } continue; }
    const s = Math.round((item.offset || 0) * rate);
    for (let i = s; i < s + n; i++) { const a = Math.abs(ch[i]); if (a > p) p = a; }
  }
  return p;
}

/**
 * Ajoute un élément dans un bus stéréo avec gain, fondus et courbe de gain optionnelle (par échantillon du mix).
 * @param {Float32Array[]} bus @param {MixItem} item @param {number} gain linéaire @param {number} rate
 * @param {Float32Array} [curve] gain multiplicatif par échantillon du MIX
 */
function addInto(bus, item, gain, rate, curve) {
  const start = Math.round(item.at * rate);
  const n = Math.min(Math.round(item.dur * rate), bus[0].length - start);
  const fi = Math.round((item.fadeIn || 0) * rate), fo = Math.round((item.fadeOut || 0) * rate);
  const off = Math.round((item.offset || 0) * rate);
  for (let c = 0; c < 2; c++) {
    const src = item.channels[Math.min(c, item.channels.length - 1)];
    const len = src.length, out = bus[c];
    for (let k = Math.max(0, -start); k < n; k++) {
      let si = off + k;
      if (si >= len) { if (!item.loop || !len) break; si %= len; }
      let g = gain;
      if (k < fi) g *= 0.5 - 0.5 * Math.cos(Math.PI * k / fi);
      else if (k >= n - fo) g *= 0.5 - 0.5 * Math.cos(Math.PI * (n - k) / fo);
      if (curve) g *= curve[start + k];
      out[start + k] += src[si] * g;
    }
  }
}

/**
 * Limiteur à anticipation (hors ligne, déterministe) : gain requis par échantillon, minimum glissant sur la fenêtre
 * d'anticipation, lissage par moyenne glissante (aucune crête ne dépasse), relâchement exponentiel. Le plafond est
 * vérifié en true peak (×4) : si l'interpolation dépasse encore, on recommence avec un plafond abaissé de l'écart.
 * @param {Float32Array[]} ch voies (modifiées en place) @param {number} rate @param {number} ceilingDbtp
 * @returns {{ maxReductionDb: number, ceilingUsedDb: number, truePeakDb: number, passes: number }}
 */
export function limit(ch, rate, ceilingDbtp = -1, { lookahead = 0.0015, release = 0.08 } = {}) {
  const n = ch[0].length;
  const L = Math.max(1, Math.round(lookahead * rate));
  const relCoef = 1 - Math.exp(-1 / (release * rate));
  let ceilDb = ceilingDbtp - 0.3, passes = 0, maxRed = 0, tp = -Infinity;
  const req = new Float32Array(n), mn = new Float32Array(n), g = new Float32Array(n);
  for (; passes < 4; passes++) {
    const ceil = lin(ceilDb);
    let any = false;
    for (let i = 0; i < n; i++) {
      let p = 0;
      for (const c of ch) { const a = Math.abs(c[i]); if (a > p) p = a; }
      req[i] = p > ceil ? ceil / p : 1;
      if (req[i] < 1) any = true;
    }
    if (any) {
      // minimum glissant sur [i, i + L] (file monotone)
      const dq = new Int32Array(n + L + 1); let h = 0, t = 0;
      for (let i = n - 1; i >= 0; i--) {
        while (t > h && req[dq[t - 1]] >= req[i]) t--;
        dq[t++] = i;
        while (dq[h] > i + L) h++;
        mn[i] = req[dq[h]];
      }
      // moyenne glissante sur [i - L, i] : chaque terme couvre la crête → gain ≤ requis à la crête
      let acc = 0;
      for (let i = 0; i < n; i++) {
        acc += mn[i]; if (i - L - 1 >= 0) acc -= mn[i - L - 1];
        const box = acc / Math.min(i + 1, L + 1);
        const prev = i ? g[i - 1] : 1;
        g[i] = Math.min(box, prev + (1 - prev) * relCoef, mn[i]);
      }
      let gmin = 1;
      for (let i = 0; i < n; i++) { const gi = g[i]; if (gi < 1) { for (const c of ch) c[i] *= gi; if (gi < gmin) gmin = gi; } }
      maxRed = Math.max(maxRed, -db(gmin));
    }
    tp = Math.max(...ch.map((c) => truePeak(c, rate).dBTP));
    if (tp <= ceilingDbtp + 1e-3) break;
    ceilDb -= tp - ceilingDbtp + 0.1;
  }
  return { maxReductionDb: r2(maxRed), ceilingUsedDb: r2(ceilDb), truePeakDb: r2(tp), passes: passes + 1 };
}

/** Activité de la voix (pas de 10 ms) : RMS au-dessus de (RMS max − 30 dB) et au-dessus de -50 dBFS. */
export function voiceActivity(bus, rate) {
  const hop = Math.round(rate * 0.01), nf = Math.ceil(bus[0].length / hop);
  const rms = new Float32Array(nf);
  let mx = -Infinity;
  for (let f = 0; f < nf; f++) {
    let s = 0, m = 0;
    for (let i = f * hop; i < Math.min(bus[0].length, (f + 1) * hop); i++) { const v = (bus[0][i] + bus[1][i]) / 2; s += v * v; m++; }
    rms[f] = db(Math.sqrt(s / Math.max(1, m)));
    if (rms[f] > mx) mx = rms[f];
  }
  const act = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) act[f] = rms[f] > Math.max(-50, mx - 30) ? 1 : 0;
  // Comble les micro-silences entre les mots (< 250 ms) : pas de pompage de la musique.
  let last = -1e9;
  for (let f = 0; f < nf; f++) { if (act[f]) { if (f - last > 1 && f - last <= 25) for (let k = last + 1; k < f; k++) act[k] = 1; last = f; } }
  return { act, hop };
}

/**
 * Courbe de gain de la musique : ducking (rampe en dB à vitesse bornée) + atténuation des « drops ».
 * @returns {{ curve: Float32Array, drops: { t: number, db: number }[] }}
 */
function musicCurve(n, rate, activity, duckZones, music, o, L) {
  const curve = new Float32Array(n);
  const { act, hop } = activity;
  // cible en dB par trame de 10 ms
  const nf = Math.ceil(n / hop), target = new Float32Array(nf);
  for (let f = 0; f < nf; f++) {
    const t = f * 0.01;
    const zone = duckZones.some(([a, b]) => t >= a && t < b);
    target[f] = act[f] || zone ? o.duckDb : 0;
  }
  // Drops : sonie par tranches de 0,5 s (moyenne des blocs momentanés), comparée au niveau habituel de la musique.
  const drops = [];
  const dropDb = new Float32Array(nf);
  if (music) {
    const step = Math.round(o.dropSlice / 0.1);
    const slices = [];
    for (let s = 0; s * step < L.momentary.length; s++) {
      const blk = L.momentary.slice(s * step, (s + 1) * step).filter(Number.isFinite);
      slices.push(blk.length ? 10 * Math.log10(blk.reduce((a, v) => a + Math.pow(10, v / 10), 0) / blk.length) : -Infinity);
    }
    // Référence = MÉDIANE des tranches (un drop ne doit pas relever la référence à laquelle on le compare).
    const ok = slices.filter((v) => v > -70).sort((a, b) => a - b);
    const mean = ok.length ? ok[Math.floor(ok.length / 2)] : -Infinity;
    // tranche s de la musique ↔ temps du mix (avec boucle)
    const srcLen = music.channels[0].length / rate;
    for (let f = 0; f < nf; f++) {
      const tMix = f * 0.01;
      if (tMix < music.at || tMix >= music.at + music.dur) continue;
      let ts = (music.offset || 0) + tMix - music.at;
      if (music.loop) ts %= srcLen;
      const s = Math.floor(ts / o.dropSlice);
      const ex = (slices[s] ?? -Infinity) - mean;
      if (ex > o.dropThresholdDb) dropDb[f] = -(ex - o.dropThresholdDb / 2);
    }
    // rapport : un événement par zone contiguë
    for (let f = 0; f < nf; f++) if (dropDb[f] < 0 && (f === 0 || dropDb[f - 1] === 0)) {
      let m = 0, k = f; while (k < nf && dropDb[k] < 0) { m = Math.min(m, dropDb[k]); k++; }
      drops.push({ t: r2(f * 0.01), db: r2(m), dur: r2((k - f) * 0.01) });
    }
  }
  // Rampe : vitesse maximale en dB/trame (attaque vers le bas, relâchement vers le haut, rampe des drops 0,4 s).
  const downStep = Math.abs(o.duckDb) / (o.duckAttack / 0.01), upStep = Math.abs(o.duckDb) / (o.duckRelease / 0.01);
  const dropStep = 12 / (o.dropRamp / 0.01);
  let cur = 0, curDrop = 0;
  const env = new Float32Array(nf + 1);
  // passe arrière pour anticiper l'attaque (le ducking est déjà bas quand le mot commence)
  const want = new Float32Array(nf);
  for (let f = 0; f < nf; f++) want[f] = target[f];
  for (let f = nf - 2; f >= 0; f--) want[f] = Math.min(want[f], want[f + 1] + downStep);
  const wantDrop = new Float32Array(nf);
  for (let f = 0; f < nf; f++) wantDrop[f] = dropDb[f];
  for (let f = nf - 2; f >= 0; f--) wantDrop[f] = Math.min(wantDrop[f], wantDrop[f + 1] + dropStep);
  for (let f = 0; f < nf; f++) {
    cur = want[f] < cur ? Math.max(want[f], cur - downStep) : Math.min(want[f], cur + upStep);
    curDrop = wantDrop[f] < curDrop ? Math.max(wantDrop[f], curDrop - dropStep) : Math.min(wantDrop[f], curDrop + dropStep);
    env[f] = cur + curDrop;
  }
  env[nf] = env[nf - 1];
  // gain linéaire par trame puis interpolation linéaire (évite une exponentielle par échantillon)
  const g = new Float32Array(nf + 1);
  for (let f = 0; f <= nf; f++) g[f] = lin(env[f]);
  for (let f = 0; f < nf; f++) {
    const a = g[f], b = g[f + 1], i0 = f * hop, i1 = Math.min(n, i0 + hop);
    for (let i = i0; i < i1; i++) curve[i] = a + (b - a) * ((i - i0) / hop);
  }
  return { curve, drops };
}

/**
 * Mixe tous les éléments sur `duration` secondes.
 * @param {MixItem[]} items @param {number} duration
 * @param {Partial<typeof MIX_DEFAULTS>} [opt]
 * @returns {{ channels: Float32Array[], report: any }}
 */
export function mixdown(items, duration, opt = {}) {
  const o = { ...MIX_DEFAULTS, ...opt, caps: { ...MIX_DEFAULTS.caps, ...(opt.caps || {}) } };
  const rate = o.rate, n = Math.max(1, Math.round(duration * rate));
  const report = { rate, duration, stems: [], drops: [], warnings: [] };

  // 1. Voix : gain + limiteur propre (sa crête devient la référence).
  const voice = [new Float32Array(n), new Float32Array(n)];
  for (const it of items.filter((x) => x.kind === 'voice')) addInto(voice, it, lin(o.voiceGainDb + (it.gainDb || 0)), rate);
  const vLim = limit(voice, rate, o.ceilingDbtp);
  const vPeak = db(Math.max(...voice.map((c) => { let p = 0; for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > p) p = a; } return p; })));
  const vLoud = measureLoudness(voice, rate).integrated;
  report.voice = { gainDb: o.voiceGainDb, peakDb: r2(vPeak), lufs: r2(vLoud), limiter: vLim };
  const hasVoice = Number.isFinite(vPeak);

  const mix = [voice[0].slice(), voice[1].slice()];
  const activity = voiceActivity(voice, rate);
  const duckZones = items.filter((x) => x.kind === 'trailer').map((x) => [x.at, x.at + x.dur]);

  // 2. Musique.
  for (const it of items.filter((x) => x.kind === 'music')) {
    const used = Math.min(it.dur, duration - it.at);
    const ML = measureLoudness(it.channels, rate);
    const L = ML.integrated;
    const gainDb = (hasVoice && Number.isFinite(L) ? vLoud + o.musicRelDb - L : o.musicRelDb) + (it.gainDb || 0);
    const { curve, drops } = musicCurve(n, rate, activity, duckZones, { ...it, dur: used }, o, ML);
    const fade = { ...it, dur: used, fadeOut: Math.max(it.fadeOut || 0, Math.min(o.musicFadeOut, used)) };
    addInto(mix, fade, lin(gainDb), rate, curve);
    const peak = db(usedPeak(it, rate)) + gainDb;
    report.stems.push({ id: it.id, kind: 'music', label: it.label, gainDb: r2(gainDb), musicLufs: r2(L), peakRelVoiceDb: r2(peak - vPeak), capped: false, loop: !!it.loop });
    for (const d of drops) report.drops.push({ ...d, id: it.id, label: it.label });
  }

  // 3. SFX, sons des overlays, audio du trailer : plafonnés sous la crête de la voix (baisse seulement).
  for (const it of items.filter((x) => x.kind !== 'voice' && x.kind !== 'music')) {
    const raw = db(usedPeak(it, rate));
    let gainDb = it.gainDb || 0, capped = false;
    const cap = o.caps[it.kind] ?? 10;
    if (hasVoice && Number.isFinite(raw) && raw + gainDb > vPeak - cap) { gainDb = vPeak - cap - raw; capped = true; }
    addInto(mix, it, lin(gainDb), rate);
    report.stems.push({ id: it.id, kind: it.kind, label: it.label, gainDb: r2(gainDb), peakRelVoiceDb: r2(raw + gainDb - vPeak), capDb: -cap, capped });
  }

  // 4. Limiteur de sécurité sur le mix.
  report.limiter = limit(mix, rate, o.ceilingDbtp);
  const fin = measureLoudness(mix, rate);
  report.lufs = r2(fin.integrated); report.lra = r2(fin.lra);
  report.truePeakDb = report.limiter.truePeakDb;
  // Résumé par type : crête la plus haute de chaque type, relative à la voix.
  const byKind = {};
  for (const s of report.stems) byKind[s.kind] = Math.max(byKind[s.kind] ?? -Infinity, s.peakRelVoiceDb);
  report.peaksRelVoice = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, r2(v)]));
  if (!hasVoice) report.warnings.push('Aucune voix : les plafonds relatifs à la voix ne sont pas appliqués.');
  if (report.limiter.maxReductionDb > 3) report.warnings.push(`Le limiteur réduit jusqu’à ${report.limiter.maxReductionDb} dB : un son est probablement trop fort.`);
  return { channels: mix, report };
}
