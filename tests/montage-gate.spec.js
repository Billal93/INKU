// Mot de passe du Montage : rien ne démarre avant le bon mot de passe, retenu ensuite ; site principal sans barrière.
import { test, expect } from '@playwright/test';

const ready = (page) => page.evaluate(() => !!window.__studioReady);

test('studio : bloqué sans le mot de passe, ouvert et retenu avec le bon', async ({ page }) => {
  await page.goto('/montage/studio.html?gate');
  await expect(page.locator('#gate input')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500);    // rechargement éventuel du service worker
  await expect(page.locator('#gate input')).toBeVisible();
  expect(await ready(page)).toBe(false);
  await expect(page.locator('#studio')).toBeHidden();

  await page.fill('#gate input', 'mauvais');
  await page.click('#gate button');
  await expect(page.locator('#gate .err')).toHaveText('Mot de passe incorrect.');
  expect(await ready(page)).toBe(false);

  await page.fill('#gate input', 'billaltest');
  await page.click('#gate button');
  await page.waitForFunction(() => window.__studioReady, null, { timeout: 30000 });
  await expect(page.locator('#gate')).toHaveCount(0);
  await expect(page.locator('#studio')).toBeVisible();

  await page.goto('/montage/studio.html?gate');
  await page.waitForFunction(() => window.__studioReady, null, { timeout: 30000 });
  await expect(page.locator('#gate')).toHaveCount(0);
});

test('autotest : aussi derrière le mot de passe, sans lancement automatique avant', async ({ page }) => {
  await page.goto('/montage/autotest.html?gate&auto');
  await expect(page.locator('#gate input')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1000);
  await expect(page.locator('#steps > *')).toHaveCount(0);
});

test('site principal : aucune barrière, le lien vers le Montage reste présent', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#gate')).toHaveCount(0);
  await expect(page.locator('#btn-montage')).toHaveAttribute('href', 'montage/studio.html');
});
