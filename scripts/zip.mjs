// @ts-check
// 把一个目录打成 zip（Firefox 的 .xpi 就是 zip，manifest.json 在最上层；Chrome 的 .zip 与 .crx 里也是它，DECISIONS §70），以及从中取出一个文件。不引入依赖：Node 自带的 zlib 做 deflate，CRC-32 自己算。
// 输出可重复：文件按路径排序，时间戳固定为 2026-01-01 00:00，同样的内容得到一模一样的字节。
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Uint8Array} buf */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = /** @type {number} */ (CRC_TABLE[(c ^ /** @type {number} */ (buf[i])) & 0xff]) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// DOS 时间：2026-01-01 00:00:00
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/**
 * @param {string} dir 要打包的目录（它的内容放在 zip 的最上层）
 * @param {string} out 输出文件
 * @returns {{ files: number; bytes: number }}
 */
export function zipDirectory(dir, out) {
  const files = walk(dir)
    .map((p) => ({ path: p, name: relative(dir, p).split(sep).join('/') }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = readFileSync(f.path);
    const deflated = deflateRawSync(data, { level: 9 });
    // 压不小的（PNG 之类）直接存
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 需要的版本 2.0
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(stored ? 0 : 8, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const cenSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...chunks, ...central, end]);
  writeFileSync(out, all);
  return { files: files.length, bytes: all.length };
}

/**
 * 从 zip（本项目的 zipDirectory 打的，或 .crx 里的那一段）里取出一个文件。找不到时返回 undefined。
 * 只认"存储"和"deflate"两种方式（zipDirectory 只用这两种）。
 * @param {Buffer} zip
 * @param {string} name zip 里的路径，例如 manifest.json
 * @returns {Buffer | undefined}
 */
export function readZipEntry(zip, name) {
  // 末尾的"中央目录结束记录"（没有注释时就在最后 22 字节；保险起见往前找）
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('不是 zip：找不到中央目录');
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 的中央目录损坏');
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entry = zip.toString('utf8', p + 46, p + 46 + nameLen);
    if (entry === name) {
      if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`zip 里 ${name} 的本地文件头损坏`);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const body = zip.subarray(start, start + size);
      if (method === 0) return Buffer.from(body);
      if (method === 8) return inflateRawSync(body);
      throw new Error(`zip 里 ${name} 的压缩方式 ${method} 不认识`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}

/**
 * 列出 zip 里所有文件的路径（按中央目录的顺序）。
 * @param {Buffer} zip
 * @returns {string[]}
 */
export function listZipEntries(zip) {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('不是 zip：找不到中央目录');
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  /** @type {string[]} */
  const names = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 的中央目录损坏');
    const nameLen = zip.readUInt16LE(p + 28);
    names.push(zip.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return names;
}
