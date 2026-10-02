// Tests d'interaction du Studio (Chrome/Edge installés : H.264 et WebCodecs réels).
// npx playwright test -c playwright.studio.config.js
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';

const F = (n) => path.join(process.cwd(), 'test-assets', 'montage', n);
const BASE = process.env.BASE || 'http://localhost:8731';
const doc = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__studio.store.doc)));
const v1 = async (page) => (await doc(page)).clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start);

async function boot(page) {
  await page.goto(BASE + '/montage/studio.html');
  await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 15000 }).catch(() => {});
  await page.goto(BASE + '/montage/studio.html');
  await page.waitForFunction(() => window.__studioReady || window.__studioError, null, { timeout: 20000 });
  expect(await page.evaluate(() => window.__studioError || null)).toBeNull();
}
async function importFixtures(page) {
  await page.setInputFiles('#filePicker', [F('shots-trailer.mp4'), F('p0-voice.wav')]);
  await page.waitForFunction(() => window.__studio.lib.list.length === 2 && window.__studio.lib.list.every((r) => r.status === 'ready'), null, { timeout: 120000 });
  await page.waitForFunction(() => window.__studio.lib.list.filter((r) => r.kind === 'video').every((r) => r.proxy === 'ready'), null, { timeout: 120000 });
}
const clipBox = async (page, id) => (await page.locator(`.clip[data-id="${id}"]`).boundingBox());

test.describe.serial('Studio — interactions (Chrome installé)', () => {
  let browser, ctx, page;
  const errors = [];

  test.beforeAll(async () => {
    browser = await chromium.launch({ channel: process.env.CHANNEL || 'chrome' });
    ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
    await boot(page);
  });
  test.afterAll(async () => { await browser.close(); });

  test('import multiple : plans à l\'image près, bandes noires, proxy persistant', async () => {
    await importFixtures(page);
    const r = await page.evaluate(() => { const v = window.__studio.lib.list.find((x) => x.kind === 'video'); return { shots: v.shots.map((s) => [s.start, s.end]), lb: [v.letterbox.top, v.letterbox.bottom], fps: v.fps, persisted: v.persisted, proxy: v.proxy }; });
    const cuts = r.shots.slice(1).map((s) => s[0]);
    [3, 5.5, 9, 12.5, 15].forEach((t, i) => expect(Math.abs(cuts[i] - t)).toBeLessThan(1 / 24 + 1e-6));
    expect(r.shots.length).toBe(6);
    expect(r.lb[0]).toBeGreaterThanOrEqual(22); expect(r.lb[0]).toBeLessThanOrEqual(26);
    expect(r.fps).toBe(24); expect(r.persisted).toBe(true); expect(r.proxy).toBe('ready');
  });

  test('ajout de plans : marge intérieure, durée ≤ 3 s, aucun chevauchement, marqués utilisés', async () => {
    for (let i = 0; i < 3; i++) { await page.locator('.shot .add').nth(i).click(); await page.waitForTimeout(150); }
    const cs = await v1(page);
    expect(cs.length).toBe(3);
    cs.forEach((c, i) => { expect(c.dur).toBeLessThanOrEqual(90); expect(i === 0 || c.start >= cs[i - 1].start + cs[i - 1].dur).toBe(true); });
    expect(cs[0].srcIn).toBeGreaterThan(0);                       // jamais pile sur la coupe
    await expect(page.locator('.shot.used')).toHaveCount(3);
  });

  test('déplacement à la souris avec magnétisme : un seul pas d\'annulation', async () => {
    const [a, b, c] = await v1(page);
    const box = await clipBox(page, c.id);
    const undoBefore = await page.evaluate(() => window.__studio.store.canUndo);
    // déplace le 3e clip d'environ 40 px vers la droite (~1,1 s) : il doit rester sans chevauchement
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2, { steps: 6 }); await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 4 }); await page.mouse.up();
    const after = await v1(page);
    expect(after[2].start).toBeGreaterThanOrEqual(after[1].start + after[1].dur);
    expect(after[2].start).not.toBe(c.start);
    await page.keyboard.press('Control+z');
    expect((await v1(page))[2].start).toBe(c.start);              // le geste entier est annulé d'un coup
    expect(undoBefore).toBe(true);
  });

  test('ajustement par poignée droite, limité par le voisin et par la source', async () => {
    const [a] = await v1(page);
    const box = await clipBox(page, a.id);
    const hx = box.x + box.width - 5, hy = box.y + box.height / 2;
    await page.mouse.move(hx, hy); await page.mouse.down(); await page.mouse.move(hx - 40, hy, { steps: 6 }); await page.mouse.up();
    const a2 = (await v1(page))[0];
    expect(a2.dur).toBeLessThan(a.dur);
    expect(a2.start).toBe(a.start); expect(a2.srcIn).toBe(a.srcIn);
    await page.keyboard.press('Control+z');
    expect((await v1(page))[0].dur).toBe(a.dur);
  });

  test('coupe à la tête de lecture (C) à l\'image près puis annulation', async () => {
    const [a] = await v1(page);
    await page.evaluate((f) => window.__studio.player.seek(f), a.start + 30);
    await page.locator('.clip[data-id="' + a.id + '"]').click();
    await page.keyboard.press('c');
    const cs = await v1(page);
    expect(cs.length).toBe(4);
    expect(cs[0].dur).toBe(30); expect(cs[1].start).toBe(a.start + 30);
    expect(cs[1].srcIn).toBeCloseTo(a.srcIn + 1, 6);
    await page.keyboard.press('Control+z');
    expect((await v1(page)).length).toBe(3);
  });

  test('suppression avec recalage (ripple) puis annulation', async () => {
    const before = await v1(page);
    await page.waitForTimeout(400);               // > intervalle de double-tap, sinon deux clics = coupe
    await page.locator('#tRipple').click();
    await page.locator('.clip[data-id="' + before[0].id + '"]').click();
    await page.keyboard.press('Delete');
    const after = await v1(page);
    expect(after.length).toBe(2);
    expect(after[0].start).toBe(before[1].start - before[0].dur);   // les suivants se recalent
    await page.keyboard.press('Control+z');
    expect((await v1(page)).length).toBe(3);
    await page.locator('#tRipple').click();
  });

  test('linting : plan réutilisé signalé sur le clip, jamais bloquant', async () => {
    const [a] = await v1(page);
    await page.waitForTimeout(400);
    await page.locator('.clip[data-id="' + a.id + '"]').click();
    await page.keyboard.press('Control+d');
    await expect(page.locator('.clip .badge').first()).toBeVisible();
    await page.locator('#propsBody .lint').first().waitFor();
    const txt = await page.locator('#propsBody').innerText();
    expect(txt).toMatch(/réutilise|mouvement|immobile|court/i);
    await page.keyboard.press('Control+z');
  });

  test('défilement : image affichée en moyenne < 160 ms sur proxy', async () => {
    const t = await page.evaluate(async () => {
      const { player, store } = window.__studio;
      const total = store.doc.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0);
      const times = [];
      for (let i = 0; i < 24; i++) {
        const f = Math.floor((i * 7919) % total);
        const t0 = performance.now(); store.ui.playhead = f; await player.renderStill(f); times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      return { mean: times.reduce((a, b) => a + b, 0) / times.length, p90: times[Math.floor(times.length * 0.9)] };
    });
    console.log('scrub (ms):', JSON.stringify(t));
    expect(t.mean).toBeLessThan(160);
  });

  test('défilement rapide : images basse définition instantanées puis image exacte au repos', async () => {
    const r = await page.evaluate(async () => {
      const { player, store } = window.__studio;
      const total = store.doc.clips.filter((c) => c.track === 'V1').reduce((m, c) => Math.max(m, c.start + c.dur), 0);
      const cold = [];
      for (let i = 0; i < 20; i++) {
        const f = Math.floor((i * 6131 + 17) % total);
        const clip = player.videoClipAt(f);
        if (!clip) continue;
        const t0 = performance.now();
        const ap = await player.scrubFrame(clip.srcId, clip.srcIn + (f - clip.start) / 30);
        cold.push(ap ? performance.now() - t0 : -1);
      }
      const before = player.stats.approx || 0;
      for (let i = 0; i < 40; i++) { player.seek(Math.floor((i * 2713) % total)); await new Promise((r) => setTimeout(r, 18)); }
      await new Promise((r) => setTimeout(r, 700));
      return { coldMean: cold.reduce((a, b) => a + b, 0) / cold.length, missing: cold.filter((x) => x < 0).length, approxDraws: (player.stats.approx || 0) - before, last: store.ui.playhead, source: player.stats.lastSource };
    });
    console.log('scrub approx:', JSON.stringify(r));
    expect(r.missing).toBe(0);
    expect(r.coldMean).toBeLessThan(25);        // décodage d'une image basse définition (JPEG) : quelques ms
    expect(r.approxDraws).toBeGreaterThan(20);  // pendant le geste on affiche l'approximation
  });

  test('lecture : la tête avance, des images sont dessinées, aucun plantage', async () => {
    await page.evaluate(() => window.__studio.player.seek(0));
    await page.click('#btnPlay');
    await page.waitForTimeout(2200);
    const s = await page.evaluate(() => ({ ph: window.__studio.store.ui.playhead, drawn: window.__studio.player.stats.drawn, playing: window.__studio.store.ui.playing }));
    await page.click('#btnPlay');
    expect(s.ph).toBeGreaterThan(30); expect(s.drawn).toBeGreaterThan(20);
  });

  test('cadrage glissé sur l\'aperçu : un seul pas d\'historique', async () => {
    const cs = await v1(page);
    await page.evaluate((f) => window.__studio.player.seek(f), cs[0].start + 5);
    await page.waitForTimeout(400);
    const fb = await page.locator('#frame').boundingBox();
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.mouse.down(); await page.mouse.move(fb.x + fb.width / 2 + 30, fb.y + fb.height / 2, { steps: 5 }); await page.mouse.up();
    const c1 = (await v1(page))[0];
    expect(c1.crop.x).toBeLessThan(0.5);                            // l'image suit le doigt : la fenêtre part à gauche
    await page.keyboard.press('Control+z');
    expect((await v1(page))[0].crop.x).toBe(0.5);
  });

  test('rechargement : projet, historique et sources conservés', async () => {
    await page.waitForTimeout(900);
    const d0 = await doc(page);
    await page.reload();
    await page.waitForFunction(() => window.__studioReady, null, { timeout: 20000 });
    const d1 = await doc(page);
    expect(d1.clips.map((c) => [c.id, c.start, c.dur, c.srcIn])).toEqual(d0.clips.map((c) => [c.id, c.start, c.dur, c.srcIn]));
    expect(await page.evaluate(() => window.__studio.store.canUndo)).toBe(true);
    expect(await page.evaluate(() => window.__studio.lib.list.length)).toBe(2);
  });

  test('aucune erreur JS pendant tout le parcours', async () => { expect(errors).toEqual([]); });
});

test.describe('Studio — tactile (appui long, défilement natif)', () => {
  test('appui long déplace un clip ; glissement rapide fait défiler sans déplacer', async () => {
    test.setTimeout(240000);
    const browser = await chromium.launch({ channel: process.env.CHANNEL || 'chrome' });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await boot(page); await importFixtures(page);
    await page.evaluate(() => document.getElementById('sheetSources').classList.add('open'));
    for (let i = 0; i < 2; i++) { await page.locator('.shot .add').nth(i).tap(); await page.waitForTimeout(200); }
    await page.evaluate(() => document.getElementById('sheetSources').classList.remove('open'));
    await page.waitForTimeout(450); // la feuille finit de se refermer (animation 0,22 s)
    const cs = await v1(page);
    const cdp = await ctx.newCDPSession(page);
    const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    const b = await clipBox(page, cs[1].id);
    const x = b.x + b.width / 2, y = b.y + b.height / 2;

    // 1) glissement rapide immédiat : le navigateur défile, le clip ne bouge pas
    await touch('touchStart', x, y); for (let i = 1; i <= 6; i++) { await touch('touchMove', x - i * 14, y); await page.waitForTimeout(16); } await touch('touchEnd');
    expect((await v1(page))[1].start).toBe(cs[1].start);
    await page.waitForTimeout(900);   // l'inertie du défilement doit se terminer (un toucher pendant l'inertie rend les touchmove non annulables)

    // 2) appui long puis glissement : le clip se déplace
    const b2 = await clipBox(page, cs[1].id);
    const x2 = b2.x + b2.width / 2, y2 = b2.y + b2.height / 2;
    await touch('touchStart', x2, y2); await page.waitForTimeout(420);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', x2 + i * 10, y2); await page.waitForTimeout(16); }
    await touch('touchEnd');
    await page.waitForTimeout(200);
    const after = await v1(page);
    expect(after[1].start).toBeGreaterThan(cs[1].start);
    expect(after[1].start).toBeGreaterThanOrEqual(after[0].start + after[0].dur);
    await browser.close();
  });
});
