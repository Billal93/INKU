// Sous-titres rendus par le compositeur commun (aperçu = export) : taille constante, centrage, mouvement
// sous-pixel continu, rendu déterministe, image de référence (golden) sur cette machine.
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

test.describe('Sous-titres (moteur de rendu)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/montage/dev/subs-test.html');
    await page.waitForFunction(() => window.subsReady, null, { timeout: 20000 });
  });

  test('taille constante : hauteur des majuscules identique (±1 px) sur tous les groupes au repos', async ({ page }) => {
    const r = await page.evaluate(() => {
      const out = [];
      for (const g of window.subsTest.groups) {
        // Une ligne, sans accent ni signe qui dépasse (É, Ç, J, Q, virgule) : la boîte blanche = hauteur des majuscules.
        if (g.lines !== 1 || !/^[A-IK-PR-Z ]+$/.test(g.text.toUpperCase())) continue;
        const f = Math.min(g.end - 1, g.start + 10);         // pop terminé (6 images), zoom lent ≈ +0,7 %
        const b = window.measureFrame(f).white;
        if (b[4] > 0) out.push({ text: g.text, h: b[3] - b[1], f, start: g.start, end: g.end });
      }
      return out;
    });
    expect(r.length).toBeGreaterThanOrEqual(2);
    // Le zoom lent (100 → 103 %) varie selon la durée du groupe : on compare des hauteurs ramenées au zoom 1.
    const norm = r.map((x) => x.h / (1 + 0.03 * Math.min(1, (x.f - x.start) / (x.end - x.start))));
    const ref = norm[0];
    for (const h of norm) expect(Math.abs(h - ref)).toBeLessThanOrEqual(1.5);
  });

  test('bloc centré (±6 px : mouvement circulaire de rayon 5) et dans la zone utile', async ({ page }) => {
    const boxes = await page.evaluate(() => window.subsTest.groups.map((g) => ({ g: g.text, overflow: g.overflow, b: window.measureFrame(g.start + 12) })));
    expect(boxes.filter((x) => x.overflow)).toEqual([]);
    for (const { b } of boxes) {
      const all = [b.white, b.yellow, b.red].filter((x) => x[4] > 0);
      const x0 = Math.min(...all.map((x) => x[0])), x1 = Math.max(...all.map((x) => x[2]));
      expect(Math.abs((x0 + x1) / 2 - 540)).toBeLessThanOrEqual(8);
      expect(x0).toBeGreaterThanOrEqual(80);
      expect(x1).toBeLessThanOrEqual(1000);
    }
  });

  test('mouvement continu : pas de saut de plus de 2 px d\'une image à la suivante après le pop', async ({ page }) => {
    const centers = await page.evaluate(() => {
      const g = window.subsTest.groups.find((x) => x.lines === 1 && x.end - x.start > 20);
      const out = [];
      for (let f = g.start + 7; f < g.end - 1; f++) { const b = window.measureFrame(f).white; out.push([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]); }
      return out;
    });
    for (let i = 1; i < centers.length; i++) {
      expect(Math.hypot(centers[i][0] - centers[i - 1][0], centers[i][1] - centers[i - 1][1])).toBeLessThanOrEqual(2);
    }
  });

  test('déterminisme et image de référence (golden) sur cette machine', async ({ page }, info) => {
    const h = await page.evaluate(async () => {
      const a = window.renderFrame(40); window.renderFrame(90); const b = window.renderFrame(40);
      const same = a.length === b.length && a.every((v, i) => v === b[i]);
      return { same, data: Array.from(a.filter((_, i) => i % 97 === 0)) };
    });
    expect(h.same).toBe(true);
    const hash = createHash('sha256').update(Buffer.from(h.data)).digest('hex');
    const dir = 'tests/golden';
    const file = `${dir}/subs-frame40-${info.project.name || 'chromium'}.sha256`;
    if (!existsSync(file)) { mkdirSync(dir, { recursive: true }); writeFileSync(file, hash + '\n'); }
    expect(hash).toBe(readFileSync(file, 'utf8').trim());
  });

  test('police absente : signalée (jamais de police de secours silencieuse)', async ({ page }) => {
    const r = await page.evaluate(() => ({ ok: window.subsTest.font.ok, missing: window.subsTest.missingFont }));
    expect(r.ok).toBe(true);
    expect(r.missing.ok).toBe(false);
    expect(r.missing.reason).toMatch(/pas importée/);
  });
});
