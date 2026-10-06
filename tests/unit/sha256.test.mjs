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

