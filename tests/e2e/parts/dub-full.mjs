// @ts-check
// 中文配音："保存完整双语视频"（DECISIONS §83）。你选原视频文件（MP4）→ 侧边栏里离线合成（不播放）→ 自动下载。
// 检查合成出来的文件本身：画面和原文件逐像素一样、时长是整片；原声按 80%；中文按开头的偏移和对齐点落在该在的时间上
// （快速对齐时按倍速、音调不变）；用时远小于视频时长；不在 YouTube 页面上也能做；全程没有网络请求。
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

  console.log('\n[保存完整双语视频：入口在「配音」页，不用开启配音、不用播放]');
  await panel.getByTestId('dub-full').waitFor({ timeout: 10000 });
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
  const exportOnce = async (/** @type {{ at: number, hz: number }[]} */ expect, testId = 'dub-full-pick') => {
    const wallStart = Date.now();
    const [dl] = await Promise.all([panel.waitForEvent('download', { timeout: 60000 }), pick(SOURCE, testId)]);
    const wallMs = Date.now() - wallStart;
    await phase('done');
    const name = dl.suggestedFilename();
    const bytes = readFileSync(/** @type {string} */ (await dl.path()));
    const measured = /** @type {any} */ (
      await page.evaluate(
        async ([outB64, srcB64, expectJson, toneHz]) => {
          const expect = /** @type {{ at: number, hz: number }[]} */ (JSON.parse(/** @type {string} */ (expectJson)));
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
          for (const at of [0.5, 3.1, 8.0, 12.4, 15.8]) {
            const x = await frame(a, at);
            const y = await frame(b, at);
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
        [bytes.toString('base64'), sourceB64, JSON.stringify(expect), DUB_FULL_VIDEO.toneHz],
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

  // 收尾：移除配音，关掉页面
  await panel.getByTestId('dub-export-other').getByRole('button', { name: '收起', exact: true }).click();
  await page.goto(`${MOCK}/watch?v=${ID}`);
  await panel.getByTestId('dub-remove').waitFor({ timeout: 10000 });
  await panel.getByTestId('dub-remove').click();
  await panel.getByTestId('dub-remove-yes').click();
  await panel.getByTestId('dub-pick').waitFor({ timeout: 10000 });
  await page.close();
  await panel.bringToFront();
}
