// Lecture / écriture WAV PCM (16 bits, 24 bits, 32 bits flottant). Fonctions pures.

/**
 * @param {ArrayBuffer | ArrayBufferView} buf
 * @returns {{ sampleRate: number, channels: Float32Array[] }}
 */
export function decodeWav(buf) {
  const dv = ArrayBuffer.isView(buf) ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength) : new DataView(buf);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('WAV invalide');
  let o = 12, fmt = null, data = null;
  while (o + 8 <= dv.byteLength) {
    const id = tag(o), size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(o + 8, true), ch: dv.getUint16(o + 10, true), rate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
    if (id === 'data') data = { o: o + 8, size: Math.min(size, dv.byteLength - o - 8) };
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV incomplet');
  const fmtCode = fmt.format === 0xfffe ? (fmt.bits === 32 ? 3 : 1) : fmt.format;
  const bps = fmt.bits / 8, n = Math.floor(data.size / (bps * fmt.ch));
  const channels = Array.from({ length: fmt.ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < fmt.ch; c++) {
      const p = data.o + (i * fmt.ch + c) * bps;
      let v;
      if (fmtCode === 3) v = bps === 4 ? dv.getFloat32(p, true) : dv.getFloat64(p, true);
      else if (bps === 2) v = dv.getInt16(p, true) / 32768;
      else if (bps === 3) v = ((dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16))) / 8388608;
      else if (bps === 4) v = dv.getInt32(p, true) / 2147483648;
      else v = (dv.getUint8(p) - 128) / 128;
      channels[c][i] = v;
    }
  }
  return { sampleRate: fmt.rate, channels };
}

/**
 * WAV 32 bits flottant (aucune perte) ou 16 bits.
 * @param {Float32Array[]} channels @param {number} sampleRate @param {16|32} [bits]
 */
export function encodeWav(channels, sampleRate, bits = 32) {
  const ch = channels.length, n = channels[0].length, bps = bits / 8;
  const buf = new ArrayBuffer(44 + n * ch * bps);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * bps, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, bits === 32 ? 3 : 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * ch * bps, true); dv.setUint16(32, ch * bps, true); dv.setUint16(34, bits, true);
  w(36, 'data'); dv.setUint32(40, n * ch * bps, true);
  let p = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++, p += bps) {
      const v = channels[c][i];
      if (bits === 32) dv.setFloat32(p, v, true);
      else dv.setInt16(p, Math.max(-32768, Math.min(32767, Math.round(v * 32768))), true);
    }
  }
  return buf;
}
