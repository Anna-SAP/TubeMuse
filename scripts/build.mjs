// @ts-check
// 构建可直接"加载已解压的扩展程序"的目录。
//   npm run build      → dist/       （正式版：真实 API 地址，manifest 含固定 key，代码里注入 OAuth Client ID）
//   npm run build:e2e  → dist-e2e/   （测试版：所有外部服务与 Google 授权页都指向本机 mock）
// manifest 的 host_permissions、CSP connect-src 与豆瓣图片的 img-src 都由 src/config/endpoints*.ts 生成，保证网络出口只有一个来源。
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromPublicKey } from './gen-key.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const e2e = process.argv.includes('--e2e');
const outdir = join(root, e2e ? 'dist-e2e' : 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** @param {string} msg @returns {never} */
function fail(msg) {
  console.error(`\n构建失败：${msg}\n`);
  process.exit(1);
}

// ── 本地私有配置 ──
const keyPath = join(root, 'local', 'manifest-key.txt');
if (!existsSync(keyPath)) fail('缺少 local/manifest-key.txt。先运行 npm run setup 生成扩展密钥（用于固定扩展 ID）。');
const manifestKey = readFileSync(keyPath, 'utf8').trim();
const extensionId = extensionIdFromPublicKey(manifestKey);
// OAuth Client ID（Google Cloud 里"Web 应用"类型的客户端）不是密钥，构建时注入代码；e2e 用假 ID
let oauthClientId = e2e ? 'e2e-test-client.apps.googleusercontent.com' : '';
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
const { ENDPOINTS, TRACKED_SITES, DOUBAN_IMAGE_ORIGINS, XHS_PAGES, EMAIL_PAGES, X_PAGES, KUBB_PAGES, IG_PAGES, DOUYIN_PAGES } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
/** @type {string[]} */
const origins = [...new Set(Object.values(ENDPOINTS).map((u) => new URL(String(u)).origin))];
const imgOrigins = ['https://i.ytimg.com', ...DOUBAN_IMAGE_ORIGINS, ...(e2e ? origins.filter((o) => o.startsWith('http://127.0.0.1')) : [])];

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
  target: 'chrome116',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  // 正式版不带 sourcemap（体积从 8MB 降到约 1.5MB）；e2e 版保留，便于排查测试失败
  sourcemap: e2e ? 'linked' : false,
  minify: false,
  legalComments: 'linked',
  chunkNames: 'chunks/[name]-[hash]',
  define: { 'process.env.NODE_ENV': '"production"', __OAUTH_CLIENT_ID__: JSON.stringify(oauthClientId) },
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
  },
  outdir,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome116',
  sourcemap: e2e ? 'linked' : false,
  minify: false,
  legalComments: 'none',
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
/** @type {Record<string, unknown>} */
const manifest = {
  manifest_version: 3,
  name: e2e ? 'TubeMuse (E2E)' : 'TubeMuse',
  version: pkg.version,
  description: '按你的意图在 YouTube 找片：一句话找片、带理由的结果、打分让系统可见地变好。只读、本地优先。',
  // e2e 版不带 key：避免与正式版同 ID 冲突
  ...(e2e ? {} : { key: manifestKey }),
  minimum_chrome_version: '116',
  permissions: ['storage', 'unlimitedStorage', 'sidePanel', 'identity', 'alarms'],
  host_permissions: origins.map((o) => `${o}/*`),
  background: { service_worker: 'background.js', type: 'module' },
  side_panel: { default_path: 'sidepanel.html' },
  options_page: 'options.html',
  // 观看追踪：只读取本地播放器状态。自动字幕：播放时采集该视频音频交给后台转写，并在播放器内叠加只读字幕层。
  // 片段录制：你开始录制后才把这个视频的画面与声音录进内存，保存时交给浏览器存进下载文件夹。
  // 2026-11-04 起也录小红书的视频笔记（DECISIONS §43），2026-11-06 起也录 X 帖子里的视频（DECISIONS §52）：
  // 2026-11-10 起也录酷播播放页的视频（DECISIONS §54）。
  // 这几个站写在同一条里，同一个页面只注入一次。X 是单页应用，从时间线点进帖子不重新加载，所以要匹配整个 x.com；
  // 酷播同理（从首页点进 /play/<ID> 不重新加载），匹配整个 www.kubb.tv，脚本自己只认播放页
  // Instagram 同理（从别的页面回到首页不重新加载），匹配整个 www.instagram.com，脚本自己只认首页信息流
  // 抖音同理（在精选页点开视频、划到下一条都不重新加载），匹配整个 www.douyin.com，脚本自己只认精选页里打开的视频（?modal_id=）
  // 多语字幕：页面内助手（world: MAIN）只读字幕轨列表、开关播放器自己的字幕；另一个脚本复用播放器的字幕请求取你选的语言，叠加显示
  // 小红书（DECISIONS §40）：页面内助手（world: MAIN）只读页面数据里的发布时间；另一个脚本在笔记卡片上显示时间、放收藏按钮。都不发网络请求
  // eMails（DECISIONS §44）：只在侧边栏 eMails 页开着时回答"当前打开的邮件里有哪些文章"，不发网络请求，不写页面
  content_scripts: [
    { matches: [...TRACKED_SITES].map((o) => `${o}/*`), js: ['content-tracker.js'], run_at: 'document_idle' },
    { matches: [...TRACKED_SITES].map((o) => `${o}/*`), js: ['content-subtitles.js'], run_at: 'document_idle' },
    { matches: [...new Set([...[...TRACKED_SITES].map((o) => `${o}/*`), ...[...XHS_PAGES, ...X_PAGES, ...KUBB_PAGES, ...IG_PAGES, ...DOUYIN_PAGES].map((/** @type {string} */ p) => `${p}*`)])], js: ['content-clipper.js'], run_at: 'document_idle' },
    { matches: [...TRACKED_SITES].map((o) => `${o}/*`), js: ['content-multicc-bridge.js'], run_at: 'document_idle', world: 'MAIN' },
    { matches: [...TRACKED_SITES].map((o) => `${o}/*`), js: ['content-multicc.js'], run_at: 'document_idle' },
    { matches: XHS_PAGES.map((/** @type {string} */ p) => `${p}*`), js: ['content-xhs-bridge.js'], run_at: 'document_idle', world: 'MAIN' },
    { matches: XHS_PAGES.map((/** @type {string} */ p) => `${p}*`), js: ['content-xhs.js'], run_at: 'document_idle' },
    { matches: EMAIL_PAGES.map((/** @type {string} */ p) => `${p}*`), js: ['content-email.js'], run_at: 'document_idle' },
  ],
  commands: {
    'toggle-subtitles': { suggested_key: { default: 'Alt+Shift+S' }, description: '开关当前视频的自动字幕' },
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
  { re: /sk-ant-[A-Za-z0-9_-]{16,}/, what: 'Anthropic API Key' },
  { re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/, what: 'OpenAI API Key' },
  { re: /AIza[0-9A-Za-z_-]{35}/, what: 'Google API Key' },
  { re: /ya29\.[0-9A-Za-z_-]{20,}/, what: 'Google 访问令牌' },
  { re: /GOCSPX-[0-9A-Za-z_-]{20,}/, what: 'Google OAuth Client Secret' },
  { re: /\b1\/\/0[0-9A-Za-z_-]{30,}/, what: 'Google 刷新令牌' },
  { re: /AAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]{30,}/, what: 'X Bearer Token' },
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
// 2026-11-04 起它也注入小红书（DECISIONS §43），2026-11-06 起也注入 X（DECISIONS §52），2026-11-10 起也注入酷播（DECISIONS §54）、Instagram（DECISIONS §56）和抖音（DECISIONS §57）：不得模拟事件；唯一的 .click() 是它自己不放进页面的下载链接
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

for (const file of walk(outdir)) {
  if (!/\.(js|json|html|css|map|txt)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const { re, what } of forbidden) {
    if (re.test(text)) fail(`产物 ${relative(root, file)} 中出现了疑似${what}（${re}）。`);
  }
}

console.log(`✔ 已构建 ${relative(root, outdir)}/`);
console.log(`  网络出口：${origins.join(', ')}`);
if (!e2e) {
  console.log(`  扩展 ID：${extensionId}`);
  console.log(`  授权回跳地址：https://${extensionId}.chromiumapp.org/（填到 Google Cloud"Web 应用"客户端的"已获授权的重定向 URI"）`);
  console.log(
    oauthClientId
      ? `  OAuth Client ID：${oauthClientId}`
      : '  ⚠ 还没有配置 OAuth Client ID：YouTube 授权暂不可用。按 README「Google Cloud 配置」创建"Web 应用"类型的客户端后写进 local/config.json，再运行 npm run build。',
  );
}
