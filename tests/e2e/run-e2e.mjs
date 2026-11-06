// @ts-check
// 在 Playwright 自带的 Chromium 里加载 dist-e2e/，用本机 mock 服务跑通 Phase 1 主流程：
// 设置 Key → 连接 YouTube → 同步画像 → 生成兴趣簇 → 口令 → 回显 → 结果 → 打 3 分（归因）与 10 分 → 可见调整 → 重排 → 多约束口令。
// 之后是 Phase 2 / 3 与豆瓣评论 RSS 阅读器。
// 任何发往 mock 以外地址的请求都会被拦截并判失败（测试中不得发出真实网络请求）。
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer, PORT } from './mock-server.mjs';
import { XHS_N1, XHS_N2, XHS_N3, XHS_N4, XHS_UID, XHS_V1 } from './xhs-pages.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const extDir = join(root, 'dist-e2e');
const shots = join(root, 'test-results', 'e2e');
rmSync(shots, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });

const FAKE_KEY = 'e2e-anthropic-test-key-not-real';
const MOCK = `http://127.0.0.1:${PORT}`;

let failures = 0;
/** @param {boolean} cond @param {string} msg */
function check(cond, msg) {
  console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`);
  if (!cond) failures++;
}

const { server, requests } = /** @type {{ server: import('node:http').Server; requests: any[] }} */ (await startMockServer());
const userDataDir = mkdtempSync(join(tmpdir(), 'tubemuse-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
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

/** @type {string[]} */
const blocked = [];
/** @type {{ url: string; referer: string | undefined }[]} */
const doubanImages = [];
await context.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith('chrome-extension://') || url.startsWith(MOCK) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
  // 授权回跳地址由浏览器截获；万一真的发起加载，也在本地应答，绝不出网
  if (/^https:\/\/[a-p]{32}\.chromiumapp\.org\//.test(url)) return route.fulfill({ status: 200, body: '' });
  // 豆瓣海报：在本地应答 418，模拟豆瓣对外站加载图片的防盗链（实测真实浏览器直接打开也是 418），绝不出网
  if (/^https:\/\/img\d\.doubanio\.com\//.test(url)) {
    doubanImages.push({ url, referer: route.request().headers().referer });
    return route.fulfill({ status: 418, body: '' });
  }
  blocked.push(url);
  return route.abort();
});

/** @type {string[]} */
const consoleErrors = [];

try {
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
  await options.getByText('已保存（出于安全不回显）').first().waitFor({ state: 'attached' }).catch(() => undefined);
  const keyInput = await options.getByTestId('anthropic-key').getAttribute('placeholder');
  check(keyInput === '已保存（出于安全不回显）', '保存 Anthropic Key 后输入框不回显 Key');
  await options.getByRole('button', { name: '连接 YouTube' }).click();
  await options.getByTestId('auth-status').filter({ hasText: '已连接' }).waitFor({ timeout: 15000 });
  const authReq = requests.filter((r) => r.path === '/oauth/authorize');
  check(authReq.length === 1, 'YouTube 已连接（launchWebAuthFlow → mock 授权页 → 回跳）');
  const aq = authReq[0]?.query ?? {};
  check(
    aq.response_type === 'token' && aq.scope === 'https://www.googleapis.com/auth/youtube.readonly' && aq.redirect_uri === `https://${extId}.chromiumapp.org/` && aq.prompt === 'select_account' && /^[0-9a-f]{32}$/.test(aq.state ?? '') && !('include_granted_scopes' in aq),
    '授权请求只申请 youtube.readonly，回跳到 chromiumapp.org，带随机 state',
  );
  check((await options.getByTestId('redirect-url').textContent()) === `https://${extId}.chromiumapp.org/`, '设置页显示授权回跳地址');
  await options.screenshot({ path: join(shots, '01-options.png'), fullPage: true });

  // ── 授权过期 → 侧边栏"重新授权"，授权窗口还开着时把侧边栏关掉：令牌照样由后台存下（以前会静默丢失，横幅一直显示"已过期"）──
  console.log('\n[重新授权]');
  {
    const readAuth = async () => /** @type {any} */ (await sw.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('youtubeAuth'))).youtubeAuth;
    const before = await readAuth();
    await sw.evaluate((st) => /** @type {any} */ (globalThis).chrome.storage.local.set({ youtubeAuth: st }), {
      ...before,
      expiresAt: Date.now() - 60_000,
      renewFailedAt: Date.now(),
      renewReason: 'Google 要求重新登录（login_required）',
    });
    const reauthPanel = await context.newPage();
    reauthPanel.on('pageerror', (e) => consoleErrors.push(`reauth pageerror: ${e.message}`));
    await reauthPanel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await reauthPanel.getByText('YouTube 授权已过期').waitFor();
    check(((await reauthPanel.getByTestId('renew-reason').textContent()) ?? '').includes('login_required'), '横幅写明自动续期失败的具体原因');
    // 授权页像真实的 Google 一样停留几秒（用户在窗口里登录、选账号）
    await fetch(`${MOCK}/e2e/authorize-mode?mode=slow&delayMs=2500`);
    const authorizeBefore = requests.filter((r) => r.path === '/oauth/authorize').length;
    await reauthPanel.getByRole('button', { name: '重新授权' }).click();
    await reauthPanel.getByTestId('auth-pending').waitFor({ timeout: 5000 });
    check(true, '点"重新授权"后显示"授权窗口已打开"');
    await reauthPanel.close();
    let renewed;
    for (const end = Date.now() + 15000; Date.now() < end && !renewed; ) {
      const a = await readAuth();
      if (a?.expiresAt > Date.now() + 30 * 60_000 && !a.renewFailedAt) renewed = a;
      else await new Promise((r) => setTimeout(r, 300));
    }
    check(!!renewed, '授权窗口开着时关掉侧边栏：新令牌照样由后台存下，"已过期"标记清除');
    check(requests.filter((r) => r.path === '/oauth/authorize').length === authorizeBefore + 1, '只打开了一次授权窗口');
    await fetch(`${MOCK}/e2e/authorize-mode?mode=instant`);
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${extId}/sidepanel.html`);
    await reopened.getByRole('tab', { name: '找片' }).waitFor();
    await reopened.waitForTimeout(500);
    check((await reopened.getByText('YouTube 授权已过期').count()) === 0 && (await reopened.getByTestId('auth-pending').count()) === 0, '重新打开侧边栏：不再显示"已过期"');
    await reopened.close();
  }

  // ── 侧边栏（以标签页方式打开同一页面）──
  const panel = await context.newPage();
  // 豆瓣那段故意制造的两个失败（海报 418、不存在的条目 404）会被浏览器记成资源加载错误，不算页面错误
  const expectedDoubanFailure = (/** @type {import('playwright').ConsoleMessage} */ m) => /^https:\/\/img\d\.doubanio\.com\/|\/douban\/feed\/subject\/99999999\//.test(m.location().url);
  panel.on('console', (m) => m.type() === 'error' && !expectedDoubanFailure(m) && consoleErrors.push(`sidepanel: ${m.text()}`));
  panel.on('pageerror', (e) => consoleErrors.push(`sidepanel pageerror: ${e.message}`));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);

  console.log('\n[画像]');
  await panel.getByRole('tab', { name: '画像' }).click();
  await panel.getByRole('button', { name: '同步订阅与喜欢的视频' }).click();
  await panel.getByText(/同步完成/).waitFor();
  check(true, '同步订阅与喜欢的视频完成');
  await panel.getByRole('button', { name: /生成兴趣簇/ }).click();
  await panel.locator('.cluster').first().waitFor();
  const clusterCount = await panel.locator('.cluster').count();
  check(clusterCount === 2, `生成兴趣簇：${clusterCount} 个`);
  // 编辑一个簇（改权重）→ 自动加锁
  await panel.locator('.cluster').first().locator('input[type=range]').fill('1.5');
  await panel.locator('.cluster').first().getByText('已锁定').waitFor();
  check(true, '编辑兴趣簇后自动锁定');
  await panel.screenshot({ path: join(shots, '02-profile.png'), fullPage: true });

  console.log('\n[验收口令 1]');
  await panel.getByRole('tab', { name: '找片' }).click();
  await panel.locator('textarea.query').fill('帮我找两天内最新的 AI 技术科普视频');
  await panel.getByRole('button', { name: '找片' }).click();
  await panel.locator('.card').first().waitFor({ timeout: 20000 });

  // ── 导航栏图钉：固定后往下滚动仍可见（吸附在头部下沿、不透明、盖在正文之上），再点恢复随页面滚动 ──
  {
    const box = (/** @type {string} */ sel) =>
      panel.locator(sel).first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      });
    const pinBtn = panel.getByTestId('pin-nav');
    check((await pinBtn.getAttribute('aria-pressed')) === 'false', '导航栏默认随页面滚动（图钉未按下）');
    await panel.evaluate(() => window.scrollTo(0, 600));
    check((await box('[data-testid=nav]')).bottom < 0, '未固定时往下滚动，导航栏滚出视野');
    await panel.evaluate(() => window.scrollTo(0, 0));
    // 固定时外边距换成等量内边距：导航栏的框会变，但标签按钮和下面的正文都不应移动
    const tabBefore = await box('.tab');
    const mainBefore = await box('main');
    await pinBtn.click();
    await panel.getByTestId('nav').and(panel.locator('.pinned')).waitFor();
    const tabPinned = await box('.tab');
    const mainPinned = await box('main');
    check(
      Math.abs(tabPinned.top - tabBefore.top) < 1 && Math.abs(mainPinned.top - mainBefore.top) < 1 && (await pinBtn.getAttribute('aria-pressed')) === 'true',
      '点图钉固定：标签与正文位置不跳，图钉显示为按下',
    );
    await panel.evaluate(() => window.scrollTo(0, 600));
    await panel.getByTestId('nav').and(panel.locator('.stuck')).waitFor();
    const header = await box('header.top');
    const nav = await box('[data-testid=nav]');
    const onTop = await panel.evaluate((y) => !!document.elementFromPoint(200, y)?.closest('[data-testid=nav]'), (nav.top + nav.bottom) / 2);
    check(Math.abs(nav.top - header.bottom) < 1 && onTop, '固定后往下滚动：导航栏吸附在头部下沿，盖在滚过的正文之上');
    await panel.getByRole('tab', { name: '画像' }).click();
    const content = await box('main > :not([hidden])');
    check(content.top >= nav.bottom - 1 && content.top - nav.bottom < 30, '固定时切换标签页：回到新页面开头，紧贴导航栏下方、不被挡住');
    await panel.getByRole('tab', { name: '找片' }).click();
    // 另一个侧边栏（另一个窗口）同步这项设置
    const other = await context.newPage();
    await other.goto(`chrome-extension://${extId}/sidepanel.html`);
    await other.getByTestId('nav').and(other.locator('.pinned')).waitFor();
    check(true, '固定状态保存在本地设置里：重新打开侧边栏仍是固定的');
    await other.close();
    await pinBtn.click();
    await panel.getByTestId('nav').and(panel.locator('.pinned')).waitFor({ state: 'detached' });
    await panel.evaluate(() => window.scrollTo(0, 600));
    check((await box('[data-testid=nav]')).bottom < 0 && (await pinBtn.getAttribute('aria-pressed')) === 'false', '再点图钉取消固定：恢复随页面滚动');
    await panel.evaluate(() => window.scrollTo(0, 0));
  }

  const echoKinds = await panel.locator('.echo-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
  check(['recency', 'sort', 'topic', 'format'].every((k) => echoKinds.includes(k)), `回显包含全部约束：${echoKinds.join(', ')}`);
  const statuses = await panel.locator('.echo-row .status').allTextContents();
  check(statuses.length === echoKinds.length, `每个约束都有落实状态：${statuses.join(' / ')}`);
  const apiParams = await panel.locator('.echo-row[data-kind=recency] .d-api').allTextContents();
  check(apiParams.some((t) => t.includes('publishedAfter')), '时效落成 publishedAfter');
  const cards = panel.locator('.card');
  const n = await cards.count();
  check(n > 0 && n <= 10, `默认展示前 ${n} 条（≤10）`);
  const ids = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-video-id')));
  check(!ids.includes('ai09'), '超过两天的视频（ai09）被时效过滤掉');
  let allReasons = true;
  for (let i = 0; i < n; i++) {
    const r = await cards.nth(i).locator('.reasons li').count();
    if (r === 0) allReasons = false;
  }
  check(allReasons, '每条结果都有"为什么推给你"');
  const metaText = await cards.first().locator('.meta.muted').textContent();
  check(/\d+:\d{2}/.test(metaText ?? '') && /前/.test(metaText ?? '') && /播放/.test(metaText ?? ''), `结果卡含时长、发布时间、播放量级：${metaText}`);
  check((await panel.locator('.card .badge.sub').count()) > 0, '订阅频道的视频带"已订阅"标记');
  await panel.screenshot({ path: join(shots, '03-results.png'), fullPage: true });
  await panel.locator('.echo').screenshot({ path: join(shots, '03a-echo.png') });
  await panel.locator('.card').first().screenshot({ path: join(shots, '03b-card.png') });

  console.log('\n[打分]');
  const clickbait = panel.locator('.card[data-video-id=ai03]');
  if (await clickbait.count()) {
    await clickbait.locator('.rate-btn[data-rate="3"]').click();
    await clickbait.locator('.attrib').waitFor();
    check(true, '3 分 → 出现低分归因选项');
    await clickbait.locator('button[data-attr=retrieval]').click();
    await clickbait.getByTestId('adjustment').waitFor();
    const adjText = (await clickbait.getByTestId('adjustment').textContent()) ?? '';
    check(adjText.includes('因为这次打分') && adjText.includes('频道偏好'), '3 分（找错/排错）→ 展示具体调整');
    check(!/训练/.test(adjText), '调整说明里没有"训练"之类不实表述');
  } else {
    check(false, '结果里应包含 ai03（用于 3 分）');
  }
  const good = panel.locator('.card[data-video-id=ai04]');
  if (await good.count()) {
    await good.locator('.rate-btn[data-rate="10"]').click();
    await good.getByTestId('adjustment').waitFor();
    const t = (await good.getByTestId('adjustment').textContent()) ?? '';
    check(t.includes('更靠前'), '10 分 → 频道偏好上调，说明"之后会更靠前"');
  } else {
    check(false, '结果里应包含 ai04（用于 10 分）');
  }
  await panel.screenshot({ path: join(shots, '04-rated.png'), fullPage: true });
  if (await clickbait.count()) await clickbait.screenshot({ path: join(shots, '04a-rated-3.png') });
  if (await good.count()) await good.screenshot({ path: join(shots, '04b-rated-10.png') });

  await panel.getByRole('button', { name: '按新偏好重排当前结果' }).click();
  await panel.locator('.delta').first().waitFor();
  const deltas = await panel.locator('.delta').allTextContents();
  check(deltas.length > 0, `重排后能看到名次变化：${deltas.join(' ')}`);
  const newIds = await panel.locator('.card').evaluateAll((els) => els.map((e) => e.getAttribute('data-video-id')));
  const oldPos = ids.indexOf('ai03');
  const newPos = newIds.indexOf('ai03');
  check(newPos === -1 || newPos > oldPos, `3 分的视频名次下降（第 ${oldPos + 1} 位 → ${newPos === -1 ? '跌出前 10' : `第 ${newPos + 1} 位`}）`);
  const goodOld = ids.indexOf('ai04');
  const goodNew = newIds.indexOf('ai04');
  check(goodNew !== -1 && goodNew <= goodOld, `10 分的视频名次不降（第 ${goodOld + 1} 位 → 第 ${goodNew + 1} 位）`);
  await panel.screenshot({ path: join(shots, '05-reranked.png'), fullPage: true });

  console.log('\n[理解错了]');
  const wrong = panel.locator('.card[data-video-id=ai02]');
  if (await wrong.count()) {
    await wrong.locator('.rate-btn[data-rate="2"]').click();
    await wrong.locator('button[data-attr=understanding]').click();
    await wrong.locator('.attrib select').selectOption({ index: 4 });
    await wrong.locator('.attrib textarea').fill('我要中文的入门科普，不要英文速览');
    await wrong.getByRole('button', { name: '记下这条纠正' }).click();
    await wrong.getByTestId('adjustment').waitFor();
    const t = (await wrong.getByTestId('adjustment').textContent()) ?? '';
    check(t.includes('已记录理解纠正') && t.includes('排序参数没有改动'), '理解错了 → 记录纠正、不改排序参数');
  }

  await panel.getByRole('tab', { name: '改进记录' }).click();
  // 两个列表都是切到这页后才从本地存储读出来的，等它们渲染完再数；条数仍要求正好相等
  await panel.locator('.adjust-log > li').nth(2).waitFor();
  await panel.locator('.corrections > li').first().waitFor();
  const logCount = await panel.locator('.adjust-log > li').count();
  check(logCount === 3, `改进记录里有 ${logCount} 条（3 分、10 分、理解纠正）`);
  check((await panel.locator('.corrections > li').count()) === 1, '理解纠正列表有 1 条');
  await panel.screenshot({ path: join(shots, '06-changes.png'), fullPage: true });

  console.log('\n[纠正进入后续理解]');
  await panel.getByRole('tab', { name: '找片' }).click();
  const before = requests.filter((r) => r.path === '/anthropic/v1/messages').length;
  await panel.getByRole('button', { name: '重新理解原句' }).click();
  await panel.getByText('参考了你的 1 条理解纠正').waitFor({ timeout: 20000 });
  const llmCalls = requests.filter((r) => r.path === '/anthropic/v1/messages');
  check(llmCalls.length > before && llmCalls.at(-1).body.includes('我要中文的入门科普'), '下一次解析时纠正被发给 LLM');
  await panel.locator('.card').first().waitFor();
  check((await panel.locator('.badge.cache').count()) === 1, '相同意图再次搜索命中缓存，标注"缓存"');

  console.log('\n[验收口令 2：6 个以上约束]');
  await panel.locator('textarea.query').fill('英文、一小时以上、近一周、带字幕、不要 Shorts 的 AI 安全访谈');
  await panel.getByRole('button', { name: '找片' }).click();
  await panel.locator('.echo-row[data-kind=caption]').waitFor({ timeout: 20000 });
  await panel.locator('.card[data-video-id=sf01]').waitFor({ timeout: 20000 });
  const rows = panel.locator('.echo-row');
  const rowCount = await rows.count();
  check(rowCount >= 6, `回显列出 ${rowCount} 个约束`);
  const rowInfo = await rows.evaluateAll((els) =>
    els.map((e) => ({ kind: e.getAttribute('data-kind'), status: e.querySelector('.status')?.textContent ?? '', disp: e.querySelectorAll('.disp-list li').length })),
  );
  check(rowInfo.every((r) => r.status && r.disp > 0), `每个约束都已落实或被明确标注：${rowInfo.map((r) => `${r.kind}=${r.status}`).join('，')}`);
  const finalIds = await panel.locator('.card').evaluateAll((els) => els.map((e) => e.getAttribute('data-video-id')));
  check(JSON.stringify(finalIds) === JSON.stringify(['sf01', 'sf02']), `过滤后只剩满足全部硬约束的视频：${finalIds.join(', ')}`);
  const stats = (await panel.locator('.filter-stats').textContent()) ?? '';
  check(/淘汰/.test(stats), `展示过滤统计：${stats.trim()}`);
  await panel.screenshot({ path: join(shots, '07-multi-constraint.png'), fullPage: true });
  await panel.locator('.echo').screenshot({ path: join(shots, '07a-echo.png') });

  console.log('\n[编辑回显后重搜：只改过滤条件 → 命中缓存]');
  const durRow = panel.locator('.echo-row[data-kind=duration]');
  await durRow.locator('button[title=编辑]').click();
  await durRow.locator('input[type=number]').first().fill('20');
  await durRow.locator('input[type=number]').first().blur();
  await panel.getByRole('button', { name: '完成' }).click();
  await panel.getByRole('button', { name: '按修改重搜' }).click();
  await panel.locator('.card[data-video-id=sf06]').waitFor({ timeout: 20000 });
  check(true, '时长改成 ≥20 分钟后，25 分钟的 sf06 出现');

  console.log('\n[配额显示]');
  const quotaText = (await panel.locator('.quota').textContent()) ?? '';
  check(/search/.test(quotaText) && /units/.test(quotaText), `配额实时显示：${quotaText.replace(/\s+/g, ' ')}`);

  // ───────────────────────── Phase 2 ─────────────────────────
  console.log('\n[Phase 2 设置：观看少于 0 分钟也评估提醒（便于人为把占比调过阈值）]');
  await options.bringToFront();
  await options.reload();
  const minTotal = options.getByLabel('观看少于多少分钟不评估');
  await minTotal.fill('0');
  await minTotal.blur();
  await options.waitForTimeout(300);

  console.log('\n[Phase 2：在播放页上真的看 3 个视频]');
  const watch = await context.newPage();
  watch.on('pageerror', (e) => consoleErrors.push(`watch pageerror: ${e.message}`));
  const ready = () => watch.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  // ① 看完：12 分钟的视频，16 倍速放完（真实约 45 秒）
  await watch.goto(`${MOCK}/watch?v=p2Complete01`);
  await ready();
  await watch.evaluate(async () => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.playbackRate = 16;
    await v.play();
  });
  await watch.waitForFunction(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).ended, null, { timeout: 120000, polling: 500 });
  check(true, '视频 1 播放完毕');
  // ② 秒退：站内跳转（不刷新页面）到第二个视频，播 2 秒就停
  await watch.evaluate(async () => {
    history.pushState({}, '', '/watch?v=p2Glance0002');
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.src = '/media/p2Glance0002.wav';
    await new Promise((r) => v.addEventListener('canplay', r, { once: true }));
    v.playbackRate = 1;
    await v.play();
  });
  await watch.waitForTimeout(2500);
  await watch.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).pause());
  // ③ 看一半：20 分钟的视频，16 倍速看到 55% 暂停
  await watch.goto(`${MOCK}/watch?v=p2Half000003`);
  await ready();
  await watch.evaluate(async () => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.playbackRate = 16;
    await v.play();
  });
  await watch.waitForFunction(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime >= 660, null, { timeout: 120000, polling: 200 });
  await watch.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).pause());
  await watch.waitForTimeout(1500);
  await watch.close();
  await panel.bringToFront();
  await panel.waitForTimeout(1500);

  console.log('\n[Phase 2：记录与当日总结]');
  await panel.getByRole('tab', { name: '记录', exact: true }).click();
  await panel.locator('.watch-row').nth(2).waitFor({ timeout: 30000 });
  const statusOf = async () =>
    Object.fromEntries(await panel.locator('.watch-row').evaluateAll((els) => els.map((e) => [e.getAttribute('data-video-id'), [e.getAttribute('data-status'), e.getAttribute('data-nature')]])));
  let st = await statusOf();
  check(st.p2Complete01?.[0] === 'completed', `看完的视频判为"看完"（${st.p2Complete01?.[0]}）`);
  check(st.p2Glance0002?.[0] === 'glance', `秒退的视频判为"瞥一眼"（${st.p2Glance0002?.[0]}）`);
  check(st.p2Half000003?.[0] === 'partial', `看一半的视频判为"部分观看"（${st.p2Half000003?.[0]}）`);

  await panel.getByRole('button', { name: /现在生成今天的总结/ }).click();
  const card = panel.locator('.summary-card').first();
  await card.waitFor({ timeout: 30000 });
  await card.getByRole('button').first().click();
  const sumText = (await card.textContent()) ?? '';
  check(/看完 1/.test(sumText) && /部分 1/.test(sumText) && /瞥一眼 1/.test(sumText), '当日总结里的分类数正确（看完 1 · 部分 1 · 瞥一眼 1）');
  check(sumText.includes('今日学了什么') && sumText.includes('机器学习入门'), '"今日学了什么"引用了看完的学习视频');
  check(sumText.includes('只是路过') && sumText.includes('搞笑合集'), '秒退的视频进了"只是路过"');
  check(sumText.includes('与近期目标的关联'), '总结包含"与近期目标的关联"');
  st = await statusOf();
  check(st.p2Complete01?.[1] === 'learning' && st.p2Glance0002?.[1] === 'entertainment', `补上元数据后判定学习/娱乐（${st.p2Complete01?.[1]} / ${st.p2Glance0002?.[1]}）`);
  await panel.screenshot({ path: join(shots, '08-records.png'), fullPage: true });

  const [dl] = await Promise.all([panel.waitForEvent('download'), panel.getByRole('button', { name: '导出记忆库（Markdown）' }).click()]);
  const md = readFileSync(/** @type {string} */ (await dl.path()), 'utf8');
  check(md.includes('# TubeMuse 记忆库') && md.includes('## 只是路过'), `记忆库导出为 Markdown（${dl.suggestedFilename()}）`);

  console.log('\n[Phase 2：人为把娱乐占比调过阈值 → 提醒触发且只触发一次]');
  check((await panel.getByTestId('reminder').count()) === 0, '学习占比高时没有提醒');
  const row = panel.locator('.watch-row[data-video-id=p2Complete01]');
  await row.getByRole('button', { name: '判定依据 / 纠正' }).click();
  await row.locator('.verdict select').selectOption('entertainment');
  await row.locator('button[data-scope=channel]').click();
  await panel.getByTestId('reminder').waitFor({ timeout: 15000 });
  const banner = (await panel.getByTestId('reminder').textContent()) ?? '';
  check((await panel.getByTestId('reminder').count()) === 1, '侧边栏顶部出现一条提醒横幅');
  check(banner.includes('放松挺好的') && /《.+》/.test(banner), `提醒语气轻，并附一个具体的学习视频：${banner.slice(0, 80)}…`);
  st = await statusOf();
  check(st.p2Half000003?.[1] === 'entertainment', '按频道纠正后，同频道的另一条也算娱乐');
  const stateBefore = await panel.evaluate(async () => (await /** @type {any} */ (globalThis).chrome.storage.local.get('reminderState')).reminderState);
  await panel.getByTestId('reminder').getByRole('button', { name: '知道了' }).click();
  await panel.getByTestId('reminder').waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
  check((await panel.getByTestId('reminder').count()) === 0, '点"知道了"后横幅消失');
  await panel.reload();
  await panel.waitForTimeout(2500);
  const stateAfter = await panel.evaluate(async () => (await /** @type {any} */ (globalThis).chrome.storage.local.get('reminderState')).reminderState);
  check((await panel.getByTestId('reminder').count()) === 0 && stateAfter.lastTriggeredAt === stateBefore.lastTriggeredAt, '重新打开侧边栏不会再次提醒（只触发一次，间隔 3 天）');
  await panel.screenshot({ path: join(shots, '09-after-reminder.png'), fullPage: true });

  console.log('\n[Phase 2：每周自省]');
  await panel.getByRole('tab', { name: '记录', exact: true }).click();
  await panel.getByRole('button', { name: /生成本周/ }).click();
  const weekly = panel.locator('.summary-list').nth(1).locator('.summary-card').first();
  await weekly.waitFor({ timeout: 30000 });
  await weekly.getByRole('button').first().click();
  const wText = (await weekly.textContent()) ?? '';
  check(wText.includes('标题党') && wText.includes('本周已自动调整了什么') && wText.includes('频道偏好'), '周报含低分共性与"本周已自动调整了什么"');
  await panel.screenshot({ path: join(shots, '10-weekly.png'), fullPage: true });

  // ───────────────────────── Phase 3 ─────────────────────────
  console.log('\n[Phase 3 设置：填写 X Bearer Token]');
  const X_TOKEN = 'e2e-x-bearer-token-not-real-0123456789';
  await options.bringToFront();
  await options.reload();
  await options.getByTestId('x-token').fill(X_TOKEN);
  await options.locator('#x .btn', { hasText: '保存' }).first().click();
  await options.waitForTimeout(300);
  check((await options.getByTestId('x-token').getAttribute('placeholder')) === '已保存（出于安全不回显）', 'X Token 保存后不回显');

  console.log('\n[Phase 3：X 热点]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '发现' }).click();
  const xCount = () => requests.filter((r) => r.path === '/x/2/tweets/search/recent').length;
  await panel.getByTestId('x-refresh-cost').waitFor({ timeout: 10000 });
  await panel.waitForTimeout(1000);
  check(xCount() === 0 && ((await panel.getByTestId('x-refresh-cost').textContent()) ?? '').includes('$0.20'), '打开"发现"页不读 X、不花钱；按钮旁写明刷新一次最多 $0.20');
  await panel.getByRole('button', { name: '刷新热点' }).click();
  await panel.getByTestId('hotspot').first().waitFor({ timeout: 30000 });
  const hotCount = await panel.getByTestId('hotspot').count();
  check(hotCount >= 5 && hotCount <= 8, `出现 ${hotCount} 条热点（5–8 条）`);
  const links = await panel.getByTestId('post-link').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  check(links.length >= hotCount && links.every((h) => /^https:\/\/x\.com\/i\/web\/status\/\d+$/.test(h)), '每条热点都带 X 原文链接');
  check((await panel.getByTestId('x-spend').count()) === 1, '顶部实时显示 X 花费');
  check((await panel.getByTestId('llm-spend').count()) === 1, '顶部实时显示大模型花费');
  const firstRound = xCount();
  check(firstRound >= 1 && firstRound <= 4, `按兴趣主题检索了 ${firstRound} 次（每个主题 1 次）`);
  await panel.screenshot({ path: join(shots, '11-hotspots.png'), fullPage: true });

  const hsText = (await panel.getByTestId('hotspot-search').first().textContent()) ?? '';
  const hsUtterance = /「(.+)」/.exec(hsText)?.[1] ?? '';
  await panel.getByTestId('hotspot-search').first().click();
  // 先等口令填进输入框、搜索跑完（切页瞬间可能还看得到上一次的结果）
  await panel.waitForFunction((u) => /** @type {HTMLTextAreaElement | null} */ (document.querySelector('textarea.query'))?.value === u, hsUtterance, { timeout: 10000 });
  await panel.waitForFunction(() => !document.querySelector('.spinner') && !!document.querySelector('.card'), null, { timeout: 30000 });
  check((await panel.locator('textarea.query').inputValue()) === hsUtterance && (await panel.getByRole('tab', { name: '找片' }).getAttribute('aria-selected')) === 'true', `点热点直接发起对应找片：「${hsUtterance}」`);

  console.log('\n[Phase 3：超预算立即停调并提示]');
  const spentNow = await panel.evaluate(async () => {
    const l = (await /** @type {any} */ (globalThis).chrome.storage.local.get('xLedger')).xLedger;
    return Object.values(l.days).reduce((s, d) => s + /** @type {any} */ (d).spentUsd, 0);
  });
  await options.bringToFront();
  const budgetField = options.getByLabel('每日预算（美元，按 UTC 日）');
  // 预算 = 已花 + 6 美分：下一轮只够读一个主题（10 条）
  await budgetField.fill(String(Math.round((spentNow + 0.06) * 100) / 100));
  await budgetField.blur();
  await options.waitForTimeout(300);
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '发现' }).click();
  const beforeRefresh = xCount();
  await panel.getByRole('button', { name: '刷新热点' }).click();
  await panel.waitForFunction(() => !document.querySelector('.spinner'), null, { timeout: 30000 });
  await panel.getByTestId('hotspot-notes').waitFor({ timeout: 10000 });
  const hsNotes = (await panel.getByTestId('hotspot-notes').textContent()) ?? '';
  check(xCount() - beforeRefresh === 1 && hsNotes.includes('已停止调用'), `预算只够一个主题：只发了 ${xCount() - beforeRefresh} 次请求，并提示"已停止调用"`);
  check(await panel.getByRole('button', { name: '刷新热点' }).isDisabled(), '预算用完后"刷新热点"按钮不可点');
  check((await panel.getByTestId('x-spend').getAttribute('class'))?.includes('warn') === true, '顶部 X 花费条变为警示色');
  await panel.screenshot({ path: join(shots, '12-x-budget.png'), fullPage: true });

  console.log('\n[Phase 3：新博主发现]');
  if ((await panel.getByTestId('creator').count()) === 0) await panel.getByRole('button', { name: /现在发现|再找一次/ }).click();
  await panel.getByTestId('creator').first().waitFor({ timeout: 30000 });
  const creators = await panel.getByTestId('creator').evaluateAll((els) =>
    els.map((e) => ({ text: e.textContent ?? '', reasons: e.querySelectorAll('.reasons-list li').length, videos: e.querySelectorAll('.recent-videos li').length })),
  );
  check(creators.length >= 1 && creators.length <= 5, `推荐了 ${creators.length} 个新博主（≤5）`);
  check(creators.every((c) => c.reasons > 0 && c.videos === 3), '每个都有推荐理由与最近 3 个视频标题');
  check(creators.every((c) => !c.text.includes('停更频道')) && creators.every((c) => !c.text.includes('科普星球')), '不推荐停更的、也不推荐已订阅的频道');
  const creatorButtons = await panel.getByTestId('creator').locator('button').allTextContents();
  check(creatorButtons.every((t) => t === '打开频道' || t === '不感兴趣'), '只有"打开频道"，没有"订阅"按钮');
  const usedSearch = Number(/(\d+)\/(\d+)/.exec((await panel.getByTestId('discovery-quota').textContent()) ?? '')?.[1] ?? 99);
  check(usedSearch <= 8, `本周为此用了 ${usedSearch} 次 search（≤8）`);
  const firstCreator = (await panel.getByTestId('creator').first().locator('.creator-name').textContent()) ?? '';
  await panel.getByTestId('creator').first().getByRole('button', { name: '不感兴趣' }).click();
  await panel.waitForTimeout(500);
  check(!(await panel.getByTestId('creator').allTextContents()).some((t) => t.includes(firstCreator)), `点"不感兴趣"后「${firstCreator}」不再显示`);
  await panel.screenshot({ path: join(shots, '13-creators.png'), fullPage: true });

  // ───────────────────────── 豆瓣评论 RSS ─────────────────────────
  console.log('\n[豆瓣评论 RSS]');
  const doubanReqs = () => requests.filter((r) => r.path.startsWith('/douban/'));
  await panel.getByRole('tab', { name: '豆瓣' }).click();
  await panel.getByTestId('douban-review').first().waitFor({ timeout: 15000 });
  const reviews = await panel.getByTestId('douban-review').evaluateAll((els) =>
    els.map((e) => {
      const a = e.querySelector('a.db-title');
      const time = e.querySelector('[data-testid="douban-time"]');
      return {
        title: e.querySelector('.db-title')?.textContent ?? '',
        href: a?.getAttribute('href') ?? '',
        target: a?.getAttribute('target') ?? '',
        excerpt: e.querySelector('.db-excerpt')?.textContent ?? '',
        time: time?.textContent ?? '',
        timeTitle: time?.getAttribute('title') ?? '',
      };
    }),
  );
  check(reviews.length === 5, `打开"豆瓣"页自动读取预置条目：${reviews.length} 篇评论（重复的已去掉）`);
  check(reviews[0]?.title === '笑出眼泪', '按发布时间从新到旧排列');
  // 夹具里最新一篇的 pubDate 是 Thu, 22 Oct 2026 01:31:55 GMT：按浏览器所在时区换算后应原样显示
  const tz = await panel.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const tp = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(Date.parse('Thu, 22 Oct 2026 01:31:55 GMT'))
      .map((x) => [x.type, x.value]),
  );
  const expectedTime = `${tp.year}/${tp.month}/${tp.day} ${tp.hour}:${tp.minute}`;
  check(
    reviews[0]?.time === expectedTime &&
      reviews.slice(0, -1).every((r) => /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(r.time)) &&
      reviews.at(-1)?.time === '时间未知' &&
      reviews.every((r) => !r.timeTitle),
    `评论时间显示为本地精确时间（${expectedTime}，${tz}），没有"几周前"，也没有悬浮提示`,
  );
  check(reviews.some((r) => r.excerpt === '期待上…') && reviews.every((r) => !/�|\\u|&#34;/.test(r.excerpt)), '摘要取自截断的 Draft.js，没有转义残渣或乱码');
  check(
    reviews.filter((r) => r.href).every((r) => r.href.startsWith('https://movie.douban.com/review/') && r.target === '_blank') && reviews.some((r) => !r.href),
    '评论链接只指向豆瓣、在新标签页打开；javascript: 链接被丢弃',
  );
  check((await panel.getByTestId('douban-hero').locator('.db-subject').textContent()) === '白衣逆行者', '条目名取自 RSS');
  await panel.getByTestId('douban-poster-note').waitFor({ timeout: 5000 });
  check((await panel.locator('.db-cover').count()) === 1, '海报被拒（模拟防盗链 418）：换成本地生成的封面，并说明原因');
  check(doubanImages.length >= 1 && doubanImages.every((i) => !i.referer), '加载海报不带 Referer（不冒充豆瓣页面）');
  const dr = doubanReqs();
  check(dr.length === 1 && dr[0].path === '/douban/feed/subject/35299923/reviews' && dr[0].method === 'GET', `只请求了一次 RSS（${dr.map((r) => r.path).join(', ')}）`);
  check(dr.every((r) => !r.headers.cookie && !r.headers.referer && !r.headers.authorization), 'RSS 请求不带 Cookie、Referer、Authorization');
  check(dr.every((r) => ![FAKE_KEY, X_TOKEN, 'e2e-fake-token'].some((s) => JSON.stringify(r).includes(s))), 'Key / Token 从未发往豆瓣');
  await panel.screenshot({ path: join(shots, '14-douban.png'), fullPage: true });
  await panel.getByTestId('douban-review').first().screenshot({ path: join(shots, '14a-douban-card.png') });

  await panel.getByRole('tab', { name: '找片' }).click();
  await panel.getByRole('tab', { name: '豆瓣' }).click();
  await panel.getByTestId('douban-review').first().waitFor();
  await panel.waitForTimeout(500);
  check(doubanReqs().length === 1, '缓存期内重新打开"豆瓣"页不再请求');

  await panel.getByTestId('douban-input').fill('https://book.douban.com/subject/1084336/');
  await panel.getByRole('button', { name: '订阅', exact: true }).click();
  await panel.getByText('这个条目暂时没有评论').waitFor({ timeout: 10000 });
  check(
    (await panel.locator('.db-chip.on').textContent()) === '某书' && ((await panel.locator('.db-kind').textContent()) ?? '').startsWith('图书'),
    '粘贴图书链接即可订阅，自动选中并读取',
  );

  await panel.getByTestId('douban-input').fill('99999999');
  await panel.getByRole('button', { name: '订阅', exact: true }).click();
  await panel.locator('.notice-error').waitFor({ timeout: 10000 });
  check(((await panel.locator('.notice-error').textContent()) ?? '').includes('HTTP 404'), '读不到的条目：用人话报错（HTTP 404），不静默');
  await panel.screenshot({ path: join(shots, '15-douban-error.png'), fullPage: true });
  await panel.getByRole('button', { name: '取消订阅' }).click();
  await panel.waitForFunction(() => document.querySelectorAll('.db-chip').length === 2, null, { timeout: 5000 });
  check((await panel.locator('.db-chip.on').textContent()) === '白衣逆行者', '取消订阅后回到第一个条目');

  console.log('\n[豆瓣：跟随当前标签页]');
  // 只数扩展自己发的 RSS 请求（标签页打开 RSS 地址本身也是一次请求，但那是浏览器导航）
  const rssFetches = (/** @type {string} */ id) => requests.filter((r) => r.path === `/douban/feed/subject/${id}/reviews` && r.headers['sec-fetch-mode'] !== 'navigate').length;
  // 侧边栏此时在后台标签页里：按固定间隔轮询，不依赖 requestAnimationFrame
  const waitSubject = (/** @type {string} */ title) =>
    panel.waitForFunction((t) => document.querySelector('.db-subject')?.textContent === t, title, { timeout: 15000, polling: 100 });
  const feedUrl = (/** @type {string} */ id) => `${MOCK}/douban/feed/subject/${id}/reviews`;
  const tabUpdate = (/** @type {number} */ id, /** @type {string} */ url) => panel.evaluate(([i, u]) => /** @type {any} */ (globalThis).chrome.tabs.update(i, { url: u }), /** @type {[number, string]} */ ([id, url]));
  const tabId = /** @type {number} */ (
    await panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }).then((/** @type {any} */ t) => t.id), feedUrl('37322586'))
  );
  await waitSubject('生日快乐');
  check(
    rssFetches('37322586') === 1 && ((await panel.getByTestId('douban-page-chip').textContent()) ?? '').includes('生日快乐') && (await panel.getByTestId('douban-chip').count()) === 2,
    '当前标签页打开《生日快乐》的评论 RSS：豆瓣页自动切过去并读取，标为"当前页"，没有自动订阅',
  );
  await panel.screenshot({ path: join(shots, '16-douban-follow.png'), fullPage: true });

  const cachedBefore = rssFetches('35299923');
  await tabUpdate(tabId, feedUrl('35299923'));
  await waitSubject('白衣逆行者');
  check(rssFetches('35299923') === cachedBefore, '同一标签页换到另一个条目的地址：随之切换；该条目缓存未过期，不重复请求');
  await tabUpdate(tabId, feedUrl('37322586'));
  await waitSubject('生日快乐');
  check(rssFetches('37322586') === 1, '切回刚看过的未订阅条目：用它自己的缓存，不重复请求');

  await panel.getByTestId('douban-chip').filter({ hasText: '白衣逆行者' }).click();
  await waitSubject('白衣逆行者');
  await panel.evaluate((i) => /** @type {any} */ (globalThis).chrome.tabs.reload(i), tabId);
  await panel.waitForTimeout(1500);
  check((await panel.locator('.db-subject').textContent()) === '白衣逆行者', '手动点选订阅条目后，同一页面刷新不会把它切走');

  await tabUpdate(tabId, 'about:blank');
  await panel.waitForTimeout(800);
  check((await panel.locator('.db-subject').textContent()) === '白衣逆行者', '标签页离开豆瓣：保持当前显示');
  await tabUpdate(tabId, feedUrl('37322586'));
  await waitSubject('生日快乐');
  check(true, '再回到豆瓣条目：重新跟随');

  await panel.getByRole('button', { name: '订阅这个条目' }).click();
  await panel.waitForFunction(() => document.querySelectorAll('[data-testid="douban-chip"]').length === 3, null, { timeout: 5000, polling: 100 });
  check(
    (await panel.getByTestId('douban-page-chip').count()) === 0 && (await panel.locator('.db-chip.on').textContent()) === '生日快乐' && (await panel.getByRole('button', { name: '取消订阅' }).count()) === 1,
    '点"订阅这个条目"后加入订阅列表',
  );
  await panel.evaluate((i) => /** @type {any} */ (globalThis).chrome.tabs.remove(i), tabId);
  await panel.bringToFront();

  // ───────────────────────── 自动字幕 ─────────────────────────
  console.log('\n[自动字幕：设置]');
  const OPENAI_KEY = 'e2e-openai-test-key-not-real';
  await options.bringToFront();
  await options.reload();
  await options.getByTestId('openai-key').fill(OPENAI_KEY);
  await options.getByTestId('openai-key').locator('xpath=following-sibling::button[1]').click();
  await options.locator('[data-testid="openai-key"][placeholder="已保存（出于安全不回显）"]').waitFor({ timeout: 5000 });
  check(await options.getByTestId('subtitle-engine-local').isChecked(), '字幕翻译默认用 Chrome 本地翻译（不花钱）');
  await options.getByTestId('subtitle-engine-llm').check();
  await options.getByTestId('subtitle-model').waitFor({ timeout: 5000 });
  check((await options.getByTestId('subtitle-model').inputValue()) === 'claude-haiku-5-5', '字幕翻译模型默认是 claude-haiku-5-5（更快更省）');
  await options.waitForTimeout(300);
  const subSection = (await options.locator('#subtitles').textContent()) ?? '';
  check(subSection.includes('12. 自动字幕') && /一小时连续说话的视频约 \$0\.\d\d/.test(subSection), '设置页有"自动字幕"一节，并按当前模型估算每小时花费');
  check(await options.getByRole('radio', { name: /浏览器识别/ }).isChecked(), '转写方式默认是"浏览器识别"（免费）');
  check(!(await options.getByTestId('subtitle-autostart').isChecked()), '"无字幕时自动开始"默认关闭');
  check(subSection.includes('本地语音包') && subSection.includes('识别语言'), '设置页显示识别语言与本地语音包状态');
  await options.locator('#subtitles').screenshot({ path: join(shots, '17-subtitle-settings.png') });

  const transcribeReqs = () => requests.filter((r) => r.path === '/openai/v1/audio/transcriptions');
  const subtitleLlmReqs = () => requests.filter((r) => r.path.startsWith('/anthropic') && r.body.includes('视频字幕翻译'));

  console.log('\n[自动字幕：浏览器识别（默认）→ 边听边出字 → 一行一行存下并翻译，不发送音频]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '字幕', exact: true }).click();
  const llmBeforeBrowser = subtitleLlmReqs().length;
  const [bsub] = await Promise.all([
    context.waitForEvent('page'),
    panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}/watch?v=subBrowse001`),
  ]);
  bsub.on('pageerror', (e) => consoleErrors.push(`browser-speech watch pageerror: ${e.message}`));
  bsub.on('console', (m) => m.type() === 'error' && consoleErrors.push(`browser-speech watch: ${m.text()}`));
  await bsub.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await bsub.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  // 字幕默认关闭：没有原生字幕的视频播放起来也不出字幕、不识别、不翻译，等你手动开启
  await bsub.waitForTimeout(3000);
  await panel.getByTestId('subtitle-status').filter({ hasText: '字幕默认关闭' }).waitFor({ timeout: 10000 });
  check(
    (await bsub.locator('[data-tubemuse="subtitles"]').count()) === 0 && subtitleLlmReqs().length === llmBeforeBrowser,
    '字幕默认关闭：没有原生字幕的视频播放 3 秒，不出字幕、不识别、不翻译',
  );
  check(((await panel.getByTestId('subtitle-status').textContent()) ?? '').includes('Alt+Shift+S'), '侧边栏说明怎么手动开启');
  await panel.getByRole('button', { name: '为这个视频生成字幕' }).click();
  await bsub.locator('[data-tubemuse="subtitles"] .tr').filter({ hasText: /Where was I\? \(\d+\)/ }).waitFor({ timeout: 20000 });
  const bSrc = (await bsub.locator('[data-tubemuse="subtitles"] .src').textContent()) ?? '';
  check(/第 \d+ 句：我说到哪里了/.test(bSrc), `浏览器识别：播放器里边听边出字：${bSrc}`);
  check(transcribeReqs().length === 0, '浏览器识别不发任何音频（没有 OpenAI 转写请求）');
  const bLlm = subtitleLlmReqs().slice(llmBeforeBrowser);
  check(bLlm.length >= 1 && bLlm.every((r) => JSON.parse(r.body).model === 'claude-haiku-5-5' && !r.body.includes('subBrowse001')), `识别出的每一行交给 Claude（claude-haiku-5-5）翻译，不含视频 ID（${bLlm.length} 行）`);
  await panel.getByTestId('subtitle-mode').filter({ hasText: 'Chrome 云端识别' }).waitFor({ timeout: 10000 });
  const bTab = (await panel.getByTestId('subtitle-tab').textContent()) ?? '';
  check(bTab.includes('浏览器识别 · Chrome 云端识别（声音发往 Google）'), '侧边栏写明转写方式与声音去向');
  check((await panel.getByTestId('subtitle-lang').inputValue()) === 'zh-CN' && bTab.includes('默认'), '视频语言查不到（YouTube 数据里没有）：按简体中文识别，并说明是默认');
  await bsub.waitForTimeout(3000);
  const bCues = await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get(['subtitles:subBrowse001']).then((/** @type {any} */ r) => r['subtitles:subBrowse001']));
  check(
    bCues?.asrModel === 'browser-speech' && bCues.cues.length >= 2 && bCues.cues.every((/** @type {any} */ c) => /^第 \d+ 句：我说到哪里了$/.test(c.text) && c.end > c.start),
    `识别出的行按视频时间存在本机（${bCues?.cues.length} 行）`,
  );
  await bsub.screenshot({ path: join(shots, '23-browser-speech-overlay.png') });
  await panel.screenshot({ path: join(shots, '24-browser-speech-panel.png'), fullPage: true });

  await panel.getByTestId('subtitle-lang').selectOption('en-US');
  await panel.waitForFunction(() => /** @type {HTMLSelectElement | null} */ (document.querySelector('[data-testid="subtitle-lang"]'))?.value === 'en-US', null, { timeout: 5000 });
  check(((await panel.getByTestId('subtitle-tab').textContent()) ?? '').includes('你选的'), '侧边栏给这个视频换识别语言：立即生效');
  const spendB = (await panel.getByTestId('subtitle-spend-detail').textContent()) ?? '';
  check(spendB.includes('浏览器识别不收费') && !/OpenAI 转写/.test(spendB), `花费只有翻译：${spendB}`);

  console.log('\n[自动字幕：浏览器识别连不上语音服务（例如不是 Google Chrome）→ 停下并说明怎么办]');
  await bsub.goto(`${MOCK}/watch?v=subBrowseNet`);
  await bsub.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await bsub.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  // 换了视频又回到默认关闭：再手动开启一次
  await panel.getByRole('button', { name: '为这个视频生成字幕' }).click();
  const netChip = bsub.locator('[data-tubemuse="subtitles"] .status');
  await netChip.filter({ hasText: '连不上 Chrome 的语音识别服务' }).waitFor({ timeout: 15000 });
  const netText = (await netChip.textContent()) ?? '';
  check(netText.includes('已停止') && netText.includes('Google Chrome') && netText.includes('OpenAI'), `播放器里说明原因与办法：${netText.slice(0, 60)}…`);
  await bsub.close();

  console.log('\n[自动字幕：改用 OpenAI 转写]');
  await options.bringToFront();
  await options.getByRole('radio', { name: /OpenAI 转写/ }).check();
  // 后面的场景验证"无字幕时自动开始"这个可选项仍然好用
  await options.getByTestId('subtitle-autostart').check();
  await options.waitForTimeout(400);
  check((await options.locator('#subtitles').textContent())?.includes('语音转写模型（OpenAI）') === true, '选 OpenAI 后显示转写模型设置');

  console.log('\n[自动字幕：没有原生字幕的视频 → 采音频 → 转写 → 翻译 → 双语字幕叠加在播放器里]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '字幕', exact: true }).click();
  // 从侧边栏打开播放页并设为当前标签页（侧边栏要看的是"当前标签页"）
  const [sub] = await Promise.all([
    context.waitForEvent('page'),
    panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}/watch?v=subNoCC00001`),
  ]);
  sub.on('pageerror', (e) => consoleErrors.push(`subtitle watch pageerror: ${e.message}`));
  sub.on('console', (m) => m.type() === 'error' && consoleErrors.push(`subtitle watch: ${m.text()}`));
  await sub.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  // YouTube 自己的元素（不含本扩展的字幕层）：开始前后逐字比较
  const ytOwnHtml = () => sub.evaluate(() => [.../** @type {HTMLElement} */ (document.getElementById('movie_player')).children].filter((e) => !e.hasAttribute('data-tubemuse')).map((e) => e.outerHTML));
  const ytChildrenBefore = await ytOwnHtml();
  await sub.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  const trLine = sub.locator('[data-tubemuse="subtitles"] .tr');
  await trLine.filter({ hasText: /Where was I\? \(\d+\)/ }).waitFor({ timeout: 30000 });
  const srcLine = (await sub.locator('[data-tubemuse="subtitles"] .src').textContent()) ?? '';
  const firstShownAt = await sub.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime);
  check(/第 \d+ 句：我说到哪里了/.test(srcLine), `播放器里出现原文：${srcLine}`);
  check(/Where was I\? \(\d+\)/.test((await trLine.textContent()) ?? ''), `并出现第二行译文（中文原文 → 英文）：${await trLine.textContent()}`);
  check(firstShownAt < 6, `第一次观看：说完一句几秒内就出字幕（视频第 ${firstShownAt.toFixed(1)} 秒）`);
  await sub.screenshot({ path: join(shots, '18-subtitle-overlay.png') });

  const hosts = await sub.evaluate(() => document.querySelectorAll('#movie_player > [data-tubemuse="subtitles"]').length);
  check(hosts === 1 && JSON.stringify(await ytOwnHtml()) === JSON.stringify(ytChildrenBefore), '只在播放器里加了一层字幕，YouTube 自己的元素原样未动');
  const tr = transcribeReqs();
  check(tr.length >= 1 && tr.every((r) => r.headers.authorization === `Bearer ${OPENAI_KEY}`), `音频发往 OpenAI 转写（${tr.length} 段），Key 只在请求头里`);
  check(
    tr.every((r) => r.body.includes('name="model"') && r.body.includes('gpt-transcribe') && r.body.includes('RIFF') && r.body.includes('WAVE')),
    '每段是 WAV 文件 + 模型名 gpt-transcribe',
  );
  check(
    tr.every((r) => String(r.headers.origin ?? '').startsWith('chrome-extension://')),
    '转写请求由扩展后台发出（不是注入 YouTube 的脚本自己发的）',
  );
  check(tr.every((r) => !r.body.includes('subNoCC00001')), '发给 OpenAI 的内容不含视频 ID');
  check(requests.filter((r) => !r.path.startsWith('/openai')).every((r) => !JSON.stringify(r).includes(OPENAI_KEY)), 'OpenAI Key 从未发往别处');
  const sl = subtitleLlmReqs();
  check(
    sl.length >= 1 && sl.every((r) => JSON.parse(r.body).model === 'claude-haiku-5-5' && r.body.includes('English') && !r.body.includes('subNoCC00001')),
    `翻译用默认的字幕模型（claude-haiku-5-5），只发字幕文字与目标语言（${sl.length} 句）`,
  );

  // 侧边栏"字幕"页：状态、花费、已生成的字幕
  await panel.getByTestId('subtitle-status').waitFor({ timeout: 10000 });
  const tabText = (await panel.getByTestId('subtitle-tab').textContent()) ?? '';
  check(tabText.includes('subNoCC00001') && tabText.includes('原生字幕没有'), `侧边栏识别当前标签页的视频与"没有原生字幕"：${tabText.slice(0, 60)}…`);
  await panel.getByTestId('subtitle-spend').waitFor({ timeout: 10000 });
  const spendText = (await panel.getByTestId('subtitle-spend-detail').textContent()) ?? '';
  check(/\$0\.\d{3,4} \/ \$1\.00/.test(spendText) && /OpenAI 转写 [1-9]\d* 秒/.test(spendText) && /翻译 [1-9]\d* 句/.test(spendText), `花费实时可见：${spendText}`);
  await panel.screenshot({ path: join(shots, '19-subtitle-panel.png'), fullPage: true });

  // 播完后拖回第二句：按时间轴对齐显示，而且不再花钱
  await sub.waitForFunction(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).ended, null, { timeout: 30000, polling: 250 });
  await sub.waitForTimeout(1500);
  const countAfterFirstPass = transcribeReqs().length;
  const cues = await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('subtitles:subNoCC00001').then((/** @type {any} */ r) => r['subtitles:subNoCC00001'].cues));
  check(cues.length >= 4 && cues.every((/** @type {any} */ c) => c.translation), `整段视频生成了 ${cues.length} 句双语字幕并存在本机`);
  const second = cues[1];
  await sub.evaluate((t) => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.currentTime = t;
    return v.play();
  }, second.start + 0.3);
  await sub.waitForTimeout(400);
  const replay = await sub.evaluate(() => {
    const host = document.querySelector('[data-tubemuse="subtitles"]');
    return { src: host?.shadowRoot?.querySelector('.src')?.textContent, late: host?.shadowRoot?.querySelector('.wrap')?.classList.contains('late') };
  });
  check(replay.src === second.text && replay.late === false, `拖回去回看：按时间轴精确显示"${replay.src}"`);
  await sub.waitForTimeout(2000);
  await sub.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).pause());
  check(transcribeReqs().length === countAfterFirstPass, '回看已有字幕的部分不再识别、不再花钱');

  // 侧边栏一键关闭 / 重新开启
  await panel.getByRole('button', { name: '关闭这个视频的字幕' }).click();
  await sub.waitForFunction(() => !document.querySelector('[data-tubemuse="subtitles"]'), null, { timeout: 5000 });
  check(((await panel.getByTestId('subtitle-status').textContent()) ?? '').includes('你已关闭'), '侧边栏一键关闭：字幕层立即移除');
  await panel.getByRole('button', { name: '为这个视频生成字幕' }).click();
  await sub.waitForFunction(() => !!document.querySelector('[data-tubemuse="subtitles"]'), null, { timeout: 5000 });
  check(true, '再点一次重新开启');

  console.log('\n[自动字幕：有原生字幕的视频不自动生成]');
  const beforeHasCC = transcribeReqs().length;
  await sub.goto(`${MOCK}/watch?v=subHasCC0002`);
  await sub.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await sub.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  await sub.waitForTimeout(4000);
  check((await sub.locator('[data-tubemuse="subtitles"]').count()) === 0 && transcribeReqs().length === beforeHasCC, '有原生字幕：不采音频、不加字幕层、不花钱');
  check(((await panel.getByTestId('subtitle-status').textContent()) ?? '').includes('有原生字幕'), '侧边栏说明为什么没有自动开启');
  await sub.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).pause());

  console.log('\n[自动字幕：到每日预算立即停止并提示]');
  // 人为把今天的字幕花费调到预算上限
  await panel.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await c.storage.local.set({ subtitleLedger: { days: { [day]: { spentUsd: 1, asrSeconds: 0, asrUsd: 1, translations: 0, inputTokens: 0, outputTokens: 0, translateUsd: 0 } } } });
  });
  const beforeBudget = transcribeReqs().length;
  await sub.goto(`${MOCK}/watch?v=subNoCC00003`);
  await sub.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await sub.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  const statusChip = sub.locator('[data-tubemuse="subtitles"] .status');
  await statusChip.filter({ hasText: '已到上限' }).waitFor({ timeout: 15000 });
  await sub.waitForTimeout(3000);
  check(transcribeReqs().length === beforeBudget, '超预算：一个转写请求都没有发出');
  check(((await statusChip.textContent()) ?? '').includes('已停止'), `播放器里用人话说明：${(await statusChip.textContent())?.slice(0, 60)}…`);
  check(((await panel.getByTestId('subtitle-tab').textContent()) ?? '').includes('已到上限'), '侧边栏同步显示停止原因与恢复方法');
  await sub.screenshot({ path: join(shots, '20-subtitle-budget.png') });

  // OpenAI 的 429 有两类：额度 / 账单（重试没用，要停下并说清楚）与限流（按 Retry-After 暂停后自动继续）
  const setFault = (/** @type {string} */ q) => fetch(`${MOCK}/e2e/transcribe-mode?${q}`);
  const playFresh = async (/** @type {string} */ id) => {
    await sub.goto(`${MOCK}/watch?v=${id}`);
    await sub.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
    await sub.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  };
  await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.remove('subtitleLedger'));

  console.log('\n[自动字幕：OpenAI 预付额度用完（429 credit_balance_exhausted）→ 停下并说清楚原因]');
  await setFault('mode=quota');
  const beforeQuota = transcribeReqs().length;
  await playFresh('subNoCC00004');
  await statusChip.filter({ hasText: 'credit_balance_exhausted' }).waitFor({ timeout: 15000 });
  await sub.waitForTimeout(4000);
  const quota429Text = (await statusChip.textContent()) ?? '';
  check(quota429Text.includes('已停止') && quota429Text.includes('预付额度已用完') && quota429Text.includes('Billing'), `播放器里说清是哪一种、去哪里处理：${quota429Text.slice(0, 70)}…`);
  check(!quota429Text.includes('请求过于频繁'), '不再显示含糊的"请求过于频繁或额度不足"');
  check(transcribeReqs().length - beforeQuota === 1, `额度问题重试没用：只发了 1 个请求就停下（实际 ${transcribeReqs().length - beforeQuota} 个）`);
  await sub.screenshot({ path: join(shots, '21-subtitle-quota.png') });

  console.log('\n[自动字幕：被限流（429 slow_down + Retry-After）→ 暂停、倒计时、到点自动继续]');
  await setFault('mode=slowdown&times=1&retryAfter=3');
  const beforeRate = transcribeReqs().length;
  await playFresh('subNoCC00005');
  await statusChip.filter({ hasText: '秒后自动继续' }).waitFor({ timeout: 15000 });
  const rateText = (await statusChip.textContent()) ?? '';
  const afterFirst429 = transcribeReqs().length;
  await sub.waitForTimeout(1500);
  check(rateText.includes('slow_down') && /\d+ 秒后自动继续/.test(rateText), `播放器里显示限流原因与倒计时：${rateText.slice(0, 60)}…`);
  check(transcribeReqs().length === afterFirst429, '暂停期间不再发请求（被拒的请求也计入每分钟上限）');
  await trLine.filter({ hasText: /Where was I\? \(\d+\)/ }).waitFor({ timeout: 15000 });
  check(transcribeReqs().length > afterFirst429, `暂停结束后自动继续出字幕（之后又识别了 ${transcribeReqs().length - afterFirst429} 段）`);
  check(afterFirst429 - beforeRate === 1, '只有第一次被限流的请求失败');
  await sub.screenshot({ path: join(shots, '22-subtitle-rate-limit.png') });
  await setFault('mode=ok');
  await sub.close();
  await panel.bringToFront();

  // ───────────────────────── 多语字幕 ─────────────────────────
  console.log('\n[多语字幕：设置]');
  await options.bringToFront();
  await options.reload();
  await options.locator('#multicc').waitFor();
  const ccSection = (await options.locator('#multicc').textContent()) ?? '';
  check(
    ccSection.includes('13. 多语字幕') && !(await options.getByTestId('multicc-autoshow').isChecked()) && (await options.getByTestId('multicc-autotranslate').isChecked()),
    '设置页有"多语字幕"一节：默认不自动开启，没有的语言用 YouTube 自动翻译补',
  );
  const ccOrder = await options.getByTestId('multicc-lang-order').locator('li').allTextContents();
  check(ccOrder.length === 3 && ccOrder[0].includes('视频原声语言') && ccOrder[1].includes('English') && ccOrder[2].includes('简体中文'), `默认语言从上到下：原声、English、简体中文`);
  const swCc = context.serviceWorkers()[0] ?? sw;
  const manifestCc = await swCc.evaluate(() => /** @type {any} */ (globalThis).chrome.runtime.getManifest());
  check(manifestCc.commands?.['toggle-multi-captions']?.suggested_key?.default === 'Alt+Shift+C', '快捷键 Alt+Shift+C 开关多语字幕');
  const bridgeEntry = manifestCc.content_scripts.find((/** @type {any} */ c) => c.js.includes('content-multicc-bridge.js'));
  check(bridgeEntry?.world === 'MAIN' && manifestCc.content_scripts.find((/** @type {any} */ c) => c.js.includes('content-multicc.js'))?.world !== 'MAIN', '页面内助手跑在页面环境（MAIN），取字幕与画字幕层的脚本在隔离环境');
  check(!['scripting', 'webRequest', 'declarativeNetRequest', 'tabs'].some((p) => manifestCc.permissions.includes(p)), `多语字幕没有新增权限：${manifestCc.permissions.join(', ')}`);

  const timedtextReqs = (/** @type {string} */ v) => requests.filter((r) => r.path === '/api/timedtext' && r.query.v === v);
  const playerTt = (/** @type {string} */ v) => timedtextReqs(v).filter((r) => r.headers['x-mock-player'] === '1');
  const ourTt = (/** @type {string} */ v) => timedtextReqs(v).filter((r) => r.headers['x-mock-player'] !== '1');
  const ccStatus = panel.getByTestId('multicc-status');
  /** 播放器里多语字幕层每一行：语言、文字、是否标了机翻、是否隐藏、颜色 */
  const ccLines = (/** @type {import('playwright').Page} */ page) =>
    page.evaluate(() =>
      [...(document.querySelector('[data-tubemuse="multicc"]')?.shadowRoot?.querySelectorAll('.line') ?? [])].map((l) => ({
        lang: /** @type {HTMLElement} */ (l).dataset.lang,
        text: l.querySelector('.tx')?.textContent ?? '',
        mt: !(/** @type {HTMLElement} */ (l.querySelector('.mt')).hidden),
        hidden: /** @type {HTMLElement} */ (l).hidden,
        color: getComputedStyle(l).color,
      })),
    );
  const seekPaused = (/** @type {import('playwright').Page} */ page, /** @type {number} */ t) =>
    page.evaluate((t) => {
      const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
      v.pause();
      v.currentTime = t;
    }, t);
  /** 等字幕层显示出这几行文字（暂停时由每 250 毫秒一次的主循环刷新） */
  const waitCcText = (/** @type {import('playwright').Page} */ page, /** @type {string[]} */ texts) =>
    page.waitForFunction(
      (texts) =>
        JSON.stringify([...(document.querySelector('[data-tubemuse="multicc"]')?.shadowRoot?.querySelectorAll('.line:not([hidden]) .tx') ?? [])].map((x) => x.textContent)) === JSON.stringify(texts),
      texts,
      { timeout: 15000 },
    );
  /** 等字幕层有 n 行显示着文字 */
  const waitCcLines = (/** @type {import('playwright').Page} */ page, /** @type {number} */ n) =>
    page.waitForFunction((n) => (document.querySelector('[data-tubemuse="multicc"]')?.shadowRoot?.querySelectorAll('.line:not([hidden])').length ?? 0) === n, n, { timeout: 15000 });
  const nativeState = (/** @type {import('playwright').Page} */ page) =>
    page.evaluate(() => {
      const p = /** @type {any} */ (document.getElementById('movie_player'));
      const w = /** @type {any} */ (window);
      return { lang: p.getOption('captions', 'track')?.languageCode ?? null, windows: document.querySelectorAll('.caption-window').length, calls: /** @type {any[]} */ (w.__playerCalls), foreign: /** @type {string[]} */ (w.__foreign) };
    });
  /** 只允许调用播放器自己的字幕开关 */
  const onlyCaptionCalls = (/** @type {any[]} */ calls) => calls.every((c) => (c[0] === 'setOption' && c[1] === 'captions' && c[2] === 'track') || (c[0] === 'loadModule' && c[1] === 'captions'));

  console.log('\n[多语字幕：MV（原生字幕关着）→ 侧边栏开启 → 韩 / 英 / 中三行叠在播放器里，各按自己的时间轴]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '字幕', exact: true }).click();
  const [cc] = await Promise.all([
    context.waitForEvent('page'),
    panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}/watch?v=ccMulti0001`),
  ]);
  // ccFlaky00007 的字幕接口故意回 502 / 404：浏览器为这几个请求记的"Failed to load resource"是预期的，其余照常算错
  const expectedCcFailure = (/** @type {import('playwright').ConsoleMessage} */ m) => /\/api\/timedtext\?v=ccFlaky00007&/.test(m.location().url);
  cc.on('pageerror', (e) => consoleErrors.push(`multicc watch pageerror: ${e.message}`));
  cc.on('console', (m) => m.type() === 'error' && !expectedCcFailure(m) && consoleErrors.push(`multicc watch: ${m.text()}`));
  await cc.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await ccStatus.filter({ hasText: '未开启' }).waitFor({ timeout: 10000 });
  await cc.waitForTimeout(1500);
  check((await cc.locator('[data-tubemuse="multicc"]').count()) === 0 && timedtextReqs('ccMulti0001').length === 0, '默认不开启：不取字幕、不加字幕层、不碰原生字幕');
  const offOpts = (await panel.getByTestId('multicc-langs').textContent()) ?? '';
  check(['English', 'Chinese (Simplified)', 'Indonesian'].every((x) => offOpts.includes(x)), '侧边栏列出这个视频的 YouTube 字幕');
  const metaBefore = requests.filter((r) => r.path === '/youtube/v3/videos' && r.query.id === 'ccMulti0001').length;
  await panel.getByRole('button', { name: '显示多语字幕' }).click();
  await seekPaused(cc, 3.0);
  await waitCcText(cc, ['내 이름을 불러줘', 'Lead me', '叫我的名字']);
  const l3 = await ccLines(cc);
  check(JSON.stringify(l3.map((l) => l.lang)) === JSON.stringify(['ko', 'en', 'zh-Hans']), `从上到下：原声（韩语，查 YouTube 数据得知）、英文、简体中文：${l3.map((l) => l.lang).join(' / ')}`);
  check(new Set(l3.map((l) => l.color)).size === 3 && l3.every((l) => !l.mt), `三行都是原生字幕、颜色各不相同：${l3.map((l) => l.color).join(' ')}`);
  // 观看记录补元数据时也可能先查过（共用缓存），所以只要求查过、且没有反复查
  const metaCalls = requests.filter((r) => r.path === '/youtube/v3/videos' && r.query.id === 'ccMulti0001').length - metaBefore;
  check(metaCalls >= 0 && metaCalls <= 1 && requests.some((r) => r.path === '/youtube/v3/videos' && r.query.id === 'ccMulti0001'), `原声语言来自官方 videos.list（与观看记录共用缓存，这次查了 ${metaCalls} 次）`);
  // 第 3 秒：英文已到第二句"Lead me"，中文、韩文仍是第一句——各自的断句与时间戳
  await seekPaused(cc, 4.25);
  await waitCcText(cc, ['내 이름을 불러줘', 'Along the lines that connect us', '循着彼此相连的脉络']);
  check(true, '第 4.25 秒：英文、中文已换到下一句，韩文的上一句到 4.3 秒才结束——各按自己的时间轴，不硬对齐');
  await seekPaused(cc, 2.25);
  await waitCcText(cc, ['내 이름을 불러줘', 'Call my name', '叫我的名字']);
  check(true, '英文两句之间 0.1 秒的空档留着上一句，不闪');
  await seekPaused(cc, 14.5);
  await cc.waitForFunction(() => document.querySelector('[data-tubemuse="multicc"]')?.shadowRoot?.querySelector('.wrap')?.hasAttribute('hidden'), null, { timeout: 5000 });
  check(true, '所有语言都没有字幕的时段：整层隐藏');

  const pT = playerTt('ccMulti0001');
  const oT = ourTt('ccMulti0001');
  check(pT.length === 1 && /^MOCKPOT-ccMulti0001-1$/.test(pT[0]?.query.pot ?? ''), `原生字幕关着：TubeMuse 请播放器选了一次字幕轨，播放器自己发出带令牌的请求（${pT.length} 个）`);
  check(
    oT.length === 3 &&
      JSON.stringify(oT.map((r) => r.query.lang).sort()) === JSON.stringify(['en', 'ko', 'zh-Hans']) &&
      oT.every((r) => r.query.pot === pT[0]?.query.pot && r.query.signature === 'MOCKSIG' && r.query.fmt === 'json3' && !r.query.tlang && !r.headers.authorization),
    `复用播放器的请求、只换语言：三种语言各取一次（${oT.map((r) => r.query.lang).join(', ')}），令牌与签名原样`,
  );
  const ns1 = await nativeState(cc);
  check(ns1.lang === null && ns1.windows === 0, '为取字幕打开的原生字幕随即关掉：播放器里不会出现两层');
  check(onlyCaptionCalls(ns1.calls) && ns1.calls.length >= 2, `只调用了播放器自己的字幕开关：${ns1.calls.map((c) => c.join(' ')).join('；')}`);
  check(ns1.foreign.length === 0, `YouTube 自己的元素原样未动（播放器自己的字幕窗口除外）${ns1.foreign.length ? `：${ns1.foreign.join(', ')}` : ''}`);
  check(((await ccStatus.textContent()) ?? '').includes('正在显示 3 种语言'), `侧边栏：${await ccStatus.textContent()}`);
  const onOpts = (await panel.getByTestId('multicc-langs').textContent()) ?? '';
  check(onOpts.includes('原生字幕 · 原声') && /3 句/.test(onOpts), '侧边栏写明每一行的来源与读到的句数');
  await seekPaused(cc, 6.0);
  await waitCcText(cc, ['서로 이어진 결을 따라', 'Along the lines that connect us', '循着彼此相连的脉络']);
  await cc.screenshot({ path: join(shots, '30-multicc-overlay.png') });
  await panel.screenshot({ path: join(shots, '31-multicc-panel.png'), fullPage: true });

  console.log('\n[多语字幕：侧边栏给这个视频加一种语言；YouTube 返回空字幕时说明原因]');
  // 勾选框的状态要等页面里的脚本回话后才变（受控的勾选框）：用 click 再等结果，不用 check()（它点完立刻核对，会和回话赛跑）
  await panel.getByTestId('multicc-langs').getByRole('checkbox', { name: /Indonesian/ }).click();
  await panel.getByTestId('multicc-langs').getByText('YouTube 返回了空字幕').waitFor({ timeout: 10000 });
  check(await panel.getByTestId('multicc-langs').getByRole('checkbox', { name: /Indonesian/ }).isChecked(), '勾选印尼语后勾选框保持勾上');
  check(ourTt('ccMulti0001').filter((r) => r.query.lang === 'id').length === 1, '加了印尼语：立即用同一个请求取来（这条轨是空的）');
  check((await ccLines(cc)).filter((l) => !l.hidden).length === 3, '空的那一行不显示，其余三行照常');
  check(((await panel.getByTestId('multicc-panel').textContent()) ?? '').includes('这个视频改回默认语言'), '这个视频用的是单独选的语言：可以一键改回默认');
  await panel.getByRole('button', { name: '这个视频改回默认语言' }).click();
  await cc.waitForFunction(() => document.querySelector('[data-tubemuse="multicc"]')?.shadowRoot?.querySelectorAll('.line').length === 3, null, { timeout: 5000 });

  console.log('\n[多语字幕：全屏 / 剧场模式字号随播放器变大；控制栏出现时上移]');
  const ccVars = () => cc.evaluate(() => {
    const h = /** @type {HTMLElement} */ (document.querySelector('[data-tubemuse="multicc"]'));
    return { fs: parseFloat(h.style.getPropertyValue('--fs')), bottom: parseFloat(h.style.getPropertyValue('--bottom')) };
  });
  const small = await ccVars();
  await cc.evaluate(() => {
    const p = /** @type {HTMLElement} */ (document.getElementById('movie_player'));
    p.style.width = '1280px';
    p.style.height = '720px';
  });
  await cc.waitForTimeout(600);
  const big = await ccVars();
  check(big.fs > small.fs * 1.8, `播放器从 360 高变成 720 高：字号 ${small.fs}px → ${big.fs}px`);
  await cc.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.remove('ytp-autohide'));
  await cc.waitForTimeout(600);
  const withControls = await ccVars();
  check(withControls.bottom >= 48 + 12 && withControls.bottom > big.bottom, `控制栏出现时字幕上移：${big.bottom}px → ${withControls.bottom}px`);
  await cc.evaluate(() => {
    const p = /** @type {HTMLElement} */ (document.getElementById('movie_player'));
    p.style.width = '';
    p.style.height = '';
    p.classList.add('ytp-autohide');
  });

  console.log('\n[多语字幕：每种语言尽量只占一行——一句里手动断的行接成一行；放不下先缩小字号（最多到 75%），再放不下才折行]');
  /** 每一行：语言、文字排成了几行、字号、是否允许折行、是否放得下 */
  const lineBoxes = () =>
    cc.evaluate(() =>
      [...(document.querySelector('[data-tubemuse="multicc"]')?.shadowRoot?.querySelectorAll('.line:not([hidden])') ?? [])].map((x) => {
        const l = /** @type {HTMLElement} */ (x);
        return { lang: l.dataset.lang, rows: /** @type {HTMLElement} */ (l.querySelector('.tx')).getClientRects().length, fs: parseFloat(l.style.fontSize), multi: l.classList.contains('multi'), fits: l.scrollWidth <= l.clientWidth + 1, w: l.scrollWidth };
      }),
    );
  const setPlayerWidth = (/** @type {string} */ w) => cc.evaluate((w) => (/** @type {HTMLElement} */ (document.getElementById('movie_player')).style.width = w), w);
  await seekPaused(cc, 10.0);
  await waitCcText(cc, ["그거면 돼 I'm diving for", "Even if my feet don't touch the ground (diving for, diving for)", '哪怕双脚触不到底 (diving for, diving for)']);
  const fsBase = (await ccVars()).fs;
  const b10 = await lineBoxes();
  check(b10.length === 3 && b10.every((b) => b.rows === 1 && !b.multi && b.fits), `字幕里原本断成两行的歌词接成一行：三种语言各占一行（${b10.map((b) => `${b.lang} ${b.rows} 行`).join('，')}）`);
  check(b10[0]?.fs === fsBase && Math.abs((b10[1]?.fs ?? 0) - fsBase * 0.92) < 0.15, `放得下时不缩小：第一行 ${b10[0]?.fs}px，其后 ${b10[1]?.fs}px（92%）`);
  // 精确验证：量出英文这一行按原字号的宽度，再把播放器调窄到只够它 85% 宽 → 这一行应缩到约 85%、仍是一行
  const enW = b10.find((b) => b.lang === 'en')?.w ?? 0;
  const enBase = fsBase * 0.92;
  await setPlayerWidth(`${Math.ceil((enW * 0.85 + 2) / 0.96)}px`);
  await cc.waitForTimeout(600);
  const en85 = (await lineBoxes()).find((b) => b.lang === 'en');
  check(!!en85 && !en85.multi && en85.rows === 1 && en85.fits && en85.fs / enBase > 0.82 && en85.fs / enBase < 0.87, `放不下时等比缩小这一行：${enBase.toFixed(1)}px → ${en85?.fs}px，仍是一行`);
  await setPlayerWidth(`${Math.ceil((enW * 0.6 + 2) / 0.96)}px`);
  await cc.waitForTimeout(600);
  const en60 = (await lineBoxes()).find((b) => b.lang === 'en');
  check(!!en60 && en60.multi && en60.rows >= 2 && Math.abs(en60.fs - enBase * 0.75) < 0.15, `缩到 75% 还放不下才折行：${en60?.fs}px、${en60?.rows} 行`);
  await setPlayerWidth('');
  await seekPaused(cc, 13.8);
  await waitCcLines(cc, 1);
  await cc.waitForTimeout(300);
  const long = (await lineBoxes())[0];
  check(long?.lang === 'en' && long.multi && long.rows >= 2 && Math.abs(long.fs - enBase * 0.75) < 0.15, `一句特别长的字幕：缩到 75% 后折行，显示全文、不截断（${long?.rows} 行）`);
  await cc.setViewportSize({ width: 660, height: 380 });
  await cc.screenshot({ path: join(shots, '34-multicc-long-line.png') });
  await seekPaused(cc, 10.0);
  await waitCcText(cc, ["그거면 돼 I'm diving for", "Even if my feet don't touch the ground (diving for, diving for)", '哪怕双脚触不到底 (diving for, diving for)']);
  await cc.screenshot({ path: join(shots, '33-multicc-single-line.png') });
  await cc.setViewportSize({ width: 420, height: 900 });

  console.log('\n[多语字幕：关闭 → 字幕层移除；原生字幕本来关着，保持关着]');
  await panel.getByRole('button', { name: '关闭多语字幕' }).click();
  await cc.waitForFunction(() => !document.querySelector('[data-tubemuse="multicc"]'), null, { timeout: 5000 });
  await cc.waitForTimeout(1500);
  const ns2 = await nativeState(cc);
  check(ns2.lang === null && ns2.calls.length === ns1.calls.length, '关闭后不替你打开原生字幕（它本来就关着）');
  check(((await ccStatus.textContent()) ?? '').includes('你已关闭'), '侧边栏：你已关闭这个视频的多语字幕');

  console.log('\n[多语字幕：演讲（原生英文字幕开着）→ 开启时关掉原生字幕、英文 + YouTube 机翻中文 → 关闭时恢复原生字幕]');
  await cc.goto(`${MOCK}/watch?v=ccNative0002`);
  await cc.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await ccStatus.filter({ hasText: '未开启' }).waitFor({ timeout: 10000 });
  check((await nativeState(cc)).lang === 'en', '页面打开时原生英文字幕开着（播放器自己取了一次字幕）');
  await panel.getByRole('button', { name: '显示多语字幕' }).click();
  await seekPaused(cc, 3.5);
  await waitCcText(cc, ['I was a government major,', '[zh-Hans] I was a government major,']);
  const lt = await ccLines(cc);
  check(lt[0]?.lang === 'en' && !lt[0].mt && lt[1]?.lang === 'zh-Hans' && lt[1].mt, '原声（自动生成字幕是英文）→ 用人工英文字幕；简体中文没有原生轨 → YouTube 自动翻译，标"机翻"');
  const pT2 = playerTt('ccNative0002');
  const oT2 = ourTt('ccNative0002');
  check(pT2.length === 1, '原生字幕开着时直接复用播放器已经发出的请求，不再请它取');
  check(
    oT2.length === 2 && oT2.some((r) => r.query.lang === 'en' && !r.query.tlang && !r.query.kind) && oT2.some((r) => r.query.lang === 'en' && r.query.tlang === 'zh-Hans'),
    `取了人工英文与"英文 → 简体中文"的 YouTube 机翻（tlang）：${oT2.map((r) => `${r.query.lang}${r.query.tlang ? `>${r.query.tlang}` : ''}`).join(', ')}`,
  );
  const ns3 = await nativeState(cc);
  check(ns3.lang === null && ns3.windows === 0, '显示期间关掉了原生字幕（避免两层）');
  check(((await panel.getByTestId('multicc-langs').textContent()) ?? '').includes('YouTube 机翻'), '侧边栏标明哪一行是 YouTube 机翻');
  await cc.screenshot({ path: join(shots, '32-multicc-autotranslate.png') });
  await panel.getByRole('button', { name: '关闭多语字幕' }).click();
  await cc.waitForFunction(() => /** @type {any} */ (document.getElementById('movie_player')).getOption('captions', 'track')?.languageCode === 'en', null, { timeout: 5000 });
  check(true, '关闭多语字幕：原生英文字幕恢复成你原来的选择');

  console.log('\n[多语字幕：显示期间你自己打开原生字幕（按 C）→ 多语字幕先让开；关掉原生字幕即恢复，之后不再替你恢复]');
  await panel.getByRole('button', { name: '显示多语字幕' }).click();
  await waitCcText(cc, ['I was a government major,', '[zh-Hans] I was a government major,']);
  await cc.waitForFunction(() => !(/** @type {any} */ (document.getElementById('movie_player')).getOption('captions', 'track')?.languageCode), null, { timeout: 5000 });
  // 你是在看的过程中按 C 的：先播三秒，明确越过 2 秒的宽限期（autoCaptionGracePlaySec）。
  // 正片刚开始那一下，原生字幕被打开算播放器按你的偏好自动打开的，见下一场景；只播 2 秒正好卡在边界上，机器一慢就算错。
  await cc.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.currentTime = 0.5;
    return v.play();
  });
  await cc.waitForTimeout(3000);
  await cc.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).pause());
  await waitCcLines(cc, 2);
  // 模拟你在 YouTube 的字幕菜单里选了韩语（播放器自己的操作）
  await cc.evaluate(() => /** @type {any} */ (document.getElementById('movie_player')).setOption('captions', 'track', { languageCode: 'ko' }));
  await ccStatus.filter({ hasText: '先让开' }).waitFor({ timeout: 8000 });
  await cc.waitForFunction(() => !document.querySelector('[data-tubemuse="multicc"]')?.shadowRoot?.querySelector('.line'), null, { timeout: 5000 });
  check((await nativeState(cc)).lang === 'ko', '你打开的原生字幕保持开着，多语字幕不和你抢');
  await cc.evaluate(() => /** @type {any} */ (document.getElementById('movie_player')).setOption('captions', 'track', {}));
  await waitCcLines(cc, 2);
  check(true, '你关掉原生字幕：多语字幕回来');
  const callsBeforeOff = (await nativeState(cc)).calls.length;
  await panel.getByRole('button', { name: '关闭多语字幕' }).click();
  await cc.waitForFunction(() => !document.querySelector('[data-tubemuse="multicc"]'), null, { timeout: 5000 });
  await cc.waitForTimeout(1500);
  const ns4 = await nativeState(cc);
  check(ns4.lang === null && ns4.calls.length === callsBeforeOff, '期间你自己动过原生字幕：关闭时不再替你恢复（保持你最后的选择）');
  check(onlyCaptionCalls(ns4.calls.slice(1)) && ns4.foreign.length === 0, 'TubeMuse 只调用了字幕开关，没有改动 YouTube 的元素');

  console.log('\n[多语字幕：没有 YouTube 字幕的视频 → 说明，不发请求]');
  await cc.goto(`${MOCK}/watch?v=ccNoTrack003`);
  await cc.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await ccStatus.filter({ hasText: '没有 YouTube 字幕' }).waitFor({ timeout: 10000 });
  await panel.getByRole('button', { name: '显示多语字幕' }).click();
  await cc.locator('[data-tubemuse="multicc"] .status').filter({ hasText: '这个视频没有 YouTube 字幕' }).waitFor({ timeout: 8000 });
  check(timedtextReqs('ccNoTrack003').length === 0 && (await nativeState(cc)).calls.length === 0, '播放器里说明"这个视频没有 YouTube 字幕"，不发请求、不碰播放器');

  console.log('\n[多语字幕：YouTube 一直返回空字幕（令牌失效）→ 换轨重试 3 次后停下并说明，不无限重试]');
  await cc.goto(`${MOCK}/watch?v=ccStale00004`);
  await cc.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await ccStatus.filter({ hasText: '未开启' }).waitFor({ timeout: 10000 });
  await panel.getByRole('button', { name: '显示多语字幕' }).click();
  const staleChip = cc.locator('[data-tubemuse="multicc"] .status');
  await staleChip.filter({ hasText: '已停止' }).waitFor({ timeout: 30000 });
  const staleCount = playerTt('ccStale00004').length;
  await cc.waitForTimeout(3000);
  check(staleCount === 3 && playerTt('ccStale00004').length === staleCount, `请播放器换了 ${staleCount} 条轨重取，之后不再请求`);
  check(((await staleChip.textContent()) ?? '').includes('刷新这个页面'), `播放器里用人话说明：${(await staleChip.textContent())?.slice(0, 50)}…`);
  check(((await ccStatus.textContent()) ?? '').includes('已停止'), '侧边栏同步显示停止原因');
  check((await nativeState(cc)).lang === null, '停下后原生字幕也关回去（它本来就关着）');

  // 2026-11-03 用户报告：部分视频一直"正在读取字幕…"。实测 YouTube 的字幕接口（连同播放器自己的请求）20 秒才回、多数 40 秒后 502（DECISIONS §42）
  console.log('\n[多语字幕：YouTube 的字幕接口又慢又时不时出错 → 说明在等什么；502 隔一会儿重试；404 不重试，关掉再打开即重试]');
  await cc.goto(`${MOCK}/watch?v=ccFlaky00007`);
  await cc.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await ccStatus.filter({ hasText: '未开启' }).waitFor({ timeout: 10000 });
  await seekPaused(cc, 3.0);
  await panel.getByRole('button', { name: '显示多语字幕' }).click();
  const flakyTt = (/** @type {string} */ lang) => ourTt('ccFlaky00007').filter((r) => r.query.lang === lang).length;
  await ccStatus.filter({ hasText: '响应很慢' }).waitFor({ timeout: 30000 });
  const slowText = (await ccStatus.textContent()) ?? '';
  const slowChip = (await cc.locator('[data-tubemuse="multicc"] .status').textContent()) ?? '';
  check(/YouTube 的字幕接口响应很慢，已等 \d+ 秒/.test(slowText) && slowChip.includes('响应很慢'), `一种都还没读到、请求等了 8 秒以上：侧边栏与播放器里都说明是 YouTube 那边慢（${slowText}）`);
  await ccStatus.filter({ hasText: '正在显示 1 种语言' }).waitFor({ timeout: 15000 });
  const flakyOpts = (await panel.getByTestId('multicc-langs').textContent()) ?? '';
  check(flakyOpts.includes('YouTube 的字幕服务器出错（HTTP 502），稍后重试') && flakyOpts.includes('YouTube 的字幕接口返回 HTTP 404'), '慢的韩文读到了；英文那一行写明 502、稍后重试；中文那一行写明 404');
  check(((await ccStatus.textContent()) ?? '').includes('还有 1 种在读取'), `侧边栏：${await ccStatus.textContent()}`);
  await ccStatus.filter({ hasText: '正在显示 2 种语言' }).waitFor({ timeout: 40000 });
  await waitCcText(cc, ['내 이름을 불러줘', 'Call my name']);
  check(flakyTt('en') === 3 && flakyTt('ko') === 1 && flakyTt('zh-Hans') === 1, `英文 502 两次后第 3 次读到（隔 5、15 秒重试）；韩文只取了一次；404 不重试（英 ${flakyTt('en')}、韩 ${flakyTt('ko')}、中 ${flakyTt('zh-Hans')} 次）`);
  await panel.getByRole('button', { name: '关闭多语字幕' }).click();
  await panel.getByRole('button', { name: '显示多语字幕' }).click();
  await ccStatus.filter({ hasText: '正在显示 3 种语言' }).waitFor({ timeout: 15000 });
  await waitCcText(cc, ['내 이름을 불러줘', 'Call my name', '叫我的名字']);
  check(flakyTt('zh-Hans') === 2 && flakyTt('en') === 3 && flakyTt('ko') === 1, '关掉再打开：只重取没读到的中文，读到的两种不再取');

  console.log('\n[多语字幕：旧版存下的 autoOn: true 不再生效，打开视频不自动显示]');
  await options.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const { settings } = await c.storage.local.get('settings');
    await c.storage.local.set({ settings: { ...settings, multiCaptions: { ...settings.multiCaptions, autoOn: true } } });
  });
  await options.waitForTimeout(300);
  await cc.bringToFront();
  await cc.goto(`${MOCK}/watch?v=ccMulti0001`);
  await cc.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await cc.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  await ccStatus.filter({ hasText: '未开启' }).waitFor({ timeout: 10000 });
  await cc.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).pause());
  check((await ccStatus.filter({ hasText: '未开启' }).count()) === 1, '旧设置里的 autoOn: true 作废：不点就不显示多语字幕');

  console.log('\n[多语字幕：设置里勾选"自动显示" → 有字幕的视频打开就显示]');
  await options.bringToFront();
  await options.getByTestId('multicc-autoshow').check();
  await options.waitForTimeout(300);
  await cc.bringToFront();
  await cc.goto(`${MOCK}/watch?v=ccMulti0001`);
  await cc.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await seekPaused(cc, 3.0);
  await waitCcText(cc, ['내 이름을 불러줘', 'Lead me', '叫我的名字']);
  check(true, '不用点：打开就叠加三种语言');
  check(
    requests.filter((r) => r.path === '/api/timedtext').every((r) => !String(r.headers.origin ?? '').startsWith('chrome-extension://') && !r.headers.authorization && !JSON.stringify(r).includes(FAKE_KEY)),
    '字幕请求都是播放页自己发出的同源请求：不经过扩展后台、不带任何 Key 或令牌',
  );

  // 2026-11-02 用户报告：开启后播放器里只有一种字幕，侧边栏写"你打开了 YouTube 原生字幕，多语字幕先让开"——其实没按 C。
  // 根因：你保存的 YouTube 偏好是"字幕开、中文"，播放器在正片开始后约 0.8 秒自动打开它；多语字幕若在这之前完成了第一次检查，
  // 就把这次自动打开当成了你的操作（DECISIONS §38）
  /** 等播放器按偏好自动打开中文、又被多语字幕关掉之后，检查没有让开、原生字幕关着、令牌来自那次自动打开 */
  const checkStickyAbsorbed = async (/** @type {string} */ id, /** @type {string} */ how) => {
    await waitCcLines(cc, 3);
    await cc.waitForTimeout(2500);
    const st = (await ccStatus.textContent()) ?? '';
    const ns = await nativeState(cc);
    check(!st.includes('先让开') && st.includes('正在显示 3 种语言') && ns.lang === null && ns.windows === 0, `${how}：播放器按你的偏好自动打开中文——没有误当成你按了 C，照常叠加三种语言、原生字幕关着（${st}）`);
    const pS = playerTt(id);
    check(pS.length === 1 && pS[0]?.query.lang === 'zh-Hans' && ourTt(id).length === 3, `直接复用那次自动打开发出的请求（${pS.map((r) => r.query.lang).join(', ')}），没有另外请播放器选轨`);
    await seekPaused(cc, 3.0);
    await waitCcText(cc, ['내 이름을 불러줘', 'Lead me', '叫我的名字']);
    await panel.getByRole('button', { name: '关闭多语字幕' }).click();
    await cc.waitForFunction(() => /** @type {any} */ (document.getElementById('movie_player')).getOption('captions', 'track')?.languageCode === 'zh-Hans', null, { timeout: 5000 });
    check(true, '关闭多语字幕：原生字幕恢复成你保存的中文');
  };

  console.log('\n[多语字幕：你保存的偏好是"字幕开、中文"，勾选了自动显示——页面打开约 1 秒后播放器自动打开中文（用户报告的 bug）]');
  await cc.goto(`${MOCK}/watch?v=ccSticky0006`);
  await cc.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await cc.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  await checkStickyAbsorbed('ccSticky0006', '自动显示');

  await options.bringToFront();
  await options.getByTestId('multicc-autoshow').uncheck();
  await options.waitForTimeout(300);
  await cc.bringToFront();

  console.log('\n[多语字幕：同样的偏好，先放 2.5 秒广告，你在广告期间点了"显示多语字幕"——广告结束后播放器自动打开中文]');
  await cc.goto(`${MOCK}/watch?v=ccSticky0005`);
  await cc.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await cc.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  await ccStatus.filter({ hasText: '未开启' }).waitFor({ timeout: 10000 });
  check(await cc.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.contains('ad-showing')), '正在播广告');
  await panel.getByRole('button', { name: '显示多语字幕' }).click();
  await checkStickyAbsorbed('ccSticky0005', '广告期间开启');

  await cc.close();
  await panel.bringToFront();

  // ───────────────────────── 片段录制 ─────────────────────────
  console.log('\n[片段录制：设置]');
  await options.bringToFront();
  await options.reload();
  await options.locator('#clips').waitFor();
  check(((await options.locator('#clips').textContent()) ?? '').includes('14. 片段录制') && (await options.getByTestId('clips-enabled').isChecked()), '设置页有"片段录制"一节（多语字幕之后顺延为 14），默认启用');
  const xhsSection = (await options.locator('#xhs').textContent()) ?? '';
  check(
    xhsSection.includes('15. 小红书') && (await options.getByTestId('xhs-enabled').isChecked()) && (await options.getByTestId('xhs-show-time').isChecked()) && (await options.getByTestId('xhs-show-save').isChecked()),
    '设置页有"小红书"一节（片段录制之后为 15），默认启用、显示时间与收藏按钮',
  );
  check(((await options.locator('#data').textContent()) ?? '').includes('17. 数据'), '"数据"一节顺延为 17');
  check(((await options.locator('#email').textContent()) ?? '').includes('16. eMails') && (await options.getByTestId('email-enabled').isChecked()), '设置页有"eMails"一节（小红书之后为 16），默认启用');
  const sw2 = context.serviceWorkers()[0] ?? sw;
  const manifest2 = await sw2.evaluate(() => /** @type {any} */ (globalThis).chrome.runtime.getManifest());
  check(manifest2.commands?.['toggle-clip-recording']?.suggested_key?.default === 'Alt+Shift+R', '快捷键 Alt+Shift+R 开始 / 停止录制');
  check(!['downloads', 'tabCapture', 'offscreen', 'desktopCapture'].some((p) => manifest2.permissions.includes(p)), `片段录制没有新增权限：${manifest2.permissions.join(', ')}`);

  /** 在页面里解析录到的片段：文件头、时长、画面尺寸、声音响度、画面底部（字幕处）与上部的亮像素数 */
  const analyzeClip = async (/** @type {import('playwright').Page} */ page, /** @type {string} */ file) => {
    const b64 = readFileSync(file).toString('base64');
    return page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes]);
      const url = URL.createObjectURL(blob);
      const v = document.createElement('video');
      v.muted = true;
      v.src = url;
      await new Promise((resolve, reject) => {
        v.onloadedmetadata = resolve;
        v.onerror = () => reject(new Error('片段无法播放'));
      });
      // MediaRecorder 录的 WebM 不写总时长：跳到末尾让浏览器算出来
      if (!Number.isFinite(v.duration)) {
        v.currentTime = 1e9;
        await new Promise((r) => (v.onseeked = r));
      }
      const duration = v.duration;
      v.currentTime = Math.min(duration / 2, 1);
      await new Promise((r) => (v.onseeked = r));
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
      g.drawImage(v, 0, 0);
      const bright = (/** @type {number} */ y0, /** @type {number} */ y1) => {
        const d = g.getImageData(0, Math.floor(c.height * y0), c.width, Math.floor(c.height * (y1 - y0))).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 600) n++;
        return n;
      };
      // 文件头里没有声音轨（声音数据可能还在文件里，但播放器读不到）时解不出声音：响度记 0
      const ac = new AudioContext();
      let rms = 0;
      try {
        const ch = (await ac.decodeAudioData(await blob.arrayBuffer())).getChannelData(0);
        let s = 0;
        for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
        rms = Math.sqrt(s / ch.length);
      } catch {
        // 没有可解码的声音轨
      }
      URL.revokeObjectURL(url);
      void ac.close();
      return { head: Array.from(bytes.slice(0, 12)), duration, width: v.videoWidth, height: v.videoHeight, rms, bottomBright: bright(0.8, 0.95), topBright: bright(0.05, 0.6) };
    }, b64);
  };
  /** MP4（第 4–8 字节是 ftyp）或 WebM（EBML 头 1A 45 DF A3） */
  const container = (/** @type {number[]} */ head) => (String.fromCharCode(...head.slice(4, 8)) === 'ftyp' ? 'mp4' : head.slice(0, 4).join(',') === '26,69,223,163' ? 'webm' : 'unknown');
  const clipLog = () => panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('clipLog').then((/** @type {any} */ r) => r.clipLog ?? []));
  const clipStatus = panel.getByTestId('clip-status');
  const recordedSec = async () => parseTimecodeText((await panel.getByTestId('clip-recorded').textContent()) ?? '');
  const parseTimecodeText = (/** @type {string} */ t) => t.split(':').reduce((a, x) => a * 60 + Number(x), 0);

  console.log('\n[片段录制：自由录制 → 暂停 / 广告时自动暂停 → 停止并保存 → 浏览器存进下载文件夹 → 记一笔]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '片段', exact: true }).click();
  const [clipPage] = await Promise.all([
    context.waitForEvent('page'),
    panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}/watch?v=clipFree0001`),
  ]);
  clipPage.on('pageerror', (e) => consoleErrors.push(`clip watch pageerror: ${e.message}`));
  clipPage.on('console', (m) => m.type() === 'error' && consoleErrors.push(`clip watch: ${m.text()}`));
  await clipPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await clipPage.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  const clipPlayerHtml = () => clipPage.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).outerHTML.replace(/ class="[^"]*"/, ''));
  const playerBefore = await clipPlayerHtml();
  const requestsBeforeClip = requests.length;
  const freeStartedAt = Date.now();
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  const badge = await sw2.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [t] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes('clipFree0001'));
    return c.action.getBadgeText({ tabId: t.id });
  });
  check(badge === 'REC', `录制中工具栏图标显示 REC（实际："${badge}"）`);
  await clipPage.waitForTimeout(2500);
  await clipPage.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).pause());
  await clipStatus.filter({ hasText: '视频已暂停' }).waitFor({ timeout: 5000 });
  const atPause = await recordedSec();
  await clipPage.waitForTimeout(1500);
  check((await recordedSec()) === atPause, `视频暂停时录制自动暂停、不计时（停在 ${atPause} 秒）`);
  // 模拟广告：YouTube 播广告时给播放器加 ad-showing
  await clipPage.evaluate(() => {
    /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.add('ad-showing');
    return /** @type {HTMLVideoElement} */ (document.querySelector('video')).play();
  });
  await clipStatus.filter({ hasText: '广告中' }).waitFor({ timeout: 5000 });
  await clipPage.waitForTimeout(1500);
  check((await recordedSec()) === atPause, '广告期间自动暂停，不录广告');
  await clipPage.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.remove('ad-showing'));
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 5000 });
  await clipPage.waitForTimeout(1500);
  await panel.screenshot({ path: join(shots, '23-clip-recording.png'), fullPage: true });
  const [freeDl] = await Promise.all([clipPage.waitForEvent('download', { timeout: 15000 }), panel.getByTestId('clip-stop').click()]);
  const freeWall = (Date.now() - freeStartedAt) / 1000;
  const freeName = freeDl.suggestedFilename();
  check(/^mock watch_00m0\ds-00m\d\ds\.(mp4|webm)$/.test(freeName), `停止后直接交给浏览器保存，文件名带标题与起止时间：${freeName}`);
  const free = await analyzeClip(clipPage, /** @type {string} */ (await freeDl.path()));
  check(container(free.head) === freeName.split('.').pop(), `文件格式与扩展名一致（${container(free.head)}）`);
  check(free.duration > 2.5 && free.duration < freeWall - 2, `片段 ${free.duration.toFixed(1)} 秒：只含播放的部分，暂停与广告的 ${(freeWall - free.duration).toFixed(1)} 秒没有录进去`);
  check(free.width === 1280 && free.height === 720, `有画面轨（只有声音的视频按默认 1280×720 输出：${free.width}×${free.height}）`);
  check(free.rms > 0.02, `录到了这个视频的声音（响度 ${free.rms.toFixed(3)}）`);
  check(free.bottomBright === 0, '没开字幕烧录：画面里没有多出字幕');
  await panel.getByTestId('clip-saved').waitFor({ timeout: 5000 });
  check(((await panel.getByTestId('clip-ready').textContent()) ?? '').includes(freeName), '侧边栏显示存好的文件名，可以再存一次');
  await panel.getByTestId('clip-log').waitFor({ timeout: 5000 });
  const log1 = await clipLog();
  check(log1.length === 1 && log1[0].fileName === freeName && log1[0].videoId === 'clipFree0001' && log1[0].mode === 'free' && !('blob' in log1[0]), '"最近录过的片段"记下文件名、时间段与大小（不存视频本身）');
  check(JSON.stringify(await clipPlayerHtml()) === JSON.stringify(playerBefore), '录制没有往页面里加任何元素，播放器原样未动');
  check(requests.slice(requestsBeforeClip).every((r) => r.path.startsWith('/media/')), '录制与保存不发任何网络请求（只有播放器自己加载媒体）');

  // 2026-11-02 用户报告：片头广告中开始录，存下的 MP4 没有声音。录音机开始后先暂停了一阵，
  // Chrome 的 MP4 封装把声音排在画面之后，写文件头时还没有声音轨——声音数据在文件里，播放器却读不到。
  // 文件头随第一个分片写出（一片约 101 帧；mock 视频只有声音，画布约 10 帧/秒，一片约 10 秒）：
  // 开头等待的时长超过一片、之后又录满一片才会复现（修复前的构建：等 13 秒、录 12 秒 → 文件头只有画面轨）
  console.log('\n[片段录制：片头广告中开始 → 广告结束才真正开录 → 文件里有声音]');
  await clipPage.goto(`${MOCK}/watch?v=clipPreroll1`);
  await clipPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await clipPage.evaluate(() => {
    /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.add('ad-showing');
    return /** @type {HTMLVideoElement} */ (document.querySelector('video')).play();
  });
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '广告中' }).waitFor({ timeout: 5000 });
  await clipPage.waitForTimeout(13000);
  await clipPage.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.remove('ad-showing'));
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 5000 });
  await clipPage.waitForTimeout(12000);
  const [prerollDl] = await Promise.all([clipPage.waitForEvent('download', { timeout: 15000 }), panel.getByTestId('clip-stop').click()]);
  const preroll = await analyzeClip(clipPage, /** @type {string} */ (await prerollDl.path()));
  check(preroll.duration > 10.5 && preroll.duration < 16,`只录了广告之后的部分（${preroll.duration.toFixed(1)} 秒）`);
  check(preroll.rms > 0.02, `开始时等了 13 秒广告，文件里仍有声音（响度 ${preroll.rms.toFixed(3)}）`);

  console.log('\n[片段录制：按时间段截取 → 自动跳到起点、到终点自动停；字幕烧进画面]');
  await clipPage.goto(`${MOCK}/watch?v=clipRange001`);
  await clipPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  // 播放器里显示着一行原生字幕（YouTube 的字幕结构）
  await clipPage.evaluate(() => {
    const win = document.createElement('div');
    win.className = 'caption-window';
    win.style.cssText = 'position:absolute;left:0;right:0;bottom:60px;text-align:center';
    const line = document.createElement('span');
    line.className = 'caption-visual-line';
    line.textContent = 'WWWW MMMM 字幕烧录测试';
    win.append(line);
    /** @type {HTMLElement} */ (document.getElementById('movie_player')).append(win);
  });
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  await panel.getByTestId('clip-burn').check();
  await panel.getByTestId('clip-mode-range').click();
  await panel.getByTestId('clip-start-at').fill('0:02');
  await panel.getByTestId('clip-end-at').fill('0:05');
  const [rangeDl] = await Promise.all([clipPage.waitForEvent('download', { timeout: 20000 }), panel.getByTestId('clip-start').click()]);
  const rangeName = rangeDl.suggestedFilename();
  check(/_00m02s-00m05s\.(mp4|webm)$/.test(rangeName), `到终点自动停止并保存：${rangeName}`);
  const range = await analyzeClip(clipPage, /** @type {string} */ (await rangeDl.path()));
  check(range.duration > 2.5 && range.duration < 3.8, `片段 ${range.duration.toFixed(2)} 秒（截取 0:02–0:05）`);
  check(range.rms > 0.02, '时间段片段也有声音');
  check(range.bottomBright > 200 && range.topBright === 0, `字幕烧进了画面底部（亮像素 ${range.bottomBright}），画面其他地方没有多出东西`);
  const log2 = await clipLog();
  check(log2.length === 3 && log2[0].mode === 'range' && log2[0].burned === true && log2[0].start === 2 && log2[0].end === 5, '记录里写明是时间段、带字幕');
  await panel.getByTestId('clip-burn').uncheck();

  console.log('\n[片段录制：关掉"停止后直接保存" → 先留在内存里，点保存才存；可以丢弃]');
  await panel.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const { settings } = await c.storage.local.get('settings');
    await c.storage.local.set({ settings: { ...settings, clips: { ...settings.clips, autoSave: false } } });
  });
  await clipPage.goto(`${MOCK}/watch?v=clipManual01`);
  await clipPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await clipPage.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  await panel.getByRole('radio', { name: '自由录制' }).click();
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  await clipPage.waitForTimeout(1500);
  /** @type {import('playwright').Download[]} */
  const stray = [];
  clipPage.on('download', (d) => stray.push(d));
  await panel.getByRole('button', { name: '■ 停止', exact: true }).click();
  await clipStatus.filter({ hasText: '还没保存' }).waitFor({ timeout: 5000 });
  await clipPage.waitForTimeout(1000);
  check(stray.length === 0, '停止后没有自动保存，侧边栏提示"还没保存"');
  const [manualDl] = await Promise.all([clipPage.waitForEvent('download', { timeout: 5000 }), panel.getByTestId('clip-save').click()]);
  check(/^mock watch_.*\.(mp4|webm)$/.test(manualDl.suggestedFilename()), `点"保存到本地"才交给浏览器保存：${manualDl.suggestedFilename()}`);
  await panel.getByRole('button', { name: '释放内存' }).click();
  await panel.getByTestId('clip-ready').waitFor({ state: 'detached', timeout: 5000 });
  check(true, '"释放内存"后片段从内存里清掉');
  await panel.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const { settings } = await c.storage.local.get('settings');
    await c.storage.local.set({ settings: { ...settings, clips: { ...settings.clips, autoSave: true } } });
  });

  console.log('\n[片段录制：站内换视频（YouTube 是单页应用）→ 这一段自动结束并保存]');
  await clipPage.goto(`${MOCK}/watch?v=clipSpa00001`);
  await clipPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await clipPage.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  await clipPage.waitForTimeout(1500);
  const [spaDl] = await Promise.all([clipPage.waitForEvent('download', { timeout: 10000 }), clipPage.evaluate(() => history.pushState(null, '', '/watch?v=clipOther001'))]);
  check(/^mock watch_.*\.(mp4|webm)$/.test(spaDl.suggestedFilename()), `换到别的视频时自动结束这一段并保存：${spaDl.suggestedFilename()}`);
  await panel.getByTestId('clip-ready').filter({ hasText: '切到了别的视频' }).waitFor({ timeout: 5000 });
  check(true, '侧边栏说明这一段为什么结束');
  await panel.screenshot({ path: join(shots, '24-clip-panel.png'), fullPage: true });
  await clipPage.close();
  await panel.bringToFront();

  // ───────────────────────── 小红书 ─────────────────────────
  console.log('\n[小红书：博主主页 → 卡片作者那一行显示发布时间；卡片高度不变，不压住下面那张]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '小红书' }).click();
  check(((await panel.getByTestId('xhs-empty').textContent()) ?? '').includes('还没有收藏'), '侧边栏"小红书"页：还没有收藏时说明怎么开始');
  const xhsReqStart = requests.length;
  const xhsProfileUrl = `${MOCK}/xhs/user/profile/${XHS_UID}?xsec_token=ABprofile%3D&xsec_source=pc_feed`;
  const [xhs] = await Promise.all([context.waitForEvent('page'), panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), xhsProfileUrl)]);
  xhs.on('pageerror', (e) => consoleErrors.push(`xhs pageerror: ${e.message}`));
  xhs.on('console', (m) => m.type() === 'error' && consoleErrors.push(`xhs: ${m.text()}`));
  await xhs.waitForFunction(() => document.querySelectorAll('[data-tubemuse="xhs-time"][data-source="page"]').length === 2, null, { timeout: 15000 });
  const xhsTimes = await xhs.evaluate(() =>
    [...document.querySelectorAll('section.note-item')].map((s) => {
      const t = /** @type {HTMLTimeElement} */ (s.querySelector('[data-tubemuse="xhs-time"]'));
      const d = new Date(t.dateTime);
      const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
      const local = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return { text: t.textContent, iso: t.dateTime, source: t.dataset.source, hint: t.title, local, between: t.previousElementSibling?.matches('a.author') && t.nextElementSibling?.matches('.like-wrapper') };
    }),
  );
  const [t1, t2, t3] = xhsTimes;
  check(t1.source === 'page' && t1.iso === new Date(XHS_N1.time).toISOString() && t1.text === t1.local && !t1.hint, `登录后的卡片：显示页面数据里的发布时间 ${t1.text}（比笔记 ID 推算的晚 2 小时，以页面数据为准；本地时区，精确到分钟）`);
  check(t2.source === 'page' && t2.iso === new Date(XHS_N2.time).toISOString(), `未登录样式的卡片（链接里没有笔记 ID）：按位置 + 标题对上页面数据 ${t2.text}`);
  check(t3.source === 'id' && t3.iso === new Date(XHS_N3.idTime).toISOString() && t3.text === `≈${t3.local}` && t3.hint.includes('笔记 ID'), `页面数据里没有的笔记：由笔记 ID 推算，显示 ${t3.text} 并在悬停提示里说明`);
  check(xhsTimes.every((t) => t.between), '时间插在作者名与点赞数之间（红框区域，作者那一行）');
  const xhsLayout = await xhs.evaluate(() => {
    const L = /** @type {any} */ (window).__layout;
    const cards = [...document.querySelectorAll('section.note-item')].map((s) => s.getBoundingClientRect());
    const sameHeights = L.every((/** @type {any} */ l, /** @type {number} */ i) => Math.abs(cards[i].height - l.height) < 0.5);
    const noOverlap = L.every((/** @type {any} */ a, /** @type {number} */ i) => L.every((/** @type {any} */ b, /** @type {number} */ j) => i === j || a.col !== b.col || cards[i].bottom <= cards[j].top + 0.5 || cards[j].bottom <= cards[i].top + 0.5));
    const rows = [...document.querySelectorAll('section.note-item .author-wrapper')].map((r) => r.getBoundingClientRect().height);
    return { sameHeights, noOverlap, oneLine: rows.every((h) => Math.abs(h - 20) < 0.5) };
  });
  check(xhsLayout.sameHeights && xhsLayout.noOverlap && xhsLayout.oneLine, '卡片高度与小红书排版时一样、同一列上下卡片不重叠、作者那一行仍是一行');
  await panel.getByTestId('xhs-tab-status').filter({ hasText: '找到 3 张笔记卡片' }).waitFor({ timeout: 5000 });
  const xhsStatus = (await panel.getByTestId('xhs-tab-status').textContent()) ?? '';
  check(xhsStatus.includes('博主主页') && xhsStatus.includes('2 张显示页面数据里的发布时间') && xhsStatus.includes('1 张由笔记 ID 推算'), `侧边栏说明当前页的情况：${xhsStatus}`);
  await xhs.screenshot({ path: join(shots, '25-xhs-profile.png') });

  console.log('\n[小红书：卡片上点"收藏" → 弹窗加标签 → 存在本机；不打开笔记、不点小红书自己的元素]');
  const xhsCard = (/** @type {number} */ i) => xhs.locator('section.note-item').nth(i);
  const xhsStored = () => panel.evaluate(async () => (await /** @type {any} */ (globalThis).chrome.storage.local.get('xhs')).xhs ?? { notes: {}, users: {} });
  const saveOpacity = (/** @type {number} */ i) => xhsCard(i).locator('[data-tubemuse="xhs-save"]').evaluate((h) => getComputedStyle(h).opacity);
  await xhs.mouse.move(400, 10);
  await xhs.waitForTimeout(300);
  const hiddenBefore = await saveOpacity(0);
  await xhsCard(0).hover();
  await xhs.waitForTimeout(300);
  check(hiddenBefore === '0' && (await saveOpacity(0)) === '1', '"收藏"平时不显示，鼠标移到卡片上时出现在封面左下角');
  const coverBox = await xhsCard(0).locator('a.cover').boundingBox();
  const saveBox = await xhsCard(0).locator('[data-tubemuse="xhs-save"] button').boundingBox();
  check(!!coverBox && !!saveBox && saveBox.y > coverBox.y && saveBox.y + saveBox.height <= coverBox.y + coverBox.height && saveBox.x >= coverBox.x, '按钮在封面范围内（不占卡片高度）');
  await xhsCard(0).locator('[data-tubemuse="xhs-save"] button').click();
  const xhsPop = xhs.locator('[data-tubemuse="xhs-pop"]');
  await xhsPop.locator('section[data-kind="note"] input').waitFor({ timeout: 5000 });
  check(((await xhsPop.locator('.pop').textContent()) ?? '').includes('不会在小红书上收藏或关注'), '弹窗写明只存在本机、不会在小红书上收藏或关注');
  check(((await xhsPop.locator('section[data-kind="user"] .name').textContent()) ?? '') === '李诞小卖部', '弹窗里同时有这篇笔记和它的作者');
  await xhsPop.locator('section[data-kind="note"] input').fill('书单，AI');
  await xhsPop.locator('section[data-kind="note"] input').press('Enter');
  await xhsCard(0).locator('[data-tubemuse="xhs-save"] button').filter({ hasText: '已收藏 · 2' }).waitFor({ timeout: 5000 });
  const st1 = await xhsStored();
  const n1 = st1.notes[XHS_N1.id];
  check(
    !!n1 &&
      JSON.stringify(n1.tags) === JSON.stringify(['书单', 'AI']) &&
      n1.url === `${MOCK}/xhs/user/profile/${XHS_UID}/${XHS_N1.id}?xsec_token=ABtoken1%3D&xsec_source=pc_user` &&
      n1.publishedAt === XHS_N1.time &&
      n1.timeSource === 'page' &&
      n1.title === XHS_N1.title &&
      n1.authorId === XHS_UID &&
      n1.authorName === '李诞小卖部',
    '加标签即收藏：标题、作者、发布时间（页面数据）、带 xsec_token 的链接、两个标签都存进本机',
  );
  check(xhs.url() === xhsProfileUrl && (await xhs.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '没有打开笔记，也没有点到小红书自己的任何元素');
  await xhsPop.getByRole('button', { name: '收藏这位博主' }).click();
  await xhs.locator('[data-tubemuse="xhs-save-inline"][data-for="profile"] button').filter({ hasText: '已收藏博主' }).waitFor({ timeout: 5000 });
  const st2 = await xhsStored();
  check(st2.users[XHS_UID]?.name === '李诞小卖部' && st2.users[XHS_UID]?.url === `${MOCK}/xhs/user/profile/${XHS_UID}?xsec_source=pc_note`, '弹窗里一键收藏这位博主；博主主页名字旁的按钮随之变成"已收藏博主"');
  await xhsPop.getByRole('button', { name: '去掉标签 AI' }).click();
  await xhsCard(0).locator('[data-tubemuse="xhs-save"] button').filter({ hasText: '已收藏 · 1' }).waitFor({ timeout: 5000 });
  check(JSON.stringify((await xhsStored()).notes[XHS_N1.id].tags) === JSON.stringify(['书单']), '在弹窗里去掉一个标签');
  await xhsPop.locator('section[data-kind="note"] input').press('Escape');
  await xhsPop.waitFor({ state: 'detached', timeout: 3000 });
  check(true, '按 Esc 关闭弹窗');
  await xhs.mouse.move(400, 10);
  await xhs.waitForTimeout(300);
  check((await saveOpacity(0)) === '1' && (await saveOpacity(2)) === '0', '收藏过的卡片按钮常驻（"已收藏 · 1"），没收藏的仍然只在悬停时出现');

  console.log('\n[小红书：未登录样式的卡片 → 只能收藏博主；常用标签一键加]');
  await xhsCard(1).hover();
  await xhsCard(1).locator('[data-tubemuse="xhs-save"] button').click();
  await xhsPop.locator('.pop').waitFor({ timeout: 3000 });
  check(((await xhsPop.locator('section[data-kind="note"]').textContent()) ?? '').includes('登录后才能收藏这篇笔记'), '卡片上没有笔记链接时说明原因（博主照常可以收藏）');
  await xhsCard(1).locator('[data-tubemuse="xhs-save"] button').click();
  await xhsPop.waitFor({ state: 'detached', timeout: 3000 });
  await xhsCard(2).hover();
  await xhsCard(2).locator('[data-tubemuse="xhs-save"] button').click();
  await xhsPop.locator('section[data-kind="note"]').getByRole('button', { name: '+书单' }).click();
  await xhsCard(2).locator('[data-tubemuse="xhs-save"] button').filter({ hasText: '已收藏 · 1' }).waitFor({ timeout: 5000 });
  const n3 = (await xhsStored()).notes[XHS_N3.id];
  check(n3?.timeSource === 'id' && n3.publishedAt === XHS_N3.idTime && JSON.stringify(n3.tags) === JSON.stringify(['书单']), '点"常用"里的标签直接收藏；时间记为由笔记 ID 推算');
  await xhs.keyboard.press('Escape');
  await xhs.mouse.click(400, 10);
  await xhsPop.waitFor({ state: 'detached', timeout: 3000 });
  check(true, '点弹窗外面关闭');

  console.log('\n[小红书：虚拟列表把卡片换成另一篇 → 时间跟着换；设置里关掉时间 / 按钮]');
  await xhs.evaluate(({ id, title }) => /** @type {any} */ (window).__recycle(2, id, title), { id: XHS_N4.id, title: XHS_N4.title });
  await xhs.waitForFunction((iso) => /** @type {HTMLTimeElement | null} */ (document.querySelector('section.note-item[data-index="12"] [data-tubemuse="xhs-time"]'))?.dateTime === iso, new Date(XHS_N4.idTime).toISOString(), { timeout: 5000 });
  check((await xhsCard(2).locator('[data-tubemuse="xhs-save"] button').textContent())?.trim() === '收藏', '换成的那篇没收藏过：按钮回到"收藏"');
  const setXhs = (/** @type {Record<string, boolean>} */ patch) =>
    panel.evaluate(async (p) => {
      const c = /** @type {any} */ (globalThis).chrome;
      const { settings = {} } = await c.storage.local.get('settings');
      await c.storage.local.set({ settings: { ...settings, xhs: { ...settings.xhs, ...p } } });
    }, patch);
  await setXhs({ showTime: false });
  await xhs.waitForFunction(() => document.querySelectorAll('[data-tubemuse="xhs-time"]').length === 0, null, { timeout: 5000 });
  await setXhs({ showTime: true, enabled: false });
  await xhs.waitForFunction(() => document.querySelectorAll('[data-tubemuse^="xhs"]').length === 0, null, { timeout: 5000 });
  check(true, '关掉"显示发布时间"、关掉整个小红书功能：页面上 TubeMuse 加的东西全部消失');
  await setXhs({ enabled: true });
  await xhs.waitForFunction(() => document.querySelectorAll('[data-tubemuse="xhs-time"]').length === 3, null, { timeout: 5000 });
  check(true, '重新打开后恢复');

  console.log('\n[小红书：笔记详情 → 日期旁显示精确发布时间；"关注"旁的按钮显示已收藏]');
  await xhs.goto(`${MOCK}/xhs/explore/${XHS_N1.id}?xsec_token=ABtoken1%3D&xsec_source=pc_user`);
  await xhs.locator('[data-tubemuse="xhs-detail-time"][data-source="page"]').waitFor({ timeout: 10000 });
  const detail = await xhs.evaluate(() => {
    const t = /** @type {HTMLTimeElement} */ (document.querySelector('[data-tubemuse="xhs-detail-time"]'));
    return { text: t.textContent, iso: t.dateTime, afterDate: t.previousElementSibling?.classList.contains('date') };
  });
  check(detail.iso === new Date(XHS_N1.time).toISOString() && /^发布于 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(detail.text ?? '') && !!detail.afterDate, `详情页日期旁：${detail.text}`);
  // 2026-11-04 用户报告：详情页里看不到"收藏"。页面里有两份作者栏，按钮被放进了顶上藏起来的那份
  const placed = await xhs.evaluate(() => {
    const all = document.querySelectorAll('[data-tubemuse="xhs-save-inline"][data-for="note"]');
    const h = /** @type {HTMLElement | undefined} */ (all[0]);
    const follow = h?.nextElementSibling;
    const a = h?.getBoundingClientRect();
    const b = follow?.getBoundingClientRect();
    return {
      count: all.length,
      visible: !!h && h.getClientRects().length > 0,
      inPanel: !!h?.closest('.interaction-container .author-container'),
      nextToFollow: !!follow?.classList.contains('note-detail-follow-btn') && !!a && !!b && a.right <= b.left + 0.5 && a.bottom > b.top && a.top < b.bottom,
      inComments: !!h?.closest('.comments-el'),
    };
  });
  check(
    placed.count === 1 && placed.visible && placed.inPanel && placed.nextToFollow && !placed.inComments,
    `笔记详情里有两份作者栏（顶上那份藏着）："收藏"放在看得见的那份里、紧挨"关注"左边，不进评论区（${JSON.stringify(placed)}）`,
  );
  const inline = xhs.locator('[data-tubemuse="xhs-save-inline"][data-for="note"] button');
  check(((await inline.textContent()) ?? '').includes('已收藏 · 1'), '"关注"旁的按钮显示这篇已收藏');
  await inline.click();
  await xhsPop.locator('section[data-kind="user"]').filter({ hasText: '移出收藏' }).waitFor({ timeout: 3000 });
  check((await xhs.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '弹窗里同时有笔记和作者；没有点到"关注"');
  await xhs.keyboard.press('Escape');

  console.log('\n[小红书：侧边栏 → 筛选、改名标签、移出与撤销]');
  await panel.bringToFront();
  await panel.getByTestId('xhs-list').waitFor({ timeout: 5000 });
  check((await panel.getByTestId('xhs-item').count()) === 3, '侧边栏列出收藏的 2 篇笔记与 1 位博主');
  check(((await panel.getByTestId('xhs-item').filter({ hasText: XHS_N1.title }).getByTestId('xhs-item-time').textContent()) ?? '').startsWith('发布 '), '笔记显示发布时间');
  await panel.getByTestId('xhs-tag-filter').getByRole('button', { name: /#书单/ }).click();
  check((await panel.getByTestId('xhs-item').count()) === 2, '按标签 #书单 筛选');
  await panel.getByRole('button', { name: '管理标签' }).click();
  await panel.getByTestId('xhs-tag-manager').getByRole('button', { name: '改名' }).first().click();
  await panel.getByRole('textbox', { name: '把 #书单 改名为' }).fill('读书');
  await panel.getByRole('textbox', { name: '把 #书单 改名为' }).press('Enter');
  /** 等本机存储里的收藏满足条件（waitForFunction 不等异步判断的结果，所以在这边轮询） */
  const untilStored = async (/** @type {(s: any) => boolean} */ ok) => {
    for (let i = 0; i < 50 && !ok(await xhsStored()); i++) await panel.waitForTimeout(100);
    return ok(await xhsStored());
  };
  const renamed = await untilStored((s) => JSON.stringify(s.notes[XHS_N3.id]?.tags) === '["读书"]' && JSON.stringify(s.notes[XHS_N1.id]?.tags) === '["读书"]');
  check(renamed && (await panel.getByTestId('xhs-item').count()) === 2, '标签改名后两篇笔记都跟着改，筛选跟到新名字');
  await panel.getByTestId('xhs-item').filter({ hasText: XHS_N3.title }).getByTestId('xhs-remove').click();
  await panel.getByRole('button', { name: '撤销' }).waitFor({ timeout: 3000 });
  check(!(await xhsStored()).notes[XHS_N3.id], '移出收藏');
  await panel.getByRole('button', { name: '撤销' }).click();
  check(await untilStored((s) => JSON.stringify(s.notes[XHS_N3.id]?.tags) === '["读书"]'), '撤销后原样放回（标签还在）');
  await panel.screenshot({ path: join(shots, '26-xhs-panel.png'), fullPage: true });

  console.log('\n[小红书：视频笔记 → 片段页录一段 → 卡住时不录 → 停在最后一帧算播完 → 自动保存，记录能回到这篇笔记]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '片段', exact: true }).click();
  // 把侧边栏拿到前台时，当前标签页变成了侧边栏自己：切回小红书那个标签页（就像你点回它）
  await panel.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [t] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes('/xhs/explore/'));
    await c.tabs.update(t.id, { active: true });
  });
  await clipStatus.filter({ hasText: '这篇笔记里没有视频' }).waitFor({ timeout: 10000 });
  check(true, '图文笔记：说明没有视频可录');
  const xhsVideoUrl = `${MOCK}/xhs/explore/${XHS_V1.id}?xsec_token=${encodeURIComponent(XHS_V1.token)}&xsec_source=pc_feed`;
  await xhs.goto(xhsVideoUrl);
  await xhs.waitForFunction(() => (document.querySelector('.player-el video') instanceof HTMLVideoElement ? /** @type {HTMLVideoElement} */ (document.querySelector('.player-el video')).readyState : 0) >= 2, null, { timeout: 30000 });
  /** 在小红书页面里对播放器的视频做点什么（模拟你播放、拖动，或播放器自己的行为） */
  const onXhsVideo = (/** @type {string} */ code) => xhs.evaluate(`(() => { const v = document.querySelector('.player-el video'); ${code} })()`);
  await onXhsVideo('return v.play();');
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  check(
    ((await panel.getByTestId('clip-title').textContent()) ?? '') === XHS_V1.title && (await panel.getByTestId('clip-burn').count()) === 0 && (await panel.getByTestId('clip-no-burn').count()) === 1,
    '小红书视频笔记：侧边栏显示笔记标题（来自页面标题），不提供字幕烧录并说明原因',
  );
  const xhsPlayerHtml = () => xhs.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('.media-container')).outerHTML);
  const xhsPlayerBefore = await xhsPlayerHtml();
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  const xhsBadge = await sw2.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [t] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes('/xhs/explore/'));
    return c.action.getBadgeText({ tabId: t.id });
  });
  check(xhsBadge === 'REC', `小红书上录制中，工具栏图标也显示 REC（实际："${xhsBadge}"）`);
  await xhs.waitForTimeout(2000);
  // 进度卡住（倍速 0：没暂停，进度不动）：当缓冲，不录静止画面
  await onXhsVideo('v.playbackRate = 0;');
  await clipStatus.filter({ hasText: '缓冲中' }).waitFor({ timeout: 5000 });
  const atStall = await recordedSec();
  await xhs.waitForTimeout(1500);
  check((await recordedSec()) === atStall, `播放中进度卡住：自动暂停录制，不录静止画面（停在 ${atStall} 秒）`);
  await onXhsVideo('v.playbackRate = 1;');
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 5000 });
  await xhs.waitForTimeout(1500);
  // 小红书的播放器放到最后一帧就停住，既不暂停也不报"播完"（2026-11-04 实测）：模拟成倍速 0、停在结尾前 0.2 秒
  const [xhsDl] = await Promise.all([xhs.waitForEvent('download', { timeout: 15000 }), onXhsVideo('v.playbackRate = 0; v.currentTime = v.duration - 0.2;')]);
  const xhsName = xhsDl.suggestedFilename();
  check(/^视频日记Day255｜一人公司怎么做_00m0\ds-00m1\ds\.(mp4|webm)$/.test(xhsName), `停在最后一帧算播完，自动结束并保存；文件名用笔记标题与起止时间：${xhsName}`);
  await panel.getByTestId('clip-ready').filter({ hasText: '视频播完了' }).waitFor({ timeout: 5000 });
  const xhsClip = await analyzeClip(xhs, /** @type {string} */ (await xhsDl.path()));
  check(
    container(xhsClip.head) === xhsName.split('.').pop() && xhsClip.duration > 2.5 && xhsClip.rms > 0.02,
    `录到了这篇笔记视频的画面与声音（${xhsClip.duration.toFixed(1)} 秒，响度 ${xhsClip.rms.toFixed(3)}）`,
  );
  const xhsLog = (await clipLog())[0];
  check(
    xhsLog?.site === 'xhs' && xhsLog.videoId === XHS_V1.id && xhsLog.title === XHS_V1.title && xhsLog.url === `${MOCK}/xhs/explore/${XHS_V1.id}?xsec_token=ABvideo1%3D&xsec_source=pc_feed` && xhsLog.fileName === xhsName,
    '"最近录过的片段"记下这是小红书笔记，带上能回到这篇笔记的链接（含 xsec_token）',
  );
  check(((await panel.getByTestId('clip-log').textContent()) ?? '').includes('小红书 · '), '侧边栏的片段清单标出小红书');
  check(
    JSON.stringify(await xhsPlayerHtml()) === JSON.stringify(xhsPlayerBefore) && (await xhs.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0,
    '录制没有往小红书页面里加任何元素，没有点到小红书自己的任何东西',
  );

  console.log('\n[小红书：录制中关掉这篇笔记（站内跳走）→ 这一段自动结束并保存]');
  await onXhsVideo('v.playbackRate = 1; v.currentTime = 0; return v.play();');
  await clipStatus.filter({ hasText: '已保存' }).waitFor({ timeout: 5000 });
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  await xhs.waitForTimeout(1500);
  const [closeDl] = await Promise.all([xhs.waitForEvent('download', { timeout: 10000 }), xhs.evaluate(() => history.pushState(null, '', '/xhs/explore'))]);
  check(/^视频日记Day255｜一人公司怎么做_.*\.(mp4|webm)$/.test(closeDl.suggestedFilename()), `关掉笔记时自动结束这一段并保存：${closeDl.suggestedFilename()}`);
  await panel.getByTestId('clip-ready').filter({ hasText: '关掉了这篇笔记' }).waitFor({ timeout: 5000 });
  check(true, '侧边栏说明这一段为什么结束');
  await panel.getByRole('tab', { name: '小红书' }).click();

  console.log('\n[小红书：网络红线]');
  const xhsPageReqs = requests.slice(xhsReqStart).filter((r) => String(r.headers.referer ?? '').startsWith(`${MOCK}/xhs/`));
  check(
    xhsPageReqs.every((r) => r.method === 'GET' && (r.path.startsWith('/xhs/') || r.path === '/favicon.ico')),
    `小红书页面上 TubeMuse 没有发出任何请求（只有你打开的页面本身）${xhsPageReqs.length ? `：${xhsPageReqs.map((r) => r.path).join(', ')}` : ''}`,
  );
  await xhs.close();
  await panel.bringToFront();

  // ───────────────────────── eMails ─────────────────────────
  console.log('\n[eMails：不在 Gmail 时说明怎么开始；打开邮件才列出文章，换邮件网址不变也跟得上]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: 'eMails' }).click();
  await panel.getByTestId('email-no-script').waitFor({ timeout: 5000 });
  check(((await panel.getByTestId('email-no-script').textContent()) ?? '').includes('当前标签页不是 Gmail'), '当前标签页不是 Gmail：说明怎么开始，并提示页面可能要刷新');
  const emailReqStart = requests.length;
  const llmCount = () => requests.filter((r) => r.path === '/anthropic/v1/messages').length;
  const llmAtStart = llmCount();
  const [gmail] = await Promise.all([context.waitForEvent('page'), panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}/gmail/mail`)]);
  gmail.on('pageerror', (e) => consoleErrors.push(`gmail pageerror: ${e.message}`));
  gmail.on('console', (m) => m.type() === 'error' && consoleErrors.push(`gmail: ${m.text()}`));
  await gmail.waitForLoadState('load');
  await panel.getByTestId('email-no-mail').waitFor({ timeout: 8000 });
  check(true, '打开了 Gmail 但还没点开邮件：说明要先打开一封（藏在页面里的上一封不算）');
  await gmail.evaluate(() => /** @type {any} */ (globalThis).openMail('digest'));
  await gmail.evaluate(() => /** @type {any} */ (globalThis).watchPage());
  const gmailUrl = gmail.url();
  await panel.getByTestId('email-found').filter({ hasText: '找到 5 篇文章' }).waitFor({ timeout: 8000 });
  const found = (await panel.getByTestId('email-found').textContent()) ?? '';
  check(found.includes('Medium Daily Digest'), `列出当前邮件：${found}`);
  const titles = await panel.getByTestId('email-title').allTextContents();
  check(titles[0]?.includes('A Postmortem of Our Two-Year Postgres Migration Across 40 Nodes') === true, '标题被邮件截断时显示配图 alt 里的完整标题');
  check(!titles.some((t) => t.includes('Hidden')), '藏在页面里的上一封邮件不会被读到');
  check(titles.length === 5 && !titles.some((t) => /Control your|Read from|Unsubscribe|Stories for/.test(t)), '页头、页脚、退订链接都不算文章');
  const firstCard = ((await panel.getByTestId('email-item').first().textContent()) ?? '');
  check(['Ada Writer', 'Systems Weekly', '14 分钟', '1,300 掌声', '25 回应', '会员文章', 'Three outages'].every((t) => firstCard.includes(t)), `卡片上有作者、刊物、阅读时长、互动数和摘要：${firstCard.slice(0, 120)}`);
  const firstHref = (await panel.getByTestId('email-title').first().getAttribute('href')) ?? '';
  check(firstHref === 'https://medium.com/@writer/postmortem-abc123', `链接去掉了带收件人信息的 source 参数：${firstHref}`);
  check(llmCount() === llmAtStart, '只是打开邮件：什么都没有发给大模型');
  check(((await panel.getByTestId('email-disclosure').textContent()) ?? '').includes('发给 Anthropic'), '说明点"评估"后发什么、发给谁，以及大模型没有读正文');

  console.log('\n[eMails：评估 → 分数与理由，按分数排序、筛选]');
  await panel.getByTestId('email-evaluate').click();
  await panel.getByTestId('email-score').nth(4).waitFor({ timeout: 8000 });
  await panel.getByTestId('email-result').waitFor({ timeout: 5000 });
  const scored = await panel.getByTestId('email-score').allTextContents();
  check(JSON.stringify(scored) === JSON.stringify(['9', '8', '5', '2', '0']), `按分数从高到低：${scored.join(' ')}`);
  check(((await panel.getByTestId('email-reason').first().textContent()) ?? '').includes('一手数据'), '每篇都有简短理由');
  check(((await panel.getByTestId('email-result').textContent()) ?? '').includes('评完 5 篇'), '说明这次评了几篇、用的模型和大约花了多少');
  const [emailCall, verdictCall] = requests.filter((r) => r.path === '/anthropic/v1/messages').slice(-2);
  check(llmCount() === llmAtStart + 2 && emailCall.body.includes('Testing Agents With Replayed Traces'), '评估发了一次评分请求，带着文章标题');
  check(verdictCall.body.includes('汇总邮件总评员') && verdictCall.body.includes('有具体的一手数据'), '评完再发一次总体结论，带着分数和理由');
  const emailLeaks = ['source=', 'https://', 'noreply@medium.com', 'Medium Daily Digest', 'Ada Writer in Systems Weekly', 'Test Reader', 'test.reader@example.com', 'Stories for', 'e2e-unsubscribe-token', 'Lunch on Friday'].filter((t) => emailCall.body.includes(t) || verdictCall.body.includes(t));
  check(emailLeaks.length === 0, `发给大模型的整个请求体不含链接、邮件主题、发件人和收件人${emailLeaks.length ? `，却出现了：${emailLeaks.join('、')}` : ''}`);
  check(!verdictCall.body.includes('Ada Writer') && !verdictCall.body.includes('Three outages'), '写总体结论时不再发作者和摘要');
  check(((await panel.getByTestId('email-verdict-headline').textContent()) ?? '').includes('这 5 篇里有 2 篇值得精读'), '评完显示总体结论：一句话概括');
  check(((await panel.getByTestId('email-verdict-summary').textContent()) ?? '').includes('实战复盘'), '总体结论有大模型写的整体质量概述');
  check((await panel.getByTestId('email-verdict-why').count()) === 0, '有值得精读的文章时不解释"为什么没有"');
  const bands = panel.getByTestId('email-bands');
  check(((await bands.textContent()) ?? '').includes('值得精读 2') && ((await bands.textContent()) ?? '').includes('一般 1') && ((await bands.textContent()) ?? '').includes('建议跳过 2'), `按分档计数：${await bands.textContent()}`);
  await bands.getByRole('button', { name: /建议跳过/ }).click();
  check((await panel.getByTestId('email-item').count()) === 2 && (await panel.getByTestId('email-item').first().getAttribute('data-band')) === 'skip', '筛选"建议跳过"：只看低分');
  await bands.getByRole('button', { name: /全部/ }).click();
  await panel.screenshot({ path: join(shots, '30-emails-scored.png'), fullPage: true });

  console.log('\n[eMails：一键收藏、打标签，收藏页筛选、移出可撤销]');
  await panel.getByTestId('email-save').first().click();
  await panel.getByTestId('email-unsave').first().waitFor({ timeout: 5000 });
  const emailStored = () => panel.evaluate(async () => (await /** @type {any} */ (globalThis).chrome.storage.local.get('emailSaved')).emailSaved ?? { articles: {} });
  const savedArticle = Object.values((await emailStored()).articles)[0];
  check(/** @type {any} */ (savedArticle)?.score === 9 && /** @type {any} */ (savedArticle)?.url === 'https://medium.com/@writer/postmortem-abc123', '收藏时带上分数与理由，存的是干净的链接');
  const tagBox = panel.getByTestId('email-item').first().getByRole('textbox', { name: '加标签' });
  await tagBox.fill('数据库, 长文');
  await tagBox.press('Enter');
  await panel.getByTestId('email-item').first().getByText('#长文').waitFor({ timeout: 5000 });
  await panel.getByTestId('email-mode-saved').click();
  check((await panel.getByTestId('email-saved-item').count()) === 1, '收藏页列出这篇');
  check(((await panel.getByTestId('email-tag-filter').textContent()) ?? '').includes('#数据库'), '标签筛选条与小红书同一套');
  await panel.getByTestId('email-remove').click();
  await panel.getByTestId('email-saved-empty').waitFor({ timeout: 5000 });
  await panel.getByTestId('email-undo').click();
  await panel.getByTestId('email-saved-item').waitFor({ timeout: 5000 });
  check(/** @type {any} */ (Object.values((await emailStored()).articles)[0])?.tags?.length === 2, '移出后撤销：标签还在');
  await panel.getByTestId('email-mode-mail').click();

  console.log('\n[eMails：换邮件、普通邮件、被截断、读不到正文]');
  await gmail.evaluate(() => /** @type {any} */ (globalThis).openMail('digest2'));
  await panel.getByTestId('email-found').filter({ hasText: '找到 2 篇文章' }).waitFor({ timeout: 8000 });
  check(gmail.url() === gmailUrl, '换邮件时网址没有变（分栏阅读），侧边栏照样跟上');
  check((await panel.getByTestId('email-score').count()) === 1 && ((await panel.getByTestId('email-evaluate').textContent()) ?? '').includes('评估剩下的 1 篇'), '上一封评过的文章直接显示分数，只需要评新的那篇');
  check((await panel.getByTestId('email-verdict').count()) === 0, '还有没评的文章、也没有结论时不下总体结论');
  await panel.getByTestId('email-evaluate').click();
  await panel.getByTestId('email-score').nth(1).waitFor({ timeout: 8000 });
  await panel.getByTestId('email-result').filter({ hasText: '评完 1 篇' }).waitFor({ timeout: 8000 });
  const [secondCall, secondVerdict] = requests.filter((r) => r.path === '/anthropic/v1/messages').slice(-2);
  check(llmCount() === llmAtStart + 4 && secondCall.body.includes('Benchmark') && !secondCall.body.includes('Postmortem'), '第二次只发新的那篇，评过的不再花钱');
  check(secondVerdict.body.includes('Benchmark') && secondVerdict.body.includes('Postmortem'), '总体结论覆盖这封邮件的全部文章，包括之前评过的');

  console.log('\n[eMails：文章都评过、一篇精读都没有时的总体结论]');
  await gmail.evaluate(() => /** @type {any} */ (globalThis).openMail('weak'));
  await panel.getByTestId('email-found').filter({ hasText: '找到 3 篇文章' }).waitFor({ timeout: 8000 });
  await panel.getByTestId('email-verdict').waitFor({ timeout: 5000 });
  check(llmCount() === llmAtStart + 4, '换到都评过的邮件：什么都没有发给大模型');
  check(((await panel.getByTestId('email-verdict-headline').textContent()) ?? '').includes('这 3 篇里没有值得精读的'), '没有大模型也说得清：一篇值得精读的都没有');
  check(((await panel.getByTestId('email-verdict-facts').textContent()) ?? '').includes('离精读线（7 分）还差 2 分'), `本地算出的原因：${await panel.getByTestId('email-verdict-facts').textContent()}`);
  const weakBands = panel.getByTestId('email-bands');
  await weakBands.getByRole('button', { name: /值得精读/ }).click();
  check(((await panel.getByTestId('email-band-empty').textContent()) ?? '').includes('原因见上面的总体结论'), '"值得精读 0"这一档不再只说"这一档没有文章"');
  await panel.getByTestId('email-conclude').click();
  await panel.getByTestId('email-verdict-why').waitFor({ timeout: 8000 });
  check(llmCount() === llmAtStart + 5, '点"生成总体结论"只发一次请求，不重新打分');
  check(((await panel.getByTestId('email-verdict-why').textContent()) ?? '').includes('都没有一手经验或数据'), '解释为什么一篇都不值得精读');
  check((await panel.getByTestId('email-conclude').count()) === 0, '写好之后不再显示"生成总体结论"');
  await panel.screenshot({ path: join(shots, '31-emails-verdict-none.png'), fullPage: true });
  await weakBands.getByRole('button', { name: /全部/ }).click();
  await gmail.evaluate(() => /** @type {any} */ (globalThis).openMail('personal'));
  await panel.getByTestId('email-no-articles').waitFor({ timeout: 8000 });
  check(((await panel.getByTestId('email-no-articles').textContent()) ?? '').includes('没有发给大模型') && (await panel.getByTestId('email-evaluate').count()) === 0, '普通邮件：说明不像文章汇总，没有"评估"按钮');
  await gmail.evaluate(() => /** @type {any} */ (globalThis).openMail('clipped'));
  await panel.getByTestId('email-clipped').waitFor({ timeout: 8000 });
  check(true, 'Gmail 截断了邮件：说明后面的文章读不到');
  await gmail.evaluate(() => /** @type {any} */ (globalThis).openMail('broken'));
  await panel.getByTestId('email-unreadable').waitFor({ timeout: 8000 });
  check(((await panel.getByTestId('email-unreadable').textContent()) ?? '').includes('Gmail 可能改版了'), '读不到正文：说明可能是 Gmail 改版，不静默');

  console.log('\n[eMails：红线]');
  const gmailMutationsBefore = await gmail.evaluate(() => /** @type {any} */ (globalThis).__clicks);
  check(gmailMutationsBefore === 0, 'TubeMuse 没有点击 Gmail 页面上的任何东西');
  await gmail.evaluate(() => /** @type {any} */ (globalThis).openMail('digest'));
  await gmail.evaluate(() => /** @type {any} */ (globalThis).watchPage());
  await panel.getByTestId('email-found').filter({ hasText: '找到 5 篇文章' }).waitFor({ timeout: 8000 });
  await panel.waitForTimeout(2000);
  check((await gmail.evaluate(() => /** @type {any} */ (globalThis).__mutations)) === 0, 'TubeMuse 读邮件时没有改动 Gmail 页面（DOM 没有任何变化）');
  const emailReqs = requests.slice(emailReqStart);
  const gmailPageReqs = emailReqs.filter((r) => String(r.headers.referer ?? '').startsWith(`${MOCK}/gmail/`));
  check(
    gmailPageReqs.every((r) => r.method === 'GET' && (r.path.startsWith('/gmail/') || r.path === '/favicon.ico')),
    `Gmail 页面上 TubeMuse 没有发出任何请求（只有你打开的页面本身）${gmailPageReqs.length ? `：${gmailPageReqs.map((r) => r.path).join(', ')}` : ''}`,
  );
  check(emailReqs.every((r) => !JSON.stringify(r).includes('e2e-private-mail-text')), '普通邮件的内容没有发到任何地方');
  await options.getByTestId('email-enabled').uncheck();
  await panel.getByText('eMails 已在设置里关闭').waitFor({ timeout: 5000 });
  check(true, '在设置里关掉 eMails：这一页说明已关闭，不再读邮件');
  await options.getByTestId('email-enabled').check();
  await gmail.close();
  await panel.bringToFront();

  // ───────────────────────── 设置页 ─────────────────────────
  // 回归：事件处理函数在异步回调里才读 e.currentTarget 时，设置存不上、也不报错（DECISIONS §45）。遍历所有勾选框，新加的开关也覆盖到
  console.log('\n[设置页：每一项改了都真的存进去，改回来能复原]');
  /** @param {unknown} v @returns {unknown} */
  const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(/** @type {Record<string, unknown>} */ (v)[k])])) : v);
  const storedSettings = async () => sortKeys(await options.evaluate(async () => (await /** @type {any} */ (globalThis).chrome.storage.local.get('settings')).settings));
  const settingsJson = async () => JSON.stringify(await storedSettings());
  /**
   * 等到 ok 成立（后台标签页里 requestAnimationFrame 不走，不能用 waitForFunction）
   * @param {() => Promise<boolean>} ok
   */
  const settled = async (ok) => {
    for (let i = 0; i < 60; i++) {
      if (await ok()) return true;
      await options.waitForTimeout(50);
    }
    return false;
  };
  const boxes = options.locator('input[type="checkbox"]');
  // 前面的自动字幕一节切到了 OpenAI 转写，"优先本机识别"那一项是藏着的：切回浏览器识别，让所有勾选框都在
  const asrEngine = options.locator('input[type="radio"][name="asr-engine"]');
  await asrEngine.first().check();
  await settled(async () => (await boxes.count()) >= 28);
  const boxCount = await boxes.count();
  /** @type {string[]} */
  const badBoxes = [];
  for (let i = 0; i < boxCount; i++) {
    const before = await settingsJson();
    await boxes.nth(i).click();
    const saved = await settled(async () => (await settingsJson()) !== before);
    await boxes.nth(i).click();
    const restored = await settled(async () => (await settingsJson()) === before);
    if (!saved || !restored) badBoxes.push(`#${i}${saved ? '' : ' 存不上'}${restored ? '' : ' 复原不了'} ${await boxes.nth(i).evaluate((el) => el.closest('label')?.textContent?.trim().slice(0, 30) ?? '')}`);
  }
  check(boxCount >= 28 && badBoxes.length === 0, `${boxCount} 个勾选框都存得上、都能复原${badBoxes.length ? `，有问题：${badBoxes.join('；')}` : ''}`);
  await asrEngine.nth(1).check();
  const voiceLang = options.getByTestId('voice-lang');
  await voiceLang.selectOption('en-US');
  const voiceSaved = await settled(async () => /** @type {any} */ (await storedSettings()).voice.lang === 'en-US');
  await voiceLang.selectOption('zh-CN');
  check(voiceSaved && (await settled(async () => /** @type {any} */ (await storedSettings()).voice.lang === 'zh-CN')), '语音默认语言存得上');
  for (const provider of ['anthropic', 'openai']) {
    const input = options.getByTestId(`model-${provider}`);
    const original = await input.inputValue();
    // 输入框的值跟着存储走：刚存完时界面还要重绘一次，这时候输入会被盖掉（实测不等时 25 轮只过 12–18 轮，等 200 毫秒 25 轮全过；人的手速碰不到）
    await options.waitForTimeout(200);
    await input.fill('e2e-test-model');
    await input.blur();
    const modelSaved = await settled(async () => /** @type {any} */ (await storedSettings()).llm.models[provider] === 'e2e-test-model');
    await options.waitForTimeout(200);
    await input.fill('');
    await input.blur();
    check(modelSaved && (await settled(async () => /** @type {any} */ (await storedSettings()).llm.models[provider] === original)), `${provider} 模型名存得上，清空后回到默认模型`);
  }

  console.log('\n[Phase 3：X 网络红线]');
  const xr = requests.filter((r) => r.path.startsWith('/x/'));
  check(xr.length > 0 && xr.every((r) => r.headers.authorization === `Bearer ${X_TOKEN}` && !JSON.stringify(r.query).includes(X_TOKEN)), 'X 请求只在请求头里带 Token');
  check(requests.filter((r) => !r.path.startsWith('/x/')).every((r) => !JSON.stringify(r).includes(X_TOKEN)), 'X Token 从未发往别处');
  check(xr.every((r) => !JSON.stringify(r).includes('e2e-fake-token')), 'YouTube 令牌从未发往 X');
  check(xr.every((r) => !String(r.query.expansions ?? '').length), '不展开作者信息（避免按用户对象另计费）');
  check(xr.every((r) => r.method === 'GET'), '对 X 只读（只有 GET，从不发帖/点赞/关注）');

  console.log('\n[网络红线]');
  const llm = requests.filter((r) => r.path.startsWith('/anthropic'));
  const yt = requests.filter((r) => r.path.startsWith('/youtube'));
  check(llm.length > 0 && llm.every((r) => String(r.headers.authorization ?? r.headers['x-api-key'] ?? '').includes(FAKE_KEY)), 'LLM 请求携带 Key（仅在请求头）');
  check(yt.every((r) => r.headers.authorization === 'Bearer e2e-fake-token'), 'YouTube 请求携带 OAuth 令牌（仅在请求头）');
  check(yt.every((r) => !JSON.stringify(r).includes(FAKE_KEY)), 'LLM Key 从未发往 YouTube');
  check(llm.every((r) => !JSON.stringify(r).includes('e2e-fake-token')), 'YouTube 令牌从未发往 LLM');
  check(requests.every((r) => !JSON.stringify(r.query).includes(FAKE_KEY)), 'Key 不出现在任何 URL 中');
  check(blocked.length === 0, `没有发往 mock 以外的请求${blocked.length ? `：${blocked.join(', ')}` : ''}`);
  check(consoleErrors.length === 0, `页面没有控制台错误${consoleErrors.length ? `：\n    ${consoleErrors.join('\n    ')}` : ''}`);
} catch (e) {
  failures++;
  console.error('\n✘ e2e 异常：', e);
  for (const p of context.pages()) await p.screenshot({ path: join(shots, `error-${Date.now()}.png`), fullPage: true }).catch(() => undefined);
} finally {
  await context.close();
  server.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures ? `\n✘ e2e 失败 ${failures} 项（截图在 test-results/e2e/）` : `\n✔ e2e 全部通过（截图在 test-results/e2e/）`);
process.exit(failures ? 1 : 0);
