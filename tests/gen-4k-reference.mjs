// Génère un PNG de référence du Créateur 4K pour comparer le rendu avant/après.
// Usage: node tests/gen-4k-reference.mjs <base_url> <out_file> [texte]
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const baseUrl = process.argv[2] || 'http://localhost:8731';
const outFile = process.argv[3] || 'reference/4k_reference.png';
const text = process.argv[4] ?? '';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(baseUrl + '/index.html');
await page.click('#btn-generator');
if (text) {
  await page.fill('#wmText', text);
} else {
  await page.fill('#wmText', '');
}
await page.click('#generator button.big-btn');
await page.waitForSelector('#genOutput', { state: 'visible' });

const dataUrl = await page.$eval('#canvasGenPreview', (canvas) => canvas.toDataURL('image/png'));
const base64 = dataUrl.split(',')[1];
fs.mkdirSync('reference', { recursive: true });
fs.writeFileSync(outFile, Buffer.from(base64, 'base64'));
console.log('Écrit', outFile, Buffer.from(base64, 'base64').length, 'octets');

await browser.close();
