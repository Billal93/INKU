// Lecture / écriture ZIP minimale et sûre (pack de marque : un seul fichier pour passer d'un appareil à l'autre).
// - lecture : répertoire central, méthodes « stockée » et « deflate » (DecompressionStream), contrôle CRC-32 ;
// - écriture : médias stockés tels quels (déjà compressés), texte compressé (deflate) ; noms UTF-8.
// Sans dépendance ; fonctionne dans le navigateur et dans Node (tests/unit/zip.test.mjs).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
/** @param {Uint8Array} data @param {number} [crc] */
export function crc32(data, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** @param {Uint8Array} data @param {'deflate-raw'} fmt */
async function pipe(data, fmt, compress) {
  const s = new Blob([/** @type {BlobPart} */ (data)]).stream().pipeThrough(compress ? new CompressionStream(fmt) : new DecompressionStream(fmt));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/**
 * Liste les entrées d'un ZIP. Les données ne sont décompressées qu'à la demande (`read()`).
 * @param {Blob} blob
 * @returns {Promise<{ name: string, size: number, read: () => Promise<Uint8Array> }[]>}
 */
export async function readZip(blob) {
  const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - 65557)).arrayBuffer());
  const dvT = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (dvT.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Fichier ZIP invalide (fin de répertoire introuvable).');
  const count = dvT.getUint16(eocd + 10, true), cdSize = dvT.getUint32(eocd + 12, true), cdOff = dvT.getUint32(eocd + 16, true);
  if (cdOff === 0xffffffff || count === 0xffff) throw new Error('ZIP64 non pris en charge (pack de plus de 4 Go).');
  const cd = new Uint8Array(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dv = new DataView(cd.buffer);
  const entries = [];
  const utf8 = new TextDecoder(), latin = new TextDecoder('latin1');
  for (let p = 0, i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Répertoire ZIP corrompu.');
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const nameBytes = cd.subarray(p + 46, p + 46 + nlen);
    const name = (flags & 0x800 ? utf8 : latin).decode(nameBytes);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (name.includes('..') || name.startsWith('/')) throw new Error('Nom de fichier dangereux dans le ZIP : ' + name);
    entries.push({
      name, size: usize,
      read: async () => {
        const lh = new DataView(await blob.slice(local, local + 30).arrayBuffer());
        if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('Entrée ZIP corrompue : ' + name);
        const start = local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const raw = new Uint8Array(await blob.slice(start, start + csize).arrayBuffer());
        let data;
        if (method === 0) data = raw;
        else if (method === 8) {
          try { data = await pipe(raw, 'deflate-raw', false); } catch { throw new Error('Fichier abîmé dans le ZIP (décompression) : ' + name); }
        }
        else throw new Error(`Méthode de compression ${method} non prise en charge (${name}).`);
        if (data.length !== usize || crc32(data) !== crc) throw new Error('Fichier abîmé dans le ZIP (CRC) : ' + name);
        return data;
      },
    });
  }
  return entries;
}

/**
 * Construit un ZIP. Les fichiers déjà compressés (vidéo, audio, image, police woff2) sont stockés tels quels.
 * @param {{ name: string, data: Uint8Array }[]} files
 * @returns {Promise<Blob>}
 */
export async function writeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const compress = /\.(json|txt|md|csv|svg|ttf|otf)$/i.test(f.name);
    const body = compress ? await pipe(f.data, 'deflate-raw', true) : f.data;
    const method = compress ? 8 : 0;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x800, true); lh.setUint16(8, method, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, body.length, true); lh.setUint32(22, f.data.length, true); lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, body);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x800, true); ch.setUint16(10, method, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, body.length, true); ch.setUint32(24, f.data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + body.length;
    if (offset > 0xffffffff) throw new Error('Pack trop volumineux (> 4 Go).');
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
