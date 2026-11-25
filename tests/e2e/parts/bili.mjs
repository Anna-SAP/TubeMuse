// @ts-check
// B站（DECISIONS §92）：视频页"接下来播放"列表的发布时间（勾选后才向 B 站接口查）、收藏与标签，以及这一页的红线。
// 页面是照 2026-11-25 实测结构写的仿 B 站视频页（tests/e2e/bili-pages.mjs）：服务端渲染、1.2 秒后"Vue 接管"，
// 站内跳转时卡片元素复用、只换内容，"展开"后多出一批，列表里有一张没有 BV 号的番剧卡片。
import { join } from 'node:path';
import { check, MOCK, shots } from '../harness.mjs';
import { BILI_BLOCKED, BILI_LIST, BILI_LIST_ID, BILI_LIST_MORE, BILI_LIST_RECS, BILI_POD_PARTS, BILI_POD_PARTS_BV, BILI_POD_SEASON, BILI_NEXT_VIDEO, BILI_PAGE_VIDEO, BILI_RECS, BILI_RECS_MORE, BILI_RECS_NEXT } from '../bili-pages.mjs';

/** @param {import('../harness.mjs').Harness} t */
export async function bili(t) {
  const { context, options, requests, consoleErrors } = t;
  const panel = await t.openPanel();
  const apiCalls = () => requests.filter((r) => r.path === '/biliapi/x/article/cards');
  const idsOf = (/** @type {{ query: Record<string, string> }} */ r) => String(r.query.ids ?? '').split(',');
  const same = (/** @type {string[]} */ a, /** @type {string[]} */ b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

  // ───────────────────────── B站 ─────────────────────────
  console.log('\n[B站：设置页有这一节；"显示发布时间"、收藏按钮默认都开着]');
  const section = (await options.locator('#bili').textContent()) ?? '';
  check(
    section.includes('21. B 站') &&
      (await options.getByTestId('bili-enabled').isChecked()) &&
      (await options.getByTestId('bili-show-pubdate-opt').isChecked()) &&
      (await options.getByTestId('bili-show-save').isChecked()),
    '设置页"21. B 站"：启用、"显示发布时间"、收藏按钮默认都勾着（e2e 构建里接口指向本机 mock）',
  );
  check(((await options.locator('#egress').textContent()) ?? '').includes(`${MOCK}/biliapi`), '"网络出口"列出 B 站的公开接口');

  await panel.bringToFront();
  await panel.getByRole('tab', { name: 'B站', exact: true }).click();
  await panel.getByTestId('bili-view').waitFor({ timeout: 5000 });
  check(
    ((await panel.getByTestId('bili-empty').textContent()) ?? '').includes('还没有收藏') &&
      (await panel.getByTestId('bili-show-pubdate').isChecked()) &&
      ((await panel.getByTestId('bili-tab-status').textContent()) ?? '').includes('不是 B 站页面'),
    '侧边栏「B站」页：还没有收藏时说明怎么开始，"显示发布时间"默认勾着，当前标签页不是 B 站页面',
  );

  console.log('\n[B站：打开视频页 → 等 B 站接管完页面才动手 → 不用做任何设置，每条视频的播放量后面就显示发布时间，封面上有"收藏"]');
  const reqStart = requests.length;
  const pageUrl = `${MOCK}/bili/zh-Hans/video/${BILI_PAGE_VIDEO.bv}/?spm_id_from=333.1007.tianma.1-1-1.click`;
  const [bili] = await Promise.all([context.waitForEvent('page'), panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), pageUrl)]);
  await bili.setViewportSize({ width: 1000, height: 900 });
  bili.on('pageerror', (e) => consoleErrors.push(`bili pageerror: ${e.message}`));
  bili.on('console', (m) => m.type() === 'error' && consoleErrors.push(`bili: ${m.text()}`));
  await bili.waitForFunction(() => /** @type {any} */ (window).__oursBeforeHydration >= 0, null, { timeout: 10000 });
  check((await bili.evaluate(() => /** @type {any} */ (window).__oursBeforeHydration)) === 0, 'B 站接管服务端渲染的页面之前，TubeMuse 一个元素都不加（真实页面上那样会整页重画）');
  const videoCards = BILI_RECS.length;
  await bili.waitForFunction((n) => document.querySelectorAll('[data-tubemuse="bili-save"]').length === n, videoCards, { timeout: 5000 });
  check((await bili.locator('.video-page-card-small[data-kind="bangumi"] [data-tubemuse]').count()) === 0, `${videoCards} 条视频的封面上都有"收藏"；没有 BV 号的番剧卡片不加`);
  const shownCount = (/** @type {number} */ n) => bili.waitForFunction((k) => document.querySelectorAll('[data-tubemuse="bili-pubdate"][data-state="shown"]').length === k, n, { timeout: 10000 });
  await shownCount(videoCards - 1);
  await bili.locator('[data-tubemuse="bili-pubdate"][data-state="unknown"]').waitFor({ timeout: 5000 });
  const readTimes = () =>
    bili.evaluate(() =>
      [...document.querySelectorAll('.video-page-card-small:not([data-kind])')].map((c) => {
        const s = /** @type {HTMLElement | null} */ (c.querySelector('[data-tubemuse="bili-pubdate"]'));
        const p = /** @type {HTMLElement} */ (c.querySelector('.playinfo'));
        const href = c.querySelector('.info a')?.getAttribute('href') ?? '';
        return {
          bv: s?.dataset.bvid,
          matches: !!s?.dataset.bvid && href.includes(s.dataset.bvid),
          text: s?.textContent ?? '',
          state: s?.dataset.state,
          hint: s?.title ?? '',
          afterPlay: s?.previousElementSibling === p,
          sameLine: !!s && Math.abs(s.getBoundingClientRect().top - p.getBoundingClientRect().top) < 4,
        };
      }),
    );
  const t1 = await readTimes();
  check(t1[0]?.text === '3小时前' && t1[1]?.text === '10天前', `30 天内写"多久以前"：${t1[0]?.text}、${t1[1]?.text}`);
  check(/^(20)?22-07-27$/.test(t1[2]?.text ?? '') && /^(20)?17-02-03$/.test(t1[3]?.text ?? ''), `更早的写日期（这一行放不下时先缩小一号字，还放不下再去掉年份的前两位）：${t1[2]?.text}、${t1[3]?.text}`);
  check(t1[2]?.hint.includes('发布于 2022/07/27') === true && t1[2].hint.includes('年前'), `悬停看精确到分钟的时间和多久以前：${t1[2]?.hint}`);
  check(t1[4]?.text === '时间未知' && t1[4].state === 'unknown', 'B 站接口里查不到的视频写"时间未知"');
  check(t1.every((x) => x.afterPlay && x.sameLine && x.matches), '时间插在播放量、弹幕数那一行后面，和它们在同一行（截图里红箭头指的那一块）');
  const calls1 = apiCalls();
  check(
    calls1.length === 1 &&
      same(idsOf(calls1[0]), BILI_RECS.map((r) => r.bv)) &&
      calls1[0].method === 'GET' &&
      !calls1[0].headers.cookie &&
      !calls1[0].headers.referer,
    `一次查完这一页的 ${videoCards} 个视频：只发 BV 号，不带 Cookie、不带 Referer（${calls1.length} 次）`,
  );
  await panel.getByTestId('bili-tab-status').filter({ hasText: `${videoCards - 1} 条显示了发布时间` }).waitFor({ timeout: 5000 });
  check(((await panel.getByTestId('bili-tab-status').textContent()) ?? '').includes('1 条 B 站接口里查不到'), `侧边栏说明当前页的情况：${(await panel.getByTestId('bili-tab-status').textContent()) ?? ''}`);
  await panel.getByTestId('bili-current').waitFor({ timeout: 5000 });
  const current = (await panel.getByTestId('bili-current').textContent()) ?? '';
  const currentIso = await panel.getByTestId('bili-current').getByTestId('bili-item-time').getAttribute('datetime');
  check(
    current.includes(BILI_PAGE_VIDEO.title) && current.includes(`UP ${BILI_PAGE_VIDEO.up}`) && current.includes('时长 3:14:21') && currentIso === new Date(BILI_PAGE_VIDEO.at).toISOString(),
    `侧边栏"当前视频"：标题、UP 主、发布时间、时长读自页面自己声明的 meta（${current.slice(0, 60)}…）`,
  );
  await bili.screenshot({ path: join(shots, '60-bili-pubdate.png') });

  console.log('\n[B站：取消勾选"显示发布时间" → 不显示、不再查；再勾上 → 直接用记着的，不再查]');
  const heights = () => bili.evaluate(() => [...document.querySelectorAll('.video-page-card-small .card-box')].map((e) => Math.round(e.getBoundingClientRect().height)));
  const heightsWith = await heights();
  await panel.getByTestId('bili-show-pubdate').uncheck();
  await bili.waitForFunction(() => document.querySelectorAll('[data-tubemuse="bili-pubdate"]').length === 0, null, { timeout: 5000 });
  await panel.getByTestId('bili-tab-status').filter({ hasText: `有 ${videoCards} 条视频` }).waitFor({ timeout: 5000 });
  await bili.waitForTimeout(1200);
  check(apiCalls().length === 1 && (await bili.locator('[data-tubemuse="bili-save"]').count()) === videoCards, '取消勾选：发布时间消失（收藏按钮还在），也不再向 B 站查');
  check(JSON.stringify(heightsWith) === JSON.stringify(await heights()), '显示发布时间时，每条视频的高度和不显示时一像素都不差');
  await panel.getByTestId('bili-show-pubdate').check();
  await shownCount(videoCards - 1);
  check(apiCalls().length === 1, '再勾上：马上显示，用的是刚才查到的，没有再查');

  console.log('\n[B站：站内跳到别的视频（卡片复用、只换内容）→ 发布时间跟着换；查过的不再查]');
  await bili.evaluate(() => /** @type {any} */ (window).__goto());
  await bili.waitForFunction(
    () => [...document.querySelectorAll('.video-page-card-small:not([data-kind])')].every((c) => {
      const s = /** @type {HTMLElement | null} */ (c.querySelector('[data-tubemuse="bili-pubdate"]'));
      return !!s && (c.querySelector('.info a')?.getAttribute('href') ?? '').includes(s.dataset.bvid ?? '?') && s.dataset.state === 'shown';
    }),
    null,
    { timeout: 10000 },
  );
  const t2 = await readTimes();
  const calls2 = apiCalls().slice(1);
  check(t2.length === BILI_RECS_NEXT.length && t2[2]?.text === '40分钟前' && t2[4]?.text === '2天前' && t2[0]?.text === '10天前', `每张卡片的时间换成新内容的：${t2.map((x) => x.text).join('、')}`);
  check(
    calls2.length === 1 && same(idsOf(calls2[0]), BILI_RECS_NEXT.slice(1).map((r) => r?.bv ?? '')),
    '只查新出现的视频，刚才查过的那个用本机记着的',
  );
  await panel.getByTestId('bili-current-title').filter({ hasText: BILI_NEXT_VIDEO.title }).waitFor({ timeout: 5000 });
  check(true, '侧边栏"当前视频"跟上跳到的那个视频');

  console.log('\n[B站：点"展开"加载出来的新条目也显示]');
  await bili.evaluate(() => /** @type {any} */ (window).__expand());
  await shownCount(BILI_RECS_NEXT.length + BILI_RECS_MORE.length);
  const t3 = await readTimes();
  check(t3.at(-1)?.text === '25天前' && /^(20)?21-10-09$/.test(t3.at(-2)?.text ?? '') && apiCalls().length === 3, `"展开"后多出的 ${BILI_RECS_MORE.length} 条：${t3.slice(-2).map((x) => x.text).join('、')}`);

  console.log('\n[B站：封面左上角"收藏" → 弹窗加标签 → 存在本机；不打开视频、不点 B 站自己的元素]');
  const card = (/** @type {number} */ i) => bili.locator('.video-page-card-small:not([data-kind])').nth(i);
  const stored = () => panel.evaluate(async () => (await /** @type {any} */ (globalThis).chrome.storage.local.get('bili')).bili ?? { videos: {} });
  const saveOpacity = (/** @type {number} */ i) => card(i).locator('[data-tubemuse="bili-save"]').evaluate((h) => getComputedStyle(h).opacity);
  const urlBefore = bili.url();
  await bili.mouse.move(5, 5);
  await bili.waitForTimeout(300);
  const hidden = await saveOpacity(2);
  await card(2).hover();
  await bili.waitForTimeout(300);
  const picBox = await card(2).locator('.pic-box').boundingBox();
  const saveBox = await card(2).locator('[data-tubemuse="bili-save"] button').boundingBox();
  check(
    hidden === '0' && (await saveOpacity(2)) === '1' && !!picBox && !!saveBox && saveBox.x - picBox.x < 12 && saveBox.y - picBox.y < 12 && saveBox.x + saveBox.width < picBox.x + picBox.width / 2,
    '"收藏"平时不显示，鼠标移到这条视频上时出现在封面左上角（右上角是 B 站的"稍后再看"，右下角是时长）',
  );
  await card(2).locator('[data-tubemuse="bili-save"] button').click();
  const pop = bili.locator('[data-tubemuse="bili-pop"]');
  await pop.locator('input').waitFor({ timeout: 5000 });
  const popText = (await pop.locator('.pop').textContent()) ?? '';
  check(popText.includes(BILI_RECS_NEXT[2]?.title ?? '?') && popText.includes('不会在 B 站上收藏') && popText.includes('40分钟前'), '弹窗里是这条视频（标题、UP 主、发布时间），写明只存在本机、不会在 B 站上收藏');
  await pop.locator('input').fill('三体，科幻');
  await pop.locator('input').press('Enter');
  await card(2).locator('[data-tubemuse="bili-save"] button').filter({ hasText: '已收藏 · 2' }).waitFor({ timeout: 5000 });
  const rec = BILI_RECS_NEXT[2];
  const v1 = (await stored()).videos[rec?.bv ?? ''];
  check(
    !!v1 &&
      JSON.stringify(v1.tags) === JSON.stringify(['三体', '科幻']) &&
      v1.url === `${MOCK}/bili/video/${rec?.bv}/` &&
      v1.title === rec?.title &&
      v1.upName === rec?.up &&
      v1.upMid === rec?.mid &&
      v1.duration === 36 &&
      Math.abs(Date.now() - 40 * 60_000 - v1.publishedAt) < 5 * 60_000,
    '加标签即收藏：标题、UP 主、时长、查到的发布时间、去掉语言和来源参数的链接、两个标签都存进本机',
  );
  check(bili.url() === urlBefore && (await bili.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '没有打开这条视频，也没有点到 B 站自己的任何元素');
  await pop.getByRole('button', { name: '去掉标签 科幻' }).click();
  await card(2).locator('[data-tubemuse="bili-save"] button').filter({ hasText: '已收藏 · 1' }).waitFor({ timeout: 5000 });
  await pop.locator('input').press('Escape');
  await pop.waitFor({ state: 'detached', timeout: 3000 });
  await bili.mouse.move(5, 5);
  await bili.waitForTimeout(300);
  check((await saveOpacity(2)) === '1' && (await saveOpacity(3)) === '0', '在弹窗里去掉一个标签；Esc 关闭；收藏过的按钮常驻，没收藏的只在悬停时出现');

  console.log('\n[B站：侧边栏里收藏当前视频；按标签筛选、移出与撤销]');
  await panel.getByTestId('bili-current-save').click();
  await panel.getByTestId('bili-item').nth(1).waitFor({ timeout: 5000 });
  const v2 = (await stored()).videos[BILI_NEXT_VIDEO.bv];
  check(
    v2?.title === BILI_NEXT_VIDEO.title &&
      v2.upName === BILI_NEXT_VIDEO.up &&
      v2.upMid === BILI_NEXT_VIDEO.mid &&
      v2.publishedAt === BILI_NEXT_VIDEO.at &&
      v2.duration === BILI_NEXT_VIDEO.seconds &&
      v2.url === `${MOCK}/bili/video/${BILI_NEXT_VIDEO.bv}/`,
    '"收藏这个视频"：标题、UP 主、发布时间、时长来自页面的 meta，链接是规范的视频页链接',
  );
  await panel.getByTestId('bili-current-unsave').waitFor({ timeout: 3000 });
  await panel.getByTestId('bili-tag-filter').getByRole('button', { name: /#三体/ }).click();
  check((await panel.getByTestId('bili-item').count()) === 1, '按标签筛选：只剩打了 #三体 的那一个');
  await panel.getByTestId('bili-tag-filter').getByRole('button', { name: /#三体/ }).click();
  await panel.getByTestId('bili-item').first().getByTestId('bili-remove').click();
  await panel.getByRole('button', { name: '撤销' }).click();
  await panel.getByTestId('bili-item').nth(1).waitFor({ timeout: 5000 });
  check(Object.keys((await stored()).videos).length === 2, '移出收藏后可以撤销');
  await panel.screenshot({ path: join(shots, '61-bili-panel.png'), fullPage: true });

  console.log('\n[B站：取消勾选 → 发布时间消失；关掉整个功能 → 页面上 TubeMuse 加的东西全部消失]');
  const callsBeforeOff = apiCalls().length;
  await panel.getByTestId('bili-show-pubdate').uncheck();
  await bili.waitForFunction(() => document.querySelectorAll('[data-tubemuse="bili-pubdate"]').length === 0, null, { timeout: 5000 });
  const setBili = (/** @type {Record<string, boolean>} */ patch) =>
    panel.evaluate(async (p) => {
      const c = /** @type {any} */ (globalThis).chrome;
      const { settings = {} } = await c.storage.local.get('settings');
      await c.storage.local.set({ settings: { ...settings, bili: { ...settings.bili, ...p } } });
    }, patch);
  await setBili({ enabled: false });
  await bili.waitForFunction(() => document.querySelectorAll('[data-tubemuse^="bili"]').length === 0, null, { timeout: 5000 });
  await setBili({ enabled: true });
  await bili.locator('[data-tubemuse="bili-save"]').first().waitFor({ state: 'attached', timeout: 5000 });
  check(apiCalls().length === callsBeforeOff, '取消勾选、关掉再打开：页面上的东西跟着消失、恢复，没有再向 B 站查');

  console.log('\n[B站：播放列表页（/list/…，你在 Firefox 上发现没有显示的那种）→ 右侧列表每一项的"N万播放"后面显示发布时间、能收藏；英文的 /en/… 网址也认得]');
  await panel.getByTestId('bili-show-pubdate').check();
  const listCalls0 = apiCalls().length;
  const listUrl = `${MOCK}/bili/en/list/${BILI_LIST_ID}?sort_field=pubtime&spm_id_from=333.1387.0.0&oid=1&bvid=${BILI_LIST[0]?.bv}`;
  await bili.goto(listUrl);
  const listShown = (/** @type {number} */ n) =>
    bili.waitForFunction((k) => document.querySelectorAll('.action-list-item-wrap [data-tubemuse="bili-pubdate"][data-state="shown"]').length === k, n, { timeout: 10000 });
  await listShown(BILI_LIST.length);
  const readList = () =>
    bili.evaluate(() =>
      [...document.querySelectorAll('.action-list-item-wrap')].map((w) => {
        const s = /** @type {HTMLElement | null} */ (w.querySelector('[data-tubemuse="bili-pubdate"]'));
        const v = /** @type {HTMLElement} */ (w.querySelector('.views'));
        return {
          key: /** @type {HTMLElement} */ (w).dataset.key,
          text: s?.textContent ?? '',
          inViews: s?.parentElement === v,
          sameLine: !!s && Math.abs(s.getBoundingClientRect().top - v.getBoundingClientRect().top) < 4,
          views: Math.round(v.getBoundingClientRect().height),
          info: Math.round(/** @type {HTMLElement} */ (w.querySelector('.info')).getBoundingClientRect().height),
          btn: !!w.querySelector('.cover > [data-tubemuse="bili-save"]'),
        };
      }),
    );
  const l1 = await readList();
  check(
    l1[0]?.text === '25天前' && l1[1]?.text === '14天前' && l1[2]?.text === '15天前' && /^(20)?25-01-02$/.test(l1[3]?.text ?? ''),
    `播放列表每一项都显示发布时间：${l1.slice(0, 4).map((x) => x.text).join('、')}`,
  );
  check(
    l1.slice(0, BILI_LIST.length).every((x) => x.inViews && x.sameLine && x.views === 16 && x.info === 60 && x.btn),
    `时间写在"N万播放"那一行的末尾（同一行），这一行和整项的高度不变；每一项的封面上都有"收藏"（${JSON.stringify(l1.slice(0, BILI_LIST.length).map((x) => [x.inViews, x.sameLine, x.views, x.info, x.btn]))}）`,
  );
  check(l1[BILI_LIST.length]?.text === '' && l1[BILI_LIST.length]?.btn === false, '分 P 视频那一项（data-key 不是 BV 号）不显示时间、不放按钮');
  await bili.waitForFunction((n) => document.querySelectorAll('.recommend-video-card [data-tubemuse="bili-pubdate"][data-state="shown"]').length === n, BILI_LIST_RECS.length, { timeout: 10000 });
  const lr = await bili.evaluate(() =>
    [...document.querySelectorAll('.recommend-video-card')].map((c) => {
      const s = /** @type {HTMLElement} */ (c.querySelector('[data-tubemuse="bili-pubdate"]'));
      const p = /** @type {HTMLElement} */ (c.querySelector('.playinfo'));
      const r = s.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      return { text: s.textContent, inPlay: s.parentElement === p, sameLine: Math.abs(r.top - pr.top) < 4 && r.right <= pr.right + 1, playH: Math.round(pr.height), btn: !!c.querySelector('.pic-box > [data-tubemuse="bili-save"]') };
    }),
  );
  check(
    lr[0]?.text === '6天前' && /^(20)?23-06-06$/.test(lr[1]?.text ?? '') && lr.every((x) => x.inPlay && x.sameLine && x.playH === 18 && x.btn),
    `播放列表下面的推荐（.recommend-video-card，播放量那一行占满整行）：时间写在这一行里面的末尾、不另起一行，有"收藏"：${JSON.stringify(lr)}`,
  );
  const listCalls = apiCalls().slice(listCalls0);
  check(
    listCalls.length === 1 && same(idsOf(listCalls[0] ?? { query: {} }), [...BILI_LIST, ...BILI_LIST_RECS].map((r) => r.bv)),
    '一次查完这一页的视频（播放列表的 BV 号来自每一项的 data-key，推荐来自链接）',
  );
  await panel.getByTestId('bili-tab-status').filter({ hasText: `${BILI_LIST.length + BILI_LIST_RECS.length} 条显示了发布时间` }).waitFor({ timeout: 5000 });
  await panel.getByTestId('bili-current-title').filter({ hasText: BILI_LIST[0]?.title ?? '?' }).waitFor({ timeout: 5000 });
  check(
    ((await panel.getByTestId('bili-current').textContent()) ?? '').includes('发布 '),
    '侧边栏认得英文网址 /en/list/…?bvid= 里的当前视频；这种页面没有发布时间的 meta，用的是列表里查到的那一个',
  );
  await bili.evaluate(() => /** @type {any} */ (window).__loadMore());
  await listShown(BILI_LIST.length + BILI_LIST_MORE.length);
  const l2 = await readList();
  const moreCalls = apiCalls().slice(listCalls0 + 1);
  check(
    moreCalls.length === 1 && same(idsOf(moreCalls[0] ?? { query: {} }), BILI_LIST_MORE.map((r) => r.bv)) && l2.some((x) => x.text === '20天前') && l2.some((x) => /^(20)?24-12-24$/.test(x.text)),
    '往下滚加载出的下一批也显示，只查新出现的',
  );
  const listItem = (/** @type {number} */ i) => bili.locator('.action-list-item-wrap').nth(i);
  await bili.mouse.move(5, 5);
  await listItem(1).hover();
  await bili.waitForTimeout(300);
  const cover = await listItem(1).locator('.cover').boundingBox();
  const listBtn = await listItem(1).locator('[data-tubemuse="bili-save"] button').boundingBox();
  check(
    (await listItem(1).locator('[data-tubemuse="bili-save"]').evaluate((h) => getComputedStyle(h).opacity)) === '1' && !!cover && !!listBtn && listBtn.x - cover.x < 10 && listBtn.y - cover.y < 10,
    '鼠标移到一项上，封面左上角出现"收藏"',
  );
  await listItem(1).locator('[data-tubemuse="bili-save"] button').click();
  await pop.locator('input').fill('人界');
  await pop.locator('input').press('Enter');
  await listItem(1).locator('[data-tubemuse="bili-save"] button').filter({ hasText: '已收藏 · 1' }).waitFor({ timeout: 5000 });
  const lv = (await stored()).videos[BILI_LIST[1]?.bv ?? ''];
  check(
    lv?.url === `${MOCK}/bili/video/${BILI_LIST[1]?.bv}/` && lv.title === BILI_LIST[1]?.title && typeof lv.publishedAt === 'number' && JSON.stringify(lv.tags) === '["人界"]',
    '收藏播放列表里的一项：链接是这个视频的视频页（列表编号不进去）、标题、查到的发布时间、标签',
  );
  check(bili.url() === listUrl && (await bili.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '点"收藏"没有切到那个视频，也没有点到 B 站自己的任何东西');
  await pop.locator('input').press('Escape');
  await pop.waitFor({ state: 'detached', timeout: 3000 });

  console.log('\n[B站：视频页右侧的合集 / 分 P 列表也显示时间——合集里每个视频的发布时间，分 P 里每一 P 的上传时间]');
  const partCalls = () => requests.filter((r) => r.path === '/biliapi/x/player/pagelist');
  const readPod = () =>
    bili.evaluate(() =>
      [...document.querySelectorAll('.video-pod__item')].map((it) => {
        const row = /** @type {HTMLElement} */ (it.classList.contains('simple-base-item') ? it : it.querySelector('.simple-base-item'));
        const s = /** @type {HTMLElement | null} */ (row.querySelector('[data-tubemuse="bili-pubdate"]'));
        const st = /** @type {HTMLElement} */ (row.querySelector('.stats'));
        return {
          text: s?.textContent ?? '',
          state: s?.dataset.state,
          hint: s?.title ?? '',
          last: !!s && row.lastElementChild === s && s.previousElementSibling === st,
          sameRow: !!s && Math.abs(s.getBoundingClientRect().top + s.getBoundingClientRect().height / 2 - (st.getBoundingClientRect().top + st.getBoundingClientRect().height / 2)) < 3,
          h: Math.round(row.getBoundingClientRect().height),
          btn: !!it.querySelector('[data-tubemuse="bili-save"]'),
        };
      }),
    );
  const podCalls0 = apiCalls().length;
  await bili.goto(`${MOCK}/bili/zh-Hans/video/${BILI_POD_SEASON[1]?.bv}/`);
  await bili.waitForFunction((n) => document.querySelectorAll('.video-pod__item [data-tubemuse="bili-pubdate"][data-state="shown"]').length === n, BILI_POD_SEASON.length, { timeout: 10000 });
  const season = await readPod();
  check(
    /^(20)?26-08-17$/.test(season[0]?.text ?? '') && season[1]?.text === '12天前' && season[2]?.text === '5小时前' && season.every((x) => x.last && x.sameRow && x.h === 31 && !x.btn),
    `合集：每一项写它自己的发布时间，接在时长后面、当这一行的最后一项，行高还是 31，不放"收藏"（${season.map((x) => x.text).join('、')}）`,
  );
  check(apiCalls().length === podCalls0 + 1 && same(idsOf(apiCalls().at(-1) ?? { query: {} }), BILI_POD_SEASON.map((r) => r.bv)) && partCalls().length === 0, '合集的 BV 号来自每一项的 data-key，一次查完；没有去查分 P');
  await bili.goto(`${MOCK}/bili/zh-Hans/video/${BILI_POD_PARTS_BV}/?p=2&spm_id_from=333.788.videopod.episodes`);
  await bili.waitForFunction((n) => document.querySelectorAll('.video-pod__item [data-tubemuse="bili-pubdate"]:is([data-state="shown"], [data-state="unknown"])').length === n, BILI_POD_PARTS.length, { timeout: 10000 });
  const parts = await readPod();
  check(
    /^(20)?21-01-14$/.test(parts[0]?.text ?? '') && /^(20)?19-04-03$/.test(parts[1]?.text ?? '') && /^(20)?20-11-10$/.test(parts[2]?.text ?? '') && parts[3]?.text === '时间未知' && parts[3]?.state === 'unknown',
    `分 P：每一 P 写它自己的上传时间（同一个视频的各 P 可以隔几年上传），B 站没给的写"时间未知"：${parts.map((x) => x.text).join('、')}`,
  );
  check(parts[1]?.hint.includes('这一 P 上传于 2019/04/03') === true && parts.every((x) => x.last && x.sameRow && x.h === 31 && !x.btn), `悬停写明是这一 P 的上传时间（${parts[1]?.hint}）；位置、行高同合集`);
  const pc = partCalls();
  check(
    pc.length === 1 && pc[0]?.query.bvid === BILI_POD_PARTS_BV && Object.keys(pc[0]?.query ?? {}).length === 1 && pc[0]?.method === 'GET' && !pc[0]?.headers.cookie && !pc[0]?.headers.referer,
    '分 P 的上传时间一个视频只查一次（x/player/pagelist，只带 BV 号，不带 Cookie、不带 Referer）',
  );
  await bili.goto(`${MOCK}/bili/video/${BILI_POD_PARTS_BV}/?p=3`);
  await bili.waitForFunction((n) => document.querySelectorAll('.video-pod__item [data-tubemuse="bili-pubdate"][data-state="shown"]').length === n, BILI_POD_PARTS.length - 1, { timeout: 10000 });
  check(partCalls().length === 1, '换一 P、重新打开这个视频：用记着的，不再查');

  console.log('\n[B站：B 站拦下查询（-352）→ 照实说明、停一阵，这期间不再发请求]');
  await panel.getByTestId('bili-show-pubdate').check();
  await bili.goto(pageUrl);
  await bili.waitForFunction(() => /** @type {any} */ (window).__oursBeforeHydration >= 0, null, { timeout: 10000 });
  await bili.locator('[data-tubemuse="bili-pubdate"]').first().waitFor({ timeout: 5000 });
  await bili.evaluate(() => /** @type {any} */ (window).__blocked());
  const blockedSpan = bili.locator(`[data-tubemuse="bili-pubdate"][data-bvid="${BILI_BLOCKED}"][data-state="failed"]`);
  await blockedSpan.waitFor({ timeout: 10000 });
  const blockedCalls = apiCalls().length;
  await panel.getByTestId('bili-error').waitFor({ timeout: 5000 });
  const errText = (await panel.getByTestId('bili-error').textContent()) ?? '';
  const failedHint = (await blockedSpan.getAttribute('title')) ?? '';
  check(errText.includes('拦下') && errText.includes('分钟后再查') && failedHint.includes('拦下'), `侧边栏和那条视频上都说明没查到的原因：${errText}`);
  check(idsOf(apiCalls().at(-1) ?? { query: {} }).join(',') === BILI_BLOCKED, '被拦的那次只查了新出现的那一个');
  check(
    (await bili.locator('[data-tubemuse="bili-pubdate"][data-state="failed"]').count()) === 1 && ((await bili.locator('[data-tubemuse="bili-pubdate"][data-bvid="BV1Gone00000"]').textContent()) ?? '') === '时间未知',
    '只有被拦的那一条写"时间?"：已经知道接口里查不到的那条仍写"时间未知"，查到的照常显示',
  );
  await bili.goto(pageUrl);
  await bili.waitForFunction(() => /** @type {any} */ (window).__oursBeforeHydration >= 0, null, { timeout: 10000 });
  await bili.locator('[data-tubemuse="bili-pubdate"][data-state="shown"]').first().waitFor({ timeout: 5000 });
  await bili.evaluate(() => /** @type {any} */ (window).__blocked());
  await blockedSpan.waitFor({ timeout: 10000 });
  check(apiCalls().length === blockedCalls, '退避期间刷新页面再遇到没查过的视频：后台直接说明，不再发请求；查过的照常显示');

  console.log('\n[B站：这一页的红线]');
  const pageReqs = requests.slice(reqStart).filter((r) => String(r.headers.referer ?? '').startsWith(`${MOCK}/bili/`) && !r.path.endsWith('favicon.ico'));
  check(pageReqs.length === 0, `B 站页面上没有 TubeMuse 发出的请求${pageReqs.length ? `：${pageReqs.map((r) => r.path).join(', ')}` : ''}`);
  check(
    apiCalls().every((r) => r.method === 'GET' && !r.headers.cookie && !r.headers.referer && idsOf(r).every((id) => /^BV[0-9A-Za-z]{10}$/.test(id))) &&
      partCalls().every((r) => r.method === 'GET' && !r.headers.cookie && !r.headers.referer && /^BV[0-9A-Za-z]{10}$/.test(String(r.query.bvid))),
    `向 B 站接口的 ${apiCalls().length + partCalls().length} 次请求都只是 GET、只带 BV 号，不带 Cookie 和 Referer`,
  );
  check((await bili.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '全程没有点到 B 站自己的任何东西');
  await bili.close();
}
