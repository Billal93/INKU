// Parcours de bout en bout du Studio (Chrome) : import, analyse, ajout de plans, lecture, édition, persistance.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const base = process.env.BASE || 'http://localhost:8731';
const mobile = process.argv.includes('--mobile');
const shots = process.argv.includes('--shots');
const out = (m) => console.log(m);
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 860 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); out('[pageerror] ' + e.message); });
p.on('console', (m) => { if (m.type() === 'error') { errs.push(m.text()); out('[console.error] ' + m.text()); } });
await p.goto(base + '/montage/studio.html');
await p.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 15000 }).catch(() => out('(pas isolé)'));
await p.goto(base + '/montage/studio.html');
await p.waitForFunction(() => window.__studioReady || window.__studioError, null, { timeout: 20000 });
out('prêt: ' + await p.evaluate(() => !!window.__studioReady) + ' erreur: ' + await p.evaluate(() => window.__studioError || 'aucune'));
await p.setInputFiles('#filePicker', ['test-assets/montage/shots-trailer.mp4', 'test-assets/montage/p0-voice.wav']);
await p.waitForFunction(() => window.__studio.lib.list.length === 2 && window.__studio.lib.list.every((r) => r.status === 'ready'), null, { timeout: 120000 });
out('analyse OK');
await p.waitForFunction(() => window.__studio.lib.list.filter((r) => r.kind === 'video').every((r) => r.proxy === 'ready'), null, { timeout: 120000 });
out('proxy OK');
if (shots) await p.screenshot({ path: `docs/maquettes/studio-${mobile ? 'mobile' : 'desktop'}-1-import.png` });
// Ajoute 4 plans via le bouton + (desktop : panneau visible ; mobile : feuille ouverte)
if (mobile) await p.evaluate(() => document.getElementById('sheetSources').classList.add('open'));
for (let i = 0; i < 4; i++) {
  await p.locator('.shot .add').nth(i).click();
  await p.waitForTimeout(250);
}
out('clips V1: ' + await p.evaluate(() => window.__studio.store.doc.clips.filter((c) => c.track === 'V1').map((c) => `${c.start}+${c.dur}@${c.srcIn.toFixed(2)}`).join(' | ')));
// voix sur A1
await p.locator('[data-act="audio"][data-track="A1"]').click();
await p.waitForTimeout(500);
if (mobile) await p.evaluate(() => document.getElementById('sheetSources').classList.remove('open'));
await p.evaluate(() => window.__studio.player.seek(30));
await p.waitForTimeout(800);
if (shots) await p.screenshot({ path: `docs/maquettes/studio-${mobile ? 'mobile' : 'desktop'}-2-timeline.png` });
const hud = await p.textContent('#hud');
out('HUD: ' + hud);
// lecture 1,5 s
await p.evaluate(() => window.__studio.player.seek(0));
await p.waitForTimeout(400);
await p.click('#btnPlay');
await p.waitForTimeout(1800);
const ph = await p.evaluate(() => ({ playhead: window.__studio.store.ui.playhead, playing: window.__studio.store.ui.playing, dropped: window.__studio.player.stats.dropped, drawn: window.__studio.player.stats.drawn }));
out('lecture: ' + JSON.stringify(ph));
await p.click('#btnPlay');
// persistance : recharge
await p.waitForTimeout(900);
const before = await p.evaluate(() => JSON.stringify(window.__studio.store.doc.clips.map((c) => [c.id, c.start, c.dur])));
await p.reload();
await p.waitForFunction(() => window.__studioReady || window.__studioError, null, { timeout: 20000 });
const after = await p.evaluate(() => JSON.stringify(window.__studio.store.doc.clips.map((c) => [c.id, c.start, c.dur])));
out('persistance exacte: ' + (before === after) + ' (' + JSON.parse(after).length + ' clips)');
out('annuler possible après rechargement: ' + await p.evaluate(() => window.__studio.store.canUndo));
out('ERREURS: ' + errs.length);
await b.close();
