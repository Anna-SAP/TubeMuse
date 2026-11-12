// @ts-check
// Firefox 正式版安装包冒烟测试（DECISIONS §69）：把 npm run build:firefox 打出的 release/*.xpi 以"临时附加组件"装进真的 Firefox
// （和 about:debugging →「临时载入附加组件…」选这个文件是同一条路），确认 manifest / CSP 被接受、各页面能渲染、
// 打开页面时扩展不发出任何网络请求。Firefox 的代理指向本机一个只记录、不转发的端口：谁想出网都看得见，也都出不去。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIREFOX_ADDON_ID, firefoxRedirectUrl } from '../../../scripts/firefox.mjs';
import { Browser, Marionette, launchFirefox } from './marionette.mjs';
import { findFirefox } from './find-firefox.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const xpi = join(root, 'release', `tubemuse-${pkg.version}-firefox.xpi`);
const UUID = '7e57f1fe-0000-4000-8000-00000000f0f0';
const EXT = `moz-extension://${UUID}`;
const MARIONETTE_PORT = 28_391;

let failures = 0;
/** @param {boolean} cond @param {string} msg */
function check(cond, msg) {
  console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`);
  if (!cond) failures++;
}

const binary = findFirefox(root);
if (!binary) {
  console.error('✘ 没找到 Firefox。装一个 Firefox（149 或更新），或用环境变量 FIREFOX_BIN 指向它的可执行文件。');
  process.exit(2);
}
if (!existsSync(xpi)) {
  console.error(`✘ 没有 ${xpi}：先运行 npm run build:firefox`);
  process.exit(2);
}

// 只记录、不转发的"代理"：记下每个想出去的连接（CONNECT 主机 / 明文请求的地址），然后断开
/** @type {string[]} */
const attempts = [];
const trap = net.createServer((sock) => {
  sock.once('data', (d) => {
    const line = d.toString().split('\r\n')[0] ?? '';
    attempts.push(line.replace(/ HTTP\/1\.[01]$/, ''));
    sock.destroy();
  });
  sock.on('error', () => undefined);
});
await new Promise((r) => trap.listen(0, '127.0.0.1', () => r(undefined)));
const trapPort = /** @type {net.AddressInfo} */ (trap.address()).port;

const work = mkdtempSync(join(tmpdir(), 'tubemuse-ffsmoke-'));
const { proc, log } = launchFirefox({
  binary,
  profileDir: join(work, 'profile'),
  port: MARIONETTE_PORT,
  prefs: {
    'extensions.webextensions.uuids': JSON.stringify({ [FIREFOX_ADDON_ID]: UUID }),
    'network.proxy.type': 1,
    'network.proxy.http': '127.0.0.1',
    'network.proxy.http_port': trapPort,
    'network.proxy.ssl': '127.0.0.1',
    'network.proxy.ssl_port': trapPort,
    'network.proxy.share_proxy_settings': true,
    'network.proxy.allow_hijacking_localhost': false,
    'app.update.disabledForTesting': true,
    'app.normandy.enabled': false,
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.startup.page': 0,
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.enabled': false,
    'browser.safebrowsing.malware.enabled': false,
    'browser.safebrowsing.phishing.enabled': false,
    'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false,
    'extensions.update.enabled': false,
    'extensions.getAddons.cache.enabled': false,
    'devtools.console.stdout.content': true,
    'devtools.console.stdout.chrome': true,
  },
});

const m = /** @type {Marionette} */ (await Marionette.connect(MARIONETTE_PORT));
const b = new Browser(m);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
try {
  await b.start();
  const id = await b.installTemporary(xpi);
  check(id === FIREFOX_ADDON_ID, `正式版安装包（${xpi.slice(root.length + 1)}）以临时附加组件装上：${id}`);
  let options = '';
  for (const end = Date.now() + 15_000; !options && Date.now() < end; await sleep(300)) {
    for (const h of await b.handles()) {
      await b.switchTo(h);
      if ((await b.url()).startsWith(`${EXT}/options.html`)) options = h;
    }
  }
  check(!!options, '首次安装自动打开设置页（后台事件页正常启动）');
  if (!options) throw new Error('设置页没有打开');
  await b.waitFor(`document.querySelector('#llm')`, { what: '设置页渲染' });
  const manifest = await b.run(`return browser.runtime.getManifest();`);
  const scripts = manifest.content_scripts.map((/** @type {any} */ c) => ({ js: c.js.map((/** @type {string} */ j) => j.split('/').pop()).join(','), matches: c.matches.join(','), world: c.world ?? 'ISOLATED' }));
  check(
    JSON.stringify(scripts) ===
      JSON.stringify([
        { js: 'content-tracker.js', matches: 'https://www.youtube.com/*', world: 'ISOLATED' },
        { js: 'content-subtitles.js', matches: 'https://www.youtube.com/*', world: 'ISOLATED' },
        { js: 'content-clipper.js', matches: 'https://www.youtube.com/*,https://www.xiaohongshu.com/*,https://www.rednote.com/*,https://x.com/*,https://www.kubb.tv/*,https://www.instagram.com/*,https://www.douyin.com/*,https://www.bilibili.com/*', world: 'ISOLATED' },
        { js: 'content-multicc-bridge.js', matches: 'https://www.youtube.com/*', world: 'MAIN' },
        { js: 'content-multicc.js', matches: 'https://www.youtube.com/*', world: 'ISOLATED' },
        { js: 'content-xhs-bridge.js', matches: 'https://www.xiaohongshu.com/*,https://www.rednote.com/*', world: 'MAIN' },
        { js: 'content-xhs.js', matches: 'https://www.xiaohongshu.com/*,https://www.rednote.com/*', world: 'ISOLATED' },
        { js: 'content-email.js', matches: 'https://mail.google.com/*', world: 'ISOLATED' },
      ]),
    '内容脚本与 Chrome 版完全相同：注入的站点、两个页面内助手在页面环境（MAIN）',
  );
  check(JSON.stringify([...manifest.permissions].sort()) === JSON.stringify(['alarms', 'identity', 'storage', 'unlimitedStorage']), `权限最小化：${manifest.permissions.join(', ')}`);
  check(!manifest.web_accessible_resources, '没有向网页暴露任何扩展文件');
  const csp = String(manifest.content_security_policy?.extension_pages ?? '');
  const connect = /connect-src ([^;]+)/.exec(csp)?.[1]?.trim().split(/\s+/) ?? [];
  const expected = ['https://www.googleapis.com', 'https://oauth2.googleapis.com', 'https://api.anthropic.com', 'https://api.openai.com', 'https://api.x.com', 'https://www.douban.com'];
  check(JSON.stringify([...connect].sort()) === JSON.stringify([...expected].sort()), `CSP 生效，网络出口白名单与 Chrome 版相同：${connect.join(' ')}`);
  check(JSON.stringify([...manifest.host_permissions].sort()) === JSON.stringify(expected.map((o) => `${o}/*`).sort()), 'host_permissions 与 connect-src 一致');
  check(['toggle-subtitles', 'toggle-multi-captions', 'toggle-clip-recording'].every((c) => manifest.commands?.[c]), '三个快捷键都在');
  check((await b.exec(`return document.querySelector('[data-testid=redirect-url]')?.textContent`)) === firefoxRedirectUrl(FIREFOX_ADDON_ID), `设置页显示 Firefox 的授权回跳地址：${firefoxRedirectUrl(FIREFOX_ADDON_ID)}`);
  const builtIn = !(await b.exec(`return !!document.querySelector('[data-testid=google-client-id]')`));
  check(true, builtIn ? '安装包带着 OAuth Client ID（来自 local/config.json）' : '安装包没带 OAuth Client ID：设置页有填写它的输入框');

  for (const page of ['sidepanel.html', 'mic-permission.html']) {
    await b.goto(`${EXT}/${page}`);
    await sleep(800);
    const text = String(await b.exec(`return document.body.textContent`));
    check(text.trim().length > 20, `${page} 正常渲染`);
    if (page === 'mic-permission.html') check(text.includes('Firefox') && text.includes('记住此决定'), '麦克风授权页按 Firefox 说明（勾"记住此决定"）');
    if (page === 'sidepanel.html') {
      check(text.includes('配置 Google OAuth 客户端') || text.includes('连接 YouTube'), '未配置时侧边栏提示下一步该做什么');
      check(await b.exec(`const img = document.querySelector('[data-testid=muse-ask] img'); return !!img && img.complete && img.naturalWidth > 0;`), '「问 muse」按钮上的图加载出来了');
      await b.exec(`document.querySelector('[data-testid=muse-ask]').click(); return true;`);
      await b.waitFor(`document.querySelector('[data-testid=muse-error]')`, { what: '问 muse 的说明' });
      check((await b.exec(`return document.querySelectorAll('[data-testid=muse-package]').length`)) === 0, '当前标签页不是视频页时「问 muse」只说明原因');
    }
  }
  await sleep(1500);
} catch (e) {
  failures++;
  console.error('✘ Firefox 冒烟测试异常：', e);
} finally {
  await m.send('Marionette:Quit').catch(() => undefined);
  m.close();
  await sleep(500);
  proc.kill();
  trap.close();
  rmSync(work, { recursive: true, force: true });
}
// Firefox 自己也会联网（例如查询本机语音模型时问 model-hub.mozilla.org）：只要不是扩展的出口、不是别的第三方，就不算
const mozilla = /(^|\.)(mozilla\.(org|com|net)|firefox\.com|mozaws\.net|mozgcp\.net)(:\d+)?$/;
const hosts = attempts.map((a) => a.replace(/^CONNECT /, '').replace(/^\w+ https?:\/\/([^/]+).*$/, '$1'));
check(hosts.every((h) => mozilla.test(h.replace(/:\d+$/, ''))), `打开页面时扩展没有发出任何网络请求${hosts.length ? `（Firefox 自己连了：${[...new Set(hosts)].join(', ')}）` : ''}`);
const extErrors = log.filter((l) => /JavaScript error|console\.error|Uncaught/.test(l) && l.includes(UUID));
check(extErrors.length === 0, `没有扩展报错${extErrors.length ? `：\n    ${extErrors.slice(0, 10).join('\n    ')}` : ''}`);
console.log(failures ? `\n✘ Firefox 正式版冒烟测试失败 ${failures} 项` : '\n✔ Firefox 正式版冒烟测试通过');
process.exit(failures ? 1 : 0);
