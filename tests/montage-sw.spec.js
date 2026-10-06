// Le service worker du Montage (COOP/COEP + cache hors ligne) doit rester limité à /montage/ :
// la page principale d'INKU doit se comporter exactement de la même façon avec ou sans lui.
import { test, expect } from '@playwright/test';

/** Charge index.html et relève ce qui pourrait différer : contrôleur SW, isolation, requêtes en échec, erreurs JS. */
async function probeIndex(page) {
  const failed = [], errors = [];
  page.on('requestfailed', (r) => failed.push(r.url()));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/index.html');
  await page.waitForLoadState('networkidle');
  const state = await page.evaluate(async () => ({
    controlled: !!navigator.serviceWorker.controller,
    isolated: window.crossOriginIsolated,
    tabs: document.querySelectorAll('.nav-btn').length,
    coep: (await fetch(location.href, { cache: 'no-store' })).headers.get('cross-origin-embedder-policy'),
  }));
  return { ...state, failed, errors };
}

test('index.html sans le service worker du Montage (référence)', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:8731' });
  const r = await probeIndex(await ctx.newPage());
  expect(r.controlled).toBe(false);
  expect(r.isolated).toBe(false);
  expect(r.errors).toEqual([]);
  expect(r.failed).toEqual([]);
  await ctx.close();
});

test('le SW du Montage est limité à /montage/ et ne touche pas index.html', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:8731' });
  const page = await ctx.newPage();
  await page.goto('/montage/studio.html');
  await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 20000 });
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope);
  expect(new URL(scope).pathname).toBe('/montage/');

  // Même contexte (le SW est installé) : la page principale ne doit pas être contrôlée ni isolée.
  const r = await probeIndex(await ctx.newPage());
  expect(r.controlled).toBe(false);
  expect(r.isolated).toBe(false);
  expect(r.coep).toBeNull();
  expect(r.errors).toEqual([]);
  expect(r.failed).toEqual([]);
  const regs = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((x) => new URL(x.scope).pathname));
  expect(regs).toEqual(['/montage/']);
  await ctx.close();
});

test('le Studio démarre hors ligne une fois mis en cache (PWA)', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:8731' });
  const page = await ctx.newPage();
  await page.goto('/montage/studio.html?offline-test');
  await page.waitForFunction(() => window.crossOriginIsolated === true && window.__studioReady === true, null, { timeout: 30000 });
  // Attendre que le pré-cache soit complet (installation du SW terminée).
  await page.waitForFunction(async () => {
    const keys = await caches.keys(); if (!keys.length) return false;
    const c = await caches.open(keys[0]); return (await c.keys()).length >= 25;
  }, null, { timeout: 30000 });
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.__studioReady === true, null, { timeout: 30000 });
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
  expect(await page.locator('#compat').isHidden()).toBe(true);
  await ctx.close();
});
