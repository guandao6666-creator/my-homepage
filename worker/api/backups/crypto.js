/**
 * 备份用的增量哈希工具。
 *
 * R2 对象可能是 25 MiB 的二进制，不能整个读进内存再算摘要，
 * 因此这里实现流式 SHA-256：一边 read() 一边 update()，只保留 64 字节块。
 * 同时提供 CRC32，供 ZIP 导出使用。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const rotr = (value, shift) => (value >>> shift) | (value << (32 - shift));

export class Sha256 {
  constructor() {
    this.h = new Uint32Array(IV);
    this.buffer = new Uint8Array(64);
    this.bufferLen = 0;
    this.bytes = 0;
    this.words = new Uint32Array(64);
  }

  #block(view) {
    const w = this.words;
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.h;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + h) >>> 0;
  }

  update(data) {
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.bytes += input.length;
    let offset = 0;

    if (this.bufferLen) {
      const need = 64 - this.bufferLen;
      const take = Math.min(need, input.length);
      this.buffer.set(input.subarray(0, take), this.bufferLen);
      this.bufferLen += take;
      offset = take;
      if (this.bufferLen === 64) {
        this.#block(new DataView(this.buffer.buffer, this.buffer.byteOffset, 64));
        this.bufferLen = 0;
      }
    }

    while (offset + 64 <= input.length) {
      this.#block(new DataView(input.buffer, input.byteOffset + offset, 64));
      offset += 64;
    }

    if (offset < input.length) {
      this.buffer.set(input.subarray(offset), 0);
      this.bufferLen = input.length - offset;
    }

    return this;
  }

  digest() {
    const bitLength = this.bytes * 8;
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;

    const padLength = this.bufferLen < 56 ? 56 - this.bufferLen : 120 - this.bufferLen;
    const tail = new Uint8Array(padLength + 8);
    tail[0] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(padLength, high);
    view.setUint32(padLength + 4, low);
    this.update(tail);

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, this.h[i]);
    return out;
  }
}

export function toHex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(value) {
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return toHex(new Sha256().update(data).digest());
}

/** 逐块读取 stream，边读边算，绝不 arrayBuffer() 整个对象。 */
export async function hashStream(stream) {
  const reader = stream.getReader();
  const hash = new Sha256();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      hash.update(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return { sha256: toHex(hash.digest()), size };
}

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

export function crc32(bytes, seed = 0) {
  const table = crcTable();
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
