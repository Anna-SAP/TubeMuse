// @ts-check
// e2e 的公共部分：本机 mock 服务、加载了 dist-e2e/ 的 Chromium、网络护栏，
// 每一组开头都要走一遍的"设置"（填 Key、连接 YouTube），以及每一组结尾的网络红线。
// 各功能的检查在 parts/ 下；哪几部分放在一组里跑见 shards.json（DECISIONS §61）。
// 任何发往 mock 以外地址的请求都会被拦截并判失败（测试中不得发出真实网络请求）。
import { chromium } from 'playwright';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer, PORT, E2E_CLIENT_SECRET } from './mock-server.mjs';
import { X_GIF_POST } from './x-pages.mjs';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const extDir = join(root, 'dist-e2e');
export const shots = join(root, 'test-results', 'e2e');

export const FAKE_KEY = 'e2e-anthropic-test-key-not-real';
export const X_TOKEN = 'e2e-x-bearer-token-not-real-0123456789';
export const MOCK = `http://127.0.0.1:${PORT}`;

let failures = 0;
/** @param {boolean} cond @param {string} msg */
export function check(cond, msg) {
  console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`);
  if (!cond) failures++;
}
/** 中途抛出的异常也算一项失败 */
export function fail() {
  failures++;
}
export const failureCount = () => failures;

/** @typedef {Awaited<ReturnType<typeof launch>>} Launched */
/** @typedef {Awaited<ReturnType<typeof setup>>} Harness */

/** 启动 mock 服务与浏览器，装好网络护栏 */
export async function launch() {
  const { server, requests } = /** @type {{ server: import('node:http').Server; requests: any[] }} */ (await startMockServer());
  const userDataDir = mkdtempSync(join(tmpdir(), 'tubemuse-e2e-'));
  /** 用同一个用户目录启动浏览器（"重启浏览器"那一节还会再启动一次，验证重启后授权仍在） */
  const launchBrowser = () =>
    chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 420, height: 900 },
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--no-first-run',
        '--disable-default-apps',
        '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
  const context = await launchBrowser();

  /** @type {string[]} */
  const blocked = [];
  /** @type {{ url: string; referer: string | undefined }[]} */
  const doubanImages = [];
  /** 小宇宙的封面（image.xyzcdn.net）：在本地应答一张 PNG，带上真实 CDN 那样的 Access-Control-Allow-Origin: *，绝不出网 @type {{ url: string; referer: string | undefined }[]} */
  const xyzImages = [];
  const xyzCover = readFileSync(join(root, 'static', 'icons', 'icon-128.png'));
  /** 仿 X 的动图：测试现场录一小段视频填进来（setXGifBody），见下面的路由 @type {Buffer} */
  let xGifBody = Buffer.alloc(0);
  /** 网络护栏：只放行扩展自身与本机 mock，其余一律在本地应答或拦下并记为失败 */
  const guard = (/** @type {import('playwright').Route} */ route) => {
    const url = route.request().url();
    if (url.startsWith('chrome-extension://') || url.startsWith(MOCK) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    // 授权回跳地址由浏览器截获；万一真的发起加载，也在本地应答，绝不出网
    if (/^https:\/\/[a-p]{32}\.chromiumapp\.org\//.test(url)) return route.fulfill({ status: 200, body: '' });
    // 豆瓣海报：在本地应答 418，模拟豆瓣对外站加载图片的防盗链（实测真实浏览器直接打开也是 418），绝不出网
    if (/^https:\/\/img\d\.doubanio\.com\//.test(url)) {
      doubanImages.push({ url, referer: route.request().headers().referer });
      return route.fulfill({ status: 418, body: '' });
    }
    if (url.startsWith('https://image.xyzcdn.net/')) {
      xyzImages.push({ url, referer: route.request().headers().referer });
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: xyzCover });
    }
    // X 的动图：跨站视频（实测真实页面就是 video.twimg.com 的地址，不是 blob:），在本地应答，绝不出网
    if (url === X_GIF_POST.src) return route.fulfill({ status: 200, contentType: 'video/webm', body: xGifBody });
    blocked.push(url);
    return route.abort();
  };
  await context.route('**/*', guard);

  /** @type {string[]} */
  const consoleErrors = [];

  return {
    server,
    requests,
    userDataDir,
    launchBrowser,
    /** "重启浏览器"那一节会换成新的 */
    context,
    guard,
    blocked,
    doubanImages,
    xyzImages,
    consoleErrors,
    setXGifBody: (/** @type {Buffer} */ body) => {
      xGifBody = body;
    },
  };
}

/**
 * 每一组开头：等扩展加载完，在设置页填 Key、连接 YouTube。之后各部分共用这些页面与状态。
 * @param {Launched} base
 */
export async function setup(base) {
  const { context, requests, consoleErrors } = base;
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  console.log(`扩展已加载：${extId}`);

  // ── 设置页 ──
  console.log('\n[设置]');
  // 首次安装时扩展会自己打开设置页：等它出现并复用，避免两次导航互相打断
  const optionsUrl = `chrome-extension://${extId}/options.html`;
  let options = context.pages().find((p) => p.url().startsWith(optionsUrl));
  options ??= await context.waitForEvent('page', { predicate: (p) => p.url().startsWith(optionsUrl), timeout: 5000 }).catch(() => undefined);
  if (!options) {
    options = await context.newPage();
    await options.goto(optionsUrl);
  }
  options.on('console', (m) => m.type() === 'error' && consoleErrors.push(`options: ${m.text()}`));
  options.on('pageerror', (e) => consoleErrors.push(`options pageerror: ${e.message}`));
  await options.waitForLoadState('domcontentloaded');
  check(true, '首次安装自动打开设置页');
  await options.getByTestId('anthropic-key').fill(FAKE_KEY);
  await options.locator('#llm .btn', { hasText: '保存' }).first().click();
  // 等输入框的 placeholder 换成"已保存"（原先等的是页面文字，而这句话只写在 placeholder 里，每次都白等满 30 秒；DECISIONS §61）
  await options.getByTestId('anthropic-key').and(options.locator('[placeholder="已保存（出于安全不回显）"]')).waitFor({ state: 'attached', timeout: 5000 }).catch(() => undefined);
  const keyInput = await options.getByTestId('anthropic-key').getAttribute('placeholder');
  check(keyInput === '已保存（出于安全不回显）', '保存 Anthropic Key 后输入框不回显 Key');
  const readAuth = async (/** @type {import('playwright').Worker} */ w = sw) => /** @type {any} */ (await w.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('youtubeAuth'))).youtubeAuth;
  const tokenGrants = (/** @type {string} */ grant) => requests.filter((r) => r.path === '/oauth/token' && new URLSearchParams(r.body).get('grant_type') === grant);
  // 没填 Client Secret 就点"连接"：说清楚要先填什么，不弹授权窗口
  await options.getByRole('button', { name: '连接 YouTube' }).click();
  await options.getByText('还没有填写 Google OAuth Client Secret').waitFor({ timeout: 5000 });
  check(requests.filter((r) => r.path === '/oauth/authorize').length === 0, '没填 Client Secret 就点"连接"：说明要先填它，不弹授权窗口');
  await options.getByTestId('google-client-secret').fill(E2E_CLIENT_SECRET);
  await options.locator('#youtube .btn', { hasText: '保存' }).first().click();
  await options.getByTestId('google-client-secret').and(options.locator('[placeholder="已保存（出于安全不回显）"]')).waitFor({ state: 'attached' });
  check(true, '保存 Client Secret 后输入框不回显');
  await options.getByRole('button', { name: '连接 YouTube' }).click();
  await options.getByTestId('auth-status').filter({ hasText: '自动续期已开启' }).waitFor({ timeout: 15000 });
  const authReq = requests.filter((r) => r.path === '/oauth/authorize');
  check(authReq.length === 1, 'YouTube 已连接（launchWebAuthFlow → mock 授权页 → 回跳授权码 → 换令牌）');
  const aq = authReq[0]?.query ?? {};
  check(
    aq.response_type === 'code' &&
      aq.access_type === 'offline' &&
      aq.prompt === 'consent select_account' &&
      aq.code_challenge_method === 'S256' &&
      /^[A-Za-z0-9_-]{43}$/.test(aq.code_challenge ?? '') &&
      aq.scope === 'https://www.googleapis.com/auth/youtube.readonly' &&
      aq.redirect_uri === `https://${extId}.chromiumapp.org/` &&
      /^[0-9a-f]{32}$/.test(aq.state ?? '') &&
      !('include_granted_scopes' in aq) &&
      !JSON.stringify(aq).includes(E2E_CLIENT_SECRET),
    '授权请求只申请 youtube.readonly，要刷新令牌（offline）、带 PKCE 与随机 state，Client Secret 不进授权地址',
  );
  const exchange = tokenGrants('authorization_code');
  const ef = new URLSearchParams(exchange[0]?.body ?? '');
  check(
    exchange.length === 1 && exchange[0]?.method === 'POST' && ef.get('client_secret') === E2E_CLIENT_SECRET && !!ef.get('code_verifier') && ef.get('redirect_uri') === `https://${extId}.chromiumapp.org/` && !JSON.stringify(exchange[0]?.query).includes(E2E_CLIENT_SECRET),
    '换令牌：POST 到令牌端点，Client Secret 与 PKCE verifier 只在请求体里',
  );
  const linked = await readAuth();
  check(!!linked?.refreshToken && linked.expiresAt > Date.now() + 30 * 60_000, '存下了访问令牌与刷新令牌');
  check(((await options.getByTestId('refresh-note').textContent()) ?? '').includes('7 天'), '设置页说明刷新令牌的期限（测试状态 7 天）');
  check((await options.getByTestId('redirect-url').textContent()) === `https://${extId}.chromiumapp.org/`, '设置页显示授权回跳地址');
  await options.screenshot({ path: join(shots, '01-options.png'), fullPage: true });

  /** @type {import('playwright').Page | undefined} */
  let panel;
  /** 侧边栏（以标签页方式打开同一页面）。一组里的各部分共用同一个 */
  const openPanel = async () => {
    if (panel) return panel;
    panel = await base.context.newPage();
    // 豆瓣那段故意制造的两个失败（海报 418、不存在的条目 404）会被浏览器记成资源加载错误，不算页面错误
    const expectedDoubanFailure = (/** @type {import('playwright').ConsoleMessage} */ m) => /^https:\/\/img\d\.doubanio\.com\/|\/douban\/feed\/subject\/99999999\//.test(m.location().url);
    panel.on('console', (m) => m.type() === 'error' && !expectedDoubanFailure(m) && consoleErrors.push(`sidepanel: ${m.text()}`));
    panel.on('pageerror', (e) => consoleErrors.push(`sidepanel pageerror: ${e.message}`));
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    return panel;
  };

  return Object.assign(base, { sw, extId, options, readAuth, tokenGrants, openPanel });
}

/**
 * 每一组结尾：这一组里发出的所有请求都守住了网络红线。
 * @param {Harness} t
 * @param {Set<string>} ran 这一组跑了哪几部分（parts/ 下的名字）
 */
export function redLines(t, ran) {
  const { requests, blocked, consoleErrors } = t;
  // X 只在主流程里用到（Phase 3 填 Token、读热点）：别的组没有 X 请求，这几条在那里没有东西可查
  if (ran.has('core')) {
    console.log('\n[Phase 3：X 网络红线]');
    const xr = requests.filter((r) => r.path.startsWith('/x/'));
    check(xr.length > 0 && xr.every((r) => r.headers.authorization === `Bearer ${X_TOKEN}` && !JSON.stringify(r.query).includes(X_TOKEN)), 'X 请求只在请求头里带 Token');
    check(requests.filter((r) => !r.path.startsWith('/x/')).every((r) => !JSON.stringify(r).includes(X_TOKEN)), 'X Token 从未发往别处');
    check(xr.every((r) => !JSON.stringify(r).includes('e2e-fake-token')), 'YouTube 令牌从未发往 X');
    check(xr.every((r) => !String(r.query.expansions ?? '').length), '不展开作者信息（避免按用户对象另计费）');
    check(xr.every((r) => r.method === 'GET'), '对 X 只读（只有 GET，从不发帖/点赞/关注）');
  }

  console.log('\n[网络红线]');
  const llm = requests.filter((r) => r.path.startsWith('/anthropic'));
  const yt = requests.filter((r) => r.path.startsWith('/youtube'));
  // 片段那一组不调大模型：只在会调的组里要求"确实发过请求"
  const expectLlm = ['core', 'subtitles', 'emails', 'xyz'].some((p) => ran.has(p));
  check((!expectLlm || llm.length > 0) && llm.every((r) => String(r.headers.authorization ?? r.headers['x-api-key'] ?? '').includes(FAKE_KEY)), 'LLM 请求携带 Key（仅在请求头）');
  check(yt.every((r) => r.headers.authorization === 'Bearer e2e-fake-token'), 'YouTube 请求携带 OAuth 令牌（仅在请求头）');
  check(yt.every((r) => !JSON.stringify(r).includes(FAKE_KEY)), 'LLM Key 从未发往 YouTube');
  check(llm.every((r) => !JSON.stringify(r).includes('e2e-fake-token')), 'YouTube 令牌从未发往 LLM');
  check(requests.every((r) => !JSON.stringify(r.query).includes(FAKE_KEY)), 'Key 不出现在任何 URL 中');
  check(requests.filter((r) => r.path !== '/oauth/token').every((r) => !JSON.stringify(r).includes(E2E_CLIENT_SECRET)), 'Google Client Secret 只发往令牌端点');
  check(requests.filter((r) => r.path !== '/oauth/token' && r.path !== '/oauth/revoke').every((r) => !JSON.stringify(r).includes('e2e-refresh-')), '刷新令牌只发往令牌端点（与吊销端点）');
  check(blocked.length === 0, `没有发往 mock 以外的请求${blocked.length ? `：${blocked.join(', ')}` : ''}`);
  check(consoleErrors.length === 0, `页面没有控制台错误${consoleErrors.length ? `：\n    ${consoleErrors.join('\n    ')}` : ''}`);
}
