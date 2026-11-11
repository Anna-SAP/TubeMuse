// @ts-check
// 片段录制与 Capture：YouTube，然后是小红书（含发布时间、收藏）、X、Instagram、抖音、酷播。
// 这几个站放在同一组里按顺序跑：Capture 的序号是跨站连着排的，后面各站的检查接着前面的序号。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, MOCK, shots } from '../harness.mjs';
import { DOUYIN_NEXT, DOUYIN_SEARCH_TITLE, DOUYIN_VIDEO } from '../douyin-pages.mjs';
import { IG_FEED_POST, IG_PLAIN_POST } from '../ig-pages.mjs';
import { KUBB_AD_SECONDS, KUBB_EPISODE, KUBB_MOVIE, KUBB_SHOW } from '../kubb-pages.mjs';
import { X_FEED_POST, X_GIF_POST, X_POST, X_TEXT_POST } from '../x-pages.mjs';
import { XHS_N1, XHS_N2, XHS_N3, XHS_N4, XHS_UID, XHS_V1 } from '../xhs-pages.mjs';

/** @param {import('../harness.mjs').Harness} t */
export async function clips(t) {
  const { context, sw, options, requests, consoleErrors } = t;
  const panel = await t.openPanel();

  // ───────────────────────── 片段录制 ─────────────────────────
  console.log('\n[片段录制：设置]');
  await options.bringToFront();
  await options.reload();
  await options.locator('#clips').waitFor();
  check(((await options.locator('#clips').textContent()) ?? '').includes('14. 片段录制') && (await options.getByTestId('clips-enabled').isChecked()), '设置页有"片段录制"一节（多语字幕之后顺延为 14），默认启用');
  const xhsSection = (await options.locator('#xhs').textContent()) ?? '';
  check(
    xhsSection.includes('15. 小红书') && (await options.getByTestId('xhs-enabled').isChecked()) && (await options.getByTestId('xhs-show-time').isChecked()) && (await options.getByTestId('xhs-show-save').isChecked()),
    '设置页有"小红书"一节（片段录制之后为 15），默认启用、显示时间与收藏按钮',
  );
  check(((await options.locator('#data').textContent()) ?? '').includes('17. 数据'), '"数据"一节顺延为 17');
  check(((await options.locator('#email').textContent()) ?? '').includes('16. eMails') && (await options.getByTestId('email-enabled').isChecked()), '设置页有"eMails"一节（小红书之后为 16），默认启用');
  const sw2 = context.serviceWorkers()[0] ?? sw;
  const manifest2 = await sw2.evaluate(() => /** @type {any} */ (globalThis).chrome.runtime.getManifest());
  check(manifest2.commands?.['toggle-clip-recording']?.suggested_key?.default === 'Alt+Shift+R', '快捷键 Alt+Shift+R 开始 / 停止录制');
  check(!['downloads', 'tabCapture', 'offscreen', 'desktopCapture'].some((p) => manifest2.permissions.includes(p)), `片段录制没有新增权限：${manifest2.permissions.join(', ')}`);

  /** 在页面里解析录到的片段：文件头、时长、画面尺寸、声音响度、画面底部（字幕处）与上部的亮像素数 */
  const analyzeClip = async (/** @type {import('playwright').Page} */ page, /** @type {string} */ file) => {
    const b64 = readFileSync(file).toString('base64');
    return page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes]);
      const url = URL.createObjectURL(blob);
      const v = document.createElement('video');
      v.muted = true;
      v.src = url;
      await new Promise((resolve, reject) => {
        v.onloadedmetadata = resolve;
        v.onerror = () => reject(new Error('片段无法播放'));
      });
      // MediaRecorder 录的 WebM 不写总时长：跳到末尾让浏览器算出来
      if (!Number.isFinite(v.duration)) {
        v.currentTime = 1e9;
        await new Promise((r) => (v.onseeked = r));
      }
      const duration = v.duration;
      v.currentTime = Math.min(duration / 2, 1);
      await new Promise((r) => (v.onseeked = r));
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
      g.drawImage(v, 0, 0);
      const bright = (/** @type {number} */ y0, /** @type {number} */ y1) => {
        const d = g.getImageData(0, Math.floor(c.height * y0), c.width, Math.floor(c.height * (y1 - y0))).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 600) n++;
        return n;
      };
      // 文件头里没有声音轨（声音数据可能还在文件里，但播放器读不到）时解不出声音：响度记 0
      const ac = new AudioContext();
      let rms = 0;
      try {
        const ch = (await ac.decodeAudioData(await blob.arrayBuffer())).getChannelData(0);
        let s = 0;
        for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
        rms = Math.sqrt(s / ch.length);
      } catch {
        // 没有可解码的声音轨
      }
      URL.revokeObjectURL(url);
      void ac.close();
      return { head: Array.from(bytes.slice(0, 12)), duration, width: v.videoWidth, height: v.videoHeight, rms, bottomBright: bright(0.8, 0.95), topBright: bright(0.05, 0.6) };
    }, b64);
  };
  /** MP4（第 4–8 字节是 ftyp）或 WebM（EBML 头 1A 45 DF A3） */
  const container = (/** @type {number[]} */ head) => (String.fromCharCode(...head.slice(4, 8)) === 'ftyp' ? 'mp4' : head.slice(0, 4).join(',') === '26,69,223,163' ? 'webm' : 'unknown');
  const clipLog = () => panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('clipLog').then((/** @type {any} */ r) => r.clipLog ?? []));
  const clipStatus = panel.getByTestId('clip-status');
  const recordedSec = async () => parseTimecodeText((await panel.getByTestId('clip-recorded').textContent()) ?? '');
  const parseTimecodeText = (/** @type {string} */ t) => t.split(':').reduce((a, x) => a * 60 + Number(x), 0);

  console.log('\n[片段录制：自由录制 → 暂停 / 广告时自动暂停 → 停止并保存 → 浏览器存进下载文件夹 → 记一笔]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '片段', exact: true }).click();
  const [clipPage] = await Promise.all([
    context.waitForEvent('page'),
    panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}/watch?v=clipFree0001`),
  ]);
  clipPage.on('pageerror', (e) => consoleErrors.push(`clip watch pageerror: ${e.message}`));
  clipPage.on('console', (m) => m.type() === 'error' && consoleErrors.push(`clip watch: ${m.text()}`));
  await clipPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await clipPage.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  const clipPlayerHtml = () => clipPage.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).outerHTML.replace(/ class="[^"]*"/, ''));
  const playerBefore = await clipPlayerHtml();
  const requestsBeforeClip = requests.length;
  const freeStartedAt = Date.now();
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  const badge = await sw2.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [t] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes('clipFree0001'));
    return c.action.getBadgeText({ tabId: t.id });
  });
  check(badge === 'REC', `录制中工具栏图标显示 REC（实际："${badge}"）`);
  await clipPage.waitForTimeout(2500);
  await clipPage.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).pause());
  await clipStatus.filter({ hasText: '视频已暂停' }).waitFor({ timeout: 5000 });
  const atPause = await recordedSec();
  await clipPage.waitForTimeout(1500);
  check((await recordedSec()) === atPause, `视频暂停时录制自动暂停、不计时（停在 ${atPause} 秒）`);
  // 模拟广告：YouTube 播广告时给播放器加 ad-showing
  await clipPage.evaluate(() => {
    /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.add('ad-showing');
    return /** @type {HTMLVideoElement} */ (document.querySelector('video')).play();
  });
  await clipStatus.filter({ hasText: '广告中' }).waitFor({ timeout: 5000 });
  await clipPage.waitForTimeout(1500);
  check((await recordedSec()) === atPause, '广告期间自动暂停，不录广告');
  await clipPage.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.remove('ad-showing'));
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 5000 });
  await clipPage.waitForTimeout(1500);
  await panel.screenshot({ path: join(shots, '23-clip-recording.png'), fullPage: true });
  const [freeDl] = await Promise.all([clipPage.waitForEvent('download', { timeout: 15000 }), panel.getByTestId('clip-stop').click()]);
  const freeWall = (Date.now() - freeStartedAt) / 1000;
  const freeName = freeDl.suggestedFilename();
  check(/^mock watch_00m0\ds-00m\d\ds\.(mp4|webm)$/.test(freeName), `停止后直接交给浏览器保存，文件名带标题与起止时间：${freeName}`);
  const free = await analyzeClip(clipPage, /** @type {string} */ (await freeDl.path()));
  check(container(free.head) === freeName.split('.').pop(), `文件格式与扩展名一致（${container(free.head)}）`);
  check(free.duration > 2.5 && free.duration < freeWall - 2, `片段 ${free.duration.toFixed(1)} 秒：只含播放的部分，暂停与广告的 ${(freeWall - free.duration).toFixed(1)} 秒没有录进去`);
  check(free.width === 1280 && free.height === 720, `有画面轨（只有声音的视频按默认 1280×720 输出：${free.width}×${free.height}）`);
  check(free.rms > 0.02, `录到了这个视频的声音（响度 ${free.rms.toFixed(3)}）`);
  check(free.bottomBright === 0, '没开字幕烧录：画面里没有多出字幕');
  await panel.getByTestId('clip-saved').waitFor({ timeout: 5000 });
  check(((await panel.getByTestId('clip-ready').textContent()) ?? '').includes(freeName), '侧边栏显示存好的文件名，可以再存一次');
  await panel.getByTestId('clip-log').waitFor({ timeout: 5000 });
  const log1 = await clipLog();
  check(log1.length === 1 && log1[0].fileName === freeName && log1[0].videoId === 'clipFree0001' && log1[0].mode === 'free' && !('blob' in log1[0]), '"最近录过的片段"记下文件名、时间段与大小（不存视频本身）');
  check(JSON.stringify(await clipPlayerHtml()) === JSON.stringify(playerBefore), '录制没有往页面里加任何元素，播放器原样未动');
  check(requests.slice(requestsBeforeClip).every((r) => r.path.startsWith('/media/')), '录制与保存不发任何网络请求（只有播放器自己加载媒体）');

  // 2026-11-02 用户报告：片头广告中开始录，存下的 MP4 没有声音。录音机开始后先暂停了一阵，
  // Chrome 的 MP4 封装把声音排在画面之后，写文件头时还没有声音轨——声音数据在文件里，播放器却读不到。
  // 文件头随第一个分片写出（一片约 101 帧；mock 视频只有声音，画布约 10 帧/秒，一片约 10 秒）：
  // 开头等待的时长超过一片、之后又录满一片才会复现（修复前的构建：等 13 秒、录 12 秒 → 文件头只有画面轨）
  console.log('\n[片段录制：片头广告中开始 → 广告结束才真正开录 → 文件里有声音]');
  await clipPage.goto(`${MOCK}/watch?v=clipPreroll1`);
  await clipPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await clipPage.evaluate(() => {
    /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.add('ad-showing');
    return /** @type {HTMLVideoElement} */ (document.querySelector('video')).play();
  });
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '广告中' }).waitFor({ timeout: 5000 });
  await clipPage.waitForTimeout(13000);
  await clipPage.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.remove('ad-showing'));
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 5000 });
  await clipPage.waitForTimeout(12000);
  const [prerollDl] = await Promise.all([clipPage.waitForEvent('download', { timeout: 15000 }), panel.getByTestId('clip-stop').click()]);
  const preroll = await analyzeClip(clipPage, /** @type {string} */ (await prerollDl.path()));
  check(preroll.duration > 10.5 && preroll.duration < 16,`只录了广告之后的部分（${preroll.duration.toFixed(1)} 秒）`);
  check(preroll.rms > 0.02, `开始时等了 13 秒广告，文件里仍有声音（响度 ${preroll.rms.toFixed(3)}）`);

  console.log('\n[片段录制：按时间段截取 → 自动跳到起点、到终点自动停；字幕烧进画面]');
  await clipPage.goto(`${MOCK}/watch?v=clipRange001`);
  await clipPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  // 播放器里显示着一行原生字幕（YouTube 的字幕结构）
  await clipPage.evaluate(() => {
    const win = document.createElement('div');
    win.className = 'caption-window';
    win.style.cssText = 'position:absolute;left:0;right:0;bottom:60px;text-align:center';
    const line = document.createElement('span');
    line.className = 'caption-visual-line';
    line.textContent = 'WWWW MMMM 字幕烧录测试';
    win.append(line);
    /** @type {HTMLElement} */ (document.getElementById('movie_player')).append(win);
  });
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  /**
   * 开关字幕烧录。不用 check() / uncheck()：它们点完立刻核对，而这个勾选框跟着设置走，设置写进存储之前，
   * 侧边栏每秒一次的状态刷新会把它弹回旧值，两者赛跑（2026-11-06 CI 上失败过）。点完先等设置写进去，再等勾选框到位。
   */
  const setClipBurn = async (/** @type {boolean} */ on) => {
    await panel.getByTestId('clip-burn').click();
    await panel.waitForFunction(
      (want) => /** @type {any} */ (globalThis).chrome.storage.local.get('settings').then((/** @type {any} */ r) => r.settings?.clips?.burnSubtitles === want),
      on,
      { timeout: 5000 },
    );
    await panel.getByTestId('clip-burn').and(panel.locator(on ? ':checked' : ':not(:checked)')).waitFor({ timeout: 5000 });
  };
  await setClipBurn(true);
  await panel.getByTestId('clip-mode-range').click();
  await panel.getByTestId('clip-start-at').fill('0:02');
  await panel.getByTestId('clip-end-at').fill('0:05');
  const [rangeDl] = await Promise.all([clipPage.waitForEvent('download', { timeout: 20000 }), panel.getByTestId('clip-start').click()]);
  const rangeName = rangeDl.suggestedFilename();
  check(/_00m02s-00m05s\.(mp4|webm)$/.test(rangeName), `到终点自动停止并保存：${rangeName}`);
  const range = await analyzeClip(clipPage, /** @type {string} */ (await rangeDl.path()));
  check(range.duration > 2.5 && range.duration < 3.8, `片段 ${range.duration.toFixed(2)} 秒（截取 0:02–0:05）`);
  check(range.rms > 0.02, '时间段片段也有声音');
  check(range.bottomBright > 200 && range.topBright === 0, `字幕烧进了画面底部（亮像素 ${range.bottomBright}），画面其他地方没有多出东西`);
  const log2 = await clipLog();
  check(log2.length === 3 && log2[0].mode === 'range' && log2[0].burned === true && log2[0].start === 2 && log2[0].end === 5, '记录里写明是时间段、带字幕');
  await setClipBurn(false);

  console.log('\n[片段录制：关掉"停止后直接保存" → 先留在内存里，点保存才存；可以丢弃]');
  await panel.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const { settings } = await c.storage.local.get('settings');
    await c.storage.local.set({ settings: { ...settings, clips: { ...settings.clips, autoSave: false } } });
  });
  await clipPage.goto(`${MOCK}/watch?v=clipManual01`);
  await clipPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await clipPage.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  await panel.getByRole('radio', { name: '自由录制' }).click();
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  await clipPage.waitForTimeout(1500);
  /** @type {import('playwright').Download[]} */
  const stray = [];
  clipPage.on('download', (d) => stray.push(d));
  await panel.getByRole('button', { name: '■ 停止', exact: true }).click();
  await clipStatus.filter({ hasText: '还没保存' }).waitFor({ timeout: 5000 });
  await clipPage.waitForTimeout(1000);
  check(stray.length === 0, '停止后没有自动保存，侧边栏提示"还没保存"');
  const [manualDl] = await Promise.all([clipPage.waitForEvent('download', { timeout: 5000 }), panel.getByTestId('clip-save').click()]);
  check(/^mock watch_.*\.(mp4|webm)$/.test(manualDl.suggestedFilename()), `点"保存到本地"才交给浏览器保存：${manualDl.suggestedFilename()}`);
  await panel.getByRole('button', { name: '释放内存' }).click();
  await panel.getByTestId('clip-ready').waitFor({ state: 'detached', timeout: 5000 });
  check(true, '"释放内存"后片段从内存里清掉');
  await panel.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const { settings } = await c.storage.local.get('settings');
    await c.storage.local.set({ settings: { ...settings, clips: { ...settings.clips, autoSave: true } } });
  });

  console.log('\n[片段录制：站内换视频（YouTube 是单页应用）→ 这一段自动结束并保存]');
  await clipPage.goto(`${MOCK}/watch?v=clipSpa00001`);
  await clipPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await clipPage.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  await clipPage.waitForTimeout(1500);
  const [spaDl] = await Promise.all([clipPage.waitForEvent('download', { timeout: 10000 }), clipPage.evaluate(() => history.pushState(null, '', '/watch?v=clipOther001'))]);
  check(/^mock watch_.*\.(mp4|webm)$/.test(spaDl.suggestedFilename()), `换到别的视频时自动结束这一段并保存：${spaDl.suggestedFilename()}`);
  await panel.getByTestId('clip-ready').filter({ hasText: '切到了别的视频' }).waitFor({ timeout: 5000 });
  check(true, '侧边栏说明这一段为什么结束');
  await panel.screenshot({ path: join(shots, '24-clip-panel.png'), fullPage: true });

  console.log('\n[片段：Capture → 按视频的真实尺寸存无损 PNG，由侧边栏交给浏览器；录制中也能截；广告时不截；不动页面、不发请求]');
  await clipPage.goto(`${MOCK}/watch?v=clipShot0001`);
  await clipPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30000 });
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  // mock 播放页的视频只有声音：现场用画布录一段 1920×1080 的视频当片源（左红右蓝），再把播放器缩到 320×180，
  // 这样截出来是 1920×1080 才算"按真实尺寸"，不是页面上显示的尺寸
  await clipPage.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 1920;
    c.height = 1080;
    const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    let n = 0;
    const paint = () => {
      g.fillStyle = '#e00000';
      g.fillRect(0, 0, 960, 1080);
      g.fillStyle = '#0000e0';
      g.fillRect(960, 0, 960, 1080);
      // 每帧动一点，画布才持续出帧
      g.fillStyle = '#e00000';
      g.fillRect(960, 0, 2, 2 + (n++ % 8));
    };
    paint();
    const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm;codecs=vp8' });
    /** @type {Blob[]} */
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start();
    const timer = setInterval(paint, 50);
    await new Promise((r) => setTimeout(r, 1500));
    clearInterval(timer);
    rec.stop();
    await stopped;
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.style.cssText = 'width:320px;height:180px';
    v.muted = true;
    const loaded = new Promise((r) => (v.onloadeddata = r));
    v.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    await loaded;
    await v.play();
    await new Promise((r) => setTimeout(r, 400));
    v.pause();
  });
  const shotVideo = await clipPage.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    const r = v.getBoundingClientRect();
    return { videoWidth: v.videoWidth, videoHeight: v.videoHeight, shownWidth: Math.round(r.width), shownHeight: Math.round(r.height) };
  });
  check(shotVideo.videoWidth === 1920 && shotVideo.shownWidth === 320, `片源 ${shotVideo.videoWidth}×${shotVideo.videoHeight}，页面上只显示 ${shotVideo.shownWidth}×${shotVideo.shownHeight}`);
  /** 读 PNG 文件：签名、文件头里的宽高位深，再在页面里解码，取左右两边的像素 */
  const readPng = async (/** @type {string} */ file, page = clipPage) => {
    const b = readFileSync(file);
    const pixels = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
      g.drawImage(bmp, 0, 0);
      const at = (/** @type {number} */ x) => Array.from(g.getImageData(x, Math.floor(bmp.height / 2), 1, 1).data);
      return { left: at(Math.floor(bmp.width / 4)), right: at(Math.floor((bmp.width * 3) / 4)) };
    }, b.toString('base64'));
    return { signature: b.subarray(0, 8).toString('hex'), width: b.readUInt32BE(16), height: b.readUInt32BE(20), depth: b[24], ...pixels };
  };
  /** WAV 没有画面，截不了：现场录一段左红右蓝的 720×1280 视频换给播放器（页面上显示的尺寸不变），放一下再暂停 */
  const useFramedVideo = (/** @type {import('playwright').Page} */ page, /** @type {string} */ selector) =>
    page.evaluate(async (sel) => {
      const c = document.createElement('canvas');
      c.width = 720;
      c.height = 1280;
      const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
      let n = 0;
      const paint = () => {
        g.fillStyle = '#e00000';
        g.fillRect(0, 0, 360, 1280);
        g.fillStyle = '#0000e0';
        g.fillRect(360, 0, 360, 1280);
        // 每帧动一点，画布才持续出帧
        g.fillStyle = '#e00000';
        g.fillRect(360, 0, 2, 2 + (n++ % 8));
      };
      paint();
      const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm;codecs=vp8' });
      /** @type {Blob[]} */
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      const stopped = new Promise((r) => (rec.onstop = r));
      rec.start();
      const timer = setInterval(paint, 50);
      await new Promise((r) => setTimeout(r, 1500));
      clearInterval(timer);
      rec.stop();
      await stopped;
      const v = /** @type {HTMLVideoElement} */ (document.querySelector(sel));
      v.muted = true;
      const loaded = new Promise((r) => (v.onloadeddata = r));
      v.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
      await loaded;
      await v.play();
      await new Promise((r) => setTimeout(r, 400));
      v.pause();
    }, selector);
  /** @type {import('playwright').Download[]} */
  const pageDownloads = [];
  clipPage.on('download', (d) => pageDownloads.push(d));
  const shotPlayerBefore = await clipPlayerHtml();
  const requestsBeforeShot = requests.length;
  const captureSeq = () => panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('captureSeq').then((/** @type {any} */ r) => r.captureSeq));
  const capture = () => Promise.all([panel.waitForEvent('download', { timeout: 15000 }), panel.getByTestId('clip-capture').click()]).then(([d]) => d);

  const shot1 = await capture();
  check(/^mock watch_00-00-0\d-\d{3}_original_00001\.png$/.test(shot1.suggestedFilename()), `文件名：标题_时间戳_original_序号.png：${shot1.suggestedFilename()}`);
  const png1 = await readPng(/** @type {string} */ (await shot1.path()));
  check(png1.signature === '89504e470d0a1a0a' && png1.depth === 8, 'PNG 文件头正确，8 位无损');
  check(png1.width === 1920 && png1.height === 1080, `按视频的真实尺寸存，不是页面上显示的尺寸：${png1.width}×${png1.height}`);
  check(png1.left[0] > 150 && png1.left[2] < 90 && png1.right[2] > 150 && png1.right[0] < 90, `存下的是视频这一帧，左红右蓝，不是黑帧（左 ${png1.left.join(',')}，右 ${png1.right.join(',')}）`);
  const shotSaved = ((await panel.getByTestId('clip-capture-saved').textContent()) ?? '');
  check(shotSaved.includes(shot1.suggestedFilename()) && shotSaved.includes('1920×1080'), '侧边栏写明文件名和实际尺寸');
  await panel.screenshot({ path: join(shots, '24b-clip-capture.png'), fullPage: true });

  // 连点第二次：序号递增。这里只能证明序号和文件；"不被 Chrome 拦"要真实下载限流才测得出（Playwright 接管下载时不限流），见 DECISIONS §50
  const shot2 = await capture();
  check(shot2.suggestedFilename().endsWith('_original_00002.png'), `再点一次序号递增：${shot2.suggestedFilename()}`);
  check(pageDownloads.length === 0, '下载算在侧边栏上，不算在 YouTube 页面上（从页面连续下载，第二次起 Chrome 会拦）');

  await clipPage.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.add('ad-showing'));
  await panel.getByTestId('clip-capture').click();
  await panel.getByText('正在播广告：广告结束后再截图').waitFor({ timeout: 5000 });
  check((await captureSeq()) === 2, '广告时不截图，说明原因，不占序号');
  await clipPage.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.remove('ad-showing'));

  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '视频已暂停' }).waitFor({ timeout: 10000 });
  const shot3 = await capture();
  check(shot3.suggestedFilename().endsWith('_original_00003.png'), `录制中也能截：${shot3.suggestedFilename()}`);
  check((await panel.getByTestId('clip-live').count()) === 1 && (await clipStatus.textContent())?.includes('视频已暂停') === true, '截图不打断正在进行的录制');
  await panel.getByTestId('clip-stop').click();
  await panel.getByTestId('clip-live').waitFor({ state: 'detached', timeout: 5000 });

  check(JSON.stringify(await clipPlayerHtml()) === JSON.stringify(shotPlayerBefore), '截图没有往页面里加任何元素，播放器原样未动');
  check(requests.slice(requestsBeforeShot).every((r) => r.path.startsWith('/media/')), '截图与保存不发任何网络请求');
  await clipPage.close();
  await panel.bringToFront();

  // ───────────────────────── 小红书 ─────────────────────────
  console.log('\n[小红书：博主主页 → 卡片作者那一行显示发布时间；卡片高度不变，不压住下面那张]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '小红书' }).click();
  check(((await panel.getByTestId('xhs-empty').textContent()) ?? '').includes('还没有收藏'), '侧边栏"小红书"页：还没有收藏时说明怎么开始');
  const xhsReqStart = requests.length;
  const xhsProfileUrl = `${MOCK}/xhs/user/profile/${XHS_UID}?xsec_token=ABprofile%3D&xsec_source=pc_feed`;
  const [xhs] = await Promise.all([context.waitForEvent('page'), panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), xhsProfileUrl)]);
  xhs.on('pageerror', (e) => consoleErrors.push(`xhs pageerror: ${e.message}`));
  xhs.on('console', (m) => m.type() === 'error' && consoleErrors.push(`xhs: ${m.text()}`));
  await xhs.waitForFunction(() => document.querySelectorAll('[data-tubemuse="xhs-time"][data-source="page"]').length === 2, null, { timeout: 15000 });
  const xhsTimes = await xhs.evaluate(() =>
    [...document.querySelectorAll('section.note-item')].map((s) => {
      const t = /** @type {HTMLTimeElement} */ (s.querySelector('[data-tubemuse="xhs-time"]'));
      const d = new Date(t.dateTime);
      const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
      const local = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return { text: t.textContent, iso: t.dateTime, source: t.dataset.source, hint: t.title, local, between: t.previousElementSibling?.matches('a.author') && t.nextElementSibling?.matches('.like-wrapper') };
    }),
  );
  const [t1, t2, t3] = xhsTimes;
  check(t1.source === 'page' && t1.iso === new Date(XHS_N1.time).toISOString() && t1.text === t1.local && !t1.hint, `登录后的卡片：显示页面数据里的发布时间 ${t1.text}（比笔记 ID 推算的晚 2 小时，以页面数据为准；本地时区，精确到分钟）`);
  check(t2.source === 'page' && t2.iso === new Date(XHS_N2.time).toISOString(), `未登录样式的卡片（链接里没有笔记 ID）：按位置 + 标题对上页面数据 ${t2.text}`);
  check(t3.source === 'id' && t3.iso === new Date(XHS_N3.idTime).toISOString() && t3.text === `≈${t3.local}` && t3.hint.includes('笔记 ID'), `页面数据里没有的笔记：由笔记 ID 推算，显示 ${t3.text} 并在悬停提示里说明`);
  check(xhsTimes.every((t) => t.between), '时间插在作者名与点赞数之间（红框区域，作者那一行）');
  const xhsLayout = await xhs.evaluate(() => {
    const L = /** @type {any} */ (window).__layout;
    const cards = [...document.querySelectorAll('section.note-item')].map((s) => s.getBoundingClientRect());
    const sameHeights = L.every((/** @type {any} */ l, /** @type {number} */ i) => Math.abs(cards[i].height - l.height) < 0.5);
    const noOverlap = L.every((/** @type {any} */ a, /** @type {number} */ i) => L.every((/** @type {any} */ b, /** @type {number} */ j) => i === j || a.col !== b.col || cards[i].bottom <= cards[j].top + 0.5 || cards[j].bottom <= cards[i].top + 0.5));
    const rows = [...document.querySelectorAll('section.note-item .author-wrapper')].map((r) => r.getBoundingClientRect().height);
    return { sameHeights, noOverlap, oneLine: rows.every((h) => Math.abs(h - 20) < 0.5) };
  });
  check(xhsLayout.sameHeights && xhsLayout.noOverlap && xhsLayout.oneLine, '卡片高度与小红书排版时一样、同一列上下卡片不重叠、作者那一行仍是一行');
  await panel.getByTestId('xhs-tab-status').filter({ hasText: '找到 3 张笔记卡片' }).waitFor({ timeout: 5000 });
  const xhsStatus = (await panel.getByTestId('xhs-tab-status').textContent()) ?? '';
  check(xhsStatus.includes('博主主页') && xhsStatus.includes('2 张显示页面数据里的发布时间') && xhsStatus.includes('1 张由笔记 ID 推算'), `侧边栏说明当前页的情况：${xhsStatus}`);
  await xhs.screenshot({ path: join(shots, '25-xhs-profile.png') });

  console.log('\n[小红书：卡片上点"收藏" → 弹窗加标签 → 存在本机；不打开笔记、不点小红书自己的元素]');
  const xhsCard = (/** @type {number} */ i) => xhs.locator('section.note-item').nth(i);
  const xhsStored = () => panel.evaluate(async () => (await /** @type {any} */ (globalThis).chrome.storage.local.get('xhs')).xhs ?? { notes: {}, users: {} });
  const saveOpacity = (/** @type {number} */ i) => xhsCard(i).locator('[data-tubemuse="xhs-save"]').evaluate((h) => getComputedStyle(h).opacity);
  await xhs.mouse.move(400, 10);
  await xhs.waitForTimeout(300);
  const hiddenBefore = await saveOpacity(0);
  await xhsCard(0).hover();
  await xhs.waitForTimeout(300);
  check(hiddenBefore === '0' && (await saveOpacity(0)) === '1', '"收藏"平时不显示，鼠标移到卡片上时出现在封面左下角');
  const coverBox = await xhsCard(0).locator('a.cover').boundingBox();
  const saveBox = await xhsCard(0).locator('[data-tubemuse="xhs-save"] button').boundingBox();
  check(!!coverBox && !!saveBox && saveBox.y > coverBox.y && saveBox.y + saveBox.height <= coverBox.y + coverBox.height && saveBox.x >= coverBox.x, '按钮在封面范围内（不占卡片高度）');
  await xhsCard(0).locator('[data-tubemuse="xhs-save"] button').click();
  const xhsPop = xhs.locator('[data-tubemuse="xhs-pop"]');
  await xhsPop.locator('section[data-kind="note"] input').waitFor({ timeout: 5000 });
  check(((await xhsPop.locator('.pop').textContent()) ?? '').includes('不会在小红书上收藏或关注'), '弹窗写明只存在本机、不会在小红书上收藏或关注');
  check(((await xhsPop.locator('section[data-kind="user"] .name').textContent()) ?? '') === '李诞小卖部', '弹窗里同时有这篇笔记和它的作者');
  await xhsPop.locator('section[data-kind="note"] input').fill('书单，AI');
  await xhsPop.locator('section[data-kind="note"] input').press('Enter');
  await xhsCard(0).locator('[data-tubemuse="xhs-save"] button').filter({ hasText: '已收藏 · 2' }).waitFor({ timeout: 5000 });
  const st1 = await xhsStored();
  const n1 = st1.notes[XHS_N1.id];
  check(
    !!n1 &&
      JSON.stringify(n1.tags) === JSON.stringify(['书单', 'AI']) &&
      n1.url === `${MOCK}/xhs/user/profile/${XHS_UID}/${XHS_N1.id}?xsec_token=ABtoken1%3D&xsec_source=pc_user` &&
      n1.publishedAt === XHS_N1.time &&
      n1.timeSource === 'page' &&
      n1.title === XHS_N1.title &&
      n1.authorId === XHS_UID &&
      n1.authorName === '李诞小卖部',
    '加标签即收藏：标题、作者、发布时间（页面数据）、带 xsec_token 的链接、两个标签都存进本机',
  );
  check(xhs.url() === xhsProfileUrl && (await xhs.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '没有打开笔记，也没有点到小红书自己的任何元素');
  await xhsPop.getByRole('button', { name: '收藏这位博主' }).click();
  await xhs.locator('[data-tubemuse="xhs-save-inline"][data-for="profile"] button').filter({ hasText: '已收藏博主' }).waitFor({ timeout: 5000 });
  const st2 = await xhsStored();
  check(st2.users[XHS_UID]?.name === '李诞小卖部' && st2.users[XHS_UID]?.url === `${MOCK}/xhs/user/profile/${XHS_UID}?xsec_source=pc_note`, '弹窗里一键收藏这位博主；博主主页名字旁的按钮随之变成"已收藏博主"');
  await xhsPop.getByRole('button', { name: '去掉标签 AI' }).click();
  await xhsCard(0).locator('[data-tubemuse="xhs-save"] button').filter({ hasText: '已收藏 · 1' }).waitFor({ timeout: 5000 });
  check(JSON.stringify((await xhsStored()).notes[XHS_N1.id].tags) === JSON.stringify(['书单']), '在弹窗里去掉一个标签');
  await xhsPop.locator('section[data-kind="note"] input').press('Escape');
  await xhsPop.waitFor({ state: 'detached', timeout: 3000 });
  check(true, '按 Esc 关闭弹窗');
  await xhs.mouse.move(400, 10);
  await xhs.waitForTimeout(300);
  check((await saveOpacity(0)) === '1' && (await saveOpacity(2)) === '0', '收藏过的卡片按钮常驻（"已收藏 · 1"），没收藏的仍然只在悬停时出现');

  console.log('\n[小红书：未登录样式的卡片 → 只能收藏博主；常用标签一键加]');
  await xhsCard(1).hover();
  await xhsCard(1).locator('[data-tubemuse="xhs-save"] button').click();
  await xhsPop.locator('.pop').waitFor({ timeout: 3000 });
  check(((await xhsPop.locator('section[data-kind="note"]').textContent()) ?? '').includes('登录后才能收藏这篇笔记'), '卡片上没有笔记链接时说明原因（博主照常可以收藏）');
  await xhsCard(1).locator('[data-tubemuse="xhs-save"] button').click();
  await xhsPop.waitFor({ state: 'detached', timeout: 3000 });
  await xhsCard(2).hover();
  await xhsCard(2).locator('[data-tubemuse="xhs-save"] button').click();
  await xhsPop.locator('section[data-kind="note"]').getByRole('button', { name: '+书单' }).click();
  await xhsCard(2).locator('[data-tubemuse="xhs-save"] button').filter({ hasText: '已收藏 · 1' }).waitFor({ timeout: 5000 });
  const n3 = (await xhsStored()).notes[XHS_N3.id];
  check(n3?.timeSource === 'id' && n3.publishedAt === XHS_N3.idTime && JSON.stringify(n3.tags) === JSON.stringify(['书单']), '点"常用"里的标签直接收藏；时间记为由笔记 ID 推算');
  await xhs.keyboard.press('Escape');
  await xhs.mouse.click(400, 10);
  await xhsPop.waitFor({ state: 'detached', timeout: 3000 });
  check(true, '点弹窗外面关闭');

  console.log('\n[小红书：虚拟列表把卡片换成另一篇 → 时间跟着换；设置里关掉时间 / 按钮]');
  await xhs.evaluate(({ id, title }) => /** @type {any} */ (window).__recycle(2, id, title), { id: XHS_N4.id, title: XHS_N4.title });
  await xhs.waitForFunction((iso) => /** @type {HTMLTimeElement | null} */ (document.querySelector('section.note-item[data-index="12"] [data-tubemuse="xhs-time"]'))?.dateTime === iso, new Date(XHS_N4.idTime).toISOString(), { timeout: 5000 });
  check((await xhsCard(2).locator('[data-tubemuse="xhs-save"] button').textContent())?.trim() === '收藏', '换成的那篇没收藏过：按钮回到"收藏"');
  const setXhs = (/** @type {Record<string, boolean>} */ patch) =>
    panel.evaluate(async (p) => {
      const c = /** @type {any} */ (globalThis).chrome;
      const { settings = {} } = await c.storage.local.get('settings');
      await c.storage.local.set({ settings: { ...settings, xhs: { ...settings.xhs, ...p } } });
    }, patch);
  await setXhs({ showTime: false });
  await xhs.waitForFunction(() => document.querySelectorAll('[data-tubemuse="xhs-time"]').length === 0, null, { timeout: 5000 });
  await setXhs({ showTime: true, enabled: false });
  await xhs.waitForFunction(() => document.querySelectorAll('[data-tubemuse^="xhs"]').length === 0, null, { timeout: 5000 });
  check(true, '关掉"显示发布时间"、关掉整个小红书功能：页面上 TubeMuse 加的东西全部消失');
  await setXhs({ enabled: true });
  await xhs.waitForFunction(() => document.querySelectorAll('[data-tubemuse="xhs-time"]').length === 3, null, { timeout: 5000 });
  check(true, '重新打开后恢复');

  console.log('\n[小红书：笔记详情 → 日期旁显示精确发布时间；"关注"旁的按钮显示已收藏]');
  await xhs.goto(`${MOCK}/xhs/explore/${XHS_N1.id}?xsec_token=ABtoken1%3D&xsec_source=pc_user`);
  await xhs.locator('[data-tubemuse="xhs-detail-time"][data-source="page"]').waitFor({ timeout: 10000 });
  const detail = await xhs.evaluate(() => {
    const t = /** @type {HTMLTimeElement} */ (document.querySelector('[data-tubemuse="xhs-detail-time"]'));
    return { text: t.textContent, iso: t.dateTime, afterDate: t.previousElementSibling?.classList.contains('date') };
  });
  check(detail.iso === new Date(XHS_N1.time).toISOString() && /^发布于 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(detail.text ?? '') && !!detail.afterDate, `详情页日期旁：${detail.text}`);
  // 2026-11-04 用户报告：详情页里看不到"收藏"。页面里有两份作者栏，按钮被放进了顶上藏起来的那份
  const placed = await xhs.evaluate(() => {
    const all = document.querySelectorAll('[data-tubemuse="xhs-save-inline"][data-for="note"]');
    const h = /** @type {HTMLElement | undefined} */ (all[0]);
    const follow = h?.nextElementSibling;
    const a = h?.getBoundingClientRect();
    const b = follow?.getBoundingClientRect();
    return {
      count: all.length,
      visible: !!h && h.getClientRects().length > 0,
      inPanel: !!h?.closest('.interaction-container .author-container'),
      nextToFollow: !!follow?.classList.contains('note-detail-follow-btn') && !!a && !!b && a.right <= b.left + 0.5 && a.bottom > b.top && a.top < b.bottom,
      inComments: !!h?.closest('.comments-el'),
    };
  });
  check(
    placed.count === 1 && placed.visible && placed.inPanel && placed.nextToFollow && !placed.inComments,
    `笔记详情里有两份作者栏（顶上那份藏着）："收藏"放在看得见的那份里、紧挨"关注"左边，不进评论区（${JSON.stringify(placed)}）`,
  );
  const inline = xhs.locator('[data-tubemuse="xhs-save-inline"][data-for="note"] button');
  check(((await inline.textContent()) ?? '').includes('已收藏 · 1'), '"关注"旁的按钮显示这篇已收藏');
  await inline.click();
  await xhsPop.locator('section[data-kind="user"]').filter({ hasText: '移出收藏' }).waitFor({ timeout: 3000 });
  check((await xhs.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '弹窗里同时有笔记和作者；没有点到"关注"');
  await xhs.keyboard.press('Escape');

  console.log('\n[小红书：侧边栏 → 筛选、改名标签、移出与撤销]');
  await panel.bringToFront();
  await panel.getByTestId('xhs-list').waitFor({ timeout: 5000 });
  check((await panel.getByTestId('xhs-item').count()) === 3, '侧边栏列出收藏的 2 篇笔记与 1 位博主');
  check(((await panel.getByTestId('xhs-item').filter({ hasText: XHS_N1.title }).getByTestId('xhs-item-time').textContent()) ?? '').startsWith('发布 '), '笔记显示发布时间');
  await panel.getByTestId('xhs-tag-filter').getByRole('button', { name: /#书单/ }).click();
  check((await panel.getByTestId('xhs-item').count()) === 2, '按标签 #书单 筛选');
  await panel.getByRole('button', { name: '管理标签' }).click();
  await panel.getByTestId('xhs-tag-manager').getByRole('button', { name: '改名' }).first().click();
  await panel.getByRole('textbox', { name: '把 #书单 改名为' }).fill('读书');
  await panel.getByRole('textbox', { name: '把 #书单 改名为' }).press('Enter');
  /** 等本机存储里的收藏满足条件（waitForFunction 不等异步判断的结果，所以在这边轮询） */
  const untilStored = async (/** @type {(s: any) => boolean} */ ok) => {
    for (let i = 0; i < 50 && !ok(await xhsStored()); i++) await panel.waitForTimeout(100);
    return ok(await xhsStored());
  };
  const renamed = await untilStored((s) => JSON.stringify(s.notes[XHS_N3.id]?.tags) === '["读书"]' && JSON.stringify(s.notes[XHS_N1.id]?.tags) === '["读书"]');
  check(renamed && (await panel.getByTestId('xhs-item').count()) === 2, '标签改名后两篇笔记都跟着改，筛选跟到新名字');
  await panel.getByTestId('xhs-item').filter({ hasText: XHS_N3.title }).getByTestId('xhs-remove').click();
  await panel.getByRole('button', { name: '撤销' }).waitFor({ timeout: 3000 });
  check(!(await xhsStored()).notes[XHS_N3.id], '移出收藏');
  await panel.getByRole('button', { name: '撤销' }).click();
  check(await untilStored((s) => JSON.stringify(s.notes[XHS_N3.id]?.tags) === '["读书"]'), '撤销后原样放回（标签还在）');
  await panel.screenshot({ path: join(shots, '26-xhs-panel.png'), fullPage: true });

  console.log('\n[小红书：视频笔记 → 片段页录一段 → 卡住时不录 → 停在最后一帧算播完 → 自动保存，记录能回到这篇笔记]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '片段', exact: true }).click();
  // 把侧边栏拿到前台时，当前标签页变成了侧边栏自己：切回小红书那个标签页（就像你点回它）
  await panel.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [t] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes('/xhs/explore/'));
    await c.tabs.update(t.id, { active: true });
  });
  await clipStatus.filter({ hasText: '这篇笔记里没有视频' }).waitFor({ timeout: 10000 });
  check(true, '图文笔记：说明没有视频可录');
  const xhsVideoUrl = `${MOCK}/xhs/explore/${XHS_V1.id}?xsec_token=${encodeURIComponent(XHS_V1.token)}&xsec_source=pc_feed`;
  await xhs.goto(xhsVideoUrl);
  await xhs.waitForFunction(() => (document.querySelector('.player-el video') instanceof HTMLVideoElement ? /** @type {HTMLVideoElement} */ (document.querySelector('.player-el video')).readyState : 0) >= 2, null, { timeout: 30000 });
  /** 在小红书页面里对播放器的视频做点什么（模拟你播放、拖动，或播放器自己的行为） */
  const onXhsVideo = (/** @type {string} */ code) => xhs.evaluate(`(() => { const v = document.querySelector('.player-el video'); ${code} })()`);
  await onXhsVideo('return v.play();');
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  check(
    ((await panel.getByTestId('clip-title').textContent()) ?? '') === XHS_V1.title && (await panel.getByTestId('clip-burn').count()) === 0 && (await panel.getByTestId('clip-no-burn').count()) === 1,
    '小红书视频笔记：侧边栏显示笔记标题（来自页面标题），不提供字幕烧录并说明原因',
  );
  check((await panel.getByTestId('clip-capture').count()) === 1, '小红书视频笔记：有 Capture 按钮');
  const xhsPlayerHtml = () => xhs.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('.media-container')).outerHTML);
  const xhsPlayerBefore = await xhsPlayerHtml();
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  const xhsBadge = await sw2.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [t] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes('/xhs/explore/'));
    return c.action.getBadgeText({ tabId: t.id });
  });
  check(xhsBadge === 'REC', `小红书上录制中，工具栏图标也显示 REC（实际："${xhsBadge}"）`);
  await xhs.waitForTimeout(2000);
  // 进度卡住（倍速 0：没暂停，进度不动）：当缓冲，不录静止画面
  await onXhsVideo('v.playbackRate = 0;');
  await clipStatus.filter({ hasText: '缓冲中' }).waitFor({ timeout: 5000 });
  const atStall = await recordedSec();
  await xhs.waitForTimeout(1500);
  check((await recordedSec()) === atStall, `播放中进度卡住：自动暂停录制，不录静止画面（停在 ${atStall} 秒）`);
  await onXhsVideo('v.playbackRate = 1;');
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 5000 });
  await xhs.waitForTimeout(1500);
  // 小红书的播放器放到最后一帧就停住，既不暂停也不报"播完"（2026-11-04 实测）：模拟成倍速 0、停在结尾前 0.2 秒
  const [xhsDl] = await Promise.all([xhs.waitForEvent('download', { timeout: 15000 }), onXhsVideo('v.playbackRate = 0; v.currentTime = v.duration - 0.2;')]);
  const xhsName = xhsDl.suggestedFilename();
  check(/^视频日记Day255｜一人公司怎么做_00m0\ds-00m1\ds\.(mp4|webm)$/.test(xhsName), `停在最后一帧算播完，自动结束并保存；文件名用笔记标题与起止时间：${xhsName}`);
  await panel.getByTestId('clip-ready').filter({ hasText: '视频播完了' }).waitFor({ timeout: 5000 });
  const xhsClip = await analyzeClip(xhs, /** @type {string} */ (await xhsDl.path()));
  check(
    container(xhsClip.head) === xhsName.split('.').pop() && xhsClip.duration > 2.5 && xhsClip.rms > 0.02,
    `录到了这篇笔记视频的画面与声音（${xhsClip.duration.toFixed(1)} 秒，响度 ${xhsClip.rms.toFixed(3)}）`,
  );
  const xhsLog = (await clipLog())[0];
  check(
    xhsLog?.site === 'xhs' && xhsLog.videoId === XHS_V1.id && xhsLog.title === XHS_V1.title && xhsLog.url === `${MOCK}/xhs/explore/${XHS_V1.id}?xsec_token=ABvideo1%3D&xsec_source=pc_feed` && xhsLog.fileName === xhsName,
    '"最近录过的片段"记下这是小红书笔记，带上能回到这篇笔记的链接（含 xsec_token）',
  );
  check(((await panel.getByTestId('clip-log').textContent()) ?? '').includes('小红书 · '), '侧边栏的片段清单标出小红书');
  check(
    JSON.stringify(await xhsPlayerHtml()) === JSON.stringify(xhsPlayerBefore) && (await xhs.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0,
    '录制没有往小红书页面里加任何元素，没有点到小红书自己的任何东西',
  );

  console.log('\n[小红书：录制中关掉这篇笔记（站内跳走）→ 这一段自动结束并保存]');
  await onXhsVideo('v.playbackRate = 1; v.currentTime = 0; return v.play();');
  await clipStatus.filter({ hasText: '已保存' }).waitFor({ timeout: 5000 });
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  await xhs.waitForTimeout(1500);
  const [closeDl] = await Promise.all([xhs.waitForEvent('download', { timeout: 10000 }), xhs.evaluate(() => history.pushState(null, '', '/xhs/explore'))]);
  check(/^视频日记Day255｜一人公司怎么做_.*\.(mp4|webm)$/.test(closeDl.suggestedFilename()), `关掉笔记时自动结束这一段并保存：${closeDl.suggestedFilename()}`);
  await panel.getByTestId('clip-ready').filter({ hasText: '关掉了这篇笔记' }).waitFor({ timeout: 5000 });
  check(true, '侧边栏说明这一段为什么结束');

  console.log('\n[小红书：Capture → 按视频的真实尺寸存无损 PNG，由侧边栏交给浏览器；不动页面]');
  await xhs.goto(xhsVideoUrl);
  await xhs.waitForFunction(() => (document.querySelector('.player-el video') instanceof HTMLVideoElement ? /** @type {HTMLVideoElement} */ (document.querySelector('.player-el video')).readyState : 0) >= 2, null, { timeout: 30000 });
  await useFramedVideo(xhs, '.player-el video');
  await panel.getByTestId('clip-capture').waitFor({ timeout: 10000 });
  /** @type {import('playwright').Download[]} */
  const xhsPageDownloads = [];
  const onXhsPageDownload = (/** @type {import('playwright').Download} */ d) => xhsPageDownloads.push(d);
  xhs.on('download', onXhsPageDownload);
  const xhsShotHtmlBefore = await xhsPlayerHtml();
  const xhsSeqBefore = await captureSeq();
  const xhsShot = await capture();
  const xhsShotName = xhsShot.suggestedFilename();
  check(xhsShotName.startsWith('视频日记Day255｜一人公司怎么做_00-00-0') && xhsShotName.endsWith(`_original_${String(xhsSeqBefore + 1).padStart(5, '0')}.png`), `文件名：笔记标题_时间戳_original_序号.png，序号接着往下排：${xhsShotName}`);
  const xhsPng = await readPng(/** @type {string} */ (await xhsShot.path()), xhs);
  check(xhsPng.signature === '89504e470d0a1a0a' && xhsPng.depth === 8 && xhsPng.width === 720 && xhsPng.height === 1280, `按视频的真实尺寸存，不是页面上显示的 320×180：${xhsPng.width}×${xhsPng.height}`);
  check(xhsPng.left[0] > 150 && xhsPng.left[2] < 90 && xhsPng.right[2] > 150 && xhsPng.right[0] < 90, `存下的是这篇笔记视频的这一帧，左红右蓝，不是黑帧（左 ${xhsPng.left.join(',')}，右 ${xhsPng.right.join(',')}）`);
  check(xhsPageDownloads.length === 0, '下载算在侧边栏上，不算在小红书页面上（从页面连续下载，第二次起 Chrome 会拦）');
  xhs.off('download', onXhsPageDownload);
  check(JSON.stringify(await xhsPlayerHtml()) === JSON.stringify(xhsShotHtmlBefore) && (await xhs.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '截图没有往小红书页面里加任何元素，没有点到小红书自己的任何东西');
  await panel.getByRole('tab', { name: '小红书' }).click();

  console.log('\n[小红书：网络红线]');
  const xhsPageReqs = requests.slice(xhsReqStart).filter((r) => String(r.headers.referer ?? '').startsWith(`${MOCK}/xhs/`));
  check(
    xhsPageReqs.every((r) => r.method === 'GET' && (r.path.startsWith('/xhs/') || r.path === '/favicon.ico')),
    `小红书页面上 TubeMuse 没有发出任何请求（只有你打开的页面本身）${xhsPageReqs.length ? `：${xhsPageReqs.map((r) => r.path).join(', ')}` : ''}`,
  );
  await xhs.close();
  await panel.bringToFront();

  // ───────────────────────── X：片段录制 ─────────────────────────
  console.log('\n[X：首页信息流里录正在播放、开着声音的那个视频（静音自动播放的、没播过的、广告不算），帖子信息来自视频所在的那条帖子；暂停后仍锁定，滚出屏幕放开]');
  const xReqStart = requests.length;
  const [xPage] = await Promise.all([context.waitForEvent('page'), panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}/xpage/home`)]);
  xPage.on('pageerror', (e) => consoleErrors.push(`x pageerror: ${e.message}`));
  await xPage.waitForLoadState('domcontentloaded');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '片段', exact: true }).click();
  // 把侧边栏拿到前台时，当前标签页变成了侧边栏自己：切回 X 那个标签页（就像你点回它）
  await panel.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [t] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes('/xpage/'));
    await c.tabs.update(t.id, { active: true });
  });
  const xAppHtml = () => xPage.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('app')).outerHTML);
  const xTitle = async () => (await panel.getByTestId('clip-title').textContent()) ?? '';
  /** 在首页信息流里对广告的视频（ad）和那条帖子的视频（v）做点什么（模拟你播放、开关声音，或 X 自己滚动时的行为） */
  const onXFeed = (/** @type {string} */ code) => xPage.evaluate(`(() => { const ad = document.querySelector('#feed-ad video'); const v = document.querySelector('#feed-post video'); ${code} })()`);
  await xPage.waitForFunction(() => [...document.querySelectorAll('video')].every((v) => v.readyState >= 2), null, { timeout: 30000 });
  await onXFeed('ad.muted = true; return ad.play();');
  await clipStatus.filter({ hasText: '没有正在播放、开着声音的视频' }).waitFor({ timeout: 10000 });
  const feedIdle = /** @type {{ adAutoplay: boolean, idle: boolean }} */ (await onXFeed('return { adAutoplay: !ad.paused && ad.muted, idle: v.paused && !v.muted };'));
  check(
    feedIdle.adAutoplay && feedIdle.idle && (await xTitle()) === '—' && (await panel.getByTestId('clip-start').count()) === 0,
    '首页信息流：静音自动播放的视频、没播过的视频（没静音但暂停着）都不算，说明要把想录的那个的声音打开',
  );
  await onXFeed('ad.currentTime = 0; ad.muted = false; return ad.play();');
  await clipStatus.filter({ hasText: '认不出这个视频属于哪条帖子' }).waitFor({ timeout: 5000 });
  check((await panel.getByTestId('clip-start').count()) === 0, '广告带着声音播放：它没有帖子链接，认不出属于哪条帖子，不让录');
  await onXFeed('ad.pause(); ad.muted = true;');

  await onXFeed('return v.play();');
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  await panel.getByTestId('clip-position').filter({ hasText: / 0:(11|12)$/ }).waitFor({ timeout: 5000 });
  check(
    (await xTitle()) === X_FEED_POST.title,
    `锁定正在播放、开着声音的那个视频；"帖子"来自它所在的那条帖子（作者 - 正文：表情保留，t.co 外链去掉，不拿被引用帖子的文字）：${await xTitle()}`,
  );
  check(((await panel.getByTestId('clip-no-burn').textContent()) ?? '').includes('首页信息流'), '界面写明信息流里录的是哪个视频');
  await onXFeed('v.pause();');
  await xPage.waitForTimeout(600);
  check(((await clipStatus.textContent()) ?? '').includes('可以开始录制') && (await xTitle()) === X_FEED_POST.title, '把它暂停：仍然锁定着（可以暂停下来截图）');
  await xPage.evaluate(() => window.scrollTo(0, 2000));
  await clipStatus.filter({ hasText: '没有正在播放、开着声音的视频' }).waitFor({ timeout: 5000 });
  await xPage.evaluate(() => window.scrollTo(0, 0));
  await xPage.waitForTimeout(600);
  check(((await clipStatus.textContent()) ?? '').includes('没有正在播放、开着声音的视频'), '暂停着滚出屏幕：放开；滚回来也不会自己又锁上，要再播放');

  await onXFeed('v.currentTime = 0; return v.play();');
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  const feedHtmlBefore = await xAppHtml();
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  await xPage.waitForTimeout(2000);
  // X 自己的行为：滚出屏幕时暂停这个视频。这时别的视频带着声音播起来，正在录的这一段也不换目标
  await onXFeed('v.pause(); window.scrollTo(0, 2000); ad.currentTime = 0; ad.muted = false; return ad.play();');
  await clipStatus.filter({ hasText: '视频已暂停' }).waitFor({ timeout: 5000 });
  const feedAtScroll = await recordedSec();
  await xPage.waitForTimeout(1200);
  check(
    (await recordedSec()) === feedAtScroll && (await panel.getByTestId('clip-live').count()) === 1 && (await xTitle()) === X_FEED_POST.title,
    `录制中滚开：这一段不结束、不跳到别的视频，暂停录制（停在 ${feedAtScroll} 秒）`,
  );
  await onXFeed('ad.pause(); ad.muted = true; window.scrollTo(0, 0); return v.play();');
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 5000 });
  await xPage.waitForTimeout(1500);
  check((await xAppHtml()) === feedHtmlBefore && (await xPage.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '信息流里录制没有往 X 页面里加任何元素，没有点到 X 自己的任何东西');
  const [feedDl] = await Promise.all([xPage.waitForEvent('download', { timeout: 10000 }), xPage.evaluate(() => history.pushState(null, '', '/xpage/explore'))]);
  const feedName = feedDl.suggestedFilename();
  check(feedName.startsWith('Feed 作者 - Fable made this entire movie 🎬 in pure code.') && /_00m\d\ds-00m\d\ds\.(mp4|webm)$/.test(feedName), `离开首页时这一段自动结束并保存，文件名用帖子的作者、正文与起止时间：${feedName}`);
  const feedClip = await analyzeClip(xPage, /** @type {string} */ (await feedDl.path()));
  check(container(feedClip.head) === feedName.split('.').pop() && feedClip.duration > 2.5 && feedClip.rms > 0.02, `信息流里录到了画面轨和声音（${feedClip.duration.toFixed(1)} 秒，响度 ${feedClip.rms.toFixed(3)}）`);
  await panel.getByTestId('clip-log').filter({ hasText: feedName }).waitFor({ timeout: 5000 });
  const feedLog = (await clipLog())[0];
  check(
    feedLog?.site === 'x' && feedLog.videoId === X_FEED_POST.id && feedLog.title === X_FEED_POST.title && feedLog.url === `${MOCK}/xpage/${X_FEED_POST.user}/status/${X_FEED_POST.id}` && feedLog.fileName === feedName,
    '"最近录过的片段"记下的是这条帖子自己的链接（不是 /home），点标题能回到帖子',
  );
  await clipStatus.filter({ hasText: '也不是首页信息流' }).waitFor({ timeout: 5000 });
  check(true, '别的 X 页面（个人主页、搜索等）：说明只有帖子页和首页信息流能录');
  await panel.getByRole('button', { name: '释放内存' }).click();
  await xPage.evaluate(() => history.pushState(null, '', '/xpage/home'));

  // 换成有画面的视频（静音、暂停着交回来）：带声音放一下再暂停，暂停着截
  await useFramedVideo(xPage, '#feed-post video');
  await onXFeed('v.muted = false; return v.play().then(() => new Promise((r) => setTimeout(r, 400))).then(() => v.pause());');
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 5000 });
  const feedSeqBefore = await captureSeq();
  const feedShot = await capture();
  const feedShotName = feedShot.suggestedFilename();
  const feedPng = await readPng(/** @type {string} */ (await feedShot.path()), xPage);
  check(
    feedShotName.startsWith('Feed 作者 - Fable made this entire movie 🎬 in pure code.') && feedShotName.endsWith(`_original_${String(feedSeqBefore + 1).padStart(5, '0')}.png`) && feedPng.width === 720 && feedPng.height === 1280 && feedPng.left[0] > 150 && feedPng.right[2] > 150,
    `信息流里暂停着 Capture：文件名用帖子的作者和正文，按视频的真实尺寸存：${feedShotName}（${feedPng.width}×${feedPng.height}）`,
  );
  // X 自己的行为：滚远了，这条帖子被从页面上撤掉
  await xPage.evaluate(() => document.getElementById('feed-post')?.remove());
  await clipStatus.filter({ hasText: '没有正在播放、开着声音的视频' }).waitFor({ timeout: 5000 });
  check(true, '这条帖子被 X 从页面上撤掉后放开，不留着已经不在的视频');

  console.log('\n[X：站内跳进帖子后录主帖的视频（静音自动播放），不录更大的回复视频；滚开时暂停，滚回来接着录]');
  await xPage.evaluate(() => /** @type {any} */ (window).__openPost());
  await xPage.waitForFunction(() => (document.querySelector('#main video') instanceof HTMLVideoElement ? /** @type {HTMLVideoElement} */ (document.querySelector('#main video')).readyState : 0) >= 2, null, { timeout: 30000 });
  /** 在 X 页面里对主帖和回复的视频做点什么（模拟你播放，或 X 自己滚动时的行为） */
  const onXVideos = (/** @type {string} */ code) => xPage.evaluate(`(() => { const main = document.querySelector('#main video'); const reply = document.querySelector('#reply video'); ${code} })()`);
  await onXVideos('main.currentTime = 0; return main.play();');
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  check(
    ((await panel.getByTestId('clip-title').textContent()) ?? '') === X_POST.title && (await panel.getByTestId('clip-burn').count()) === 0 && (await panel.getByTestId('clip-capture').count()) === 1,
    '站内跳进帖子后不用刷新就能录：标题来自页面标题（作者 - 正文，去掉 t.co 短链），不提供字幕烧录，有 Capture',
  );
  check(((await panel.getByTestId('clip-no-burn').textContent()) ?? '').includes('片头广告认不出来'), '界面写明 X 的片头广告认不出来，不静默录进去');
  const xPosition = async () => (await panel.getByTestId('clip-position').textContent()) ?? '';
  // 站内跳转后状态马上是"可以开始录制"，时长要等视频元数据到了、下一轮推送才进侧边栏：等它出现，选错视频时这里是 0:30，会超时
  const xShowsMainVideo = () => panel.getByTestId('clip-position').filter({ hasText: / 0:(19|20)$/ }).waitFor({ timeout: 5000 });
  await xShowsMainVideo();
  check(true, `选中主帖的视频（20 秒），不是回复里更大的那个（30 秒）：${await xPosition()}`);
  const xAppBefore = await xAppHtml();
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  const xBadge = await sw2.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [t] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes('/xpage/'));
    return c.action.getBadgeText({ tabId: t.id });
  });
  check(xBadge === 'REC', `X 上录制中，工具栏图标也显示 REC（实际："${xBadge}"）`);
  await xPage.waitForTimeout(2000);
  // X 自己的行为：滚开时暂停主帖的视频，屏幕上的回复视频开始播
  await onXVideos('main.pause(); reply.scrollIntoView(); return reply.play();');
  await clipStatus.filter({ hasText: '视频已暂停' }).waitFor({ timeout: 5000 });
  const xAtScroll = await recordedSec();
  await xPage.waitForTimeout(1200);
  check((await recordedSec()) === xAtScroll && (await panel.getByTestId('clip-live').count()) === 1 && / 0:(19|20)$/.test(await xPosition()), `滚到回复区：这一段不结束、不跳到回复的视频，暂停录制（停在 ${xAtScroll} 秒）`);
  await onXVideos('reply.pause(); main.scrollIntoView(); return main.play();');
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 5000 });
  await xPage.waitForTimeout(1500);
  const [xDl] = await Promise.all([xPage.waitForEvent('download', { timeout: 15000 }), panel.getByTestId('clip-stop').click()]);
  const xName = xDl.suggestedFilename();
  check(/^Ayo O - I reverse engineered tiktok_00m\d\ds-00m\d\ds\.(mp4|webm)$/.test(xName), `停止后保存，文件名用作者、正文与起止时间：${xName}`);
  const xClip = await analyzeClip(xPage, /** @type {string} */ (await xDl.path()));
  check(container(xClip.head) === xName.split('.').pop() && xClip.duration > 2.5 && xClip.rms > 0.02, `视频静音播放也录到了声音（${xClip.duration.toFixed(1)} 秒，响度 ${xClip.rms.toFixed(3)}）`);
  await panel.getByTestId('clip-log').waitFor({ timeout: 5000 });
  const xStatusUrl = `${MOCK}/xpage/${X_POST.user}/status/${X_POST.id}`;
  const xLog = (await clipLog())[0];
  check(xLog?.site === 'x' && xLog.videoId === X_POST.id && xLog.title === X_POST.title && xLog.url === xStatusUrl && xLog.fileName === xName, '"最近录过的片段"记下这是 X 的帖子，链接去掉了分享参数');
  check(((await panel.getByTestId('clip-log').textContent()) ?? '').includes('X · '), '侧边栏的片段清单标出 X');
  check((await xAppHtml()) === xAppBefore && (await xPage.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '录制没有往 X 页面里加任何元素，没有点到 X 自己的任何东西');

  console.log('\n[X：Capture → 按视频的真实尺寸存无损 PNG，由侧边栏交给浏览器；不动页面]');
  await useFramedVideo(xPage, '#main video');
  /** @type {import('playwright').Download[]} */
  const xPageDownloads = [];
  const onXPageDownload = (/** @type {import('playwright').Download} */ d) => xPageDownloads.push(d);
  xPage.on('download', onXPageDownload);
  const xShotHtmlBefore = await xAppHtml();
  const xSeqBefore = await captureSeq();
  const xShot = await capture();
  const xShotName = xShot.suggestedFilename();
  check(xShotName.startsWith('Ayo O - I reverse engineered tiktok_00-00-0') && xShotName.endsWith(`_original_${String(xSeqBefore + 1).padStart(5, '0')}.png`), `文件名：作者 - 正文_时间戳_original_序号.png，序号接着 YouTube 的往下排：${xShotName}`);
  const xPng = await readPng(/** @type {string} */ (await xShot.path()), xPage);
  check(xPng.signature === '89504e470d0a1a0a' && xPng.depth === 8 && xPng.width === 720 && xPng.height === 1280, `按视频的真实尺寸存，不是页面上显示的 286×508：${xPng.width}×${xPng.height}`);
  check(xPng.left[0] > 150 && xPng.left[2] < 90 && xPng.right[2] > 150 && xPng.right[0] < 90, `存下的是主帖视频的这一帧，左红右蓝，不是黑帧（左 ${xPng.left.join(',')}，右 ${xPng.right.join(',')}）`);
  check(((await panel.getByTestId('clip-capture-saved').textContent()) ?? '').includes('720×1280'), '侧边栏写明文件名和实际尺寸');
  check(xPageDownloads.length === 0, '下载算在侧边栏上，不算在 X 页面上（从页面连续下载，第二次起 Chrome 会拦）');
  xPage.off('download', onXPageDownload);
  check((await xAppHtml()) === xShotHtmlBefore && (await xPage.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '截图没有往 X 页面里加任何元素，没有点到 X 自己的任何东西');

  console.log('\n[X：全屏视图录弹层里的视频，不录底下被盖住的；离开帖子时这一段自动结束并保存]');
  await xPage.goto(`${xStatusUrl}/video/1`);
  const dialogVideo = '[role="dialog"] video';
  await xPage.waitForFunction((s) => (/** @type {HTMLVideoElement | null} */ (document.querySelector(s))?.readyState ?? 0) >= 2, dialogVideo, { timeout: 30000 });
  await xPage.evaluate((s) => /** @type {HTMLVideoElement} */ (document.querySelector(s)).play(), dialogVideo);
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  await xShowsMainVideo();
  check(true, `选中弹层里的视频（20 秒），不是底下被盖住的（7 秒）：${await xPosition()}`);
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  await xPage.waitForTimeout(1500);
  const [leaveDl] = await Promise.all([xPage.waitForEvent('download', { timeout: 10000 }), xPage.evaluate(() => history.pushState(null, '', '/xpage/home'))]);
  check(/^Ayo O - I reverse engineered tiktok_.*\.(mp4|webm)$/.test(leaveDl.suggestedFilename()), `离开帖子时自动结束这一段并保存：${leaveDl.suggestedFilename()}`);
  await panel.getByTestId('clip-ready').filter({ hasText: '离开了这条帖子' }).waitFor({ timeout: 5000 });
  check(true, '侧边栏说明这一段为什么结束');
  await panel.getByTestId('clip-log').filter({ hasText: leaveDl.suggestedFilename() }).waitFor({ timeout: 5000 });
  check((await clipLog())[0]?.url === xStatusUrl, '全屏视图录的片段：记录里的链接回到帖子本身（去掉 /video/1）');

  console.log('\n[X：动图是跨站视频，录不了时说人话；文字帖子说明没有视频]');
  // 现场录一小段有画面的视频当动图（WAV 没有画面，读不出"画面不可读"这种情况）
  const xGifBody = Buffer.from(
    await xPage.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
      const rec = new MediaRecorder(c.captureStream(10), { mimeType: 'video/webm;codecs=vp8' });
      /** @type {Blob[]} */
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.start();
      for (let i = 0; i < 12; i++) {
        g.fillStyle = i % 2 ? '#0a0' : '#080';
        g.fillRect(0, 0, 64, 64);
        await new Promise((r) => setTimeout(r, 50));
      }
      rec.stop();
      await new Promise((r) => (rec.onstop = r));
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      return btoa(String.fromCharCode(...bytes));
    }),
    'base64',
  );
  t.setXGifBody(xGifBody);
  await xPage.goto(`${MOCK}/xpage/${X_GIF_POST.user}/status/${X_GIF_POST.id}`);
  await xPage.waitForFunction(() => (document.querySelector('video')?.videoWidth ?? 0) > 0, null, { timeout: 15000 });
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  await panel.getByTestId('clip-start').click();
  await panel.getByRole('alert').filter({ hasText: '视频来自别的网站' }).waitFor({ timeout: 5000 });
  check(((await panel.getByRole('alert').textContent()) ?? '').includes('X 的动图（GIF）') && (await panel.getByTestId('clip-live').count()) === 0, '动图：不开始录制，说明是动图的限制，普通视频不受影响');
  const xSeqAtGif = await captureSeq();
  await panel.getByTestId('clip-capture').click();
  await panel.getByRole('alert').filter({ hasText: '没有放行（X 的动图（GIF）是这样' }).waitFor({ timeout: 5000 });
  check((await captureSeq()) === xSeqAtGif && (await panel.getByTestId('clip-capture-saved').count()) === 0, '动图：Capture 也截不了，说明原因，不占序号');
  await xPage.goto(`${MOCK}/xpage/${X_TEXT_POST.user}/status/${X_TEXT_POST.id}`);
  await clipStatus.filter({ hasText: '这条帖子里没有视频' }).waitFor({ timeout: 10000 });
  check(true, '文字帖子：说明没有视频可录');
  const xPageReqs = requests.slice(xReqStart).filter((r) => String(r.headers.referer ?? '').startsWith(`${MOCK}/xpage/`));
  check(
    xPageReqs.every((r) => r.method === 'GET' && (r.path.startsWith('/xpage/') || r.path === '/favicon.ico')),
    `X 页面上 TubeMuse 没有发出任何请求（只有你打开的页面本身）${xPageReqs.length ? `：${xPageReqs.map((r) => r.path).join(', ')}` : ''}`,
  );
  await xPage.close();
  await panel.bringToFront();

  // ───────────────────────── Instagram：片段录制 ─────────────────────────
  console.log('\n[Instagram：首页信息流里录正在播放、开着声音的那个视频（静音自动播放的、没播过的、广告不算）；帖子信息来自视频所在的那条帖子；放到结尾自动结束]');
  const igReqStart = requests.length;
  const [ig] = await Promise.all([context.waitForEvent('page'), panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}/igpage/`)]);
  ig.on('pageerror', (e) => consoleErrors.push(`ig pageerror: ${e.message}`));
  await ig.waitForLoadState('domcontentloaded');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '片段', exact: true }).click();
  // 把侧边栏拿到前台时，当前标签页变成了侧边栏自己：切回 Instagram 那个标签页（就像你点回它）
  await panel.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [t] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes('/igpage/'));
    await c.tabs.update(t.id, { active: true });
  });
  const igAppHtml = () => ig.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('app')).outerHTML);
  const igTitle = async () => (await panel.getByTestId('clip-title').textContent()) ?? '';
  /** 在 Instagram 首页上对广告的视频（ad）、带正文的帖子的视频（v）、没有正文的帖子的视频（plain）做点什么（模拟你开关声音、播放，或 Instagram 自己的行为） */
  const onIg = (/** @type {string} */ code) =>
    ig.evaluate(`(() => { const ad = document.querySelector('#ig-ad video'); const v = document.querySelector('#ig-post video'); const plain = document.querySelector('#ig-plain video'); ${code} })()`);
  await ig.waitForFunction(() => [...document.querySelectorAll('video')].every((v) => v.readyState >= 2), null, { timeout: 30000 });
  await onIg('ad.muted = true; return ad.play();');
  await clipStatus.filter({ hasText: '没有正在播放、开着声音的视频' }).waitFor({ timeout: 10000 });
  const igIdle = /** @type {{ adAutoplay: boolean, idle: boolean }} */ (await onIg('return { adAutoplay: !ad.paused && ad.muted, idle: v.paused && v.muted };'));
  check(
    igIdle.adAutoplay && igIdle.idle && (await igTitle()) === '—' && (await panel.getByTestId('clip-start').count()) === 0,
    'Instagram 首页：静音自动播放的视频、没播过的视频都不算，说明要把想录的那个的声音打开',
  );
  await onIg('ad.currentTime = 0; ad.muted = false; return ad.play();');
  await clipStatus.filter({ hasText: '这个视频录不了' }).waitFor({ timeout: 5000 });
  check((await panel.getByTestId('clip-start').count()) === 0, '广告帖子带着声音播放：它没有帖子链接，认不出属于哪条帖子，不让录');
  await onIg('ad.pause(); ad.muted = true;');

  // 打开这条帖子的声音（Instagram 上是 muted=false、音量 0.5），从 2 秒处播
  await onIg('v.currentTime = 2; v.muted = false; v.volume = 0.5; return v.play();');
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  await panel.getByTestId('clip-position').filter({ hasText: / 0:0(5|6)$/ }).waitFor({ timeout: 5000 });
  check(
    (await igTitle()) === IG_FEED_POST.title,
    `锁定打开了声音的那个视频；"帖子"来自它所在的那条帖子（用户名 - 露出来的正文：话题和表情保留，不含折叠的"更多"）：${await igTitle()}`,
  );
  check(
    ((await panel.getByTestId('clip-no-burn').textContent()) ?? '').includes('录到结尾就自动结束') && (await panel.getByTestId('clip-burn').count()) === 0 && (await panel.getByTestId('clip-capture').count()) === 1,
    '界面写明信息流里录的是哪个视频、放到结尾自动结束；不提供字幕烧录，有 Capture',
  );
  await onIg('v.currentTime = 2;');
  const igHtmlBefore = await igAppHtml();
  // 不点停止：视频放到结尾自己跳回开头时，这一段自动结束并保存，不把第二遍接着录进去
  const [igDl] = await Promise.all([ig.waitForEvent('download', { timeout: 20000 }), panel.getByTestId('clip-start').click()]);
  const igName = igDl.suggestedFilename();
  check(igName.startsWith(`${IG_FEED_POST.title}_00m0`) && /_00m0[2-3]s-00m0[5-6]s\.(mp4|webm)$/.test(igName), `视频放到结尾跳回开头时自动结束并保存，文件名用用户名、正文与起止时间：${igName}`);
  await panel.getByTestId('clip-ready').filter({ hasText: '视频播完了' }).waitFor({ timeout: 5000 });
  const igClip = await analyzeClip(ig, /** @type {string} */ (await igDl.path()));
  check(
    container(igClip.head) === igName.split('.').pop() && igClip.duration > 2 && igClip.duration < 5.5 && igClip.rms > 0.02,
    `只录了这一遍（${igClip.duration.toFixed(1)} 秒，视频从 2 秒放到 6 秒），有声音（响度 ${igClip.rms.toFixed(3)}）`,
  );
  await panel.getByTestId('clip-log').filter({ hasText: igName }).waitFor({ timeout: 5000 });
  const igLog = (await clipLog())[0];
  check(
    igLog?.site === 'ig' && igLog.videoId === IG_FEED_POST.code && igLog.title === IG_FEED_POST.title && igLog.url === `${MOCK}/igpage/p/${IG_FEED_POST.code}/` && igLog.fileName === igName,
    '"最近录过的片段"记下这是 Instagram 的帖子，链接是这条帖子自己的（不是首页）',
  );
  check(((await panel.getByTestId('clip-log').textContent()) ?? '').includes('Instagram · '), '侧边栏的片段清单标出 Instagram');
  check((await igAppHtml()) === igHtmlBefore && (await ig.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '录制没有往 Instagram 页面里加任何元素，没有点到 Instagram 自己的任何东西（包括"更多"）');
  await panel.getByRole('button', { name: '释放内存' }).click();

  // 换成有画面的视频（静音、暂停着交回来）：带声音放一下再暂停，暂停着截
  await useFramedVideo(ig, '#ig-post video');
  await onIg('v.muted = false; return v.play().then(() => new Promise((r) => setTimeout(r, 400))).then(() => v.pause());');
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 5000 });
  const igSeqBefore = await captureSeq();
  const igShot = await capture();
  const igShotName = igShot.suggestedFilename();
  const igPng = await readPng(/** @type {string} */ (await igShot.path()), ig);
  check(
    igShotName.startsWith(`${IG_FEED_POST.title}_00-00-0`) && igShotName.endsWith(`_original_${String(igSeqBefore + 1).padStart(5, '0')}.png`) && igPng.width === 720 && igPng.height === 1280 && igPng.left[0] > 150 && igPng.right[2] > 150,
    `暂停着 Capture：仍然锁定着，文件名用帖子的用户名和正文，按视频的真实尺寸存：${igShotName}（${igPng.width}×${igPng.height}）`,
  );
  await ig.evaluate(() => window.scrollTo(0, 2600));
  await clipStatus.filter({ hasText: '没有正在播放、开着声音的视频' }).waitFor({ timeout: 5000 });
  check(true, '暂停着滚出屏幕：放开');
  await ig.evaluate(() => window.scrollTo(0, 0));

  // 没有正文的帖子：下面露着别人的评论
  await onIg('v.muted = true; plain.muted = false; plain.volume = 0.5; return plain.play();');
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  await panel.getByTestId('clip-title').filter({ hasText: IG_PLAIN_POST.user }).waitFor({ timeout: 5000 });
  check((await igTitle()) === IG_PLAIN_POST.user, `没有正文的帖子：只显示用户名，不把别人的评论当成正文：${await igTitle()}`);
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  await ig.waitForTimeout(1500);
  // 点开评论时 Instagram 把网址换成这条帖子的（站内跳转，不重新加载）：离开了首页，这一段自动结束并保存
  const [igLeaveDl] = await Promise.all([ig.waitForEvent('download', { timeout: 10000 }), ig.evaluate((path) => history.pushState(null, '', path), `/igpage/p/${IG_PLAIN_POST.code}/`)]);
  check(/^plain\.user_00m\d\ds-00m\d\ds\.(mp4|webm)$/.test(igLeaveDl.suggestedFilename()), `离开首页时这一段自动结束并保存：${igLeaveDl.suggestedFilename()}`);
  await clipStatus.filter({ hasText: '不是 Instagram 的首页信息流' }).waitFor({ timeout: 5000 });
  check((await clipLog())[0]?.url === `${MOCK}/igpage/p/${IG_PLAIN_POST.code}/`, '帖子页等别的 Instagram 页面：说明只有首页信息流能录；刚才那一段记下的是它自己的帖子链接');
  const igPageReqs = requests.slice(igReqStart).filter((r) => String(r.headers.referer ?? '').startsWith(`${MOCK}/igpage/`));
  check(
    igPageReqs.every((r) => r.method === 'GET' && (r.path.startsWith('/igpage/') || r.path === '/favicon.ico')),
    `Instagram 页面上 TubeMuse 没有发出任何请求（只有你打开的页面本身）${igPageReqs.length ? `：${igPageReqs.map((r) => r.path).join(', ')}` : ''}`,
  );
  await ig.close();
  await panel.bringToFront();

  // ───────────────────────── 抖音：片段录制 ─────────────────────────
  console.log('\n[抖音：精选页里点开一条视频后录"当前这一条"（不认旁边预先加载的下一条）；标题来自这条视频上的作者和描述，不用不更新的页面标题；划到下一条时自动结束]');
  const douyinReqStart = requests.length;
  const [douyin] = await Promise.all([context.waitForEvent('page'), panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}/douyin/jingxuan/travel`)]);
  douyin.on('pageerror', (e) => consoleErrors.push(`douyin pageerror: ${e.message}`));
  await douyin.waitForLoadState('domcontentloaded');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '片段', exact: true }).click();
  // 把侧边栏拿到前台时，当前标签页变成了侧边栏自己：切回抖音那个标签页（就像你点回它）
  await panel.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [t] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes('/douyin/'));
    await c.tabs.update(t.id, { active: true });
  });
  await clipStatus.filter({ hasText: '没有点开的抖音视频' }).waitFor({ timeout: 10000 });
  check(true, '精选页上还没点开视频：说明要点开一条再录');
  const douyinAppHtml = () => douyin.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('app')).outerHTML);
  const douyinTitle = async () => (await panel.getByTestId('clip-title').textContent()) ?? '';
  const douyinActive = '[data-e2e="feed-active-video"] video';
  await douyin.evaluate(() => /** @type {any} */ (window).__openVideo());
  await douyin.waitForFunction((s) => (/** @type {HTMLVideoElement | null} */ (document.querySelector(s))?.readyState ?? 0) >= 2, douyinActive, { timeout: 30000 });
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  // 时长要等视频元数据到了、下一轮推送才进侧边栏：选成预先加载的下一条时这里是 0:30，会超时
  await panel.getByTestId('clip-position').filter({ hasText: / 0:(19|20)$/ }).waitFor({ timeout: 5000 });
  check(
    (await douyinTitle()) === DOUYIN_VIDEO.title,
    `站内点开视频后不用刷新就能录：选中"当前这一条"（20 秒），标题是作者 - 描述（去掉 @ 和"展开"，不混进弹幕）：${await douyinTitle()}`,
  );
  check(
    ((await panel.getByTestId('clip-no-burn').textContent()) ?? '').includes('弹幕') && (await panel.getByTestId('clip-burn').count()) === 0 && (await panel.getByTestId('clip-capture').count()) === 1,
    '界面写明弹幕不会录进去、划到下一条时自动结束；不提供字幕烧录，有 Capture',
  );
  const douyinHtmlBefore = await douyinAppHtml();
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  await douyin.waitForTimeout(2500);
  const [douyinDl] = await Promise.all([douyin.waitForEvent('download', { timeout: 15000 }), panel.getByTestId('clip-stop').click()]);
  const douyinName = douyinDl.suggestedFilename();
  check(douyinName.startsWith(`${DOUYIN_VIDEO.title}_00m0`) && /_00m\d\ds-00m\d\ds\.(mp4|webm)$/.test(douyinName), `停止后保存，文件名用作者、描述与起止时间：${douyinName}`);
  const douyinClip = await analyzeClip(douyin, /** @type {string} */ (await douyinDl.path()));
  check(container(douyinClip.head) === douyinName.split('.').pop() && douyinClip.duration > 2 && douyinClip.rms > 0.02, `视频静音播放（浏览器的限制）也录到了声音（${douyinClip.duration.toFixed(1)} 秒，响度 ${douyinClip.rms.toFixed(3)}）`);
  await panel.getByTestId('clip-log').filter({ hasText: douyinName }).waitFor({ timeout: 5000 });
  const douyinLog = (await clipLog())[0];
  check(
    douyinLog?.site === 'douyin' && douyinLog.videoId === DOUYIN_VIDEO.id && douyinLog.title === DOUYIN_VIDEO.title && douyinLog.url === `${MOCK}/douyin/jingxuan/travel?modal_id=${DOUYIN_VIDEO.id}` && douyinLog.fileName === douyinName,
    '"最近录过的片段"记下这是抖音的视频，链接只留类目路径和 modal_id（别的参数去掉）',
  );
  check(((await panel.getByTestId('clip-log').textContent()) ?? '').includes('抖音 · '), '侧边栏的片段清单标出抖音');
  check((await douyinAppHtml()) === douyinHtmlBefore && (await douyin.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '录制没有往抖音页面里加任何元素，没有点到抖音自己的任何东西（包括"展开"）');

  // 再录一段，录制中划到下一条：这一段自动结束并保存；侧边栏跟上新的一条（页面标题还是上一条的）
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  await douyin.waitForTimeout(1500);
  const [douyinNextDl] = await Promise.all([douyin.waitForEvent('download', { timeout: 10000 }), douyin.evaluate(() => /** @type {any} */ (window).__nextVideo())]);
  check(douyinNextDl.suggestedFilename().startsWith(`${DOUYIN_VIDEO.title}_00m0`), `划到下一条时这一段自动结束并保存，文件名是录的那一条的：${douyinNextDl.suggestedFilename()}`);
  await panel.getByTestId('clip-ready').filter({ hasText: '切到了别的视频' }).waitFor({ timeout: 5000 });
  await panel.getByTestId('clip-log').filter({ hasText: douyinNextDl.suggestedFilename() }).waitFor({ timeout: 5000 });
  check((await clipLog())[0]?.videoId === DOUYIN_VIDEO.id && (await clipLog())[0]?.title === DOUYIN_VIDEO.title, '这一段记在录的那一条名下');
  await panel.getByTestId('clip-title').filter({ hasText: DOUYIN_NEXT.title }).waitFor({ timeout: 5000 });
  await panel.getByTestId('clip-position').filter({ hasText: / 0:(29|30)$/ }).waitFor({ timeout: 5000 });
  const douyinStale = await douyin.evaluate(() => document.title);
  check(
    (await douyinTitle()) === DOUYIN_NEXT.title && douyinStale === DOUYIN_VIDEO.docTitle,
    `侧边栏跟上新的一条（30 秒）：标题来自这条视频本身，没有用还停在上一条的页面标题（"${douyinStale}"）`,
  );
  await panel.getByRole('button', { name: '释放内存' }).click();

  // 换成有画面的视频（静音、暂停着交回来），暂停着截
  await useFramedVideo(douyin, douyinActive);
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 5000 });
  const douyinSeqBefore = await captureSeq();
  const douyinShot = await capture();
  const douyinShotName = douyinShot.suggestedFilename();
  const douyinPng = await readPng(/** @type {string} */ (await douyinShot.path()), douyin);
  check(
    douyinShotName.startsWith(`${DOUYIN_NEXT.title}_00-00-0`) && douyinShotName.endsWith(`_original_${String(douyinSeqBefore + 1).padStart(5, '0')}.png`) && douyinPng.width === 720 && douyinPng.height === 1280 && douyinPng.left[0] > 150 && douyinPng.right[2] > 150,
    `Capture：截的是当前这一条，文件名用它的作者和描述，按视频的真实尺寸存，不带弹幕：${douyinShotName}（${douyinPng.width}×${douyinPng.height}）`,
  );
  await douyin.evaluate(() => /** @type {any} */ (window).__closeVideo());
  await clipStatus.filter({ hasText: '没有点开的抖音视频' }).waitFor({ timeout: 5000 });
  check(true, '关掉这条视频回到精选页：说明要点开一条再录');
  const douyinPageReqs = requests.slice(douyinReqStart).filter((r) => String(r.headers.referer ?? '').startsWith(`${MOCK}/douyin/`));
  check(
    douyinPageReqs.every((r) => r.method === 'GET' && (r.path.startsWith('/douyin/') || r.path === '/favicon.ico')),
    `抖音页面上 TubeMuse 没有发出任何请求（只有你打开的页面本身）${douyinPageReqs.length ? `：${douyinPageReqs.map((r) => r.path).join(', ')}` : ''}`,
  );
  await douyin.close();
  await panel.bringToFront();

  // 搜索结果页里点开的视频（2026-11-11 用户要求）：同样能录；记下的链接是精选页的那种（搜索页的网址回不到这条视频），搜索词不进记录
  console.log('\n[抖音：搜索结果页里点开的视频也能录、也能 Capture；记下的链接不带搜索词]');
  // 网址用站内搜索框搜出来的那种：search 前面带着发起搜索时所在页面的路径（这里是精选页），并带着 aid
  const douyinSearchPath = `/douyin/jingxuan/search/${encodeURIComponent('大麦哥')}`;
  const [douyinSearch] = await Promise.all([
    context.waitForEvent('page'),
    panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}${douyinSearchPath}?aid=4fe2f184-e2e&type=general`),
  ]);
  douyinSearch.on('pageerror', (e) => consoleErrors.push(`douyin search pageerror: ${e.message}`));
  await douyinSearch.waitForLoadState('domcontentloaded');
  await panel.bringToFront();
  await panel.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [t] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes('/douyin/jingxuan/search/'));
    await c.tabs.update(t.id, { active: true });
  });
  await clipStatus.filter({ hasText: '没有点开的抖音视频' }).waitFor({ timeout: 10000 });
  check(((await clipStatus.textContent()) ?? '').includes('搜索结果'), '搜索结果页上还没点开视频：说明在精选页或搜索结果里点开一条再录');
  await douyinSearch.evaluate(() => /** @type {any} */ (window).__openVideo());
  await douyinSearch.waitForFunction((s) => (/** @type {HTMLVideoElement | null} */ (document.querySelector(s))?.readyState ?? 0) >= 2, douyinActive, { timeout: 30000 });
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  await panel.getByTestId('clip-position').filter({ hasText: / 0:(19|20)$/ }).waitFor({ timeout: 5000 });
  const douyinSearchUrl = await douyinSearch.evaluate(() => location.pathname + location.search);
  check(
    douyinSearchUrl === `${douyinSearchPath}?modal_id=${DOUYIN_VIDEO.id}&type=general` && (await douyinTitle()) === DOUYIN_VIDEO.title && (await douyinSearch.evaluate(() => document.title)) === DOUYIN_SEARCH_TITLE,
    `搜索结果里点开视频（网址是 /jingxuan/search/<搜索词>?modal_id=…&type=general）后能录：标题是作者 - 描述，不是页面标题"${DOUYIN_SEARCH_TITLE}"`,
  );
  const douyinSearchHtmlBefore = await douyinSearch.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('app')).outerHTML);
  const douyinSearchLogTop = (await clipLog())[0]?.id;
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  await douyinSearch.waitForTimeout(2000);
  const [douyinSearchDl] = await Promise.all([douyinSearch.waitForEvent('download', { timeout: 15000 }), panel.getByTestId('clip-stop').click()]);
  const douyinSearchName = douyinSearchDl.suggestedFilename();
  // 等新记录真的写进去再读：这一段和上面精选页那一段录的是同一条视频、都从 0 秒起，文件名可能一模一样，
  // 只等"清单里出现这个文件名"会被那条旧记录立刻满足（CI 上撞到过，读到的是旧记录）
  await panel.waitForFunction(
    async (prev) => ((await /** @type {any} */ (globalThis).chrome.storage.local.get('clipLog')).clipLog ?? [])[0]?.id !== prev,
    douyinSearchLogTop,
    { timeout: 5000 },
  );
  await panel.getByTestId('clip-log').filter({ hasText: douyinSearchName }).waitFor({ timeout: 5000 });
  const douyinSearchLog = (await clipLog())[0];
  check(
    douyinSearchName.startsWith(`${DOUYIN_VIDEO.title}_00m0`) &&
      douyinSearchLog?.site === 'douyin' &&
      douyinSearchLog.videoId === DOUYIN_VIDEO.id &&
      douyinSearchLog.fileName === douyinSearchName &&
      douyinSearchLog.url === `${MOCK}/douyin/jingxuan?modal_id=${DOUYIN_VIDEO.id}`,
    `在搜索结果里录的片段存下来了，记的是精选页的链接，不带搜索词：${douyinSearchLog?.url}`,
  );
  const douyinSearchLogText = JSON.stringify(douyinSearchLog);
  check(!douyinSearchLogText.includes('search') && !douyinSearchLogText.includes('大麦哥') && !douyinSearchLogText.includes(encodeURIComponent('大麦哥')), '这条记录里没有搜索页的网址，也没有搜索词');
  check(
    (await douyinSearch.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('app')).outerHTML)) === douyinSearchHtmlBefore,
    '录制没有往抖音搜索页里加任何元素',
  );
  await panel.getByRole('button', { name: '释放内存' }).click();
  await useFramedVideo(douyinSearch, douyinActive);
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 5000 });
  const douyinSearchShot = await capture();
  const douyinSearchPng = await readPng(/** @type {string} */ (await douyinSearchShot.path()), douyinSearch);
  check(
    douyinSearchShot.suggestedFilename().startsWith(`${DOUYIN_VIDEO.title}_00-00-0`) && douyinSearchPng.width === 720 && douyinSearchPng.height === 1280,
    `搜索结果里点开的视频也能 Capture：${douyinSearchShot.suggestedFilename()}（${douyinSearchPng.width}×${douyinSearchPng.height}）`,
  );
  check((await douyinSearch.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '没有点到抖音搜索页自己的任何东西');
  await douyinSearch.evaluate(() => /** @type {any} */ (window).__closeVideo());
  await clipStatus.filter({ hasText: '没有点开的抖音视频' }).waitFor({ timeout: 5000 });
  check(true, '关掉这条视频回到搜索结果：说明要点开一条再录');
  await douyinSearch.close();
  await panel.bringToFront();

  // ───────────────────────── 酷播：片段录制 ─────────────────────────
  console.log('\n[酷播：首页说明要点开影片；站内跳进播放页后录播放器里的视频，不认投屏按钮里和页面角落的那两个]');
  const kubbReqStart = requests.length;
  const [kubb] = await Promise.all([context.waitForEvent('page'), panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}/kubb/home`)]);
  kubb.on('pageerror', (e) => consoleErrors.push(`kubb pageerror: ${e.message}`));
  await kubb.waitForLoadState('domcontentloaded');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '片段', exact: true }).click();
  // 把侧边栏拿到前台时，当前标签页变成了侧边栏自己：切回酷播那个标签页（就像你点回它）
  await panel.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [t] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes('/kubb/'));
    await c.tabs.update(t.id, { active: true });
  });
  await clipStatus.filter({ hasText: '不是播放页' }).waitFor({ timeout: 10000 });
  check(true, '首页上：说明要点开一部影片才能录');
  const kubbVideo = '#video_player';
  const kubbPlaying = () => kubb.waitForFunction((s) => (/** @type {HTMLVideoElement | null} */ (document.querySelector(s))?.readyState ?? 0) >= 2, kubbVideo, { timeout: 30000 });
  /** 侧边栏"当前位置"里的总时长是这么多秒（时长要等视频元数据到了、下一轮推送才进侧边栏；选错视频会超时） */
  const kubbShowsDuration = (/** @type {number} */ seconds) =>
    panel.getByTestId('clip-position').filter({ hasText: new RegExp(` 0:(${seconds - 1}|${seconds})$`) }).waitFor({ timeout: 5000 });
  await kubb.evaluate(() => /** @type {any} */ (window).__openMovie());
  await kubbPlaying();
  await clipStatus.filter({ hasText: '可以开始录制' }).waitFor({ timeout: 10000 });
  check(
    ((await panel.getByTestId('clip-title').textContent()) ?? '') === KUBB_MOVIE.title && (await panel.getByTestId('clip-burn').count()) === 0 && (await panel.getByTestId('clip-capture').count()) === 1,
    '站内跳进播放页后不用刷新就能录：标题来自页面标题（去掉"-免费在线观看-酷播"），不提供字幕烧录，有 Capture',
  );
  const kubbNote = (await panel.getByTestId('clip-no-burn').textContent()) ?? '';
  check(kubbNote.includes('弹幕') && kubbNote.includes('别的广告认不出来'), '界面写明弹幕不会录进去，片头广告只认得出一种');
  await kubbShowsDuration(KUBB_MOVIE.seconds);
  check(true, `选中播放器的视频（${KUBB_MOVIE.seconds} 秒），不是投屏按钮里空的那个，也不是页面角落 1×1 的（7 秒）：${(await panel.getByTestId('clip-position').textContent()) ?? ''}`);
  const kubbAppHtml = () => kubb.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('app')).outerHTML);
  const kubbAppBefore = await kubbAppHtml();
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  const kubbBadge = await sw2.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [t] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes('/kubb/'));
    return c.action.getBadgeText({ tabId: t.id });
  });
  check(kubbBadge === 'REC', `酷播上录制中，工具栏图标也显示 REC（实际："${kubbBadge}"）`);
  await kubb.waitForTimeout(2500);
  const [kubbDl] = await Promise.all([kubb.waitForEvent('download', { timeout: 15000 }), panel.getByTestId('clip-stop').click()]);
  const kubbName = kubbDl.suggestedFilename();
  check(/^八仙！_00m\d\ds-00m\d\ds\.(mp4|webm)$/.test(kubbName), `停止后保存，文件名用片名与起止时间：${kubbName}`);
  const kubbClip = await analyzeClip(kubb, /** @type {string} */ (await kubbDl.path()));
  check(container(kubbClip.head) === kubbName.split('.').pop() && kubbClip.duration > 1.5 && kubbClip.rms > 0.02, `录到了这个视频的声音（${kubbClip.duration.toFixed(1)} 秒，响度 ${kubbClip.rms.toFixed(3)}）`);
  await panel.getByTestId('clip-log').filter({ hasText: kubbName }).waitFor({ timeout: 5000 });
  const kubbMovieUrl = `${MOCK}/kubb/play/${KUBB_MOVIE.id}`;
  const kubbLog = (await clipLog())[0];
  check(kubbLog?.site === 'kubb' && kubbLog.videoId === KUBB_MOVIE.id && kubbLog.title === KUBB_MOVIE.title && kubbLog.url === kubbMovieUrl && kubbLog.fileName === kubbName, '"最近录过的片段"记下这是酷播的影片和它的播放页链接');
  check(((await panel.getByTestId('clip-log').textContent()) ?? '').includes('酷播 · '), '侧边栏的片段清单标出酷播');
  check((await kubbAppHtml()) === kubbAppBefore && (await kubb.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '录制没有往酷播页面里加任何元素，没有点到酷播自己的任何东西');

  console.log('\n[酷播：换一集（网址带上 ?id=，播放器还是同一个）时这一段自动结束并保存，接下来录的是新的一集]');
  await kubb.evaluate(() => /** @type {any} */ (window).__openShow());
  await kubbPlaying();
  await panel.getByTestId('clip-title').filter({ hasText: KUBB_SHOW.title }).waitFor({ timeout: 10000 });
  await kubbShowsDuration(KUBB_SHOW.seconds);
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  await kubb.waitForTimeout(1500);
  const [switchDl] = await Promise.all([kubb.waitForEvent('download', { timeout: 10000 }), kubb.evaluate(() => /** @type {any} */ (window).__switchEpisode())]);
  check(/^玉簟秋-24_.*\.(mp4|webm)$/.test(switchDl.suggestedFilename()), `换集时自动结束这一段并保存，文件名是开录时那一集：${switchDl.suggestedFilename()}`);
  await panel.getByTestId('clip-ready').filter({ hasText: '切到了别的视频' }).waitFor({ timeout: 5000 });
  check(true, '侧边栏说明这一段为什么结束');
  await panel.getByTestId('clip-log').filter({ hasText: switchDl.suggestedFilename() }).waitFor({ timeout: 5000 });
  const kubbShowLog = (await clipLog())[0];
  check(kubbShowLog?.videoId === KUBB_SHOW.id && kubbShowLog.url === `${MOCK}/kubb/play/${KUBB_SHOW.id}`, '不带 ?id= 打开的那一集：记录里的链接是播放页本身');
  await kubbPlaying();
  await panel.getByTestId('clip-title').filter({ hasText: KUBB_EPISODE.title }).waitFor({ timeout: 10000 });
  await kubbShowsDuration(KUBB_EPISODE.seconds);
  check(true, `换集后侧边栏跟上新的一集：${(await panel.getByTestId('clip-title').textContent()) ?? ''}`);

  console.log('\n[酷播：片头广告和正片用同一个播放器放：广告时不截图、不录，广告放完不当成"视频播完"，换成正片后接着录，声音也接得上]');
  await kubb.evaluate(() => /** @type {any} */ (window).__playAd());
  await kubb.waitForFunction((s) => { const v = /** @type {HTMLVideoElement} */ (document.querySelector(s)); return v.readyState >= 2 && !v.currentSrc.startsWith('blob:'); }, kubbVideo, { timeout: 15000 });
  const kubbSeqAtAd = await captureSeq();
  await panel.getByTestId('clip-capture').click();
  await panel.getByRole('alert').filter({ hasText: '正在播广告' }).waitFor({ timeout: 5000 });
  check((await captureSeq()) === kubbSeqAtAd && (await panel.getByTestId('clip-capture-saved').count()) === 0, '广告时点 Capture：不截，说明原因，不占序号');
  await panel.getByTestId('clip-start').click();
  await clipStatus.filter({ hasText: '广告中' }).waitFor({ timeout: 10000 });
  // 广告放到头：真实页面上它报"播完"，约 1.4 秒后才换成正片
  await kubb.waitForFunction((s) => /** @type {HTMLVideoElement} */ (document.querySelector(s)).ended, kubbVideo, { timeout: (KUBB_AD_SECONDS + 10) * 1000 });
  await kubb.waitForTimeout(1200);
  check(
    (await panel.getByTestId('clip-live').count()) === 1 && (await recordedSec()) === 0 && ((await clipStatus.textContent()) ?? '').includes('广告中'),
    '广告期间不计时；广告放完不算视频播完，这一段还在等正片',
  );
  await kubb.evaluate(() => /** @type {any} */ (window).__endAd());
  await clipStatus.filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
  await kubb.waitForTimeout(2500);
  const [adDl] = await Promise.all([kubb.waitForEvent('download', { timeout: 15000 }), panel.getByTestId('clip-stop').click()]);
  const adName = adDl.suggestedFilename();
  const adClip = await analyzeClip(kubb, /** @type {string} */ (await adDl.path()));
  check(/^玉簟秋-02_00m0\ds-00m0\ds\.(mp4|webm)$/.test(adName), `成片从正片开始算起止时间，不带广告的时间：${adName}`);
  check(adClip.duration > 1.5 && adClip.duration < KUBB_AD_SECONDS && adClip.rms > 0.02, `成片只有正片这一段，换片源后声音接上了（${adClip.duration.toFixed(1)} 秒，响度 ${adClip.rms.toFixed(3)}）`);
  await panel.getByTestId('clip-log').filter({ hasText: adName }).waitFor({ timeout: 5000 });
  const kubbEpisodeLog = (await clipLog())[0];
  check(
    kubbEpisodeLog?.site === 'kubb' && kubbEpisodeLog.videoId === `${KUBB_SHOW.id}.${KUBB_EPISODE.id}` && kubbEpisodeLog.url === `${MOCK}/kubb/play/${KUBB_SHOW.id}?id=${KUBB_EPISODE.id}`,
    '换过集的记录：ID 带上分集，链接只留 ?id=（别的参数去掉），点标题能回到这一集',
  );
  check((await kubb.evaluate(() => /** @type {any} */ (window).__nativeClicks)) === 0, '全程没有点到酷播自己的任何东西');
  const kubbPageReqs = requests.slice(kubbReqStart).filter((r) => String(r.headers.referer ?? '').startsWith(`${MOCK}/kubb/`));
  check(
    kubbPageReqs.every((r) => r.method === 'GET' && (r.path.startsWith('/kubb/') || r.path === '/favicon.ico')),
    `酷播页面上 TubeMuse 没有发出任何请求（只有页面自己取的视频）${kubbPageReqs.length ? `：${[...new Set(kubbPageReqs.map((r) => r.path))].join(', ')}` : ''}`,
  );
  await kubb.close();
  await panel.bringToFront();
}
