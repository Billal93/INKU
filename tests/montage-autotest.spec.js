// Écran Autotest (celui que l'utilisateur lance sur son iPhone) : toutes les étapes sans transcription réussissent.
import { test, expect } from '@playwright/test';

test('autotest : capacités, rendu, encodage relu, overlay, mixage', async ({ page }) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/montage/autotest.html?auto');
  await page.waitForFunction(() => window.__autotest, null, { timeout: 200000 });
  const r = await page.evaluate(() => window.__autotest);
  console.log('autotest :', JSON.stringify({ render: r.steps.render, encode: r.steps.encode, overlay: r.steps.overlay, mix: r.steps.mix }));
  expect(r.steps.support.ok).toBe(true);
  expect(r.steps.render.deterministic).toBe(true);
  expect(r.steps.encode.videoFrames).toBe(150);
  expect(r.steps.encode.irregularTimestamps).toBe(0);
  expect(r.steps.overlay.ok).toBe(true);
  expect(r.steps.mix.truePeakDb).toBeLessThanOrEqual(-1 + 1e-3);
  expect(errors).toEqual([]);
});
