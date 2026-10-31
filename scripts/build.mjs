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
const { ENDPOINTS, TRACKED_SITES, DOUBAN_IMAGE_ORIGINS } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
/** @type {string[]} */
const origins = [...new Set(Object.values(ENDPOINTS).map((u) => new URL(String(u)).origin))];
const imgOrigins = ['https://i.ytimg.com', ...DOUBAN_IMAGE_ORIGINS, ...(e2e ? origins.filter((o) => o.startsWith('http://127.0.0.1')) : [])];

// ── 打包 ──
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

/** e2e 构建时整体替换网络出口模块；正式构建不含任何测试代码 */
const swapPlugin = {
  name: 'tubemuse-e2e-swap',
  /** @param {import('esbuild').PluginBuild} build */
  setup(build) {
    if (!e2e) return;
    const swaps = { [join(root, 'src', 'config', 'endpoints.ts')]: 'endpoints.e2e.ts' };
    build.onResolve({ filter: /\/endpoints$/ }, (args) => {
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

// 内容脚本不能是 ES 模块：单独打成 IIFE
await esbuild.build({
  entryPoints: { 'content-tracker': join(root, 'src', 'content', 'tracker.ts') },
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
  // 只在 YouTube 播放页读取本地播放器状态做观看追踪
  content_scripts: [{ matches: [...TRACKED_SITES].map((o) => `${o}/*`), js: ['content-tracker.js'], run_at: 'document_idle' }],
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
  { re: /AAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]{30,}/, what: 'X Bearer Token' },
];
if (!e2e) {
  // 只查本项目自己的 mock 地址（SDK 内部有"仅允许 https 或 localhost"之类的无害字符串，不算）
  forbidden.push({ re: /127\.0\.0\.1:47321/, what: '本机测试地址' }, { re: /e2e-fake-token/, what: 'e2e 测试代码' });
}
// 红线：注入 YouTube 的脚本不得发网络请求、不得改动页面
const tracker = readFileSync(join(outdir, 'content-tracker.js'), 'utf8');
for (const bad of [/\bfetch\(/, /XMLHttpRequest/, /\.innerHTML\s*=/, /appendChild\(/, /insertAdjacent/, /\bWebSocket\b/, /sendBeacon/]) {
  if (bad.test(tracker)) fail(`内容脚本里出现了不允许的操作（${bad}）：它只能读取播放器状态。`);
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
