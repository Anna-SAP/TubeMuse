// @ts-check
// 中文配音："保存完整双语视频"（DECISIONS §83）。你选原视频文件（MP4）→ 侧边栏里离线合成（不播放）→ 自动下载。
// 检查合成出来的文件本身：画面和原文件逐像素一样、时长是整片；原声按 80%；中文按开头的偏移和对齐点落在该在的时间上
// （快速对齐时按倍速、音调不变）；用时远小于视频时长；不在 YouTube 页面上也能做；全程没有网络请求。
// 带上原声字幕（DECISIONS §84）：默认勾着；字幕按"你选的字幕文件 → 原视频文件里嵌着的 → YouTube 页面上这个视频自带的"找，
// 都没有时停下来问；写成视频里的一条字幕轨，还能另存成 .srt。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, MOCK, root, shots } from '../harness.mjs';
import { DUB_FULL_VIDEO } from '../mock-server.mjs';

/**
 * 配音用的 tests/fixtures/xyz-tones.m4a：第 k 段音从 0.5 + 3k 秒起、1.8 秒长，频率 300 + 20k Hz。
 * 原视频用的 tests/fixtures/dub-source.mp4：16 秒，320×180 的 H.264 画面（每一帧都不一样），原声是 200 Hz、振幅 0.2 的单音。
 * 手动对齐：开头不偏移；视频 8 秒处一个对齐点 ↔ 中文 30.5 秒（之后中文 = 视频 + 22.5）。
 * 所以合成出来的整片里：1.4 秒处是第 0 段（300 Hz），4.4 秒处是第 1 段（320 Hz），8.9 秒处是第 10 段（500 Hz），
 * 11.9 秒处是第 11 段（520 Hz），14.9 秒处是第 12 段（540 Hz）
 */
const ANCHOR = { video: 8, dub: 30.5 };
const MANUAL = [
  { at: 1.4, hz: 300 },
  { at: 4.4, hz: 320 },
  { at: 8.9, hz: 500 },
  { at: 11.9, hz: 520 },
  { at: 14.9, hz: 540 },
];
/** 快速对齐 0.75 倍（慢放）：中文的 d 秒落在视频的 d ÷ 0.75 秒；第 k 段在 (0.5 + 3k) ÷ 0.75 到 (2.3 + 3k) ÷ 0.75 秒，音高不变 */
const QUICK_RATE = 0.75;
const QUICK = [
  { at: 1.9, hz: 300 },
  { at: 5.9, hz: 320 },
  { at: 9.9, hz: 340 },
  { at: 13.9, hz: 360 },
];
/**
 * 加快英文 1.25 倍（DECISIONS §87）：画面和原声快 1.25 倍，新文件 12.8 秒；中文原速——它的 d 秒落在新文件的 d 秒，
 * 所以第 k 段仍在 0.5 + 3k 到 2.3 + 3k 秒，音高不变；原声的 200 Hz 也还是 200 Hz（变速不变调）
 */
const ENGLISH_RATE = 1.25;
const ENGLISH = [
  { at: 1.4, hz: 300 },
  { at: 4.4, hz: 320 },
  { at: 7.4, hz: 340 },
  { at: 10.4, hz: 360 },
];
/** 手动对齐 + 整体 0.8 倍（慢放）：新文件 20 秒，MANUAL 里的每个时刻都 ÷ 0.8 */
const OVERALL_RATE = 0.8;
const OVERALL = MANUAL.map((x) => ({ at: Number((x.at / OVERALL_RATE).toFixed(3)), hz: x.hz }));

/** @param {import('../harness.mjs').Harness} t */
export async function dubFull(t) {
  const { context, requests, consoleErrors } = t;
  const panel = await t.openPanel();
  const M4A = join(root, 'tests', 'fixtures', 'xyz-tones.m4a');
  const SOURCE = join(root, 'tests', 'fixtures', 'dub-source.mp4');
  const sourceB64 = readFileSync(SOURCE).toString('base64');
  const ID = DUB_FULL_VIDEO.id;

  console.log('\n[保存完整双语视频：准备（关联配音、一个对齐点）]');
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
  /** 直接改本机存着的这条配音记录（加对齐点的界面在 dub 那一部分测过） */
  const patchRec = (/** @type {Record<string, unknown>} */ change) =>
    panel.evaluate(
      async ([id, json]) => {
        const c = /** @type {any} */ (globalThis).chrome;
        const { dubs } = await c.storage.local.get('dubs');
        const next = { ...dubs[/** @type {string} */ (id)], .../** @type {object} */ (JSON.parse(/** @type {string} */ (json))) };
        for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
        dubs[/** @type {string} */ (id)] = next;
        await c.storage.local.set({ dubs });
      },
      [ID, JSON.stringify(change)],
    );
  await patchRec({ anchors: [ANCHOR] });
  const text = async (/** @type {string} */ id) => ((await panel.getByTestId(id).count()) ? ((await panel.getByTestId(id).first().textContent()) ?? '') : '');
  /** 点"选择原视频文件"，在文件对话框里选这个文件 */
  const pick = async (/** @type {string | { name: string, mimeType: string, buffer: Buffer }} */ file, testId = 'dub-full-pick') => {
    const [chooser] = await Promise.all([panel.waitForEvent('filechooser'), panel.getByTestId(testId).first().click()]);
    await chooser.setFiles(file);
  };
  const phase = (/** @type {string} */ want, timeout = 20000) => panel.locator(`[data-testid="dub-export"][data-phase="${want}"]`).first().waitFor({ timeout });

  const exportSubsSetting = async () => /** @type {any} */ (await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('settings'))).settings?.dub?.exportSubtitles;
  /** 勾上 / 取消"带上原声字幕"，等它存下 */
  const setSubs = async (/** @type {boolean} */ on) => {
    if ((await panel.getByTestId('dub-full-subs').isChecked()) !== on) await panel.getByTestId('dub-full-subs').click();
    for (let i = 0; i < 30 && (await exportSubsSetting()) !== on; i++) await panel.waitForTimeout(100);
  };

  console.log('\n[保存完整双语视频：入口在「配音」页，不用开启配音、不用播放]');
  await panel.getByTestId('dub-full').waitFor({ timeout: 10000 });
  const subsAuto = (await text('dub-full-subs-auto')).replace(/\s+/g, ' ');
  check(
    (await panel.getByTestId('dub-full-subs').isChecked()) && subsAuto.includes('字幕不在视频文件里') && subsAuto.includes('从这个 YouTube 页面取这个视频自带的原声字幕') && (await panel.getByTestId('dub-full-subs-pick').count()) === 1,
    `"带上原声字幕"默认勾着，并写明字幕为什么要另找、从哪找：${subsAuto.slice(0, 60)}…`,
  );
  // 前面几节先看不带字幕的合成（和以前一样）；带字幕的在后面
  await setSubs(false);
  check((await exportSubsSetting()) === false && (await panel.getByTestId('dub-full-subs-source').count()) === 0, '取消勾选：存进设置，字幕来源的说明收起');
  const about = (await text('dub-full-about')).replace(/\s+/g, ' ');
  check(
    about.includes('不用播放') && about.includes('画面原样照搬') && about.includes('全部 1 个对齐点') && about.includes('不下载 YouTube 的视频') && !about.includes('实时录'),
    `「配音」页有"保存完整双语视频"：选原视频文件、本机合成、不用播放：${about.slice(0, 64)}…`,
  );
  const dubOff = /** @type {any} */ (await panel.evaluate((u) => /** @type {any} */ (globalThis).chrome.tabs.query({ url: u }).then((/** @type {any[]} */ tabs) => /** @type {any} */ (globalThis).chrome.tabs.sendMessage(tabs[0].id, { type: 'tubemuse:dub:get-state' })), `${MOCK}/watch*`));
  check(dubOff.active === false && !(await panel.getByTestId('dub-full-pick').isDisabled()) && (await page.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).paused)), '配音没开启、视频没在放：按钮照样能点');
  check((await panel.locator('[data-testid^="dub-full-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).every((id) => !['dub-full-start', 'dub-full-stop', 'dub-full-pause'].includes(id ?? '')), '原来"实时录一遍"的开始 / 暂停 / 停止按钮没有了');

  console.log('\n[保存完整双语视频：选错文件时说清楚是什么、怎么办]');
  await pick({ name: 'video.mp4', mimeType: 'video/mp4', buffer: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000)]) });
  await phase('error');
  const webmError = (await text('dub-export')).replace(/\s+/g, ' ');
  check(webmError.includes('WebM / MKV') && webmError.includes('ffmpeg -i'), `改了扩展名的 WebM：说明不是 MP4，并给出转换办法：${webmError.slice(0, 90)}…`);
  await panel.getByTestId('dub-export').locator('.icon-btn').click();
  await pick(M4A);
  await phase('error');
  check((await text('dub-export')).includes('没有画面'), '只有声音的文件：说明没有画面');
  await panel.getByTestId('dub-export').locator('.icon-btn').click();
  // 时长和 YouTube 上的对不上（把记下的视频时长临时改成 2 分钟）：先问，不直接合成
  await patchRec({ videoDurationSec: 120 });
  await pick(SOURCE);
  await phase('confirm');
  const mismatch = (await text('dub-export-mismatch')).replace(/\s+/g, ' ');
  check(mismatch.includes('这个文件长 0:16') && mismatch.includes('YouTube 上这个视频是 2:00') && mismatch.includes('差 104.0 秒'), `文件时长和视频对不上：先问是不是选错了文件：${mismatch.slice(0, 60)}…`);
  await panel.getByTestId('dub-export').getByRole('button', { name: '取消', exact: true }).click();
  await phase('cancelled');
  check((await text('dub-export-cancelled')).includes('没有生成文件'), '取消：不生成文件');
  await panel.getByTestId('dub-export').getByRole('button', { name: '收起', exact: true }).click();
  await patchRec({ videoDurationSec: DUB_FULL_VIDEO.seconds });

  /** 合成一次，取回下载的文件，在（仿）YouTube 页面里解出来量：画面、时长、原声、中文各段的位置 */
  /** speed：画面的倍速（加快英文、整体变速时新文件里的 t 秒是原文件的 t × speed 秒） */
  const exportOnce = async (/** @type {{ at: number, hz: number }[]} */ expect, testId = 'dub-full-pick', speed = 1) => {
    const wallStart = Date.now();
    const [dl] = await Promise.all([panel.waitForEvent('download', { timeout: 60000 }), pick(SOURCE, testId)]);
    const wallMs = Date.now() - wallStart;
    await phase('done');
    const name = dl.suggestedFilename();
    const bytes = readFileSync(/** @type {string} */ (await dl.path()));
    const measured = /** @type {any} */ (
      await page.evaluate(
        async ([outB64, srcB64, expectJson, toneHz, speedArg]) => {
          const expect = /** @type {{ at: number, hz: number }[]} */ (JSON.parse(/** @type {string} */ (expectJson)));
          const sp = /** @type {number} */ (speedArg);
          const bytesOf = (/** @type {string} */ b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
          const out = bytesOf(/** @type {string} */ (outB64));
          // 画面：新文件和原文件各放进一个不放进页面的 <video>，跳到同一时刻，逐像素比
          const load = async (/** @type {Uint8Array} */ b) => {
            const v = document.createElement('video');
            v.muted = true;
            v.src = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (b)], { type: 'video/mp4' }));
            await new Promise((ok, bad) => {
              v.onloadeddata = ok;
              v.onerror = () => bad(new Error(`放不了：${v.error?.message}`));
            });
            return v;
          };
          const frame = async (/** @type {HTMLVideoElement} */ v, /** @type {number} */ at) => {
            v.currentTime = at;
            await new Promise((ok) => (v.onseeked = ok));
            const c = document.createElement('canvas');
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
            g.drawImage(v, 0, 0);
            return g.getImageData(0, 0, c.width, c.height).data;
          };
          const a = await load(out);
          const b = await load(bytesOf(/** @type {string} */ (srcB64)));
          const video = { duration: a.duration, width: a.videoWidth, height: a.videoHeight, same: /** @type {boolean[]} */ ([]), differ: /** @type {boolean[]} */ ([]) };
          /** @type {Uint8ClampedArray | undefined} */
          let previous;
          // 画面变速时比的是新文件的 t 秒和原文件的 t × 倍速 秒（都避开两帧交界的时刻）
          for (const at of sp === 1 ? [0.5, 3.1, 8.0, 12.4, 15.8] : [0.55, 3.1, 7.9, 12.4]) {
            const x = await frame(a, at);
            const y = await frame(b, at * sp);
            video.same.push(x.length === y.length && x.every((p, i) => p === y[i]));
            // 不同时刻的画面确实不一样（不是每次都比到同一张黑图）
            const before = previous;
            if (before) video.differ.push(x.some((p, i) => p !== before[i]));
            previous = x;
          }
          // 声音
          const ac = new AudioContext();
          try {
            const buf = await ac.decodeAudioData(out.slice().buffer);
            const ch = buf.getChannelData(0);
            const sr = buf.sampleRate;
            const amp = (/** @type {number} */ hz, /** @type {number} */ from, /** @type {number} */ to) => {
              const i0 = Math.max(0, Math.floor(from * sr));
              const i1 = Math.min(ch.length, Math.floor(to * sr));
              const w = (2 * Math.PI * hz) / sr;
              let re = 0;
              let im = 0;
              for (let i = i0; i < i1; i++) {
                re += ch[i] * Math.cos(w * i);
                im -= ch[i] * Math.sin(w * i);
              }
              return i1 > i0 ? (2 * Math.sqrt(re * re + im * im)) / (i1 - i0) : -1;
            };
            /** @type {number[]} */ const tones = [];
            for (let s = 0.5; s + 0.5 <= buf.duration - 0.5; s += 0.5) tones.push(amp(/** @type {number} */ (toneHz), s, s + 0.5));
            const tone = [...tones].sort((x, y) => x - y)[Math.floor(tones.length / 2)] ?? -1;
            const all = [300, 320, 340, 360, 380, 400, 440, 450, 480, 500, 520, 540];
            const hits = expect.map((e) => ({ ...e, amp: amp(e.hz, e.at - 0.2, e.at + 0.2), others: Math.max(...all.filter((hz) => hz !== e.hz).map((hz) => amp(hz, e.at - 0.2, e.at + 0.2))) }));
            // 第一段中文（300 Hz）从哪一刻响起来：20 毫秒一格往后找
            let onset = -1;
            for (let s = 0; s < 4 && onset < 0; s += 0.005) if (amp(300, s, s + 0.02) > 0.15) onset = s;
            let peak = 0;
            for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
            return { video, audio: { duration: buf.duration, channels: buf.numberOfChannels, sampleRate: sr, tone, hits, onset, peak } };
          } finally {
            void ac.close();
          }
        },
        [bytes.toString('base64'), sourceB64, JSON.stringify(expect), DUB_FULL_VIDEO.toneHz, speed],
      )
    );
    return { name, bytes, wallMs, measured, done: (await text('dub-export-done')).replace(/\s+/g, ' ') };
  };
  const usedSec = (/** @type {string} */ done) => Number(/用时 (\d+) 秒/.exec(done)?.[1] ?? NaN);

  console.log('\n[保存完整双语视频：选原视频文件 → 离线合成 → 自动下载；用时远小于视频时长]');
  const playedBefore = await page.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime);
  const first = await exportOnce(MANUAL);
  const playedAfter = await page.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    return { t: v.currentTime, paused: v.paused };
  });
  check(playedAfter.paused && playedAfter.t === playedBefore, `合成期间（仿）YouTube 页面上的视频没有被播放（一直停在 ${playedAfter.t} 秒）`);
  check(
    first.wallMs < (DUB_FULL_VIDEO.seconds * 1000) / 2 && usedSec(first.done) <= DUB_FULL_VIDEO.seconds / 2,
    `从选好文件到文件下载下来用了 ${(first.wallMs / 1000).toFixed(1)} 秒，视频长 ${DUB_FULL_VIDEO.seconds} 秒：不到一半（界面上写的：${/用时[^·]*/.exec(first.done)?.[0]}）`,
  );
  check(first.name === 'mock watch_双语完整版.mp4' && (await text('dub-export-file')) === first.name, `文件名：${first.name}`);
  check(!first.bytes.includes(Buffer.from('tx3g')) && (await text('dub-export-no-subs')).includes('没有带字幕') && (await panel.getByTestId('dub-export-srt').count()) === 0, '没勾"带上原声字幕"：文件里没有字幕轨，界面写明这一份没有带字幕');
  check(first.done.includes('全片 0:16') && first.done.includes('画面原样照搬') && first.done.includes('中文 2 段') && (await text('dub-export-saved')).includes('存进下载文件夹'), `界面写明合成好了：${first.done}`);
  const v1 = first.measured.video;
  check(Math.abs(v1.duration - 16) < 0.1 && v1.width === 320 && v1.height === 180, `新文件能放：${v1.width}×${v1.height}，时长 ${v1.duration.toFixed(2)} 秒 = 整片`);
  check(
    v1.same.length === 5 && v1.same.every(Boolean) && v1.differ.every(Boolean),
    `画面原样照搬：0.5 / 3.1 / 8.0 / 12.4 / 15.8 秒这 5 处，新文件和原文件解出来的画面逐像素相同（各处的画面互不相同）`,
  );
  const a1 = first.measured.audio;
  check(Math.abs(a1.duration - 16) < 0.1, `声音的时长 ${a1.duration.toFixed(2)} 秒 = 整片（${a1.channels} 声道 ${a1.sampleRate} Hz）`);
  check(Math.abs(a1.tone / DUB_FULL_VIDEO.toneAmp - 0.8) < 0.05, `原声按 80% 保留：200 Hz 的振幅 ${a1.tone.toFixed(3)}（原来 ${DUB_FULL_VIDEO.toneAmp}）`);
  check(
    a1.hits.length === MANUAL.length && a1.hits.every((/** @type {any} */ h) => h.amp > 0.2 && h.others < h.amp / 4),
    `中文按开头的偏移和对齐点落在该在的时间上（视频 8 秒处跳到中文 30.5 秒）：${a1.hits.map((/** @type {any} */ h) => `${h.at}s 是 ${h.hz}Hz（振幅 ${h.amp.toFixed(2)}，别的 ${h.others.toFixed(2)}）`).join('；')}`,
  );
  check(Math.abs(a1.onset - 0.5) < 0.03, `对得准：中文第一段音该在 0.500 秒响起，合成出来的在 ${a1.onset.toFixed(3)} 秒`);
  check(a1.peak <= 1 && a1.peak > 0.4, `两路声音叠在一起没有削波（峰值 ${a1.peak.toFixed(3)}）`);
  await panel.screenshot({ path: join(shots, '74-dub-export-done.png'), fullPage: true });

  console.log('\n[保存完整双语视频：快速对齐开着时，中文按倍速慢放（音调不变）铺到全片]');
  await patchRec({ quickRate: QUICK_RATE });
  for (let i = 0; i < 30 && !(await text('dub-full-about')).includes('快速对齐'); i++) await page.waitForTimeout(100);
  check((await text('dub-full-about')).includes('中文按快速对齐的 0.75× 慢放叠上去（音调不变）'), '说明跟着变：中文按快速对齐的倍速叠上去');
  const quick = await exportOnce(QUICK);
  const a2 = quick.measured.audio;
  check(
    a2.hits.length === QUICK.length && a2.hits.every((/** @type {any} */ h) => h.amp > 0.2 && h.others < h.amp / 4),
    `快速对齐 0.75 倍：中文的 d 秒落在视频的 d ÷ 0.75 秒，音高没变（没有变成 0.75 倍的频率）：${a2.hits.map((/** @type {any} */ h) => `${h.at}s 是 ${h.hz}Hz（振幅 ${h.amp.toFixed(2)}，别的 ${h.others.toFixed(2)}）`).join('；')}`,
  );
  check(Math.abs(a2.onset - 0.5 / QUICK_RATE) < 0.04 && Math.abs(a2.tone / DUB_FULL_VIDEO.toneAmp - 0.8) < 0.05, `慢放后第一段音在 ${a2.onset.toFixed(3)} 秒响起（该在 ${(0.5 / QUICK_RATE).toFixed(3)} 秒）；原声仍是 80%（${a2.tone.toFixed(3)}）`);
  check(quick.done.includes('中文 1 段') && quick.measured.video.same.every(Boolean), `一段到底；画面仍和原文件逐像素相同：${quick.done}`);
  await patchRec({ quickRate: null });

  console.log('\n[保存完整双语视频：加快英文（DECISIONS §87）——画面不重新编码、跟着英文快 1.25 倍，原声变速不变调，中文原样不动]');
  await panel.getByTestId('dub-export').getByRole('button', { name: '收起', exact: true }).click();
  await patchRec({ englishRate: ENGLISH_RATE });
  for (let i = 0; i < 30 && !(await text('dub-full-about')).includes('加快英文'); i++) await page.waitForTimeout(100);
  const engAbout = (await text('dub-full-about')).replace(/\s+/g, ' ');
  check(
    engAbout.includes('英文原声按加快英文的 1.25× 快放（音调不变），中文按原速叠上去') && engAbout.includes('不重新编码') && engAbout.includes('整片快到 1.25×'),
    `说明跟着变：画面不重新编码、按 1.25 倍放，英文快放，中文原速：${engAbout.slice(0, 90)}…`,
  );
  const eng = await exportOnce(ENGLISH, 'dub-full-pick', ENGLISH_RATE);
  const ev = eng.measured.video;
  const ea = eng.measured.audio;
  check(Math.abs(ev.duration - 16 / ENGLISH_RATE) < 0.1 && Math.abs(ea.duration - 16 / ENGLISH_RATE) < 0.12, `新文件 ${ev.duration.toFixed(2)} 秒 = 16 ÷ 1.25（声音 ${ea.duration.toFixed(2)} 秒）`);
  check(
    ev.same.length === 4 && ev.same.every(Boolean) && ev.differ.every(Boolean),
    '画面没有重新编码：新文件 0.55 / 3.1 / 7.9 / 12.4 秒的画面和原文件 × 1.25 那一刻的画面逐像素相同',
  );
  check(
    ea.hits.length === ENGLISH.length && ea.hits.every((/** @type {any} */ h) => h.amp > 0.2 && h.others < h.amp / 4) && Math.abs(ea.onset - 0.5) < 0.03,
    `中文原样不动：第一段音仍在 ${ea.onset.toFixed(3)} 秒响起（该在 0.500），各段按原来的时间、原来的音高：${ea.hits.map((/** @type {any} */ h) => `${h.at}s 是 ${h.hz}Hz（${h.amp.toFixed(2)}）`).join('；')}`,
  );
  check(Math.abs(ea.tone / DUB_FULL_VIDEO.toneAmp - 0.8) < 0.06, `原声快放 1.25 倍后仍是 200 Hz（音调不变）、仍按 80%：振幅 ${ea.tone.toFixed(3)}`);
  check(
    eng.done.includes('全片 0:13（原视频 0:16 按 1.25× 快放）') && eng.done.includes('画面原样照搬（不重新编码') && eng.done.includes('英文 1.25×、中文 1×，音调不变'),
    `界面写明新文件多长、怎么变的速：${eng.done}`,
  );

  console.log('\n[保存完整双语视频：整体变速（DECISIONS §87）——手动对齐 + 整体 0.8 倍，两条声音和画面一起慢放，对齐不变]');
  await panel.getByTestId('dub-export').getByRole('button', { name: '收起', exact: true }).click();
  await patchRec({ englishRate: null, overallRate: OVERALL_RATE });
  for (let i = 0; i < 30 && !(await text('dub-full-about')).includes('整体倍速'); i++) await page.waitForTimeout(100);
  check((await text('dub-full-about')).replace(/\s+/g, ' ').includes('整体倍速 0.8× 也一起写进去'), '说明写明整体倍速也写进去、要原速先调回 1×');
  const slow = await exportOnce(OVERALL, 'dub-full-pick', OVERALL_RATE);
  const sv = slow.measured.video;
  const sa = slow.measured.audio;
  check(Math.abs(sv.duration - 20) < 0.1 && sv.same.every(Boolean) && sv.same.length === 4, `整体 0.8 倍：新文件 ${sv.duration.toFixed(2)} 秒，画面逐像素对得上原文件 × 0.8 那一刻`);
  check(
    sa.hits.every((/** @type {any} */ h) => h.amp > 0.2 && h.others < h.amp / 4) && Math.abs(sa.onset - 0.5 / OVERALL_RATE) < 0.04 && Math.abs(sa.tone / DUB_FULL_VIDEO.toneAmp - 0.8) < 0.06,
    `中文各段（含视频 8 秒处的对齐点）都在原来的时刻 ÷ 0.8，音高不变；第一段音在 ${sa.onset.toFixed(3)} 秒（该在 0.625）；原声 200 Hz 仍按 80%（${sa.tone.toFixed(3)}）`,
  );
  check(slow.done.includes('全片 0:20（原视频 0:16 按 0.80× 慢放）') && slow.done.includes('英文 0.8×、中文 0.8×'), `界面写明：${slow.done}`);
  await patchRec({ overallRate: null });
  for (let i = 0; i < 30 && (await text('dub-full-about')).includes('整体倍速'); i++) await page.waitForTimeout(100);

  console.log('\n[保存完整双语视频：不在 YouTube 页面上也能做——"已关联的视频"里直接选]');
  await panel.getByTestId('dub-export').getByRole('button', { name: '收起', exact: true }).click();
  await page.goto('about:blank');
  await panel.getByTestId('dub-item-export').waitFor({ timeout: 10000 });
  check((await panel.getByTestId('dub-full').count()) === 0, '当前标签页不是这个视频：上面没有这个视频的面板');
  const away = await exportOnce(MANUAL, 'dub-item-export');
  const other = (await text('dub-export-other')).replace(/\s+/g, ' ');
  check(
    other.includes('完整双语视频：mock watch') && away.measured.audio.hits.every((/** @type {any} */ h) => h.amp > 0.2) && away.measured.video.same.every(Boolean),
    `没开着这个视频的页面，从"已关联的视频"里选原视频文件照样合成：${other.slice(0, 70)}…`,
  );
  await panel.screenshot({ path: join(shots, '75-dub-export-list.png'), fullPage: true });

  const newReqs = requests.slice(reqStart).filter((r) => !(r.path === '/watch' || r.path === `/media/${ID}.wav` || r.path === '/favicon.ico' || r.path.startsWith('/youtube/v3/videos')));
  check(newReqs.length === 0, `合成完整双语视频没有发出任何网络请求${newReqs.length ? `：${[...new Set(newReqs.map((r) => r.path))].join(', ')}` : ''}`);

  // ── 带上原声字幕（DECISIONS §84）──
  const VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.500 --> 00:00:03.000 align:start position:0%
 
So<00:00:00.900><c> in</c><00:00:01.200><c> college</c>

00:00:03.000 --> 00:00:03.010 align:start position:0%
So in college
 

00:00:03.010 --> 00:00:06.000 align:start position:0%
So in college
I<00:00:03.400><c> was</c><c> a</c><c> government</c><c> major</c>

00:00:06.000 --> 00:00:06.010 align:start position:0%
I was a government major
 

00:00:06.010 --> 00:00:10.000 align:start position:0%
I was a government major
which means 写了很多论文
`;
  const VTT_LINES = ['So in college', 'I was a government major', 'which means 写了很多论文'];
  const VTT_AS_SRT = '1\n00:00:00,500 --> 00:00:03,010\nSo in college\n\n2\n00:00:03,010 --> 00:00:06,010\nI was a government major\n\n3\n00:00:06,010 --> 00:00:10,000\nwhich means 写了很多论文\n';
  /** 新文件里有没有一条字幕轨、里面有没有这几句 */
  const hasSubs = (/** @type {Buffer} */ bytes, /** @type {string[]} */ lines) => bytes.includes(Buffer.from('tx3g')) && bytes.includes(Buffer.from('sbtl')) && lines.every((l) => bytes.includes(Buffer.from(l, 'utf8')));
  /** 在文件对话框里选一个文件（点 testId 这个按钮） */
  const choose = async (/** @type {string} */ testId, /** @type {string | { name: string, mimeType: string, buffer: Buffer }} */ file) => {
    const [chooser] = await Promise.all([panel.waitForEvent('filechooser'), panel.getByTestId(testId).first().click()]);
    await chooser.setFiles(file);
  };
  const collapse = async () => {
    if (await panel.getByTestId('dub-export-other').count()) await panel.getByTestId('dub-export-other').getByRole('button', { name: '收起', exact: true }).click();
    else if (await panel.getByTestId('dub-export').count()) await panel.getByTestId('dub-export').getByRole('button', { name: '收起', exact: true }).click();
  };
  const savedFile = async (/** @type {import('playwright').Download} */ dl) => ({ name: dl.suggestedFilename(), bytes: readFileSync(/** @type {string} */ (await dl.path())) });

  console.log('\n[保存完整双语视频 · 原声字幕：没有字幕来源时停下来问，不悄悄合成一份没字幕的]');
  await collapse();
  await page.goto(`${MOCK}/watch?v=${ID}`);
  await panel.getByTestId('dub-full').waitFor({ timeout: 10000 });
  const subsReqStart = requests.length;
  await setSubs(true);
  await pick(SOURCE);
  await phase('need-subs', 40000);
  const need = (await text('dub-export-need-subs')).replace(/\s+/g, ' ');
  check(
    need.includes('没有找到字幕') && need.includes('原视频文件里没有嵌着字幕') && need.includes('从 YouTube 页面也没取到') && (await panel.getByTestId('dub-export-subs-skip').count()) === 1,
    `原视频文件里没有字幕、这个页面上也取不到：停下来说明原因，给出"选字幕文件 / 不带字幕继续 / 取消"：${need.slice(0, 90)}…`,
  );
  // 选了一个不是字幕的文件：留在原地，说明哪里不对
  await choose('dub-export-subs-pick', { name: 'notes.srt', mimeType: 'application/x-subrip', buffer: Buffer.from('just some notes\nno timings here') });
  await panel.getByTestId('dub-export-need-subs').filter({ hasText: '用不了' }).waitFor({ timeout: 10000 });
  check((await text('dub-export-need-subs')).includes('「notes.srt」用不了') && (await text('dub-export-need-subs')).includes('一句字幕都没读到'), '选的文件不是字幕：说明读不出来，仍然等你决定');
  // 选一个 YouTube 自动字幕导出的 .vtt（每句带着上一句、夹着过渡句）
  const [subDl] = await Promise.all([panel.waitForEvent('download', { timeout: 60000 }), choose('dub-export-subs-pick', { name: 'talk.en.vtt', mimeType: 'text/vtt', buffer: Buffer.from(VTT, 'utf8') })]);
  await phase('done');
  const withFile = await savedFile(subDl);
  const subsLine = (await text('dub-export-subs')).replace(/\s+/g, ' ');
  check(hasSubs(withFile.bytes, VTT_LINES), `选了字幕文件后接着合成：新文件里有一条字幕轨，三句都在（${withFile.name}，${withFile.bytes.length} 字节）`);
  check(
    subsLine.includes('原声字幕：3 句') && subsLine.includes('你选的字幕文件（talk.en.vtt）') && subsLine.includes('可以关') && subsLine.includes('另存字幕（.srt）'),
    `界面写明字幕有几句、从哪来、哪些播放器认：${subsLine.slice(0, 80)}…`,
  );
  const [srtDl] = await Promise.all([panel.waitForEvent('download', { timeout: 15000 }), panel.getByTestId('dub-export-srt').click()]);
  const srt = await savedFile(srtDl);
  check(srt.name === 'mock watch_双语完整版.srt' && srt.bytes.toString('utf8') === VTT_AS_SRT, `"另存字幕（.srt）"：和视频同名；滚动字幕的重复去掉了，一句接一句：${JSON.stringify(srt.bytes.toString('utf8').slice(0, 60))}…`);
  await panel.screenshot({ path: join(shots, '76-dub-export-subs.png'), fullPage: true });

  console.log('\n[保存完整双语视频 · 原声字幕：原视频文件里嵌着字幕轨时直接用它]');
  await collapse();
  check((await text('dub-full-subs-chosen')).includes('talk.en.vtt') && (await text('dub-full-subs-chosen')).includes('3 句'), '刚才选的字幕文件记着（这次打开侧边栏期间），可以不用');
  await panel.getByTestId('dub-full-subs-drop').click();
  await panel.getByTestId('dub-full-subs-auto').waitFor({ timeout: 5000 });
  // 拿上一步合成出来的文件当原视频：它里面嵌着一条字幕轨
  const [embDl] = await Promise.all([panel.waitForEvent('download', { timeout: 60000 }), pick({ name: 'with-subs.mp4', mimeType: 'video/mp4', buffer: withFile.bytes })]);
  await phase('done');
  const emb = await savedFile(embDl);
  const embLine = (await text('dub-export-subs')).replace(/\s+/g, ' ');
  check(hasSubs(emb.bytes, VTT_LINES) && embLine.includes('原声字幕：3 句') && embLine.includes('原视频文件里嵌着的字幕'), `没选字幕文件、原视频文件里有字幕轨：直接用它，不去 YouTube 取：${embLine.slice(0, 60)}…`);

  console.log('\n[保存完整双语视频 · 原声字幕：这一次不带；事先选好字幕文件]');
  await collapse();
  await pick(SOURCE);
  await phase('need-subs', 40000);
  const [skipDl] = await Promise.all([panel.waitForEvent('download', { timeout: 60000 }), panel.getByTestId('dub-export-subs-skip').click()]);
  await phase('done');
  const skipped = await savedFile(skipDl);
  check(!skipped.bytes.includes(Buffer.from('tx3g')) && (await text('dub-export-no-subs')).includes('没有带字幕') && (await exportSubsSetting()) === true, '点"不带字幕，继续合成"：这一份不带，设置不变');
  await collapse();
  await choose('dub-full-subs-pick', { name: 'broken.srt', mimeType: 'application/x-subrip', buffer: Buffer.from('{"events":[]}') });
  await panel.getByTestId('dub-full-subs-problem').waitFor({ timeout: 10000 });
  check((await text('dub-full-subs-problem')).includes('不是 .srt 或 .vtt 格式'), '事先选的字幕文件格式不对：当场说明');
  await choose('dub-full-subs-pick', { name: 'talk.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(VTT_AS_SRT, 'utf8') });
  await panel.getByTestId('dub-full-subs-chosen').waitFor({ timeout: 10000 });
  const [preDl] = await Promise.all([panel.waitForEvent('download', { timeout: 60000 }), pick(SOURCE)]);
  await phase('done');
  const pre = await savedFile(preDl);
  check(hasSubs(pre.bytes, VTT_LINES) && (await text('dub-export-subs')).includes('你选的字幕文件（talk.srt）'), '事先选好 .srt 再选原视频文件：不用再问，直接带上');
  const subReqs = requests.slice(subsReqStart).filter((r) => !(r.path === '/watch' || r.path === `/media/${ID}.wav` || r.path === '/favicon.ico' || r.path.startsWith('/youtube/v3/videos')));
  check(subReqs.length === 0, `用字幕文件、嵌着的字幕时没有发出任何网络请求${subReqs.length ? `：${[...new Set(subReqs.map((r) => r.path))].join(', ')}` : ''}`);
  await collapse();
  await panel.getByTestId('dub-full-subs-drop').click();

  console.log('\n[保存完整双语视频 · 原声字幕：开着这个视频的 YouTube 页面时，取它自带的原声字幕]');
  const CC_ID = 'ccDubSubs007';
  const [ccPage] = await Promise.all([context.waitForEvent('page'), panel.evaluate((u) => /** @type {any} */ (globalThis).chrome.tabs.create({ url: u, active: true }), `${MOCK}/watch?v=${CC_ID}`)]);
  ccPage.on('pageerror', (e) => consoleErrors.push(`dub subs pageerror: ${e.message}`));
  ccPage.on('console', (m) => m.type() === 'error' && consoleErrors.push(`dub subs: ${m.text()}`));
  await ccPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1, null, { timeout: 20000 });
  await panel.getByTestId('dub-pick').waitFor({ timeout: 10000 });
  await panel.getByTestId('dub-file').setInputFiles(M4A);
  await panel.getByTestId('dub-done').waitFor({ timeout: 15000 });
  await panel.getByTestId('dub-full-subs-auto').waitFor({ timeout: 10000 });
  const ccReqStart = requests.length;
  const nativeBefore = await ccPage.evaluate(() => document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'));
  const [ccDl] = await Promise.all([panel.waitForEvent('download', { timeout: 90000 }), pick(SOURCE)]);
  await phase('done');
  const cc = await savedFile(ccDl);
  const ccLine = (await text('dub-export-subs')).replace(/\s+/g, ' ');
  const CC_LINES = ['so in college', 'i was a government major', 'which means i had to write a lot of papers', 'thank you'];
  check(hasSubs(cc.bytes, CC_LINES) && !cc.bytes.includes(Buffer.from('上大学的时候', 'utf8')), '新文件里的字幕轨是这个视频的英文原声字幕（四句都在），不是中文那一条');
  check(
    ccLine.includes('原声字幕：4 句') && ccLine.includes('取自 YouTube 上这个视频的字幕（English (auto-generated)）'),
    `界面写明取的是哪一条：${ccLine.slice(0, 70)}…`,
  );
  const tt = requests.slice(ccReqStart).filter((r) => r.path === '/api/timedtext' && r.headers['x-mock-player'] !== '1');
  check(
    tt.length >= 1 && tt.every((r) => r.query.v === CC_ID && r.query.lang === 'en' && r.query.kind === 'asr' && !!r.query.pot && !r.query.tlang),
    `字幕是复用播放器自己的字幕请求取的：只取了英文自动字幕这一种，带着播放器的令牌，没用自动翻译（${tt.length} 次）`,
  );
  const nativeAfter = await ccPage.evaluate(() => ({ pressed: document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'), paused: /** @type {HTMLVideoElement} */ (document.querySelector('video')).paused, t: /** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime }));
  check(nativeBefore === 'false' && nativeAfter.pressed === 'false' && nativeAfter.paused && nativeAfter.t === 0, '取完之后播放器的原生字幕关回去了（原来就是关着的），视频没有被播放');
  const ccOther = requests.slice(ccReqStart).filter((r) => !(r.path === '/watch' || r.path === '/api/timedtext' || r.path.startsWith('/media/') || r.path === '/favicon.ico' || r.path.startsWith('/youtube/v3/videos')));
  check(ccOther.length === 0, `除了那一处字幕请求，没有别的网络请求${ccOther.length ? `：${[...new Set(ccOther.map((r) => r.path))].join(', ')}` : ''}`);
  await panel.screenshot({ path: join(shots, '77-dub-export-youtube-subs.png'), fullPage: true });
  await collapse();
  await panel.getByTestId('dub-remove').click();
  await panel.getByTestId('dub-remove-yes').click();
  await panel.getByTestId('dub-pick').waitFor({ timeout: 10000 });
  await ccPage.close();
  await page.bringToFront();
  await panel.evaluate((u) => /** @type {any} */ (globalThis).chrome.tabs.query({ url: u }).then((/** @type {any[]} */ tabs) => /** @type {any} */ (globalThis).chrome.tabs.update(tabs[0].id, { active: true })), `${MOCK}/watch?v=${ID}*`);
  await panel.getByTestId('dub-remove').waitFor({ timeout: 10000 });

  // 收尾：移除配音，关掉页面
  await panel.getByTestId('dub-remove').click();
  await panel.getByTestId('dub-remove-yes').click();
  await panel.getByTestId('dub-pick').waitFor({ timeout: 10000 });
  await page.close();
  await panel.bringToFront();
}
