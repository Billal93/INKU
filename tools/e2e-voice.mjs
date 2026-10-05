// Parcours complet « voix » dans le Studio (Chrome, profil persistant du banc pour réutiliser les modèles) :
// import d'une voix, analyse, application à la timeline, lecture ; captures d'écran et temps mesurés.
// Usage : node tools/e2e-voice.mjs <voix.wav> [--mobile]
import { chromium, devices } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const BENCH = 'C:/Users/cybersecurite/Downloads/INKU-bench';
const file = process.argv[2];
if (!file) { console.error('Usage : node tools/e2e-voice.mjs <voix.wav>'); process.exit(1); }
const mobile = process.argv.includes('--mobile');
const out = join(BENCH, 'e2e');
mkdirSync(out, { recursive: true });

const context = await chromium.launchPersistentContext(join(BENCH, 'inku-bench-profile'), {
  channel: 'chrome', headless: true,
  ...(mobile ? { ...devices['iPhone 14'], defaultBrowserType: undefined } : { viewport: { width: 1440, height: 900 } }),
});
const page = context.pages()[0] || await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:8731/montage/studio.html');
await page.waitForFunction(() => window.__studioReady === true, null, { timeout: 30000 });
// Projet neuf à chaque passage.
await page.evaluate(async () => { const { store } = window.__studio; store.commit('reset', (d) => { d.clips = []; d.voice = undefined; }); });
await page.setInputFiles('#filePicker', file);
await page.waitForFunction(() => window.__studio.lib.list.some((r) => r.status === 'ready'), null, { timeout: 120000 });
if (mobile) await page.click('.dock [data-sheet="sheetVoice"]'); else await page.click('#sheetSources [data-tab="sheetVoice"]');
await page.waitForSelector('[data-analyze]');
const t0 = Date.now();
if (process.argv.includes('--reuse') && await page.locator('[data-do="apply"]').count()) { /* analyse déjà faite */ } else {
  await page.click('[data-analyze]');
  await page.waitForSelector('[data-do="apply"]', { timeout: 30 * 60e3 });
}
const analyzeSec = (Date.now() - t0) / 1000;
await page.screenshot({ path: join(out, `voix-analyse${mobile ? '-mobile' : ''}.png`) });
await page.click('[data-do="apply"]');
await page.waitForFunction(() => window.__studio.store.doc.clips.some((c) => c.track === 'T1'), null, { timeout: 30000 });
const info = await page.evaluate(() => {
  const d = window.__studio.store.doc;
  return { a1: d.clips.filter((c) => c.track === 'A1').length, t1: d.clips.filter((c) => c.track === 'T1').length, subs: d.clips.filter((c) => c.track === 'T1').slice(0, 6).map((c) => c.sub.words.map((w) => w.w).join(' ')) };
});
// Aperçu à l'image d'un sous-titre
const f = await page.evaluate(() => { const c = window.__studio.store.doc.clips.filter((x) => x.track === 'T1')[1]; return c.start + 8; });
await page.evaluate((f) => window.__studio.player.seek(f), f);
await page.waitForTimeout(600);
await page.screenshot({ path: join(out, `voix-timeline${mobile ? '-mobile' : ''}.png`) });
const dump = await page.evaluate(async () => {
  const s = await window.__studio.voice.state();
  return { an: { ...s.an, envelope: undefined }, cut: [...s.st.cut], kept: s.st.kept, keptSec: s.st.keptSec, report: await window.__studio.voice.report() };
});
(await import('node:fs')).writeFileSync(join(out, 'analyse.json'), JSON.stringify(dump, null, 1));
console.log(JSON.stringify({ analyzeSec, ...info, errors, timing: dump.an.timing, recovered: dump.an.recovered, retries: dump.an.retries }, null, 1));
await context.close();
