// Corpus d'évaluation du nettoyage de voix (HORS dépôt) : voix off d'environ 1 minute construites à partir de
// phrases FLEURS fr (CC-BY-4.0), avec des défauts INJECTÉS à des positions connues :
// faux départs, reprises complètes, mots répétés, syllabes bégayées, « euh » (voyelle tenue de la même voix),
// respirations, blancs. La vérité terrain permet de mesurer : WER avant/après nettoyage, défauts trouvés,
// parole propre coupée par erreur, coupes au milieu d'un mot.
// Usage : node tools/bench/build-corpus.mjs [--n=8] [--seed=1]   (nécessite fleurs/align.json : tools/bench/ref_align.py)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav, encodeWav } from '../../montage/audio/wav.js';
import { pitchYin, energy } from '../../montage/audio/features.js';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const BENCH = arg('bench', 'C:/Users/cybersecurite/Downloads/INKU-bench');
const N = Number(arg('n', '8')), FS = 16000;
let seed = Number(arg('seed', '1'));
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + (b - a) * rnd();

const align = JSON.parse(readFileSync(join(BENCH, 'fleurs/align.json'), 'utf8'));
const ids = Object.keys(align).filter((id) => align[id].words.length >= 6 && align[id].dur < 14);
const audioCache = new Map();
const audioOf = (id) => {
  if (!audioCache.has(id)) audioCache.set(id, decodeWav(readFileSync(join(BENCH, 'fleurs/dev', id + '.wav'))).channels[0]);
  return audioCache.get(id);
};

function noise(sec, db) {
  const n = Math.round(sec * FS), out = new Float32Array(n), a = Math.pow(10, db / 20) * Math.sqrt(3);
  let b = 0;
  for (let i = 0; i < n; i++) { b = 0.97 * b + 0.03 * (rnd() * 2 - 1); out[i] = a * (b * 4); }
  return out;
}
function fade(x, ms = 8) {
  const k = Math.min(x.length >> 1, Math.round(ms / 1000 * FS));
  for (let i = 0; i < k; i++) { const g = i / k; x[i] *= g; x[x.length - 1 - i] *= g; }
  return x;
}
const seg = (x, t0, t1) => fade(x.slice(Math.max(0, Math.round(t0 * FS)), Math.min(x.length, Math.round(t1 * FS))));

/** « euh » : voyelle la plus stable de la phrase, répétée par périodes entières (même voix, même hauteur). */
function makeEuh(x, sec) {
  const { f0, clarity } = pitchYin(x, FS);
  let best = -1, bestScore = 0;
  for (let i = 5; i + 5 < f0.length; i++) {
    if (!f0[i] || clarity[i] < 0.85) continue;
    let ok = 0; for (let k = -4; k <= 4; k++) if (f0[i + k] && Math.abs(f0[i + k] - f0[i]) / f0[i] < 0.03) ok++;
    if (ok > bestScore) { bestScore = ok; best = i; }
  }
  if (best < 0) return null;
  const period = Math.round(FS / f0[best]);
  const c = Math.round((best + 1) * 0.01 * FS);
  const cyc = x.slice(c - period, c + period);   // deux périodes
  const n = Math.round(sec * FS), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = cyc[i % cyc.length];
  // enveloppe douce + léger glissement de niveau, comme un « euh » réel
  const att = Math.round(0.04 * FS);
  for (let i = 0; i < n; i++) out[i] *= Math.min(1, i / att, (n - 1 - i) / att) * (0.8 + 0.2 * Math.sin(Math.PI * i / n));
  return out;
}

mkdirSync(join(BENCH, 'corpus/v1'), { recursive: true });
const manifest = [];
for (let v = 0; v < N; v++) {
  const gender = v % 2 ? 'FEMALE' : 'MALE';
  const pool = ids.filter((id) => align[id].gender === gender);
  const sentences = [];
  // Textes tous différents (FLEURS contient la même phrase lue par plusieurs personnes : ce serait une vraie reprise).
  while (sentences.length < 5) { const id = pick(pool); if (!sentences.some((s) => align[s].text === align[id].text)) sentences.push(id); }
  const parts = [], defects = [], spans = [], truthWords = [];
  let t = 0;
  const push = (x, meta) => { parts.push(x); const r = { t0: t, t1: t + x.length / FS }; t = r.t1; if (meta) defects.push({ ...meta, ...r }); return r; };
  push(noise(between(0.3, 0.8), -62));
  for (const [si, id] of sentences.entries()) {
    const x = audioOf(id), A = align[id], W = A.words;
    const roll = rnd();
    if (roll < 0.25) {        // faux départ : 2 à 4 premiers mots, puis reprise complète
      const k = 1 + Math.floor(rnd() * 3);
      push(seg(x, Math.max(0, W[0].start - 0.05), W[k].end + 0.04), { type: 'faux départ', expect: 'cut', sentence: si });
      push(noise(between(0.35, 0.7), -60));
    } else if (roll < 0.5) {  // prise complète ratée (bégaiement dedans), puis la bonne
      const j = 2 + Math.floor(rnd() * (W.length - 3));
      const a = seg(x, Math.max(0, W[0].start - 0.05), W[j].start), stut = seg(x, W[j].start, W[j].start + between(0.07, 0.13));
      const b = seg(x, W[j].start, Math.min(x.length / FS, W[W.length - 1].end + 0.08));
      const take = new Float32Array(a.length + stut.length + 960 + b.length);
      take.set(a, 0); take.set(stut, a.length); take.set(b, a.length + stut.length + 960);
      push(take, { type: 'prise ratée', expect: 'cut', sentence: si });
      push(noise(between(0.6, 1.1), -60));
    }
    // La phrase gardée, avec éventuellement un défaut à l'intérieur.
    const inner = rnd();
    const cutAt = 2 + Math.floor(rnd() * (W.length - 3));
    const head = seg(x, Math.max(0, W[0].start - 0.06), W[cutAt].start);
    const tail = seg(x, W[cutAt].start, Math.min(x.length / FS, W[W.length - 1].end + 0.1));
    const s0 = t;
    const headStart = Math.max(0, W[0].start - 0.06);
    for (const w of W.slice(0, cutAt)) truthWords.push({ w: w.w, t0: s0 + w.start - headStart, t1: s0 + w.end - headStart, sentence: si });
    push(head);
    if (inner < 0.3) {          // mot répété « le le »
      push(seg(x, W[cutAt].start, W[cutAt].end + 0.02), { type: 'répétition', expect: 'cut', sentence: si, word: W[cutAt].w });
      push(noise(between(0.05, 0.12), -62));
    } else if (inner < 0.55) {  // syllabe bégayée « p- p- pour »
      const reps = 1 + Math.floor(rnd() * 2);
      for (let r = 0; r < reps; r++) {
        push(seg(x, W[cutAt].start, W[cutAt].start + between(0.07, 0.14)), { type: 'bégaiement', expect: 'cut', sentence: si, word: W[cutAt].w });
        push(noise(between(0.05, 0.1), -62));
      }
    } else if (inner < 0.75) {  // « euh »
      const euh = makeEuh(x, between(0.35, 0.6));
      if (euh) { push(noise(0.08, -62)); push(euh, { type: 'hésitation', expect: 'cut', sentence: si }); push(noise(0.1, -62)); }
    }
    const tailT = t;
    for (const w of W.slice(cutAt)) truthWords.push({ w: w.w, t0: tailT + w.start - W[cutAt].start, t1: tailT + w.end - W[cutAt].start, sentence: si });
    push(tail);
    spans.push({ sentence: si, id, t0: s0, t1: t, text: A.text });
    // Respiration (bruit filtré) dans un blanc, parfois.
    const gap = noise(between(0.5, 1.3), -62);
    if (rnd() < 0.4) { const br = noise(between(0.25, 0.45), -36); const off = Math.round(gap.length * 0.3); fade(br, 60); gap.set(br.subarray(0, Math.min(br.length, gap.length - off)), off); }
    push(gap);
  }
  const total = parts.reduce((a, p) => a + p.length, 0), out = new Float32Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  const name = `voix-${String(v + 1).padStart(2, '0')}`;
  writeFileSync(join(BENCH, 'corpus/v1', name + '.wav'), Buffer.from(encodeWav([out], FS, 16)));
  const truth = { name, dur: total / FS, gender, script: spans.map((s) => s.text).join(' '), sentences: spans, words: truthWords, defects, sources: sentences };
  writeFileSync(join(BENCH, 'corpus/v1', name + '.json'), JSON.stringify(truth, null, 1));
  manifest.push({ name, dur: +truth.dur.toFixed(1), defects: defects.length });
  // contrôle : niveau moyen de la voix (aucune saturation)
  const e = energy(out, FS);
  console.log(name, truth.dur.toFixed(1), 's,', defects.length, 'défauts :', defects.map((d) => d.type).join(', '), '| max', Math.max(...e.db).toFixed(1), 'dBFS');
}
writeFileSync(join(BENCH, 'corpus/v1/manifest.json'), JSON.stringify({ created: new Date().toISOString(), license: 'Phrases FLEURS fr (Google, CC-BY-4.0), défauts injectés', items: manifest }, null, 1));
