// @ts-check
// 问 muse：在 YouTube、小红书、X、Instagram、抖音、酷播、B 站的仿页面上各冻结一次，核对咨询包的内容与红线。
import { join } from 'node:path';
import { CC_MULTI_DESCRIPTION, E2E_CLIENT_SECRET } from '../mock-server.mjs';
import { check, FAKE_KEY, MOCK, shots, X_TOKEN } from '../harness.mjs';
import { DOUYIN_NEXT, DOUYIN_VIDEO } from '../douyin-pages.mjs';
import { IG_FEED_POST } from '../ig-pages.mjs';
import { BILI_EPISODE } from '../bili-pages.mjs';
import { KUBB_AD_SECONDS, KUBB_MOVIE } from '../kubb-pages.mjs';
import { X_FEED_POST, X_POST, X_TEXT_POST } from '../x-pages.mjs';
import { XHS_N1, XHS_V1 } from '../xhs-pages.mjs';

/** @param {import('../harness.mjs').Harness} t */
export async function muse(t) {
  const { context, sw, requests, consoleErrors } = t;
  const panel = await t.openPanel();
  // 下面这几个和 emails.mjs、subtitles.mjs 里的同名工具是同一个定义（拆文件之前它们在同一个作用域里）
  const llmCount = () => requests.filter((r) => r.path === '/anthropic/v1/messages').length;
  const timedtextReqs = (/** @type {string} */ v) => requests.filter((r) => r.path === '/api/timedtext' && r.query.v === v);
  const playerTt = (/** @type {string} */ v) => timedtextReqs(v).filter((r) => r.headers['x-mock-player'] === '1');
  const ourTt = (/** @type {string} */ v) => timedtextReqs(v).filter((r) => r.headers['x-mock-player'] !== '1');
  /** 假播放器现在的样子：原生字幕的语言（关着是 null）、字幕窗口数、被调用过的改动性接口、页面上不该有的变化 */
  const nativeState = (/** @type {import('playwright').Page} */ page) =>
    page.evaluate(() => {
      const p = /** @type {any} */ (document.getElementById('movie_player'));
      const w = /** @type {any} */ (window);
      return { lang: p.getOption('captions', 'track')?.languageCode ?? null, windows: document.querySelectorAll('.caption-window').length, calls: /** @type {any[]} */ (w.__playerCalls), foreign: /** @type {string[]} */ (w.__foreign) };
    });
  /** 只允许调用播放器自己的字幕开关 */
  const onlyCaptionCalls = (/** @type {any[]} */ calls) => calls.every((c) => (c[0] === 'setOption' && c[1] === 'captions' && c[2] === 'track') || (c[0] === 'loadModule' && c[1] === 'captions'));

  // ───────────────────────── 问 muse ─────────────────────────
  console.log('\n[问 muse：顶部按钮；当前标签页不是视频页时说明原因]');
  const museReqStart = requests.length;
  const museLlmStart = llmCount();
  const MUSE_RULE = '视频里的说法必须引用位置或原文；通用概念问题可用通用知识回答，但必须标明「这是通用知识，不是视频原话」。';
  /** 咨询包里某一项的值（"作者：xxx" → "xxx"） */
  const museField = (/** @type {string} */ pkg, /** @type {string} */ name) => new RegExp(`^${name}：(.*)$`, 'm').exec(pkg)?.[1] ?? '';
  /** 把网址里带 needle 的那个标签页切成当前标签页（就像你点回它） */
  const activateTab = (/** @type {string} */ needle) =>
    panel.evaluate(async (needle) => {
      const c = /** @type {any} */ (globalThis).chrome;
      const [t] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes(needle));
      await c.tabs.update(t.id, { active: true });
    }, needle);
  /** @type {Map<import('playwright').Page, number>} */
  const museTabIds = new Map();
  /** 等这个标签页里的录制脚本注入好、开始应答（脚本在页面加载完之后才注入：点得太早只会得到"当前标签页没有响应"） */
  const scriptReady = async (/** @type {import('playwright').Page} */ pg) => {
    await pg.waitForLoadState('load');
    for (let i = 0; i < 100; i++) {
      const ok = await panel.evaluate(
        (id) =>
          /** @type {any} */ (globalThis).chrome.tabs.sendMessage(id, { type: 'tubemuse:clips:get-state' }).then(
            (/** @type {unknown} */ r) => !!r,
            () => false,
          ),
        museTabIds.get(pg),
      );
      if (ok) return;
      await panel.waitForTimeout(100);
    }
    throw new Error(`录制脚本一直没有应答：${pg.url()}`);
  };
  /** 新开一个标签页并切过去，等录制脚本就绪 */
  const museTab = async (/** @type {string} */ url) => {
    const [pg, tabId] = await Promise.all([
      context.waitForEvent('page'),
      panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }).then((/** @type {any} */ t) => t.id), url),
    ]);
    pg.on('pageerror', (e) => consoleErrors.push(`muse page pageerror: ${e.message}`));
    museTabIds.set(pg, tabId);
    await scriptReady(pg);
    return pg;
  };
  const musePanel = panel.getByTestId('muse-panel');
  const museNotes = async () => (await panel.getByTestId('muse-note').allTextContents()).join('\n');
  /** 点「问 muse」，等这一次冻结完成（面板上的冻结时刻变了），返回咨询包全文 */
  const askMuse = async () => {
    const stamp = async () => ((await musePanel.count()) ? await musePanel.getAttribute('data-frozen-at') : null);
    const before = await stamp();
    await panel.getByTestId('muse-ask').click();
    for (let i = 0; i < 150; i++) {
      const at = await stamp();
      if (at && at !== before && (await panel.getByTestId('muse-ask').isEnabled())) return panel.getByTestId('muse-package').inputValue();
      await panel.waitForTimeout(100);
    }
    throw new Error(`「问 muse」没有冻结成功：${(await panel.getByTestId('muse-error').count()) ? await panel.getByTestId('muse-error').textContent() : '超时'}`);
  };
  /** 点「问 muse」，等它说明为什么认不出当前视频 */
  const askMuseFails = async (/** @type {string} */ reason) => {
    await panel.getByTestId('muse-ask').click();
    await panel.getByTestId('muse-error').filter({ hasText: reason }).waitFor({ timeout: 8000 });
    return (await panel.getByTestId('muse-package').count()) === 0;
  };
  const videoReady = (/** @type {import('playwright').Page} */ pg, /** @type {string} */ selector) =>
    pg.waitForFunction((s) => (/** @type {HTMLVideoElement | null} */ (document.querySelector(s))?.readyState ?? 0) >= 2, selector, { timeout: 30000 });
  const nativeClicks = (/** @type {import('playwright').Page} */ pg) => pg.evaluate(() => /** @type {any} */ (window).__nativeClicks);

  await panel.bringToFront();
  await panel.getByRole('tab', { name: '找片', exact: true }).click();
  check((await panel.getByTestId('muse-ask').count()) === 1 && (await musePanel.count()) === 0, '侧边栏顶部有「问 muse」按钮，没点之前不占地方');
  // 按钮是一张图（DECISIONS §65）：图要真的加载出来、按给定的大小显示；图上没有字，名字在 aria-label 里
  const museBtn = await panel.getByTestId('muse-ask').evaluate((el) => {
    const img = el.querySelector('img');
    const r = img?.getBoundingClientRect();
    return { loaded: !!img && img.complete && img.naturalWidth > 0, natural: `${img?.naturalWidth}×${img?.naturalHeight}`, shown: `${r?.width}×${r?.height}`, text: (el.textContent ?? '').trim(), src: img?.getAttribute('src') };
  });
  check(museBtn.loaded && museBtn.natural === '120×144' && museBtn.shown === '40×48' && museBtn.text === '', `「问 muse」按钮是一张图，加载出来了：${museBtn.src}，原图 ${museBtn.natural}，显示成 ${museBtn.shown}`);
  check((await panel.getByRole('button', { name: '问 muse', exact: true }).count()) === 1, '图片按钮的名字还是「问 muse」（读屏和悬停提示用）');
  check(await askMuseFails('当前标签页没有响应'), '当前标签页不是支持的视频页：说明原因和怎么办，不生成咨询包');

  console.log('\n[问 muse：YouTube——不用先开字幕，点一下自己取视频自带的字幕；有章节和简介；冻结不暂停视频，链接带 &t=；生成 / 复制 / 打开 muse.ai]');
  const museYt = await museTab(`${MOCK}/watch?v=ccMulti0001`);
  await videoReady(museYt, 'video');
  await museYt.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.currentTime = 2;
    return v.play();
  });
  await museYt.waitForFunction(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime > 2.2, null, { timeout: 10000 });
  const ytPlayerKids = () => museYt.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).children.length);
  const ytKidsBefore = await ytPlayerKids();
  const ytIntroCalls = () => requests.filter((r) => r.path === '/youtube/v3/videos' && r.query.id === 'ccMulti0001' && r.query.part === 'snippet').length;
  const ytIntroBefore = ytIntroCalls();
  const ytTtBefore = { player: playerTt('ccMulti0001').length, ours: ourTt('ccMulti0001').length };
  /** 这一段开始以来：播放器自己发了几次字幕请求、我们取了几次 */
  const ytTt = () => ({ player: playerTt('ccMulti0001').length - ytTtBefore.player, ours: ourTt('ccMulti0001').length - ytTtBefore.ours });
  // 先关掉"自动取 YouTube 字幕"：这个页面刚打开，什么字幕都还没读到
  const museFetchBox = panel.getByTestId('muse-fetch-captions');
  check(await museFetchBox.isChecked(), '面板里有"自动取 YouTube 字幕"的开关，默认开着');
  await museFetchBox.uncheck();
  const ytOffPkg = await askMuse();
  const ytOffState = await nativeState(museYt);
  check(
    ytOffPkg.includes('\n上下文：无字幕\n') && (await museNotes()).includes('你关掉了"自动取 YouTube 字幕"') && ytTt().player === 0 && ytTt().ours === 0 && ytOffState.calls.length === 0,
    '关掉自动取字幕：上下文写「无字幕」并说明原因，不取字幕、不碰播放器',
  );
  await museFetchBox.check();
  // 打开开关再点：多语字幕一直没开过，「问 muse」自己去取
  const ytFirstPkg = await askMuse();
  const ytNative = await nativeState(museYt);
  check(
    ytFirstPkg.includes('上下文（当前位置前后 30 秒的字幕 · YouTube 字幕（') && ytTt().player === 1 && ytTt().ours === 1,
    `没开多语字幕也带上了字幕：请播放器取了 ${ytTt().player} 次（拿到带令牌的请求），再复用它取了 ${ytTt().ours} 种语言`,
  );
  check(
    ytNative.lang === null && ytNative.windows === 0 && ytNative.calls.length > 0 && onlyCaptionCalls(ytNative.calls) && ytNative.foreign.length === 0 && (await museYt.locator('[data-tubemuse="multicc"]').count()) === 0,
    `取完把为此打开的原生字幕关了回去，不显示字幕层，页面别处没动（对播放器只调了字幕开关：${ytNative.calls.length} 次）`,
  );
  const ytPkg = await askMuse();
  check(ytTt().player === 1 && ytTt().ours === 1, '同一个视频再点一次：字幕已经读到了，不再取');
  const ytAfter = await museYt.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    return { t: v.currentTime, paused: v.paused };
  });
  const ytLink = museField(ytPkg, '页面链接');
  const ytT = Number(/^https:\/\/www\.youtube\.com\/watch\?v=ccMulti0001&t=(\d+)s$/.exec(ytLink)?.[1] ?? -1);
  check(museField(ytPkg, '平台') === 'YouTube' && ytT >= 2 && ytT <= ytAfter.t, `YouTube 的链接拼上了冻结那一刻的秒数：${ytLink}`);
  check(museField(ytPkg, '标题') === '多语字幕测试' && museField(ytPkg, '作者') === 'CC Mock', `标题来自页面标题，作者来自官方接口（页面上的不读）：${museField(ytPkg, '标题')} / ${museField(ytPkg, '作者')}`);
  check(museField(ytPkg, '播放位置') === `00:${String(ytT).padStart(2, '0')} / 00:16`, `播放位置是 mm:ss / 总时长：${museField(ytPkg, '播放位置')}`);
  const ytChapters = ytT < 5 ? '当前 [00:00] 开场；下一章 [00:05] 第二段' : ytT < 10 ? '上一章 [00:00] 开场；当前 [00:05] 第二段；下一章 [00:10] 结尾' : '上一章 [00:05] 第二段；当前 [00:10] 结尾';
  check(museField(ytPkg, '章节') === ytChapters, `章节只放当前位置所在的那一章和前后各一章：${museField(ytPkg, '章节')}`);
  check(ytPkg.includes(`\n简介：\n${CC_MULTI_DESCRIPTION}\n上下文（`) && ((await panel.getByTestId('muse-chapters').textContent()) ?? '') === ytChapters, '简介来自官方 videos.list，放在章节后面；面板里也显示当前章节');
  check(
    ytPkg.includes('上下文（当前位置前后 30 秒的字幕 · YouTube 字幕（') && /\n\[00:00\] (내 이름을 불러줘|Call my name|叫我的名字)\n/.test(ytPkg) && !ytPkg.includes('只有标题'),
    '上下文是位置前后 30 秒的字幕：一句一行，带时间',
  );
  check(ytPkg.includes('\n我的问题：无\n\n') && ytPkg.endsWith(MUSE_RULE) && MUSE_RULE.includes('这是通用知识，不是视频原话'), '还没写问题时"我的问题"是「无」；末尾是改定的那句给 Muse 的指令');
  check(!ytAfter.paused && ytAfter.t > 2.2 && ((await panel.getByTestId('muse-position').textContent()) ?? '').includes('视频没有暂停'), '冻结只是记下位置：视频照常在播');
  check((await ytPlayerKids()) === ytKidsBefore, '没有往播放器里加任何东西');
  check(ytIntroCalls() - ytIntroBefore === 1, `作者、简介和章节走官方 videos.list：这个视频点了 3 次，只查了 ${ytIntroCalls() - ytIntroBefore} 次（查过就记在本机）`);
  // 写问题 → 咨询包不自己变 → 点"生成"才更新；播放位置还是冻结的那一刻
  await museYt.waitForTimeout(1200);
  await panel.getByTestId('muse-question').fill('这句歌词是什么意思？\n第二行');
  await panel.getByTestId('muse-stale').waitFor({ timeout: 5000 });
  check((await panel.getByTestId('muse-package').inputValue()) === ytPkg, '改了问题、还没点"生成"：咨询包不变，并提示它过时了');
  await panel.getByTestId('muse-generate').click();
  await panel.getByTestId('muse-stale').waitFor({ state: 'detached', timeout: 5000 });
  const ytPkg2 = await panel.getByTestId('muse-package').inputValue();
  check(ytPkg2.includes(`\n我的问题：这句歌词是什么意思？\n第二行\n\n${MUSE_RULE}`), '点"生成"：问题按原话写进咨询包');
  check(museField(ytPkg2, '页面链接') === ytLink && museField(ytPkg2, '播放位置') === museField(ytPkg, '播放位置'), '视频又播了一会儿，咨询包里的位置还是冻结的那一刻');
  await panel.screenshot({ path: join(shots, '32-ask-muse.png'), fullPage: true });
  // 复制：先按现在的问题更新，再放进剪贴板（粘贴出来核对）
  await panel.bringToFront();
  await panel.getByTestId('muse-question').fill('改过的问题');
  await panel.getByTestId('muse-copy').click();
  await panel.getByTestId('muse-copied').filter({ hasText: '已复制' }).waitFor({ timeout: 5000 });
  const ytPkg3 = await panel.getByTestId('muse-package').inputValue();
  await panel.getByTestId('muse-question').fill('');
  await panel.getByTestId('muse-question').focus();
  await panel.keyboard.press('Control+V');
  const pasted = (await panel.getByTestId('muse-question').inputValue()).replace(/\r\n/g, '\n');
  check(ytPkg3.includes('\n我的问题：改过的问题\n') && pasted === ytPkg3, '"复制"：先按现在的问题更新咨询包，再把整段放进剪贴板');
  await panel.getByTestId('muse-question').fill('');
  // 打开 muse.ai：只是开一个标签页，什么都不带过去
  const [musePage] = await Promise.all([context.waitForEvent('page'), panel.getByTestId('muse-open').click()]);
  await musePage.waitForLoadState('domcontentloaded');
  const museOpens = requests.filter((r) => r.path.startsWith('/muse'));
  check(
    musePage.url() === `${MOCK}/muse/` && museOpens.length === 1 && museOpens[0].method === 'GET' && Object.keys(museOpens[0].query).length === 0 && !museOpens[0].body,
    '"打开 muse.ai"：只在新标签页里打开它（e2e 里是本机 mock），网址和请求里什么都不带——咨询包要你自己粘贴',
  );
  check(((await musePage.locator('body').textContent()) ?? '').trim() === 'mock muse', '打开的页面里没有被写进任何东西');
  await musePage.close();

  console.log('\n[问 muse：YouTube 取不到字幕——上下文写「无字幕」；广告中位置写「未知」；本机存着自动字幕时用转写]');
  await museYt.goto(`${MOCK}/watch?v=clipFree0001`);
  await scriptReady(museYt);
  // 刚才把侧边栏拿到了前台：先切回这个标签页再等视频（后台标签页不加载媒体）
  await activateTab('clipFree0001');
  await videoReady(museYt, 'video');
  await museYt.evaluate(() => {
    /** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime = 7;
  });
  const plainIntroCalls = () => requests.filter((r) => r.path === '/youtube/v3/videos' && r.query.id === 'clipFree0001' && r.query.part === 'snippet').length;
  const plainMetaBefore = plainIntroCalls();
  const plainPkg = await askMuse();
  check(
    museField(plainPkg, '页面链接') === 'https://www.youtube.com/watch?v=clipFree0001&t=7s' && museField(plainPkg, '播放位置') === '00:07 / 00:20' && museField(plainPkg, '标题') === 'mock watch',
    `暂停着也能冻结：${museField(plainPkg, '页面链接')}，${museField(plainPkg, '播放位置')}`,
  );
  check(plainPkg.includes('\n章节：无\n简介：无\n上下文：无字幕\n') && plainPkg.split('mock watch').length === 2, 'YouTube 实在取不到字幕：上下文写「无字幕」（不把标题再抄一遍）；官方接口查不到的视频，章节和简介写「无」');
  const plainNotes = await museNotes();
  check(
    museField(plainPkg, '作者') === '无' && plainNotes.includes('查不到这个视频') && plainNotes.includes('没有带上字幕：') && plainNotes.includes('先在"字幕"页打开多语字幕或自动字幕'),
    '官方接口查不到的视频：作者写「无」并说明原因；没带上字幕时说明这一次为什么没取到，并保留怎么带上的提示',
  );
  await museYt.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.add('ad-showing'));
  const adPkg = await askMuse();
  check(
    museField(adPkg, '播放位置') === '未知' && museField(adPkg, '页面链接') === 'https://www.youtube.com/watch?v=clipFree0001' && (await museNotes()).includes('正在播广告'),
    '广告期间：播放位置写「未知」、链接不拼时间，并说明是因为在播广告',
  );
  await museYt.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.remove('ad-showing'));
  await panel.evaluate(() =>
    /** @type {any} */ (globalThis).chrome.storage.local.set({
      'subtitles:clipFree0001': {
        videoId: 'clipFree0001',
        asrModel: 'e2e',
        updatedAt: Date.now(),
        cues: [
          { id: 'a', start: 4, end: 6, text: 'hello from the transcript', createdAt: 1 },
          { id: 'b', start: 60, end: 62, text: 'too far away', createdAt: 1 },
        ],
      },
    }),
  );
  const asrPkg = await askMuse();
  check(
    asrPkg.includes('上下文（当前位置前后 30 秒的转写 · TubeMuse 自动字幕（语音识别））：\n[00:04] hello from the transcript\n我的问题：') && !asrPkg.includes('too far away'),
    '本机存着这个视频的自动字幕：上下文用位置前后 30 秒的转写，远处的句子不带',
  );
  await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.remove('subtitles:clipFree0001'));
  const plainMetaCalls = plainIntroCalls() - plainMetaBefore;
  check(plainMetaCalls === 1, `同一个视频冻结了 3 次，官方接口只查了 ${plainMetaCalls} 次（查不到也记在本机，不反复查）`);
  // 有播放器、但这个视频一条字幕轨都没有
  await museYt.goto(`${MOCK}/watch?v=ccNoTrack003`);
  await scriptReady(museYt);
  await videoReady(museYt, 'video');
  await museYt.evaluate(() => {
    /** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime = 3;
  });
  const noTrackPkg = await askMuse();
  const noTrackState = await nativeState(museYt);
  check(
    noTrackPkg.includes('\n上下文：无字幕\n') && (await museNotes()).includes('没有带上字幕：这个视频没有 YouTube 字幕') && noTrackState.calls.length === 0 && timedtextReqs('ccNoTrack003').length === 0,
    '视频本身没有 YouTube 字幕：上下文写「无字幕」并说明，不去动播放器、不发字幕请求',
  );
  await museYt.close();

  console.log('\n[问 muse：小红书——笔记的标题、作者、正文；链接不带 xsec_token；图文笔记位置写「未知」]');
  const museXhs = await museTab(`${MOCK}/xhs/explore/${XHS_V1.id}?xsec_token=${encodeURIComponent(XHS_V1.token)}&xsec_source=pc_feed`);
  await videoReady(museXhs, 'video');
  await museXhs.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.muted = true;
    v.currentTime = 3;
    return v.play();
  });
  // 等小红书脚本自己的按钮、时间放好，再比较页面前后有没有变化
  await museXhs.waitForTimeout(1500);
  const xhsNoteHtml = () => museXhs.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('noteContainer')).outerHTML);
  const xhsNoteBefore = await xhsNoteHtml();
  const xhsPkg = await askMuse();
  check(
    museField(xhsPkg, '平台') === '小红书' && museField(xhsPkg, '页面链接') === `${MOCK}/xhs/explore/${XHS_V1.id}` && !xhsPkg.includes('xsec_token') && !xhsPkg.includes(XHS_V1.token) && !xhsPkg.includes(encodeURIComponent(XHS_V1.token)),
    `小红书的链接只留笔记 ID，xsec_token（令牌）不进咨询包：${museField(xhsPkg, '页面链接')}`,
  );
  check(museField(xhsPkg, '标题') === XHS_V1.title && museField(xhsPkg, '作者') === '李诞小卖部' && /^00:0[3-9] \/ 00:12$/.test(museField(xhsPkg, '播放位置')), `标题、作者、播放位置：${museField(xhsPkg, '标题')} / ${museField(xhsPkg, '作者')} / ${museField(xhsPkg, '播放位置')}`);
  check(xhsPkg.includes(`\n上下文（这篇笔记的正文）：\n${XHS_V1.desc}\n我的问题：`) && !xhsPkg.includes('听了半天') && !xhsPkg.includes('自如签'), '上下文是这篇笔记的正文（换行、#话题都在），评论不读');
  check(!xhsPkg.includes('&t=') && !/[?&]t=\d/.test(museField(xhsPkg, '页面链接')), '别的平台不在链接上拼时间');
  check(xhsPkg.includes('\n章节：无\n简介：无\n上下文（这篇笔记的正文）：\n'), '所有平台同一组字段：YouTube 以外"章节""简介"写「无」');
  check((await museNotes()).includes('没有带 xsec_token'), '面板里说明：小红书链接没带 xsec_token，从外面打开可能要登录');
  check((await xhsNoteHtml()) === xhsNoteBefore && (await nativeClicks(museXhs)) === 0 && !(await museXhs.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).paused)), '读笔记没有改动页面、没有点任何东西，视频照常在播');
  await museXhs.goto(`${MOCK}/xhs/explore/${XHS_N1.id}`);
  await scriptReady(museXhs);
  await museXhs.locator('#detail-desc').waitFor();
  const xhsTextPkg = await askMuse();
  check(
    museField(xhsTextPkg, '播放位置') === '未知' && xhsTextPkg.includes(`\n上下文（这篇笔记的正文）：\n${XHS_N1.desc}\n`) && museField(xhsTextPkg, '标题') === XHS_N1.title && (await museNotes()).includes('没找到视频'),
    '图文笔记也能问：播放位置写「未知」并说明，正文照常带上',
  );
  await museXhs.close();

  console.log('\n[问 muse：X——首页信息流认的是开着声音在播的那条帖子；帖子页的作者和正文来自页面标题]');
  const museX = await museTab(`${MOCK}/xpage/home`);
  await museX.waitForFunction(() => [...document.querySelectorAll('video')].every((v) => v.readyState >= 2), null, { timeout: 30000 });
  check(await askMuseFails('没有正在播放、开着声音的视频'), '首页信息流上没有开着声音在播的视频：说明要先打开声音，不生成咨询包');
  await museX.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('#feed-post video'));
    v.currentTime = 4;
    return v.play();
  });
  const xAppHtmlNow = () => museX.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('app')).outerHTML);
  const xFeedBefore = await xAppHtmlNow();
  const xFeedPkg = await askMuse();
  check(
    museField(xFeedPkg, '平台') === 'X' && museField(xFeedPkg, '页面链接') === `${MOCK}/xpage/${X_FEED_POST.user}/status/${X_FEED_POST.id}` && museField(xFeedPkg, '标题') === '无' && museField(xFeedPkg, '作者') === 'Feed 作者',
    `信息流里：链接是这条帖子的（不是首页），帖子没有标题写「无」，作者是帖子的作者：${museField(xFeedPkg, '页面链接')}`,
  );
  check(/^00:0[4-9] \/ 00:12$/.test(museField(xFeedPkg, '播放位置')), `播放位置：${museField(xFeedPkg, '播放位置')}`);
  check(
    xFeedPkg.includes('\n上下文（这条帖子的正文）：\nFable made this entire movie 🎬 in pure code.\n\nVoices, graphics, everything. @claudeai\n我的问题：') && !xFeedPkg.includes('t.co') && !xFeedPkg.includes('被引用帖子的正文') && !xFeedPkg.includes('广告的正文'),
    '上下文是这条帖子的正文（表情、换行保留，t.co 短链去掉）；被引用的帖子、别的帖子不读',
  );
  check((await xAppHtmlNow()) === xFeedBefore && (await nativeClicks(museX)) === 0, '没有改动页面，没有点任何东西');
  await museX.evaluate(() => /** @type {any} */ (window).__openPost());
  await videoReady(museX, '#main video');
  const xPostPkg = await askMuse();
  check(
    museField(xPostPkg, '页面链接') === `${MOCK}/xpage/${X_POST.user}/status/${X_POST.id}` && !xPostPkg.includes('sharerToken') && museField(xPostPkg, '作者') === 'Ayo O' && /^00:0\d \/ 00:20$/.test(museField(xPostPkg, '播放位置')),
    `帖子页：链接去掉分享参数，作者来自页面标题：${museField(xPostPkg, '页面链接')} / ${museField(xPostPkg, '作者')}`,
  );
  check(xPostPkg.includes('\n上下文（这条帖子的正文）：\nI reverse engineered tiktok\n我的问题：'), '帖子页：正文来自页面标题');
  await museX.goto(`${MOCK}/xpage/${X_TEXT_POST.user}/status/${X_TEXT_POST.id}`);
  await scriptReady(museX);
  await museX.locator('[data-testid="tweetText"]').waitFor();
  const xTextPkg = await askMuse();
  check(museField(xTextPkg, '播放位置') === '未知' && xTextPkg.includes('\n上下文（这条帖子的正文）：\n只有文字\n') && (await museNotes()).includes('没找到视频'), '没有视频的帖子也能问：播放位置写「未知」并说明');
  await museX.close();

  console.log('\n[问 muse：Instagram——首页信息流里开着声音在播的那条帖子]');
  const museIg = await museTab(`${MOCK}/igpage/`);
  await museIg.waitForFunction(() => [...document.querySelectorAll('video')].every((v) => v.readyState >= 2), null, { timeout: 30000 });
  await museIg.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('#ig-post video'));
    v.currentTime = 2;
    v.muted = false;
    v.volume = 0.5;
    return v.play();
  });
  const museIgHtmlBefore = await museIg.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('app')).outerHTML);
  const igPkg = await askMuse();
  check(
    museField(igPkg, '平台') === 'Instagram' && museField(igPkg, '页面链接') === `${MOCK}/igpage/p/${IG_FEED_POST.code}/` && museField(igPkg, '标题') === '无' && museField(igPkg, '作者') === IG_FEED_POST.user && /^00:0[2-5] \/ 00:06$/.test(museField(igPkg, '播放位置')),
    `链接是这条帖子的，作者是用户名：${museField(igPkg, '页面链接')} / ${museField(igPkg, '作者')} / ${museField(igPkg, '播放位置')}`,
  );
  check(igPkg.includes('\n上下文（这条帖子的正文）：\n《#地球娛樂室》 #兔瓏 來台灣啦🐰🍡\n我的问题：') && !igPkg.includes('别人的评论') && !igPkg.includes('广告的正文') && !igPkg.includes('更多'), '上下文是这条帖子露出来的正文；别的帖子、评论和"更多"不读');
  check((await museIg.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('app')).outerHTML)) === museIgHtmlBefore && (await nativeClicks(museIg)) === 0, '没有改动页面，没有点任何东西（不点"更多"）');
  await museIg.close();

  console.log('\n[问 muse：抖音——点开的这条视频的作者和描述；划到下一条再问就是下一条]');
  const museDy = await museTab(`${MOCK}/douyin/jingxuan`);
  check(await askMuseFails('没有点开的抖音视频'), '精选页上还没点开视频：说明要先点开一条');
  await museDy.evaluate(() => /** @type {any} */ (window).__openVideo());
  await videoReady(museDy, '[data-e2e="feed-active-video"] video');
  const dyHtmlBefore = await museDy.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('app')).outerHTML);
  const dyPkg = await askMuse();
  check(
    museField(dyPkg, '平台') === '抖音' && museField(dyPkg, '页面链接') === `${MOCK}/douyin/jingxuan?modal_id=${DOUYIN_VIDEO.id}` && museField(dyPkg, '标题') === '无' && museField(dyPkg, '作者') === '云汉AI创投' && /^00:0\d \/ 00:20$/.test(museField(dyPkg, '播放位置')),
    `链接只留 modal_id，作者是昵称（去掉 @）：${museField(dyPkg, '页面链接')} / ${museField(dyPkg, '作者')} / ${museField(dyPkg, '播放位置')}`,
  );
  check(dyPkg.includes('\n上下文（这条视频的描述）：\n第13集：为什么要“搞死”黄仁勋？#AI创业 #黄仁勋\n我的问题：') && !dyPkg.includes('弹幕') && !dyPkg.includes('展开') && !dyPkg.includes('冬天去哪里看雪'), '上下文是这条视频的描述；弹幕、"展开"按钮和旁边预先加载的下一条不读');
  check((await museDy.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('app')).outerHTML)) === dyHtmlBefore && (await nativeClicks(museDy)) === 0, '没有改动页面，没有点任何东西（不点"展开"）');
  await museDy.evaluate(() => /** @type {any} */ (window).__nextVideo());
  await videoReady(museDy, '[data-e2e="feed-active-video"] video');
  const dyNextPkg = await askMuse();
  check(
    museField(dyNextPkg, '页面链接') === `${MOCK}/douyin/jingxuan?modal_id=${DOUYIN_NEXT.id}` && museField(dyNextPkg, '作者') === '旅行的小周' && dyNextPkg.includes('\n冬天去哪里看雪 #旅行\n') && / \/ 00:30$/.test(museField(dyNextPkg, '播放位置')),
    '划到下一条后再点：咨询包换成下一条的（页面标题没更新也不会张冠李戴）',
  );
  await museDy.close();

  console.log('\n[问 muse：酷播——只有页面标题和播放位置；片头广告时位置写「未知」]');
  const museKubb = await museTab(`${MOCK}/kubb/home`);
  check(await askMuseFails('不是播放页'), '酷播首页：说明要先点开一部影片');
  await museKubb.evaluate(() => /** @type {any} */ (window).__openMovie());
  await videoReady(museKubb, '#video_player');
  const kubbHtmlBefore = await museKubb.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('.root-container')).outerHTML.replace(/ src="blob:[^"]*"/, ''));
  const kubbPkg = await askMuse();
  check(
    museField(kubbPkg, '平台') === '酷播' && museField(kubbPkg, '页面链接') === `${MOCK}/kubb/play/${KUBB_MOVIE.id}` && museField(kubbPkg, '标题') === KUBB_MOVIE.title && museField(kubbPkg, '作者') === '无' && /^00:0\d \/ 00:20$/.test(museField(kubbPkg, '播放位置')),
    `标题来自页面标题，作者没有就写「无」：${museField(kubbPkg, '标题')} / ${museField(kubbPkg, '作者')} / ${museField(kubbPkg, '播放位置')}`,
  );
  check(
    kubbPkg.includes('\n上下文：只有上面的标题（没有字幕 / 转写，也没有正文 / 描述）\n') && kubbPkg.split(KUBB_MOVIE.title).length === 2 && !kubbPkg.includes('弹幕弹幕'),
    '上下文只有标题时不把标题再抄一遍（标题在咨询包里只出现一次）；弹幕不读',
  );
  check((await museKubb.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('.root-container')).outerHTML.replace(/ src="blob:[^"]*"/, ''))) === kubbHtmlBefore && (await nativeClicks(museKubb)) === 0, '没有改动页面，没有点任何东西');
  await museKubb.evaluate(() => /** @type {any} */ (window).__playAd());
  await museKubb.waitForFunction((seconds) => Math.round(/** @type {HTMLVideoElement} */ (document.querySelector('#video_player')).duration) === seconds, KUBB_AD_SECONDS, { timeout: 15000 });
  const kubbAdPkg = await askMuse();
  check(museField(kubbAdPkg, '播放位置') === '未知' && (await museNotes()).includes('正在播广告'), '酷播认得出的片头广告期间：播放位置写「未知」并说明');
  await museKubb.close();

  console.log('\n[问 muse：B 站——只有页面标题和播放位置；链接去掉语言前缀和来源参数]');
  const museBili = await museTab(`${MOCK}/bili/`);
  check(await askMuseFails('没有 B 站的播放器'), 'B 站首页：说明要先打开一个播放页');
  await museBili.evaluate(() => /** @type {any} */ (window).__nextEpisode());
  await videoReady(museBili, '#bilibili-player video');
  const biliHtmlBefore = await museBili.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('app')).outerHTML.replace(/ src="blob:[^"]*"/, ''));
  const biliPkg = await askMuse();
  check(
    museField(biliPkg, '平台') === 'B 站' && museField(biliPkg, '页面链接') === `${MOCK}/bili/bangumi/play/${BILI_EPISODE.id}` && museField(biliPkg, '标题') === BILI_EPISODE.title && museField(biliPkg, '作者') === '无' && /^00:0\d \/ 00:25$/.test(museField(biliPkg, '播放位置')),
    `标题来自页面标题，UP 主不读（写「无」）：${museField(biliPkg, '页面链接')} / ${museField(biliPkg, '标题')} / ${museField(biliPkg, '播放位置')}`,
  );
  check(biliPkg.includes('\n上下文：只有上面的标题（没有字幕 / 转写，也没有正文 / 描述）\n') && !biliPkg.includes('弹幕弹幕') && !biliPkg.includes('推荐视频的封面'), '弹幕、推荐列表不读');
  check((await museBili.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('app')).outerHTML.replace(/ src="blob:[^"]*"/, ''))) === biliHtmlBefore && (await nativeClicks(museBili)) === 0, '没有改动页面，没有点任何东西');
  await museBili.close();

  console.log('\n[问 muse：红线]');
  const museReqs = requests.slice(museReqStart);
  check(llmCount() === museLlmStart && museReqs.every((r) => !r.path.startsWith('/openai') && !r.path.startsWith('/x/')), '全程没有调大模型（也没有语音转写、没有读 X）：不产生任何费用');
  const musePagePaths = ['/watch', '/media/', '/api/timedtext', '/xhs/', '/xpage/', '/igpage/', '/douyin/', '/kubb/', '/bili/', '/muse/', '/favicon.ico'];
  const fromPages = museReqs.filter((r) => String(r.headers.referer ?? '').startsWith(MOCK));
  const pageLeaks = fromPages.filter((r) => r.method !== 'GET' || !musePagePaths.some((p) => r.path === p || r.path.startsWith(p)));
  const museTt = fromPages.filter((r) => r.path === '/api/timedtext');
  check(
    pageLeaks.length === 0 && museTt.every((r) => String(r.headers.referer ?? '').includes('/watch?v=')),
    `除了在 YouTube 播放页上取字幕（同源的 /api/timedtext，${museTt.length} 次，含播放器自己发的），注入各个网站的脚本没有为「问 muse」发任何请求${pageLeaks.length ? `：${pageLeaks.map((r) => `${r.method} ${r.path}`).join(', ')}` : ''}`,
  );
  const museLeaks = museReqs.filter((r) => /我的问题|上下文（|这句歌词|改过的问题/.test(JSON.stringify(r.query) + String(r.body ?? '')));
  check(museLeaks.length === 0, '咨询包和你的问题没有发往任何地方（只在侧边栏和剪贴板里）');
  const museManifest = await (context.serviceWorkers()[0] ?? sw).evaluate(() => /** @type {any} */ (globalThis).chrome.runtime.getManifest());
  check(
    JSON.stringify([...museManifest.permissions].sort()) === JSON.stringify(['alarms', 'identity', 'sidePanel', 'storage', 'unlimitedStorage']) &&
      !JSON.stringify(museManifest.host_permissions).includes('muse') &&
      !JSON.stringify(museManifest.content_scripts).includes('muse') &&
      !museManifest.content_security_policy.extension_pages.includes('muse'),
    `「问 muse」没有新增权限和域名：${museManifest.permissions.join(', ')}`,
  );
  check(![ytPkg3, plainPkg, xhsPkg, xFeedPkg, xPostPkg, igPkg, dyPkg, kubbPkg, biliPkg].some((p) => p.includes(FAKE_KEY) || p.includes('e2e-fake-token') || p.includes(E2E_CLIENT_SECRET) || p.includes(X_TOKEN)), '咨询包里没有任何 Key / 令牌');
  await panel.bringToFront();
  await panel.getByTestId('muse-close').click();
  check((await musePanel.count()) === 0, '点 × 收起面板');
}
