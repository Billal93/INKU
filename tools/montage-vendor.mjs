// Copie les bibliothèques embarquées du Montage depuis node_modules (versions figées dans package.json).
// transformers.js est stocké COMPRESSÉ (.gz, reproductible) : 4× plus léger à télécharger, et la protection
// anti-secrets de GitHub ne le confond plus avec une clé d'API (faux positif sur « Mistral3ForConditionalGeneration »).
// Usage : node tools/montage-vendor.mjs
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const NM = join(ROOT, 'node_modules'), OUT = join(ROOT, 'montage/vendor/transformers');
mkdirSync(OUT, { recursive: true });

const tjs = JSON.parse(readFileSync(join(NM, '@huggingface/transformers/package.json'), 'utf8')).version;
const ort = JSON.parse(readFileSync(join(NM, 'onnxruntime-web/package.json'), 'utf8')).version;
// gzip niveau 9, sans nom ni date dans l'en-tête : même entrée → mêmes octets.
const gz = (/** @type {Buffer} */ b) => { const z = gzipSync(b, { level: 9 }); z[4] = z[5] = z[6] = z[7] = 0; return z; };
const src = readFileSync(join(NM, '@huggingface/transformers/dist/transformers.js'));
writeFileSync(join(OUT, 'transformers.js.gz'), gz(src));
const wasm = readFileSync(join(NM, 'onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm'));
writeFileSync(join(OUT, 'ort-wasm-simd-threaded.asyncify.wasm.gz'), gz(wasm));
copyFileSync(join(NM, 'onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs'), join(OUT, 'ort-wasm-simd-threaded.asyncify.mjs'));
copyFileSync(join(NM, '@huggingface/transformers/LICENSE'), join(OUT, 'transformers.LICENSE.txt'));
writeFileSync(join(OUT, 'VERSIONS.txt'), `transformers.js ${tjs} (Apache-2.0) : transformers.js.gz = dist/transformers.js compressé\nonnxruntime-web ${ort} (MIT) : ort-wasm-simd-threaded.asyncify.wasm.gz = moteur WebAssembly compressé\n`);
console.log(`transformers.js ${tjs} et onnxruntime-web ${ort} copiés (compressés).`);
