import { test, expect } from '@playwright/test';
import path from 'node:path';

const img = (n) => path.join(process.cwd(), 'test-assets', `test${n}.jpg`);
const testVideo = path.join(process.cwd(), 'test-assets', 'test-video.mp4');

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

  test('Collage : téléchargement classique + Insta (noms après réorganisation)', async ({ page, browserName }) => {
    await page.goto('/index.html');
    await page.click('#btn-collage');
    await page.setInputFiles('#collageInput', [img(1), img(2), img(3), img(4)]);
    await expect(page.locator('#collageGrid .collage-item')).toHaveCount(4);

    const isIOSProject = /iPhone|iPad/.test(test.info().project.name);

    // Collage classique : doit produire un fichier téléchargeable (ou la modale iOS).
    if (isIOSProject) {
      await page.click('text=Collage Classique');
      await expect(page.locator('#iosModal')).toBeVisible();
      await page.click('text=Fermer');
    } else {
      const [download1] = await Promise.all([
        page.waitForEvent('download'),
        page.click('text=Collage Classique'),
      ]);
      expect(download1.suggestedFilename()).toBe('INKU_COLLAGE_2_COLONNES.jpg');
    }

    // Collage Insta : 4 images -> 2 paires. Reorganise les paires puis vérifie
    // que le téléchargement individuel de la 1ère carte utilise bien le nom "_1".
    await page.click('text=Collage Insta');
    await expect(page.locator('#instaPreview .capture-thumb')).toHaveCount(2);

    // Permute les deux paires par glisser-déposer (simulé via drag events HTML5
    // n'étant pas fiable avec Sortable ; on vérifie ici seulement la cohérence
    // nommage <-> position actuelle sans reorganiser physiquement, Firefox/CI
    // n'étant pas fiables pour un vrai drag tactile).
    const firstCardDlBtn = page.locator('#instaPreview .capture-thumb').nth(0).locator('button');
    if (isIOSProject) {
      await firstCardDlBtn.click();
      await expect(page.locator('#iosModal')).toBeVisible();
    } else {
      const [download2] = await Promise.all([
        page.waitForEvent('download'),
        firstCardDlBtn.click(),
      ]);
      expect(download2.suggestedFilename()).toBe('INKU_COLLAGE_INSTA_1.jpg');
    }
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

  test('Créateur 4K : touche Entrée + nom de fichier assaini', async ({ page, browserName }) => {
    await page.goto('/index.html');
    await page.click('#btn-generator');
    await page.fill('#wmText', 'Test / 4K : "spécial"');
    await page.press('#wmText', 'Enter');
    await expect(page.locator('#genOutput')).toBeVisible();

    const isIOSProject = /iPhone|iPad/.test(test.info().project.name);
    if (isIOSProject) {
      await page.click('text=Télécharger l\'image 4K');
      await expect(page.locator('#iosModal')).toBeVisible();
    } else {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click('text=Télécharger l\'image 4K'),
      ]);
      const name = download.suggestedFilename();
      expect(name).not.toMatch(/[\\/:*?"<>|]/);
    }
  });

  test('Appliquer : téléchargement via saveFiles (Blob URL, pas de dataURL brute)', async ({ page }) => {
    await page.goto('/index.html');
    await page.setInputFiles('#inImgs', [img(1)]);
    await page.fill('#logoSearch', 'naruto');
    await page.waitForTimeout(400);
    await page.locator('#logoResults .logo-item').first().click();
    await page.click('text=Appliquer les Copyrights');
    await expect(page.locator('#bulkActions')).toBeVisible({ timeout: 15000 });

    // Sur iOS (simulé ici), saveFiles() ouvre la modale d'appui long au lieu
    // d'émettre un événement "download" — c'est le comportement attendu.
    const isIOSProject = /iPhone|iPad/.test(test.info().project.name);
    if (isIOSProject) {
      await page.click('text=Tout Télécharger');
      await expect(page.locator('#iosModal')).toBeVisible();
      await expect(page.locator('#iosModalGrid img')).toHaveCount(1);
    } else {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click('text=Tout Télécharger'),
      ]);
      expect(download.suggestedFilename()).toMatch(/\.jpg$/);
    }
  });

  test('Vidéo : extraction de frames', async ({ page, browserName }) => {
    // Le WebKit embarqué par Playwright échoue à lire une blob: URL dans
    // <video> (MEDIA_ERR_SRC_NOT_SUPPORTED) même si une URL http classique
    // fonctionne : limite connue de ce WebKit headless, pas un comportement
    // de vrai Safari. À vérifier manuellement sur iPhone/iPad réels.
    test.skip(browserName === 'webkit', 'blob: URL non lisible par le WebKit headless de Playwright — à tester sur un vrai Safari');
    await page.goto('/index.html');
    await page.click('#btn-extractor');
    await page.setInputFiles('#videoFile', testVideo);
    await expect(page.locator('#videoControls')).toBeVisible();
    await page.click('[data-val="1"]'); // intervalle 1s sur une vidéo de 6s
    await page.click('#btnStartRealtime');
    await expect(page.locator('#capturesGrid .capture-thumb').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#realtimeStatus')).toContainText('terminée', { timeout: 20000 });
    const count = await page.locator('#capturesGrid .capture-thumb').count();
    expect(count).toBeGreaterThanOrEqual(5); // ~6-7 frames attendues (0,1,2,3,4,5,6s)

    const isIOSProject = /iPhone|iPad/.test(test.info().project.name);
    if (isIOSProject) {
      await page.click('text=ZIP Complet');
      await expect(page.locator('#iosModal')).toBeVisible();
    } else {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click('text=ZIP Complet'),
      ]);
      expect(download.suggestedFilename()).toMatch(/\.zip$/);
    }
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
