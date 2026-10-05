// Évaluation du nettoyage de voix sur le corpus à défauts injectés (tools/bench/build-corpus.mjs), dans Chrome.
// Mesures : WER avant/après nettoyage (contre le script propre), défauts injectés trouvés (rappel), parole propre
// coupée par erreur, coupes au milieu d'un mot de la vérité terrain, temps de calcul par minute d'audio.
// Usage : node tools/bench-voice.mjs [--model=whisper-turbo-h] [--device=auto] [--only=voix-01]
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { wer } from '../montage/speech/text.js';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const BENCH = arg('bench', 'C:/Users/cybersecurite/Downloads/INKU-bench');
const CORPUS = join(BENCH, 'corpus/v1');
const PORT = 8731, BASE = `http://localhost:${PORT}`;
const only = arg('only', '');
const names = readdirSync(CORPUS).filter((f) => /^voix-\d+\.json$/.test(f)).map((f) => f.replace('.json', '')).filter((n) => !only || only.split(',').includes(n)).sort();
const truth = Object.fromEntries(names.map((n) => [n, JSON.parse(readFileSync(join(CORPUS, n + '.json'), 'utf8'))]));

async function serverUp() { try { return (await fetch(BASE + '/montage/bench/voice-eval.html')).ok; } catch { return false; } }
if (!(await serverUp())) {
  spawn('python', ['-m', 'http.server', String(PORT)], { cwd: new URL('..', import.meta.url).pathname.slice(1), stdio: 'ignore', detached: true }).unref();
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
}

const context = await chromium.launchPersistentContext(join(BENCH, 'inku-bench-profile'), { channel: 'chrome', headless: true });
const page = context.pages()[0] || await context.newPage();
await context.route('**/bench-data/**', (r) => {
  const p = decodeURIComponent(new URL(r.request().url()).pathname.replace('/bench-data/', ''));
  r.fulfill({ body: readFileSync(join(CORPUS, p)), contentType: 'audio/wav' });
});
await context.route('**/bench-data/voice-list.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: names.map((n) => ({ name: n, url: `/bench-data/${n}.wav` })) }) }));
page.on('console', (m) => { const t = m.text(); if (/^voix-|ERREUR/.test(t)) console.log('  │', t); });
await page.goto(`${BASE}/montage/bench/voice-eval.html?model=${arg('model', 'whisper-turbo')}&device=${arg('device', 'auto')}`);
for (const t0 = Date.now(); ;) {
  await new Promise((r) => setTimeout(r, 2000));
  if (await page.evaluate(() => window.__eval.done)) break;
  if (Date.now() - t0 > 4 * 3600e3) throw new Error('évaluation trop longue');
}
const ev = await page.evaluate(() => window.__eval);
await context.close();
if (ev.error) { console.error('ERREUR', ev.error); process.exit(1); }

/** Intervalles [t0, t1] : union triée. */
const union = (iv) => { const s = [...iv].sort((a, b) => a[0] - b[0]); const o = []; for (const x of s) { if (o.length && x[0] <= o[o.length - 1][1]) o[o.length - 1][1] = Math.max(o[o.length - 1][1], x[1]); else o.push([...x]); } return o; };
const overlap = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
const covered = (x, set) => set.reduce((s, y) => s + overlap(x, y), 0);

const rows = [];
for (const r of ev.results) {
  const T = truth[r.name];
  const cut = new Set(r.proposal.cutWords);
  const keptWords = r.words.filter((_, i) => !cut.has(i));
  const before = wer([{ ref: T.script, hyp: r.words.map((w) => w.w).join(' ') }]);
  const after = wer([{ ref: T.script, hyp: keptWords.map((w) => w.w).join(' ') }]);
  const keptIv = union(r.proposal.kept.map((k) => [k.t0, k.t1]));
  // Défaut trouvé : au moins 50 % de sa durée hors des passages gardés.
  const found = T.defects.filter((d) => (d.t1 - d.t0) - covered([d.t0, d.t1], keptIv) >= 0.5 * (d.t1 - d.t0));
  // Parole propre (mots de la vérité terrain dans les phrases gardées, hors défauts) coupée par erreur.
  const cleanWords = T.words.map((w) => [w.t0, w.t1, w.w]);
  const lostWords = cleanWords.filter((w) => covered([w[0], w[1]], keptIv) < 0.5 * (w[1] - w[0]));
  const splitWords = cleanWords.filter((w) => keptIv.some((k) => (k[0] > w[0] + 0.03 && k[0] < w[1] - 0.03) || (k[1] > w[0] + 0.03 && k[1] < w[1] - 0.03)));
  rows.push({
    name: r.name, dur: T.dur, werBefore: +(before.wer * 100).toFixed(1), werAfter: +(after.wer * 100).toFixed(1),
    defects: T.defects.length, found: found.length, missed: T.defects.filter((d) => !found.includes(d)).map((d) => d.type),
    cleanWords: cleanWords.length, lostWords: lostWords.map((w) => w[2]), splitWords: splitWords.map((w) => w[2]),
    secPerMin: +((r.wallMs / 1000) / (T.dur / 60)).toFixed(1), retries: r.retries.length,
  });
}
const tot = (k) => rows.reduce((a, r) => a + r[k], 0);
const summary = {
  date: new Date().toISOString(), model: arg('model', 'whisper-turbo'), device: arg('device', 'auto'), voices: rows.length,
  werBefore: +(rows.reduce((a, r) => a + r.werBefore, 0) / rows.length).toFixed(1),
  werAfter: +(rows.reduce((a, r) => a + r.werAfter, 0) / rows.length).toFixed(1),
  defectRecall: +(100 * tot('found') / Math.max(1, tot('defects'))).toFixed(1),
  cleanWordsLost: rows.reduce((a, r) => a + r.lostWords.length, 0), cleanWords: tot('cleanWords'),
  wordsSplitByCut: rows.reduce((a, r) => a + r.splitWords.length, 0),
  secPerMinAudio: +(rows.reduce((a, r) => a + r.secPerMin, 0) / rows.length).toFixed(1),
};
const dir = join(BENCH, 'results');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const file = join(dir, `voice-${summary.date.slice(0, 16).replace(/[:T]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ summary, rows, raw: ev.results }, null, 1));
console.log('\nvoix     durée  WER avant  WER après  défauts trouvés  mots propres perdus  mots coupés  s/min');
for (const r of rows) console.log(r.name.padEnd(8), String(r.dur.toFixed(0)).padStart(5), String(r.werBefore).padStart(9), String(r.werAfter).padStart(10), `${r.found}/${r.defects}`.padStart(16), String(r.lostWords.length).padStart(20), String(r.splitWords.length).padStart(12), String(r.secPerMin).padStart(6), r.missed.length ? ' manqués: ' + r.missed.join(',') : '');
console.log('\nRÉSUMÉ', JSON.stringify(summary));
console.log('rapport :', file);
