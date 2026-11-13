// @ts-check
// 中文配音（DECISIONS §74）：给 YouTube 视频选一个本地 .m4a → 存进扩展的 IndexedDB → 下次打开同一视频时提示 →
// 开启后在页面里叠加播放，跟随播放 / 暂停 / 拖动 / 倍速与偏移 → 原声降 20%（你改音量、广告、关闭时的处理）→ 移除。
// 全程不发任何新的网络请求。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, MOCK, root, shots } from '../harness.mjs';
import { DUB_VIDEO } from '../mock-server.mjs';

/** @param {import('../harness.mjs').Harness} t */
export async function dub(t) {
  const { context, sw, options, requests, consoleErrors } = t;
  const panel = await t.openPanel();
  const M4A = join(root, 'tests', 'fixtures', 'xyz-tones.m4a');
  const MP3 = join(root, 'tests', 'fixtures', 'xyz-tones-vbr.mp3');

  console.log('\n[中文配音：设置]');
  await options.bringToFront();
  await options.reload();
  await options.locator('#dub').waitFor();
  const dubSection = (await options.locator('#dub').textContent()) ?? '';
  check(
    dubSection.includes('19. 中文配音') && (await options.getByTestId('dub-enabled').isChecked()) && (await options.getByTestId('dub-prompt-setting').isChecked()),
    '设置页有"中文配音"一节（19），默认启用、默认提示',
  );
  const manifest = await sw.evaluate(() => /** @type {any} */ (globalThis).chrome.runtime.getManifest());
  check(
    manifest.content_scripts.some((/** @type {any} */ c) => c.js.includes('content-dub.js') && !c.world) && !['offscreen', 'tabs', 'downloads'].some((p) => manifest.permissions.includes(p)),
    `配音脚本注入 YouTube；没有新增权限：${manifest.permissions.join(', ')}`,
  );

  console.log('\n[中文配音：给当前视频选一个本地 .m4a → 存进扩展的 IndexedDB]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: '配音', exact: true }).click();
  const reqStart = requests.length;
  const url = `${MOCK}/watch?v=${DUB_VIDEO.id}`;
  const [page] = await Promise.all([context.waitForEvent('page'), panel.evaluate((u) => /** @type {any} */ (globalThis).chrome.tabs.create({ url: u, active: true }), url)]);
  page.on('pageerror', (e) => consoleErrors.push(`dub watch pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`dub watch: ${m.text()}`));
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1, null, { timeout: 20000 });
  await panel.getByTestId('dub-pick').waitFor({ timeout: 10000 });
  check(((await panel.getByTestId('dub-current').textContent()) ?? '').includes('还没有中文配音'), '没关联过的视频：说明并给出"选择 .m4a 文件"');

  // 选错文件：mp3 改名成 .m4a
  await panel.getByTestId('dub-file').setInputFiles({ name: 'fake.m4a', mimeType: 'audio/mp4', buffer: readFileSync(MP3) });
  await panel.getByTestId('dub-error').waitFor({ timeout: 10000 });
  check(((await panel.getByTestId('dub-error').textContent()) ?? '').includes('不是 m4a'), '改了扩展名的 mp3：说明不是 m4a，不存');
  await panel.getByTestId('dub-error').locator('.icon-btn').click();

  await panel.getByTestId('dub-file').setInputFiles(M4A);
  await panel.getByTestId('dub-done').waitFor({ timeout: 15000 });
  const stored = /** @type {any} */ (await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('dubs'))).dubs;
  const rec = stored?.[DUB_VIDEO.id];
  check(!!rec && rec.fileName === 'xyz-tones.m4a' && rec.durationSec > 91 && rec.durationSec < 93 && rec.videoDurationSec === DUB_VIDEO.seconds && rec.delaySec === 0, `记下视频与文件的对应关系、时长：${JSON.stringify(rec)}`);
  const idb = await panel.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('tubemuse-dub');
        req.onsuccess = () => {
          const tx = req.result.transaction('audio', 'readonly');
          const all = tx.objectStore('audio').getAll();
          const keys = tx.objectStore('audio').getAllKeys();
          tx.oncomplete = () => {
            resolve({ keys: keys.result, sizes: all.result.map((/** @type {Blob} */ b) => b.size) });
            req.result.close();
          };
        };
      }),
  );
  const m4aSize = readFileSync(M4A).length;
  check(JSON.stringify(idb) === JSON.stringify({ keys: [rec?.fileId], sizes: [m4aSize] }), `音频整份存在扩展的 IndexedDB 里（${m4aSize} 字节），不在 chrome.storage.local：${JSON.stringify(idb)}`);
  const local = JSON.stringify(await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get(null)));
  check(local.length < 200_000 && !local.includes('ftyp'), 'chrome.storage.local 里只有元数据');
  const dur = (await panel.getByTestId('dub-duration').textContent()) ?? '';
  check(dur.includes('中文 1:32 · 原视频 2:00') && dur.includes('中文短') && !/逐句|逐词/.test(dur), `对比两者时长，说明只能对齐开头：${dur}`);

  // 这个标签页的 ID（后面会把它跳到别的页面再跳回来，所以只按网址找一次）
  const dubTabId = await sw.evaluate(async (vid) => {
    const c = /** @type {any} */ (globalThis).chrome;
    const [tab] = (await c.tabs.query({})).filter((/** @type {any} */ x) => String(x.url).includes(vid));
    return tab.id;
  }, DUB_VIDEO.id);
  const tabOf = async () => dubTabId;
  const badge = async () => sw.evaluate((id) => /** @type {any} */ (globalThis).chrome.action.getBadgeText({ tabId: id }), await tabOf());
  /** 问页面里的配音脚本要状态（和侧边栏同一条路） */
  const dubState = async () =>
    /** @type {any} */ (await panel.evaluate((id) => /** @type {any} */ (globalThis).chrome.tabs.sendMessage(id, { type: 'tubemuse:dub:get-state' }), await tabOf()));
  const waitState = async (/** @type {(s: any) => boolean} */ ok, /** @type {string} */ what, timeout = 10000) => {
    const until = Date.now() + timeout;
    let s;
    while (Date.now() < until) {
      s = await dubState();
      if (ok(s)) return s;
      await page.waitForTimeout(150);
    }
    throw new Error(`等不到配音状态：${what}（最后：${JSON.stringify(s)}）`);
  };
  await waitState((s) => s.available && !s.active, '有配音、未开启');
  for (let i = 0; i < 20 && (await badge()) !== '中'; i++) await page.waitForTimeout(150);
  check((await badge()) === '中', '工具栏图标标出"中"：这个视频有中文版');

  console.log('\n[中文配音：离开这个视频 → "中"消失；下次打开同一视频时提示 → 开启]');
  await page.goto('about:blank');
  for (let i = 0; i < 20 && (await badge()) !== ''; i++) await page.waitForTimeout(150);
  check((await badge()) === '', '在同一个标签页里跳到别的页面：图标上的"中"清掉');
  await page.goto(url);
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1, null, { timeout: 20000 });
  for (let i = 0; i < 20 && (await badge()) !== '中'; i++) await page.waitForTimeout(150);
  check((await badge()) === '中', '再打开这个视频：图标上又标出"中"');
  await panel.getByRole('tab', { name: '找片', exact: true }).click();
  await panel.getByTestId('dub-prompt').waitFor({ timeout: 10000 });
  check(((await panel.getByTestId('dub-prompt').textContent()) ?? '').includes('这个视频有中文配音：xyz-tones.m4a'), '重新打开同一视频：侧边栏顶部提示有中文版（不自动出声）');
  check((await dubState()).playing === false && (await page.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).volume)) === 1, '只提示：配音没放、原声没动');
  await page.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).play());
  await panel.getByTestId('dub-prompt-on').click();
  const playing = await waitState((s) => s.phase === 'ready' && s.playing && s.status.includes('配音播放中'), '开启后放起来');
  check(playing.dubDuration > 91 && playing.dubDuration < 93, `开启后音频由后台从 IndexedDB 交给页面，页面里放起来（中文 ${playing.dubDuration?.toFixed(1)} 秒）`);
  check((await panel.getByTestId('dub-prompt').count()) === 0 && (await badge()) === '中', '开启后顶部提示消失，图标仍标"中"');
  const vol = () => page.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).volume);
  check(Math.abs((await vol()) - 0.8) < 0.005, `配音开启时原声降 20%：1 → ${await vol()}`);
  check((await page.locator('audio').count()) === 0 && (await page.evaluate(() => document.querySelectorAll('[data-tubemuse]').length)) === 0, '页面里没有插入任何元素（配音的 <audio> 不放进页面）');
  await page.waitForTimeout(1500);
  let s = await dubState();
  check(Math.abs(s.dubTime - s.videoTime) < 0.4, `跟着视频走：视频 ${s.videoTime.toFixed(2)} 秒 · 中文 ${s.dubTime.toFixed(2)} 秒`);

  console.log('\n[中文配音：暂停、拖动进度、倍速、偏移]');
  await page.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).pause());
  s = await waitState((x) => !x.playing && x.status.includes('视频暂停'), '跟着暂停');
  await page.waitForTimeout(800);
  const s2 = await dubState();
  check(Math.abs(s2.dubTime - s.dubTime) < 0.05, `视频暂停，配音跟着停（停在 ${s2.dubTime.toFixed(2)} 秒）`);
  await page.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.currentTime = 50;
    void v.play();
  });
  s = await waitState((x) => x.playing && x.videoTime > 50.3, '拖动后继续放');
  await page.waitForTimeout(1000);
  s = await dubState();
  check(s.dubTime > 50 && Math.abs(s.dubTime - s.videoTime) < 0.4, `拖到 0:50：配音跟着跳过去（视频 ${s.videoTime.toFixed(2)} · 中文 ${s.dubTime.toFixed(2)}）`);
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).playbackRate = 1.5));
  await page.waitForTimeout(2000);
  s = await dubState();
  check(Math.abs(s.dubTime - s.videoTime) < 0.4, `1.5 倍速：配音跟着加速（视频 ${s.videoTime.toFixed(2)} · 中文 ${s.dubTime.toFixed(2)}）`);
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).playbackRate = 1));

  await panel.getByRole('tab', { name: '配音', exact: true }).click();
  await panel.getByTestId('dub-delay-input').fill('2');
  await panel.getByTestId('dub-delay-input').press('Enter');
  await panel.getByTestId('dub-delay-input').blur();
  for (let i = 0; i < 30; i++) {
    const d = /** @type {any} */ (await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('dubs'))).dubs?.[DUB_VIDEO.id]?.delaySec;
    if (d === 2) break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(1000);
  s = await dubState();
  check(s.delaySec === 2 && Math.abs(s.videoTime - 2 - s.dubTime) < 0.4, `偏移 +2 秒（中文推后）：中文 = 视频 − 2（视频 ${s.videoTime.toFixed(2)} · 中文 ${s.dubTime.toFixed(2)}），按视频存下`);
  check(((await panel.getByTestId('dub-delay-text').textContent()) ?? '').includes('中文推后 2 秒'), '偏移的说法：中文推后 2 秒');
  // 拖滑块：实时生效，松手后存下
  const range = panel.getByTestId('dub-delay-range');
  await range.evaluate((el) => {
    const r = /** @type {HTMLInputElement} */ (el);
    r.value = '-1.5';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitState((x) => x.delaySec === -1.5, '滑块实时生效');
  await range.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
  for (let i = 0; i < 30; i++) {
    const d = /** @type {any} */ (await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('dubs'))).dubs?.[DUB_VIDEO.id]?.delaySec;
    if (d === -1.5) break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(800);
  s = await dubState();
  check(Math.abs(s.videoTime + 1.5 - s.dubTime) < 0.4, `滑块拖到 −1.5（中文提前）：拖动时实时生效、松手后存下（视频 ${s.videoTime.toFixed(2)} · 中文 ${s.dubTime.toFixed(2)}）`);
  await panel.getByRole('button', { name: '归零' }).click();
  await waitState((x) => x.delaySec === 0, '归零');

  console.log('\n[中文配音：原声音量——你改音量、广告、关闭]');
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).volume = 0.5));
  for (let i = 0; i < 20 && Math.abs((await vol()) - 0.4) > 0.005; i++) await page.waitForTimeout(100);
  check(Math.abs((await vol()) - 0.4) < 0.005, `配音开着时你把音量调到 50%：按你的新音量再降 20%（${await vol()}）`);
  check(((await panel.getByTestId('dub-volume').textContent()) ?? '').includes('你的音量 50% → 现在 40%'), '侧边栏写明原声音量：你的音量 → 现在');
  await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.add('ad-showing'));
  s = await waitState((x) => !x.playing && x.status.includes('广告'), '广告时暂停');
  check(Math.abs((await vol()) - 0.5) < 0.005, `广告期间配音暂停、原声恢复（${await vol()}）`);
  await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.remove('ad-showing'));
  await waitState((x) => x.playing, '广告结束继续');
  check(Math.abs((await vol()) - 0.4) < 0.005, '广告结束：配音继续、原声再降');
  await panel.screenshot({ path: join(shots, '70-dub-panel.png'), fullPage: true });
  await panel.getByTestId('dub-toggle').click();
  await waitState((x) => !x.active && !x.playing, '关闭');
  check(Math.abs((await vol()) - 0.5) < 0.005, `关闭配音：配音停、原声恢复成你的音量（${await vol()}）`);

  console.log('\n[中文配音：移除]');
  await panel.getByTestId('dub-remove').click();
  await panel.getByTestId('dub-remove-yes').click();
  await panel.getByTestId('dub-pick').waitFor({ timeout: 10000 });
  const after = /** @type {any} */ (await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('dubs'))).dubs;
  const idbAfter = await panel.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('tubemuse-dub');
        req.onsuccess = () => {
          const k = req.result.transaction('audio', 'readonly').objectStore('audio').count();
          k.onsuccess = () => {
            resolve(k.result);
            req.result.close();
          };
        };
      }),
  );
  check(JSON.stringify(after) === '{}' && idbAfter === 0, '移除：对应关系和 IndexedDB 里的音频都删掉');
  await waitState((x) => !x.available, '移除后页面里也没有了');
  for (let i = 0; i < 20 && (await badge()) !== ''; i++) await page.waitForTimeout(150);
  check((await badge()) === '', '移除后图标上的"中"消失');

  // 全程只有页面自己取视频：TubeMuse 没有为配音发出任何请求
  const newReqs = requests.slice(reqStart).filter((r) => !(r.path === `/watch` || r.path === `/media/${DUB_VIDEO.id}.wav` || r.path === '/favicon.ico' || r.path.startsWith('/youtube/v3/videos')));
  check(newReqs.length === 0, `配音没有发出任何网络请求${newReqs.length ? `：${[...new Set(newReqs.map((r) => r.path))].join(', ')}` : ''}`);
  await page.close();
  await panel.bringToFront();
}
