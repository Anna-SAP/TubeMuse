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
import { E2E_CLIENT_SECRET, PORT, startMockServer } from '../mock-server.mjs';
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
  check(JSON.stringify([...manifest.permissions].sort()) === JSON.stringify(['alarms', 'identity', 'storage', 'unlimitedStorage']), `权限：${manifest.permissions.join(', ')}（不需要 sidePanel，也没有 downloads / clipboardWrite / tabs）`);
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

  console.log('\n[片段录制：YouTube 播放页 → 开始 → 停止 → Firefox 存下 WebM（VP8 + Opus），有声音]');
  await tapText('片段', '[role=tab]');
  const watch = await openActiveTab(`${MOCK}/watch?v=clipFree0001`);
  await b.switchTo(watch);
  await b.waitFor(`(document.querySelector('video')?.readyState ?? 0) >= 2`, { timeout: 30_000, what: '视频可以播放' });
  await b.run(`await document.querySelector('video').play();`);
  await b.switchTo(handles.panel);
  await b.waitFor(`document.querySelector('[data-testid=clip-status]')?.textContent.includes('可以开始录制')`, { what: '可以开始录制' });
  // 页面从没被点过（视频是脚本放起来的）：Firefox 不让它处理声音，录制停下来说明怎么办，不录一段没声音的
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
  await b.exec(`document.querySelector('video').pause(); return true;`);
  await b.switchTo(handles.panel);
  check(Math.abs(ffVol - 0.8) < 0.005, `Firefox：原声降 20%（${ffVol}）`);
  for (let i = 0; i < 20 && (await dubState())?.playing; i++) await sleep(150);
  check((await dubState())?.playing === false, 'Firefox：视频暂停，配音跟着停');
  await tap('[data-testid=dub-toggle]');
  await b.switchTo(dubPage);
  let ffBack = 0;
  for (let i = 0; i < 20 && Math.abs(ffBack - 1) > 0.005; i++) {
    ffBack = await b.exec(`return document.querySelector('video').volume;`);
    if (Math.abs(ffBack - 1) > 0.005) await sleep(150);
  }
  await b.switchTo(handles.panel);
  check(Math.abs(ffBack - 1) < 0.005, `Firefox：关闭配音，原声恢复（${ffBack}）`);
  await tap('[data-testid=dub-remove]');
  await tap('[data-testid=dub-remove-yes]');
  await b.waitFor(`!!document.querySelector('[data-testid=dub-pick]')`, { what: '移除后回到选文件' });
  check(JSON.stringify(await b.run(`return (await browser.storage.local.get('dubs')).dubs;`)) === '{}', 'Firefox：移除后对应关系清空');
  await closeTab(dubPage);

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
  check(paths.every((p) => ['/youtube', '/oauth', '/anthropic', '/openai', '/thumb', '/watch', '/media', '/api', '/xhs', '/gmail', '/xyz', '/xyzimg', '/xyzmedia', '/favicon.ico'].includes(p)), `mock 只收到预期的请求：${paths.join(' ')}`);
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
