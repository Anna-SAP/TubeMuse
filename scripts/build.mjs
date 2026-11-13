// @ts-check
// 构建可直接"加载已解压的扩展程序"的目录。
//   npm run build              → dist/                （正式版：真实 API 地址，manifest 含固定 key，代码里注入 OAuth Client ID）
//   npm run build:e2e          → dist-e2e/            （测试版：所有外部服务与 Google 授权页都指向本机 mock）
//   npm run build:firefox      → dist-firefox/ + release/tubemuse-<版本>-firefox.xpi（Firefox 版，DECISIONS §69）
//   npm run build:firefox-e2e  → dist-firefox-e2e/    （Firefox 测试版，同样指向本机 mock）
//   --version=0.1.0.42         manifest 与安装包文件名用这个版本号，不用 package.json 的（发布用，DECISIONS §70）
// 同一份源码，两个浏览器只差 manifest 与少数几处由 __BROWSER__ 区分的地方（src/platform.ts）。
// manifest 的 host_permissions、CSP connect-src 与豆瓣图片的 img-src 都由 src/config/endpoints*.ts 生成，保证网络出口只有一个来源。
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromPublicKey } from './gen-key.mjs';
import { FIREFOX_ADDON_ID, FIREFOX_DATA_COLLECTION, FIREFOX_E2E_ADDON_ID, FIREFOX_MIN_VERSION, firefoxRedirectUrl } from './firefox.mjs';
import { SECRET_PATTERNS } from './secret-patterns.mjs';
import { isManifestVersion } from './version.mjs';
import { zipDirectory } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const e2e = process.argv.includes('--e2e');
const firefox = process.argv.includes('--firefox');
const outdir = join(root, `${firefox ? 'dist-firefox' : 'dist'}${e2e ? '-e2e' : ''}`);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const versionArg = process.argv.find((a) => a.startsWith('--version='))?.slice('--version='.length);
/** manifest 的版本号：Chrome 与 Firefox 都要求 1–4 段、每段 0–65535 的整数、不带前导 0 */
const version = versionArg ?? String(pkg.version);

/** @param {string} msg @returns {never} */
function fail(msg) {
  console.error(`\n构建失败：${msg}\n`);
  process.exit(1);
}

if (!isManifestVersion(version)) fail(`版本号 ${version} 不能用作扩展版本：要 1–4 段用点隔开的整数，每段 0–65535，不带前导 0（例如 0.1.0.42）。`);

// ── 本地私有配置 ──
// Chrome 用 manifest 的 key 固定扩展 ID；Firefox 用 gecko.id，不需要它
const keyPath = join(root, 'local', 'manifest-key.txt');
if (!firefox && !existsSync(keyPath)) fail('缺少 local/manifest-key.txt。先运行 npm run setup 生成扩展密钥（用于固定扩展 ID）。');
const manifestKey = firefox ? '' : readFileSync(keyPath, 'utf8').trim();
const extensionId = firefox ? '' : extensionIdFromPublicKey(manifestKey);
const geckoId = e2e ? FIREFOX_E2E_ADDON_ID : FIREFOX_ADDON_ID;
const firefoxRedirect = firefoxRedirectUrl(geckoId);
// OAuth Client ID（Google Cloud 里"Web 应用"类型的客户端）不是密钥，构建时注入代码；e2e 用假 ID。
// Firefox 测试版故意不注入：走"在设置页填 Client ID"那条路（别处打好、没带 Client ID 的安装包就是这样用的）
let oauthClientId = e2e && !firefox ? 'e2e-test-client.apps.googleusercontent.com' : '';
const configPath = join(root, 'local', 'config.json');
if (!e2e && existsSync(configPath)) {
  oauthClientId = String(JSON.parse(readFileSync(configPath, 'utf8')).oauthClientId ?? '').trim();
  if (oauthClientId && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(oauthClientId)) {
    fail(`local/config.json 里的 oauthClientId 看起来不对：${oauthClientId}（应形如 xxxx.apps.googleusercontent.com）`);
  }
}

// ── 读取网络出口（把 endpoints.ts 临时编译成 JS 再导入）──
const endpointsFile = join(root, 'src', 'config', e2e ? 'endpoints.e2e.ts' : 'endpoints.ts');
const compiled = await esbuild.build({ entryPoints: [endpointsFile], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const { ENDPOINTS, TRACKED_SITES, DOUBAN_IMAGE_ORIGINS, XYZ_IMAGE_ORIGINS, XHS_PAGES, EMAIL_PAGES, X_PAGES, KUBB_PAGES, IG_PAGES, DOUYIN_PAGES, BILI_PAGES, XYZ_PAGES } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
/** @type {string[]} */
const origins = [...new Set(Object.values(ENDPOINTS).map((u) => new URL(String(u)).origin))];
/**
 * manifest 里的网址匹配规则（host_permissions、内容脚本的 matches）。Firefox 的匹配规则不认端口：
 * 写成 http://127.0.0.1:47321/* 永远匹配不上（161 实测），去掉端口才行。正式版的网址都没有端口，只有测试版的本机 mock 受影响；
 * CSP 的 connect-src 认端口，照常写全。
 * @param {string} pattern
 */
const match = (pattern) => (firefox ? pattern.replace(/^(\w+:\/\/[^/:]+):\d+\//, '$1/') : pattern);
const imgOrigins = ['https://i.ytimg.com', ...DOUBAN_IMAGE_ORIGINS, ...XYZ_IMAGE_ORIGINS, ...(e2e ? origins.filter((o) => o.startsWith('http://127.0.0.1')) : [])];

// ── 打包 ──
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

/** e2e 构建时整体替换网络出口模块与浏览器语音识别（换成按脚本出字的假识别器）；正式构建不含任何测试代码 */
const swapPlugin = {
  name: 'tubemuse-e2e-swap',
  /** @param {import('esbuild').PluginBuild} build */
  setup(build) {
    if (!e2e) return;
    const swaps = {
      [join(root, 'src', 'config', 'endpoints.ts')]: 'endpoints.e2e.ts',
      [join(root, 'src', 'content', 'speech-engine.ts')]: 'speech-engine.e2e.ts',
    };
    build.onResolve({ filter: /\/(endpoints|speech-engine)$/ }, (args) => {
      const resolved = join(args.resolveDir, args.path + '.ts');
      const swap = swaps[resolved];
      return swap ? { path: join(dirname(resolved), swap) } : undefined;
    });
  },
};

await esbuild.build({
  entryPoints: {
    background: join(root, 'src', 'background.ts'),
    sidepanel: join(root, 'src', 'ui', 'sidepanel', 'main.tsx'),
    options: join(root, 'src', 'ui', 'options', 'main.tsx'),
    'mic-permission': join(root, 'src', 'ui', 'mic', 'main.ts'),
  },
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: firefox ? `firefox${parseInt(FIREFOX_MIN_VERSION)}` : 'chrome116',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  // 正式版不带 sourcemap（体积从 8MB 降到约 1.5MB）；e2e 版保留，便于排查测试失败
  sourcemap: e2e ? 'linked' : false,
  minify: false,
  legalComments: 'linked',
  chunkNames: 'chunks/[name]-[hash]',
  define: { 'process.env.NODE_ENV': '"production"', __OAUTH_CLIENT_ID__: JSON.stringify(oauthClientId), __BROWSER__: JSON.stringify(firefox ? 'firefox' : 'chrome') },
  plugins: [swapPlugin],
  logLevel: 'warning',
});

// 内容脚本不能是 ES 模块：单独打成 IIFE（观看追踪、自动字幕、片段录制、多语字幕、小红书及各自的页面内助手各一个文件，互不依赖）
await esbuild.build({
  entryPoints: {
    'content-tracker': join(root, 'src', 'content', 'tracker.ts'),
    'content-subtitles': join(root, 'src', 'content', 'subtitles.ts'),
    'content-clipper': join(root, 'src', 'content', 'clipper.ts'),
    'content-multicc': join(root, 'src', 'content', 'multi-captions.ts'),
    'content-multicc-bridge': join(root, 'src', 'content', 'multi-captions-bridge.ts'),
    'content-xhs': join(root, 'src', 'content', 'xhs.ts'),
    'content-xhs-bridge': join(root, 'src', 'content', 'xhs-bridge.ts'),
    'content-email': join(root, 'src', 'content', 'email.ts'),
    'content-xyz': join(root, 'src', 'content', 'xyz.ts'),
    'content-dub': join(root, 'src', 'content', 'dub.ts'),
  },
  outdir,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: firefox ? `firefox${parseInt(FIREFOX_MIN_VERSION)}` : 'chrome116',
  sourcemap: e2e ? 'linked' : false,
  minify: false,
  legalComments: 'none',
  define: { __BROWSER__: JSON.stringify(firefox ? 'firefox' : 'chrome') },
  plugins: [swapPlugin],
  logLevel: 'warning',
});

cpSync(join(root, 'static'), outdir, { recursive: true });

// ── manifest ──
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "style-src 'self'",
  `img-src 'self' data: blob: ${imgOrigins.join(' ')}`,
  `connect-src ${origins.join(' ')}`,
  "media-src 'none'",
  "frame-src 'none'",
].join('; ');

const icons = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };
/**
 * 两个浏览器不同的那几项（DECISIONS §69）：
 * - Chrome：key 固定扩展 ID；后台是 service worker；侧边栏是 side_panel（要 sidePanel 权限）；设置页 options_page。
 * - Firefox：gecko.id 固定扩展 ID（不认 key）；后台是事件页（background.scripts，Firefox 不支持扩展的 service worker）；
 *   侧边栏是 sidebar_action（不需要权限）；设置页 options_ui 在新标签页打开；不认 minimum_chrome_version。
 * @type {Record<string, unknown>}
 */
const browserSpecific = firefox
  ? {
      // data_collection_permissions：Mozilla 签名必填的数据收集声明（DECISIONS §71），Firefox 安装时列给你看
      browser_specific_settings: {
        gecko: { id: geckoId, strict_min_version: FIREFOX_MIN_VERSION, data_collection_permissions: { required: [...FIREFOX_DATA_COLLECTION.required] } },
      },
      permissions: ['storage', 'unlimitedStorage', 'identity', 'alarms'],
      background: { scripts: ['background.js'], type: 'module' },
      sidebar_action: { default_panel: 'sidepanel.html', default_title: 'TubeMuse', default_icon: icons, open_at_install: false },
      options_ui: { page: 'options.html', open_in_tab: true },
    }
  : {
      // e2e 版不带 key：避免与正式版同 ID 冲突
      ...(e2e ? {} : { key: manifestKey }),
      minimum_chrome_version: '116',
      permissions: ['storage', 'unlimitedStorage', 'sidePanel', 'identity', 'alarms'],
      background: { service_worker: 'background.js', type: 'module' },
      side_panel: { default_path: 'sidepanel.html' },
      options_page: 'options.html',
    };
/** @type {Record<string, unknown>} */
const manifest = {
  manifest_version: 3,
  name: e2e ? 'TubeMuse (E2E)' : 'TubeMuse',
  version,
  description: '按你的意图在 YouTube 找片：一句话找片、带理由的结果、打分让系统可见地变好。只读、本地优先。',
  ...browserSpecific,
  host_permissions: [...new Set(origins.map((o) => match(`${o}/*`)))],
  // 观看追踪：只读取本地播放器状态。自动字幕：播放时采集该视频音频交给后台转写，并在播放器内叠加只读字幕层。
  // 片段录制：你开始录制后才把这个视频的画面与声音录进内存，保存时交给浏览器存进下载文件夹。
  // 2026-11-04 起也录小红书的视频笔记（DECISIONS §43），2026-11-06 起也录 X 帖子里的视频（DECISIONS §52）：
  // 2026-11-10 起也录酷播播放页的视频（DECISIONS §54）。
  // 这几个站写在同一条里，同一个页面只注入一次。X 是单页应用，从时间线点进帖子不重新加载，所以要匹配整个 x.com；
  // 酷播同理（从首页点进 /play/<ID> 不重新加载），匹配整个 www.kubb.tv，脚本自己只认播放页
  // Instagram 同理（从别的页面回到首页不重新加载），匹配整个 www.instagram.com，脚本自己只认首页信息流
  // 抖音同理（在精选页点开视频、划到下一条都不重新加载），匹配整个 www.douyin.com，脚本自己只认精选页里打开的视频（?modal_id=）
  // B 站同理（换集、换分 P、连播、从列表里点下一个都不重新加载），匹配整个 www.bilibili.com，脚本自己只认页面的主播放器（DECISIONS §64）
  // 多语字幕：页面内助手（world: MAIN）只读字幕轨列表、开关播放器自己的字幕；另一个脚本复用播放器的字幕请求取你选的语言，叠加显示
  // 小红书（DECISIONS §40）：页面内助手（world: MAIN）只读页面数据里的发布时间；另一个脚本在笔记卡片上显示时间、放收藏按钮。都不发网络请求
  // eMails（DECISIONS §44）：只在侧边栏 eMails 页开着时回答"当前打开的邮件里有哪些文章"，不发网络请求，不写页面
  // 小宇宙（DECISIONS §72）：只认单集页；读这一集的信息、看 <audio> 的播放状态，向后台要音频段、送切好的句子，在页面上叠一层只读字幕。不发网络请求
  // 中文配音（DECISIONS §74）：你开启后，把后台从扩展 IndexedDB 交来的本地 .m4a 交给一个不放进页面的 <audio>，跟着视频播放、暂停、拖动；
  // 配音开着时原声降 20%。不发网络请求，不往页面插元素
  // 问 muse（DECISIONS §60、§63）：没有新脚本。片段录制脚本在你点「问 muse」时把当前这条视频 / 帖子读一次交给侧边栏；
  // 多语字幕脚本交出位置前后的字幕——已经读到的，或为这一次提问取一种语言（仍是下面检查的那唯一一处同源 /api/timedtext 请求）
  content_scripts: [
    { matches: [...TRACKED_SITES].map((o) => match(`${o}/*`)), js: ['content-tracker.js'], run_at: 'document_idle' },
    { matches: [...TRACKED_SITES].map((o) => match(`${o}/*`)), js: ['content-subtitles.js'], run_at: 'document_idle' },
    { matches: [...new Set([...[...TRACKED_SITES].map((o) => match(`${o}/*`)), ...[...XHS_PAGES, ...X_PAGES, ...KUBB_PAGES, ...IG_PAGES, ...DOUYIN_PAGES, ...BILI_PAGES].map((/** @type {string} */ p) => match(`${p}*`))])], js: ['content-clipper.js'], run_at: 'document_idle' },
    { matches: [...TRACKED_SITES].map((o) => match(`${o}/*`)), js: ['content-multicc-bridge.js'], run_at: 'document_idle', world: 'MAIN' },
    { matches: [...TRACKED_SITES].map((o) => match(`${o}/*`)), js: ['content-multicc.js'], run_at: 'document_idle' },
    { matches: XHS_PAGES.map((/** @type {string} */ p) => match(`${p}*`)), js: ['content-xhs-bridge.js'], run_at: 'document_idle', world: 'MAIN' },
    { matches: XHS_PAGES.map((/** @type {string} */ p) => match(`${p}*`)), js: ['content-xhs.js'], run_at: 'document_idle' },
    { matches: EMAIL_PAGES.map((/** @type {string} */ p) => match(`${p}*`)), js: ['content-email.js'], run_at: 'document_idle' },
    { matches: XYZ_PAGES.map((/** @type {string} */ p) => match(`${p}*`)), js: ['content-xyz.js'], run_at: 'document_idle' },
    { matches: [...TRACKED_SITES].map((o) => match(`${o}/*`)), js: ['content-dub.js'], run_at: 'document_idle' },
  ],
  commands: {
    'toggle-subtitles': { suggested_key: { default: 'Alt+Shift+S' }, description: '开关当前视频的自动字幕（在小宇宙单集页上开关这一集的字幕）' },
    'toggle-multi-captions': { suggested_key: { default: 'Alt+Shift+C' }, description: '开关当前视频的多语字幕（YouTube 原生字幕叠加显示）' },
    'toggle-clip-recording': { suggested_key: { default: 'Alt+Shift+R' }, description: '开始 / 停止录制当前视频的片段' },
  },
  action: { default_title: 'TubeMuse', default_icon: icons },
  icons,
  content_security_policy: { extension_pages: csp },
};
writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// ── 产物自检：不得含密钥、令牌；正式版不得含测试地址或测试代码 ──
/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const forbidden = [
  // 各家 Key / 令牌的格式与仓库自检（tests/unit/secret-hygiene.test.mjs）共用一份（DECISIONS §73）
  ...SECRET_PATTERNS,
  // 给 .crx 签名的私钥（local/extension-key.pem，发布时来自仓库 Secret，DECISIONS §70）只该用来签名，绝不能进安装包
  { re: /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/, what: '私钥' },
];
if (!e2e) {
  // 只查本项目自己的 mock 地址（SDK 内部有"仅允许 https 或 localhost"之类的无害字符串，不算）
  forbidden.push({ re: /127\.0\.0\.1:47321/, what: '本机测试地址' }, { re: /e2e-fake-token/, what: 'e2e 测试代码' }, { re: /data-fake-speech|FakeSpeechRecognition/, what: 'e2e 假语音识别器' });
}
// 红线：注入 YouTube 的脚本不得发网络请求、不得改动页面
const tracker = readFileSync(join(outdir, 'content-tracker.js'), 'utf8');
for (const bad of [/\bfetch\(/, /XMLHttpRequest/, /\.innerHTML\s*=/, /appendChild\(/, /insertAdjacent/, /\bWebSocket\b/, /sendBeacon/]) {
  if (bad.test(tracker)) fail(`内容脚本里出现了不允许的操作（${bad}）：它只能读取播放器状态。`);
}
// 红线（2026-11-01 变更）：字幕脚本可以采集音频、在播放器里加一层字幕，但不得自己发网络请求（音频经后台发往 OpenAI），
// 不得用 HTML 字符串写入页面（字幕文字只用 textContent），不得读写页面 Cookie，不得触发下载
const subtitles = readFileSync(join(outdir, 'content-subtitles.js'), 'utf8');
for (const bad of [/\bfetch\(/, /XMLHttpRequest/, /\bWebSocket\b/, /sendBeacon/, /\bEventSource\b/, /\.innerHTML\s*=/, /outerHTML\s*=/, /insertAdjacentHTML/, /document\.cookie/, /\.download\s*=/]) {
  if (bad.test(subtitles)) fail(`字幕脚本里出现了不允许的操作（${bad}）：它只能采音频、交给后台、画字幕层。`);
}
// 红线（2026-11-01 变更，DECISIONS §36）：片段录制脚本可以录这个视频的画面与声音、交给浏览器保存，
// 但不得发网络请求、不得往页面里插入任何元素（画布和下载链接都不放进页面）、不得用 HTML 字符串写页面、不得读写 Cookie。
// 2026-11-04 起它也注入小红书（DECISIONS §43），2026-11-06 起也注入 X（DECISIONS §52），2026-11-10 起也注入酷播（DECISIONS §54）、Instagram（DECISIONS §56）和抖音（DECISIONS §57），2026-11-11 起也注入 B 站（DECISIONS §64）：不得模拟事件；唯一的 .click() 是它自己不放进页面的下载链接
const clipper = readFileSync(join(outdir, 'content-clipper.js'), 'utf8');
if ((clipper.match(/\.click\(\)/g) ?? []).length !== 1) fail('片段录制脚本只能有一处 .click()（它自己的下载链接），不得点击页面上的任何东西。');
for (const bad of [
  /\bfetch\(/,
  /XMLHttpRequest/,
  /\bWebSocket\b/,
  /sendBeacon/,
  /\bEventSource\b/,
  /\.innerHTML\s*=/,
  /outerHTML\s*=/,
  /insertAdjacent/,
  /appendChild\(/,
  /\.append\(/,
  /\.prepend\(/,
  /insertBefore\(/,
  /replaceChildren\(/,
  /replaceWith\(/,
  /attachShadow\(/,
  /document\.cookie/,
  /getUserMedia|getDisplayMedia/,
  /dispatchEvent\(/,
  /localStorage|sessionStorage|indexedDB/,
]) {
  if (bad.test(clipper)) fail(`片段录制脚本里出现了不允许的操作（${bad}）：它只能录这个视频、交给浏览器保存。`);
}

// 红线（2026-11-02 变更，DECISIONS §37）：多语字幕脚本唯一的网络请求是复用播放器自己的字幕请求（同源 /api/timedtext），
// 只能有一处 fetch；不得用 HTML 字符串写页面、不得读写 Cookie、不得触发下载、不得带上跨站凭据
const multicc = readFileSync(join(outdir, 'content-multicc.js'), 'utf8');
if ((multicc.match(/\bfetch\(/g) ?? []).length !== 1 || !multicc.includes('/api/timedtext')) fail('多语字幕脚本只能有一处 fetch，且只取同源的 /api/timedtext。');
for (const bad of [/XMLHttpRequest/, /\bWebSocket\b/, /sendBeacon/, /\bEventSource\b/, /\.innerHTML\s*=/, /outerHTML\s*=/, /insertAdjacentHTML/, /document\.cookie/, /\.download\s*=/, /credentials:\s*["']include/]) {
  if (bad.test(multicc)) fail(`多语字幕脚本里出现了不允许的操作（${bad}）：它只能取当前视频的字幕、画字幕层。`);
}
// 页面内助手跑在 YouTube 页面自己的环境里：只读播放器的字幕轨列表、开关播放器自己的字幕；
// 不得发网络请求、不得往页面插元素或写 HTML、不得读页面文字、不得读写 Cookie / 本地存储、不得动态执行代码、不得用扩展接口
const bridge = readFileSync(join(outdir, 'content-multicc-bridge.js'), 'utf8');
for (const bad of [
  /\bfetch\(/,
  /XMLHttpRequest/,
  /\bWebSocket\b/,
  /sendBeacon/,
  /\bEventSource\b/,
  /innerHTML/,
  /outerHTML/,
  /insertAdjacent/,
  /appendChild\(/,
  /\.append\(/,
  /\.prepend\(/,
  /insertBefore\(/,
  /replaceChildren\(/,
  /replaceWith\(/,
  /attachShadow\(/,
  /\.textContent\b/,
  /\.innerText\b/,
  /document\.cookie/,
  /localStorage|sessionStorage|indexedDB/,
  /\beval\(|new Function\(/,
  /\bchrome\./,
]) {
  if (bad.test(bridge)) fail(`多语字幕的页面内助手里出现了不允许的操作（${bad}）：它只能读字幕轨列表、开关播放器的字幕。`);
}

// 小红书（2026-11-03 新增，DECISIONS §40）：页面脚本可以往笔记卡片里加时间与收藏按钮，但不得发任何网络请求、
// 不得用 HTML 字符串写页面、不得读写 Cookie / 页面的本地存储、不得点击或模拟点击小红书自己的按钮（不会替你收藏、点赞、关注）、
// 不得直接写扩展存储（收藏经后台校验后写入）、不得动态执行代码
const xhs = readFileSync(join(outdir, 'content-xhs.js'), 'utf8');
for (const bad of [
  /\bfetch\(/,
  /XMLHttpRequest/,
  /\bWebSocket\b/,
  /sendBeacon/,
  /\bEventSource\b/,
  /innerHTML/,
  /outerHTML/,
  /insertAdjacentHTML/,
  /document\.cookie/,
  /localStorage|sessionStorage|indexedDB/,
  /\.click\(\)/,
  /dispatchEvent\(/,
  /chrome\.storage\.local\.(set|remove|clear)\(/,
  /\beval\(|new Function\(/,
  /window\.open\(/,
  /\.download\s*=/,
]) {
  if (bad.test(xhs)) fail(`小红书脚本里出现了不允许的操作（${bad}）：它只能在卡片上显示时间、放收藏按钮。`);
}
// 小红书的页面内助手跑在小红书页面自己的环境里：只读页面数据里的发布时间；
// 不得发网络请求、不得碰页面元素（连 document 都不用）、不得读写 Cookie / 本地存储、不得动态执行代码、不得用扩展接口
const xhsBridge = readFileSync(join(outdir, 'content-xhs-bridge.js'), 'utf8');
for (const bad of [
  /\bfetch\(/,
  /XMLHttpRequest/,
  /\bWebSocket\b/,
  /sendBeacon/,
  /\bEventSource\b/,
  /\bdocument\./,
  /innerHTML|outerHTML|insertAdjacent/,
  /localStorage|sessionStorage|indexedDB/,
  /\beval\(|new Function\(/,
  /\bchrome\./,
]) {
  if (bad.test(xhsBridge)) fail(`小红书的页面内助手里出现了不允许的操作（${bad}）：它只能读页面数据里的发布时间。`);
}

// eMails（2026-11-04 新增，DECISIONS §44）：注入 Gmail 的脚本只读打开的这封邮件：不得发网络请求、不得写页面（一个元素都不加）、
// 不得点击或模拟事件（不会替你归档、删除、标记）、不得碰 Cookie / 本地存储 / 扩展存储、不得读收件人与发件人地址、不得自己观察页面
const email = readFileSync(join(outdir, 'content-email.js'), 'utf8');
for (const bad of [
  /\bfetch\(/,
  /XMLHttpRequest/,
  /\bWebSocket\b/,
  /sendBeacon/,
  /\bEventSource\b/,
  /innerHTML|outerHTML|insertAdjacent/,
  /appendChild\(/,
  /\.append\(/,
  /\.prepend\(/,
  /insertBefore\(/,
  /replaceChildren\(/,
  /replaceWith\(/,
  /createElement\(/,
  /attachShadow\(/,
  /setAttribute\(/,
  /\.click\(\)/,
  /dispatchEvent\(/,
  /document\.cookie/,
  /localStorage|sessionStorage|indexedDB/,
  /chrome\.storage/,
  /sendMessage\(/,
  /MutationObserver|setInterval/,
  /getAttribute\(["']email["']\)/,
  /\beval\(|new Function\(/,
  /window\.open\(/,
]) {
  if (bad.test(email)) fail(`邮件脚本里出现了不允许的操作（${bad}）：它只能在被问到时读打开的这封邮件。`);
}

// 小宇宙（2026-11-13 新增，DECISIONS §72）：注入小宇宙的脚本自己不发任何网络请求（音频由后台只从小宇宙 CDN 读），
// 不得用 HTML 字符串写页面、不得读写 Cookie / 页面的本地存储、不得点击或模拟点击小宇宙的按钮（不会替你订阅、收藏、点赞）、
// 不得触发下载、不得直接写扩展存储、不得动态执行代码、不得开麦克风或录屏
const xyzScript = readFileSync(join(outdir, 'content-xyz.js'), 'utf8');
for (const bad of [
  /\bfetch\(/,
  /XMLHttpRequest/,
  /\bWebSocket\b/,
  /sendBeacon/,
  /\bEventSource\b/,
  /innerHTML|outerHTML|insertAdjacentHTML/,
  /document\.cookie/,
  /localStorage|sessionStorage|indexedDB/,
  /\.click\(\)/,
  /dispatchEvent\(/,
  /chrome\.storage\.local\.(set|remove|clear)\(/,
  /\beval\(|new Function\(/,
  /window\.open\(/,
  /\.download\s*=/,
  /getUserMedia|getDisplayMedia/,
  /captureStream/,
]) {
  if (bad.test(xyzScript)) fail(`小宇宙脚本里出现了不允许的操作（${bad}）：它只能读这一集的信息、看播放状态、叠加字幕层。`);
}
// 小宇宙的音频 CDN 是新增的网络出口：只允许这一个，别的小宇宙域名（网站本身、图片 CDN）都不进 connect-src / host_permissions
if (origins.some((o) => /xiaoyuzhoufm\.com|image\.xyzcdn\.net/i.test(o))) fail('小宇宙网站与图片 CDN 不应出现在网络出口里：扩展只读 media.xyzcdn.net 上的音频。');

// 中文配音（2026-11-13 新增，DECISIONS §74）：注入 YouTube 的配音脚本只播放你为这个视频选的本地音频（由后台从扩展的 IndexedDB 交来）、
// 改 <video> 的音量（原声降 20%）。不得发任何网络请求、不得往页面插入元素或写 HTML（<audio> 不放进页面）、不得碰 Cookie / 页面存储、
// 不得点击或模拟事件、不得录音录屏或采集视频的声音、不得触发下载、不得直接写扩展存储、不得动态执行代码
const dubScript = readFileSync(join(outdir, 'content-dub.js'), 'utf8');
for (const bad of [
  /\bfetch\(/,
  /XMLHttpRequest/,
  /\bWebSocket\b/,
  /sendBeacon/,
  /\bEventSource\b/,
  /innerHTML|outerHTML|insertAdjacent/,
  /appendChild\(/,
  /\.append\(/,
  /\.prepend\(/,
  /insertBefore\(/,
  /replaceChildren\(/,
  /replaceWith\(/,
  /attachShadow\(/,
  /createElement\(/,
  /document\.cookie/,
  /localStorage|sessionStorage|indexedDB/,
  /\.click\(\)/,
  /dispatchEvent\(/,
  /getUserMedia|getDisplayMedia|captureStream/,
  /chrome\.storage\.local\.(set|remove|clear)\(/,
  /\beval\(|new Function\(/,
  /window\.open\(/,
  /\.download\s*=/,
]) {
  if (bad.test(dubScript)) fail(`配音脚本里出现了不允许的操作（${bad}）：它只能播放你选的配音、跟随视频、调原声音量。`);
}

// 「问 muse」（2026-11-11 新增，DECISIONS §60）：只生成一段文字，由你自己粘贴到 Muse。muse.ai 只由侧边栏在新标签页里打开：
// 不进网络出口（host_permissions / connect-src），注入网页的脚本里也不出现它的地址（它们不能替你打开或联系它）
if (origins.some((o) => /muse\.ai/i.test(o))) fail('muse.ai 不应出现在网络出口里：「问 muse」只生成文字，扩展不向 Muse 发请求。');
for (const file of readdirSync(outdir).filter((f) => /^content-.*\.js$/.test(f))) {
  if (/muse\.ai/i.test(readFileSync(join(outdir, file), 'utf8'))) fail(`注入网页的脚本 ${file} 里出现了 muse.ai：只有侧边栏能在新标签页里打开它。`);
}

for (const file of walk(outdir)) {
  if (!/\.(js|json|html|css|map|txt)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const { re, what } of forbidden) {
    if (re.test(text)) fail(`产物 ${relative(root, file)} 中出现了疑似${what}（${re}）。`);
  }
}

// Firefox 版的 manifest：不得带 Chrome 专有的项（Firefox 会报警告或直接拒绝），要带固定的 gecko.id（授权回跳地址靠它）
if (firefox) {
  const m = /** @type {any} */ (manifest);
  const chromeOnly = ['key', 'minimum_chrome_version', 'side_panel', 'options_page'].filter((k) => k in m);
  if (chromeOnly.length || m.permissions.includes('sidePanel') || m.background?.service_worker) fail(`Firefox 版 manifest 里混进了 Chrome 专有的项：${[...chromeOnly, 'sidePanel', 'service_worker'].join('、')}`);
  if (m.browser_specific_settings?.gecko?.id !== geckoId) fail('Firefox 版 manifest 没有固定的 gecko.id：授权回跳地址会每次都变');
  // Mozilla 签名必填；不能写 "none"——TubeMuse 确实会把数据发给你选的服务（DECISIONS §71）
  const dc = m.browser_specific_settings?.gecko?.data_collection_permissions;
  if (!Array.isArray(dc?.required) || !dc.required.length || dc.required.includes('none')) fail('Firefox 版 manifest 缺少如实的 data_collection_permissions：Mozilla 签名会被拒');
}

console.log(`✔ 已构建 ${relative(root, outdir)}/（版本 ${version}）`);
console.log(`  网络出口：${origins.join(', ')}`);
if (firefox) {
  console.log(`  Firefox 扩展 ID：${geckoId}`);
  console.log(`  授权回跳地址：${firefoxRedirect}（加到 Google Cloud"Web 应用"客户端的"已获授权的重定向 URI"）`);
}
if (firefox && !e2e) {
  // 打成 .xpi（就是 zip，manifest.json 在最上层）：about:debugging →「临时载入附加组件」可以直接选它
  const xpi = join(root, 'release', `tubemuse-${version}-firefox.xpi`);
  mkdirSync(dirname(xpi), { recursive: true });
  const { files, bytes } = zipDirectory(outdir, xpi);
  console.log(`  安装包：${relative(root, xpi)}（${files} 个文件，${(bytes / 1024).toFixed(0)} KB）`);
  console.log(
    oauthClientId
      ? `  OAuth Client ID：${oauthClientId}`
      : '  这个安装包没有带 OAuth Client ID：装好后在设置页「2. YouTube 账号」填，或写进 local/config.json 后重新构建。',
  );
}
if (!e2e && !firefox) {
  console.log(`  扩展 ID：${extensionId}`);
  console.log(`  授权回跳地址：https://${extensionId}.chromiumapp.org/（填到 Google Cloud"Web 应用"客户端的"已获授权的重定向 URI"）`);
  console.log(
    oauthClientId
      ? `  OAuth Client ID：${oauthClientId}`
      : '  ⚠ 还没有配置 OAuth Client ID：YouTube 授权暂不可用。按 README「Google Cloud 配置」创建"Web 应用"类型的客户端后写进 local/config.json，再运行 npm run build。',
  );
}
