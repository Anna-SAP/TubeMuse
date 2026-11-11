// @ts-check
// 自动字幕（浏览器识别 / OpenAI 转写、翻译、预算与限流）与多语字幕（叠加、顺序、让位原生字幕、慢与出错时的说明、自动显示）。
import { join } from 'node:path';
import { check, FAKE_KEY, MOCK, shots } from '../harness.mjs';

/** @param {import('../harness.mjs').Harness} t */
export async function subtitles(t) {
  const { context, sw, options, requests, consoleErrors } = t;
  const panel = await t.openPanel();

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

  console.log('\n[多语字幕：调整显示顺序——↑↓ 只改这个视频，字幕层立刻跟着变、不重新取字幕；可以设为默认（刷新后还在），也可以改回默认]');
  const ccMoveBtn = (/** @type {'上移' | '下移'} */ dir, /** @type {string} */ name) => panel.getByRole('button', { name: `${dir} ${name}`, exact: true });
  const ccPanelRows = () => panel.getByTestId('multicc-langs').locator('.cc-lang-name').allTextContents();
  const ccFocused = (/** @type {string} */ label) => panel.waitForFunction((label) => document.activeElement?.getAttribute('aria-label') === label, label, { timeout: 5000 });
  /** 等字幕层的行序变成这样（不管这一行此刻有没有字） */
  const waitLineOrder = (/** @type {import('playwright').Page} */ page, /** @type {string[]} */ order) =>
    page.waitForFunction(
      (order) => JSON.stringify([...(document.querySelector('[data-tubemuse="multicc"]')?.shadowRoot?.querySelectorAll('.line') ?? [])].map((l) => /** @type {HTMLElement} */ (l).dataset.lang)) === JSON.stringify(order),
      order,
      { timeout: 5000 },
    );
  const ccBackToDefault = panel.getByRole('button', { name: '这个视频改回默认语言和顺序' });
  const ccSaveDefault = panel.getByRole('button', { name: '把这组语言和顺序设为默认' });
  const savedCcLangs = () => panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('settings').then((/** @type {any} */ r) => r.settings.multiCaptions.langs));
  /** 把默认语言写回去（给后面的用例；走存储，不走界面） */
  const setDefaultCcLangs = (/** @type {string[]} */ langs) =>
    panel.evaluate(async (langs) => {
      const c = /** @type {any} */ (globalThis).chrome;
      const { settings } = await c.storage.local.get('settings');
      await c.storage.local.set({ settings: { ...settings, multiCaptions: { ...settings.multiCaptions, langs } } });
    }, langs);

  await panel.getByRole('button', { name: '显示多语字幕' }).click();
  await seekPaused(cc, 6.0);
  await waitCcText(cc, ['서로 이어진 결을 따라', 'Along the lines that connect us', '循着彼此相连的脉络']);
  const ccFetchedBefore = ourTt('ccMulti0001').length;
  const colorsBefore = (await ccLines(cc)).map((l) => l.color);
  check((await ccMoveBtn('上移', 'Korean').isDisabled()) && (await ccMoveBtn('下移', 'Chinese (Simplified)').isDisabled()), '第一行不能再上移，最后一行不能再下移');
  check((await panel.getByRole('button', { name: '上移 Indonesian' }).count()) === 0, '没勾选的语言没有 ↑↓（它不在播放器里）');

  await ccMoveBtn('下移', 'Korean').click();
  await waitLineOrder(cc, ['en', 'ko', 'zh-Hans']);
  await waitCcText(cc, ['Along the lines that connect us', '서로 이어진 결을 따라', '循着彼此相连的脉络']);
  check(true, '视频暂停时点 ↓：字幕层立刻换成英文 / 韩文 / 中文，排在前面的语言显示在上方');
  check(JSON.stringify((await ccLines(cc)).map((l) => l.color)) === JSON.stringify(colorsBefore), '颜色和字号跟位置走：第一行仍是白色');
  check((await ccPanelRows()).slice(0, 3).join(' / ') === 'English / Korean / Chinese (Simplified)', `侧边栏的顺序跟着变：${(await ccPanelRows()).slice(0, 3).join(' / ')}`);
  check(ourTt('ccMulti0001').length === ccFetchedBefore, '调顺序不重新取字幕');
  await panel.screenshot({ path: join(shots, '35-multicc-order.png'), fullPage: true });

  await ccMoveBtn('下移', 'Korean').focus();
  await panel.keyboard.press('Enter');
  await waitLineOrder(cc, ['en', 'zh-Hans', 'ko']);
  await ccFocused('上移 Korean');
  check(true, '键盘操作：挪到底后 ↓ 不能按了，焦点落到同一行的 ↑');
  await panel.keyboard.press('Enter');
  await waitLineOrder(cc, ['en', 'ko', 'zh-Hans']);
  await ccFocused('上移 Korean');
  check(true, '键盘操作：挪完焦点跟着这一行走，连按挪的始终是同一种语言');

  await panel.keyboard.press('Enter');
  await waitLineOrder(cc, ['ko', 'en', 'zh-Hans']);
  await ccBackToDefault.waitFor({ state: 'detached', timeout: 5000 });
  check(true, '手动调回和默认一样：不算单独选过，"改回默认"随之消失');

  await ccMoveBtn('上移', 'English').click();
  await waitLineOrder(cc, ['en', 'ko', 'zh-Hans']);
  await ccBackToDefault.click();
  await waitLineOrder(cc, ['ko', 'en', 'zh-Hans']);
  check(true, '这个视频改回默认语言和顺序：字幕层回到默认');

  await panel.getByRole('button', { name: '关闭多语字幕' }).click();
  await cc.waitForFunction(() => !document.querySelector('[data-tubemuse="multicc"]'), null, { timeout: 5000 });
  await ccMoveBtn('下移', 'Korean').click();
  await ccBackToDefault.waitFor({ timeout: 5000 });
  await panel.getByRole('button', { name: '显示多语字幕' }).click();
  await waitLineOrder(cc, ['en', 'ko', 'zh-Hans']);
  check(true, '字幕层关着时调的顺序，打开后生效');

  await ccMoveBtn('上移', 'Chinese (Simplified)').click();
  await waitLineOrder(cc, ['en', 'zh-Hans', 'ko']);
  await ccMoveBtn('上移', 'Chinese (Simplified)').click();
  await waitLineOrder(cc, ['zh-Hans', 'en', 'ko']);
  await ccSaveDefault.click();
  await panel.getByTestId('multicc-default-saved').waitFor({ timeout: 5000 });
  const ccSavedOrder = await savedCcLangs();
  check(JSON.stringify(ccSavedOrder) === JSON.stringify(['zh-Hans', 'en', 'original']), `设为默认：存进设置的是 ${ccSavedOrder.join(', ')}`);
  await ccBackToDefault.waitFor({ state: 'detached', timeout: 5000 });
  check(true, '设为默认后这个视频不再算单独选过');
  await options.getByTestId('multicc-lang-order').locator('li').first().filter({ hasText: '简体中文' }).waitFor({ timeout: 5000 });
  check(true, '设置页的默认顺序跟着变');
  await cc.reload();
  await cc.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await ccStatus.filter({ hasText: '未开启' }).waitFor({ timeout: 10000 });
  await panel.getByRole('button', { name: '显示多语字幕' }).click();
  await waitLineOrder(cc, ['zh-Hans', 'en', 'ko']);
  check(true, '刷新页面后顺序还在（存在设置里）');
  await setDefaultCcLangs(['original', 'en', 'zh-Hans']);
  await waitLineOrder(cc, ['ko', 'en', 'zh-Hans']);
  check(true, '在设置里改默认顺序：正在看的视频立刻跟着变');
  await panel.getByRole('button', { name: '关闭多语字幕' }).click();
  await cc.waitForFunction(() => !document.querySelector('[data-tubemuse="multicc"]'), null, { timeout: 5000 });

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
  // 原声就是英语：默认列表里的 en 没有自己的一行。调顺序、设为默认都不能把它弄丢，否则到韩语 MV 上就少一行英文
  await ccMoveBtn('上移', 'lang:zh-Hans').click();
  await waitLineOrder(cc, ['zh-Hans', 'en']);
  await ccSaveDefault.click();
  await panel.getByTestId('multicc-default-saved').waitFor({ timeout: 5000 });
  const ccTalkOrder = await savedCcLangs();
  check(JSON.stringify(ccTalkOrder) === JSON.stringify(['zh-Hans', 'original', 'en']), `原声与 English 重复时设为默认：没显示的 en 跟着原声走、不丢（${ccTalkOrder.join(', ')}）`);
  await setDefaultCcLangs(['original', 'en', 'zh-Hans']);
  await waitLineOrder(cc, ['en', 'zh-Hans']);
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
}
