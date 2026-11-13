// @ts-check
// 小宇宙（DECISIONS §72）：在仿小宇宙单集页上——默认不出字幕、开始后读音频段 → 切句 → 转写 → 校对 / 翻译 → 叠在播放器上方（时间对得上）；
// 显示方式、点一句跳过去、整集生成与下载、片段快照（进度条标记、卡片、导出图片 / 音频、复制链接、试听）、收藏、收听记录；
// 可变码率 mp3 跳转后，字幕按实际在放的声音对齐；以及这一页的红线（只读小宇宙 CDN、不带 Cookie、不点页面按钮、不改页面元素）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, MOCK, shots } from '../harness.mjs';
import { XYZ_EP, XYZ_VBR } from '../xyz-pages.mjs';

const OPENAI_KEY = 'e2e-openai-test-key-not-real';

/** 这一段音（第 k 段：0.5 + 3k 秒起，1.8 秒长；600 秒的那集每 60 段频率循环一次） */
const toneStart = (/** @type {number} */ k) => 0.5 + 3 * k;

/** @param {import('../harness.mjs').Harness} t */
export async function xyz(t) {
  const { context, requests, consoleErrors, xyzImages } = t;
  const panel = await t.openPanel();
  await fetch(`${MOCK}/e2e/transcribe-mode?mode=ok`);
  await panel.evaluate(async (key) => {
    const c = /** @type {any} */ (globalThis).chrome;
    const { secrets } = await c.storage.local.get('secrets');
    await c.storage.local.set({ secrets: { ...(secrets ?? {}), openaiApiKey: secrets?.openaiApiKey ?? key } });
    await c.storage.local.remove('subtitleLedger');
    // 边听边转写只提前 30 秒：92 秒的这一集不会一开始就全部生成完，"生成整集字幕"才有事可做
    const { settings } = await c.storage.local.get('settings');
    await c.storage.local.set({ settings: { ...settings, xyz: { ...(settings?.xyz ?? {}), lookaheadSec: 30 } } });
  }, OPENAI_KEY);

  const extMedia = () => requests.filter((r) => r.path.startsWith('/xyzmedia/') && !r.headers.referer);
  const transcribes = () => requests.filter((r) => r.path === '/openai/v1/audio/transcriptions' && r.body.includes('测试节目串门儿'));
  const polishes = () => requests.filter((r) => r.path.startsWith('/anthropic') && r.body.includes('播客字幕的校对兼翻译'));

  console.log('\n[小宇宙：不在小宇宙时说明怎么开始]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '小宇宙' }).click();
  await panel.getByTestId('xyz-not-episode').waitFor({ timeout: 5000 });
  check(((await panel.getByTestId('xyz-not-episode').textContent()) ?? '').includes('小宇宙'), '当前标签页不是小宇宙：说明怎么开始');

  console.log('\n[小宇宙：单集页 → 侧边栏读到这一集；字幕默认关闭，不读音频、不花钱]');
  const [page] = await Promise.all([context.waitForEvent('page'), panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}/xyz/episode/${XYZ_EP.eid}`)]);
  page.on('pageerror', (e) => consoleErrors.push(`xyz pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`xyz: ${m.text()}`));
  await page.waitForLoadState('load');
  const pageHtmlBefore = await page.evaluate(() => document.getElementById('__next')?.outerHTML.replace(/\s*style="[^"]*"/g, '').replace(/>\d\d:\d\d</g, '><') ?? '');
  await page.click('#pp');
  await page.waitForFunction(() => !(/** @type {HTMLAudioElement} */ (document.querySelector('audio')).paused), null, { timeout: 10000 });
  await panel.getByTestId('xyz-title').waitFor({ timeout: 8000 });
  check(((await panel.getByTestId('xyz-title').textContent()) ?? '') === XYZ_EP.title, `读到单集标题：${await panel.getByTestId('xyz-title').textContent()}`);
  check(((await panel.getByTestId('xyz-episode').textContent()) ?? '').includes(XYZ_EP.podcast), '读到节目名');
  check(((await panel.getByTestId('xyz-status').textContent()) ?? '').includes('未开启'), '字幕默认关闭，说明怎么开启');
  await page.waitForTimeout(1500);
  check(extMedia().length === 0 && transcribes().length === 0, '没开启：扩展一次都没读音频、没转写');
  check(!(await page.evaluate(() => !!document.querySelector('[data-tubemuse="xyz"]'))), '没开启：页面上没有字幕层');

  console.log('\n[小宇宙：开始字幕 → 读音频段 → 转写 → 校对 / 翻译 → 播放器上方的双语字幕，时间对得上]');
  await panel.getByTestId('xyz-toggle').click();
  const zh = page.locator('[data-tubemuse="xyz"] .zh');
  const en = page.locator('[data-tubemuse="xyz"] .en');
  await zh.filter({ hasText: '（校）' }).waitFor({ timeout: 20000 });
  // 屏幕上的字幕对应现在正在放的那一段音（页面时间就是真实时间：m4a）
  /** 读屏幕上的那句与当时的播放位置 */
  const sample = async () => {
    const r = await page.evaluate(() => {
      const root = document.querySelector('[data-tubemuse="xyz"]')?.shadowRoot;
      return { zh: root?.querySelector('.zh')?.textContent ?? '', en: root?.querySelector('.en')?.textContent ?? '', t: /** @type {HTMLAudioElement} */ (document.querySelector('audio')).currentTime };
    });
    const k = Number(/第(\d+)段/.exec(r.zh)?.[1] ?? NaN);
    return { ...r, k };
  };
  const aligned = [];
  /** @type {string[]} */
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const s = await sample();
    // 第 k 段从 toneStart(k) − 0.2 秒（句首留白）显示到结束后 0.6 秒
    if (!Number.isNaN(s.k)) {
      aligned.push(s.t >= toneStart(s.k) - 0.35 && s.t <= toneStart(s.k) + 1.8 + 0.7);
      seen.push(`${s.t.toFixed(1)}s→第${s.k}段`);
    }
    await page.waitForTimeout(900);
  }
  check(aligned.length >= 2 && aligned.every(Boolean), `字幕与正在放的声音对得上（${seen.join('，')}）`);
  const s0 = await sample();
  check(s0.en === '' || /^This is segment \d+$/.test(s0.en), `第二行是英文：${s0.en}`);
  const media = extMedia();
  check(media.length >= 2 && media.every((r) => /^bytes=\d+-\d+$/.test(String(r.headers.range)) && !r.headers.cookie && !r.headers.referer), `扩展分段读这一集的音频（${media.length} 次），不带 Cookie、不带 Referer`);
  const tr = transcribes();
  check(tr.length >= 3 && tr.length < 25 && tr.every((r) => r.body.includes('测试节目串门儿：') && r.headers.authorization === `Bearer ${OPENAI_KEY}`), `转写一句一句发往 OpenAI（${tr.length} 句，只到播放位置之后 30 秒），提示词带节目名与标题`);
  const pl = polishes();
  check(pl.length >= 1 && pl.every((r) => r.body.includes('Lance Martin') && !r.body.includes(XYZ_EP.eid) && !r.body.includes('/xyzmedia/') && !r.body.includes('评论区')), '校对 / 翻译只发节目名、标题、简介摘录与转写文字：不发单集 ID、音频地址、评论');
  await page.screenshot({ path: join(shots, '60-xyz-captions.png') });

  console.log('\n[小宇宙：页面上显示什么（中文 / 英文 / 不显示）]');
  await panel.getByTestId('xyz-display-zh').click();
  await page.waitForTimeout(800);
  check((await en.textContent()) === '' && ((await zh.textContent()) ?? '').length > 0, '只看中文：第二行不显示');
  await panel.getByTestId('xyz-display-off').click();
  await page.waitForTimeout(800);
  check(await page.evaluate(() => !!document.querySelector('[data-tubemuse="xyz"]')?.shadowRoot?.querySelector('.cap')?.hasAttribute('hidden')), '不在页面上显示：字幕层收起');
  await panel.getByTestId('xyz-display-bilingual').click();

  console.log('\n[小宇宙：点一句字幕跳过去；整集生成；下载]');
  await panel.getByTestId('xyz-cue-list').locator('li').nth(5).click();
  await page.waitForFunction(() => Math.abs(/** @type {HTMLAudioElement} */ (document.querySelector('audio')).currentTime - 15.27) < 1.5, null, { timeout: 5000 });
  check(true, '点第 6 句：页面上的播放位置跳到这一句（约 15 秒）');
  await panel.getByTestId('xyz-whole').click();
  const estimate = (await panel.getByTestId('xyz-whole-estimate').textContent()) ?? '';
  check(/预计约 \$\d/.test(estimate), `生成整集前先给预计花费：${estimate}`);
  await panel.getByTestId('xyz-whole-go').click();
  await panel.getByTestId('xyz-whole').filter({ hasText: '整集字幕已生成' }).waitFor({ timeout: 30000 });
  const stored = /** @type {any} */ (await panel.evaluate((eid) => /** @type {any} */ (globalThis).chrome.storage.local.get(`xyzTranscript:${eid}`), XYZ_EP.eid))[`xyzTranscript:${XYZ_EP.eid}`];
  const ks = /** @type {any[]} */ (stored.cues).map((c) => Number(/第(\d+)段/.exec(c.raw)?.[1]));
  const offBy = /** @type {any[]} */ (stored.cues).map((c) => c.start - toneStart(Number(/第(\d+)段/.exec(c.raw)?.[1])));
  const timed = offBy.every((d) => d > -0.4 && d < 0.15);
  check(ks.length === 30 && ks.every((k, i) => k === i), `整集 30 段都生成了，按顺序（${ks.length} 句）`);
  check(timed, `每句的开始时间都对得上那段音（句首最多留白 0.4 秒；实际 ${Math.min(...offBy).toFixed(2)}～${Math.max(...offBy).toFixed(2)} 秒）`);
  check(/** @type {any[]} */ (stored.cues).every((c) => c.polished && c.zh.endsWith('（校）') && c.en.startsWith('This is segment')), '每句都校对过、有英文');
  const transcribedAll = transcribes().length;
  // 无头浏览器的下载事件里，中文文件名会变成 "download"（真实 Chrome 没这个问题）：记下扩展交给浏览器的文件名
  await panel.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__dl = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) w.__dl.push(this.download);
      return click.call(this);
    };
  });
  const lastDl = async () => /** @type {string} */ (await panel.evaluate(() => /** @type {any} */ (window).__dl.at(-1) ?? ''));
  await panel.getByTestId('xyz-format').selectOption('srt-bilingual');
  const [dl] = await Promise.all([panel.waitForEvent('download'), panel.getByTestId('xyz-download').click()]);
  const srt = readFileSync(/** @type {string} */ (await dl.path()), 'utf8');
  const srtName = await lastDl();
  check(srtName === `${XYZ_EP.title.replace(/[:：]/g, (c) => (c === ':' ? ' ' : c))}.srt` && /^1\n00:00:00,\d{3} --> 00:00:0\d,\d{3}\n这是第0段音频的内容（校）\nThis is segment 0\n/.test(srt), `下载 SRT 中英双语：${srtName}`);
  const [dl2] = await Promise.all([panel.waitForEvent('download'), (await panel.getByTestId('xyz-format').selectOption('md'), panel.getByTestId('xyz-download').click())]);
  const md = readFileSync(/** @type {string} */ (await dl2.path()), 'utf8');
  check(md.startsWith(`# ${XYZ_EP.title}`) && md.includes(`https://www.xiaoyuzhoufm.com/episode/${XYZ_EP.eid}`), 'Markdown 文稿带标题与单集链接');

  console.log('\n[小宇宙：片段快照（进度条上的标记、卡片、导出图片 / 音频、复制链接、试听）]');
  await panel.getByTestId('xyz-sub-snap').click();
  await panel.getByTestId('xyz-snap-label').waitFor({ timeout: 5000 });
  check(/^\d\d:\d\d – \d\d:\d\d \(\d+s\)$/.test((await panel.getByTestId('xyz-snap-label').textContent()) ?? ''), `默认选好当前这句：${await panel.getByTestId('xyz-snap-label').textContent()}`);
  await panel.getByTestId('xyz-snap-start').fill('00:03');
  await panel.getByTestId('xyz-snap-end').fill('00:09');
  await panel.getByTestId('xyz-card-preview').waitFor({ timeout: 8000 });
  check(((await panel.getByTestId('xyz-snap-label').textContent()) ?? '') === '00:03 – 00:09 (6s)', '片段标签：00:03 – 00:09 (6s)');
  check(((await panel.getByTestId('xyz-snap-zh').inputValue()) ?? '').includes('这是第1段音频的内容（校）这是第2段'), '卡片上的中文是这一段的字幕');
  const marks = await page.evaluate(() => {
    const root = document.querySelector('[data-tubemuse="xyz"]')?.shadowRoot;
    return { hidden: root?.querySelector('.marks')?.hasAttribute('hidden'), tags: [...(root?.querySelectorAll('.tag') ?? [])].map((x) => x.textContent) };
  });
  check(marks.hidden === false && JSON.stringify(marks.tags) === '["00:03","00:09"]', `页面进度条上标出片段起止：${marks.tags.join(' – ')}`);
  await page.screenshot({ path: join(shots, '61-xyz-marks.png') });
  // 卡片：等波形读回来再导出
  await panel.waitForTimeout(1500);
  const [img] = await Promise.all([panel.waitForEvent('download'), panel.getByTestId('xyz-export-image').click()]);
  const png = readFileSync(/** @type {string} */ (await img.path()));
  const imgName = await lastDl();
  check(imgName.endsWith('_00-03_00-09.png') && png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 1080, `导出图片：1080 宽的 PNG（${imgName}，${Math.round(png.length / 1024)} KB）`);
  await panel.getByTestId('xyz-snap-msg').waitFor({ timeout: 8000 });
  check(((await panel.getByTestId('xyz-snap-msg').textContent()) ?? '').includes('下载文件夹'), `说明存到了哪里：${await panel.getByTestId('xyz-snap-msg').textContent()}`);
  check(requests.some((r) => r.path.startsWith('/xyzimg/')) && xyzImages.length === 0, '卡片上的封面从（仿）小宇宙图片 CDN 加载，测试中没有出网');
  await panel.screenshot({ path: join(shots, '62-xyz-snapshot.png'), fullPage: true });
  // 无头浏览器里读不了系统剪贴板：把写入接下来看写了什么
  await panel.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__copied = [];
    navigator.clipboard.writeText = async (/** @type {string} */ text) => void w.__copied.push(text);
  });
  await panel.getByTestId('xyz-copy-link').click();
  await panel.getByTestId('xyz-snap-msg').filter({ hasText: '链接已复制' }).waitFor({ timeout: 5000 });
  const clip = /** @type {string} */ (await panel.evaluate(() => /** @type {any} */ (window).__copied[0] ?? ''));
  check(clip.includes('00:03–00:09') && clip.includes(`https://www.xiaoyuzhoufm.com/episode/${XYZ_EP.eid}`) && !clip.includes('t='), `复制链接：单集链接 + 片段起止，不自创时间参数`);
  const [wav] = await Promise.all([panel.waitForEvent('download'), panel.getByTestId('xyz-export-audio').click()]);
  const wb = readFileSync(/** @type {string} */ (await wav.path()));
  const wavSec = wb.readUInt32LE(40) / (wb.readUInt32LE(28));
  check((await lastDl()).endsWith('_00-03_00-09.wav') && wb.subarray(0, 4).toString() === 'RIFF' && Math.abs(wavSec - 6) < 0.1, `导出音频片段：WAV，${wavSec.toFixed(2)} 秒`);
  const snaps = /** @type {any} */ (await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('xyzSnapshots'))).xyzSnapshots;
  check(snaps?.length === 1 && snaps[0].start === 3 && snaps[0].end === 9, '"我的快照"记下这一条（只有元数据）');
  await panel.getByTestId('xyz-listen').click();
  await page.waitForFunction(() => /** @type {HTMLAudioElement} */ (document.querySelector('audio')).paused, null, { timeout: 12000 });
  const stopAt = await page.evaluate(() => /** @type {HTMLAudioElement} */ (document.querySelector('audio')).currentTime);
  check(stopAt >= 8.9 && stopAt < 10, `试听：跳到起点播放，到终点自动暂停（停在 ${stopAt.toFixed(2)} 秒）`);
  await panel.getByTestId('xyz-sub-captions').click();
  await page.waitForTimeout(500);
  check(await page.evaluate(() => !!document.querySelector('[data-tubemuse="xyz"]')?.shadowRoot?.querySelector('.marks')?.hasAttribute('hidden')), '离开快照页：进度条上的标记去掉');

  console.log('\n[小宇宙：收藏单集与节目、打标签]');
  await panel.getByTestId('xyz-save-episode').click();
  await panel.getByTestId('xyz-save-podcast').click();
  await panel.getByTestId('xyz-sub-saved').click();
  await panel.getByTestId('xyz-saved-item').nth(1).waitFor({ timeout: 5000 });
  const kinds = await panel.getByTestId('xyz-saved-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')).sort());
  check(JSON.stringify(kinds) === '["episode","podcast"]', '收藏里有这一集和这个节目');
  await panel.getByTestId('xyz-saved-item').first().getByLabel('加标签').fill('AI');
  await panel.getByTestId('xyz-saved-item').first().getByLabel('加标签').press('Enter');
  await panel.getByTestId('xyz-tag-filter').waitFor({ timeout: 5000 });
  const savedState = /** @type {any} */ (await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('xyzSaved'))).xyzSaved;
  check(Object.values(savedState.podcasts).length === 1 && [...Object.values(savedState.episodes), ...Object.values(savedState.podcasts)].some((x) => /** @type {any} */ (x).tags.includes('AI')), '收藏与标签存在本机');

  console.log('\n[小宇宙：收听记录（只计真正在播放的时间）]');
  await page.evaluate(() => /** @type {HTMLAudioElement} */ (document.querySelector('audio')).play());
  await page.waitForTimeout(16_500);
  await panel.getByTestId('xyz-sub-listens').click();
  await panel.getByTestId('xyz-listen-item').first().waitFor({ timeout: 8000 });
  const listen = (await panel.getByTestId('xyz-listen-item').first().textContent()) ?? '';
  check(listen.includes(XYZ_EP.title) && /听了 \d+ 秒/.test(listen), `收听记录：${listen.slice(0, 80)}`);

  console.log('\n[小宇宙：页面红线]');
  const clicks = await page.evaluate(() => /** @type {any} */ (window).__nativeClicks);
  check(clicks === 1, `TubeMuse 没有点过小宇宙页面上的任何东西（页面上只有测试自己点的 ${clicks} 次）`);
  const pageHtmlAfter = await page.evaluate(() => document.getElementById('__next')?.outerHTML.replace(/\s*style="[^"]*"/g, '').replace(/>\d\d:\d\d</g, '><') ?? '');
  const norm = (/** @type {string} */ h) => h.replace(/aria-label="(暂停|播放)"/g, '');
  const a1 = norm(pageHtmlBefore);
  const a2 = norm(pageHtmlAfter);
  let at = 0;
  while (at < a1.length && a1[at] === a2[at]) at++;
  check(a1 === a2, `小宇宙自己的元素一个没改（字幕层是挂在页面最外层的单独元素）${a1 === a2 ? '' : `：第 ${at} 个字符起不同：${a1.slice(at - 40, at + 60)} ⇢ ${a2.slice(at - 40, at + 60)}`}`);
  check(transcribes().length === transcribedAll, '整集生成完之后再听、做快照，不再转写（不重复花钱）');
  await page.close();

  console.log('\n[小宇宙：改用浏览器识别（免费）→ 读到的声音按 1 倍速交给浏览器的语音识别，不发音频、不花转写费]');
  await panel.evaluate(async (eid) => {
    const c = /** @type {any} */ (globalThis).chrome;
    await c.storage.local.remove(`xyzTranscript:${eid}`);
    const { secrets } = await c.storage.local.get('secrets');
    // 去掉 OpenAI Key：侧边栏给出"改用浏览器识别"的一键入口
    await c.storage.local.set({ secrets: { ...secrets, openaiApiKey: undefined } });
  }, XYZ_EP.eid);
  const [bp] = await Promise.all([context.waitForEvent('page'), panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}/xyz/episode/${XYZ_EP.eid}`)]);
  bp.on('pageerror', (e) => consoleErrors.push(`xyz browser pageerror: ${e.message}`));
  await bp.waitForLoadState('load');
  await bp.click('#pp');
  await panel.getByTestId('xyz-sub-captions').click();
  await panel.getByTestId('xyz-need-openai').waitFor({ timeout: 8000 });
  await panel.getByTestId('xyz-use-browser').click();
  await panel.getByTestId('xyz-toggle').click();
  const transcribedBefore = transcribes().length;
  await bp.locator('[data-tubemuse="xyz"] .zh').filter({ hasText: '我说到哪里了' }).waitFor({ timeout: 20000 });
  check(true, `浏览器识别出的字显示在页面上：${await bp.locator('[data-tubemuse="xyz"] .zh').textContent()}`);
  await bp.waitForTimeout(3000);
  const browserCues = /** @type {any} */ (await panel.evaluate((eid) => /** @type {any} */ (globalThis).chrome.storage.local.get(`xyzTranscript:${eid}`), XYZ_EP.eid))[`xyzTranscript:${XYZ_EP.eid}`];
  check(browserCues?.asrModel === 'browser-speech' && browserCues.cues.length > 0, `识别出的行存成字幕（${browserCues?.cues.length ?? 0} 行，转写方式 browser-speech）`);
  check(transcribes().length === transcribedBefore, '浏览器识别：一个音频都没发往 OpenAI');
  await panel.getByTestId('xyz-toggle').click();
  await panel.evaluate(async (key) => {
    const c = /** @type {any} */ (globalThis).chrome;
    const { secrets, settings } = await c.storage.local.get(['secrets', 'settings']);
    await c.storage.local.set({ secrets: { ...secrets, openaiApiKey: key }, settings: { ...settings, xyz: { ...settings.xyz, asrEngine: 'openai' } } });
  }, OPENAI_KEY);
  await bp.close();

  console.log('\n[小宇宙：可变码率 mp3——先建时间索引；跳转后字幕按实际在放的声音对齐]');
  const [vbr] = await Promise.all([context.waitForEvent('page'), panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}/xyz/episode/${XYZ_VBR.eid}`)]);
  vbr.on('pageerror', (e) => consoleErrors.push(`xyz vbr pageerror: ${e.message}`));
  await vbr.waitForLoadState('load');
  await panel.getByTestId('xyz-sub-captions').click();
  await panel.getByTestId('xyz-title').filter({ hasText: XYZ_VBR.title }).waitFor({ timeout: 8000 });
  await panel.getByTestId('xyz-toggle').click();
  // 跳到 160 秒（Chrome 实测：这里报告的时间比实际放的声音晚约 3.5 秒）
  await vbr.evaluate(async () => {
    const a = /** @type {HTMLAudioElement} */ (document.querySelector('audio'));
    a.preload = 'auto';
    a.currentTime = 160;
    await new Promise((r) => a.addEventListener('seeked', r, { once: true }));
    await a.play();
  });
  await vbr.locator('[data-tubemuse="xyz"] .zh').filter({ hasText: '（校）' }).waitFor({ timeout: 30000 });
  const truth = await vbr.evaluate(async () => {
    // 测试自己（不是 TubeMuse）从同源的 mock 播放器取声音，认出现在放的是第几段音
    const a = /** @type {HTMLAudioElement & { captureStream(): MediaStream }} */ (document.querySelector('audio'));
    const ac = new AudioContext({ sampleRate: 16000 });
    const src = ac.createMediaStreamSource(a.captureStream());
    const an = ac.createAnalyser();
    an.fftSize = 8192;
    src.connect(an);
    /** @type {{ k: number; zh: string; t: number }[]} */
    const out = [];
    for (let i = 0; i < 12 && out.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 450));
      const buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      let best = -1;
      let bestK = -1;
      for (let k = 0; k < 60; k++) {
        const w = (2 * Math.PI * (300 + 20 * k)) / 16000;
        const c = 2 * Math.cos(w);
        let s1 = 0;
        let s2 = 0;
        for (const x of buf) {
          const s0 = x + c * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        const p = s1 * s1 + s2 * s2 - c * s1 * s2;
        if (p > best) [best, bestK] = [p, k];
      }
      let e = 0;
      for (const x of buf) e += x * x;
      const zh = document.querySelector('[data-tubemuse="xyz"]')?.shadowRoot?.querySelector('.zh')?.textContent ?? '';
      if (Math.sqrt(e / buf.length) > 0.05 && /第(\d+)段/.test(zh)) out.push({ k: bestK, zh, t: a.currentTime });
    }
    void ac.close();
    return out;
  });
  const matches = truth.filter((x) => Number(/第(\d+)段/.exec(x.zh)?.[1]) === x.k);
  check(truth.length >= 2 && matches.length === truth.length, `跳转后屏幕上的字幕就是正在放的那段音（${matches.length}/${truth.length}：${truth.map((x) => `${x.t.toFixed(1)}s 放第${x.k}段/显示${/第(\d+)段/.exec(x.zh)?.[1]}`).join('，')}）`);
  const vstate = /** @type {any} */ (await panel.evaluate(async (url) => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [tab] = await c.tabs.query({ url });
    return c.tabs.sendMessage(tab.id, { type: 'tubemuse:xyz:get-state' });
  }, `${MOCK}/xyz/episode/${XYZ_VBR.eid}`));
  check(vstate && vstate.truePos - vstate.pos < -2.5 && vstate.truePos - vstate.pos > -4.5, `页面时间与真实时间之差按 Chrome 的跳转规则换算（${(vstate.truePos - vstate.pos).toFixed(2)} 秒）`);
  check(extMedia().some((r) => r.path.endsWith(XYZ_VBR.file) && !r.headers.range?.match(/-\d+$/)), '建索引时把文件从头读了一遍（只读帧头，不保存）');
  await vbr.screenshot({ path: join(shots, '63-xyz-vbr.png') });
  await panel.getByTestId('xyz-toggle').click();
  await vbr.close();
  await panel.bringToFront();
}
