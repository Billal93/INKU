import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, readZip, writeZip } from '../../montage/brand/zip.js';

test('CRC-32 (valeur de référence)', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('ZIP : aller-retour, noms UTF-8, fichiers stockés et compressés', async () => {
  const files = [
    { name: 'pack.json', data: new TextEncoder().encode(JSON.stringify({ police: 'Clash Display', é: 'ç' }).repeat(50)) },
    { name: 'sons/clic é.wav', data: Uint8Array.from({ length: 5000 }, (_, i) => (i * 31) & 255) },
    { name: 'vide.txt', data: new Uint8Array(0) },
  ];
  const zip = await writeZip(files);
  const entries = await readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), files.map((f) => f.name));
  for (const [i, e] of entries.entries()) assert.deepEqual(Array.from(await e.read()), Array.from(files[i].data));
});

test('ZIP : lit un fichier produit par un autre outil (Python zipfile, deflate)', async (t) => {
  const py = 'python';
  try { execFileSync(py, ['--version']); } catch { t.skip('Python absent'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  try {
    const script = "import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)\nz.writestr('a/é.txt','bonjour '*100)\nz.writestr('b.bin',bytes(range(256))*10)\nz.close()";
    writeFileSync(join(dir, 'mk.py'), script);
    execFileSync(py, [join(dir, 'mk.py'), join(dir, 'x.zip')]);
    const entries = await readZip(new Blob([readFileSync(join(dir, 'x.zip'))]));
    assert.deepEqual(entries.map((e) => e.name), ['a/é.txt', 'b.bin']);
    assert.equal(new TextDecoder().decode(await entries[0].read()), 'bonjour '.repeat(100));
    assert.equal((await entries[1].read()).length, 2560);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ZIP : refuse un fichier corrompu et un chemin dangereux', async () => {
  const zip = new Uint8Array(await (await writeZip([{ name: 'a.txt', data: new TextEncoder().encode('x'.repeat(100)) }])).arrayBuffer());
  const bad = zip.slice(); bad[40] ^= 0xff;                 // octet de données modifié
  const e = await readZip(new Blob([bad]));
  await assert.rejects(e[0].read(), /CRC|corromp|abîmé|invalid/i);
  const evil = await writeZip([{ name: '../evil.txt', data: new Uint8Array(1) }]);
  await assert.rejects(readZip(evil), /dangereux/);
});
