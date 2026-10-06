// Banc d'essai de transcription (PC) : précision (WER), vitesse (facteur temps réel), mémoire (pic des processus
// du navigateur), par modèle et par appareil (WebGPU / WASM). Le corpus reste HORS dépôt.
// Usage : node tools/bench-asr.mjs --models=whisper-small,whisper-turbo --devices=webgpu --n=60 [--words] [--headed]
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { wer } from '../montage/speech/text.js';
import { decodeWav, encodeWav } from '../montage/audio/wav.js';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const BENCH = arg('bench', 'C:/Users/cybersecurite/Downloads/INKU-bench');
const PORT = 8731, BASE = `http://localhost:${PORT}`;
const N = Number(arg('n', '60'));

// Corpus : N extraits FLEURS fr (dev), choisis de façon déterministe et répartis sur tout le fichier.
const rows = readFileSync(join(BENCH, 'fleurs/dev.tsv'), 'utf8').trim().split('\n').map((l) => l.split('\t'));
const step = rows.length / N;
const pick = Array.from({ length: N }, (_, i) => rows[Math.floor(i * step)]);
let list = { items: pick.map((r) => ({ id: r[1].replace('.wav', ''), url: `/bench-data/fleurs/dev/${r[1]}`, ref: r[2], gender: r[6] })) };
// --concat=k : k phrases consécutives réunies (0,4 s de silence entre elles) = morceaux de ~25-30 s, comme une
// vraie voix découpée par la VAD (Whisper traite toujours une fenêtre de 30 s : les extraits courts le pénalisent).
const CONCAT = Number(arg('concat', '1'));
const memFiles = new Map();
if (CONCAT > 1) {
  const items = [];
  for (let i = 0; i + CONCAT <= list.items.length; i += CONCAT) {
    const group = list.items.slice(i, i + CONCAT);
    const parts = group.map((it) => decodeWav(readFileSync(join(BENCH, it.url.replace('/bench-data/', '')))).channels[0]);
    const gap = new Float32Array(6400);
    const total = parts.reduce((a, x) => a + x.length, 0) + gap.length * (parts.length - 1);
    if (total > 16000 * 29.5) continue;
    const out = new Float32Array(total);
    let o = 0;
    parts.forEach((x, k) => { if (k) o += gap.length; out.set(x, o); o += x.length; });
    const id = group.map((it) => it.id).join('+');
    memFiles.set('concat/' + id + '.wav', Buffer.from(encodeWav([out], 16000, 16)));
    items.push({ id, url: `/bench-data/concat/${id}.wav`, ref: group.map((it) => it.ref).join(' '), gender: group[0].gender });
  }
  list = { items };
}

async function serverUp() { try { return (await fetch(BASE + '/montage/bench/asr.html')).ok; } catch { return false; } }
if (!(await serverUp())) {
  spawn('python', ['-m', 'http.server', String(PORT)], { cwd: new URL('..', import.meta.url).pathname.slice(1), stdio: 'ignore', detached: true }).unref();
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
}

// Mémoire : somme des octets privés des processus du navigateur de test, échantillonnée chaque seconde.
const mem = { samples: /** @type {{ gpu: number, renderer: number }[]} */ ([]) };
const ps = spawn('powershell', ['-NoProfile', '-Command',
  `while ($true) { $g = 0; $r = 0; Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*inku-bench-profile*' } | ForEach-Object { $m = (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).PrivateMemorySize64; if ($_.CommandLine -like '*--type=gpu-process*') { $g += $m } elseif ($_.CommandLine -like '*--type=renderer*') { $r += $m } }; Write-Output "$g $r"; Start-Sleep -Milliseconds 1000 }`]);
ps.stdout.on('data', (d) => { for (const l of String(d).split('\n')) { const m = l.trim().match(/^(\d+) (\d+)$/); if (m) mem.samples.push({ gpu: Number(m[1]) / 1048576, renderer: Number(m[2]) / 1048576 }); } });

// Profil persistant dédié : quota de stockage réel (un contexte « incognito » est limité) et modèles conservés.
const context = await chromium.launchPersistentContext(join(BENCH, 'inku-bench-profile'), { channel: 'chrome', headless: !process.argv.includes('--headed') });
const page = context.pages()[0] || await context.newPage();
await context.route('**/bench-data/**', (r) => {
  const p = decodeURIComponent(new URL(r.request().url()).pathname.replace('/bench-data/', ''));
  r.fulfill({ body: memFiles.get(p) || readFileSync(join(BENCH, p)), contentType: 'audio/wav' });
});
// (Playwright : la route enregistrée en dernier est prioritaire.)
await context.route('**/bench-data/list.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(list) }));
page.on('console', (m) => { const t = m.text(); if (!/^\[/.test(t)) console.log('  │', t); });
await page.goto(`${BASE}/montage/bench/asr.html?models=${arg('models', 'whisper-small')}&devices=${arg('devices', 'webgpu')}${process.argv.includes('--words') ? '&words' : ''}`);

// Suivi du pic mémoire par exécution (modèle/appareil).
const peaks = new Map();
let lastKey = null, base = null;
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 1500));
  const st = await page.evaluate(() => { const b = window.__bench; const r = b.runs[b.runs.length - 1]; return { done: b.done, error: b.error, key: r ? r.model + '/' + r.device : null }; });
  const cur = mem.samples.length ? mem.samples[mem.samples.length - 1] : null;
  if (base === null && cur) base = cur;
  if (st.key && cur) {
    if (st.key !== lastKey) lastKey = st.key;
    const pk = peaks.get(st.key) || { gpu: 0, renderer: 0 };
    peaks.set(st.key, { gpu: Math.max(pk.gpu, cur.gpu), renderer: Math.max(pk.renderer, cur.renderer) });
  }
  if (st.done) break;
  if (Date.now() - t0 > 3 * 3600e3) throw new Error('banc trop long');
}
const bench = await page.evaluate(() => window.__bench);
await context.close();
ps.kill();

const report = { date: new Date().toISOString(), machine: 'PC i5-1245U, Iris Xe, 16 Go, Chrome', n: N, audioSec: 0, baseMem: base, runs: /** @type {any[]} */ ([]) };
for (const r of bench.runs) {
  if (r.error && !r.items) { report.runs.push(r); continue; }
  const pairs = r.items.map((it) => ({ ref: list.items.find((x) => x.id === it.id).ref, hyp: it.hyp }));
  const w = wer(pairs);
  const ws = wer(pairs, { spelled: true });
  report.audioSec = r.audioSec;
  report.runs.push({
    model: r.model, device: r.device, error: r.error, wer: +(w.wer * 100).toFixed(2), werSpelled: +(ws.wer * 100).toFixed(2), sub: w.sub, del: w.del, ins: w.ins, words: w.words,
    rtf: +(r.totalMs / 1000 / r.audioSec).toFixed(4), secPerMinAudio: +((r.totalMs / 1000) / (r.audioSec / 60)).toFixed(2),
    loadSec: +(r.loadMs / 1000).toFixed(1), downloadSec: +(r.dlMs / 1000).toFixed(1),
    peakMem: peaks.get(r.model + '/' + r.device) || null,
    items: r.items,
  });
}
const dir = join(BENCH, 'results');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const file = join(dir, `asr-${report.date.slice(0, 16).replace(/[:T]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(report, null, 1));
console.log(`\n${list.items.length} extraits, ${report.audioSec.toFixed(0)} s d'audio ; mémoire au départ : GPU ${Math.round(base ? base.gpu : 0)} Mo, page ${Math.round(base ? base.renderer : 0)} Mo`);
console.log('modèle               appareil  WER %  WER* %  s/min audio  charge s  pic GPU Mo  pic page Mo   (* nombres en lettres)');
for (const r of report.runs) {
  if (r.error && r.wer === undefined) { console.log(r.model.padEnd(20), 'ERREUR', r.error); continue; }
  console.log(r.model.padEnd(20), String(r.device).padEnd(9), String(r.wer).padStart(5), String(r.werSpelled).padStart(7), String(r.secPerMinAudio).padStart(12), String(r.loadSec).padStart(9), String(Math.round(r.peakMem ? r.peakMem.gpu : 0)).padStart(11), String(Math.round(r.peakMem ? r.peakMem.renderer : 0)).padStart(12), r.error ? ' ERREUR ' + r.error : '');
}
console.log('rapport :', file);
