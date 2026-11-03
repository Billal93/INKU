// Habillage (priorité 3) dans le Studio, avec des éléments de marque SYNTHÉTIQUES générés dans la page (vérité
// connue) : analyse des overlays, transition calée à l'image près (couverture totale opaque), ouverture, abonne-toi
// sur le mot, logo borné, copyright, SFX espacés, musique, niveaux relatifs à la voix ; retrait de fond sans halo et
// fond flou sur le GPU.
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';

const F = (n) => path.join(process.cwd(), 'test-assets', 'montage', n);
const BASE = process.env.BASE || 'http://localhost:8731';

test.describe.serial('Habillage (Chrome installé)', () => {
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
    await page.setInputFiles('#filePicker', [F('shots-trailer.mp4'), F('p0-voice.wav')]);
    await page.waitForFunction(() => window.__studio.lib.list.length === 2 && window.__studio.lib.list.every((r) => r.status === 'ready'), null, { timeout: 120000 });
  });
  test.afterAll(async () => { await browser.close(); });

  test('pack synthétique : analyse (couverture, image de coupe, retrait de fond, première image visible)', async () => {
    const r = await page.evaluate(async () => {
      const { synthOverlay, synthLogo, synthSounds } = await import('/montage/autotest/synth.js');
      const { importBrandFiles } = await import('/montage/brand/brand.js');
      const files = [await synthOverlay('transition'), await synthOverlay('opening'), await synthOverlay('subscribe'), await synthLogo(), ...synthSounds()];
      await importBrandFiles(files);
      const A = window.__studio.assets;
      await A.load();
      const t0 = performance.now();
      for (const a of A.manifest.assets) await A.analyzed(a.id);
      return { ms: performance.now() - t0, list: A.manifest.assets.map((a) => ({ name: a.name, kind: a.kind, role: a.role, key: a.keying && a.keying.method, fps: a.fps, frames: a.frames, an: a.analysis && { fs: a.analysis.fullStart, fe: a.analysis.fullEnd, cut: a.analysis.cutFrame, vis: a.analysis.firstVisible, b60: a.analysis.below60 }, hasAudio: a.hasAudio, dur: a.duration })) };
    });
    console.log('analyse du pack :', Math.round(r.ms), 'ms');
    const by = (re) => r.list.find((a) => re.test(a.name));
    const tr = by(/^transition/), op = by(/^ouverture/), ab = by(/^abonne/), logo = by(/^logo/);
    expect(tr.kind).toBe('transition'); expect(op.kind).toBe('opening'); expect(ab.kind).toBe('subscribe'); expect(logo.kind).toBe('logo');
    expect(tr.fps).toBe(30); expect(tr.frames).toBe(30);
    expect(tr.key).toBe('luma');
    expect(tr.an).toMatchObject({ fs: 10, fe: 16, cut: 13 });
    expect(op.an.fs).toBe(0); expect(op.an.fe).toBe(5); expect(op.an.b60).toBeGreaterThan(5);
    expect(ab.an.vis).toBe(4);
    expect(logo.key).toBe('alpha');
    expect(by(/^click/).role).toBe('click'); expect(by(/^pop/).role).toBe('pop'); expect(by(/^musique/).kind).toBe('music');
  });

  test('pose : ouverture, transition proposée (coupe au milieu de la couverture), abonne-toi sur le mot, logo, SFX, musique, copyright', async () => {
    await page.evaluate(() => {
      const { store, lib } = window.__studio;
      const vid = lib.list.find((r) => r.kind === 'video'), voice = lib.list.find((r) => r.kind === 'audio');
      const id = (p) => p + Math.random().toString(36).slice(2, 9);
      const crop = { mode: 'fixed', x: 0.5, travel: null };
      const sub = (start, dur, sentence, words) => ({ id: id('t'), track: 'T1', start, dur, sub: { index: start, sentence, words } });
      store.commit('Préparation du test', (d) => {
        d.clips = [
          { id: 'A', track: 'V1', start: 0, dur: 75, srcId: vid.id, srcIn: 0.2, crop },
          { id: 'B', track: 'V1', start: 75, dur: 75, srcId: vid.id, srcIn: 5.7, crop },
          { id: 'C', track: 'V1', start: 150, dur: 75, srcId: vid.id, srcIn: 9.2, crop },
          { id: 'D', track: 'V1', start: 225, dur: 75, srcId: vid.id, srcIn: 12.7, crop },
          { id: 'V', track: 'A1', start: 0, dur: 300, srcId: voice.id, srcIn: 0 },
          sub(3, 27, 0, [{ w: 'UN', kind: 'normal', t0: 0.1 }, { w: 'NOUVEAU', kind: 'important', t0: 0.4 }]),
          sub(78, 12, 1, [{ w: 'DEUX', kind: 'important', t0: 2.6 }]),
          sub(90, 30, 1, [{ w: 'GARÇONS', kind: 'important', t0: 3.0 }]),
          sub(135, 15, 2, [{ w: 'AVANT', kind: 'normal', t0: 4.5 }, { w: 'DE', kind: 'normal', t0: 4.8 }]),
          sub(150, 45, 2, [{ w: 'ABONNE-TOI', kind: 'normal', t0: 5.0 }]),
          sub(210, 60, 3, [{ w: 'LE', kind: 'normal', t0: 7.0 }, { w: '12 MAI', kind: 'impact', t0: 7.2 }]),
        ];
      });
    });
    await page.locator('#sheetSources [data-tab="sheetDress"]').click();
    const body = page.locator('#dressBody');
    await body.locator('[data-do="opening"]').click();
    await page.waitForFunction(() => window.__studio.store.doc.clips.some((c) => c.role === 'opening'));
    await body.locator('[data-sugg]').first().click();
    await page.waitForFunction(() => window.__studio.store.doc.clips.some((c) => c.role === 'transition'));
    await body.locator('[data-do="subscribe"]').click();
    await page.waitForFunction(() => window.__studio.store.doc.clips.some((c) => c.role === 'subscribe'));
    await body.locator('[data-do="logo"]').click();
    await page.waitForFunction(() => window.__studio.store.doc.clips.some((c) => c.role === 'logo'));
    await body.locator('[data-do="sfx"]').click();
    await page.waitForFunction(() => window.__studio.store.doc.clips.some((c) => c.track === 'A3'));
    await body.locator('[data-do="music"]').click();
    await page.waitForFunction(() => window.__studio.store.doc.clips.some((c) => c.track === 'A2'));
    await body.locator('#crText').fill('© STUDIO TEST, CO-PRODUCTEUR');
    await body.locator('#crText').dispatchEvent('change');
    const d = await page.evaluate(() => JSON.parse(JSON.stringify(window.__studio.store.doc)));
    const role = (r) => d.clips.find((c) => c.role === r);
    expect(role('opening')).toMatchObject({ start: 0, srcFrame: 0, dur: 30 });
    expect(role('transition')).toMatchObject({ cut: 75, start: 62, cover: [10, 16] });
    expect(role('subscribe')).toMatchObject({ start: 146, wordFrame: 150 });
    expect(role('logo')).toMatchObject({ start: 0, dur: 300 });
    const sfx = d.clips.filter((c) => c.track === 'A3').sort((a, b) => a.start - b.start);
    for (let i = 1; i < sfx.length; i++) expect(sfx[i].start - sfx[i - 1].start).toBeGreaterThanOrEqual(12);
    expect(sfx.at(-1).sfx).toBe('pop');
    expect(d.clips.find((c) => c.track === 'A2')).toMatchObject({ loop: true, dur: 300 });
    expect(d.copyright.text).toBe('© STUDIO TEST, CO-PRODUCTEUR');
    // Contrôles de la transition : aucun problème (plans différents, ≥ 1 s visibles, pas sur l'ouverture).
    expect(await body.locator('.placed .err').count()).toBe(0);
  });

  test('rendu : couverture totale opaque à la coupe, abonne-toi visible sur le mot, logo et copyright affichés', async () => {
    const px = async (frame) => page.evaluate(async (f) => {
      const p = window.__studio.player;
      p.seek(f);
      await new Promise((r) => setTimeout(r, 120));
      while (p.rendering || p.pending !== null) await new Promise((r) => setTimeout(r, 30));
      const c = p.comp, W = c.width, H = c.height, d = c.readPixels();
      const at = (x, y) => { const i = ((H - 1 - Math.round(y * (H - 1))) * W + Math.round(x * (W - 1))) * 4; return [d[i], d[i + 1], d[i + 2]]; };
      const grid = []; for (let y = 0.05; y < 1; y += 0.1) for (let x = 0.05; x < 1; x += 0.1) grid.push(at(x, y));
      let red = 0; for (let y = 0.6; y < 0.8; y += 0.01) for (let x = 0.3; x < 0.7; x += 0.02) { const q = at(x, y); if (q[0] > 180 && q[1] < 60) red++; }
      let logoWhite = 0; for (let y = 0.07; y < 0.13; y += 0.004) for (let x = 0.75; x < 0.95; x += 0.004) { const q = at(x, y); if (q[0] > 200 && q[1] > 200 && q[2] > 200) logoWhite++; }
      let crWhite = 0; for (let y = 0.975; y < 0.995; y += 0.002) for (let x = 0.3; x < 0.7; x += 0.004) { const q = at(x, y); if (q[0] > 150 && q[1] > 150) crWhite++; }
      return { grid, red, logoWhite, crWhite };
    }, frame);
    const cut = await px(75);
    const orange = cut.grid.filter((q) => Math.abs(q[0] - 255) < 20 && Math.abs(q[1] - 140) < 25 && q[2] < 30).length;
    // Couverture totale : tout l'écran est l'overlay (sauf logo et copyright posés au-dessus) → aucun clip visible.
    expect(orange).toBeGreaterThanOrEqual(96);
    const abo = await px(152);
    expect(abo.red).toBeGreaterThan(20);
    const mid = await px(200);
    expect(mid.logoWhite).toBeGreaterThan(5);
    expect(mid.crWhite).toBeGreaterThan(5);
  });

  test('niveaux : SFX ≤ −14 dB, transition/ouverture ≤ −10 dB, abonne-toi ≤ −14 dB sous la crête de la voix, true peak ≤ −1 dBTP, drop signalé', async () => {
    await page.locator('#dressBody [data-do="mix"]').click();
    await page.waitForSelector('#dressBody .mixtab', { timeout: 60000 });
    const r = await page.evaluate(() => { const m = window.__studio.player.mixBuffer; return { ...m.report, ms: m.ms }; });
    console.log('mixage :', r.ms, 'ms', JSON.stringify(r.peaksRelVoice), 'LUFS', r.lufs, 'TP', r.truePeakDb);
    if (r.peaksRelVoice.sfx !== undefined) expect(r.peaksRelVoice.sfx).toBeLessThanOrEqual(-14 + 0.01);
    if (r.peaksRelVoice.transition !== undefined) expect(r.peaksRelVoice.transition).toBeLessThanOrEqual(-10 + 0.01);
    if (r.peaksRelVoice.opening !== undefined) expect(r.peaksRelVoice.opening).toBeLessThanOrEqual(-10 + 0.01);
    if (r.peaksRelVoice.subscribe !== undefined) expect(r.peaksRelVoice.subscribe).toBeLessThanOrEqual(-14 + 0.01);
    expect(r.truePeakDb).toBeLessThanOrEqual(-1 + 0.01);
    expect(r.drops.length).toBeGreaterThanOrEqual(1);
  });

  test('GPU : retrait de fond noir et vert sans halo, fond flou net au centre', async () => {
    const r = await page.evaluate(async () => {
      const { Compositor } = await import('/montage/render/compositor.js');
      const W = 270, H = 480;
      const comp = new Compositor(new OffscreenCanvas(W, H), W, H);
      const solid = (rgb) => { const c = new OffscreenCanvas(W, H), g = c.getContext('2d'); g.fillStyle = `rgb(${rgb})`; g.fillRect(0, 0, W, H); return c; };
      const disc = (bg) => { const c = new OffscreenCanvas(W, H), g = c.getContext('2d'); g.fillStyle = bg; g.fillRect(0, 0, W, H); g.fillStyle = '#fff'; g.beginPath(); g.arc(W / 2, H / 2, 80.5, 0, 7); g.fill(); return c; };
      const read = () => comp.readPixels();
      // fond noir → gris moyen 128 : aucun pixel plus sombre que le fond
      comp.begin(); comp.drawClip(solid('128,128,128'), null); comp.drawKeyedOverlay(disc('#000'), { method: 'luma' });
      let d = read(), darkest = 255;
      for (let i = 0; i < d.length; i += 4) darkest = Math.min(darkest, d[i]);
      // fond vert → gris : aucun liseré vert
      comp.begin(); comp.drawClip(solid('128,128,128'), null); comp.drawKeyedOverlay(disc('rgb(0,200,30)'), { method: 'chroma', color: [0, 200 / 255, 30 / 255] });
      d = read(); let greenFringe = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] > Math.max(d[i], d[i + 2]) + 4) greenFringe++;
      // fond flou : image paysage en damier
      const checker = (sq) => { const land = new OffscreenCanvas(320, 180), g = land.getContext('2d'); for (let y = 0; y < 180; y += sq) for (let x = 0; x < 320; x += sq) { g.fillStyle = ((x + y) / sq) % 2 ? '#fff' : '#000'; g.fillRect(x, y, sq, sq); } return land; };
      const std = (y0, y1) => { const v = []; for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) v.push(d[((H - 1 - y) * W + x) * 4]); const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); };
      // détails fins (cases de 2 px) : effacés par le flou du fond ; avant-plan (cases de 10 px) net
      comp.begin(); comp.drawFitBlur(checker(2), null); d = read(); const stdTop = std(10, 120), meanTop = d[((H - 1 - 60) * W + 135) * 4];
      comp.begin(); comp.drawFitBlur(checker(10), null); d = read(); const stdMid = std(H / 2 - 40, H / 2 + 40);
      const res = { darkest, greenFringe, stdTop, stdMid, meanTop };
      comp.destroy();
      return res;
    });
    console.log('GPU :', JSON.stringify(r));
    expect(r.darkest).toBeGreaterThanOrEqual(126);
    expect(r.greenFringe).toBe(0);
    expect(r.stdTop).toBeLessThan(6);        // fond très flou
    expect(Math.abs(r.meanTop - 127 * 0.85)).toBeLessThan(15);   // assombri d'environ 15 %
    expect(r.stdMid).toBeGreaterThan(60);    // avant-plan net
  });

  test('aucune erreur JS', async () => { expect(errors).toEqual([]); });
});
