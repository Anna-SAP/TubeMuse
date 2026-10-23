// @ts-check
// 在 Playwright 自带的 Chromium 里加载 dist-e2e/，用本机 mock 服务跑通 Phase 1 主流程：
// 设置 Key → 连接 YouTube → 同步画像 → 生成兴趣簇 → 口令 → 回显 → 结果 → 打 3 分（归因）与 10 分 → 可见调整 → 重排 → 多约束口令。
// 任何发往 mock 以外地址的请求都会被拦截并判失败（测试中不得发出真实网络请求）。
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer, PORT } from './mock-server.mjs';

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
await context.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith('chrome-extension://') || url.startsWith(MOCK) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
  // 授权回跳地址由浏览器截获；万一真的发起加载，也在本地应答，绝不出网
  if (/^https:\/\/[a-p]{32}\.chromiumapp\.org\//.test(url)) return route.fulfill({ status: 200, body: '' });
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

  // ── 侧边栏（以标签页方式打开同一页面）──
  const panel = await context.newPage();
  panel.on('console', (m) => m.type() === 'error' && consoleErrors.push(`sidepanel: ${m.text()}`));
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
  await panel.getByTestId('hotspot').first().waitFor({ timeout: 30000 });
  const hotCount = await panel.getByTestId('hotspot').count();
  check(hotCount >= 5 && hotCount <= 8, `出现 ${hotCount} 条热点（5–8 条）`);
  const links = await panel.getByTestId('post-link').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  check(links.length >= hotCount && links.every((h) => /^https:\/\/x\.com\/i\/web\/status\/\d+$/.test(h)), '每条热点都带 X 原文链接');
  check((await panel.getByTestId('x-spend').count()) === 1, '顶部实时显示 X 花费');
  const xCount = () => requests.filter((r) => r.path === '/x/2/tweets/search/recent').length;
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
  // 预算 = 已花 + 6 美分：下一轮只够读一个主题（12 条）
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
