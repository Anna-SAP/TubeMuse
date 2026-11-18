// @ts-check
// 故事（DECISIONS §88）：在仿 X 帖子页（用户给的例子）和仿新闻页上读页面、联网调研、看结果；读不了的页面、不读的站、
// 右键菜单 / 快捷键的留话、粘贴文字、历史、设置里的开关，以及红线（只读不写不点、只发该发的、只有一处读页面的入口）。
import { join } from 'node:path';
import { check, FAKE_KEY, MOCK, shots } from '../harness.mjs';
import { STORY_NEWS_SLUG, STORY_X_POST } from '../story-pages.mjs';

/** @param {import('../harness.mjs').Harness} t */
export async function story(t) {
  const { context, options, requests, consoleErrors } = t;
  const panel = await t.openPanel();
  const llmReqs = () => requests.filter((r) => r.path === '/anthropic/v1/messages');
  const text = async (/** @type {string} */ id) => (await panel.getByTestId(id).first().textContent()) ?? '';
  /** 在当前窗口里打开一个网页、切过去（就像你点开它），返回页面和它的标签页 ID */
  const open = async (/** @type {string} */ url) => {
    const [page, tabId] = await Promise.all([context.waitForEvent('page'), panel.evaluate(async (u) => (await /** @type {any} */ (globalThis).chrome.tabs.create({ url: u, active: true })).id, url)]);
    page.on('pageerror', (e) => consoleErrors.push(`story page pageerror: ${e.message}`));
    await page.waitForLoadState('load');
    return { page, tabId: /** @type {number} */ (tabId) };
  };
  const pageState = (/** @type {import('playwright').Page} */ page) => page.evaluate(() => ({ mutations: /** @type {any} */ (window).__mutations, clicks: /** @type {any} */ (window).__clicks }));

  // ───────────────────────── 故事 ─────────────────────────
  console.log('\n[故事：标签在"发现"后面；当前标签页读不了时说明怎么办]');
  await panel.bringToFront();
  const tabs = await panel.getByRole('tab').allTextContents();
  check(tabs.indexOf('故事') === tabs.indexOf('发现') + 1, `"故事"在"发现"后面：${tabs.join(' ')}`);
  await panel.getByRole('tab', { name: '故事' }).click();
  await panel.getByTestId('story-view').waitFor({ timeout: 5000 });
  const llmStart = llmReqs().length;
  // 当前标签页是扩展自己的页面（侧边栏在 e2e 里以标签页打开）：谁都不能往里放脚本
  await panel.getByTestId('story-read').click();
  await panel.getByTestId('story-no-access').waitFor({ timeout: 5000 });
  check((await text('story-no-access')).includes('右键'), '读不了当前页面：说明可以右键「TubeMuse：讲讲这个故事」或按快捷键');
  check((await text('story-no-access')).includes('Alt+Shift+G'), `说明里写着快捷键：${(await text('story-no-access')).slice(0, 80)}`);

  console.log('\n[故事：X 帖子页（用户给的例子）——只读这一条帖子和它引用的那一条]');
  const { page: xp } = await open(`${MOCK}/xpage/${STORY_X_POST.user}/status/${STORY_X_POST.id}?s=20&t=sharerToken`);
  await panel.getByTestId('story-read').click();
  await panel.getByTestId('story-page').waitFor({ timeout: 8000 });
  const post = await text('story-post');
  const quoted = await text('story-quoted');
  check(post.includes('Elon Musk') && post.includes('@elonmusk') && post.includes('🤷‍♂️'), `主帖：作者、用户名、正文（表情）：${post.slice(0, 80)}`);
  check(post.includes('4204000 次观看') && /2026\/11\/1[78]/.test(post), `主帖：页面上显示的互动数据和发布时间：${post.slice(0, 160)}`);
  check(quoted.includes('Eric Daugherty') && quoted.includes('Sean Duffy RESPONDS') && quoted.includes('based on the ground') && quoted.includes('视频'), `引用的帖子：作者、正文、附带视频：${quoted.slice(0, 120)}`);
  const card = await text('story-page');
  check(!card.includes('最新消息') && !card.includes('达菲'), '翻译扩展插进页面的中文译文不读');
  check(!card.includes('This reply text'), '下面的回复不读');
  check((await panel.getByTestId('story-page-title').getAttribute('href')) === `${MOCK}/xpage/${STORY_X_POST.user}/status/${STORY_X_POST.id}`, '帖子链接不带分享参数（?s=…&t=…）');
  check((await panel.getByTestId('story-site-offer').count()) === 0, '已经有权限的站：不问"以后直接读"');
  check(llmReqs().length === llmStart, '只是读页面：什么都没有发给大模型');
  check(((await text('story-disclosure')) ?? '').includes('发给 Anthropic'), '调研按钮下面说明发什么、发给谁、大约多少钱');

  console.log('\n[故事：调研 → 已证实 / 只是说法 / 推测分清，每一条都有可点的来源]');
  await panel.getByTestId('story-run').click();
  await panel.getByTestId('story-result').waitFor({ timeout: 15000 });
  check((await text('story-headline')).includes('Duffy 回应马斯克'), `一句话说清怎么回事：${await text('story-headline')}`);
  const legend = await text('story-legend');
  check(legend.includes('已证实 2') && legend.includes('只是说法 1') && legend.includes('有争议 0') && legend.includes('查无实据 0'), `四种状态的计数：${legend}`);
  const claimStatuses = await panel.getByTestId('story-claim').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')));
  check(JSON.stringify(claimStatuses) === JSON.stringify(['confirmed', 'claimed']), `核心说法逐条核对：${claimStatuses.join(' ')}`);
  check((await text('story-downgraded')).includes('有 1 条'), '只有页面本身作来源的"已证实"降为"只是说法"，并且说出来');
  check((await text('story-caveat')).includes('只有他本人一方'), '提醒：一面之词');
  const sources = panel.getByTestId('story-source');
  check((await sources.count()) === 2, `来源只有真的搜到的那两个（编造的 S7 没有出现）：${await sources.count()}`);
  check((await sources.first().locator('a').getAttribute('href')) === 'https://www.reuters.com/world/us/duffy-musk-starlink-faa-2026-11-17/' && (await sources.first().textContent())?.includes('based on the ground') === true, '来源 S1 是路透社，带着被引用的原文');
  const refLinks = await panel.getByTestId('story-claims').getByTestId('story-ref').evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute('href')]));
  check(refLinks.some(([t2, h]) => t2 === '[S1]' && h?.includes('reuters.com')) && refLinks.some(([t2]) => t2 === '[页面]'), `说法后面的来源可以点开：${JSON.stringify(refLinks)}`);
  check(((await panel.getByTestId('story-timeline').textContent()) ?? '').includes('2026-11-10'), '来龙去脉按时间排');
  check(((await panel.getByTestId('story-analysis').textContent()) ?? '').includes('不是事实'), '深层含义标明是分析和推测');
  const footer = await text('story-footer');
  check(footer.includes('搜索 1 次') && footer.includes('"Sean Duffy Starlink FAA ground network"') && footer.includes('max_uses_exceeded') && footer.includes('claude-haiku-5-5'), `说明搜了什么、几次、出错的搜索、用的模型和花费：${footer.slice(0, 200)}`);
  await panel.screenshot({ path: join(shots, '60-story-x.png'), fullPage: true });

  const [researchReq, briefReq] = llmReqs().slice(-2);
  const rb = JSON.parse(researchReq?.body ?? '{}');
  check(llmReqs().length === llmStart + 2, '调研发了两次请求：联网调研、整理');
  check(JSON.stringify(rb.tools) === JSON.stringify([{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]), `调研带着服务方自带的搜索工具和次数上限：${JSON.stringify(rb.tools)}`);
  check(researchReq?.body.includes('Sean Duffy RESPONDS') === true && researchReq.body.includes('4204000'), '调研请求里有主帖、引用的帖子和互动数据');
  const leaks = ['This reply text', '最新消息', 'sharerToken', FAKE_KEY].filter((s) => researchReq?.body.includes(s) || briefReq?.body.includes(s));
  check(leaks.length === 0, `回复、译文、分享参数、Key 都没有发出去${leaks.length ? `，却出现了：${leaks.join('、')}` : ''}`);
  check(briefReq?.body.includes('故事整理员') === true && briefReq.body.includes('[S1]') && !briefReq.body.includes('"tools"') && !briefReq.body.includes('turned down'), '整理请求：带编号的笔记和来源清单，不联网，不再发一遍帖子正文');
  const ledger = /** @type {any} */ (await panel.evaluate(async () => (await /** @type {any} */ (globalThis).chrome.storage.local.get('llmLedger')).llmLedger));
  const research = /** @type {any} */ (Object.values(ledger.days)[0])?.byTask?.storyResearch;
  check(Math.abs((research?.usd ?? 0) - ((20000 * 0.1 + 1500 * 0.5) / 1e6 + 0.01)) < 1e-6, `花费记在"AI $"里：token 加 1 次 $0.01 的搜索费（${research?.usd}）`);
  check((await pageState(xp)).mutations === 0 && (await pageState(xp)).clicks === 0, 'X 页面：读的时候没有改动页面、没有点任何东西');

  console.log('\n[故事：同一个页面再读，直接显示上次的结果，不再花钱]');
  await panel.getByTestId('story-read').click();
  await panel.getByTestId('story-cached').waitFor({ timeout: 8000 });
  check((await text('story-cached')).includes('没有再花钱') && (await panel.getByTestId('story-rerun').count()) === 1, '缓存时间内：标明是上次的结果，可以点"重新调研"');
  check(llmReqs().length === llmStart + 2, '没有发新的请求');

  console.log('\n[故事：新闻页——页面声明的元数据、正文；导航、侧栏、页脚、隐藏段落、译文不读；选中的文字优先查]');
  const { page: news, tabId: newsTab } = await open(`${MOCK}/news/${STORY_NEWS_SLUG}?utm_source=newsletter&fbclid=abc123`);
  await news.evaluate(() => {
    const p = [...document.querySelectorAll('article p')].find((e) => e.textContent?.includes('based on the ground'));
    const node = [...(p?.childNodes ?? [])].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes('based on the ground'));
    if (!node) return;
    const at = node.textContent?.indexOf('based on the ground') ?? 0;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 'based on the ground'.length);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  });
  const newsMutationsBefore = (await pageState(news)).mutations;
  await panel.getByTestId('story-read').click();
  await panel.getByTestId('story-page-text').waitFor({ timeout: 8000 });
  const newsCard = await text('story-page');
  check((await text('story-page-title')) === 'Duffy: FAA wants a ground-based network, not free Starlink', `标题用页面声明的：${await text('story-page-title')}`);
  check(newsCard.includes('Example News') && newsCard.includes('Jane Reporter') && newsCard.includes('发布于 2026/11/17'), `站点名、作者、发布时间：${newsCard.slice(0, 160)}`);
  const body = await text('story-page-text');
  check(body.includes('Transportation Secretary Sean Duffy') && body.includes('modernize its air traffic control'), '正文段落读到了');
  check(!/nav junk|Hidden paragraph|aside recommendation|Footer text|我们认为/.test(body), `导航、隐藏段落、侧栏、页脚、译文都不读：${body.slice(0, 200)}`);
  check((await text('story-selection')).includes('based on the ground'), '你选中的文字单独列出来（会优先查它）');
  check((await panel.getByTestId('story-page-title').getAttribute('href')) === `${MOCK}/news/${STORY_NEWS_SLUG}`, '链接用页面声明的规范链接，跟踪参数去掉了');
  check((await pageState(news)).mutations === newsMutationsBefore && (await pageState(news)).clicks === 0, '新闻页：读的时候没有改动页面、没有点任何东西');
  check(llmReqs().length === llmStart + 2, '读了新的页面：还没点"调研"，什么都没发');

  console.log('\n[故事：不读的站、X 信息流]');
  const { page: gmail } = await open(`${MOCK}/gmail/mail`);
  await panel.getByTestId('story-read').click();
  await panel.getByTestId('story-read-skipped').waitFor({ timeout: 8000 });
  check((await text('story-read-skipped')).includes('Gmail'), '各有约定的站（这里是 Gmail）：一个字都不读，说明可以粘贴文字');
  await gmail.close();
  const { page: home } = await open(`${MOCK}/xpage/home`);
  await panel.getByTestId('story-read').click();
  await panel.getByTestId('story-read-x-nopost').waitFor({ timeout: 8000 });
  check(true, 'X 的信息流：说明要先点开一条帖子，信息流不读');
  await home.close();

  console.log('\n[故事：右键菜单 / 快捷键的留话——侧边栏切到「故事」，读那个标签页]');
  await panel.getByRole('tab', { name: '找片' }).click();
  await panel.evaluate((tabId) => /** @type {any} */ (globalThis).chrome.storage.session.set({ storyRequest: { tabId, at: Date.now() } }), newsTab);
  await panel.getByRole('tab', { name: '故事', selected: true }).waitFor({ timeout: 5000 });
  await panel.getByTestId('story-page-title').filter({ hasText: 'Duffy: FAA wants' }).waitFor({ timeout: 8000 });
  check(true, '收到留话：切到「故事」页，读了留话里的那个标签页');
  const leftover = await panel.evaluate(async () => (await /** @type {any} */ (globalThis).chrome.storage.session.get('storyRequest')).storyRequest);
  check(leftover === undefined, '读了就删掉留话');
  await panel.evaluate((tabId) => /** @type {any} */ (globalThis).chrome.storage.session.set({ storyRequest: { tabId, at: Date.now() - 5 * 60_000 } }), newsTab);
  await panel.waitForTimeout(500);
  check((await panel.getByTestId('story-read').isEnabled()) && (await panel.getByTestId('story-page').count()) === 1, '过时的留话（几分钟前的）不理会');
  await news.close();

  console.log('\n[故事：粘贴文字来查]');
  await panel.getByTestId('story-paste').locator('summary').click();
  await panel.getByTestId('story-paste-text').fill('有人说某地今天宣布了全新的交通政策');
  await panel.getByTestId('story-paste-use').click();
  await panel.getByTestId('story-page').filter({ hasText: '粘贴的文字' }).waitFor({ timeout: 5000 });
  check(((await text('story-page-title')) ?? '').includes('全新的交通政策'), '粘贴的文字当作要查的页面，同样可以调研');

  console.log('\n[故事：调研过的、设置里的开关]');
  await panel.getByTestId('story-mode-history').click();
  await panel.getByTestId('story-history').waitFor({ timeout: 5000 });
  check((await panel.getByTestId('story-history-item').count()) === 1, '"调研过的"列出那一条');
  await panel.getByTestId('story-history-item').first().locator('button').first().click();
  await panel.getByTestId('story-history').getByTestId('story-result').waitFor({ timeout: 5000 });
  await panel.getByTestId('story-delete').click();
  await panel.getByTestId('story-history-empty').waitFor({ timeout: 5000 });
  check(true, '可以删掉');
  await panel.getByTestId('story-mode-current').click();
  await options.bringToFront();
  await options.getByTestId('story-enabled').uncheck();
  await panel.getByText('故事已在设置里关闭').waitFor({ timeout: 5000 });
  check(true, '在设置里关掉故事：这一页说明已关闭，不读页面、不调研');
  check((await options.getByTestId('story-sites').textContent())?.includes('还没有') === true, '设置页列出"允许直接读的网站"（现在一个都没有）');
  await options.getByTestId('story-enabled').check();
  await xp.close();
  await panel.bringToFront();
}
