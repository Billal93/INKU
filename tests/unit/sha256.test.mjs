// SHA-256 incrémental (vérification des modèles téléchargés) comparé à node:crypto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Sha256, sha256Hex } from '../../montage/speech/sha256.js';

test('SHA-256 : vecteurs FIPS 180-4 et découpages arbitraires', () => {
  for (const s of ['', 'abc', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', 'a'.repeat(1000)]) {
    assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
  }
  for (let n = 0; n < 120; n++) {
    const buf = randomBytes(n * 37 + (n % 7));
    const h = new Sha256();
    for (let i = 0; i < buf.length;) { const k = Math.min(buf.length - i, 1 + ((i * 13) % 97)); h.update(buf.subarray(i, i + k)); i += k; }
    assert.equal(h.hex(), createHash('sha256').update(buf).digest('hex'));
  }
});

test('SHA-256 : débit ≥ 50 Mo/s (modèle de 600 Mo vérifié en < 12 s, même machine chargée)', () => {
  const big = randomBytes(64 * 1048576);
  const t0 = performance.now();
  const h = new Sha256();
  for (let i = 0; i < big.length; i += 1 << 20) h.update(big.subarray(i, i + (1 << 20)));
  assert.equal(h.hex(), createHash('sha256').update(big).digest('hex'));
  const mbps = 64 / ((performance.now() - t0) / 1000);
  console.log(`sha256 : ${mbps.toFixed(0)} Mo/s`);
  assert.ok(mbps >= 50);
});
