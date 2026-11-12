// @ts-check
// 打发布用的安装包（DECISIONS §70）。发布工作流（.github/workflows/release.yml）和 CI 都跑它，本机也能跑。
//   npm run package                   → 版本号用 package.json 的
//   npm run package -- --build=137    → 版本号 <package.json 的版本>.137（发布时第四段是 main 上的提交数）
//   npm run package -- --version=1.2.3.4
// 产物都在 release/：
//   tubemuse-<版本>-chrome.zip   Chrome：解压后"加载已解压的扩展程序"（Windows / macOS 上装 Chrome 版走这条）
//   tubemuse-<版本>-chrome.crx   Chrome：同一个 zip，用 local/extension-key.pem 签名（CRX3）
//   tubemuse-<版本>-firefox.xpi  Firefox：about:debugging 临时载入
//   release-notes.md             发布页上的安装说明（不是下载文件）
// 需要 local/manifest-key.txt 与 local/extension-key.pem 是同一对密钥（npm run setup 生成；发布时由 scripts/release-key.mjs 从 Secret 写出）。
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestKeyOf, packCrx, readCrx } from './crx.mjs';
import { FIREFOX_ADDON_ID, firefoxRedirectUrl } from './firefox.mjs';
import { extensionIdFromPublicKey } from './gen-key.mjs';
import { isManifestVersion, releaseVersion } from './version.mjs';
import { zipDirectory } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(root, 'release');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** @param {string} msg @returns {never} */
function fail(msg) {
  console.error(`\n打包失败：${msg}\n`);
  process.exit(1);
}

/** @param {string} name */
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

let version = String(pkg.version);
const buildArg = arg('build');
const versionArg = arg('version');
if (buildArg !== undefined && versionArg !== undefined) fail('--build 和 --version 只能给一个');
try {
  if (buildArg !== undefined) version = releaseVersion(version, Number(buildArg));
} catch (e) {
  fail(/** @type {Error} */ (e).message);
}
if (versionArg !== undefined) version = versionArg;
if (!isManifestVersion(version)) fail(`版本号 ${version} 不能用作扩展版本（1–4 段整数，每段 0–65535，不带前导 0）`);

// ── 密钥：签名用的私钥必须和 manifest 里的 key 是同一对，否则 .crx 装上后的扩展 ID 和 .zip 的不一样 ──
const pubPath = join(root, 'local', 'manifest-key.txt');
const pemPath = join(root, 'local', 'extension-key.pem');
if (!existsSync(pubPath) || !existsSync(pemPath)) fail('缺少 local/manifest-key.txt 或 local/extension-key.pem。先运行 npm run setup（发布工作流里由 scripts/release-key.mjs 从 Secret 写出）。');
const manifestKey = readFileSync(pubPath, 'utf8').trim();
const pem = readFileSync(pemPath, 'utf8');
let pemKey;
try {
  pemKey = manifestKeyOf(pem);
} catch {
  fail('local/extension-key.pem 读不出私钥。');
}
if (pemKey !== manifestKey) fail('local/extension-key.pem 和 local/manifest-key.txt 不是同一对密钥：签出来的 .crx 会和 manifest 里的扩展 ID 对不上。');
const extensionId = extensionIdFromPublicKey(manifestKey);

// ── 清掉上一次的产物（只删本脚本会生成的文件），免得旧版本被一起发布 ──
mkdirSync(releaseDir, { recursive: true });
for (const f of readdirSync(releaseDir)) {
  if (/^tubemuse-.*\.(zip|crx|xpi)$/.test(f) || f === 'release-notes.md') rmSync(join(releaseDir, f));
}

/** @param {string[]} args */
function build(args) {
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs'), ...args, `--version=${version}`], { stdio: 'inherit', cwd: root });
  } catch {
    fail(`构建没有成功（node scripts/build.mjs ${args.join(' ')} --version=${version}），原因见上面的输出。`);
  }
}

// ── Chrome：dist/ → zip → crx ──
build([]);
const dist = join(root, 'dist');
const chromeManifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (chromeManifest.version !== version) fail(`dist/manifest.json 的版本是 ${chromeManifest.version}，不是 ${version}`);
if (chromeManifest.key !== manifestKey) fail('dist/manifest.json 的 key 不是 local/manifest-key.txt 里的公钥');
const zipPath = join(releaseDir, `tubemuse-${version}-chrome.zip`);
zipDirectory(dist, zipPath);
const zip = readFileSync(zipPath);
const crxPath = join(releaseDir, `tubemuse-${version}-chrome.crx`);
writeFileSync(crxPath, packCrx(zip, pem));

// 按 Chrome 的规则把刚打的 .crx 读回来校验一遍：签名对、扩展 ID 和 manifest 的 key 算出来的一样、里面就是那个 zip
let crx;
try {
  crx = readCrx(readFileSync(crxPath));
} catch (e) {
  fail(`刚打的 .crx 校验不通过：${/** @type {Error} */ (e).message}`);
}
if (crx.id !== extensionId) fail(`.crx 的扩展 ID 是 ${crx.id}，manifest 的 key 对应的是 ${extensionId}`);
if (crx.publicKey !== manifestKey) fail('.crx 的签名公钥和 manifest 的 key 不一样');
if (!crx.zip.equals(zip)) fail('.crx 里的内容和 .zip 不一样');

// ── Firefox：dist-firefox/ → xpi（build.mjs 自己打包） ──
build(['--firefox']);
const ffManifest = JSON.parse(readFileSync(join(root, 'dist-firefox', 'manifest.json'), 'utf8'));
if (ffManifest.version !== version) fail(`dist-firefox/manifest.json 的版本是 ${ffManifest.version}，不是 ${version}`);
const xpiPath = join(releaseDir, `tubemuse-${version}-firefox.xpi`);
if (!existsSync(xpiPath)) fail(`没有生成 ${relative(root, xpiPath)}`);

// ── 发布页上的说明 ──
const config = join(root, 'local', 'config.json');
const clientId = existsSync(config) ? String(JSON.parse(readFileSync(config, 'utf8')).oauthClientId ?? '').trim() : '';
const repo = process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}` : 'https://github.com/Anna-SAP/TubeMuse';
let sha = process.env.RELEASE_SHA ?? '';
if (!sha) {
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    sha = '';
  }
}
const zipName = relative(releaseDir, zipPath);
const crxName = relative(releaseDir, crxPath);
const xpiName = relative(releaseDir, xpiPath);
const notes = [
  `**TubeMuse ${version}**${sha ? ` · 来自 \`main\` 的提交 [${sha.slice(0, 7)}](${repo}/commit/${sha})` : ''}`,
  '',
  '### 下载哪个',
  '',
  '| 文件 | 浏览器 | 怎么装 |',
  '|---|---|---|',
  `| **\`${zipName}\`** | Chrome 或其他 Chromium 内核浏览器（**推荐**） | 解压到一个固定的文件夹 → 打开 \`chrome://extensions\` → 右上角打开「开发者模式」→「加载已解压的扩展程序」→ 选解压出来的文件夹（里面直接就是 \`manifest.json\`）。装好后不要移动或删除这个文件夹 |`,
  `| \`${crxName}\` | Chrome（签过名的安装包） | **Windows / macOS 上的正式版 Chrome 不允许安装 Chrome 应用商店以外的 .crx**（拖进 \`chrome://extensions\` 会被拒绝或装上后被停用，常见报错 \`CRX_REQUIRED_PROOF_MISSING\`），请用上面的 .zip。用企业策略（ExtensionInstallForcelist）部署时可以用它（发布前的自动化测试走的就是这条路） |`,
  `| **\`${xpiName}\`** | Firefox 149 及以上 | 打开 \`about:debugging#/runtime/this-firefox\` →「临时载入附加组件…」→ 选这个文件。重启 Firefox 后要重新载入一次（本机数据还在） |`,
  '',
  '### 装好以后',
  '',
  `- **Chrome 扩展 ID**：\`${extensionId}\`，授权回跳地址 \`https://${extensionId}.chromiumapp.org/\`。和你本机 \`npm run setup\` 打印的一样时，Google Cloud 里什么都不用改。`,
  `- **Firefox 扩展 ID**：\`${FIREFOX_ADDON_ID}\`，授权回跳地址 \`${firefoxRedirectUrl(FIREFOX_ADDON_ID)}\`。`,
  clientId
    ? `- 安装包里带着 OAuth Client ID \`${clientId}\`。`
    : '- 安装包里**没有带 OAuth Client ID**：第一次装好后，在设置页「2. YouTube 账号」的 **OAuth Client ID** 框里填一次（和 Client Secret 一样只存在本机），再点"连接 YouTube"。',
  '- **更新**：Chrome 把新的 .zip 解压**覆盖到同一个文件夹**，再在 `chrome://extensions` 点 TubeMuse 卡片上的刷新按钮，本机数据保留；Firefox 重新临时载入新的 .xpi。',
  '',
  `完整说明见 README 的 [安装](${repo}#install) 与 [在 Firefox 里使用](${repo}#firefox)。`,
  '',
].join('\n');
writeFileSync(join(releaseDir, 'release-notes.md'), notes);

// 在 GitHub Actions 里把版本号交给后面的步骤（发布时用它起标签名）
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);

console.log(`\n✔ 已打包 TubeMuse ${version}（release/）`);
for (const p of [zipPath, crxPath, xpiPath]) console.log(`  ${relative(root, p)}（${(statSync(p).size / 1024).toFixed(0)} KB）`);
console.log(`  Chrome 扩展 ID：${extensionId}（.crx 的签名与 .zip 里 manifest 的 key 是同一把密钥）`);
console.log(`  Firefox 扩展 ID：${FIREFOX_ADDON_ID}`);
