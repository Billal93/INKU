import { test, expect } from '@playwright/test';
import path from 'node:path';

const img = (n) => path.join(process.cwd(), 'test-assets', `test${n}.jpg`);

test.describe('Smoke INKU Studio', () => {
  test('pas d\'erreur JS au chargement + tous les onglets changent', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

    await page.goto('/index.html');
    await expect(page.locator('#applier')).toBeVisible();

    for (const id of ['extractor', 'collage', 'generator', 'redaction', 'applier']) {
      await page.click('#btn-' + id);
      await expect(page.locator('#' + id)).toBeVisible();
    }

    expect(errors, 'Erreurs JS détectées : ' + errors.join(' | ')).toEqual([]);
  });

  test('Appliquer : recherche logo + traitement images', async ({ page }) => {
    await page.goto('/index.html');
    await page.setInputFiles('#inImgs', [img(1), img(2)]);
    await page.fill('#logoSearch', 'naruto');
    await page.waitForTimeout(400);
    const results = page.locator('#logoResults .logo-item');
    await expect(results.first()).toBeVisible({ timeout: 5000 });
    await results.first().click();
    await page.click('text=Appliquer les Copyrights');
    await expect(page.locator('#bulkActions')).toBeVisible({ timeout: 15000 });
    const items = page.locator('#appPreview .app-item');
    await expect(items).toHaveCount(2);
  });

  test('Collage : ajout images + collage classique', async ({ page }) => {
    await page.goto('/index.html');
    await page.click('#btn-collage');
    await page.setInputFiles('#collageInput', [img(1), img(2), img(3)]);
    await expect(page.locator('#collageGrid .collage-item')).toHaveCount(3);
  });

  test('Créateur 4K : génère un canvas 3840x2160', async ({ page }) => {
    await page.goto('/index.html');
    await page.click('#btn-generator');
    await page.fill('#wmText', 'Test 4K');
    await page.click('#generator button.big-btn');
    await expect(page.locator('#genOutput')).toBeVisible();
    const dims = await page.$eval('#canvasGenPreview', (c) => [c.width, c.height]);
    expect(dims).toEqual([3840, 2160]);
  });

  test('Tweets : compteur et bloc-notes', async ({ page }) => {
    await page.goto('/index.html');
    await page.click('#btn-redaction');
    await page.fill('#tweetLibreInput', 'Bonjour le monde');
    await expect(page.locator('#libreCount')).toHaveText('16 / 280');
    await page.fill('#blocNotesInput', 'note de test');
    await page.reload();
    await page.click('#btn-redaction');
    await expect(page.locator('#blocNotesInput')).toHaveValue('note de test');
  });
});
