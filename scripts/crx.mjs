// @ts-check
// Chrome 的 .crx 安装包（CRX3 格式，DECISIONS §70）：打包与校验。不引入依赖，只用 Node 自带的 crypto。
//
// 格式（Chromium components/crx_file/crx3.proto 与 crx_verifier.cc）：
//   "Cr24" | uint32 LE 3（版本）| uint32 LE 头部长度 | 头部（protobuf CrxFileHeader）| zip
//   CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2; bytes signed_header_data = 10000; }
//   AsymmetricKeyProof { bytes public_key = 1;（SPKI DER） bytes signature = 2; }
//   SignedData { bytes crx_id = 1; }（公钥 SHA-256 的前 16 字节）
//   签名（RSA PKCS#1 v1.5 + SHA-256）覆盖："CRX3 SignedData\x00" | uint32 LE signed_header_data 长度 | signed_header_data | zip
// 扩展 ID 就是 crx_id 的十六进制换成 a–p：和 manifest 的 key 算出来的是同一个（scripts/gen-key.mjs）。
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const MAGIC = 'Cr24';
const SIGNED_DATA_PREFIX = Buffer.from('CRX3 SignedData\x00', 'latin1');
/** 头部长度的合理上限（正常的头部只有几百字节）：防止读到坏文件时按一个离谱的长度去切 */
const MAX_HEADER = 1 << 20;

/** @param {number} n */
function varint(n) {
  /** @type {number[]} */
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

/**
 * 长度定界字段（wire type 2）
 * @param {number} num
 * @param {Buffer} bytes
 */
function bytesField(num, bytes) {
  return Buffer.concat([varint(num * 8 + 2), varint(bytes.length), bytes]);
}

/**
 * 读出一段 protobuf 里的长度定界字段（别的类型跳过）。
 * @param {Buffer} buf
 * @returns {{ num: number; value: Buffer }[]}
 */
function readFields(buf) {
  /** @type {{ num: number; value: Buffer }[]} */
  const fields = [];
  let i = 0;
  const readVarint = () => {
    let n = 0;
    let mul = 1;
    for (;;) {
      if (i >= buf.length) throw new Error('CRX 头部被截断（varint）');
      const b = /** @type {number} */ (buf[i++]);
      n += (b & 0x7f) * mul;
      if (!(b & 0x80)) return n;
      mul *= 128;
      if (mul > 2 ** 49) throw new Error('CRX 头部的 varint 太长');
    }
  };
  while (i < buf.length) {
    const tag = readVarint();
    const num = Math.floor(tag / 8);
    const type = tag % 8;
    if (type === 2) {
      const len = readVarint();
      if (i + len > buf.length) throw new Error('CRX 头部被截断（字段长度超出）');
      fields.push({ num, value: buf.subarray(i, i + len) });
      i += len;
    } else if (type === 0) readVarint();
    else if (type === 5) i += 4;
    else if (type === 1) i += 8;
    else throw new Error(`CRX 头部里有不认识的字段类型 ${type}`);
  }
  return fields;
}

/**
 * 公钥（SPKI DER）→ crx_id（16 字节）
 * @param {Buffer} spki
 */
export function crxIdOf(spki) {
  return createHash('sha256').update(spki).digest().subarray(0, 16);
}

/**
 * crx_id → 扩展 ID（32 个 a–p）
 * @param {Buffer} crxId
 */
export function extensionIdOf(crxId) {
  return [...crxId.toString('hex')].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/** @param {Buffer} signedData @param {Buffer} zip */
function signedPayload(signedData, zip) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedData.length);
  return Buffer.concat([SIGNED_DATA_PREFIX, len, signedData, zip]);
}

/**
 * 私钥（PEM）→ manifest 的 key（公钥 SPKI DER 的 base64）。用来核对签名用的私钥和 manifest 里的 key 是同一对。
 * @param {string} privateKeyPem
 */
export function manifestKeyOf(privateKeyPem) {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'der' }).toString('base64');
}

/**
 * 把扩展的 zip 打成 CRX3。
 * @param {Buffer} zip 扩展目录打成的 zip（manifest.json 在最上层）
 * @param {string} privateKeyPem RSA 私钥（PEM，PKCS#8 或 PKCS#1 都行）
 */
export function packCrx(zip, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'rsa') throw new Error(`签名密钥要是 RSA 私钥，拿到的是 ${key.asymmetricKeyType}`);
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const signedData = bytesField(1, crxIdOf(spki));
  const signature = sign('sha256', signedPayload(signedData, zip), key);
  const proof = Buffer.concat([bytesField(1, spki), bytesField(2, signature)]);
  const header = Buffer.concat([bytesField(2, proof), bytesField(10000, signedData)]);
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, 'latin1');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, zip]);
}

/**
 * 按 Chrome 的规则校验一个 CRX3：魔数与版本、每个 RSA 签名都对、头部声明的 ID 有一个签名对得上（开发者签名）。
 * 不通过时抛错，说明哪一项不对。
 * @param {Buffer} crx
 * @returns {{ id: string; publicKey: string; zip: Buffer }} 扩展 ID、开发者公钥（base64，与 manifest 的 key 同一写法）、里面的 zip
 */
export function readCrx(crx) {
  if (crx.length < 12 || crx.toString('latin1', 0, 4) !== MAGIC) throw new Error('不是 CRX 文件（开头不是 Cr24）');
  const version = crx.readUInt32LE(4);
  if (version !== 3) throw new Error(`CRX 版本是 ${version}，Chrome 现在只认 3`);
  const headerSize = crx.readUInt32LE(8);
  if (headerSize > MAX_HEADER || 12 + headerSize > crx.length) throw new Error(`CRX 头部长度 ${headerSize} 不对`);
  const header = crx.subarray(12, 12 + headerSize);
  const zip = crx.subarray(12 + headerSize);
  if (zip.length < 4 || zip.readUInt32LE(0) !== 0x04034b50) throw new Error('CRX 头部后面不是 zip');

  const fields = readFields(header);
  const signedDataField = fields.find((f) => f.num === 10000);
  if (!signedDataField) throw new Error('CRX 头部没有 signed_header_data');
  const signedData = signedDataField.value;
  const crxId = readFields(signedData).find((f) => f.num === 1)?.value;
  if (!crxId || crxId.length !== 16) throw new Error('CRX 头部没有 16 字节的 crx_id');
  if (fields.some((f) => f.num === 3)) throw new Error('CRX 里有 ECDSA 签名：本项目只用 RSA，出现它说明文件不是本项目打的');

  const payload = signedPayload(signedData, zip);
  let developerKey = /** @type {Buffer | undefined} */ (undefined);
  const proofs = fields.filter((f) => f.num === 2);
  if (!proofs.length) throw new Error('CRX 头部没有 RSA 签名');
  for (const p of proofs) {
    const parts = readFields(p.value);
    const spki = parts.find((f) => f.num === 1)?.value;
    const signature = parts.find((f) => f.num === 2)?.value;
    if (!spki || !signature) throw new Error('CRX 的签名缺公钥或签名值');
    const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    if (!verify('sha256', payload, pub, signature)) throw new Error('CRX 签名校验失败：内容被改过，或签名不是用这把公钥对应的私钥做的');
    if (crxIdOf(spki).equals(crxId)) developerKey = spki;
  }
  if (!developerKey) throw new Error('CRX 头部声明的扩展 ID 没有对应的签名（Chrome 会报 CRX_REQUIRED_PROOF_MISSING）');
  return { id: extensionIdOf(crxId), publicKey: developerKey.toString('base64'), zip };
}
