// @ts-check
// 让 Mozilla 给 Firefox 版签名（自行分发 / unlisted，DECISIONS §71）：签过名的 .xpi 在 Firefox 正式版、Beta 里能永久安装。
// 发布工作流在发布之后跑它：
//   node scripts/sign-firefox.mjs --version=0.1.0.51
// 前提：npm run package 已经打好 dist-firefox/ 和 release/tubemuse-<版本>-firefox.xpi；npm ci --prefix tools/amo 装好了 web-ext。
// 凭据来自环境变量 AMO_JWT_ISSUER / AMO_JWT_SECRET（仓库 Secret），只交给 web-ext 子进程（它自己的 WEB_EXT_API_KEY / WEB_EXT_API_SECRET），
// 不写进命令行、不写进文件、不打印。
// 做的事：
//   1. 把这个提交的源码打成 zip（我们的代码是 esbuild 打包过的，Mozilla 要求附上原始源码），附上给审核员的构建说明；
//   2. web-ext sign --channel=unlisted：上传、等校验、等签名、下载签好的文件（不公开上架）；
//   3. 核对签好的文件：有 Mozilla 的签名文件，除签名文件外和我们打的 .xpi 逐个文件一模一样，扩展 ID、版本号对得上；
//   4. 存成 release/tubemuse-<版本>-firefox-signed.xpi，由工作流上传到这一版的 Release。
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { FIREFOX_ADDON_ID } from './firefox.mjs';
import { isManifestVersion } from './version.mjs';
import { listZipEntries, readZipEntry } from './zip.mjs';

/** 等 Mozilla 签名的最长时间。自行分发的一般几分钟；Mozilla 说最长可能 24 小时，等不到时说明去哪里手动下载 */
export const APPROVAL_TIMEOUT_MS = 25 * 60_000;
/** AMO 的开发者中心：等不到签名、或这个版本已经提交过时，签好的文件在这里下载 */
export const AMO_DEVELOPER_HUB = 'https://addons.mozilla.org/developers/addons';

/**
 * 给 Mozilla 审核员的说明：怎样从源码包构建出一模一样的 .xpi。
 * @param {string} version
 * @param {string} sha 这个版本对应的提交
 * @param {string} repo 仓库地址
 */
export function approvalNotes(version, sha, repo) {
  return [
    `TubeMuse ${version} — personal-use extension, self-distributed (unlisted). Source: ${repo} (commit ${sha}); the uploaded source archive is that commit.`,
    'The code is bundled (not minified) with esbuild. To reproduce the submitted package from the source archive:',
    '  1. Node.js 20 or newer',
    '  2. npm ci',
    `  3. node scripts/build.mjs --firefox --version=${version}`,
    `  4. The extension is in dist-firefox/ (the same build also writes release/tubemuse-${version}-firefox.xpi).`,
    'No OAuth client ID is injected in this build (local/config.json is absent), so the output is deterministic.',
    'The extension only talks to the services listed in the manifest (host_permissions / CSP connect-src); API keys are entered by the user and stored locally.',
  ].join('\n');
}

/**
 * 核对 Mozilla 签好的 .xpi：
 * - 有签名文件（META-INF/mozilla.rsa 或 META-INF/cose.sig）；
 * - 除 META-INF/ 外的文件和我们打的 .xpi 一一对应、内容一模一样（Mozilla 只加签名，不改内容；manifest.json 会被它重新序列化，按解析后的内容比）；
 * - manifest 里的扩展 ID、版本号是这一版的。
 * 不通过时抛错说明哪里不对。
 * @param {Buffer} signed Mozilla 签好的 .xpi
 * @param {Buffer} unsigned 我们自己打的 .xpi
 * @param {{ version: string; id: string }} expected
 * @returns {{ signatureFiles: string[] }}
 */
export function verifySignedXpi(signed, unsigned, expected) {
  const signedNames = listZipEntries(signed).filter((n) => !n.endsWith('/'));
  const signatureFiles = signedNames.filter((n) => n.startsWith('META-INF/'));
  if (!signatureFiles.some((n) => n === 'META-INF/mozilla.rsa' || n === 'META-INF/cose.sig')) {
    throw new Error(`签好的文件里没有 Mozilla 的签名（META-INF/mozilla.rsa 或 META-INF/cose.sig）：${signatureFiles.join(', ') || '没有 META-INF'}`);
  }
  const content = signedNames.filter((n) => !n.startsWith('META-INF/')).sort();
  const ours = listZipEntries(unsigned)
    .filter((n) => !n.endsWith('/'))
    .sort();
  const missing = ours.filter((n) => !content.includes(n));
  const extra = content.filter((n) => !ours.includes(n));
  if (missing.length || extra.length) {
    throw new Error(`签好的文件和我们打的 .xpi 文件不一样：${missing.length ? `少了 ${missing.join(', ')}` : ''}${missing.length && extra.length ? '；' : ''}${extra.length ? `多了 ${extra.join(', ')}` : ''}`);
  }
  // manifest.json 例外：Mozilla 签名时会把它重新序列化（2026-11-12 第一次真签名实测：只有它字节不同；外部报告是去掉了末尾的换行），
  // 所以按解析后的内容比，必须完全相同；其余文件逐字节比
  const changed = ours.filter((n) => n !== 'manifest.json' && !(/** @type {Buffer} */ (readZipEntry(signed, n)).equals(/** @type {Buffer} */ (readZipEntry(unsigned, n)))));
  if (changed.length) throw new Error(`签好的文件里这些文件的内容和我们打的不一样：${changed.join(', ')}`);
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(String(readZipEntry(signed, 'manifest.json')));
  } catch {
    throw new Error('签好的文件里的 manifest.json 不是合法的 JSON');
  }
  const ourManifest = JSON.parse(String(readZipEntry(unsigned, 'manifest.json')));
  if (!isDeepStrictEqual(manifest, ourManifest)) {
    const keys = [...new Set([...Object.keys(manifest), ...Object.keys(ourManifest)])].filter((k) => !isDeepStrictEqual(manifest[k], ourManifest[k]));
    throw new Error(`签好的文件里 manifest.json 的内容和我们打的不一样（不只是格式）：${keys.join(', ')}`);
  }
  if (manifest.version !== expected.version) throw new Error(`签好的文件版本是 ${manifest.version}，不是 ${expected.version}`);
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (id !== expected.id) throw new Error(`签好的文件扩展 ID 是 ${id}，不是 ${expected.id}`);
  return { signatureFiles };
}

/** @param {string} msg */
function summary(msg) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${msg}\n`);
}

/** @param {string} msg @returns {never} */
function fail(msg) {
  console.error(`::error::${msg.replace(/\n/g, ' ')}`);
  summary(`### Firefox 版没有签名成功\n\n${msg}\n`);
  process.exit(1);
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const version = process.argv.find((a) => a.startsWith('--version='))?.slice('--version='.length) ?? '';
  if (!isManifestVersion(version)) fail(`版本号 ${version || '（没给）'} 不对：用 --version=0.1.0.51 这样的写法`);

  const issuer = (process.env.AMO_JWT_ISSUER ?? '').trim();
  const secret = (process.env.AMO_JWT_SECRET ?? '').trim();
  if (!issuer || !secret) {
    fail(
      `仓库还没有配置 ${!issuer ? 'AMO_JWT_ISSUER' : ''}${!issuer && !secret ? ' 和 ' : ''}${!secret ? 'AMO_JWT_SECRET' : ''}：` +
        '到 https://addons.mozilla.org/developers/addon/api/key/ 拿 JWT issuer 和 JWT secret，' +
        '填进 GitHub 仓库 Settings → Secrets and variables → Actions（名字分别是 AMO_JWT_ISSUER、AMO_JWT_SECRET）。这一版的 Chrome 包和未签名的 .xpi 已经照常发布。',
    );
  }

  const dist = join(root, 'dist-firefox');
  const unsignedPath = join(root, 'release', `tubemuse-${version}-firefox.xpi`);
  if (!existsSync(join(dist, 'manifest.json')) || !existsSync(unsignedPath)) fail(`没有 dist-firefox/ 或 release/tubemuse-${version}-firefox.xpi：先运行 npm run package -- --version=${version}`);
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
  if (manifest.version !== version) fail(`dist-firefox/manifest.json 的版本是 ${manifest.version}，不是 ${version}`);
  const webExt = join(root, 'tools', 'amo', 'node_modules', 'web-ext', 'bin', 'web-ext.js');
  if (!existsSync(webExt)) fail('没有装 web-ext：先运行 npm ci --prefix tools/amo');

  // 测试用：tests/e2e/sign-firefox-mock.mjs 把 web-ext 指向本机的假 AMO。只允许本机回环地址，凭据不会因此被发到别处
  const amoBase = process.env.TUBEMUSE_AMO_BASE_URL;
  if (amoBase && !/^http:\/\/127\.0\.0\.1:\d+\//.test(amoBase)) fail(`TUBEMUSE_AMO_BASE_URL 只能指向本机测试服务（http://127.0.0.1:端口/），拿到的是 ${amoBase}`);

  // web-ext 会在 --source-dir 里记下上一次的上传（.amo-upload-uuid）和自动生成的 ID（.web-extension-id），内容没变时直接沿用旧的上传。
  // 每次都交一份新的：签名前后都清掉，也免得它们留在 dist-firefox/ 里
  const webExtState = ['.amo-upload-uuid', '.web-extension-id'].map((f) => join(dist, f));
  for (const f of webExtState) rmSync(f, { force: true });

  const work = mkdtempSync(join(tmpdir(), 'tubemuse-amo-'));
  try {
    const sha = process.env.RELEASE_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const repo = process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}` : 'https://github.com/Anna-SAP/TubeMuse';
    const source = join(work, `tubemuse-${version}-source.zip`);
    execFileSync('git', ['archive', '--format=zip', '-o', source, sha], { cwd: root });
    const metadata = join(work, 'amo-metadata.json');
    writeFileSync(metadata, JSON.stringify({ version: { approval_notes: approvalNotes(version, sha, repo) } }, null, 2));
    const artifacts = join(work, 'signed');

    console.log(`把 TubeMuse ${version}（Firefox 版）交给 Mozilla 签名（自行分发，不公开上架），最多等 ${APPROVAL_TIMEOUT_MS / 60_000} 分钟…`);
    const run = spawnSync(
      process.execPath,
      [
        webExt,
        'sign',
        '--channel=unlisted',
        `--source-dir=${dist}`,
        `--artifacts-dir=${artifacts}`,
        `--upload-source-code=${source}`,
        `--amo-metadata=${metadata}`,
        `--approval-timeout=${APPROVAL_TIMEOUT_MS}`,
        '--timeout=600000',
        '--no-input',
        '--no-config-discovery',
        ...(amoBase ? [`--amo-base-url=${amoBase}`] : []),
      ],
      { cwd: root, stdio: 'inherit', env: { ...process.env, WEB_EXT_API_KEY: issuer, WEB_EXT_API_SECRET: secret } },
    );
    if (run.status !== 0) {
      fail(
        `web-ext sign 没有成功（退出码 ${run.status}），原因见上面的输出。常见情况：` +
          `① 等签名超时——Mozilla 签完后到 ${AMO_DEVELOPER_HUB} 找到 TubeMuse 的 ${version} 版下载签好的文件，手动上传到这一版的 Release，或者等下一次合并出的新版本；` +
          '② 这个版本号已经提交过（同一版本号在 Mozilla 那边只能提交一次，例如重新运行了这一步）——同样去开发者中心下载；' +
          '③ 校验没通过——按输出里列的问题改，下一版会重新提交；④ 凭据不对——检查 AMO_JWT_ISSUER / AMO_JWT_SECRET。' +
          '这一版的 Chrome 包和未签名的 .xpi 已经照常发布。',
      );
    }
    const files = existsSync(artifacts) ? readdirSync(artifacts).filter((f) => f.endsWith('.xpi')) : [];
    if (files.length !== 1) fail(`web-ext 说签好了，但下载目录里有 ${files.length} 个 .xpi（应该正好 1 个）`);
    const signedPath = join(artifacts, /** @type {string} */ (files[0]));
    let check;
    try {
      check = verifySignedXpi(readFileSync(signedPath), readFileSync(unsignedPath), { version, id: FIREFOX_ADDON_ID });
    } catch (e) {
      fail(`签好的文件没通过核对：${/** @type {Error} */ (e).message}`);
    }
    const out = join(root, 'release', `tubemuse-${version}-firefox-signed.xpi`);
    copyFileSync(signedPath, out);
    console.log(`✔ Mozilla 已签名：release/tubemuse-${version}-firefox-signed.xpi（签名文件：${check.signatureFiles.join(', ')}；其余文件与未签名的 .xpi 逐个相同）`);
    summary(`Firefox 版已由 Mozilla 签名：\`tubemuse-${version}-firefox-signed.xpi\`（可在 Firefox 正式版 / Beta 里永久安装）`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    for (const f of webExtState) rmSync(f, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
