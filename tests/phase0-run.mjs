// Lance le test de faisabilité Phase 0 dans plusieurs moteurs et résume le résultat.
// Usage: node tests/phase0-run.mjs [chrome|msedge|chromium|webkit|firefox ...] [--res=720x1280] [--comp=canvas2d] [--hw=prefer-software]
import { chromium, webkit, firefox } from '@playwright/test';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opts = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const targets = args.filter((a) => !a.startsWith('--'));
if (!targets.length) targets.push('chrome');
const base = process.env.BASE || 'http://localhost:8731';

const launchers = {
  chrome: () => chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-webgpu'] }),
  msedge: () => chromium.launch({ channel: 'msedge' }),
  chromium: () => chromium.launch(),
  webkit: () => webkit.launch(),
  firefox: () => firefox.launch(),
};

fs.mkdirSync('reference', { recursive: true });
for (const name of targets) {
  console.log('\n=== ' + name + ' ===');
  let browser;
  try {
    browser = await launchers[name]();
    const page = await browser.newPage();
    if (opts.noaac) await page.addInitScript(() => { delete window.AudioEncoder; }); // simule un navigateur sans AudioEncoder (ex. iOS < 26)
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
    const q = new URLSearchParams({ auto: '1', ...(opts.res && { res: opts.res }), ...(opts.comp && { comp: opts.comp }), ...(opts.hw && { hw: opts.hw }) });
    // 1) première visite : le service worker s'installe et recharge la page une fois (isolation cross-origin)
    await page.goto(`${base}/montage/phase0.html`);
    const isolated = await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 15000 }).then(() => true).catch(() => false);
    console.log('crossOriginIsolated après service worker :', isolated);
    // 2) test automatique
    await page.goto(`${base}/montage/phase0.html?${q}`);
    await page.waitForFunction(() => window.__phase0Done === true, null, { timeout: 240000 });
    const rep = await page.evaluate(() => window.__phase0Report);
    console.log('Verdict :', rep.verdict, rep.error || '');
    for (const c of rep.checks || []) console.log((c.ok ? '  OK  ' : '  KO  ') + c.name + ' — ' + c.detail);
    if (rep.timings) console.log('Timings :', JSON.stringify(rep.timings));
    if (rep.render) console.log('Render  :', JSON.stringify(rep.render));
    if (rep.chosen) console.log('Chosen  :', JSON.stringify(rep.chosen), '| compositor:', rep.compositor, '| AAC:', rep.aacMode);
    if (rep.caps) console.log('Caps    :', JSON.stringify({ level: rep.caps.level, webgl2: rep.caps.webgl2, webgpu: rep.caps.webgpu, hwH264: rep.caps.hwH264, aacNative: rep.caps.aacNative, coi: rep.caps.crossOriginIsolated, mem: rep.caps.deviceMemoryGB, cores: rep.caps.cores }));
    if (rep.mediaRecorder) console.log('Niveau D:', JSON.stringify(rep.mediaRecorder));
    if (rep.warnings && rep.warnings.length) console.log('Warnings:', rep.warnings.join(' | '));
    fs.writeFileSync(`reference/phase0-${name}${opts.res ? '-' + opts.res : ''}.json`, JSON.stringify(rep, null, 2));
    // sauvegarde le MP4 produit pour inspection (ffprobe)
    const b64 = await page.evaluate(async () => {
      if (!window.__phase0Blob) return null;
      const buf = new Uint8Array(await window.__phase0Blob.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
      return btoa(s);
    });
    if (b64) fs.writeFileSync(`reference/phase0-${name}.mp4`, Buffer.from(b64, 'base64'));
  } catch (e) {
    console.log('ÉCHEC du lancement/exécution :', e.message.split('\n')[0]);
  } finally {
    if (browser) await browser.close();
  }
}
