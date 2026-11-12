// @ts-check
// Chrome 安装包冒烟测试（DECISIONS §70）：让真的 Chromium 自己下载、校验、安装 npm run package 打出的 .crx，确认 Chrome 认这个包。
//
// 做法：和企业给员工装扩展一样走策略 ExtensionInstallForcelist——本机起一个小服务器，提供更新清单（updates.xml）和这个 .crx；
// Chromium 按策略去取、校验 CRX3 签名、核对扩展 ID、安装。装上以后核对：扩展 ID 与 .zip 里 manifest 的 key 算出来的一样、
// 版本号对、各页面能渲染、没有报错。签名或 ID 有一点不对，Chromium 都会拒装，这一项就会失败。
//
// 只在 Linux 上跑（CI 的 package 与 release job）：策略文件要写进 Playwright 的 Chromium（Chrome for Testing）读的
// /etc/opt/chrome_for_testing/policies/managed/，CI 里先用 sudo 建好这个目录并交给当前用户。Windows / macOS 上的策略在注册表
// / 描述文件里，而且不在域里的 Windows 不允许从商店以外强制安装，所以不在那里跑。
// Chromium 的代理指向一个不存在的端口：除了本机这个小服务器（回环地址不走代理），它一个请求都出不去。
import { chromium } from 'playwright';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCrx } from '../../scripts/crx.mjs';
import { extensionIdFromPublicKey } from '../../scripts/gen-key.mjs';
import { readZipEntry } from '../../scripts/zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const POLICY_DIR = process.env.CHROME_POLICY_DIR ?? '/etc/opt/chrome_for_testing/policies/managed';
const POLICY_FILE = join(POLICY_DIR, 'tubemuse-crx-smoke.json');

let failures = 0;
/** @param {boolean} cond @param {string} msg */
function check(cond, msg) {
  console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`);
  if (!cond) failures++;
}
/** @param {string} msg @returns {never} */
function stop(msg) {
  console.error(`✘ ${msg}`);
  process.exit(2);
}

if (process.platform !== 'linux') stop('这个冒烟测试只在 Linux 上跑（靠 Chromium 的策略文件强制安装）。');
const releaseDir = join(root, 'release');
const arg = process.argv[2];
const crxFiles = arg ? [arg] : existsSync(releaseDir) ? readdirSync(releaseDir).filter((f) => /^tubemuse-.*-chrome\.crx$/.test(f)).map((f) => join(releaseDir, f)) : [];
if (crxFiles.length !== 1) stop(`release/ 里要正好有一个 tubemuse-*-chrome.crx（现在 ${crxFiles.length} 个）：先运行 npm run package`);
const crxPath = /** @type {string} */ (crxFiles[0]);
try {
  writeFileSync(POLICY_FILE, '{}');
} catch {
  stop(`写不了 ${POLICY_FILE}：先建好目录并交给当前用户（sudo mkdir -p ${POLICY_DIR} && sudo chown "$USER" ${POLICY_DIR}）`);
}

const crxBytes = readFileSync(crxPath);
const crx = readCrx(crxBytes);
const manifest = JSON.parse(String(readZipEntry(crx.zip, 'manifest.json')));
check(extensionIdFromPublicKey(manifest.key) === crx.id, `.crx 的签名与里面 manifest 的 key 是同一把密钥：扩展 ID ${crx.id}`);

/** @type {string[]} */
const served = [];
const server = createServer((req, res) => {
  const url = req.url ?? '';
  served.push(url);
  if (url.startsWith('/updates.xml')) {
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(
      `<?xml version='1.0' encoding='UTF-8'?>\n<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>` +
        `<app appid='${crx.id}'><updatecheck codebase='http://127.0.0.1:${port()}/tubemuse.crx' version='${manifest.version}' /></app></gupdate>\n`,
    );
  } else if (url === '/tubemuse.crx') {
    res.writeHead(200, { 'content-type': 'application/x-chrome-extension', 'content-length': crxBytes.length });
    res.end(crxBytes);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
function port() {
  const a = server.address();
  return a && typeof a === 'object' ? a.port : 0;
}
// DeveloperToolsAvailability: 1 —— 这条策略默认"不许对策略强制安装的扩展用开发者工具"，Playwright 正是通过开发者工具协议驱动浏览器的：
// Chrome 156 起，不放开它时扩展自己的页面 Playwright 一个都连不上（设置页明明开着却看不到，打开扩展页面报"页面已关闭"；
// 本机和 GitHub 的 runner 上都实际碰到过）。只放开这个临时配置里的测试，和安装、校验 .crx 无关。
writeFileSync(POLICY_FILE, JSON.stringify({ ExtensionInstallForcelist: [`${crx.id};http://127.0.0.1:${port()}/updates.xml`], DeveloperToolsAvailability: 1 }));

const userDataDir = mkdtempSync(join(tmpdir(), 'tubemuse-crx-'));
/** @type {import('playwright').BrowserContext | undefined} */
let context;
/** @type {string[]} */
const errors = [];
try {
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    // 默认参数里的 --disable-extensions 会连策略装的扩展一起禁掉；--disable-background-networking 会让 Chromium 不去取更新清单
    ignoreDefaultArgs: ['--disable-extensions', '--disable-background-networking'],
    args: ['--no-first-run', '--proxy-server=http://127.0.0.1:9'],
  });
  // 等 Chromium 把它装进配置目录（策略生效后几秒内）
  const installed = join(userDataDir, 'Default', 'Extensions', crx.id);
  const deadline = Date.now() + 60_000;
  while (!existsSync(installed) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  check(served.some((u) => u.startsWith('/updates.xml') && u.includes(crx.id)), `Chromium 按策略来取了更新清单${served.length ? '' : '（一个请求都没来：策略没有生效，检查策略目录）'}`);
  check(served.includes('/tubemuse.crx'), 'Chromium 下载了这个 .crx');
  check(existsSync(installed) && readdirSync(installed).includes(`${manifest.version}_0`), `Chromium 校验通过并安装了它（版本 ${manifest.version}）`);
  if (existsSync(installed)) {
    // 首次安装时扩展的后台（service worker）会调用 runtime.openOptionsPage()，当前是空白标签页时 Chromium 用设置页替换它。
    // 先等设置页出现：这说明装上的扩展后台确实跑起来了；后台什么时候起来不固定，等它出现后再开下面的页面，免得自己的页面被替换掉。
    const optionsUrl = `chrome-extension://${crx.id}/options.html`;
    const optionsDeadline = Date.now() + 60_000;
    while (!context.pages().some((p) => p.url() === optionsUrl) && Date.now() < optionsDeadline) await new Promise((r) => setTimeout(r, 250));
    check(
      context.pages().some((p) => p.url() === optionsUrl),
      `扩展的后台跑起来了：首次安装时自己打开了设置页${context.pages().some((p) => p.url() === optionsUrl) ? '' : `（60 秒内没有出现；现在的页面：${context.pages().map((p) => p.url()).join(', ')}）`}`,
    );
    for (const page of ['sidepanel.html', 'options.html']) {
      const p = await context.newPage();
      p.on('console', (m) => m.type() === 'error' && errors.push(`${page}: ${m.text()}`));
      p.on('pageerror', (e) => errors.push(`${page}: ${e.message}`));
      await p.goto(`chrome-extension://${crx.id}/${page}`);
      await p.waitForTimeout(800);
      const text = (await p.locator('body').textContent()) ?? '';
      check(text.trim().length > 20, `${page} 正常渲染`);
      if (page === 'sidepanel.html') {
        const info = await p.evaluate(() => {
          const c = /** @type {any} */ (globalThis).chrome;
          return { id: c.runtime.id, version: c.runtime.getManifest().version, key: c.runtime.getManifest().key };
        });
        check(info.id === crx.id, `装上后的扩展 ID 是 ${info.id}`);
        check(info.version === manifest.version, `装上后的版本号是 ${info.version}`);
        check(info.key === crx.publicKey, '装上后 manifest 的 key 就是签名用的公钥（加载 .zip 得到的也是这个 ID）');
      }
      await p.close();
    }
  }
} catch (e) {
  failures++;
  console.error('✘ .crx 冒烟测试异常：', e);
} finally {
  rmSync(POLICY_FILE, { force: true });
  await Promise.race([context?.close(), new Promise((r) => setTimeout(r, 10_000))]);
  server.close();
  rmSync(userDataDir, { recursive: true, force: true });
}
check(errors.length === 0, `没有控制台错误${errors.length ? `：\n    ${errors.join('\n    ')}` : ''}`);
console.log(failures ? `\n✘ .crx 冒烟测试失败 ${failures} 项` : '\n✔ .crx 冒烟测试通过：Chromium 认这个安装包');
process.exit(failures ? 1 : 0);
