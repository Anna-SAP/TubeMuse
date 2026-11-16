// @ts-check
// 中文配音："录下完整双语视频"（DECISIONS §81）。在「配音」页点一下 → 片段录制脚本把视频跳到开头、从头实时录到结尾（双语混音）→
// 放完自动保存。标签页切到后台时视频和录制一起暂停，切回来接着录，文件里不缺也不多。
// 检查录下的文件本身：时长是整片；原声按 80%；中文按开头的偏移和对齐点落在该在的时间上。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, MOCK, root, shots } from '../harness.mjs';
import { DUB_FULL_VIDEO } from '../mock-server.mjs';

/**
 * 配音用的 tests/fixtures/xyz-tones.m4a：第 k 段音从 0.5 + 3k 秒起、1.8 秒长，频率 300 + 20k Hz。
 * 测试里的对齐：开头不偏移；视频 8 秒处一个对齐点 ↔ 中文 30.5 秒（之后中文 = 视频 + 22.5）。
 * 所以录下的整片里：1.4 秒处是第 0 段（300 Hz），4.4 秒处是第 1 段（320 Hz），8.9 秒处是第 10 段（500 Hz），
 * 11.9 秒处是第 11 段（520 Hz），14.9 秒处是第 12 段（540 Hz）
 */
const ANCHOR = { video: 8, dub: 30.5 };
const EXPECT = [
  { at: 1.4, hz: 300 },
  { at: 4.4, hz: 320 },
  { at: 8.9, hz: 500 },
  { at: 11.9, hz: 520 },
  { at: 14.9, hz: 540 },
];

/** @param {import('../harness.mjs').Harness} t */
export async function dubFull(t) {
  const { context, sw, requests, consoleErrors } = t;
  const panel = await t.openPanel();
  const M4A = join(root, 'tests', 'fixtures', 'xyz-tones.m4a');
  const ID = DUB_FULL_VIDEO.id;

  console.log('\n[中文配音：录下完整双语视频——准备（关联配音、一个对齐点）]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '配音', exact: true }).click();
  const reqStart = requests.length;
  const [page] = await Promise.all([context.waitForEvent('page'), panel.evaluate((u) => /** @type {any} */ (globalThis).chrome.tabs.create({ url: u, active: true }), `${MOCK}/watch?v=${ID}`)]);
  page.on('pageerror', (e) => consoleErrors.push(`dub full pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`dub full: ${m.text()}`));
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1, null, { timeout: 20000 });
  await panel.getByTestId('dub-pick').waitFor({ timeout: 10000 });
  await panel.getByTestId('dub-file').setInputFiles(M4A);
  await panel.getByTestId('dub-done').waitFor({ timeout: 15000 });
  // 对齐点直接写进本机存储（加对齐点的界面在 dub 那一部分测过）
  await panel.evaluate(
    async ([id, anchor]) => {
      const c = /** @type {any} */ (globalThis).chrome;
      const { dubs } = await c.storage.local.get('dubs');
      dubs[/** @type {string} */ (id)].anchors = [anchor];
      await c.storage.local.set({ dubs });
    },
    [ID, ANCHOR],
  );
  const tabId = await sw.evaluate(async (vid) => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [tab] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes(vid));
    return tab.id;
  }, ID);
  const ask = (/** @type {string} */ type) => /** @type {Promise<any>} */ (panel.evaluate(([id, ty]) => /** @type {any} */ (globalThis).chrome.tabs.sendMessage(id, { type: ty }), /** @type {[number, string]} */ ([tabId, type])));
  const clipState = () => ask('tubemuse:clips:get-state');
  const dubState = () => ask('tubemuse:dub:get-state');
  const wait = async (/** @type {() => Promise<any>} */ get, /** @type {(s: any) => boolean} */ ok, /** @type {string} */ what, timeout = 10000) => {
    const until = Date.now() + timeout;
    let s;
    while (Date.now() < until) {
      s = await get();
      if (s && ok(s)) return s;
      await page.waitForTimeout(100);
    }
    throw new Error(`等不到：${what}（最后：${JSON.stringify(s)}）`);
  };
  /**
   * 让这个标签页"进后台 / 回前台"。Playwright 给每个页面都开着焦点模拟，测试里的页面永远报告"可见"，换标签页也一样；
   * 所以在录制脚本所在的隔离环境里（经 CDP 找到扩展的那个环境）把 document.visibilityState 换掉，再发一次 visibilitychange——
   * 录制脚本看到的和真的切走标签页时一样
   */
  const cdp = await context.newCDPSession(page);
  /** @type {any[]} */ const worlds = [];
  cdp.on('Runtime.executionContextCreated', (e) => worlds.push(e.context));
  await cdp.send('Runtime.enable');
  const world = worlds.find((w) => w.auxData?.type === 'isolated' && String(w.origin).startsWith('chrome-extension://'));
  if (!world) throw new Error(`没找到扩展在这个页面里的隔离环境：${JSON.stringify(worlds.map((w) => [w.name, w.origin, w.auxData?.type]))}`);
  const setVisibility = async (/** @type {'hidden' | 'visible'} */ state) => {
    const r = await cdp.send('Runtime.evaluate', {
      contextId: world.id,
      expression: `Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => '${state}' }); document.dispatchEvent(new Event('visibilitychange')); document.visibilityState`,
    });
    if (r.result.value !== state) throw new Error(`没能把标签页设成 ${state}：${JSON.stringify(r)}`);
  };
  /** 在页面里对这个视频做点什么 / 读点什么（body 是一小段代码，v 是那个 <video>） */
  const video = (/** @type {string} */ body) => /** @type {Promise<any>} */ (page.evaluate(`(() => { const v = document.querySelector('video'); ${body} })()`));
  const text = async (/** @type {string} */ id) => ((await panel.getByTestId(id).count()) ? ((await panel.getByTestId(id).first().textContent()) ?? '') : '');

  console.log('\n[中文配音：录下完整双语视频——入口在「配音」页，配音没开时点不了]');
  await panel.getByTestId('dub-full').waitFor({ timeout: 10000 });
  const about = await text('dub-full-about');
  check(
    about.includes('从头到尾实时录一遍') && about.includes('全部 1 个对齐点') && about.includes('0:16') && about.includes('不下载 YouTube 的视频'),
    `「配音」页有"保存完整双语视频"，写明是实时录、要花和视频一样长的时间、按全部对齐点叠中文：${about.slice(0, 60)}…`,
  );
  check((await panel.getByTestId('dub-full-start').isDisabled()) && (await text('dub-full-blocked')).includes('先开启配音'), '配音没开启时按钮点不了，并说明先开启配音');

  await video('void v.play();');
  await panel.getByTestId('dub-toggle').click();
  await wait(dubState, (s) => s.phase === 'ready' && s.playing, '配音放起来');
  // 先放到后面去：开始录整片时应当自己跳回开头
  await video('v.currentTime = 11;');
  await wait(dubState, (s) => s.videoTime > 11.3 && s.playing, '拖到 0:11');
  await panel.getByTestId('dub-full-start').waitFor({ timeout: 5000 });
  for (let i = 0; i < 30 && (await panel.getByTestId('dub-full-start').isDisabled()); i++) await page.waitForTimeout(100);
  check(!(await panel.getByTestId('dub-full-start').isDisabled()) && (await text('dub-full-blocked')) === '', '配音开着、就绪：按钮可以点');
  const elementsBefore = await page.evaluate(() => document.querySelectorAll('*').length);

  console.log('\n[中文配音：录下完整双语视频——从头录，切到后台时视频和录制一起暂停，切回来接着录，放完自动保存]');
  const download = page.waitForEvent('download', { timeout: 90000 });
  await panel.getByTestId('dub-full-start').click();
  let c = await wait(clipState, (s) => s.phase === 'recording' && s.mode === 'full' && !s.waiting && s.recordedSec >= 1, '开始录整片', 15000);
  const posAtStart = /** @type {number} */ (await video('return v.currentTime;'));
  check(posAtStart < 4 && c.status === '正在录完整双语视频' && c.dub === 'mixing', `点了之后视频跳回开头从头放（现在 ${posAtStart.toFixed(1)} 秒），状态：${c.status}，正在混配音`);
  check(c.maxSec > DUB_FULL_VIDEO.seconds && c.maxSec < 600, `时长上限按视频时长算（${c.maxSec} 秒），不受"单段时长上限"管`);
  await panel.getByTestId('dub-full-live').waitFor({ timeout: 10000 });
  const liveText = await text('dub-full-live');
  check(liveText.includes('/ 0:16') && liveText.includes('还要约') && liveText.includes('这个标签页要一直开在前台'), `录制中显示进度、还要多久，并提醒标签页要留在前台：${liveText.replace(/\s+/g, ' ').slice(0, 70)}…`);
  await panel.screenshot({ path: join(shots, '74-dub-full-live.png'), fullPage: true });
  await panel.getByRole('tab', { name: '片段', exact: true }).click();
  await panel.getByTestId('clip-live').waitFor({ timeout: 10000 });
  check((await text('clip-live')).includes('完整双语视频'), '「片段」页也看得到这是一段完整双语视频的录制');
  await panel.getByRole('tab', { name: '配音', exact: true }).click();

  // 放到 5.5 秒左右（两段中文之间）把别的标签页切到前面：这个标签页进了后台
  await wait(clipState, (s) => s.position >= 5.4, '放到 5.5 秒', 15000);
  await setVisibility('hidden');
  c = await wait(clipState, (s) => s.waiting === 'hidden', '标签页进后台');
  const hiddenAt = /** @type {{ paused: boolean, t: number }} */ (await video('return { paused: v.paused, t: v.currentTime };'));
  await page.waitForTimeout(2500);
  const stillAt = /** @type {{ paused: boolean, t: number }} */ (await video('return { paused: v.paused, t: v.currentTime };'));
  const d = await dubState();
  check(
    hiddenAt.paused && stillAt.paused && Math.abs(stillAt.t - hiddenAt.t) < 0.05 && c.status.includes('视频和录制都暂停了') && d.playing === false,
    `标签页切到后台：视频、配音和录制一起暂停（停在 ${stillAt.t.toFixed(2)} 秒，2.5 秒后没动），状态：${c.status}`,
  );
  await setVisibility('visible');
  c = await wait(clipState, (s) => !s.waiting && s.position > stillAt.t + 0.5, '切回来接着录', 15000);
  check(!(/** @type {boolean} */ (await video('return v.paused;'))), `切回这个标签页：视频自己接着放、接着录（现在 ${c.position} 秒）`);

  const dl = await download;
  const name = dl.suggestedFilename();
  const b64 = readFileSync(/** @type {string} */ (await dl.path())).toString('base64');
  c = await wait(clipState, (s) => s.phase === 'idle' && !!s.ready?.savedAt, '放完自动保存');
  check(
    c.ready.full?.issues.length === 0 && c.ready.endedBy === 'ended' && c.ready.dubbed === true && c.ready.start === 0 && c.ready.end === DUB_FULL_VIDEO.seconds,
    `视频放完：录制自己结束、自动保存，没有"没录完整"的地方（${JSON.stringify(c.ready.full)}，${c.ready.start}–${c.ready.end} 秒）`,
  );
  check(/_双语完整版\.(mp4|webm)$/.test(name) && name === c.ready.fileName, `文件名：${name}`);

  // 录下的文件：整片那么长；原声（200 Hz）按 80%；中文各段落在按对齐点算出的时间上
  const measured = /** @type {{ duration: number, tone: number, hits: { at: number, hz: number, amp: number, others: number }[] }} */ (
    await page.evaluate(
      async ([b64, toneHz, expectJson]) => {
        const expect = /** @type {{ at: number, hz: number }[]} */ (JSON.parse(/** @type {string} */ (expectJson)));
        const bytes = Uint8Array.from(atob(/** @type {string} */ (b64)), (ch) => ch.charCodeAt(0));
        const ac = new AudioContext();
        try {
          const buf = await ac.decodeAudioData(bytes.buffer);
          const ch = buf.getChannelData(0);
          const sr = buf.sampleRate;
          const amp = (/** @type {number} */ hz, /** @type {number} */ from, /** @type {number} */ to) => {
            const a = Math.max(0, Math.floor(from * sr));
            const b = Math.min(ch.length, Math.floor(to * sr));
            const w = (2 * Math.PI * hz) / sr;
            let re = 0;
            let im = 0;
            for (let i = a; i < b; i++) {
              re += ch[i] * Math.cos(w * i);
              im -= ch[i] * Math.sin(w * i);
            }
            return b > a ? (2 * Math.sqrt(re * re + im * im)) / (b - a) : -1;
          };
          // 原声：每 0.5 秒量一次，取中位数
          /** @type {number[]} */ const tones = [];
          for (let s = 0.5; s + 0.5 <= buf.duration - 0.5; s += 0.5) tones.push(amp(/** @type {number} */ (toneHz), s, s + 0.5));
          const tone = [...tones].sort((x, y) => x - y)[Math.floor(tones.length / 2)] ?? -1;
          // 中文：在该出现的那 0.4 秒里量该有的那个频率，再量别的几段的频率（不该有）
          const all = expect.map((e) => e.hz);
          const hits = expect.map((e) => ({
            ...e,
            amp: amp(e.hz, e.at - 0.2, e.at + 0.2),
            others: Math.max(...all.filter((hz) => hz !== e.hz).map((hz) => amp(hz, e.at - 0.2, e.at + 0.2))),
          }));
          return { duration: buf.duration, tone, hits };
        } catch {
          return { duration: -1, tone: -1, hits: [] };
        } finally {
          void ac.close();
        }
      },
      [b64, DUB_FULL_VIDEO.toneHz, JSON.stringify(EXPECT)],
    )
  );
  check(
    Math.abs(measured.duration - DUB_FULL_VIDEO.seconds) < 1,
    `文件时长 ${measured.duration.toFixed(2)} 秒 = 整片 ${DUB_FULL_VIDEO.seconds} 秒：中途在后台停的那 2.5 秒没有录进去，也没有缺一段`,
  );
  check(Math.abs(measured.tone / DUB_FULL_VIDEO.toneAmp - 0.8) < 0.08, `原声按 80% 保留：200 Hz 的振幅 ${measured.tone.toFixed(3)}（原来 ${DUB_FULL_VIDEO.toneAmp}）`);
  const placed = measured.hits.length === EXPECT.length && measured.hits.every((h) => h.amp > 0.15 && h.others < h.amp / 3);
  check(
    placed,
    `中文按开头的偏移和对齐点落在该在的时间上（视频 8 秒处跳到中文 30.5 秒）：${measured.hits.map((h) => `${h.at}s 是 ${h.hz}Hz（振幅 ${h.amp.toFixed(2)}，别的 ${h.others.toFixed(2)}）`).join('；')}`,
  );

  await panel.getByTestId('dub-full-ready').waitFor({ timeout: 10000 });
  const readyText = await text('dub-full-ready');
  check(
    readyText.includes(name) && (await text('dub-full-complete')).includes('录完整了：全片 0:16') && (await text('dub-full-saved')).includes('存进下载文件夹'),
    `「配音」页写明录完整了、已保存：${(await text('dub-full-complete')).trim()}`,
  );
  await panel.screenshot({ path: join(shots, '75-dub-full-done.png'), fullPage: true });
  const log = /** @type {any[]} */ (await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('clipLog').then((/** @type {any} */ r) => r.clipLog ?? [])));
  check(
    log[0]?.mode === 'full' && log[0]?.videoId === ID && log[0]?.dubbed === true && !log[0]?.partial && log[0]?.fileName === name,
    `"最近录过的片段"记下这一份完整双语视频（只有元数据）：${JSON.stringify({ mode: log[0]?.mode, start: log[0]?.start, end: log[0]?.end, dubbed: log[0]?.dubbed })}`,
  );
  check((await page.evaluate(() => document.querySelectorAll('*').length)) === elementsBefore && (await page.locator('audio, canvas, a[download]').count()) === 0, '页面里没有插入任何元素');

  console.log('\n[中文配音：录下完整双语视频——中途停下、拖过进度：不算完整，一条条写明]');
  await video('void v.play();');
  await wait(dubState, (s) => s.phase === 'ready', '配音仍开着');
  const partial = page.waitForEvent('download', { timeout: 30000 });
  await panel.getByTestId('dub-full-start').click();
  await wait(clipState, (s) => s.phase === 'recording' && s.mode === 'full' && !s.waiting && s.recordedSec >= 1.5, '第二次开始', 15000);
  // 录制中把进度往前拖 6 秒
  await video('v.currentTime = v.currentTime + 6;');
  await wait(clipState, (s) => !s.waiting && s.position >= 8, '拖动后接着录', 15000);
  await page.waitForTimeout(600);
  await panel.getByTestId('dub-full-stop').click();
  const dl2 = await partial;
  c = await wait(clipState, (s) => s.phase === 'idle' && !!s.ready?.savedAt && s.ready.fileName === dl2.suggestedFilename(), '停下后保存');
  const issues = await text('dub-full-issues');
  check(
    JSON.stringify(c.ready.full?.issues) === JSON.stringify(['stopped-early', 'jumped']) && issues.includes('没录到结尾（你停止了录制）') && issues.includes('全片 0:16') && issues.includes('进度条被拖动过'),
    `中途停下、拖过进度：写明没录到结尾、缺了一段：${issues.replace(/\s+/g, ' ')}`,
  );
  check(!dl2.suggestedFilename().includes('双语完整版') && /_\d\dm\d\ds-\d\dm\d\ds\./.test(dl2.suggestedFilename()), `没录完整的不叫"完整版"，文件名带起止时间：${dl2.suggestedFilename()}`);
  const log2 = /** @type {any[]} */ (await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('clipLog').then((/** @type {any} */ r) => r.clipLog ?? [])));
  check(log2[0]?.mode === 'full' && log2[0]?.partial === true, '记录里标明这一份没录完整');

  console.log('\n[中文配音：录下完整双语视频——倍速不是 1 时不开始；全程没有网络请求]');
  await video('v.playbackRate = 1.5; void v.play();');
  await page.waitForTimeout(300);
  await panel.getByTestId('dub-full-start').click();
  await panel.getByTestId('dub-full').getByTestId('dub-error').waitFor({ timeout: 10000 });
  const rateError = (await panel.getByTestId('dub-full').getByTestId('dub-error').textContent()) ?? '';
  check(rateError.includes('1.5 倍速') && (await clipState()).phase === 'idle', `倍速不是 1：不开始，说明先调回正常速度：${rateError}`);
  await video('v.playbackRate = 1;');

  const newReqs = requests.slice(reqStart).filter((r) => !(r.path === '/watch' || r.path === `/media/${ID}.wav` || r.path === '/favicon.ico' || r.path.startsWith('/youtube/v3/videos')));
  check(newReqs.length === 0, `录完整双语视频没有发出任何网络请求${newReqs.length ? `：${[...new Set(newReqs.map((r) => r.path))].join(', ')}` : ''}`);

  // 收尾：移除配音，关掉页面
  await panel.getByTestId('dub-remove').click();
  await panel.getByTestId('dub-remove-yes').click();
  await panel.getByTestId('dub-pick').waitFor({ timeout: 10000 });
  await page.close();
  await panel.bringToFront();
}
