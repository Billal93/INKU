// Génère montage/precache.json (fichiers de l'application à garder hors ligne) et réécrit la VERSION
// du service worker : toute modification d'un fichier change la version, donc le cache.
// Usage : node tools/montage-precache.mjs [--check]   (--check : échoue si les fichiers ne sont pas à jour)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const M = join(ROOT, 'montage');
const SKIP = [/^dev\//, /^bench\/data\//, /\.d\.m?ts$/, /\.LICENSE\.txt$/, /^precache\.json$/, /^sw\.js$/, /^mockup\.html$/, /\.map$/];

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(M).map((p) => relative(M, p).split(sep).join('/')).filter((f) => !SKIP.some((re) => re.test(f))).sort();
// Polices et icônes partagées avec le site principal, utilisées par studio.html.
const shared = ['../assets/fonts/plus-jakarta-sans-400.woff2', '../assets/fonts/plus-jakarta-sans-700.woff2', '../assets/fonts/plus-jakarta-sans-800.woff2', '../assets/favicon-32.png', '../assets/apple-touch-icon.png'];
const all = [...files, ...shared];
const h = createHash('sha256');
// Fins de ligne normalisées : même version quel que soit le poste (Git convertit CRLF/LF).
const TEXT = /\.(m?js|html|css|json|webmanifest|txt|md)$/;
/** @param {string} s */
const lf = (s) => s.split('\r\n').join('\n');
for (const f of [...files, ...shared]) {
  const b = readFileSync(join(M, f));
  h.update(f).update(TEXT.test(f) ? lf(b.toString('utf8')) : b);
}
const version = h.digest('hex').slice(0, 12);

const json = JSON.stringify({ version, files: all }, null, 1) + '\n';
const swPath = join(M, 'sw.js');
const sw = readFileSync(swPath, 'utf8').replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
if (process.argv.includes('--check')) {
  const ok = lf(readFileSync(join(M, 'precache.json'), 'utf8')) === json && lf(readFileSync(swPath, 'utf8')) === lf(sw);
  if (!ok) { console.error('precache.json / sw.js pas à jour : lancez node tools/montage-precache.mjs'); process.exit(1); }
  console.log('precache à jour', version);
} else {
  writeFileSync(join(M, 'precache.json'), json);
  writeFileSync(swPath, sw);
  console.log(`precache : ${all.length} fichiers, version ${version}`);
}
