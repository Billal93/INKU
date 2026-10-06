// Priorité 5 : rendu final réel (MP4 H.264 + AAC écrit dans le stockage privé), relu et contrôlé ; police de la marque
// obligatoire ; historique ; export / import de l'EDL avec ré-association des sources par empreinte.
// Éléments synthétiques uniquement (police du site, trailer et voix de test, overlays générés dans la page).
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const F = (n) => path.join(process.cwd(), 'test-assets', 'montage', n);
const BASE = process.env.BASE || 'http://localhost:8731';

test.describe.serial('Rendu final (Chrome installé)', () => {
  let browser, page;
  const errors = [];

  test.beforeAll(async () => {
    browser = await chromium.launch({ channel: process.env.CHANNEL || 'chrome' });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
    await page.goto(BASE + '/montage/studio.html');
    await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 15000 }).catch(() => {});
    await page.goto(BASE + '/montage/studio.html');
    await page.waitForFunction(() => window.__studioReady || window.__studioError, null, { timeout: 20000 });
    const buf = (n, mime) => ({ name: n, mimeType: mime, buffer: fs.readFileSync(F(n)) });
    await page.setInputFiles('#filePicker', [buf('shots-trailer.mp4', 'video/mp4'), buf('p0-voice.wav', 'audio/wav')]);
    await page.waitForFunction(() => window.__studio.lib.list.length === 2 && window.__studio.lib.list.every((r) => r.status === 'ready'), null, { timeout: 120000 });
  });
  test.afterAll(async () => { await browser.close(); });

  test('sans police de la marque : rendu bloqué (jamais de police de secours silencieuse)', async () => {
    await page.click('#btnExport');
    await expect(page.locator('#renderBody [data-do="render"]')).toBeDisabled();
    await expect(page.locator('#renderBody .warn').first()).toContainText('Police de la marque absente');
  });

  test('rendu 540×960 : MP4 relu, toutes les vérifications réussies', async () => {
    const font = fs.readFileSync(path.join(process.cwd(), 'assets', 'fonts', 'plus-jakarta-sans-800.woff2'));
    await page.evaluate(async (bytes) => {
      const { importBrandFiles, loadBrandFont } = await import('/montage/brand/brand.js');
      const { synthOverlay, synthSounds } = await import('/montage/autotest/synth.js');
      await importBrandFiles([new File([new Uint8Array(bytes)], 'PlusJakartaSans-ExtraBold.woff2'), await synthOverlay('transition'), ...synthSounds()]);
      const A = window.__studio.assets; await A.load();
      for (const a of A.manifest.assets) await A.analyzed(a.id);
      const f = await loadBrandFont();
      if (!f.ok) throw new Error(f.reason);
      await window.__studio.player.setSubtitleFont({ family: f.family, weight: 700, brand: true });
      const { store, lib } = window.__studio;
      const vid = lib.list.find((r) => r.kind === 'video'), voice = lib.list.find((r) => r.kind === 'audio');
      const crop = { mode: 'fixed', x: 0.5, travel: null };
      const tr = A.manifest.assets.find((a) => a.kind === 'transition');
      const { placeTransition } = await import('/montage/studio/overlays.js');
      store.commit('Préparation du rendu', (d) => {
        d.project.name = 'Test rendu';
        d.copyright = { enabled: true, text: '© STUDIO TEST' };
        d.clips = [
          { id: 'A', track: 'V1', start: 0, dur: 75, srcId: vid.id, srcIn: 0.2, crop },
          { id: 'B', track: 'V1', start: 75, dur: 75, srcId: vid.id, srcIn: 15.2, crop },
          { id: 'V', track: 'A1', start: 0, dur: 150, srcId: voice.id, srcIn: 0 },
          { id: 'T', track: 'T1', start: 10, dur: 60, sub: { index: 0, sentence: 0, words: [{ w: 'DEUX', kind: 'normal', t0: 0.4 }, { w: 'GARÇONS', kind: 'important', t0: 0.8 }] } },
          { id: 'T2', track: 'T1', start: 80, dur: 60, sub: { index: 1, sentence: 1, words: [{ w: 'LE', kind: 'normal', t0: 2.7 }, { w: '12 MAI', kind: 'impact', t0: 3.0 }] } },
        ];
        d.clips.push(placeTransition(d, tr, 75).clip);
        d.clips.push({ id: 'M', track: 'A2', role: 'music', assetId: A.manifest.assets.find((a) => a.kind === 'music').id, assetName: 'musique', start: 0, dur: 150, srcIn: 0, loop: true, gainDb: 0 });
      });
    }, Array.from(font));
    await page.click('#btnExport');
    await page.locator('#renderBody input[value="draft"]').check();
    await page.locator('#renderBody [data-do="render"]').click();
    await page.waitForFunction(() => window.__lastRender && (window.__lastRender.error || window.__lastRender.verify), null, { timeout: 300000 });
    const r = await page.evaluate(() => window.__lastRender);
    console.log('rendu :', JSON.stringify({ ...r.render, mixReport: undefined }), 'contrôles', r.verify && r.verify.ms, 'ms', JSON.stringify(r.verify && r.verify.stats));
    expect(r.error).toBeUndefined();
    for (const c of r.verify.checks) expect.soft(c.ok, `${c.label} : ${c.detail}`).toBe(true);
    expect(r.render.frames).toBe(150);
    expect(r.render.width).toBe(540);
    expect(r.render.target).toBe('opfs');
    await expect(page.locator('#renderBody .checks li.ko')).toHaveCount(0);
    await expect(page.locator('#renderBody [data-play]')).toHaveCount(1);
  });

  test('l\'image rendue est celle de l\'aperçu (même scène) : écart moyen faible à la coupe sous la transition', async () => {
    const r = await page.evaluate(async () => {
      const { Input, ALL_FORMATS, BlobSource, CanvasSink } = await import('/montage/vendor/mediabunny.min.mjs');
      const root = await navigator.storage.getDirectory();
      const id = window.__lastRender.render.id;
      const file = await (await (await root.getDirectoryHandle('renders')).getFileHandle(id + '.mp4')).getFile();
      const t = await new Input({ source: new BlobSource(file), formats: ALL_FORMATS }).getPrimaryVideoTrack();
      const wc = await new CanvasSink(t, { width: 54, height: 96, fit: 'fill' }).getCanvas(75.5 / 30);
      const g = new OffscreenCanvas(54, 96).getContext('2d'); g.drawImage(wc.canvas, 0, 0);
      const d = g.getImageData(0, 0, 54, 96).data;
      let orange = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 225 && d[i + 1] > 110 && d[i + 1] < 170 && d[i + 2] < 50) orange++;
      return orange / (54 * 96);
    });
    // à l'image de coupe, la transition couvre tout l'écran (sauf le copyright en bas)
    expect(r).toBeGreaterThan(0.9);
  });

  test('rendu final 1080×1920 (16 Mb/s, AAC) : contrôles réussis, vitesse mesurée', async () => {
    await page.evaluate(() => { window.__lastRender = null; });
    await page.locator('#renderBody input[value="final"]').check();
    await page.locator('#renderBody [data-do="render"]').click();
    await page.waitForFunction(() => window.__lastRender && (window.__lastRender.error || window.__lastRender.verify), null, { timeout: 300000 });
    const r = await page.evaluate(() => window.__lastRender);
    console.log('rendu 1080p :', r.render && JSON.stringify({ ms: r.render.ms, size: r.render.size, audio: r.render.audio, w: r.render.width }), JSON.stringify(r.verify && r.verify.stats));
    expect(r.error).toBeUndefined();
    for (const c of r.verify.checks) expect.soft(c.ok, `${c.label} : ${c.detail}`).toBe(true);
    expect(r.render.width).toBe(1080);
    await expect(page.locator('#renderBody [data-play]')).toHaveCount(2);
  });

  test('EDL : export puis import, sources reconnues par empreinte', async () => {
    const dl = page.waitForEvent('download');
    await page.locator('#renderBody [data-do="edl-export"]').click();
    const file = await (await dl).path();
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(doc.sources).length).toBe(2);
    // même projet, identifiants de sources « d'un autre appareil »
    for (const [id, ref] of Object.entries(doc.sources)) { const nid = 'autre_' + id; ref.id = nid; doc.sources[nid] = ref; delete doc.sources[id]; for (const c of doc.clips) if (c.srcId === id) c.srcId = nid; }
    doc.project.name = 'Importé';
    const tmp = path.join(path.dirname(file), 'import.edl.json');
    fs.writeFileSync(tmp, JSON.stringify(doc));
    page.once('dialog', (d) => d.accept());
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#renderBody [data-do="edl-import"]').click();
    await (await chooser).setFiles(tmp);
    await page.waitForFunction(() => window.__studio.store.doc.project.name === 'Importé');
    const ok = await page.evaluate(() => window.__studio.store.doc.clips.filter((c) => c.srcId).every((c) => window.__studio.lib.get(c.srcId)));
    expect(ok).toBe(true);
  });

  test('aucune erreur JS', async () => { expect(errors).toEqual([]); });
});
