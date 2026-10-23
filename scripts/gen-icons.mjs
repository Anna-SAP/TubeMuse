// @ts-check
// 生成扩展图标 PNG（一次性脚本，产物已提交到 static/icons）。不依赖任何图像库。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'icons');

/** @param {Buffer} buf */
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {number} size @param {Uint8Array} rgba */
function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 单位坐标 (0..1) 下的着色函数，返回 [r,g,b,a] @param {number} x @param {number} y */
function shade(x, y) {
  const r = 0.22;
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0];
  // 播放三角形
  const inTri = x > 0.36 && x < 0.74 && Math.abs(y - 0.5) < (0.74 - x) * 0.62;
  if (inTri) return [255, 255, 255, 255];
  // 右上角的小星点（"缪斯"的灵感）
  const sx = x - 0.76;
  const sy = y - 0.24;
  if (Math.abs(sx) + Math.abs(sy) < 0.07 || (Math.abs(sx) < 0.012 || Math.abs(sy) < 0.012) && Math.abs(sx) + Math.abs(sy) < 0.11) {
    return [255, 236, 179, 255];
  }
  const t = (x + y) / 2;
  return [Math.round(232 - 60 * t), Math.round(64 - 20 * t), Math.round(78 + 70 * t), 255];
}

for (const size of [16, 32, 48, 128]) {
  const ss = 4;
  const rgba = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
          const a = c[3] / 255;
          acc[0] += c[0] * a;
          acc[1] += c[1] * a;
          acc[2] += c[2] * a;
          acc[3] += a;
        }
      }
      const i = (py * size + px) * 4;
      const n = ss * ss;
      rgba[i] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      rgba[i + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      rgba[i + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      rgba[i + 3] = Math.round((acc[3] / n) * 255);
    }
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `icon-${size}.png`), encodePng(size, rgba));
}
console.log(`图标已写入 ${outDir}`);
