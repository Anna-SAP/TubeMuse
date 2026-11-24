// @ts-check
// Firefox 版的端到端测试（DECISIONS §69）：在真的 Firefox 里以"临时附加组件"装上 dist-firefox-e2e/，
// 用本机 mock 服务把两个浏览器差别所在的地方都真的跑一遍——后台事件页、侧边栏页面、Firefox 的授权回跳、
// 设置页填 Client ID、网站权限、captureStream / MediaRecorder（Firefox 只能录 WebM）、下载、剪贴板、
// 页面环境（MAIN）助手与内容脚本的通话、内容脚本的同源 fetch、语音识别的说法。Chrome 版的完整流程仍由 tests/e2e/run-e2e.mjs 覆盖。
//
//   npm run e2e:firefox        （先构建 dist-firefox-e2e/）
// 要一个 Firefox（149 或更新）：环境变量 FIREFOX_BIN 指定，或按常见安装位置去找（见 findFirefox）。
// 网络：Firefox 的代理指向一个不存在的端口，除本机 mock 以外的请求一律出不去（测试中不发出真实网络请求）。
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FIREFOX_E2E_ADDON_ID, firefoxRedirectUrl } from '../../../scripts/firefox.mjs';
import { E2E_CLIENT_SECRET, PORT, dubTranscribes, startMockServer } from '../mock-server.mjs';
import { findFirefox } from './find-firefox.mjs';
import { Browser, Marionette, launchFirefox } from './marionette.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const extDir = join(root, 'dist-firefox-e2e');
const shots = join(root, 'test-results', 'e2e-firefox');
const MOCK = `http://127.0.0.1:${PORT}`;
const UUID = '7e57f1fe-0000-4000-8000-00000000e2e0';
const EXT = `moz-extension://${UUID}`;
const FAKE_KEY = 'e2e-anthropic-test-key-not-real';
const CLIENT_ID = 'e2e-firefox-client.apps.googleusercontent.com';
const MARIONETTE_PORT = 28_291;

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
if (!existsSync(join(extDir, 'manifest.json'))) {
  console.error('✘ 没有 dist-firefox-e2e/：先运行 npm run build:firefox-e2e');
  process.exit(2);
}
const version = spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim();
console.log(`Firefox：${version}（${binary}）`);

rmSync(shots, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'tubemuse-ff-'));
const downloads = join(work, 'downloads');
mkdirSync(downloads, { recursive: true });

const { server, requests } = /** @type {{ server: import('node:http').Server; requests: any[] }} */ (await startMockServer());
const { proc, log } = launchFirefox({
  binary,
  profileDir: join(work, 'profile'),
  port: MARIONETTE_PORT,
  prefs: {
    // 扩展页面的地址固定下来（moz-extension://<UUID>/），测试才能直接打开侧边栏页面
    'extensions.webextensions.uuids': JSON.stringify({ [FIREFOX_E2E_ADDON_ID]: UUID }),
    // 网络护栏：除本机（Firefox 从不经代理访问 127.0.0.1）外全部走一个不存在的代理，出不去
    'network.proxy.type': 1,
    'network.proxy.http': '127.0.0.1',
    'network.proxy.http_port': 9,
    'network.proxy.ssl': '127.0.0.1',
    'network.proxy.ssl_port': 9,
    'network.proxy.share_proxy_settings': true,
    'network.proxy.allow_hijacking_localhost': false,
    // Firefox 自己的后台联网：关掉
    'app.update.disabledForTesting': true,
    'app.normandy.enabled': false,
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.startup.page': 0,
    'browser.aboutwelcome.enabled': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'datareporting.healthreport.uploadEnabled': false,
    'toolkit.telemetry.enabled': false,
    'browser.safebrowsing.malware.enabled': false,
    'browser.safebrowsing.phishing.enabled': false,
    'browser.safebrowsing.downloads.enabled': false,
    'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false,
    'extensions.update.enabled': false,
    'extensions.getAddons.cache.enabled': false,
    'extensions.blocklist.enabled': false,
    // 下载直接存进测试目录，不弹窗
    'browser.download.folderList': 2,
    'browser.download.dir': downloads,
    'browser.download.useDownloadDir': true,
    'browser.download.always_ask_before_handling_new_types': false,
    'browser.download.start_downloads_in_tmp_dir': false,
    'browser.download.alwaysOpenPanel': false,
    // 剪贴板：测试里没有真人点击，跳过"刚被点过才能写 / 读"的检查（真实使用时 Capture 本来就是你点的）
    'dom.events.testing.asyncClipboard': true,
    // 视频自动播放（mock 播放页由测试来点播放）
    'media.autoplay.default': 0,
    'media.autoplay.blocking_policy': 0,
    // 页面与扩展的报错打到标准输出，测试结束时检查
    'devtools.console.stdout.content': true,
    'devtools.console.stdout.chrome': true,
  },
});

const m = /** @type {Marionette} */ (await Marionette.connect(MARIONETTE_PORT));
const b = new Browser(m);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** 下载目录里完整写好的文件（不含 .part） */
const downloaded = () => readdirSync(downloads).filter((f) => !f.endsWith('.part') && statSync(join(downloads, f)).size > 0);
/** 等下载目录里多出一个文件 @param {string[]} before @param {RegExp} re */
async function waitDownload(before, re, timeout = 20_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const f = downloaded().find((x) => !before.includes(x) && re.test(x));
    if (f) {
      // 等它写完（大小不再变）
      let size = -1;
      for (;;) {
        const s = statSync(join(downloads, f)).size;
        if (s === size) return f;
        size = s;
        await sleep(300);
      }
    }
    if (Date.now() > end) throw new Error(`等不到下载：${re}（下载目录：${downloaded().join(', ') || '空'}）`);
    await sleep(250);
  }
}

let handles = { options: '', panel: '' };
/** 在侧边栏页面里点按钮：用页面自己的 click()，不把侧边栏切到前台（否则"当前标签页"就成了它自己） @param {string} css */
const tap = (css) => b.exec(`const el = document.querySelector(arguments[0]); if (!el) throw new Error('找不到 ' + arguments[0]); el.click(); return true;`, [css]);
/** 按文字找按钮再点 @param {string} text */
const tapText = (text, scope = 'button') =>
  b.exec(`const el = [...document.querySelectorAll(arguments[1])].find((e) => e.textContent.trim() === arguments[0] || e.textContent.includes(arguments[0])); if (!el) throw new Error('找不到按钮 ' + arguments[0]); el.click(); return true;`, [text, scope]);
const text = (/** @type {string} */ css) => b.exec(`return document.querySelector(arguments[0])?.textContent ?? null;`, [css]);
/** Preact 的受控输入框：改 value 后发 input 事件 @param {string} css @param {string} value */
const fill = (css, value) =>
  b.exec(
    `const el = document.querySelector(arguments[0]); if (!el) throw new Error('找不到 ' + arguments[0]);
     const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
     Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, arguments[1]);
     el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true;`,
    [css, value],
  );
/**
 * 对 mock 站点拦住 / 放开没点过的页面的声音（Firefox 的"自动播放"网站权限，设成"阻止音频和视频"）：
 * 拦着时，没被真的点过的页面里 AudioContext 一直起不来（实测等 3 秒仍是 suspended），点过之后 30 毫秒内起来。
 * 权限同步到页面所在的进程要一小会儿。
 * @param {boolean} blocked
 */
const setMockAutoplayBlocked = async (blocked) => {
  await b.chrome(
    `const p = Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(arguments[0]), {});
     if (arguments[1]) Services.perms.addFromPrincipal(p, 'autoplay-media', Ci.nsIAutoplay.BLOCKED_ALL);
     else Services.perms.removeFromPrincipal(p, 'autoplay-media');
     return true;`,
    [MOCK, blocked],
  );
  await new Promise((r) => setTimeout(r, 300));
};
/** 从侧边栏打开一个前台标签页，返回它的句柄（侧边栏跟踪的就是这个"当前标签页"） @param {string} url */
async function openActiveTab(url) {
  await b.switchTo(handles.panel);
  const before = await b.handles();
  await b.run(`await browser.tabs.create({ url: args[0], active: true });`, [url]);
  const end = Date.now() + 10_000;
  for (;;) {
    const h = (await b.handles()).find((x) => !before.includes(x));
    if (h) return h;
    if (Date.now() > end) throw new Error(`新标签页没出现：${url}`);
    await sleep(200);
  }
}
/** 关掉一个标签页（不切换前台） @param {string} handle */
async function closeTab(handle) {
  await b.switchTo(handle);
  await m.send('WebDriver:CloseWindow');
  await b.switchTo(handles.panel);
}

try {
  await b.start();
  console.log('\n[安装：about:debugging 的"临时载入附加组件"同一条路]');
  const id = await b.installTemporary(extDir);
  check(id === FIREFOX_E2E_ADDON_ID, `以临时附加组件装上：${id}`);

  // 首次安装时后台打开设置页（options_ui 在新标签页）
  const end = Date.now() + 15_000;
  while (!handles.options && Date.now() < end) {
    for (const h of await b.handles()) {
      await b.switchTo(h);
      if ((await b.url()).startsWith(`${EXT}/options.html`)) handles.options = h;
    }
    if (!handles.options) await sleep(300);
  }
  check(!!handles.options, '首次安装自动在新标签页打开设置页：后台事件页启动了');
  if (!handles.options) throw new Error('设置页没有打开：后台脚本可能没能运行');
  await b.switchTo(handles.options);
  await b.waitFor(`document.querySelector('#llm')`, { what: '设置页渲染' });

  console.log('\n[manifest 与后台]');
  const manifest = await b.run(`return browser.runtime.getManifest();`);
  check(
    manifest.browser_specific_settings?.gecko?.id === FIREFOX_E2E_ADDON_ID && !manifest.key && !manifest.side_panel && !manifest.minimum_chrome_version,
    'Firefox 版 manifest：固定的 gecko.id，没有 Chrome 专有的 key / side_panel / minimum_chrome_version',
  );
  check(
    String(manifest.sidebar_action?.default_panel).endsWith('/sidepanel.html') &&
      manifest.background?.scripts?.length === 1 &&
      String(manifest.background.scripts[0]).endsWith('/background.js') &&
      manifest.background?.type === 'module' &&
      !manifest.background?.service_worker,
    '侧边栏是 sidebar_action；后台是事件页（ES 模块），不是 service worker',
  );
  check(JSON.stringify([...manifest.permissions].sort()) === JSON.stringify(['activeTab', 'alarms', 'contextMenus', 'identity', 'scripting', 'storage', 'unlimitedStorage']), `权限：${manifest.permissions.join(', ')}（不需要 sidePanel，也没有 downloads / clipboardWrite / tabs；scripting、activeTab、contextMenus 只给「故事」，DECISIONS §88）`);
  const alarms = await b.waitFor(`return browser.alarms.getAll().then((a) => a.length >= 2 ? a.map((x) => x.name).sort() : false)`, { what: '后台建好闹钟' }).catch(() => []);
  check(JSON.stringify(alarms) === JSON.stringify(['tubemuse-daily', 'tubemuse-tick']), `后台建好了例行闹钟与每日总结闹钟（Firefox 不认 persistAcrossSessions，带上会建不起来）：${alarms}`);
  const origins = [...new Set([...manifest.host_permissions, ...manifest.content_scripts.flatMap((/** @type {any} */ c) => c.matches)])];
  const granted = await b.run(`return Promise.all(args[0].map((o) => browser.permissions.contains({ origins: [o] })));`, [origins]);
  check(granted.every(Boolean), `manifest 里要的 ${origins.length} 个网站都已获准（Firefox 127 起安装时默认给）`);
  check((await b.exec(`return document.querySelectorAll('[data-testid=host-access]').length`)) === 0, '网站权限齐全时设置页不显示"缺权限"横幅');

  console.log('\n[网站权限被收回 → 横幅写明缺哪些、会影响什么；授权回来后横幅消失]');
  // Firefox 的匹配规则不认端口：测试版里本机 mock 写成 http://127.0.0.1/*（见 scripts/build.mjs 的 match）
  const MOCK_PATTERN = 'http://127.0.0.1/*';
  await b.run(`await browser.permissions.remove({ origins: [args[0]] });`, [MOCK_PATTERN]).catch(() => undefined);
  const removed = await b.run(`return browser.permissions.contains({ origins: [args[0]] });`, [MOCK_PATTERN]);
  if (!removed) {
    await b.waitFor(`document.querySelector('[data-testid=host-access]')`, { what: '缺权限横幅' });
    const banner = (await text('[data-testid=host-access]')) ?? '';
    check(banner.includes('127.0.0.1') && banner.includes('授权访问这些网站'), `横幅：${banner.slice(0, 80)}…`);
    // 弹窗要真人确认，测试里由浏览器自身把权限加回去
    await b.chrome(
      `const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
       const policy = WebExtensionPolicy.getByID(arguments[0]);
       return ExtensionPermissions.add(arguments[0], { permissions: [], origins: [arguments[1]] }, policy.extension).then(() => true);`,
      [FIREFOX_E2E_ADDON_ID, MOCK_PATTERN],
    );
    await b.waitFor(`!document.querySelector('[data-testid=host-access]')`, { what: '权限回来后横幅消失' });
    check(true, '权限加回来后横幅自动消失');
  } else {
    check(false, '没能在测试里收回网站权限（permissions.remove 没生效）');
  }

  console.log('\n[设置：填 Key、Client ID、Client Secret → 连接 YouTube（Firefox 的授权回跳）]');
  await b.type('[data-testid=anthropic-key]', FAKE_KEY);
  await b.exec(`[...document.querySelectorAll('#llm .btn')].find((e) => e.textContent.trim() === '保存').click(); return true;`);
  await b.waitFor(`document.querySelector('[data-testid=anthropic-key]').placeholder === '已保存（出于安全不回显）'`, { what: 'Key 已保存' });
  check(true, '保存 Anthropic Key 后输入框不回显');
  const redirect = await text('[data-testid=redirect-url]');
  const expectedRedirect = firefoxRedirectUrl(FIREFOX_E2E_ADDON_ID);
  check(redirect === expectedRedirect, `设置页显示 Firefox 的授权回跳地址：${redirect}`);
  check(((await text('[data-testid=client-id]')) ?? '').includes('未配置'), '构建时没带 Client ID：设置页写明未配置');
  check((await b.exec(`return !!document.querySelector('[data-testid=google-client-id]')`)) === true, '有填写 Client ID 的输入框');
  await b.type('[data-testid=google-client-id]', 'not-a-client-id');
  check(((await text('#youtube')) ?? '').includes('应形如 xxxx.apps.googleusercontent.com'), '填错格式时当场说明');
  await b.type('[data-testid=google-client-id]', CLIENT_ID);
  await b.exec(`const f = document.querySelector('[data-testid=google-client-id]').closest('.field'); [...f.querySelectorAll('.btn')].find((e) => e.textContent.trim() === '保存').click(); return true;`);
  await b.waitFor(`document.querySelector('[data-testid=client-id]').textContent.includes(arguments[0])`, { args: [CLIENT_ID], what: 'Client ID 已保存' });
  check(true, '保存后显示这个 Client ID，状态不再是"未配置 OAuth 客户端"');
  await b.type('[data-testid=google-client-secret]', E2E_CLIENT_SECRET);
  await b.exec(`const f = document.querySelector('[data-testid=google-client-secret]').closest('.field'); [...f.querySelectorAll('.btn')].find((e) => e.textContent.trim() === '保存').click(); return true;`);
  await b.waitFor(`document.querySelector('[data-testid=google-client-secret]').placeholder === '已保存（出于安全不回显）'`, { what: 'Client Secret 已保存' });
  await tapText('连接 YouTube');
  await b.waitFor(`document.querySelector('[data-testid=auth-status]')?.textContent.includes('自动续期已开启')`, { timeout: 20_000, what: 'YouTube 已连接' });
  const authReq = requests.filter((r) => r.path === '/oauth/authorize');
  check(authReq.length === 1 && authReq[0].query.redirect_uri === expectedRedirect && authReq[0].query.client_id === CLIENT_ID, `YouTube 已连接：launchWebAuthFlow 带着 Firefox 的回跳地址和设置页填的 Client ID（${authReq[0]?.query.redirect_uri}）`);
  const exchange = requests.filter((r) => r.path === '/oauth/token' && new URLSearchParams(r.body).get('grant_type') === 'authorization_code');
  const ef = new URLSearchParams(exchange[0]?.body ?? '');
  check(exchange.length === 1 && ef.get('client_id') === CLIENT_ID && ef.get('client_secret') === E2E_CLIENT_SECRET && ef.get('redirect_uri') === expectedRedirect && !!ef.get('code_verifier'), '换令牌：Client ID、Client Secret、PKCE verifier 都在请求体里');
  const auth = await b.run(`return (await browser.storage.local.get('youtubeAuth')).youtubeAuth;`);
  check(!!auth?.refreshToken && auth.expiresAt > Date.now() + 30 * 60_000, '存下了访问令牌与刷新令牌');
  const exported = await b.run(`return Object.keys((await browser.storage.local.get('secrets')).secrets ?? {}).sort();`);
  check(JSON.stringify(exported) === JSON.stringify(['anthropicApiKey', 'googleClientId', 'googleClientSecret']), `Client ID 和 Key 一起只存本机：${exported.join(', ')}`);
  await b.screenshot(join(shots, '01-options.png'));

  console.log('\n[侧边栏页面：画像 → 找片 → 回显 → 结果 → 打 3 分和 10 分]');
  handles.panel = await b.newTab();
  await b.goto(`${EXT}/sidepanel.html`);
  await b.waitFor(`document.querySelector('[role=tab]')`, { what: '侧边栏渲染' });
  check((await b.exec(`return document.querySelectorAll('[data-testid=host-access]').length`)) === 0, '侧边栏：权限齐全，不显示"缺权限"横幅');
  await tapText('画像', '[role=tab]');
  await tapText('同步订阅与喜欢的视频');
  await b.waitFor(`document.body.textContent.includes('同步完成')`, { timeout: 20_000, what: '同步完成' });
  await b.exec(`[...document.querySelectorAll('button')].find((e) => /生成兴趣簇/.test(e.textContent)).click(); return true;`);
  await b.waitFor(`document.querySelectorAll('.cluster').length === 2`, { timeout: 20_000, what: '兴趣簇' });
  check(true, '同步订阅与喜欢的视频、生成 2 个兴趣簇（YouTube API、LLM 都由侧边栏发出）');
  await tapText('找片', '[role=tab]');
  const voice = (await text('[data-testid=voice-mode]')) ?? '';
  const voiceNote = (await b.exec(`return document.querySelector('.voice')?.textContent ?? ''`)) ?? '';
  check(!voiceNote.includes('Google'), `语音输入不再声称"音频发往 Google"（Firefox 没有云端识别）：${voice} ${voiceNote.slice(0, 60)}`);
  await fill('textarea.query', '帮我找两天内最新的 AI 技术科普视频');
  await tapText('找片', 'button.btn');
  await b.waitFor(`document.querySelectorAll('.card').length > 0`, { timeout: 30_000, what: '结果卡片' });
  const echoKinds = await b.exec(`return [...document.querySelectorAll('.echo-row')].map((e) => e.dataset.kind)`);
  check(['recency', 'topic'].every((k) => echoKinds.includes(k)), `回显包含约束：${echoKinds.join(', ')}`);
  const cards = await b.exec(`return document.querySelectorAll('.card').length`);
  check(cards >= 5, `拿到 ${cards} 条带理由的结果`);
  if (await b.exec(`return !!document.querySelector('.card[data-video-id=ai03]')`)) {
    await tap('.card[data-video-id=ai03] .rate-btn[data-rate="3"]');
    await b.waitFor(`document.querySelector('.card[data-video-id=ai03] .attrib')`, { what: '低分归因' });
    await tap('.card[data-video-id=ai03] button[data-attr=retrieval]');
    await b.waitFor(`document.querySelector('.card[data-video-id=ai03] [data-testid=adjustment]')`, { what: '3 分的调整' });
    const adj = (await text('.card[data-video-id=ai03] [data-testid=adjustment]')) ?? '';
    check(adj.includes('因为这次打分') && !/训练/.test(adj), `3 分 → 归因"找错/排错" → 展示具体调整：${adj.slice(0, 50)}…`);
  } else check(false, '结果里应包含 ai03（用于 3 分）');
  if (await b.exec(`return !!document.querySelector('.card[data-video-id=ai04]')`)) {
    await tap('.card[data-video-id=ai04] .rate-btn[data-rate="10"]');
    await b.waitFor(`document.querySelector('.card[data-video-id=ai04] [data-testid=adjustment]')`, { what: '10 分的调整' });
    check(((await text('.card[data-video-id=ai04] [data-testid=adjustment]')) ?? '').includes('更靠前'), '10 分 → 说明"之后会更靠前"');
  } else check(false, '结果里应包含 ai04（用于 10 分）');
  await b.screenshot(join(shots, '02-find.png'));

  console.log('\n[侧边栏缩放（DECISIONS §80）：Firefox 里整个侧边栏一样能放大 / 缩小，固定的导航栏照样吸附在头部下沿]');
  {
    const look = () =>
      b.exec(`const h = (s) => document.querySelector(s).getBoundingClientRect().height; const root = document.documentElement;
        return { label: document.querySelector('[data-testid=zoom-reset]').textContent.trim(), css: root.currentCSSZoom, style: root.style.zoom, brand: h('.brand'), tab: h('.tab'), overflowX: root.scrollWidth - innerWidth, pageH: root.scrollHeight };`);
    const waitZoom = (/** @type {number} */ pct) => b.waitFor(`document.querySelector('[data-testid=zoom]')?.dataset.zoom === '${pct}'`, { what: `缩放到 ${pct}%` });
    /** @param {'zoom-in' | 'zoom-out'} btn @param {number} pct */
    const stepTo = async (btn, pct) => {
      for (let i = 0; i < 12 && (await look()).label !== `${pct}%`; i++) await tap(`[data-testid=${btn}]`);
      await waitZoom(pct);
    };
    const storedZoom = () => b.run(`return (await browser.storage.local.get('settings')).settings?.ui?.zoom;`);
    const waitStored = async (/** @type {number} */ pct) => {
      for (const end = Date.now() + 5000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if ((await storedZoom()) === pct) return true;
      return false;
    };
    const near = (/** @type {number} */ a, /** @type {number} */ b0, /** @type {number} */ want) => Math.abs(a / b0 - want) < 0.03;
    const base = await look();
    check(base.label === '100%' && base.css === 1 && base.style === '', '默认 100%，页面没有加任何缩放');
    await stepTo('zoom-in', 110);
    const up = await look();
    check(Math.abs(up.css - 1.1) < 0.001 && near(up.brand, base.brand, 1.1) && near(up.tab, base.tab, 1.1) && up.overflowX <= 0, `点 + 放大到 110%：头部（${base.brand} → ${up.brand.toFixed(1)}）和导航栏（${base.tab} → ${up.tab.toFixed(1)}）一起变大，没有横向滚动条`);
    check(await waitStored(110), '选的档位存进本机设置（ui.zoom = 110）');
    await stepTo('zoom-out', 75);
    const down = await look();
    check(Math.abs(down.css - 0.75) < 0.001 && near(down.brand, base.brand, 0.75) && down.pageH < base.pageH && down.overflowX <= 0, `点 − 缩小到 75%：整页从 ${base.pageH}px 缩到 ${down.pageH}px`);
    await b.screenshot(join(shots, '02b-zoom-75.png'));

    // 固定导航栏：头部高度是缩放之后量出来的，写回 CSS 时除以了缩放倍数——两个浏览器的 getBoundingClientRect 都含缩放
    await tap('[data-testid=pin-nav]');
    await b.waitFor(`document.querySelector('[data-testid=nav].pinned')`, { what: '导航栏固定' });
    for (const [btn, pct] of /** @type {['zoom-in' | 'zoom-out', number][]} */ ([['zoom-out', 75], ['zoom-in', 150]])) {
      await stepTo(btn, pct);
      await b.exec(`window.scrollTo(0, 600); return true;`);
      await b.waitFor(`document.querySelector('[data-testid=nav].stuck')`, { what: `${pct}% 时导航栏吸附` });
      await new Promise((r) => setTimeout(r, 200));
      const pos = await b.exec(`const head = document.querySelector('header.top').getBoundingClientRect(); const nav = document.querySelector('[data-testid=nav]').getBoundingClientRect();
        return { head: head.bottom, navTop: nav.top, onTop: !!document.elementFromPoint(innerWidth / 2 - 40, (nav.top + nav.bottom) / 2)?.closest('[data-testid=nav]') };`);
      check(Math.abs(pos.navTop - pos.head) < 1 && pos.onTop, `${pct}% 时往下滚：固定的导航栏吸附在头部下沿（头部下沿 ${pos.head.toFixed(1)}，导航栏上沿 ${pos.navTop.toFixed(1)}），盖在正文之上`);
      if (pct === 150) await b.screenshot(join(shots, '02c-zoom-150-pinned.png'));
      await b.exec(`window.scrollTo(0, 0); return true;`);
    }
    await tap('[data-testid=pin-nav]');
    await b.waitFor(`!document.querySelector('[data-testid=nav].pinned')`, { what: '取消固定' });

    // 快捷键：Ctrl+0 恢复（页面自己处理，并拦下浏览器自己的缩放）
    const prevented = await b.exec(`const e = new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented;`);
    await waitZoom(100);
    const end = await look();
    check(prevented === true && end.style === '' && end.css === 1 && end.brand === base.brand && (await waitStored(100)), 'Ctrl+0 恢复 100%：和没缩放时完全一样，并存下');
  }

  console.log('\n[片段录制：YouTube 播放页 → 开始 → 停止 → Firefox 存下 WebM（VP8 + Opus），有声音]');
  await tapText('片段', '[role=tab]');
  const watch = await openActiveTab(`${MOCK}/watch?v=clipFree0001`);
  await b.switchTo(watch);
  await b.waitFor(`(document.querySelector('video')?.readyState ?? 0) >= 2`, { timeout: 30_000, what: '视频可以播放' });
  await b.run(`await document.querySelector('video').play();`);
  await b.switchTo(handles.panel);
  await b.waitFor(`document.querySelector('[data-testid=clip-status]')?.textContent.includes('可以开始录制')`, { what: '可以开始录制' });
  // 页面从没被点过（视频是脚本放起来的）：Firefox 不让它处理声音，录制停下来说明怎么办，不录一段没声音的。
  // 这个测试用的 Firefox 把自动播放整个放开了（media.autoplay.default = 0，脚本才能直接把视频放起来）——那样没点过的页面
  // 其实也能处理声音，看不看得到这句说明只取决于第一次启动声音有没有超过 CLIPS.audioResumeMs（同一流程实测 23 毫秒到 1.6 秒都有，
  // 2026-11-16 在 CI 上就因为启动得快而没看到）。所以这一步对 mock 站点按 Firefox 出厂的方式拦住声音（你没改过设置时的真实情况）：
  // 没点过就一直起不来，真的点一下才起得来；录上之后撤掉，后面各节照旧。
  await setMockAutoplayBlocked(true);
  await tap('[data-testid=clip-start]');
  await b.waitFor(`document.querySelector('#clips, .app')?.textContent.includes('浏览器还没允许这个页面处理声音')`, { what: '没点过页面时的说明' });
  check(true, '页面没被点过时：说明"在视频画面上点一下再录"，不录没声音的片段');
  // 真的在视频上点一下（就像你点播放）
  await b.switchTo(watch);
  await b.click('video');
  await b.switchTo(handles.panel);
  let before = downloaded();
  await tap('[data-testid=clip-start]');
  await b.waitFor(`document.querySelector('[data-testid=clip-status]')?.textContent.includes('正在录制')`, { what: '正在录制' });
  check(true, '在视频上真的点一下之后：声音仍被拦着的设置下也能开始录制');
  await setMockAutoplayBlocked(false);
  const badge = await b.run(`const [t] = (await browser.tabs.query({})).filter((x) => String(x.url).includes('clipFree0001')); return browser.action.getBadgeText({ tabId: t.id });`);
  check(badge === 'REC', `录制中工具栏图标显示 REC（实际："${badge}"）`);
  await sleep(3500);
  await tap('[data-testid=clip-stop]');
  const clipFile = await waitDownload(before, /\.webm$/);
  check(/^mock watch_00m0\ds-00m0\ds\.webm$/.test(clipFile), `停止后由 Firefox 存进下载文件夹：${clipFile}`);
  // 在播放页里解析（侧边栏页面的 CSP 不许播放媒体）
  await b.switchTo(watch);
  const clipInfo = await b.run(
    `const bytes = Uint8Array.from(atob(args[0]), (c) => c.charCodeAt(0));
     const head = Array.from(bytes.slice(0, 4));
     const ac = new AudioContext();
     let rms = 0;
     try { const ch = (await ac.decodeAudioData(bytes.buffer.slice(0))).getChannelData(0); let s = 0; for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i]; rms = Math.sqrt(s / ch.length); } catch (e) { rms = -1; }
     const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
     await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('片段无法播放')); });
     return { head, rms, width: v.videoWidth, height: v.videoHeight };`,
    [readFileSync(join(downloads, clipFile)).toString('base64')],
  );
  await b.switchTo(handles.panel);
  check(clipInfo.head.join(',') === '26,69,223,163', 'WebM 文件头（Firefox 的 MediaRecorder 不出 MP4，自动选了 WebM）');
  check(clipInfo.width === 1280 && clipInfo.height === 720, `有画面轨：${clipInfo.width}×${clipInfo.height}`);
  check(clipInfo.rms > 0.02, `录到了这个视频的声音（响度 ${clipInfo.rms.toFixed(3)}；标准 captureStream()，不是会让视频变哑的 mozCaptureStream）`);
  await b.waitFor(`document.querySelector('[data-testid=clip-log]')`, { what: '最近录过的片段' });
  const clipLog = await b.run(`return (await browser.storage.local.get('clipLog')).clipLog ?? [];`);
  check(clipLog.length === 1 && clipLog[0].fileName === clipFile && clipLog[0].format.includes('WebM'), `"最近录过的片段"记下文件名与格式（${clipLog[0]?.format}）`);
  const playing = await (async () => {
    await b.switchTo(watch);
    const r = await b.exec(`const v = document.querySelector('video'); return { muted: v.muted, volume: v.volume, paused: v.paused };`);
    await b.switchTo(handles.panel);
    return r;
  })();
  check(!playing.muted && playing.volume === 1, '录制没有把视频静音、没有改音量');

  console.log('\n[Capture：按视频真实尺寸存 PNG，同时放进剪贴板]');
  // mock 播放页的片源只有声音：现场录一段左红右蓝的 1920×1080 视频换上，页面上只显示 320×180
  await b.switchTo(watch);
  await b.run(
    `const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; const g = c.getContext('2d'); let n = 0;
     const paint = () => { g.fillStyle = '#e00000'; g.fillRect(0, 0, 960, 1080); g.fillStyle = '#0000e0'; g.fillRect(960, 0, 960, 1080); g.fillStyle = '#e00000'; g.fillRect(960, 0, 2, 2 + (n++ % 8)); };
     paint();
     const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm;codecs=vp8' }); const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
     const stopped = new Promise((r) => (rec.onstop = r)); rec.start(); const timer = setInterval(paint, 50);
     await new Promise((r) => setTimeout(r, 1500)); clearInterval(timer); rec.stop(); await stopped;
     const v = document.querySelector('video'); v.style.cssText = 'width:320px;height:180px'; v.muted = true;
     const loaded = new Promise((r) => (v.onloadeddata = r)); v.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })); await loaded;
     await v.play(); await new Promise((r) => setTimeout(r, 400)); v.pause();`,
  );
  await b.switchTo(handles.panel);
  before = downloaded();
  await b.run(`await navigator.clipboard.writeText('截图之前的剪贴板');`);
  await tap('[data-testid=clip-capture]');
  const png = await waitDownload(before, /\.png$/);
  const pngBytes = readFileSync(join(downloads, png));
  check(pngBytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && pngBytes.readUInt32BE(16) === 1920 && pngBytes.readUInt32BE(20) === 1080, `PNG 按视频真实尺寸存进下载文件夹（页面上只显示 320×180）：${png}（${pngBytes.readUInt32BE(16)}×${pngBytes.readUInt32BE(20)}）`);
  await b.waitFor(`document.querySelector('[data-testid=clip-capture-saved]')?.textContent.includes(arguments[0])`, { args: [png], what: '侧边栏写明存好的截图' });
  const saved = (await text('[data-testid=clip-capture-saved]')) ?? '';
  check(saved.includes('也已放进剪贴板') && (await b.exec(`return document.querySelectorAll('[data-testid=clip-capture-clipboard-error]').length`)) === 0, '侧边栏写明这张图也放进了剪贴板');
  const clip = await b.run(
    `const items = await navigator.clipboard.read();
     const types = items.flatMap((i) => i.types);
     const item = items.find((i) => i.types.includes('image/png'));
     if (!item) return { types };
     const bmp = await createImageBitmap(await item.getType('image/png'));
     return { types, width: bmp.width, height: bmp.height };`,
  );
  check(clip.types.includes('image/png') && clip.width === 1920 && clip.height === 1080, `剪贴板里是这张 PNG（${clip.types.join(', ')}；${clip.width}×${clip.height}）`);
  await closeTab(watch);

  console.log('\n[多语字幕：页面环境（MAIN）助手 ↔ 内容脚本通话；复用播放器的字幕请求（内容脚本的同源 fetch）；叠在播放器里]');
  await tapText('字幕', '[role=tab]');
  const cc = await openActiveTab(`${MOCK}/watch?v=ccMulti0001`);
  await b.switchTo(cc);
  await b.waitFor(`(document.querySelector('video')?.readyState ?? 0) >= 2`, { timeout: 30_000, what: '视频可以播放' });
  await b.switchTo(handles.panel);
  await b.waitFor(`document.querySelector('[data-testid=multicc-status]')?.textContent.includes('未开启')`, { what: '多语字幕未开启' });
  const langs = (await text('[data-testid=multicc-langs]')) ?? '';
  check(['English', 'Chinese (Simplified)'].every((x) => langs.includes(x)), '侧边栏列出这个视频的 YouTube 字幕（页面内助手读到了播放器的字幕轨列表）');
  await tapText('显示多语字幕');
  await b.switchTo(cc);
  await b.exec(`const v = document.querySelector('video'); v.pause(); v.currentTime = 3.0; return true;`);
  const ccText = await b
    .waitFor(
      `const t = [...(document.querySelector('[data-tubemuse="multicc"]')?.shadowRoot?.querySelectorAll('.line:not([hidden]) .tx') ?? [])].map((x) => x.textContent); return t.length === 3 ? t : false;`,
      { timeout: 20_000, what: '三行字幕' },
    )
    .catch(() => []);
  check(JSON.stringify(ccText) === JSON.stringify(['내 이름을 불러줘', 'Lead me', '叫我的名字']), `韩 / 英 / 中三行叠在播放器里：${ccText.join(' / ')}`);
  const tt = requests.filter((r) => r.path === '/api/timedtext' && r.query.v === 'ccMulti0001' && r.headers['x-mock-player'] !== '1');
  check(tt.length === 3 && tt.every((r) => r.query.pot && r.query.signature === 'MOCKSIG'), `复用播放器的带令牌请求、只换语言：${tt.map((r) => r.query.lang).join(', ')}`);
  await b.screenshot(join(shots, '03-multicc.png'));

  console.log('\n[问 muse：冻结播放位置，生成咨询包]');
  await b.switchTo(handles.panel);
  await tap('[data-testid=muse-ask]');
  await b.waitFor(`document.querySelector('[data-testid=muse-panel]')`, { what: '问 muse 面板' });
  // 面板一点开就在，"我的问题"输入框要等冻结做完（读播放位置、取字幕、查作者和简介）才出现：等它出来再填。
  // 只等面板的话，runner 慢的时候冻结还没做完，就报"找不到 muse-question"（main 上 CI #77 就是这样挂的）
  await b.waitFor(`document.querySelector('[data-testid=muse-question]')`, { timeout: 20_000, what: '问 muse 冻结完成、出现"我的问题"' });
  await fill('[data-testid=muse-question]', '这一段讲了什么？');
  await tap('[data-testid=muse-generate]');
  const pkg = await b.waitFor(`return document.querySelector('[data-testid=muse-package]')?.value || document.querySelector('[data-testid=muse-package]')?.textContent || false`, { timeout: 20_000, what: '咨询包' });
  check(String(pkg).includes('ccMulti0001') && /&t=\d+s/.test(String(pkg)) && String(pkg).includes('这一段讲了什么'), '咨询包里有带 &t= 的链接和问题');
  check(!String(pkg).includes(FAKE_KEY) && !String(pkg).includes(E2E_CLIENT_SECRET), '咨询包里没有任何 Key');
  await tap('[data-testid=muse-close]').catch(() => undefined);
  await closeTab(cc);

  console.log('\n[小红书：页面环境助手读发布时间，卡片上写时间、放收藏按钮]');
  const xhs = await openActiveTab(`${MOCK}/xhs/user/profile/67398f95000000001d02d725?xsec_token=ABprofile%3D&xsec_source=pc_feed`);
  await b.switchTo(xhs);
  const xhsTimes = await b
    .waitFor(`const t = document.querySelectorAll('[data-tubemuse="xhs-time"][data-source="page"]'); return t.length === 2 ? [...t].map((x) => x.textContent) : false;`, { timeout: 15_000, what: '小红书发布时间' })
    .catch(() => []);
  check(xhsTimes.length === 2, `笔记卡片上写着页面数据里的发布时间：${xhsTimes.join('、')}`);
  check((await b.exec(`return document.querySelectorAll('[data-tubemuse="xhs-save"]').length`)) > 0, '卡片上有"收藏"按钮');
  await closeTab(xhs);

  console.log('\n[eMails：读当前打开的这封邮件，列出文章]');
  await tapText('eMails', '[role=tab]');
  const gmail = await openActiveTab(`${MOCK}/gmail/mail`);
  await b.switchTo(gmail);
  await b.waitFor(`typeof window.openMail === 'function'`, { what: 'mock Gmail' });
  await b.exec(`window.openMail('digest'); window.watchPage?.(); return true;`);
  await b.switchTo(handles.panel);
  await b.waitFor(`document.querySelector('[data-testid=email-found]')?.textContent.includes('找到 5 篇文章')`, { timeout: 15_000, what: '列出 5 篇文章' });
  check(true, '侧边栏列出当前邮件里的 5 篇文章');
  await closeTab(gmail);

  console.log('\n[故事（DECISIONS §88）：侧边栏把读取函数放进 X 帖子页跑一次（Firefox 的 scripting）→ 联网调研 → 结果分清已证实 / 说法]');
  await tapText('故事', '[role=tab]');
  const storyX = await openActiveTab(`${MOCK}/xpage/elonmusk/status/2122810772967575759?s=20&t=sharerToken`);
  await b.switchTo(storyX);
  await b.waitFor(`document.querySelector('#story-main') && document.readyState === 'complete'`, { what: '仿 X 帖子页' });
  await b.switchTo(handles.panel);
  await tap('[data-testid=story-read]');
  const storyPost = await b.waitFor(`return document.querySelector('[data-testid=story-post]')?.textContent || false`, { timeout: 15_000, what: '读到的主帖' });
  const storyQuoted = await b.exec(`return document.querySelector('[data-testid=story-quoted]')?.textContent ?? ''`);
  check(String(storyPost).includes('Elon Musk') && String(storyQuoted).includes('Sean Duffy RESPONDS') && !String(storyQuoted).includes('最新消息'), `Firefox 里读到了主帖和引用的帖子（译文不读）：${String(storyQuoted).slice(0, 60)}`);
  check(!(await b.exec(`return document.querySelector('[data-testid=story-page]')?.textContent ?? ''`)).includes('This reply text'), '回复不读');
  await tap('[data-testid=story-run]');
  const storyLegend = await b.waitFor(`return document.querySelector('[data-testid=story-legend]')?.textContent || false`, { timeout: 20_000, what: '调研结果' });
  check(String(storyLegend).includes('已证实 2') && String(storyLegend).includes('只是说法 1'), `调研结果分清已证实 / 只是说法：${storyLegend}`);
  await b.switchTo(storyX);
  const storyMut = await b.exec(`return { m: window.__mutations, c: window.__clicks }`);
  check(storyMut.m === 0 && storyMut.c === 0, 'X 页面：读的时候没有改动页面、没有点任何东西');
  await closeTab(storyX);

  console.log('\n[自动字幕：设置页按 Firefox 写——浏览器识别只在本机、没有云端；本地翻译 Firefox 没有]');
  const OPENAI_KEY = 'e2e-openai-test-key-not-real';
  await b.switchTo(handles.options);
  await b.goto(`${EXT}/options.html`);
  await b.waitFor(`document.querySelector('#subtitles')`, { what: '设置页"自动字幕"一节' });
  const subSection = (await text('#subtitles')) ?? '';
  check(subSection.includes('只在本机识别') && !subSection.includes('没装时用 Chrome 云端识别'), '"浏览器识别"写明 Firefox 只在本机识别，不说"没装时用 Chrome 云端识别"');
  check(subSection.includes('本地语音包') || subSection.includes('本机语音模型'), '显示这个语言的本机语音模型状态');
  check((await b.exec(`return !!document.querySelector('[data-testid=local-translate-missing]')`)) === true && subSection.includes('Firefox 没有给扩展用的本地翻译接口'), '本地翻译：写明 Firefox 没有，第二行不会显示（不假装能翻）');
  check(((await text('#voice')) ?? '').includes('只在本机进行') && !((await text('#voice')) ?? '').includes('云端语音服务'), '"语音"一节写明 Firefox 只在本机识别');
  check(((await text('#egress')) ?? '').includes('extensions.allizom.org') && !((await text('#egress')) ?? '').includes('chromiumapp.org'), '网络说明里的授权回跳域名是 extensions.allizom.org');

  console.log('\n[自动字幕：浏览器识别——本机模型没准备好时停下说明，不假装在听]');
  await b.switchTo(handles.panel);
  await tapText('字幕', '[role=tab]');
  const bsub = await openActiveTab(`${MOCK}/watch?v=subBrowse001`);
  await b.switchTo(bsub);
  await b.waitFor(`(document.querySelector('video')?.readyState ?? 0) >= 2`, { timeout: 30_000, what: '视频可以播放' });
  await b.click('video');
  await b.run(`await document.querySelector('video').play();`);
  await b.switchTo(handles.panel);
  await b.waitFor(`[...document.querySelectorAll('button')].some((e) => e.textContent.includes('为这个视频生成字幕'))`, { what: '"为这个视频生成字幕"按钮' });
  await tapText('为这个视频生成字幕');
  await b.switchTo(bsub);
  const chip = await b.waitFor(`return document.querySelector('[data-tubemuse="subtitles"]')?.shadowRoot?.querySelector('.status')?.textContent || document.querySelector('[data-tubemuse="subtitles"] .status')?.textContent || false`, { timeout: 15_000, what: '字幕层的状态' });
  check(String(chip).includes('本机语音模型') && String(chip).includes('OpenAI'), `播放器里说明原因与办法：${String(chip).slice(0, 70)}…`);
  await closeTab(bsub);

  console.log('\n[自动字幕：OpenAI 转写——采这个视频的声音（captureStream + AudioContext）→ 后台转写 → 大模型翻译 → 叠在播放器里]');
  await b.switchTo(handles.options);
  await fill('[data-testid=openai-key]', OPENAI_KEY);
  await b.exec(`const f = document.querySelector('[data-testid=openai-key]').closest('.field'); [...f.querySelectorAll('.btn')].find((e) => e.textContent.trim() === '保存').click(); return true;`);
  await b.waitFor(`document.querySelector('[data-testid=openai-key]').placeholder === '已保存（出于安全不回显）'`, { what: 'OpenAI Key 已保存' });
  await tap('input[name=asr-engine]:not(:checked)');
  await tap('[data-testid=subtitle-engine-llm]');
  await b.waitFor(`return browser.storage.local.get('settings').then((r) => r.settings?.subtitles?.asrEngine === 'openai' && r.settings?.subtitles?.translationEngine === 'llm')`, { what: '设置已保存' });
  await b.switchTo(handles.panel);
  const sub = await openActiveTab(`${MOCK}/watch?v=subNoCC00001`);
  await b.switchTo(sub);
  await b.waitFor(`(document.querySelector('video')?.readyState ?? 0) >= 2`, { timeout: 30_000, what: '视频可以播放' });
  await b.click('video');
  await b.run(`await document.querySelector('video').play();`);
  await b.switchTo(handles.panel);
  await b.waitFor(`[...document.querySelectorAll('button')].some((e) => e.textContent.includes('为这个视频生成字幕'))`, { what: '"为这个视频生成字幕"按钮' });
  await tapText('为这个视频生成字幕');
  await b.switchTo(sub);
  const lines = await b
    .waitFor(
      `const root = document.querySelector('[data-tubemuse="subtitles"]'); const q = (c) => (root?.shadowRoot ?? root)?.querySelector(c)?.textContent ?? '';
       return q('.tr').includes('Where was I?') ? { src: q('.src'), tr: q('.tr') } : false;`,
      { timeout: 40_000, what: '双语字幕' },
    )
    .catch(() => ({ src: '', tr: '' }));
  check(/第 \d+ 句：我说到哪里了/.test(lines.src) && /Where was I\?/.test(lines.tr), `播放器里出现原文与译文：${lines.src} / ${lines.tr}`);
  const tr = requests.filter((r) => r.path === '/openai/v1/audio/transcriptions');
  check(tr.length >= 1 && tr.every((r) => r.headers.authorization === `Bearer ${OPENAI_KEY}` && r.body.includes('RIFF') && r.body.includes('WAVE')), `音频切成 WAV 发往 OpenAI 转写（${tr.length} 段），Key 只在请求头里`);
  check(tr.every((r) => String(r.headers.origin ?? '').startsWith('moz-extension://')), '转写请求由扩展后台发出（不是注入 YouTube 的脚本自己发的）');
  const playingSub = await b.exec(`const v = document.querySelector('video'); return { muted: v.muted, volume: v.volume };`);
  check(!playingSub.muted && playingSub.volume === 1, '采声音时视频照常播放：没有静音、没有改音量');
  await b.screenshot(join(shots, '04-subtitles.png'));
  await closeTab(sub);

  console.log('\n[小宇宙：单集页 → 开始字幕 → 后台读音频段 → 页面脚本在 Firefox 里解码、切句 → 转写 → 校对 / 翻译 → 叠在播放器上方]');
  await b.switchTo(handles.panel);
  const xyzPage = await openActiveTab(`${MOCK}/xyz/episode/6af02451b4a4e20202f67f19`);
  await b.switchTo(xyzPage);
  await b.click('#pp');
  await b.waitFor(`!document.querySelector('audio').paused`, { timeout: 15_000, what: '小宇宙页面开始播放' });
  await b.switchTo(handles.panel);
  await tapText('小宇宙', 'button[role=tab]');
  await b.waitFor(`document.querySelector('[data-testid=xyz-title]')?.textContent.includes('#817.测试单集') && !!document.querySelector('[data-testid=xyz-toggle]')`, { what: '侧边栏读到这一集' });
  await tap('[data-testid=xyz-toggle]');
  await b.switchTo(xyzPage);
  const xyzLines = await b
    .waitFor(
      `const root = document.querySelector('[data-tubemuse="xyz"]')?.shadowRoot; const q = (c) => root?.querySelector(c)?.textContent ?? '';
       return q('.zh').includes('（校）') ? { zh: q('.zh'), en: q('.en'), t: document.querySelector('audio').currentTime } : false;`,
      { timeout: 40_000, what: '小宇宙的双语字幕' },
    )
    .catch(() => ({ zh: '', en: '', t: 0 }));
  const shownK = Number(/第(\d+)段/.exec(xyzLines.zh)?.[1] ?? NaN);
  check(/第\d+段音频的内容（校）/.test(xyzLines.zh) && /This is segment \d+/.test(xyzLines.en), `播放器上方出现中英字幕：${xyzLines.zh} / ${xyzLines.en}`);
  check(xyzLines.t >= 0.5 + 3 * shownK - 0.35 && xyzLines.t <= 0.5 + 3 * shownK + 2.5, `字幕对得上正在放的那段音（${xyzLines.t.toFixed(1)} 秒显示第 ${shownK} 段）`);
  const xyzMedia = requests.filter((r) => r.path.startsWith('/xyzmedia/') && !r.headers.referer);
  check(xyzMedia.length >= 1 && xyzMedia.every((r) => /^bytes=\d+-\d+$/.test(String(r.headers.range)) && !r.headers.cookie), `音频由扩展后台分段读（${xyzMedia.length} 次），不带 Cookie`);
  const xyzTr = requests.filter((r) => r.path === '/openai/v1/audio/transcriptions' && r.body.includes('测试节目串门儿'));
  check(xyzTr.length >= 1 && xyzTr.every((r) => String(r.headers.origin ?? '').startsWith('moz-extension://')), `切好的句子由扩展后台发往 OpenAI 转写（${xyzTr.length} 句）`);
  await b.screenshot(join(shots, '05-xyz.png'));
  await closeTab(xyzPage);

  console.log('\n[中文配音：侧边栏选 .m4a → 存进扩展的 IndexedDB → 事件页读出来交给页面 → 页面里用 blob 地址播放、跟随、原声降 20%]');
  await b.switchTo(handles.panel);
  await tapText('配音', '[role=tab]');
  const dubPage = await openActiveTab(`${MOCK}/watch?v=dubVideo0001`);
  await b.switchTo(dubPage);
  await b.waitFor(`(document.querySelector('video')?.readyState ?? 0) >= 2`, { timeout: 30_000, what: '视频可以播放' });
  await b.switchTo(handles.panel);
  await b.waitFor(`!!document.querySelector('[data-testid=dub-pick]')`, { what: '可以选文件' });
  // 测试里没有文件对话框：把文件放进文件框（和你在对话框里选中一样触发 change）
  await b.exec(
    `const bytes = Uint8Array.from(atob(arguments[0]), (c) => c.charCodeAt(0));
     const dt = new DataTransfer(); dt.items.add(new File([bytes], 'xyz-tones.m4a', { type: 'audio/mp4' }));
     const input = document.querySelector('[data-testid=dub-file]'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true;`,
    [readFileSync(join(root, 'tests', 'fixtures', 'xyz-tones.m4a')).toString('base64')],
  );
  await b.waitFor(`!!document.querySelector('[data-testid=dub-done]')`, { timeout: 15_000, what: '关联好了' });
  const dubRec = await b.run(`return (await browser.storage.local.get('dubs')).dubs?.dubVideo0001;`);
  const dubIdb = await b.run(
    `return await new Promise((res) => { const r = indexedDB.open('tubemuse-dub'); r.onsuccess = () => { const q = r.result.transaction('audio').objectStore('audio').getAll(); q.onsuccess = () => { res(q.result.map((x) => x.size)); r.result.close(); }; }; });`,
  );
  check(dubRec?.durationSec > 91 && JSON.stringify(dubIdb) === JSON.stringify([readFileSync(join(root, 'tests', 'fixtures', 'xyz-tones.m4a')).length]), `Firefox：音频存进扩展的 IndexedDB、时长读出来了（${dubRec?.durationSec} 秒）`);
  const dubTab = await b.run(`const [t] = (await browser.tabs.query({})).filter((x) => String(x.url).includes('dubVideo0001')); return t.id;`);
  const dubState = () => b.run(`return await browser.tabs.sendMessage(args[0], { type: 'tubemuse:dub:get-state' });`, [dubTab]);
  await tap('[data-testid=dub-toggle]');
  await b.switchTo(dubPage);
  await b.click('video');
  await b.run(`await document.querySelector('video').play();`);
  await b.switchTo(handles.panel);
  let dubS = await dubState();
  for (let i = 0; i < 60 && !(dubS?.playing && dubS.phase === 'ready'); i++) {
    await sleep(250);
    dubS = await dubState();
  }
  check(dubS?.playing === true && dubS.dubDuration > 91, `Firefox：后台（事件页）读 IndexedDB 分块交给页面，页面里的 <audio> 用 blob 地址放起来了：${dubS?.status}`);
  await sleep(1500);
  dubS = await dubState();
  check(Math.abs(dubS.dubTime - dubS.videoTime) < 0.5, `Firefox：跟着视频走（视频 ${Number(dubS.videoTime).toFixed(2)} · 中文 ${Number(dubS.dubTime).toFixed(2)}）`);
  await b.switchTo(dubPage);
  const ffVol = await b.exec(`return document.querySelector('video').volume;`);
  await b.switchTo(handles.panel);
  check(Math.abs(ffVol - 0.8) < 0.005, `Firefox：原声降 20%（${ffVol}）`);
  // 对齐图（DECISIONS §77）与此刻差距（§78）：Firefox 里一样画出来、跟着播放走
  await b.waitFor(`(document.querySelector('[data-testid=dub-gap-note]')?.textContent ?? '').includes('全片时长差')`, { what: '对齐图' });
  const mapNow = () => b.run(`return document.querySelector('[data-testid=dub-gap-value]').textContent + ' · ' + document.querySelector('[data-testid=dub-gap-note]').textContent;`);
  const ffNowA = await mapNow();
  await sleep(1500);
  const ffNowB = await mapNow();
  const ffOverall = await b.run(`return document.querySelector('[data-testid=dub-map-overall]')?.textContent ?? '';`);
  const ffShapes = await b.run(`return document.querySelectorAll('[data-testid=dub-map-overview] polygon, [data-testid=dub-map-detail] polygon, [data-testid=dub-map-hold]').length;`);
  check(
    ffNowA !== ffNowB && /中文在视频 1:3[12] 放完/.test(ffOverall) && ffShapes >= 3,
    `Firefox："还差多少没对上"读数和对齐图画出来、跟着播放走（${ffNowA} → ${ffNowB}；${ffOverall.slice(0, 24)}…）`,
  );
  // 快速对齐（DECISIONS §82）：Firefox 里一样——点建议的倍速，中文整段慢放（变速不变调）放满全片，"还差多少"直接是 0
  const ffQuickWant = Number((dubS.dubDuration / dubS.videoDuration).toFixed(6));
  await b.waitFor(`!!document.querySelector('[data-testid=dub-quick-apply]')`, { what: '建议倍速的按钮' });
  const ffQuickBtn = String(await text('[data-testid=dub-quick-apply]')).trim();
  await tap('[data-testid=dub-quick-apply]');
  const ffDubRec = () => b.run(`return (await browser.storage.local.get('dubs')).dubs?.dubVideo0001;`);
  let ffQuickRec = await ffDubRec();
  for (let i = 0; i < 40 && ffQuickRec?.quickRate === undefined; i++) {
    await sleep(150);
    ffQuickRec = await ffDubRec();
  }
  await b.waitFor(`(document.querySelector('[data-testid=dub-gap-value]')?.textContent ?? '').trim() === '0.0 秒'`, { what: '快速对齐后还差 0.0 秒' });
  check(
    ffQuickBtn === `${ffQuickWant.toFixed(2)}×` && ffQuickRec?.quickRate === ffQuickWant && String(await text('[data-testid=dub-gap-note]')).includes('匀到整段，中文和视频同时结束'),
    `Firefox：点建议的倍速 ${ffQuickBtn}（中文 ${Number(dubS.dubDuration).toFixed(1)} 秒 ÷ 视频 ${Number(dubS.videoDuration).toFixed(1)} 秒）→ 存下 ${ffQuickRec?.quickRate}，"还差多少没对上"直接是 0.0 秒`,
  );
  dubS = await dubState();
  for (let i = 0; i < 40 && !(dubS?.quickRate === ffQuickWant && dubS.playing && Math.abs(dubS.dubTime - dubS.videoTime * ffQuickWant) < 0.5); i++) {
    await sleep(150);
    dubS = await dubState();
  }
  await sleep(1200);
  const ffQ1 = await dubState();
  await sleep(2500);
  const ffQ2 = await dubState();
  const ffSpeed = (ffQ2.dubTime - ffQ1.dubTime) / (ffQ2.videoTime - ffQ1.videoTime);
  check(
    Math.abs(ffQ2.dubTime - ffQ2.videoTime * ffQuickWant) < 0.5 && Math.abs(ffSpeed - ffQuickWant) < 0.1 && String(ffQ2.status).includes('快速对齐'),
    `Firefox：中文按倍速慢放、位置 = 视频位置 × 倍速（视频 ${Number(ffQ2.videoTime).toFixed(2)} · 中文 ${Number(ffQ2.dubTime).toFixed(2)}，应在 ${(ffQ2.videoTime * ffQuickWant).toFixed(2)}；这段时间中文走得是视频的 ${ffSpeed.toFixed(2)} 倍）`,
  );
  // 配音开着时录片段（DECISIONS §76）：录下的是双语混音。两个内容脚本在 Firefox 里也共用同一个隔离环境，录制脚本拿得到配音的 <audio>。
  // 这一段是快速对齐开着录的：慢放的中文同样录得进去
  await tapText('片段', '[role=tab]');
  await b.waitFor(`document.querySelector('[data-testid=clip-dub]')?.textContent.includes('双语混音')`, { what: '片段页写明会录双语混音' });
  const dubClipBefore = downloaded();
  await tap('[data-testid=clip-start]');
  await b.waitFor(`document.querySelector('[data-testid=clip-status]')?.textContent.includes('正在录制')`, { what: '正在录制' });
  await sleep(3000);
  await tap('[data-testid=clip-stop]');
  const dubClip = await waitDownload(dubClipBefore, /\.webm$/);
  await b.switchTo(dubPage);
  // 原声是 200 Hz、振幅 0.2 的单音：按 0.1 秒一段量它的振幅和其余的响度（= 配音），取中位数
  const dubMixInfo = await b.run(
    `const bytes = Uint8Array.from(atob(args[0]), (c) => c.charCodeAt(0));
     const ac = new AudioContext();
     const buf = await ac.decodeAudioData(bytes.buffer.slice(0));
     const ch = buf.getChannelData(0); const win = Math.round(buf.sampleRate / 10); const w = 2 * Math.PI * 200 / buf.sampleRate;
     const tones = []; const rests = [];
     for (let a = Math.floor(buf.sampleRate * 0.3); a + win <= ch.length - buf.sampleRate * 0.3; a += win) {
       let re = 0, im = 0, sum = 0;
       for (let i = a; i < a + win; i++) { re += ch[i] * Math.cos(w * i); im -= ch[i] * Math.sin(w * i); sum += ch[i] * ch[i]; }
       const amp = 2 * Math.sqrt(re * re + im * im) / win; tones.push(amp); rests.push(Math.sqrt(Math.max(0, sum / win - amp * amp / 2)));
     }
     const med = (xs) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)];
     return { tone: med(tones), rest: med(rests) };`,
    [readFileSync(join(downloads, dubClip)).toString('base64')],
  );
  await b.exec(`document.querySelector('video').pause(); return true;`);
  await b.switchTo(handles.panel);
  // 原声的振幅按 200 Hz 量：Firefox 以前把录音的 AudioContext 固定成 48 kHz、设备是 44.1 kHz 时声音录慢、音调降到约 184 Hz，这里就量不到（DECISIONS §76）
  check(dubMixInfo.rest > 0.05 && Math.abs(dubMixInfo.tone - 0.16) < 0.03, `Firefox：配音开着（快速对齐，中文慢放）时录下双语混音——有中文配音（其余响度 ${dubMixInfo.rest.toFixed(3)}），原声按 80% 混入、音调没变（200 Hz 振幅 ${dubMixInfo.tone.toFixed(3)}，原本 0.2）`);
  await tapText('配音', '[role=tab]');
  await b.waitFor(`!!document.querySelector('[data-testid=dub-toggle]')`, { what: '回到配音页' });
  for (let i = 0; i < 20 && (await dubState())?.playing; i++) await sleep(150);
  check((await dubState())?.playing === false, 'Firefox：视频暂停，配音跟着停');
  // 切回手动对齐：倍速去掉，中文回到正常速度
  await tap('[data-testid=dub-quick-off]');
  ffQuickRec = await ffDubRec();
  for (let i = 0; i < 40 && ffQuickRec?.quickRate !== undefined; i++) {
    await sleep(150);
    ffQuickRec = await ffDubRec();
  }
  dubS = await dubState();
  for (let i = 0; i < 40 && !(dubS?.quickRate === undefined && Math.abs(dubS.dubTime - dubS.videoTime) < 0.5); i++) {
    await sleep(150);
    dubS = await dubState();
  }
  check(
    ffQuickRec && ffQuickRec.quickRate === undefined && dubS?.quickRate === undefined && Math.abs(dubS.dubTime - dubS.videoTime) < 0.5,
    `Firefox：切回手动对齐，中文位置回到 视频位置 − 偏移（视频 ${Number(dubS?.videoTime).toFixed(2)} · 中文 ${Number(dubS?.dubTime).toFixed(2)}）`,
  );
  // 加快英文（DECISIONS §87）：Firefox 里一样——点建议的英文倍速，页面里视频（英文原声）按它快放、中文原速；整体变速两边一起快；切回手动后视频回到 1 倍
  const ffEngWant = Number((dubS.videoDuration / dubS.dubDuration).toFixed(6));
  await b.waitFor(`!!document.querySelector('[data-testid=dub-english-apply]')`, { what: '加快英文的按钮' });
  await tap('[data-testid=dub-english-apply]');
  let ffEngRec = await ffDubRec();
  for (let i = 0; i < 40 && ffEngRec?.englishRate === undefined; i++) {
    await sleep(150);
    ffEngRec = await ffDubRec();
  }
  await b.waitFor(`(document.querySelector('[data-testid=dub-gap-value]')?.textContent ?? '').trim() === '0.0 秒'`, { what: '加快英文后还差 0.0 秒' });
  await b.switchTo(dubPage);
  await b.exec(`document.querySelector('video').currentTime = 20; document.querySelector('video').play(); return true;`);
  await b.switchTo(handles.panel);
  dubS = await dubState();
  for (let i = 0; i < 40 && !(dubS?.englishRate === ffEngWant && dubS.playing && Math.abs(dubS.dubTime - dubS.videoTime / ffEngWant) < 0.5); i++) {
    await sleep(150);
    dubS = await dubState();
  }
  await sleep(1000);
  const ffE1 = { s: await dubState(), at: Date.now() };
  await sleep(2500);
  const ffE2 = { s: await dubState(), at: Date.now() };
  const ffWall = (ffE2.at - ffE1.at) / 1000;
  await b.switchTo(dubPage);
  const ffEngRate = await b.exec(`return document.querySelector('video').playbackRate;`);
  await b.switchTo(handles.panel);
  check(
    ffEngRec?.englishRate === ffEngWant &&
      Math.abs(ffEngRate - ffEngWant) < 0.002 &&
      Math.abs(ffE2.s.dubTime - ffE2.s.videoTime / ffEngWant) < 0.5 &&
      Math.abs((ffE2.s.videoTime - ffE1.s.videoTime) / ffWall - ffEngWant) < 0.15 &&
      Math.abs((ffE2.s.dubTime - ffE1.s.dubTime) / ffWall - 1) < 0.12 &&
      String(ffE2.s.status).includes('加快英文'),
    `Firefox：加快英文 ${ffEngWant.toFixed(4)}——页面里视频的倍速 ${Number(ffEngRate).toFixed(4)}，中文原速（这 ${ffWall.toFixed(1)} 秒英文走 ${((ffE2.s.videoTime - ffE1.s.videoTime) / ffWall).toFixed(2)} 倍、中文 ${((ffE2.s.dubTime - ffE1.s.dubTime) / ffWall).toFixed(2)} 倍），"还差"是 0`,
  );
  await tap('[data-testid=dub-speed-preset][data-rate="1.5"]');
  let ffOverRate = 0;
  for (let i = 0; i < 40 && Math.abs(ffOverRate - 1.5 * ffEngWant) > 0.002; i++) {
    await sleep(150);
    await b.switchTo(dubPage);
    ffOverRate = await b.exec(`return document.querySelector('video').playbackRate;`);
    await b.switchTo(handles.panel);
  }
  check(Math.abs(ffOverRate - 1.5 * ffEngWant) < 0.002 && (await ffDubRec())?.overallRate === 1.5, `Firefox：整体 1.5 倍——视频 ${Number(ffOverRate).toFixed(3)} 倍（1.5 × ${ffEngWant.toFixed(4)}）`);
  await tap('[data-testid=dub-speed-preset][data-rate="1"]');
  await tap('[data-testid=dub-quick-off]');
  let ffBackRate = 0;
  for (let i = 0; i < 40 && ffBackRate !== 1; i++) {
    await sleep(150);
    await b.switchTo(dubPage);
    ffBackRate = await b.exec(`return document.querySelector('video').playbackRate;`);
    await b.switchTo(handles.panel);
  }
  ffEngRec = await ffDubRec();
  for (let i = 0; i < 40 && (ffEngRec?.englishRate !== undefined || ffEngRec?.overallRate !== undefined); i++) {
    await sleep(150);
    ffEngRec = await ffDubRec();
  }
  check(ffBackRate === 1 && ffEngRec?.englishRate === undefined && ffEngRec?.overallRate === undefined, 'Firefox：整体倍速调回 1×、切回手动对齐后，视频回到 1 倍');
  await b.switchTo(dubPage);
  await b.exec(`document.querySelector('video').pause(); return true;`);
  await b.switchTo(handles.panel);
  for (let i = 0; i < 20 && (await dubState())?.playing; i++) await sleep(150);
  // 视频控制键（DECISIONS §85）：这时视频停着。前进 30 秒 → 视频跳过去、仍停着，配音的位置跟过去；点"播放"接着放
  // 先把视频放到一个确定的地方（0:10，停着）：后面看字幕要落在中文的 92 秒以内
  await b.switchTo(dubPage);
  await b.exec(`document.querySelector('video').currentTime = 10; return true;`);
  await b.switchTo(handles.panel);
  dubS = await dubState();
  for (let i = 0; i < 40 && !(Math.abs(dubS.videoTime - 10) < 0.3 && Math.abs(dubS.dubTime - 10) < 0.5); i++) {
    await sleep(150);
    dubS = await dubState();
  }
  const ffBefore = dubS.videoTime;
  await tap('[data-testid=dub-seek][data-by="30"]');
  dubS = await dubState();
  for (let i = 0; i < 40 && !(Math.abs(dubS.videoTime - (ffBefore + 30)) < 0.3 && Math.abs(dubS.dubTime - dubS.videoTime) < 0.5); i++) {
    await sleep(150);
    dubS = await dubState();
  }
  check(
    Math.abs(dubS.videoTime - (ffBefore + 30)) < 0.3 && Math.abs(dubS.dubTime - dubS.videoTime) < 0.5 && dubS.playing === false,
    `Firefox：视频控制键"30 秒 »"——视频 ${Number(ffBefore).toFixed(2)} → ${Number(dubS.videoTime).toFixed(2)} 秒，仍停着，配音跟到 ${Number(dubS.dubTime).toFixed(2)} 秒`,
  );
  await tap('[data-testid=dub-play]');
  dubS = await dubState();
  for (let i = 0; i < 40 && !dubS?.playing; i++) {
    await sleep(150);
    dubS = await dubState();
  }
  check(dubS?.playing === true && dubS.videoPlaying === true, 'Firefox：视频控制键"播放"——视频接着放，配音跟着放');
  // 配音字幕（DECISIONS §86）：选一个中英双语的字幕文件 → 只留中文那几行 → 画面上显示配音此刻说到的那一句
  await b.exec(
    `const srt = Array.from({ length: 23 }, (_, i) => { const at = (s) => '00:' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') + ',000'; return (i + 1) + '\\n' + at(i * 4) + ' --> ' + at(i * 4 + 4) + '\\n第 ' + i + ' 句中文配音\\nEnglish line ' + i + '\\n'; }).join('\\n');
     const dt = new DataTransfer(); dt.items.add(new File([srt], '配音.zh-en.srt', { type: 'application/x-subrip' }));
     const input = document.querySelector('[data-testid=dub-subs-file]'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true;`,
  );
  let ffSubsRec = await ffDubRec();
  for (let i = 0; i < 40 && !ffSubsRec?.subs; i++) {
    await sleep(150);
    ffSubsRec = await ffDubRec();
  }
  check(ffSubsRec?.subs?.count === 23 && ffSubsRec.subs.lang === 'zh' && ffSubsRec.subs.reduced === true, `Firefox：选中英双语的字幕文件，只留中文那几行：${JSON.stringify(ffSubsRec?.subs)}`);
  const ffOverlay = () =>
    b.exec(
      `const host = document.querySelector('#movie_player [data-tubemuse="dubsubs"]'); const wrap = host?.shadowRoot?.querySelector('.wrap'); const line = host?.shadowRoot?.querySelector('.line');
       return wrap && line && !wrap.hidden ? { text: line.textContent, color: getComputedStyle(line).color } : null;`,
    );
  /** @type {any} */
  let ffSub = null;
  let ffSubOk = false;
  for (let i = 0; i < 60 && !ffSubOk; i++) {
    // 字幕层在视频页里读，配音的位置回侧边栏问（扩展接口只在扩展页面里有）：前后各问一次位置，字幕是这段时间里的某一句就算对
    const st0 = await dubState();
    await b.switchTo(dubPage);
    ffSub = await ffOverlay();
    await b.switchTo(handles.panel);
    const st1 = await dubState();
    const from = Math.floor((st0.dubTime - 0.4) / 4);
    const to = Math.floor((st1.dubTime + 0.4) / 4);
    ffSubOk = !!ffSub && Array.from({ length: to - from + 1 }, (_, k) => `第 ${from + k} 句中文配音`).includes(ffSub.text);
    if (!ffSubOk) await sleep(150);
  }
  check(ffSubOk && ffSub.color === 'rgb(255, 255, 255)', `Firefox：配音字幕层叠在播放器里，显示配音此刻说到的那一句（"${ffSub?.text}"，默认白字）`);
  await tap('[data-testid=dub-subs-show]');
  await b.switchTo(dubPage);
  await b.waitFor(`!document.querySelector('[data-tubemuse="dubsubs"]')`, { what: '去掉"显示"后字幕层拿掉' });
  check(true, 'Firefox：去掉"显示配音字幕"的勾，字幕层从页面上拿掉');
  await b.exec(`document.querySelector('video').pause(); return true;`);
  await b.switchTo(handles.panel);
  await tap('[data-testid=dub-subs-show]');
  await tap('[data-testid=dub-toggle]');
  await b.switchTo(dubPage);
  let ffBack = 0;
  for (let i = 0; i < 20 && Math.abs(ffBack - 1) > 0.005; i++) {
    ffBack = await b.exec(`return document.querySelector('video').volume;`);
    if (Math.abs(ffBack - 1) > 0.005) await sleep(150);
  }
  await b.switchTo(handles.panel);
  check(Math.abs(ffBack - 1) < 0.005, `Firefox：关闭配音，原声恢复（${ffBack}）`);
  // 从配音音频识别字幕（DECISIONS §91）：没有字幕文件时，在 Firefox 的侧边栏页面里把配音的 m4a 解码（AAC → decodeAudioData）、
  // 按停顿切句、一句一句发去转写、校对，存成这个配音的字幕（和字幕文件同一个键）
  await b.run(
    `const { secrets } = await browser.storage.local.get('secrets');
     await browser.storage.local.set({ secrets: { ...(secrets ?? {}), openaiApiKey: secrets?.openaiApiKey ?? 'e2e-openai-test-key-not-real' } });
     return true;`,
  );
  const ffSentBefore = dubTranscribes.length;
  await tap('[data-testid=dub-subs-asr]');
  await b.waitFor(`!!document.querySelector('[data-testid=dub-asr-estimate]')`, { what: '识别前先给预计花费' });
  const ffPlan = String(await b.exec(`return document.querySelector('[data-testid=dub-asr-plan]').textContent;`)).replace(/\s+/g, ' ');
  await tap('[data-testid=dub-asr-start]');
  await b.waitFor(`!!document.querySelector('[data-testid=dub-asr-done]') || !!document.querySelector('[data-testid=dub-asr-error]')`, { what: '从配音音频识别字幕', timeout: 90_000 });
  const ffAsr = await b.run(
    `const all = await browser.storage.local.get(null);
     return { subs: all.dubs?.dubVideo0001?.subs, cues: all['dubSubs:dubVideo0001']?.cues ?? [], left: 'dubAsr:dubVideo0001' in all, error: document.querySelector('[data-testid=dub-asr-error]')?.textContent ?? '' };`,
  );
  // 夹具：第 k 段音从 0.5 + 3k 秒响 1.8 秒；mock 转写从收到的音频里认出是第几段
  const ffKs = /** @type {any[]} */ (ffAsr.cues).map((c) => Number(/第(\d+)段/.exec(c.text)?.[1] ?? -1));
  const ffOff = /** @type {any[]} */ (ffAsr.cues).map((c, i) => c.start - (0.5 + 3 * i));
  check(
    ffPlan.includes('一句一句发往 OpenAI') && /预计约 \$0\.00\d+/.test(ffPlan) && ffAsr.subs?.source === 'asr' && ffAsr.subs.count === 30 && ffKs.every((k, i) => k === i) && ffAsr.cues.every((/** @type {any} */ c) => c.text.endsWith('（校）')) && !ffAsr.left && dubTranscribes.length - ffSentBefore === 30,
    `Firefox：从配音音频识别字幕——先给预计花费，30 句都识别出来、按顺序、校对过，存成这个配音的字幕${ffAsr.error ? `（出错：${ffAsr.error}）` : ''}`,
  );
  check(ffOff.length === 30 && ffOff.every((d) => d > -0.4 && d < 0.15), `Firefox：字幕的时间按配音文件自己的时间，每句的开始对得上那段音（句首留白 ${Math.min(...ffOff).toFixed(2)}～${Math.max(...ffOff).toFixed(2)} 秒）`);
  await tap('[data-testid=dub-remove]');
  await tap('[data-testid=dub-remove-yes]');
  await b.waitFor(`!!document.querySelector('[data-testid=dub-pick]')`, { what: '移除后回到选文件' });
  check(
    JSON.stringify(await b.run(`return (await browser.storage.local.get('dubs')).dubs;`)) === '{}' && (await b.run(`return 'dubSubs:dubVideo0001' in (await browser.storage.local.get(null));`)) === false,
    'Firefox：移除后对应关系清空，这个配音的字幕也删掉',
  );
  await closeTab(dubPage);

  console.log('\n[中文配音：保存完整双语视频（DECISIONS §83）——Firefox 里选原视频文件、离线合成、自动下载，不播放]');
  await tapText('配音', '[role=tab]');
  const fullPage = await openActiveTab(`${MOCK}/watch?v=dubFull00001`);
  await b.switchTo(fullPage);
  await b.waitFor(`(document.querySelector('video')?.readyState ?? 0) >= 2`, { timeout: 30_000, what: '视频可以播放' });
  await b.switchTo(handles.panel);
  await b.waitFor(`!!document.querySelector('[data-testid=dub-pick]')`, { what: '可以选文件' });
  /** 测试里没有文件对话框：把文件放进文件框（和你在对话框里选中一样触发 change） */
  const chooseFile = (/** @type {string} */ testId, /** @type {string} */ path, /** @type {string} */ name, /** @type {string} */ type) =>
    b.exec(
      `const bytes = Uint8Array.from(atob(arguments[0]), (c) => c.charCodeAt(0));
       const dt = new DataTransfer(); dt.items.add(new File([bytes], arguments[2], { type: arguments[3] }));
       const input = document.querySelector('[data-testid=' + arguments[1] + ']'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true;`,
      [readFileSync(path).toString('base64'), testId, name, type],
    );
  await chooseFile('dub-file', join(root, 'tests', 'fixtures', 'xyz-tones.m4a'), 'xyz-tones.m4a', 'audio/mp4');
  await b.waitFor(`!!document.querySelector('[data-testid=dub-done]')`, { timeout: 15_000, what: '关联好了' });
  // 一个对齐点：视频 8 秒 ↔ 中文 30.5 秒（和 Chrome 的测试一样）
  await b.run(`const { dubs } = await browser.storage.local.get('dubs'); dubs.dubFull00001.anchors = [{ video: 8, dub: 30.5 }]; await browser.storage.local.set({ dubs });`);
  await b.waitFor(`(document.querySelector('[data-testid=dub-full-about]')?.textContent ?? '').includes('全部 1 个对齐点') && !document.querySelector('[data-testid=dub-full-pick]').disabled`, { what: '可以选原视频文件' });
  // 带上原声字幕（DECISIONS §84）：默认勾着；这里事先选一个字幕文件（.srt），合成时写成视频里的一条字幕轨
  const FF_SRT = '1\n00:00:00,500 --> 00:00:03,000\nSo in college,\n\n2\n00:00:03,100 --> 00:00:06,000\nI was a government major,\n';
  await b.exec(
    `const dt = new DataTransfer(); dt.items.add(new File([arguments[0]], 'talk.en.srt', { type: 'application/x-subrip' }));
     const input = document.querySelector('[data-testid=dub-full-subs-file]'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true;`,
    [FF_SRT],
  );
  await b.waitFor(`(document.querySelector('[data-testid=dub-full-subs-chosen]')?.textContent ?? '').includes('2 句')`, { what: '字幕文件读出来了' });
  check((await b.exec(`return document.querySelector('[data-testid=dub-full-subs]').checked;`)) === true, 'Firefox："带上原声字幕"默认勾着，选的字幕文件读出 2 句');
  const fullBefore = downloaded();
  const fullStarted = Date.now();
  await chooseFile('dub-full-file', join(root, 'tests', 'fixtures', 'dub-source.mp4'), 'dub-source.mp4', 'video/mp4');
  const fullFile = await waitDownload(fullBefore, /_双语完整版\.mp4$/, 60_000);
  const fullWall = Date.now() - fullStarted;
  await b.waitFor(`document.querySelector('[data-testid=dub-export]')?.getAttribute('data-phase') === 'done'`, { what: '合成好了' });
  const fullDone = ((await text('[data-testid=dub-export-done]')) ?? '').replace(/\s+/g, ' ');
  check(fullWall < 8000 && fullDone.includes('全片 0:16') && fullDone.includes('画面原样照搬'), `Firefox：选好原视频文件后 ${(fullWall / 1000).toFixed(1)} 秒文件就下载好了（视频长 16 秒），没有播放：${fullDone}`);
  const fullBytes = readFileSync(join(downloads, fullFile));
  const sourceBytes = readFileSync(join(root, 'tests', 'fixtures', 'dub-source.mp4'));
  // 画面的数据原样在新文件里：原文件的数据区一开头就是第一帧画面（关键帧，2.5 KB），取它中间的 2000 个字节，在新文件里要能一字不差地找到
  const mdatAt = sourceBytes.indexOf(Buffer.from('mdat'));
  const keyframe = sourceBytes.subarray(mdatAt + 20, mdatAt + 2020);
  check(fullBytes.subarray(4, 8).toString() === 'ftyp' && mdatAt > 0 && fullBytes.includes(keyframe), `Firefox：新文件是 MP4，原文件第一帧画面的数据原样在里面（${fullBytes.length} 字节）`);
  const ffSubsLine = ((await text('[data-testid=dub-export-subs]')) ?? '').replace(/\s+/g, ' ');
  check(
    fullBytes.includes(Buffer.from('tx3g')) && fullBytes.includes(Buffer.from('So in college,')) && fullBytes.includes(Buffer.from('I was a government major,')) && ffSubsLine.includes('原声字幕：2 句') && ffSubsLine.includes('你选的字幕文件（talk.en.srt）'),
    `Firefox：新文件里有一条字幕轨，两句英文都在：${ffSubsLine.slice(0, 50)}…`,
  );
  await b.switchTo(fullPage);
  const fullInfo = await b.run(
    `const bytes = Uint8Array.from(atob(args[0]), (c) => c.charCodeAt(0));
     const ac = new AudioContext();
     const buf = await ac.decodeAudioData(bytes.buffer.slice(0));
     const ch = buf.getChannelData(0); const sr = buf.sampleRate;
     const amp = (hz, from, to) => { const a = Math.floor(from * sr), z = Math.min(ch.length, Math.floor(to * sr)), w = 2 * Math.PI * hz / sr; let re = 0, im = 0;
       for (let i = a; i < z; i++) { re += ch[i] * Math.cos(w * i); im -= ch[i] * Math.sin(w * i); } return z > a ? 2 * Math.sqrt(re * re + im * im) / (z - a) : -1; };
     const tones = []; for (let t = 0.5; t + 0.5 <= buf.duration - 0.5; t += 0.5) tones.push(amp(200, t, t + 0.5));
     let onset = -1; for (let s = 0; s < 4 && onset < 0; s += 0.005) if (amp(300, s, s + 0.02) > 0.15) onset = s;
     return { duration: buf.duration, tone: tones.sort((x, y) => x - y)[Math.floor(tones.length / 2)], first: amp(300, 1.2, 1.6), second: amp(320, 4.2, 4.6), jumped: amp(500, 8.7, 9.1), last: amp(540, 14.7, 15.1), wrong: amp(340, 8.7, 9.1), onset };`,
    [fullBytes.toString('base64')],
  );
  await b.switchTo(handles.panel);
  // 中文第 0、1 段音（300、320 Hz）在开头那一段；视频 8 秒处跳到中文 30.5 秒，之后是第 10、12 段（500、540 Hz）
  check(
    Math.abs(fullInfo.duration - 16) < 0.2 && Math.abs(fullInfo.tone - 0.16) < 0.02 && fullInfo.first > 0.2 && fullInfo.second > 0.2 && fullInfo.jumped > 0.2 && fullInfo.last > 0.2 && fullInfo.wrong < 0.05 && Math.abs(fullInfo.onset - 0.5) < 0.04,
    `Firefox：新文件的声音是整片（${Number(fullInfo.duration).toFixed(2)} 秒），原声按 80%（200 Hz 振幅 ${Number(fullInfo.tone).toFixed(3)}），中文按对齐点落在该在的时间上（1.4 秒 300 Hz ${Number(fullInfo.first).toFixed(2)}、4.4 秒 320 Hz ${Number(fullInfo.second).toFixed(2)}、8.9 秒 500 Hz ${Number(fullInfo.jumped).toFixed(2)}、14.9 秒 540 Hz ${Number(fullInfo.last).toFixed(2)}；第一段音在 ${Number(fullInfo.onset).toFixed(3)} 秒响起）`,
  );
  await tap('[data-testid=dub-remove]');
  await tap('[data-testid=dub-remove-yes]');
  await b.waitFor(`!!document.querySelector('[data-testid=dub-pick]')`, { what: '移除后回到选文件' });
  await closeTab(fullPage);

  console.log('\n[工具栏图标 → 打开 / 关上 Firefox 的侧边栏]');
  // Firefox 新装的扩展按钮收在"扩展"面板里：先固定到工具栏（就像你右键"固定到工具栏"），再真的点一下
  const widgetId = `${FIREFOX_E2E_ADDON_ID.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}-browser-action`;
  const pinned = await b.chrome(
    `const w = Services.wm.getMostRecentWindow('navigator:browser');
     w.CustomizableUI.addWidgetToArea(arguments[0], w.CustomizableUI.AREA_NAVBAR);
     return !!w.document.getElementById(arguments[0]);`,
    [widgetId],
  );
  check(pinned, `工具栏上有 TubeMuse 的按钮（${widgetId}）`);
  const sidebarState = () =>
    b.chrome(`const w = Services.wm.getMostRecentWindow('navigator:browser'); return { open: !!w.SidebarController?.isOpen, id: w.SidebarController?.currentID ?? '' };`);
  /** @param {boolean} open */
  const waitSidebar = async (open) => {
    const until = Date.now() + 8000;
    for (;;) {
      const st = await sidebarState();
      if (st.open === open && (!open || /sidebar-action/.test(st.id))) return st;
      if (Date.now() > until) return st;
      await sleep(250);
    }
  };
  const button = `#${widgetId} .unified-extensions-item-action-button`;
  await b.chromeClick(button);
  const opened = await waitSidebar(true);
  check(opened.open && opened.id.startsWith(widgetId.replace(/-browser-action$/, '')), `点工具栏上的 TubeMuse 图标：Firefox 的侧边栏打开了 TubeMuse（${opened.id || '没打开'}）`);
  const panelUrl = await b.chrome(
    `const w = Services.wm.getMostRecentWindow('navigator:browser'); return w.SidebarController?.browser?.contentDocument?.getElementById('webext-panels-browser')?.currentURI?.spec ?? '';`,
  );
  check(panelUrl === `${EXT}/sidepanel.html`, `侧边栏里装的是 TubeMuse 的侧边栏页面：${panelUrl}`);
  await b.chromeClick(button);
  const closed = await waitSidebar(false);
  check(!closed.open, '再点一下：侧边栏关上');
} catch (e) {
  failures++;
  console.error('\n✘ Firefox e2e 异常：', e);
  try {
    for (const h of await b.handles()) {
      await b.switchTo(h);
      await b.screenshot(join(shots, `error-${h.slice(0, 8)}.png`)).catch(() => undefined);
    }
  } catch {
    // 浏览器已经出问题了
  }
} finally {
  // 红线：除本机 mock 以外没有请求能出去（代理是死的）；这里核对 mock 只收到了预期的几类请求
  const paths = [...new Set(requests.map((r) => r.path.split('/').slice(0, 2).join('/')))];
  // /xpage 是故事读的仿 X 帖子页（页面本身，DECISIONS §88）
  check(paths.every((p) => ['/youtube', '/oauth', '/anthropic', '/openai', '/thumb', '/watch', '/media', '/api', '/xhs', '/gmail', '/xpage', '/xyz', '/xyzimg', '/xyzmedia', '/favicon.ico'].includes(p)), `mock 只收到预期的请求：${paths.join(' ')}`);
  // 扩展自己的报错（后台、页面、内容脚本）：Firefox 打到标准输出的 JavaScript 错误
  const extErrors = log.filter((l) => /JavaScript error|console\.error|Uncaught/.test(l) && (l.includes(UUID) || /content-[\w-]+\.js|TubeMuse/.test(l)));
  check(extErrors.length === 0, `扩展没有报错${extErrors.length ? `：\n    ${extErrors.slice(0, 10).join('\n    ')}` : ''}`);
  await m.send('Marionette:Quit').catch(() => undefined);
  m.close();
  await sleep(500);
  proc.kill();
  server.close();
  rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `\n✘ Firefox e2e 失败 ${failures} 项（截图在 test-results/e2e-firefox/）` : `\n✔ Firefox e2e 全部通过（截图在 test-results/e2e-firefox/）`);
process.exit(failures ? 1 : 0);
