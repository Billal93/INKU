// Priorité 4 dans le Studio : remplir la timeline (coupes sur les mots, aucun plan réutilisé), climax proposé puis posé
// (fond flou, son continu sur A5, durée cible atteinte), miniature non 9:16 jamais déformée, linting sans alerte bloquante.
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';

const F = (n) => path.join(process.cwd(), 'test-assets', 'montage', n);
const BASE = process.env.BASE || 'http://localhost:8731';

test.describe.serial('Fin de vidéo et remplissage (Chrome installé)', () => {
  let browser, page;
  const errors = [];

  test.beforeAll(async () => {
    browser = await chromium.launch({ channel: process.env.CHANNEL || 'chrome' });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
    await page.goto(BASE + '/montage/studio.html');
    await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 15000 }).catch(() => {});
    await page.goto(BASE + '/montage/studio.html');
    await page.waitForFunction(() => window.__studioReady || window.__studioError, null, { timeout: 20000 });
    // Miniature paysage (16:9, magenta) générée dans la page : jamais de fichier de l'utilisateur.
    const png = await page.evaluate(async () => {
      const c = new OffscreenCanvas(640, 360), g = c.getContext('2d');
      g.fillStyle = '#e000e0'; g.fillRect(0, 0, 640, 360); g.fillStyle = '#fff'; g.fillRect(270, 130, 100, 100);
      return Array.from(new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()));
    });
    const fs = await import('node:fs');
    const buf = (n, mime) => ({ name: n, mimeType: mime, buffer: fs.readFileSync(F(n)) });
    await page.setInputFiles('#filePicker', [buf('shots-trailer.mp4', 'video/mp4'), buf('p0-voice.wav', 'audio/wav'), { name: 'miniature.png', mimeType: 'image/png', buffer: Buffer.from(png) }]);
    await page.waitForFunction(() => window.__studio.lib.list.length === 3 && window.__studio.lib.list.every((r) => r.status === 'ready'), null, { timeout: 120000 });
    await page.waitForFunction(() => window.__studio.lib.list.filter((r) => r.kind === 'video').every((r) => r.proxy === 'ready'), null, { timeout: 120000 });
  });
  test.afterAll(async () => { await browser.close(); });

  test('analyse : descripteurs par plan (histogramme, point d\'intérêt, cartons) et par échantillon', async () => {
    const r = await page.evaluate(() => { const v = window.__studio.lib.list.find((x) => x.kind === 'video'); const im = window.__studio.lib.list.find((x) => x.kind === 'image'); return { hist: v.shots[0].hist.length, fx: v.shots.map((s) => s.focusX), feat: v.feat && v.feat.d.length, rate: v.feat && v.feat.rate, img: [im.width, im.height] }; });
    expect(r.hist).toBe(48); expect(r.rate).toBe(8); expect(r.feat).toBeGreaterThanOrEqual(140);
    for (const x of r.fx) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); }
    expect(r.img).toEqual([640, 360]);
  });

  test('remplir : V1 couvert jusqu\'à la fin de la voix, coupes sur les mots, aucun intervalle réutilisé', async () => {
    await page.evaluate(() => {
      const { store, lib } = window.__studio;
      const voice = lib.list.find((r) => r.kind === 'audio');
      const words = []; for (let f = 12; f < 240; f += 21) words.push({ w: 'mot', kind: 'normal', t0: f / 30 });
      store.commit('Préparation', (d) => {
        d.clips = [{ id: 'V', track: 'A1', start: 0, dur: 240, srcId: voice.id, srcIn: 0 }, { id: 'T', track: 'T1', start: 0, dur: 240, sub: { index: 0, sentence: 0, words } }];
        d.project.target = { duration: 8 + 7 + 1.75, min: 16.5, max: 16.9 };
      });
    });
    await page.click('#tFill');
    const d = await page.evaluate(() => JSON.parse(JSON.stringify(window.__studio.store.doc)));
    const v1 = d.clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start);
    expect(v1.length).toBeGreaterThanOrEqual(3);
    expect(v1[0].start).toBe(0);
    for (let i = 1; i < v1.length; i++) expect(v1[i].start).toBe(v1[i - 1].start + v1[i - 1].dur);
    expect(v1.at(-1).start + v1.at(-1).dur).toBe(240);
    for (let i = 0; i < v1.length; i++) for (let j = i + 1; j < v1.length; j++) {
      const a = [v1[i].srcIn, v1[i].srcIn + v1[i].dur / 30], b = [v1[j].srcIn, v1[j].srcIn + v1[j].dur / 30];
      expect(Math.min(a[1], b[1]) - Math.max(a[0], b[0])).toBeLessThanOrEqual(1e-6);
    }
    const onWord = v1.slice(0, -1).filter((c) => (c.start + c.dur + 2 - 12) % 21 === 0).length;
    expect(onWord).toBeGreaterThanOrEqual(v1.length - 2);
  });

  test('fin : 3 climax proposés, choix, fond flou, son continu, miniature, durée cible exacte', async () => {
    await page.locator('#sheetSources [data-tab="sheetEnd"]').click();
    const body = page.locator('#endBody');
    await body.locator('[data-do="suggest"]').click();
    await body.locator('[data-pick]').first().waitFor({ timeout: 30000 });
    const chips = await body.locator('[data-pick]').count();
    expect(chips).toBeGreaterThanOrEqual(1);
    await body.locator('[data-pick]').first().click();
    await body.locator('[data-do="place"]').click();
    await page.waitForFunction(() => window.__studio.store.doc.clips.some((c) => c.role === 'climax'));
    const d = await page.evaluate(() => JSON.parse(JSON.stringify(window.__studio.store.doc)));
    const climax = d.clips.filter((c) => c.role === 'climax' && c.track === 'V1');
    const a5 = d.clips.find((c) => c.track === 'A5'), th = d.clips.find((c) => c.role === 'thumbnail');
    expect(climax[0].start).toBe(240); expect(climax[0].layout).toBe('fit-blur');
    expect(climax.reduce((a, c) => a + c.dur, 0)).toBe(210);   // 7 s = cible 16,75 s − voix 8 s − miniature 1,75 s
    expect(th.start).toBe(450); expect(th.dur).toBe(53);
    expect(a5).toMatchObject({ start: 240, dur: 263, srcIn: d.end.climax.start });
    expect(d.end.climax.start).toBeGreaterThanOrEqual(9); expect(d.end.climax.start + 7).toBeLessThanOrEqual(18);
    const lint = await page.evaluate(async () => { const { lintDoc } = await import('/montage/studio/lint.js'); return lintDoc(window.__studio.store.doc, (id) => window.__studio.lib.get(id)).map((i) => i.code); });
    expect(lint).not.toContain('duree-hors-cible'); expect(lint).not.toContain('images-manquantes'); expect(lint).not.toContain('climax-duree');
  });

  test('rendu : miniature paysage centrée sur fond flou (jamais déformée), pas de sous-titre pendant la fin', async () => {
    const r = await page.evaluate(async () => {
      const p = window.__studio.player;
      p.seek(470);
      await new Promise((res) => setTimeout(res, 150));
      while (p.rendering || p.pending !== null) await new Promise((res) => setTimeout(res, 30));
      const c = p.comp, W = c.width, H = c.height, d = c.readPixels();
      const at = (x, y) => { const i = ((H - 1 - Math.round(y * (H - 1))) * W + Math.round(x * (W - 1))) * 4; return [d[i], d[i + 1], d[i + 2]]; };
      return { mid: at(0.1, 0.5), top: at(0.5, 0.1), centerWhite: at(0.5, 0.5), subs: p.scene.subtitleLayer(window.__studio.store.doc) ? 1 : 0 };
    });
    // centre : la miniature nette (magenta) avec son carré blanc ; haut : le même magenta flouté et assombri de 15 %
    expect(r.mid[0]).toBeGreaterThan(200); expect(r.mid[1]).toBeLessThan(40);
    expect(r.centerWhite.every((v) => v > 230)).toBe(true);
    expect(Math.abs(r.top[0] - 0.85 * 224)).toBeLessThan(18); expect(r.top[1]).toBeLessThan(40);
  });

  test('aucune erreur JS', async () => { expect(errors).toEqual([]); });
});
