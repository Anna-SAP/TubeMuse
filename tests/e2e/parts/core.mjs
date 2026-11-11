// @ts-check
// 主流程：授权失效与旧版升级 → 画像 → 两句验收口令 → 打分与归因 → Phase 2（观看、总结、提醒、自省）→ Phase 3（X 热点、新博主）→ 豆瓣评论。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, FAKE_KEY, MOCK, shots, X_TOKEN } from '../harness.mjs';

/** @param {import('../harness.mjs').Harness} t */
export async function core(t) {
  const { context, sw, extId, options, requests, consoleErrors, doubanImages, readAuth, tokenGrants } = t;
  // ── 刷新令牌失效（invalid_grant）→ 横幅写明原因 → 侧边栏"重新授权"；授权窗口还开着时把侧边栏关掉：令牌照样由后台存下 ──
  console.log('\n[刷新令牌失效 → 重新授权]');
  {
    const before = await readAuth();
    await fetch(`${MOCK}/e2e/token-mode?mode=revoked`);
    await sw.evaluate((st) => /** @type {any} */ (globalThis).chrome.storage.local.set({ youtubeAuth: st }), { ...before, expiresAt: Date.now() - 60_000 });
    const reauthPanel = await context.newPage();
    reauthPanel.on('pageerror', (e) => consoleErrors.push(`reauth pageerror: ${e.message}`));
    await reauthPanel.goto(`chrome-extension://${extId}/sidepanel.html`);
    // 用一次 YouTube（同步画像）：访问令牌已过期 → 后台用刷新令牌续期 → Google 说 invalid_grant
    await reauthPanel.getByRole('tab', { name: '画像' }).click();
    await reauthPanel.getByRole('button', { name: '同步订阅与喜欢的视频' }).click();
    await reauthPanel.getByText('YouTube 授权已过期').first().waitFor({ timeout: 10000 });
    const reason = (await reauthPanel.getByTestId('renew-reason').textContent()) ?? '';
    check(reason.includes('invalid_grant') && reason.includes('7 天'), `横幅写明续期失败的具体原因：${reason.slice(0, 60)}…`);
    check(!(await readAuth())?.refreshToken, '失效的刷新令牌已丢弃（不再白发续期请求）');
    // 授权页像真实的 Google 一样停留几秒（用户在窗口里登录、选账号、同意）
    await fetch(`${MOCK}/e2e/authorize-mode?mode=slow&delayMs=2500`);
    const authorizeBefore = requests.filter((r) => r.path === '/oauth/authorize').length;
    await reauthPanel.getByRole('button', { name: '重新授权' }).click();
    await reauthPanel.getByTestId('auth-pending').waitFor({ timeout: 5000 });
    check(true, '点"重新授权"后显示"授权窗口已打开"');
    await reauthPanel.close();
    let renewed;
    for (const end = Date.now() + 15000; Date.now() < end && !renewed; ) {
      const a = await readAuth();
      if (a?.expiresAt > Date.now() + 30 * 60_000 && !a.renewFailedAt && a.refreshToken) renewed = a;
      else await new Promise((r) => setTimeout(r, 300));
    }
    check(!!renewed, '授权窗口开着时关掉侧边栏：新的访问令牌与刷新令牌照样由后台存下，"已过期"标记清除');
    check(requests.filter((r) => r.path === '/oauth/authorize').length === authorizeBefore + 1, '只打开了一次授权窗口');
    await fetch(`${MOCK}/e2e/authorize-mode?mode=instant`);
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${extId}/sidepanel.html`);
    await reopened.getByRole('tab', { name: '找片' }).waitFor();
    await reopened.waitForTimeout(500);
    check((await reopened.getByText('YouTube 授权已过期').count()) === 0 && (await reopened.getByTestId('auth-pending').count()) === 0, '重新打开侧边栏：不再显示"已过期"');
    await reopened.close();
  }

  // ── 从旧版升级：存着的是隐式授权的记录（没有刷新令牌）→ 侧边栏提前提示，点一次"重新授权"换成能自动续期的授权 ──
  console.log('\n[旧版授权升级]');
  {
    const { refreshToken: _r, refreshIssuedAt: _i, ...legacy } = await readAuth();
    await sw.evaluate((st) => /** @type {any} */ (globalThis).chrome.storage.local.set({ youtubeAuth: st }), { ...legacy, expiresAt: Date.now() + 40 * 60_000 });
    const legacyPanel = await context.newPage();
    legacyPanel.on('pageerror', (e) => consoleErrors.push(`legacy pageerror: ${e.message}`));
    await legacyPanel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await legacyPanel.getByTestId('legacy-auth').waitFor({ timeout: 5000 });
    check(true, '旧版授权（没有刷新令牌）还没过期时，侧边栏提前提示它过期后续不上');
    await legacyPanel.getByRole('button', { name: '重新授权' }).click();
    let upgraded;
    for (const end = Date.now() + 15000; Date.now() < end && !upgraded; ) {
      const a = await readAuth();
      if (a?.refreshToken) upgraded = a;
      else await new Promise((r) => setTimeout(r, 300));
    }
    await legacyPanel.getByTestId('legacy-auth').waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
    check(!!upgraded && (await legacyPanel.getByTestId('legacy-auth').count()) === 0, '点一次"重新授权"后换成带刷新令牌的授权，提示消失');
    await legacyPanel.close();
  }

  const panel = await t.openPanel();

  console.log('\n[画像]');
  // 访问令牌早就过期（模拟连接后过了一整天）：用的时候在后台用刷新令牌换新的，不弹窗、不报"已过期"
  const authorizeCount = requests.filter((r) => r.path === '/oauth/authorize').length;
  const refreshCount = tokenGrants('refresh_token').length;
  await sw.evaluate((st) => /** @type {any} */ (globalThis).chrome.storage.local.set({ youtubeAuth: st }), { ...(await readAuth()), expiresAt: Date.now() - 24 * 3_600_000 });
  await panel.getByRole('tab', { name: '画像' }).click();
  await panel.getByRole('button', { name: '同步订阅与喜欢的视频' }).click();
  await panel.getByText(/同步完成/).waitFor();
  check(true, '同步订阅与喜欢的视频完成');
  const refreshed = await readAuth();
  check(
    tokenGrants('refresh_token').length > refreshCount &&
      requests.filter((r) => r.path === '/oauth/authorize').length === authorizeCount &&
      refreshed?.expiresAt > Date.now() + 30 * 60_000 &&
      !refreshed?.renewFailedAt &&
      (await panel.getByText('YouTube 授权已过期').count()) === 0,
    '访问令牌过期 24 小时后再用：后台用刷新令牌自动续期，没有弹授权窗口，也没有"已过期"横幅',
  );
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
}
