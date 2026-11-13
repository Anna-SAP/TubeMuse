// @ts-check
// 发布流程（DECISIONS §70、§71）里不依赖浏览器的部分：版本号、CRX3 打包与校验、zip 读回、仓库 Secret 里的签名密钥、
// Firefox 版的数据收集声明与 Mozilla 签好的文件的核对、两个工作流的关键约定。
// Chromium 真的认不认这个 .crx，由 tests/e2e/smoke-crx.mjs 在真的 Chromium 里验证（CI 的 package job 和发布前各跑一次）。
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extensionIdOf, crxIdOf, manifestKeyOf, packCrx, readCrx } from '../../scripts/crx.mjs';
import { extensionIdFromPublicKey } from '../../scripts/gen-key.mjs';
import { SECRET_NAME, signingKeyFromSecret } from '../../scripts/release-key.mjs';
import { isManifestVersion, releaseVersion } from '../../scripts/version.mjs';
import { FIREFOX_ADDON_ID, FIREFOX_DATA_COLLECTION } from '../../scripts/firefox.mjs';
import { approvalNotes, verifySignedXpi } from '../../scripts/sign-firefox.mjs';
import { readZipEntry, zipDirectory } from '../../scripts/zip.mjs';

/** @param {'pkcs8' | 'pkcs1'} type */
const rsaPem = (type = 'pkcs8') => /** @type {string} */ (generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type, format: 'pem' }));

let pem = '';
let otherPem = '';
let dir = '';
let zip = Buffer.alloc(0);
beforeAll(() => {
  pem = rsaPem();
  otherPem = rsaPem();
  dir = mkdtempSync(join(tmpdir(), 'tubemuse-release-test-'));
  const ext = join(dir, 'ext');
  mkdirSync(join(ext, 'chunks'), { recursive: true });
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'T', version: '0.1.0.7', key: manifestKeyOf(pem) }));
  writeFileSync(join(ext, 'chunks', 'a.js'), 'console.log("中文 ✔");\n'.repeat(50));
  writeFileSync(join(ext, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  zipDirectory(ext, join(dir, 'ext.zip'));
  zip = readFileSync(join(dir, 'ext.zip'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('版本号', () => {
  it('Chrome 与 Firefox 都接受的写法：1–4 段整数，每段 0–65535，不带前导 0', () => {
    for (const v of ['1', '0.1.0', '0.1.0.137', '65535.0.0.65535']) expect(isManifestVersion(v)).toBe(true);
    for (const v of ['', '0.1.0.1.2', '01.2', '1.65536', '1..2', 'v1.2', '1.2-beta', '1.2.']) expect(isManifestVersion(v)).toBe(false);
  });

  it('发布版本号 = package.json 的三段 + 构建号；每次发布都比上一次高', () => {
    expect(releaseVersion('0.1.0', 137)).toBe('0.1.0.137');
    expect(() => releaseVersion('0.1', 3)).toThrow(/三段/);
    expect(() => releaseVersion('0.1.0', 0)).toThrow(/正整数/);
    expect(() => releaseVersion('0.1.0', 70000)).toThrow(/不能用作扩展版本/);
  });
});

describe('zip', () => {
  it('打进去的文件（含子目录、中文、存储与压缩两种方式）能原样读回来', () => {
    expect(JSON.parse(String(readZipEntry(zip, 'manifest.json'))).version).toBe('0.1.0.7');
    expect(String(readZipEntry(zip, 'chunks/a.js'))).toBe('console.log("中文 ✔");\n'.repeat(50));
    expect(readZipEntry(zip, 'icon.png')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    expect(readZipEntry(zip, 'nope.txt')).toBeUndefined();
  });
});

describe('CRX3', () => {
  it('打出来的包按 Chrome 的规则读得回来：扩展 ID 与 manifest 的 key 算出来的一样，里面就是原来的 zip', () => {
    const crx = packCrx(zip, pem);
    expect(crx.subarray(0, 4).toString('latin1')).toBe('Cr24');
    expect(crx.readUInt32LE(4)).toBe(3);
    const read = readCrx(crx);
    expect(read.id).toBe(extensionIdFromPublicKey(manifestKeyOf(pem)));
    expect(read.id).toMatch(/^[a-p]{32}$/);
    expect(read.publicKey).toBe(manifestKeyOf(pem));
    expect(read.zip.equals(zip)).toBe(true);
    // 同样的 zip、同样的私钥，字节一模一样（RSA PKCS#1 v1.5 签名是确定的）
    expect(packCrx(zip, pem).equals(crx)).toBe(true);
  });

  it('头部的 protobuf 编码：signed_header_data 是 10000 号字段（标签 82 F1 04），里面是 16 字节的 crx_id', () => {
    const crx = packCrx(zip, pem);
    const header = crx.subarray(12, 12 + crx.readUInt32LE(8));
    const crxId = crxIdOf(Buffer.from(manifestKeyOf(pem), 'base64'));
    expect(header.subarray(-22).equals(Buffer.concat([Buffer.from([0x82, 0xf1, 0x04, 0x12, 0x0a, 0x10]), crxId]))).toBe(true);
    expect(header[0]).toBe(0x12); // sha256_with_rsa = 2，长度定界
    expect(extensionIdOf(crxId)).toBe(readCrx(crx).id);
  });

  it('PKCS#1 格式的私钥（BEGIN RSA PRIVATE KEY）也能签', () => {
    const pkcs1 = rsaPem('pkcs1');
    expect(readCrx(packCrx(zip, pkcs1)).id).toBe(extensionIdFromPublicKey(manifestKeyOf(pkcs1)));
  });

  it('内容被改过、签名被改过、头部声明的 ID 不是签名的那把钥匙：都校验不过', () => {
    const crx = packCrx(zip, pem);
    const tamperedZip = Buffer.from(crx);
    tamperedZip[tamperedZip.length - 30] ^= 1;
    expect(() => readCrx(tamperedZip)).toThrow(/签名校验失败/);
    const tamperedSig = Buffer.from(crx);
    tamperedSig[12 + crx.readUInt32LE(8) - 30] ^= 1;
    expect(() => readCrx(tamperedSig)).toThrow(/签名校验失败/);
    // 声明的 ID 被改成另一把钥匙的：签名覆盖了声明，同样校验不过
    const other = packCrx(zip, otherPem);
    const swapped = Buffer.from(other);
    crxIdOf(Buffer.from(manifestKeyOf(pem), 'base64')).copy(swapped, 12 + other.readUInt32LE(8) - 16);
    expect(() => readCrx(swapped)).toThrow(/签名校验失败/);
  });

  it('签名本身没问题、但声明的扩展 ID 不是签名那把钥匙的：Chrome 报 CRX_REQUIRED_PROOF_MISSING，这里也拒绝', () => {
    // 按格式手工拼一个：用 otherPem 正确签名，signed_header_data 里却写 pem 的 crx_id（也顺带独立核对一遍编码）
    /** @param {number} n */
    const varint = (n) => {
      const out = [];
      while (n > 0x7f) {
        out.push((n & 0x7f) | 0x80);
        n >>>= 7;
      }
      return Buffer.from([...out, n]);
    };
    /** @param {number} num @param {Buffer} b */
    const field = (num, b) => Buffer.concat([varint(num * 8 + 2), varint(b.length), b]);
    const key = createPrivateKey(otherPem);
    const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
    const signedData = field(1, crxIdOf(Buffer.from(manifestKeyOf(pem), 'base64')));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(signedData.length);
    const signature = sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), len, signedData, zip]), key);
    const header = Buffer.concat([field(2, Buffer.concat([field(1, spki), field(2, signature)])), field(10000, signedData)]);
    const prefix = Buffer.alloc(12);
    prefix.write('Cr24', 0, 'latin1');
    prefix.writeUInt32LE(3, 4);
    prefix.writeUInt32LE(header.length, 8);
    expect(() => readCrx(Buffer.concat([prefix, header, zip]))).toThrow(/CRX_REQUIRED_PROOF_MISSING/);
    // 同样的拼法、声明自己的 ID，就是一个合格的包，并且和 packCrx 打的逐字节相同
    const own = Buffer.concat([field(2, Buffer.concat([field(1, spki), field(2, sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), len, field(1, crxIdOf(spki)), zip]), key))])), field(10000, field(1, crxIdOf(spki)))]);
    const ownPrefix = Buffer.from(prefix);
    ownPrefix.writeUInt32LE(own.length, 8);
    expect(Buffer.concat([ownPrefix, own, zip]).equals(packCrx(zip, otherPem))).toBe(true);
  });

  it('不是 CRX3 的文件说清楚哪里不对', () => {
    expect(() => readCrx(zip)).toThrow(/不是 CRX/);
    const v2 = Buffer.from(packCrx(zip, pem));
    v2.writeUInt32LE(2, 4);
    expect(() => readCrx(v2)).toThrow(/只认 3/);
    expect(() => readCrx(packCrx(zip, pem).subarray(0, 40))).toThrow();
  });

  it('只接受 RSA 私钥', () => {
    const ec = /** @type {string} */ (generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    expect(() => packCrx(zip, ec)).toThrow(/RSA/);
  });
});

describe('仓库 Secret 里的签名密钥', () => {
  it('没配时说明要去哪里配、填什么', () => {
    for (const v of [undefined, '', '  \n ']) {
      expect(() => signingKeyFromSecret(v)).toThrow(new RegExp(`${SECRET_NAME}.*Settings → Secrets and variables → Actions.*local/extension-key\\.pem`));
    }
  });

  it('从 Windows 复制来的（\\r\\n）、前后带空行的也能用；得到的扩展 ID 与 npm run setup 的算法一致', () => {
    const key = signingKeyFromSecret(`\r\n${pem.replace(/\n/g, '\r\n')}\r\n\r\n`);
    expect(key.manifestKey).toBe(manifestKeyOf(pem));
    expect(key.extensionId).toBe(extensionIdFromPublicKey(manifestKeyOf(pem)));
    expect(key.pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    // 写出去的 PEM 和原来的是同一把钥匙：签出来的包和直接用原文签的一样
    expect(packCrx(zip, key.pem).equals(packCrx(zip, pem))).toBe(true);
  });

  it('填错了（公钥、半截、别的东西）时说明原因，不回显内容', () => {
    const pub = manifestKeyOf(pem);
    expect(() => signingKeyFromSecret(pub)).toThrow(/像是公钥/);
    expect(() => signingKeyFromSecret(`-----BEGIN PUBLIC KEY-----\n${pub}\n-----END PUBLIC KEY-----`)).toThrow(/是公钥/);
    const half = pem.slice(0, pem.length / 2);
    let message = '';
    try {
      signingKeyFromSecret(half);
    } catch (e) {
      message = /** @type {Error} */ (e).message;
    }
    expect(message).toMatch(/读不出私钥/);
    const body = half.split('\n')[1] ?? '';
    expect(body.length).toBeGreaterThan(20);
    expect(message).not.toContain(body);
    expect(() => signingKeyFromSecret('hello')).toThrow(/不是 PEM/);
    const ec = /** @type {string} */ (generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    expect(() => signingKeyFromSecret(ec)).toThrow(/RSA/);
  });
});

describe('发布工作流（.github/workflows/release.yml）', () => {
  const root = new URL('../../', import.meta.url);
  const release = readFileSync(new URL('.github/workflows/release.yml', root), 'utf8');
  const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');

  it('在 main 上 push 触发、全部通过的那次 CI 之后发布；也能手动发布 main', () => {
    expect(release).toMatch(/workflow_run:\n\s+workflows: \[CI\]\n\s+types: \[completed\]\n\s+branches: \[main\]/);
    expect(release).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(release).toContain("github.event.workflow_run.event == 'push'");
    expect(release).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
    expect(release).toContain("github.ref == 'refs/heads/main'");
    // CI 的名字改了，这里就再也不会被触发
    expect(ci).toMatch(/^name: CI$/m);
  });

  it('发布的是 CI 验过的那个提交，版本号的第四段是它在 main 上的提交数', () => {
    expect(release).toContain('github.event.workflow_run.head_sha');
    expect(release).toMatch(/fetch-depth: 0/);
    expect(release).toContain('npm run package -- --build="$(git rev-list --count "$RELEASE_SHA")"');
  });

  it('签名密钥只交给载入它的那一步；发布前让真的 Chromium 装一遍 .crx；三个文件都上传', () => {
    expect(release.match(/secrets\.CRX_PRIVATE_KEY/g)?.length).toBe(1);
    expect(release).toMatch(/CRX_PRIVATE_KEY: \$\{\{ secrets\.CRX_PRIVATE_KEY \}\}\n\s+run: node scripts\/release-key\.mjs/);
    expect(release.indexOf('node tests/e2e/smoke-crx.mjs')).toBeGreaterThan(0);
    expect(release.indexOf('node tests/e2e/smoke-crx.mjs')).toBeLessThan(release.indexOf('gh release create'));
    for (const f of ['chrome.zip', 'chrome.crx', 'firefox.xpi']) expect(release).toContain(`release/tubemuse-$VERSION-${f}`);
  });

  it('只有发布的那个 job 能写仓库；工作流默认只读', () => {
    expect(release).toMatch(/^permissions:\n\s+contents: read$/m);
    expect(release.match(/contents: write/g)?.length).toBe(1);
  });

  it('CI 的 package job 在每个 PR 上用临时密钥把同一条打包路走一遍，verify 要它也通过', () => {
    const job = ci.slice(ci.indexOf('\n  package:'), ci.indexOf('\n  verify:'));
    expect(job).toContain('run: npm run setup');
    expect(job).toContain('run: npm run package');
    expect(job).toContain('run: node tests/e2e/smoke-crx.mjs');
    expect(job).not.toContain('secrets.');
    const verify = ci.slice(ci.indexOf('\n  verify:'));
    expect(verify).toContain('[ "$PACKAGE" = "success" ]');
    expect(verify).toContain("needs.package.result == 'success'");
  });
});

describe('Firefox 版的 Mozilla 签名（DECISIONS §71）', () => {
  const root = new URL('../../', import.meta.url);
  const release = readFileSync(new URL('.github/workflows/release.yml', root), 'utf8');
  const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  const MOZILLA_TYPES = [
    'personallyIdentifyingInfo',
    'healthInfo',
    'financialAndPaymentInfo',
    'authenticationInfo',
    'personalCommunications',
    'locationInfo',
    'browsingActivity',
    'websiteContent',
    'websiteActivity',
    'searchTerms',
    'bookmarksInfo',
    'technicalAndInteraction',
  ];

  /** 用 zipDirectory 打一个"扩展"，再按需加上 META-INF 签名文件、改动内容 */
  const makeXpi = (/** @type {{ version?: string; id?: string; extra?: Record<string, string>; jsBody?: string; manifest?: (m: any) => string }} */ o = {}) => {
    const base = mkdtempSync(join(tmpdir(), 'tubemuse-xpi-'));
    const d = join(base, 'ext');
    try {
      mkdirSync(join(d, 'chunks'), { recursive: true });
      const m = { manifest_version: 3, version: o.version ?? '0.1.0.51', browser_specific_settings: { gecko: { id: o.id ?? FIREFOX_ADDON_ID } } };
      writeFileSync(join(d, 'manifest.json'), o.manifest ? o.manifest(m) : JSON.stringify(m, null, 2) + '\n');
      writeFileSync(join(d, 'chunks', 'a.js'), o.jsBody ?? 'console.log("ok");\n'.repeat(30));
      for (const [name, body] of Object.entries(o.extra ?? {})) {
        mkdirSync(join(d, name, '..'), { recursive: true });
        writeFileSync(join(d, name), body);
      }
      zipDirectory(d, join(base, 'out.xpi'));
      return readFileSync(join(base, 'out.xpi'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };
  const SIG = { 'META-INF/manifest.mf': 'x', 'META-INF/mozilla.sf': 'x', 'META-INF/mozilla.rsa': 'sig', 'META-INF/cose.manifest': 'x', 'META-INF/cose.sig': 'sig' };
  const expected = { version: '0.1.0.51', id: FIREFOX_ADDON_ID };

  it('数据收集声明：只用 Mozilla 定义的类别，如实声明（不是 none），technicalAndInteraction 不能是必需', () => {
    expect(FIREFOX_DATA_COLLECTION.required.length).toBeGreaterThan(0);
    for (const t of FIREFOX_DATA_COLLECTION.required) expect(MOZILLA_TYPES).toContain(t);
    expect(FIREFOX_DATA_COLLECTION.required).not.toContain('none');
    expect(FIREFOX_DATA_COLLECTION.required).not.toContain('technicalAndInteraction');
    // 找片口令发给大模型 / YouTube：核心功能，少了它声明就不如实
    expect(FIREFOX_DATA_COLLECTION.required).toContain('searchTerms');
  });

  it('Mozilla 会重新序列化 manifest.json（2026-11-12 第一次真签名时碰到）：内容相同就通过，内容变了照样拒收', () => {
    const unsigned = makeXpi();
    // 去掉末尾换行、换一种缩进：解析后一样
    expect(() => verifySignedXpi(makeXpi({ extra: SIG, manifest: (m) => JSON.stringify(m, null, 2) }), unsigned, expected)).not.toThrow();
    expect(() => verifySignedXpi(makeXpi({ extra: SIG, manifest: (m) => JSON.stringify(m) }), unsigned, expected)).not.toThrow();
    // 多了一项、改了一项：拒收，并说出是哪一项
    expect(() => verifySignedXpi(makeXpi({ extra: SIG, manifest: (m) => JSON.stringify({ ...m, update_url: 'https://evil.example/u.json' }) }), unsigned, expected)).toThrow(/manifest\.json.*update_url/);
    expect(() => verifySignedXpi(makeXpi({ extra: SIG, manifest: (m) => JSON.stringify({ ...m, manifest_version: 2 }) }), unsigned, expected)).toThrow(/manifest_version/);
    expect(() => verifySignedXpi(makeXpi({ extra: SIG, manifest: () => '{ not json' }), unsigned, expected)).toThrow(/不是合法的 JSON/);
  });

  it('Mozilla 签好的文件：有签名、其余文件逐个相同、ID 与版本对得上，才算通过', () => {
    const unsigned = makeXpi();
    expect(verifySignedXpi(makeXpi({ extra: SIG }), unsigned, expected).signatureFiles).toContain('META-INF/cose.sig');
    expect(() => verifySignedXpi(makeXpi(), unsigned, expected)).toThrow(/没有 Mozilla 的签名/);
    expect(() => verifySignedXpi(makeXpi({ extra: { ...SIG, 'evil.js': 'x' } }), unsigned, expected)).toThrow(/多了 evil\.js/);
    expect(() => verifySignedXpi(makeXpi({ extra: SIG, jsBody: 'console.log("changed");' }), unsigned, expected)).toThrow(/chunks\/a\.js/);
    expect(() => verifySignedXpi(makeXpi({ extra: SIG, version: '0.1.0.52' }), makeXpi({ version: '0.1.0.52' }), expected)).toThrow(/版本是 0\.1\.0\.52/);
    expect(() => verifySignedXpi(makeXpi({ extra: SIG, id: 'other@x' }), makeXpi({ id: 'other@x' }), expected)).toThrow(/扩展 ID 是 other@x/);
    const fewer = makeXpi({ extra: { ...SIG } });
    expect(() => verifySignedXpi(fewer, makeXpi({ extra: { 'more.txt': 'y' } }), expected)).toThrow(/少了 more\.txt/);
  });

  it('给审核员的说明写明从源码构建出同一个包的命令', () => {
    const notes = approvalNotes('0.1.0.51', 'abc123', 'https://github.com/o/r');
    expect(notes).toContain('node scripts/build.mjs --firefox --version=0.1.0.51');
    expect(notes).toContain('npm ci');
    expect(notes).toContain('abc123');
  });

  it('发布之后才签名；AMO 凭据只交给签名那一步；已经有签好的文件就不重复提交；签好的追加到同一个 Release', () => {
    expect(release.match(/secrets\.AMO_JWT_ISSUER/g)?.length).toBe(1);
    expect(release.match(/secrets\.AMO_JWT_SECRET/g)?.length).toBe(1);
    const sign = release.slice(release.indexOf('- name: Sign the Firefox package with Mozilla'));
    expect(release.indexOf('gh release create')).toBeLessThan(release.indexOf('- name: Sign the Firefox package with Mozilla'));
    expect(sign).toContain('AMO_JWT_SECRET: ${{ secrets.AMO_JWT_SECRET }}');
    expect(sign).toContain('node scripts/sign-firefox.mjs --version="$VERSION"');
    expect(sign).toContain('grep -qxF "$name"');
    expect(sign).toContain('gh release upload "$tag" "release/$name"');
    expect(release).toContain('npm ci --prefix tools/amo');
  });

  it('web-ext 单独放在 tools/amo、版本钉死、有锁文件；CI 的 package job 用它做 Mozilla 同款校验', () => {
    const pkg = JSON.parse(readFileSync(new URL('tools/amo/package.json', root), 'utf8'));
    expect(pkg.devDependencies['web-ext']).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = JSON.parse(readFileSync(new URL('tools/amo/package-lock.json', root), 'utf8'));
    expect(lock.packages['node_modules/web-ext'].version).toBe(pkg.devDependencies['web-ext']);
    const job = ci.slice(ci.indexOf('\n  package:'), ci.indexOf('\n  verify:'));
    expect(job).toContain('run: npm run lint:firefox');
    expect(job).toContain('run: npm run test:sign');
    // 主项目不依赖它：扩展的 npm ci 不变
    const main = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    expect(main.devDependencies['web-ext']).toBeUndefined();
  });
});
