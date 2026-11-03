// Profil de la transcription : encodeur seul (1 jeton) vs transcription complète vs complète avec mots.
// Usage : node tools/bench-profile.mjs --models=whisper-turbo --devices=webgpu
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav, encodeWav } from '../montage/audio/wav.js';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const BENCH = 'C:/Users/cybersecurite/Downloads/INKU-bench';
// Un morceau réaliste de ~26 s : trois phrases FLEURS.
const rows = readFileSync(join(BENCH, 'fleurs/dev.tsv'), 'utf8').trim().split('\n').map((l) => l.split('\t'));
const parts = rows.slice(10, 13).map((r) => decodeWav(readFileSync(join(BENCH, 'fleurs/dev', r[1]))).channels[0]);
const total = parts.reduce((a, p) => a + p.length + 6400, 0), audio = new Float32Array(Math.min(total, 16000 * 29));
let o = 0; for (const p of parts) { if (o >= audio.length) break; audio.set(p.subarray(0, audio.length - o), o); o += p.length + 6400; }
const wav = Buffer.from(encodeWav([audio], 16000, 16));

const context = await chromium.launchPersistentContext(join(BENCH, 'inku-bench-profile'), { channel: 'chrome', headless: true });
const page = context.pages()[0] || await context.newPage();
await context.route('**/bench-data/chunk.wav', (r) => r.fulfill({ body: wav, contentType: 'audio/wav' }));
await context.route('**/bench-data/list.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [{ url: '/bench-data/chunk.wav' }] }) }));
page.on('console', (m) => console.log('  │', m.text()));
await page.goto(`http://localhost:8731/montage/bench/profile.html?models=${arg('models', 'whisper-turbo')}&devices=${arg('devices', 'webgpu')}`);
for (;;) { await new Promise((r) => setTimeout(r, 2000)); if (await page.evaluate(() => window.__profile.done)) break; }
console.log(JSON.stringify(await page.evaluate(() => window.__profile), null, 1));
await context.close();
