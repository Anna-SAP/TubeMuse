// @ts-check
// 中文配音（DECISIONS §74）：给 YouTube 视频选一个本地 .m4a → 存进扩展的 IndexedDB → 下次打开同一视频时提示 →
// 开启后在页面里叠加播放，跟随播放 / 暂停 / 拖动 / 倍速与偏移 → 对齐点分段跟随（DECISIONS §75）→ 原声降 20%（你改音量、广告、关闭时的处理）
// → 配音开着时录片段：录下的是双语混音（DECISIONS §76）→ 从配音音频识别字幕（DECISIONS §91）→ 移除。
// 除了"从配音音频识别字幕"那一节（发往 OpenAI 转写和大模型校对），全程不发任何新的网络请求。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, MOCK, root, shots } from '../harness.mjs';
import { DUB_VIDEO, dubProofs, dubTranscribes } from '../mock-server.mjs';

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
  /** "从配音音频识别字幕"那一节发出的请求在 requests 里的范围：只有这一节会联网（DECISIONS §91） */
  let asrFrom = 0;
  let asrTo = 0;
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
  const storedRec = async () => /** @type {any} */ (await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('dubs'))).dubs?.[DUB_VIDEO.id];
  const waitStored = async (/** @type {(r: any) => boolean} */ ok, /** @type {string} */ what) => {
    for (let i = 0; i < 50; i++) {
      const r = await storedRec();
      if (r && ok(r)) return r;
      await page.waitForTimeout(100);
    }
    throw new Error(`等不到存下：${what}（最后：${JSON.stringify(await storedRec())}）`);
  };
  // "中文位置"滑块：选此刻放中文的哪里——拖动时实时生效，松手后按此刻的视频位置换算成这一段的偏移存下
  const pos = panel.getByTestId('dub-position-range');
  await pos.waitFor({ timeout: 5000 });
  s = await dubState();
  const want = Math.round(s.videoTime + 1.5);
  await pos.evaluate((el, v) => {
    const r = /** @type {HTMLInputElement} */ (el);
    r.value = String(v);
    r.dispatchEvent(new Event('input', { bubbles: true }));
  }, want);
  await waitState((x) => x.delaySec < -0.5 && x.delaySec > -2.6, '"中文位置"实时生效');
  await pos.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
  const afterPos = await waitStored((r) => r.delaySec < -0.5 && r.delaySec > -2.6, '"中文位置"松手后存下');
  await page.waitForTimeout(800);
  s = await dubState();
  check(Math.abs(s.videoTime - afterPos.delaySec - s.dubTime) < 0.4, `拖"中文位置"让中文提前约 1.5 秒：拖动时实时生效、松手后存成偏移 ${afterPos.delaySec} 秒（视频 ${s.videoTime.toFixed(2)} · 中文 ${s.dubTime.toFixed(2)}）`);
  await panel.getByRole('button', { name: '归零' }).click();
  await waitState((x) => x.delaySec === 0, '归零');

  console.log('\n[中文配音：对齐点——中文比原视频短很多（或删了段落）时分段对齐：先说完就停下等画面，说得慢就跳过去]');
  await page.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.pause();
    v.currentTime = 70;
  });
  await waitState((x) => !x.playing && Math.abs(x.videoTime - 70) < 0.3, '停在 1:10');
  await panel.getByTestId('dub-anchor-add').click();
  let r = await waitStored((x) => x.anchors?.length === 1, '加对齐点');
  check(Math.abs(r.anchors[0].video - 70) < 0.3 && Math.abs(r.anchors[0].dub - 70) < 0.3 && r.delaySec === 0, `在视频 1:10 点"在这里加对齐点"：记下视频 ${r.anchors[0].video} ↔ 中文 ${r.anchors[0].dub}（按此刻的偏移，加完听到的不变）`);
  check(((await panel.getByTestId('dub-align-note').textContent()) ?? '').includes('加了对齐点'), '说明从这里起是新的一段');
  await panel.getByRole('button', { name: '+10 秒', exact: true }).click();
  r = await waitStored((x) => Math.abs(x.anchors?.[0]?.dub - (x.anchors?.[0]?.video - 10)) < 0.05, '这一段 +10 秒');
  check(r.delaySec === 0 && ((await panel.getByTestId('dub-segment').textContent()) ?? '').includes('第 1 个对齐点之后'), '+10 秒只改对齐点之后这一段（改的是这个对齐点的中文位置），开头那段的偏移不变');

  console.log('\n[中文配音：对齐图——两条音轨画出此刻的对齐状态（DECISIONS §77）：此刻差多少、全片还差多少；指着哪里说哪里；拖下面的中文调这一段]');
  const mapText = async (/** @type {string} */ id) => ((await panel.getByTestId(id).textContent()) ?? '').replace(/\s+/g, ' ');
  const waitMapText = async (/** @type {string} */ id, /** @type {(s: string) => boolean} */ ok, /** @type {string} */ what) => {
    for (let i = 0; i < 50; i++) {
      const x = await mapText(id);
      if (ok(x)) return x;
      await page.waitForTimeout(100);
    }
    throw new Error(`对齐图等不到：${what}（最后：${await mapText(id)}）`);
  };
  // 此刻差距（DECISIONS §78）：「对齐」区顶上大字写视频 − 中文差多少秒，下面一行写意思和两边各在哪里
  const gapOf = (/** @type {string} */ x) => Number(x.replace('−', '-').replace(/[^\d.+-]/g, ''));
  // 大字是"还差多少没对上"（DECISIONS §79）= 全片时长差 − 此刻中文滞后，按页面实际读到的两段时长算
  const durs = await dubState();
  const total = durs.videoDuration - durs.dubDuration;
  const near = (/** @type {string} */ x, /** @type {number} */ want) => Math.abs(gapOf(x) - want) < 0.11;
  let gapNow = await waitMapText('dub-gap-value', (x) => near(x, total - 10), `还差 ${(total - 10).toFixed(1)} 秒`);
  const gapNote = await mapText('dub-gap-note');
  check(
    (await mapText('dub-gap')).includes('还差多少没对上（全片时长差 − 此刻中文滞后；0 = 全部对完）') &&
      gapNote.includes(`= 全片时长差 ${total.toFixed(1)} 秒`) &&
      gapNote.includes('− 此刻中文滞后 10.0 秒 · 视频 1:10 ↔ 中文 1:00') &&
      (await panel.getByTestId('dub-gap').getAttribute('data-kind')) === 'left',
    `「对齐」区顶上大字写还差多少没对上 = 全片时长差 ${total.toFixed(2)} 秒 − 此刻中文滞后 10 秒：${gapNow}（${gapNote}）`,
  );
  check(
    (await mapText('dub-map-overall')).includes(`还差 ${Number((total - 10).toFixed(1))} 秒`),
    '和对齐图说明里的"还差"是同一个数',
  );
  const gapLook = await panel.evaluate(() => {
    const g = /** @type {HTMLElement} */ (document.querySelector('[data-testid=dub-gap]'));
    const v = /** @type {HTMLElement} */ (document.querySelector('[data-testid=dub-gap-value]'));
    const cs = getComputedStyle(v);
    const align = /** @type {HTMLElement} */ (document.querySelector('[data-testid=dub-align]'));
    const map = /** @type {HTMLElement} */ (document.querySelector('[data-testid=dub-map]'));
    return { size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight), inAlign: align.contains(g), beforeMap: !!(g.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  check(gapLook.size >= 28 && gapLook.weight >= 700 && gapLook.inAlign && gapLook.beforeMap, `读数又大又醒目（${gapLook.size}px、粗 ${gapLook.weight}），在"对齐"一栏的最上面、对齐图之前`);
  let overall = await mapText('dub-map-overall');
  check(/中文在视频 1:4[12] 放完/.test(overall) && overall.includes('全片中文短') && !/逐句|逐词/.test(overall), `全片：照现在的对齐中文在哪里放完、后面还差多少：${overall}`);
  const holdKinds = await panel.getByTestId('dub-map-hold').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
  check(JSON.stringify(holdKinds) === JSON.stringify(['wait', 'after-end']), `全片图上标出中文停下等画面（1:00–1:10）和中文放完之后只有原声的地方：${holdKinds.join(', ')}`);
  check(
    (await panel.getByTestId('dub-map-overview-anchor').count()) === 1 && (await panel.getByTestId('dub-map-anchor').count()) === 1 && (await mapText('dub-map-anchor')) === '1',
    '对齐点画在两条音轨之间，编号和"第 1 个对齐点"一样',
  );
  check((await panel.getByTestId('dub-anchor').first().evaluate((el) => /** @type {HTMLLIElement} */ (el).value)) === 1, '列表里的对齐点也从 1 编号（"开头"不占编号）');
  check((await mapText('dub-map-now-gap')) === '+10.0 秒', '附近图上播放头旁写着这一段差多少');
  // 指着上面英文的 1:05（中文停下等画面的那 10 秒里）
  const detail = panel.getByTestId('dub-map-detail');
  // 对齐图上面还有别的内容（配音字幕、保存完整双语视频）：先滚到屏幕中间（不被头部挡住），鼠标才指得到
  await detail.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await detail.boundingBox());
  const pxPerSec = (box.width - 36) / 120;
  const centerX = box.x + 30 + (box.width - 36) / 2;
  await panel.mouse.move(centerX - 5 * pxPerSec, box.y + 26);
  const hover = await waitMapText('dub-map-hover', (x) => x.includes('视频 1:05'), '指着 1:05');
  check(hover.includes('视频 1:05：中文停下等画面，只有原声') && hover.includes('视频到 1:10 的对齐点再接着放'), `指着英文那条：说出这时听到的是什么（${hover}）`);
  await panel.mouse.move(centerX + 3 * pxPerSec, box.y + 90);
  const hoverZh = await waitMapText('dub-map-hover', (x) => x.startsWith('中文 1:03'), '指着中文 1:03');
  check(hoverZh.includes('中文 1:03 → 在视频 1:13 放（第 1 个对齐点之后）'), `指着中文那条：说出这一句在视频哪里放（${hoverZh}）`);
  // 拖下面的中文往右 40 像素：这一段的中文推后 40 / 每秒像素 秒——拖动时页面里的配音实时跟着，松手后存下
  const dragBy = 40;
  const wantOff = Math.round((10 + dragBy / pxPerSec) * 10) / 10;
  const y0 = box.y + 95;
  await panel.mouse.move(centerX, y0);
  await panel.mouse.down();
  await panel.mouse.move(centerX + dragBy / 2, y0, { steps: 4 });
  s = await waitState((x) => x.delaySec > 10.3 && x.delaySec < wantOff, '拖动时实时生效');
  const gapMid = gapOf(await mapText('dub-gap-value'));
  check(gapMid < total - 10.3 && gapMid > total - wantOff, `拖到一半：还差多少已经跟着变小（${gapMid} 秒）`);
  const anchorVideo = r.anchors[0].video;
  check(Math.abs((await storedRec()).anchors[0].dub - (anchorVideo - 10)) < 0.05, `拖到一半：页面里的配音已经按 ${s.delaySec} 秒跟着，还没存`);
  await panel.mouse.move(centerX + dragBy, y0, { steps: 4 });
  await panel.mouse.up();
  r = await waitStored((x) => Math.abs(x.anchors?.[0]?.dub - (anchorVideo - wantOff)) < 0.15, '拖完存下');
  check(r.delaySec === 0 && Math.abs(r.anchors[0].video - 70) < 0.3, `在对齐图上把中文往右拖 ${dragBy} 像素 = 这一段推后 ${(wantOff - 10).toFixed(1)} 秒：松手后存成对齐点 视频 ${r.anchors[0].video} ↔ 中文 ${r.anchors[0].dub}（开头那段不变）`);
  gapNow = await waitMapText('dub-gap-value', (x) => near(x, total - wantOff), '拖完读数跟着变');
  check((await mapText('dub-gap-note')).includes(`− 此刻中文滞后 ${wantOff.toFixed(1)} 秒`), `拖完还差多少跟着变：${gapNow}`);
  check((await mapText('dub-delay-value')).includes(`+${wantOff.toFixed(1)} 秒`), '上面的"这一段的偏移"也跟着变');
  // 改回 +10 秒，后面接着测分段跟随
  await panel.getByTestId('dub-delay-input').fill('10');
  await panel.getByTestId('dub-delay-input').press('Enter');
  await panel.getByTestId('dub-delay-input').blur();
  r = await waitStored((x) => Math.abs(x.anchors?.[0]?.dub - (anchorVideo - 10)) < 0.05, '改回 +10 秒');
  await waitMapText('dub-gap-value', (x) => near(x, total - 10), '改回 +10 秒后读数跟着变');
  // 侧边栏放大到 125%（DECISIONS §80）：图跟着变大但不撑出去；鼠标位置按缩放换算过，指哪里、拖多少仍然准
  {
    const zf = 1.25;
    // 不用 Playwright 的 click()：它点之前会先把吸顶的按钮"滚到可见"，把页面滚走
    const zoomClick = (/** @type {string} */ id) => panel.getByTestId(id).evaluate((el) => /** @type {HTMLElement} */ (el).click());
    await zoomClick('zoom-in');
    await zoomClick('zoom-in');
    await panel.locator('[data-testid=zoom][data-zoom="125"]').waitFor();
    await detail.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    const fit = await panel.evaluate(() => {
      const svg = /** @type {SVGSVGElement} */ (document.querySelector('[data-testid=dub-map-detail]'));
      const map = /** @type {HTMLElement} */ (document.querySelector('[data-testid=dub-map]'));
      return { svg: svg.getBoundingClientRect().width, map: map.getBoundingClientRect().width, overflowX: document.documentElement.scrollWidth - innerWidth };
    });
    check(Math.abs(fit.svg - fit.map) < 2 * zf && fit.overflowX <= 0, `放大到 125%：对齐图跟着变大，仍然正好占满这一栏（图 ${fit.svg.toFixed(0)}px，栏 ${fit.map.toFixed(0)}px），没有横向滚动条`);
    // 对齐图上面还有别的内容（配音字幕、保存完整双语视频）：先滚到屏幕中间（不被头部挡住），鼠标才指得到
    await detail.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const zbox = /** @type {{ x: number, y: number, width: number, height: number }} */ (await detail.boundingBox());
    const plot = zbox.width / zf - 36;
    const zPxPerSec = (plot / 120) * zf;
    const zCenterX = zbox.x + (30 + plot / 2) * zf;
    await panel.mouse.move(zCenterX - 5 * zPxPerSec, zbox.y + 26 * zf);
    const zHover = await waitMapText('dub-map-hover', (x) => x.includes('视频 1:05'), '125% 时指着 1:05');
    check(zHover.includes('视频 1:05：中文停下等画面，只有原声'), `125% 时指着英文那条的 1:05：说的还是 1:05（${zHover.slice(0, 24)}…）`);
    const zDragBy = 50;
    const zWant = Math.round((10 + zDragBy / zPxPerSec) * 10) / 10;
    const zy = zbox.y + 95 * zf;
    await panel.mouse.move(zCenterX, zy);
    await panel.mouse.down();
    await panel.mouse.move(zCenterX + zDragBy, zy, { steps: 6 });
    await panel.mouse.up();
    r = await waitStored((x) => Math.abs(x.anchors?.[0]?.dub - (anchorVideo - zWant)) < 0.15, '125% 时拖完存下');
    check(Math.abs(r.anchors[0].dub - (anchorVideo - zWant)) < 0.15, `125% 时把中文往右拖 ${zDragBy} 像素 = 推后 ${(zWant - 10).toFixed(1)} 秒（屏幕上每秒 ${zPxPerSec.toFixed(2)} 像素）：存下的偏移是 +${(anchorVideo - r.anchors[0].dub).toFixed(1)} 秒`);
    await panel.getByTestId('dub-map').screenshot({ path: join(shots, '72b-dub-align-map-zoom-125.png') });
    await zoomClick('zoom-reset');
    await panel.locator('[data-testid=zoom][data-zoom="100"]').waitFor();
    await panel.getByTestId('dub-delay-input').fill('10');
    await panel.getByTestId('dub-delay-input').press('Enter');
    await panel.getByTestId('dub-delay-input').blur();
    r = await waitStored((x) => Math.abs(x.anchors?.[0]?.dub - (anchorVideo - 10)) < 0.05, '恢复 100%、改回 +10 秒');
    await waitMapText('dub-gap-value', (x) => near(x, total - 10), '恢复 100%、改回 +10 秒后读数跟着变');
  }
  await panel.getByTestId('dub-map-zoom').filter({ hasText: '30 秒' }).click();
  check((await panel.getByTestId('dub-map-zoom').filter({ hasText: '30 秒' }).getAttribute('aria-pressed')) === 'true', '附近可以放大到 30 秒');
  await panel.getByTestId('dub-map').screenshot({ path: join(shots, '72-dub-align-map.png') });
  await panel.getByTestId('dub-map-zoom').filter({ hasText: '2 分' }).click();
  // 往下滚去按微调按钮时，读数吸在头部下面，一直看得见
  await panel.getByTestId('dub-anchor-add').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  const stuck = await panel.evaluate(() => {
    const head = /** @type {HTMLElement} */ (document.querySelector('header.top')).getBoundingClientRect().bottom;
    const g = /** @type {HTMLElement} */ (document.querySelector('[data-testid=dub-gap]')).getBoundingClientRect();
    const title = /** @type {HTMLElement} */ (document.querySelector('[data-testid=dub-segment]')).getBoundingClientRect();
    const add = /** @type {HTMLElement} */ (document.querySelector('[data-testid=dub-anchor-add]')).getBoundingClientRect();
    return { head, top: g.top, bottom: g.bottom, titleTop: title.top, addTop: add.top, h: innerHeight };
  });
  check(
    stuck.titleTop < stuck.head && Math.abs(stuck.top - stuck.head) < 2 && stuck.bottom < stuck.addTop && stuck.addTop < stuck.h,
    `往下滚到微调按钮时，"对齐"的标题已经滚出去，差距读数吸在头部下面、不挡按钮（读数 ${Math.round(stuck.top)}–${Math.round(stuck.bottom)}，头部到 ${Math.round(stuck.head)}，按钮在 ${Math.round(stuck.addTop)}）`,
  );
  await panel.screenshot({ path: join(shots, '73-dub-gap-sticky.png') });
  await panel.evaluate(() => scrollTo(0, 0));
  await page.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.currentTime = 75;
    void v.play();
  });
  await page.waitForTimeout(1500);
  s = await dubState();
  check(s.segment?.index === 0 && Math.abs(s.videoTime - 10 - s.dubTime) < 0.4, `对齐点之后：中文 = 视频 − 10（视频 ${s.videoTime.toFixed(2)} · 中文 ${s.dubTime.toFixed(2)}）`);
  // 开头那段的中文到 60 秒为止：从 0:57 放，3 秒后中文说完，停下等画面到 1:10 的对齐点
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime = 57));
  s = await waitState((x) => !x.playing && x.status.includes('等画面到 1:10 的对齐点'), '中文说完等画面', 10000);
  check(Math.abs(s.dubTime - (r.anchors[0].dub)) < 0.35 && s.videoTime < 70, `中文这一段先说完：停在中文 ${s.dubTime.toFixed(2)} 秒等画面（视频 ${s.videoTime.toFixed(2)}，原声照常）`);
  const holdNote = await waitMapText('dub-gap-note', (x) => x.includes('停在 1:00 等画面'), '读数：中文停着等');
  // 测试里侧边栏是后台标签页，浏览器不给它动画帧：读数只随每秒一次的读位置变（真正的侧边栏看得见，会连续变），所以等它变大，不只看固定的一小段
  const g1 = gapOf(await mapText('dub-gap-value'));
  const g2 = gapOf(await waitMapText('dub-gap-value', (x) => gapOf(x) < g1 - 0.5, '停着等画面时还差的变小'));
  check(
    g2 < g1 - 0.5 && g2 > total - 10 && (await panel.getByTestId('dub-gap').getAttribute('data-plan')) === 'wait' && holdNote.includes('这几秒正在抵掉差距'),
    `中文停着等画面：这几秒正在抵掉差距，还差的随播放变小（${g1} → ${g2} 秒）：${holdNote}`,
  );
  s = await waitState((x) => x.playing && x.videoTime > 70.8, '到对齐点接着放', 20000);
  check(Math.abs(s.videoTime - 10 - s.dubTime) < 0.4, `画面到了 1:10 的对齐点：中文从停下的地方接着放（视频 ${s.videoTime.toFixed(2)} · 中文 ${s.dubTime.toFixed(2)}）`);
  gapNow = await waitMapText('dub-gap-value', (x) => near(x, total - 10), '跨过对齐点后读数');
  check((await panel.getByTestId('dub-gap').getAttribute('data-plan')) === 'playing', `跨过对齐点：正好接上下一段（全片时长差 − 这一段的偏移 10 秒 = ${gapNow}）`);
  // 说得慢就跳过去：把这一段改成中文提前 10 秒（开头那段的中文要放到 1:20，视频到 1:10 时还没说完）
  await panel.getByRole('button', { name: '−10 秒', exact: true }).click();
  await waitStored((x) => Math.abs(x.anchors?.[0]?.dub - 70) < 0.05, '−10 秒');
  await panel.getByRole('button', { name: '−10 秒', exact: true }).click();
  r = await waitStored((x) => Math.abs(x.anchors?.[0]?.dub - 80) < 0.05, '再 −10 秒');
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime = 67));
  s = await waitState((x) => x.playing && x.videoTime > 71, '过了对齐点', 15000);
  check(Math.abs(s.videoTime + 10 - s.dubTime) < 0.4, `中文这一段说得慢：画面到了 1:10 就跳到 1:20 接着放（视频 ${s.videoTime.toFixed(2)} · 中文 ${s.dubTime.toFixed(2)}）`);
  // 对齐图：中文说得慢的那一段——视频先到了对齐点，没说完的 10 秒被跳过；播放中播放头跟着走
  overall = await waitMapText('dub-map-overall', (x) => x.includes('中文在视频 1:2'), '跳过之后全片');
  const skipKinds = await panel.getByTestId('dub-map-skip').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
  check(JSON.stringify(skipKinds) === JSON.stringify(['cut']) && /中文在视频 1:2[12] 放完/.test(overall), `对齐图标出被跳过的中文（1:10–1:20），中文更早放完：${overall}`);
  const noteA = await mapText('dub-gap-note');
  await page.waitForTimeout(1500);
  const noteB = await mapText('dub-gap-note');
  check(
    noteA !== noteB && near(await mapText('dub-gap-value'), total + 10) && noteB.includes('+ 此刻中文超前 10.0 秒'),
    `中文提前 10 秒：还差的反而多了 10 秒（${await mapText('dub-gap-value')}）；播放中两边的位置跟着走：${noteA} → ${noteB}`,
  );
  const list = (await panel.getByTestId('dub-anchors').textContent()) ?? '';
  check(list.includes('开头：不偏移') && list.includes('视频 1:10 ↔ 中文 1:20'), `对齐点列表：${list.replace(/\s+/g, ' ').slice(0, 80)}`);
  await panel.screenshot({ path: join(shots, '71-dub-anchors.png'), fullPage: true });
  await panel.getByTestId('dub-anchor-remove').click();
  await waitStored((x) => !x.anchors, '删除对齐点');
  await panel.getByTestId('dub-anchor-undo').click();
  r = await waitStored((x) => x.anchors?.length === 1, '撤销删除');
  check(Math.abs(r.anchors[0].video - 70) < 0.3 && Math.abs(r.anchors[0].dub - 80) < 0.05, '删除对齐点可以撤销');

  console.log('\n[中文配音：快速对齐（DECISIONS §82）——点建议的倍速，中文整段变速放满全片，"还差多少"直接到 0；手动对齐点留着，可以切回]');
  // 这时手动对齐里有一个对齐点（视频 1:10 ↔ 中文 1:20），开头不偏移
  const manualBefore = await storedRec();
  await page.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.currentTime = 30;
    void v.play();
  });
  await waitState((x) => x.playing && x.videoTime > 30.3 && x.videoTime < 40, '回到 0:30 放着');
  const quickWant = Number((durs.dubDuration / durs.videoDuration).toFixed(6));
  const quickLabel = `${quickWant.toFixed(2)}×`;
  const applyBtn = panel.getByTestId('dub-quick-apply');
  await applyBtn.waitFor({ timeout: 5000 });
  const quickBox = async () => ((await panel.getByTestId('dub-quick').textContent()) ?? '').replace(/\s+/g, ' ');
  const suggestText = await quickBox();
  check(
    ((await applyBtn.textContent()) ?? '').trim() === quickLabel && suggestText.includes(`中文 1:32.0 ÷ 英文 2:00.0 = ${quickWant.toFixed(4)}（约 ${quickWant.toFixed(2)}）`) && suggestText.includes('建议中文慢放到'),
    `"对齐"一栏给出建议的中文倍速 = 中文时长 ÷ 视频时长：按钮上写 ${quickLabel}，旁边写算式（${suggestText.slice(0, 60)}…）`,
  );
  const quickPlace = await panel.evaluate(() => {
    const q = /** @type {HTMLElement} */ (document.querySelector('[data-testid=dub-quick]'));
    const g = /** @type {HTMLElement} */ (document.querySelector('[data-testid=dub-gap]'));
    const map = /** @type {HTMLElement} */ (document.querySelector('[data-testid=dub-map]'));
    const align = /** @type {HTMLElement} */ (document.querySelector('[data-testid=dub-align]'));
    return { inAlign: align.contains(q), afterGap: !!(g.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING), beforeMap: !!(q.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING), on: q.getAttribute('data-on') };
  });
  check(quickPlace.inAlign && quickPlace.afterGap && quickPlace.beforeMap && quickPlace.on === 'false', '快速对齐在"对齐"一栏里，紧跟在"还差多少"读数下面、对齐图上面；还没开');
  const gapBefore = gapOf(await mapText('dub-gap-value'));
  check(Math.abs(gapBefore) > 5, `点之前（手动对齐）还差 ${gapBefore} 秒`);
  // 截视口（不截整栏）：整栏比视口高，吸顶的读数会盖住它下面的卡片
  await panel.getByTestId('dub-quick').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  await panel.screenshot({ path: join(shots, '74-dub-quick-suggest.png') });
  await applyBtn.click();
  r = await waitStored((x) => x.quickRate === quickWant, '存下快速对齐的倍速');
  check(
    r.delaySec === manualBefore.delaySec && JSON.stringify(r.anchors) === JSON.stringify(manualBefore.anchors) && r.anchors.length === 1,
    `点建议的倍速：按视频存下倍速 ${r.quickRate}（精确值，不是四舍五入的 ${quickWant.toFixed(2)}）；手动的开头偏移和对齐点原样留着：${JSON.stringify(r.anchors)}`,
  );
  gapNow = await waitMapText('dub-gap-value', (x) => x.trim() === '0.0 秒', '应用后还差 0.0 秒');
  const quickNote = await mapText('dub-gap-note');
  check(
    (await panel.getByTestId('dub-gap').getAttribute('data-kind')) === 'done' &&
      (await mapText('dub-gap')).includes('快速对齐：全片时长差由变速匀到整段；0 = 全部对完') &&
      quickNote.includes(`快速对齐：中文按 ${quickWant.toFixed(4)}× 慢放（中文 1:32.0 ÷ 英文 2:00.0），全片时长差 ${total.toFixed(1)} 秒匀到整段，中文和视频同时结束`),
    `应用之后"还差多少没对上"直接是 ${gapNow}（变绿），说明写清是怎么抵掉的：${quickNote}`,
  );
  s = await waitState((x) => x.quickRate === quickWant && x.playing && x.status.includes(`快速对齐，中文按 ${quickLabel} 慢放`), '页面里按倍速放起来');
  await page.waitForTimeout(1200);
  const q1 = await dubState();
  await page.waitForTimeout(2500);
  const q2 = await dubState();
  const speed = (q2.dubTime - q1.dubTime) / (q2.videoTime - q1.videoTime);
  check(
    Math.abs(q2.dubTime - q2.videoTime * quickWant) < 0.4 && Math.abs(speed - quickWant) < 0.08,
    `中文位置 = 视频位置 × 倍速（视频 ${q2.videoTime.toFixed(2)} × ${quickWant.toFixed(4)} = ${(q2.videoTime * quickWant).toFixed(2)}，中文 ${q2.dubTime.toFixed(2)}），中文真的在慢放（这 ${(q2.videoTime - q1.videoTime).toFixed(1)} 秒里中文走了 ${(q2.dubTime - q1.dubTime).toFixed(2)} 秒，${speed.toFixed(2)} 倍）`,
  );
  check(near(await mapText('dub-gap-value'), 0), `播放推进，读数一直是 0（${await mapText('dub-gap-value')}）`);
  // 界面：写明开着、用的倍速；手动的那些控件收起来，留着的对齐点列出来（不能删）；对齐图一段到底
  const onText = await quickBox();
  check(
    (await panel.getByTestId('dub-quick').getAttribute('data-on')) === 'true' &&
      onText.includes(`快速对齐已开`) &&
      onText.includes(`中文整段按 ${quickLabel}（精确 ${quickWant.toFixed(4)}）慢放`) &&
      onText.includes('开头偏移和 1 个对齐点都留着') &&
      !/逐句|逐词/.test(onText),
    `开着时写明倍速、手动对齐的东西留着：${onText.slice(0, 70)}…`,
  );
  check(
    (await panel.getByTestId('dub-anchor-add').count()) === 0 && (await panel.getByTestId('dub-delay-input').count()) === 0 && (await panel.getByTestId('dub-position-range').count()) === 0 && (await panel.getByTestId('dub-anchor-remove').count()) === 0,
    '快速对齐开着时，手动的偏移、"中文位置"、"加对齐点"都收起来（不会误改）',
  );
  const kept = ((await panel.getByTestId('dub-kept').textContent()) ?? '').replace(/\s+/g, ' ');
  check(kept.includes('手动对齐留着的：开头偏移和 1 个对齐点') && kept.includes('视频 1:10 ↔ 中文 1:20') && ((await panel.getByTestId('dub-segment').textContent()) ?? '').includes('快速对齐，全程一段'), `留着的对齐点列在下面：${kept.slice(0, 80)}`);
  overall = await mapText('dub-map-overall');
  check(
    (await panel.getByTestId('dub-map').getAttribute('data-quick')) === 'on' &&
      overall.includes(`快速对齐：中文整段按 ${quickWant.toFixed(4)}× 慢放，和视频同时开始、同时结束`) &&
      (await panel.getByTestId('dub-map-hold').count()) === 0 &&
      (await panel.getByTestId('dub-map-skip').count()) === 0 &&
      (await panel.getByTestId('dub-map-anchor').count()) === 0 &&
      (await panel.getByTestId('dub-map-overview-anchor').count()) === 0 &&
      (await mapText('dub-map-now-gap')) === `${quickLabel} 慢放`,
    `对齐图：一段到底，没有停下等、没有跳过，不画留着不用的对齐点：${overall.slice(0, 50)}…`,
  );
  // 指着图：英文的某一刻 ↔ 中文按倍速换算的那一刻（中文按倍速拉长画，竖着对上）
  {
    // 先把图滚到视口中间：鼠标要指到图的下半条
    await detail.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(200);
    // 对齐图上面还有别的内容（配音字幕、保存完整双语视频）：先滚到屏幕中间（不被头部挡住），鼠标才指得到
    await detail.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const qbox = /** @type {{ x: number, y: number, width: number, height: number }} */ (await detail.boundingBox());
    const qpx = (qbox.width - 36) / 120;
    const qcx = qbox.x + 30 + (qbox.width - 36) / 2;
    const at = (await dubState()).videoTime;
    await panel.mouse.move(qcx - 5 * qpx, qbox.y + 26);
    const hv = await waitMapText('dub-map-hover', (x) => x.startsWith('视频 ') && x.includes('快速对齐'), '快速对齐时指着英文');
    await panel.mouse.move(qcx - 5 * qpx, qbox.y + 90);
    const hz = await waitMapText('dub-map-hover', (x) => x.startsWith('中文 ') && x.includes('快速对齐'), '快速对齐时指着中文');
    const clockSec = (/** @type {string} */ c) => c.split(':').reduce((n, p) => n * 60 + Number(p), 0);
    const mv = /视频 ([\d:]+) ↔ 中文 ([\d:]+)/.exec(hv);
    const mz = /中文 ([\d:]+) → 在视频 ([\d:]+) 放/.exec(hz);
    check(
      !!mv && !!mz && Math.abs(clockSec(mv[2]) - clockSec(mv[1]) * quickWant) <= 1.5 && Math.abs(clockSec(mz[1]) - clockSec(mz[2]) * quickWant) <= 1.5 && Math.abs(clockSec(mv[1]) - (at - 5)) < 6 && Math.abs(clockSec(mz[2]) - (at - 5)) < 6,
      `指着图上同一处：英文那条说"${hv}"，中文那条说"${hz}"——上下对着的是同时听到的`,
    );
    await panel.mouse.move(qbox.x + 5, qbox.y - 30);
  }
  await panel.getByTestId('dub-align').screenshot({ path: join(shots, '75-dub-quick-on.png') });
  // "保存完整双语视频"（DECISIONS §83）合成的是开着配音时听到的声音：快速对齐开着时写明中文是按倍速慢放叠上去的，不再说对齐点
  const fullAboutQuick = ((await panel.getByTestId('dub-full-about').textContent()) ?? '').replace(/\s+/g, ' ');
  check(fullAboutQuick.includes(`中文按快速对齐的 ${quickLabel} 慢放叠上去`) && !fullAboutQuick.includes('对齐点'), `"保存完整双语视频"的说明跟着变：${fullAboutQuick.slice(0, 70)}…`);
  // 倍速跟着视频的倍速；拖进度、暂停照常跟随
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).playbackRate = 1.5));
  await page.waitForTimeout(2000);
  s = await dubState();
  check(Math.abs(s.dubTime - s.videoTime * quickWant) < 0.45, `视频 1.5 倍速：中文按 1.5 × ${quickWant.toFixed(2)} 跟着（视频 ${s.videoTime.toFixed(2)} · 中文 ${s.dubTime.toFixed(2)}，应在 ${(s.videoTime * quickWant).toFixed(2)}）`);
  await page.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.playbackRate = 1;
    // 手动对齐时这里（1:05）中文停着等画面；快速对齐照常放
    v.currentTime = 65;
  });
  s = await waitState((x) => x.playing && x.videoTime > 65.8 && x.videoTime < 75, '拖到 1:05 后继续放');
  check(Math.abs(s.dubTime - s.videoTime * quickWant) < 0.4 && !s.status.includes('等画面'), `拖到 1:05：中文跳到 ${s.dubTime.toFixed(2)}（= ${s.videoTime.toFixed(2)} × ${quickWant.toFixed(4)}），不停下等画面、不看留着的对齐点`);
  // 快到结尾：中文也快放完，两边同时结束
  await page.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.pause();
    v.currentTime = 118;
  });
  s = await waitState((x) => !x.playing && Math.abs(x.videoTime - 118) < 0.3 && Math.abs(x.dubTime - 118 * quickWant) < 0.3, '停在 1:58，中文对好位置');
  check(
    s.status.includes('视频暂停') && s.dubDuration - s.dubTime < 2.2 && s.dubDuration - s.dubTime > 0.8 && near(await mapText('dub-gap-value'), 0),
    `视频还剩 2 秒时中文也只剩 ${(s.dubDuration - s.dubTime).toFixed(2)} 秒（中文 ${s.dubTime.toFixed(2)} / ${s.dubDuration.toFixed(2)}）：同时结束，读数仍是 0`,
  );
  // 切回手动对齐：倍速去掉，开头偏移和对齐点照旧生效
  await panel.getByTestId('dub-quick-off').click();
  r = await waitStored((x) => x.quickRate === undefined, '切回手动对齐');
  check(JSON.stringify(r) === JSON.stringify(manualBefore), `切回手动对齐：存储和开快速对齐之前一模一样（${JSON.stringify(r.anchors)}）`);
  check(((await panel.getByTestId('dub-align-note').textContent()) ?? '').includes('已切回手动对齐：开头偏移和 1 个对齐点照旧生效'), '说明已切回、对齐点照旧生效');
  check((((await panel.getByTestId('dub-full-about').textContent()) ?? '')).includes('中文按开头的偏移和全部 1 个对齐点叠上去'), '"保存完整双语视频"的说明回到"按开头的偏移和全部 1 个对齐点"');
  await panel.getByTestId('dub-anchor-add').waitFor({ timeout: 5000 });
  await page.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.currentTime = 75;
    void v.play();
  });
  s = await waitState((x) => x.playing && x.videoTime > 76 && x.quickRate === undefined && x.segment?.index === 0, '手动对齐接着放');
  await page.waitForTimeout(1200);
  const m1 = await dubState();
  await page.waitForTimeout(1500);
  const m2 = await dubState();
  const manualSpeed = (m2.dubTime - m1.dubTime) / (m2.videoTime - m1.videoTime);
  check(
    Math.abs(m2.videoTime + 10 - m2.dubTime) < 0.4 && Math.abs(manualSpeed - 1) < 0.08 && m2.status.includes('配音播放中，跟着视频走'),
    `切回后按留着的对齐点跟随、中文回到正常速度（视频 ${m2.videoTime.toFixed(2)} · 中文 ${m2.dubTime.toFixed(2)}，${manualSpeed.toFixed(2)} 倍）`,
  );
  check(
    near(await mapText('dub-gap-value'), total + 10) && (await panel.getByTestId('dub-map').getAttribute('data-quick')) === 'off' && (await panel.getByTestId('dub-anchor').count()) === 1 && (await panel.getByTestId('dub-map-overview-anchor').count()) === 1,
    `读数回到手动对齐的"还差"（${await mapText('dub-gap-value')}），对齐点回到图上和列表里，建议倍速的按钮又出现了：${((await applyBtn.textContent()) ?? '').trim()}`,
  );
  // "撤销"：切回手动之后点撤销 = 重新开快速对齐
  await panel.getByTestId('dub-anchor-undo').click();
  await waitStored((x) => x.quickRate === quickWant, '撤销切回 = 重新开快速对齐');
  await waitMapText('dub-gap-value', (x) => x.trim() === '0.0 秒', '重新开后还差 0.0 秒');
  await panel.getByTestId('dub-quick-off').click();
  r = await waitStored((x) => x.quickRate === undefined, '再切回手动对齐');
  check(JSON.stringify(r) === JSON.stringify(manualBefore), '切回可以撤销（重新开快速对齐），再切回仍和原来一样');
  await waitState((x) => x.quickRate === undefined, '页面里回到手动对齐');

  console.log('\n[中文配音：加快英文（DECISIONS §87）——中文原速，英文原声连同画面整段按"视频时长 ÷ 中文时长"快放；整体变速——两边一起变快、对齐不变]');
  const vrate = () => page.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).playbackRate);
  const engWant = Number((durs.videoDuration / durs.dubDuration).toFixed(6));
  const engLabel = `${engWant.toFixed(2)}×`;
  const engBtn = panel.getByTestId('dub-english-apply');
  await engBtn.waitFor({ timeout: 5000 });
  const engSuggest = await quickBox();
  check(
    ((await engBtn.textContent()) ?? '').trim() === engLabel &&
      engSuggest.includes('加快英文或者中文原速，建议英文快放到') &&
      (await mapText('dub-english-formula')).includes(`英文 2:00.0 ÷ 中文 1:32.0 = ${engWant.toFixed(4)}（约 ${engWant.toFixed(2)}）`) &&
      (await mapText('dub-english-note')).includes('中文保持原来的语速'),
    `快速对齐下面给出第三种：加快英文，建议英文快放到 ${engLabel} = 英文时长 ÷ 中文时长（${(await mapText('dub-english-formula')).trim()}）`,
  );
  await page.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.currentTime = 30;
    void v.play();
  });
  await waitState((x) => x.playing && x.videoTime > 30.3 && x.videoTime < 40, '加快英文之前回到 0:30 放着');
  await engBtn.click();
  r = await waitStored((x) => x.englishRate === engWant, '存下加快英文的倍速');
  check(r.quickRate === undefined && r.delaySec === manualBefore.delaySec && JSON.stringify(r.anchors) === JSON.stringify(manualBefore.anchors), `点了之后按视频存下英文的倍速 ${r.englishRate}（精确值），手动的偏移和对齐点原样留着`);
  gapNow = await waitMapText('dub-gap-value', (x) => x.trim() === '0.0 秒', '加快英文后还差 0.0 秒');
  const engNote = await mapText('dub-gap-note');
  check(
    (await panel.getByTestId('dub-gap').getAttribute('data-kind')) === 'done' &&
      (await mapText('dub-gap')).includes('加快英文：全片时长差由英文变速匀到整段；0 = 全部对完') &&
      engNote.includes(`加快英文：英文原声按 ${engWant.toFixed(4)}× 快放、中文原速（英文 2:00.0 ÷ 中文 1:32.0），全片时长差 ${total.toFixed(1)} 秒匀到整段，中文和视频同时结束`),
    `"还差多少没对上"同样直接是 ${gapNow}：${engNote}`,
  );
  s = await waitState((x) => x.englishRate === engWant && x.playing && x.status.includes(`加快英文，英文原声按 ${engLabel} 快放、中文原速`), '页面里英文快放、中文原速');
  check(Math.abs((await vrate()) - engWant) < 0.002 && s.speed?.boosted && Math.abs(s.speed.want - engWant) < 1e-6, `YouTube 页面里视频（英文原声）的倍速被设成 ${(await vrate()).toFixed(4)}（= ${engWant.toFixed(4)}）`);
  await page.waitForTimeout(1200);
  const e1 = { s: await dubState(), at: Date.now() };
  await page.waitForTimeout(2500);
  const e2 = { s: await dubState(), at: Date.now() };
  const wall = (e2.at - e1.at) / 1000;
  const enSpeed = (e2.s.videoTime - e1.s.videoTime) / wall;
  const zhSpeed = (e2.s.dubTime - e1.s.dubTime) / wall;
  check(
    Math.abs(e2.s.dubTime - e2.s.videoTime / engWant) < 0.4 && Math.abs(enSpeed - engWant) < 0.12 && Math.abs(zhSpeed - 1) < 0.1,
    `中文位置 = 视频位置 ÷ ${engWant.toFixed(4)}（视频 ${e2.s.videoTime.toFixed(2)} · 中文 ${e2.s.dubTime.toFixed(2)}）；这 ${wall.toFixed(1)} 秒里英文走了 ${enSpeed.toFixed(2)} 倍、中文 ${zhSpeed.toFixed(2)} 倍（原速）`,
  );
  check(near(await mapText('dub-gap-value'), 0), `播放推进，读数一直是 0（${await mapText('dub-gap-value')}）`);
  const engOn = await quickBox();
  check(
    (await panel.getByTestId('dub-quick').getAttribute('data-mode')) === 'english' &&
      engOn.includes('加快英文已开') &&
      engOn.includes(`英文原声整段按 ${engLabel}（精确 ${engWant.toFixed(4)}）快放，中文原速，音调不变`) &&
      engOn.includes('切回手动对齐') &&
      engOn.includes('开头偏移和 1 个对齐点都留着') &&
      engOn.includes(`也可以改成快速对齐（英文原速）：中文慢放到 ${quickLabel}`) &&
      !/逐句|逐词/.test(engOn),
    `面板照快速对齐那块写：已开、倍速、切回手动、留着的东西，还能直接换成快速对齐：${engOn.slice(0, 70)}…`,
  );
  check(
    ((await panel.getByTestId('dub-segment').textContent()) ?? '').includes(`加快英文，全程一段（英文 ${engLabel} 快放，中文原速）`) &&
      (await mapText('dub-speed-now')).includes(`英文 ${Number(engWant.toFixed(2))}×（画面跟着） · 中文 1×（加快英文 ${engLabel}）`) &&
      (await mapText('dub-status')).includes('加快英文') &&
      (await mapText('dub-duration')).includes(`加快英文开着：英文原声整段按 ${engLabel} 快放、中文原速`) &&
      (await panel.getByTestId('dub-anchor-add').count()) === 0 &&
      ((await panel.getByTestId('dub-kept').textContent()) ?? '').includes('加快英文期间不用'),
    `"现在在"、状态、倍速、时长各行都跟着变；手动的控件收起来：${await mapText('dub-speed-now')}`,
  );
  overall = await mapText('dub-map-overall');
  check(
    (await panel.getByTestId('dub-map').getAttribute('data-mode')) === 'english' &&
      overall.includes(`加快英文：英文原声整段按 ${engWant.toFixed(4)}× 快放、中文原速，和视频同时开始、同时结束`) &&
      (await mapText('dub-map-now-gap')) === `英文 ${engLabel} 快放` &&
      (await mapText('dub-map')).includes(`附近（英文按 ${engLabel} 压短画、中文原样画`) &&
      (await mapText('dub-map-hover')).includes('加快英文：英文整段变速、中文原速，一段到底') &&
      (await panel.getByTestId('dub-map-anchor').count()) === 0,
    `对齐图：一段到底，"附近"里英文按倍速压短画、中文原样画；播放头旁写英文的倍速：${overall.slice(0, 60)}…`,
  );
  {
    // 指着图上同一处：英文 v ↔ 中文 v ÷ 倍速（横轴是中文的时间）
    await detail.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(200);
    const ebox = /** @type {{ x: number, y: number, width: number, height: number }} */ (await detail.boundingBox());
    const epx = (ebox.width - 36) / 120;
    const ecx = ebox.x + 30 + (ebox.width - 36) / 2;
    await panel.mouse.move(ecx - 5 * epx, ebox.y + 26);
    const hv = await waitMapText('dub-map-hover', (x) => x.startsWith('视频 ') && x.includes('加快英文'), '加快英文时指着英文');
    await panel.mouse.move(ecx - 5 * epx, ebox.y + 90);
    const hz = await waitMapText('dub-map-hover', (x) => x.startsWith('中文 ') && x.includes('加快英文'), '加快英文时指着中文');
    const clockSec = (/** @type {string} */ c) => c.split(':').reduce((n, p) => n * 60 + Number(p), 0);
    const mv = /视频 ([\d:]+) ↔ 中文 ([\d:]+)/.exec(hv);
    const mz = /中文 ([\d:]+) → 在视频 ([\d:]+) 放/.exec(hz);
    check(
      !!mv && !!mz && Math.abs(clockSec(mv[1]) - clockSec(mv[2]) * engWant) <= 1.5 && Math.abs(clockSec(mz[2]) - clockSec(mz[1]) * engWant) <= 1.5 && Math.abs(clockSec(mv[2]) - clockSec(mz[1])) <= 1.5,
      `指着图上同一处：英文那条说"${hv}"，中文那条说"${hz}"——上下对着的是同时听到的`,
    );
    await panel.mouse.move(ebox.x + 5, ebox.y - 30);
  }
  await panel.getByTestId('dub-align').screenshot({ path: join(shots, '75b-dub-english-on.png') });
  const fullAboutEng = await mapText('dub-full-about');
  check(
    fullAboutEng.includes(`英文原声按加快英文的 ${engLabel} 快放（音调不变），中文按原速叠上去`) && fullAboutEng.includes(`整片快到 ${engLabel}`) && fullAboutEng.includes('不重新编码'),
    `"保存完整双语视频"的说明：画面不重新编码、跟着英文快放，中文原速：${fullAboutEng.slice(0, 90)}…`,
  );
  // 你在 YouTube 播放器里改倍速（这里直接改 <video>，和 YouTube 的倍速菜单做的一样）：记成你的倍速，再乘上去
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).playbackRate = 1.5));
  for (let i = 0; i < 30 && Math.abs((await vrate()) - 1.5 * engWant) > 0.002; i++) await page.waitForTimeout(100);
  s = await waitState((x) => x.speed?.user === 1.5, 'YouTube 里选了 1.5 倍');
  check(Math.abs((await vrate()) - 1.5 * engWant) < 0.002 && (await mapText('dub-speed-now')).includes('YouTube 里选的 1.5×'), `你在 YouTube 里选 1.5 倍：英文 = 1.5 × ${engWant.toFixed(4)} = ${(await vrate()).toFixed(3)}，中文跟着 1.5 倍`);
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).playbackRate = 1));
  for (let i = 0; i < 30 && Math.abs((await vrate()) - engWant) > 0.002; i++) await page.waitForTimeout(100);
  check(Math.abs((await vrate()) - engWant) < 0.002, '改回 1 倍：英文回到加快英文的倍速');
  // 广告：不加速（不替你缩短广告），原样恢复；广告完了接着加快
  await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.add('ad-showing'));
  await waitState((x) => x.status.includes('广告'), '加快英文时放广告');
  for (let i = 0; i < 30 && (await vrate()) !== 1; i++) await page.waitForTimeout(100);
  check((await vrate()) === 1, '广告期间视频回到你的倍速（不加速广告）');
  await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.remove('ad-showing'));
  await waitState((x) => x.playing && x.englishRate === engWant, '广告完了');
  for (let i = 0; i < 30 && Math.abs((await vrate()) - engWant) > 0.002; i++) await page.waitForTimeout(100);
  check(Math.abs((await vrate()) - engWant) < 0.002, '广告完了：英文接着加快');
  // 关掉配音：视频回到你的倍速；再开启：接着加快
  await panel.getByTestId('dub-toggle').click();
  await waitState((x) => !x.active, '关掉配音');
  for (let i = 0; i < 30 && (await vrate()) !== 1; i++) await page.waitForTimeout(100);
  check((await vrate()) === 1, '关掉配音：视频的倍速恢复成你的 1 倍');
  await panel.getByTestId('dub-toggle').click();
  await waitState((x) => x.active && x.playing, '重新开启配音');
  for (let i = 0; i < 30 && Math.abs((await vrate()) - engWant) > 0.002; i++) await page.waitForTimeout(100);
  check(Math.abs((await vrate()) - engWant) < 0.002, '重新开启：英文接着加快');

  // 整体变速：两边一起快 1.25 倍，对齐不变
  check((await mapText('dub-speed')).includes('整体变速') && (await mapText('dub-speed-value')).trim() === '1×', '对齐卡片下面有"整体变速"，现在是 1×');
  await panel.locator('[data-testid="dub-speed-preset"][data-rate="1.25"]').click();
  r = await waitStored((x) => x.overallRate === 1.25, '存下整体倍速 1.25');
  check(r.englishRate === engWant && JSON.stringify(r.anchors) === JSON.stringify(manualBefore.anchors), '整体倍速按视频存下，加快英文和对齐点都还在');
  for (let i = 0; i < 30 && Math.abs((await vrate()) - 1.25 * engWant) > 0.002; i++) await page.waitForTimeout(100);
  s = await waitState((x) => x.overallRate === 1.25 && x.playing && x.status.includes('（整体 1.25×）'), '整体 1.25 倍放着');
  await page.waitForTimeout(1000);
  const o1 = { s: await dubState(), at: Date.now() };
  await page.waitForTimeout(2500);
  const o2 = { s: await dubState(), at: Date.now() };
  const owall = (o2.at - o1.at) / 1000;
  check(
    Math.abs((await vrate()) - 1.25 * engWant) < 0.002 &&
      Math.abs((o2.s.dubTime - o1.s.dubTime) / owall - 1.25) < 0.12 &&
      Math.abs(o2.s.dubTime - o2.s.videoTime / engWant) < 0.4 &&
      near(await mapText('dub-gap-value'), 0),
    `整体 1.25 倍：英文 ${(await vrate()).toFixed(3)} 倍、中文 ${((o2.s.dubTime - o1.s.dubTime) / owall).toFixed(2)} 倍，中文位置仍 = 视频 ÷ ${engWant.toFixed(4)}，还差仍是 0`,
  );
  check(
    (await mapText('dub-speed-value')).trim() === '1.25×' &&
      (await mapText('dub-speed-note')).includes('已经对好的关系不变') &&
      (await mapText('dub-speed-now')).includes('· 中文 1.25×（加快英文') &&
      (await mapText('dub-full-about')).includes('整体倍速 1.25× 也一起写进去') &&
      ((await panel.getByTestId('dub-item').filter({ hasText: '（当前视频）' }).textContent()) ?? '').includes('整体 1.25×'),
    `倍速一行、"保存完整双语视频"、已关联列表都写上整体倍速：${await mapText('dub-speed-now')}`,
  );
  await panel.getByTestId('dub-speed-up').click();
  await waitStored((x) => x.overallRate === 1.3, '整体倍速 + 0.05');
  await panel.getByTestId('dub-speed-down').click();
  await waitStored((x) => x.overallRate === 1.25, '整体倍速 − 0.05');
  // 换成快速对齐：英文回到原速（× 整体倍速），中文慢放；整体倍速还在
  await panel.getByTestId('dub-quick-apply').click();
  r = await waitStored((x) => x.quickRate === quickWant && x.englishRate === undefined, '从加快英文直接换成快速对齐');
  for (let i = 0; i < 30 && Math.abs((await vrate()) - 1.25) > 0.002; i++) await page.waitForTimeout(100);
  s = await waitState((x) => x.quickRate === quickWant && x.playing, '快速对齐 × 整体 1.25 放着');
  await page.waitForTimeout(1500);
  s = await dubState();
  check(
    r.overallRate === 1.25 && Math.abs((await vrate()) - 1.25) < 0.002 && Math.abs(s.dubTime - s.videoTime * quickWant) < 0.4 && s.status.includes('快速对齐') && s.status.includes('（整体 1.25×）'),
    `换成快速对齐：英文 ${(await vrate()).toFixed(3)} 倍（只有整体倍速），中文照快速对齐跟着（视频 ${s.videoTime.toFixed(2)} · 中文 ${s.dubTime.toFixed(2)}）`,
  );
  // 切回手动 + 整体倍速：手动对齐也能整体变速
  await panel.getByTestId('dub-quick-off').click();
  await waitStored((x) => x.quickRate === undefined && x.englishRate === undefined && x.overallRate === 1.25, '切回手动、整体倍速留着');
  await page.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.currentTime = 75;
  });
  s = await waitState((x) => x.playing && x.videoTime > 76 && x.quickRate === undefined && x.englishRate === undefined, '手动对齐 × 整体 1.25 放着');
  await page.waitForTimeout(1500);
  s = await dubState();
  check(Math.abs((await vrate()) - 1.25) < 0.002 && Math.abs(s.videoTime + 10 - s.dubTime) < 0.45 && s.status.includes('配音播放中，跟着视频走（整体 1.25×）'), `手动对齐也能整体变速：视频 1.25 倍，中文照对齐点跟着（视频 ${s.videoTime.toFixed(2)} · 中文 ${s.dubTime.toFixed(2)}）`);
  await panel.locator('[data-testid="dub-speed-preset"][data-rate="1"]').click();
  r = await waitStored((x) => x.overallRate === undefined, '整体倍速调回 1×');
  for (let i = 0; i < 30 && (await vrate()) !== 1; i++) await page.waitForTimeout(100);
  check(JSON.stringify(r) === JSON.stringify(manualBefore) && (await vrate()) === 1 && (await panel.getByTestId('dub-speed-now').count()) === 0, '调回 1×：存储和原来一模一样，视频回到 1 倍，倍速一行收起');
  await page.screenshot({ path: join(shots, '75c-dub-english-page.png') });

  await panel.getByTestId('dub-anchor-remove').click();
  await waitStored((x) => !x.anchors, '再删除');
  await page.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.currentTime = 20;
    void v.play();
  });
  await waitState((x) => x.playing && x.segment?.index === -1, '回到全程一个偏移');

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

  console.log('\n[中文配音：视频控制键（DECISIONS §85）——对齐图的图例下面一排：暂停 / 播放，后退 5/10/30/60 秒，前进 5/10/15/30/60 秒；跳完、停下之后配音照现在的对齐跟上]');
  const vt = () => page.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime);
  const vPaused = () => page.evaluate(() => /** @type {HTMLVideoElement} */ (document.querySelector('video')).paused);
  const seekBtn = (/** @type {number} */ by) => panel.locator(`[data-testid="dub-seek"][data-by="${by}"]`);
  const playBtn = panel.getByTestId('dub-play');
  await panel.getByTestId('dub-transport').waitFor({ timeout: 5000 });
  const place = await panel.evaluate(() => {
    const q = (/** @type {string} */ id) => document.querySelector(`[data-testid="${id}"]`);
    const bar = /** @type {HTMLElement} */ (q('dub-transport'));
    const after = (/** @type {Element | null} */ a, /** @type {Element | null} */ b) => !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
      inMap: !!bar.closest('[data-testid="dub-map"]'),
      afterLegend: after(q('dub-map-hover'), bar),
      afterNearby: after(q('dub-map-detail'), bar),
      beforeManual: after(bar, q('dub-delay-value')),
      keys: [...bar.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()),
      bys: [...bar.querySelectorAll('[data-testid="dub-seek"]')].map((b) => Number(b.getAttribute('data-by'))),
    };
  });
  check(place.inMap && place.afterLegend && place.afterNearby && place.beforeManual, `控制键在「附近」时间轴和图例的下面、手动对齐那几行的上面：${JSON.stringify({ ...place, keys: undefined, bys: undefined })}`);
  check(
    JSON.stringify(place.bys) === JSON.stringify([-60, -30, -10, -5, 5, 10, 15, 30, 60]) && place.keys.join('|') === '« 60 秒|« 30 秒|« 10 秒|« 5 秒|暂停|5 秒 »|10 秒 »|15 秒 »|30 秒 »|60 秒 »',
    `后退 60 / 30 / 10 / 5 秒，暂停，前进 5 / 10 / 15 / 30 / 60 秒：${place.keys.join(' ')}`,
  );
  // 暂停：视频停下，配音跟着停；按键变成"播放"
  await page.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.currentTime = 20;
    void v.play();
  });
  await waitState((x) => x.playing && x.videoTime > 20.3 && x.videoTime < 30, '控制键之前：放着');
  await playBtn.click();
  s = await waitState((x) => !x.playing && x.videoPlaying === false && x.status.includes('视频暂停'), '点"暂停"后停下');
  check((await vPaused()) && Math.abs(s.dubTime - s.videoTime) < 0.4, `点"暂停"：视频停在 ${s.videoTime.toFixed(2)} 秒，配音跟着停在 ${s.dubTime.toFixed(2)} 秒`);
  for (let i = 0; i < 30 && ((await playBtn.textContent()) ?? '').trim() !== '播放'; i++) await page.waitForTimeout(100);
  check(((await playBtn.textContent()) ?? '').trim() === '播放', '视频停着时这个键写"播放"');
  // 停着的时候前进 30 秒：视频跳过去、仍然停着，配音的位置也对好（一放就是对的）
  let before = await vt();
  await seekBtn(30).click();
  s = await waitState((x) => Math.abs(x.videoTime - (before + 30)) < 0.3 && Math.abs(x.dubTime - x.videoTime) < 0.4 && !x.playing, '停着时前进 30 秒');
  check(await vPaused(), `停着时点"30 秒 »"：视频 ${before.toFixed(2)} → ${s.videoTime.toFixed(2)} 秒，仍然停着；配音也到了 ${s.dubTime.toFixed(2)} 秒`);
  for (let i = 0; i < 30 && !((await panel.getByTestId('dub-transport-at').textContent()) ?? '').startsWith('0:5'); i++) await page.waitForTimeout(100);
  check(((await panel.getByTestId('dub-transport-at').textContent()) ?? '').replace(/\s+/g, ' ').trim() === `0:${Math.round(s.videoTime)} / 2:00`, `按键旁边写着视频位置：${((await panel.getByTestId('dub-transport-at').textContent()) ?? '').trim()}`);
  // 播放：接着放，配音跟上
  await playBtn.click();
  s = await waitState((x) => x.playing && x.videoPlaying === true, '点"播放"后放起来');
  check(!(await vPaused()), '点"播放"：视频接着放，配音跟着放');
  // 放着的时候后退 10 秒
  before = await vt();
  await seekBtn(-10).click();
  s = await waitState((x) => x.playing && x.videoTime < before - 8 && x.videoTime > before - 10.5, '放着时后退 10 秒');
  await page.waitForTimeout(700);
  s = await dubState();
  check(Math.abs(s.dubTime - s.videoTime) < 0.4 && s.playing, `放着时点"« 10 秒"：视频退到 ${s.videoTime.toFixed(2)} 秒接着放，配音跟过去（中文 ${s.dubTime.toFixed(2)}）`);
  // 每一档都按一遍：跳的秒数和按键上写的一样
  await playBtn.click();
  await waitState((x) => x.videoPlaying === false, '停下来逐档按');
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime = 40));
  await waitState((x) => Math.abs(x.videoTime - 40) < 0.2, '停在 0:40');
  /** @type {string[]} */
  const wrong = [];
  for (const by of [5, 10, 15, 30, -5, -10, -30, 60, -60]) {
    const from = await vt();
    await seekBtn(by).click();
    for (let i = 0; i < 30 && Math.abs((await vt()) - (from + by)) > 0.05; i++) await page.waitForTimeout(50);
    if (Math.abs((await vt()) - (from + by)) > 0.05) wrong.push(`${by}: ${from} → ${await vt()}`);
  }
  check(wrong.length === 0 && Math.abs((await vt()) - 55) < 0.1, `九档各按一遍，跳的秒数和按键上写的一样（0:40 → +5 +10 +15 +30 −5 −10 −30 +60 −60 → ${(await vt()).toFixed(1)} 秒）${wrong.join('；')}`);
  // 不早于开头、不晚于结尾
  await seekBtn(60).click();
  await seekBtn(60).click();
  for (let i = 0; i < 30 && (await vt()) < 119.9; i++) await page.waitForTimeout(50);
  const atEnd = await vt();
  await seekBtn(-60).click();
  await seekBtn(-60).click();
  await seekBtn(-60).click();
  for (let i = 0; i < 30 && (await vt()) > 0.05; i++) await page.waitForTimeout(50);
  check(Math.abs(atEnd - DUB_VIDEO.seconds) < 0.1 && (await vt()) === 0, `跳过头时停在结尾（${atEnd.toFixed(1)} 秒）；退过头时停在开头（${await vt()} 秒）`);
  // 有偏移时：跳完之后配音在"视频位置 − 偏移"
  await panel.getByTestId('dub-delay-input').fill('2');
  await panel.getByTestId('dub-delay-input').blur();
  await waitStored((x) => x.delaySec === 2, '偏移 +2');
  await seekBtn(30).click();
  await seekBtn(15).click();
  await playBtn.click();
  s = await waitState((x) => x.playing && x.videoTime > 45.3 && Math.abs(x.videoTime - 2 - x.dubTime) < 0.4, '有偏移时跳完接着放');
  check(s.delaySec === 2, `偏移 +2 秒时前进 45 秒再播放：配音在"视频 − 2"（视频 ${s.videoTime.toFixed(2)} · 中文 ${s.dubTime.toFixed(2)}）`);
  // 快速对齐开着时：跳完之后配音在"视频位置 × 倍速"
  await panel.getByTestId('dub-quick-apply').click();
  await waitStored((x) => x.quickRate === quickWant, '控制键：开快速对齐');
  await waitState((x) => x.quickRate === quickWant && x.playing, '快速对齐放着');
  before = await vt();
  await seekBtn(30).click();
  s = await waitState((x) => x.playing && x.videoTime > before + 29 && Math.abs(x.videoTime * quickWant - x.dubTime) < 0.4, '快速对齐时前进 30 秒');
  check(Math.abs(s.dubTime - s.videoTime) > 5, `快速对齐（${quickLabel}）开着时点"30 秒 »"：配音跟到"视频 × 倍速"（视频 ${s.videoTime.toFixed(2)} · 中文 ${s.dubTime.toFixed(2)}），不是视频时间`);
  await seekBtn(-60).click();
  s = await waitState((x) => x.playing && x.videoTime < before - 20 && Math.abs(x.videoTime * quickWant - x.dubTime) < 0.4, '快速对齐时后退 60 秒');
  check(true, `再点"« 60 秒"：视频 ${s.videoTime.toFixed(2)} · 中文 ${s.dubTime.toFixed(2)}，仍按倍速对着`);
  await panel.getByTestId('dub-quick-off').click();
  await waitStored((x) => x.quickRate === undefined, '控制键：切回手动对齐');
  await panel.getByTestId('dub-delay-input').fill('0');
  await panel.getByTestId('dub-delay-input').blur();
  await waitStored((x) => x.delaySec === 0, '偏移归零');
  await waitState((x) => x.quickRate === undefined && x.delaySec === 0 && x.playing, '回到不偏移');
  // 广告期间不跳（不替你跳过广告）：按键停用；就算消息发到了，页面里的脚本也不跳，并说明原因
  await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.add('ad-showing'));
  await waitState((x) => x.status.includes('广告'), '广告');
  for (let i = 0; i < 30 && !(await seekBtn(30).isDisabled()); i++) await page.waitForTimeout(100);
  before = await vt();
  const adReply = /** @type {any} */ (await panel.evaluate((id) => /** @type {any} */ (globalThis).chrome.tabs.sendMessage(id, { type: 'tubemuse:dub:control', action: 'seek', by: 30 }), await tabOf()));
  check((await seekBtn(30).isDisabled()) && adReply.ok === false && adReply.problem.includes('广告') && (await vt()) - before < 2, `广告期间前进 / 后退的键停用；直接发消息也不跳，并说明：${adReply.problem}`);
  const badReply = /** @type {any} */ (await panel.evaluate((id) => /** @type {any} */ (globalThis).chrome.tabs.sendMessage(id, { type: 'tubemuse:dub:control', action: 'seek', by: 1e9 }), await tabOf()));
  check(badReply.ok === false, `不像样的跳转（一次跳 10 亿秒）不理：${badReply.problem}`);
  await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.remove('ad-showing'));
  await waitState((x) => x.playing, '广告结束');
  check((await page.locator('audio').count()) === 0 && (await page.evaluate(() => document.querySelectorAll('[data-tubemuse]').length)) === 0, '控制键没有往页面里插任何元素');
  await panel.getByTestId('dub-transport').scrollIntoViewIfNeeded();
  await panel.screenshot({ path: join(shots, '71-dub-transport.png'), fullPage: true });

  console.log('\n[中文配音：配音字幕（DECISIONS §86）——给配音选字幕，画面底部显示配音此刻说到的那一句（按配音放到的位置，不按视频时间）；调样式]');
  // 仿真播放页的播放器没有尺寸：按真实播放器的样子给它一个（字幕层按播放器的大小排）
  await page.addStyleTag({ content: '#movie_player{position:relative;width:640px;height:360px;background:#123}' });
  /** 画面上的配音字幕层 */
  const overlay = () =>
    page.evaluate(() => {
      const host = document.querySelector('#movie_player [data-tubemuse="dubsubs"]');
      const wrap = /** @type {HTMLElement | null | undefined} */ (host?.shadowRoot?.querySelector('.wrap'));
      const line = /** @type {HTMLElement | null | undefined} */ (host?.shadowRoot?.querySelector('.line'));
      if (!host || !wrap || !line) return undefined;
      const cs = getComputedStyle(line);
      const player = /** @type {HTMLElement} */ (document.getElementById('movie_player')).getBoundingClientRect();
      const box = line.getBoundingClientRect();
      return {
        hidden: wrap.hidden,
        text: wrap.hidden ? '' : (line.textContent ?? ''),
        font: cs.fontFamily,
        size: parseFloat(cs.fontSize),
        color: cs.color,
        bg: cs.backgroundColor,
        weight: cs.fontWeight,
        shadow: cs.textShadow,
        /** 字幕底边离播放器底边多远 */
        fromBottom: Math.round(player.bottom - box.bottom),
        centered: Math.abs((box.left + box.right) / 2 - (player.left + player.right) / 2) < 2,
        pointer: getComputedStyle(host).pointerEvents,
      };
    });
  /** @returns {Promise<any>} */
  const waitOverlay = async (/** @type {(o: any) => boolean} */ ok, /** @type {string} */ what) => {
    let o;
    for (let i = 0; i < 60; i++) {
      o = await overlay();
      if (ok(o)) return o;
      await page.waitForTimeout(100);
    }
    throw new Error(`等不到配音字幕层：${what}（最后：${JSON.stringify(o)}）`);
  };
  const subsBox = panel.getByTestId('dub-subs');
  await subsBox.waitFor({ timeout: 5000 });
  check(
    (await panel.getByTestId('dub-subs-show').isChecked()) && ((await panel.getByTestId('dub-subs-now').textContent()) ?? '').includes('还没有字幕') && (await overlay()) === undefined,
    '「配音」页有"配音字幕"一节，默认勾着"显示"；这个配音还没有字幕时说明、画面上什么都不加',
  );
  // 字幕文件：每 4 秒一句，中英双语（每句两行）。配音是中文配音：只显示中文那一行
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const srtAt = (/** @type {number} */ sec) => `00:${pad(Math.floor(sec / 60))}:${pad(sec % 60)},000`;
  const srt = Array.from({ length: 23 }, (_, i) => `${i + 1}\n${srtAt(i * 4)} --> ${srtAt(i * 4 + 4)}\n第 ${i} 句中文配音\nEnglish line number ${i}\n`).join('\n');
  await panel.getByTestId('dub-subs-file').setInputFiles({ name: 'not-subs.srt', mimeType: 'application/x-subrip', buffer: Buffer.from('{"not": "subtitles"}') });
  await panel.getByTestId('dub-subs-problem').waitFor({ timeout: 5000 });
  check(((await panel.getByTestId('dub-subs-problem').textContent()) ?? '').includes('not-subs.srt」用不了') && (await storedRec()).subs === undefined, `不是字幕的文件：说明原因，不存（${((await panel.getByTestId('dub-subs-problem').textContent()) ?? '').trim().slice(0, 50)}…）`);
  await panel.getByTestId('dub-subs-file').setInputFiles({ name: '配音.zh-en.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(srt, 'utf8') });
  r = await waitStored((x) => x.subs?.count === 23, '存下字幕');
  const subsDoc = /** @type {any} */ (await panel.evaluate((k) => /** @type {any} */ (globalThis).chrome.storage.local.get(k).then((/** @type {any} */ x) => x[k]), `dubSubs:${DUB_VIDEO.id}`));
  check(
    r.subs.lang === 'zh' && r.subs.reduced === true && r.subs.source === 'file' && r.subs.name === '配音.zh-en.srt' && subsDoc.cues.length === 23 && subsDoc.cues[5].text === '第 5 句中文配音' && subsDoc.cues[5].start === 20,
    `选中英双语的字幕文件：只留中文那几行（字幕的语言跟配音走），字幕按视频单独存一个键：${JSON.stringify(r.subs)}`,
  );
  check(((await panel.getByTestId('dub-subs-note').textContent()) ?? '').includes('23 句，中文') && ((await panel.getByTestId('dub-subs-note').textContent()) ?? '').includes('只显示中文那几行'), `存好后说明：${((await panel.getByTestId('dub-subs-note').textContent()) ?? '').trim()}`);
  // 画面上：配音此刻说到的那一句。先不偏移（中文位置 = 视频位置）
  const cueOf = (/** @type {number} */ t) => `第 ${Math.floor(t / 4)} 句中文配音`;
  /** 读一次字幕层和配音状态；离句子交界不到 0.4 秒时前后两句都算对 */
  const shownMatchesDub = async () => {
    const [o, st] = [/** @type {any} */ (await overlay()), await dubState()];
    const ok = !!o && !o.hidden && [cueOf(st.dubTime - 0.4), cueOf(st.dubTime), cueOf(st.dubTime + 0.4)].includes(o.text);
    return { ok, o, st };
  };
  await page.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.currentTime = 21;
    void v.play();
  });
  await waitState((x) => x.playing && x.videoTime > 21.3 && x.videoTime < 23, '字幕：从 0:21 放');
  let ov = await waitOverlay((o) => !!o && !o.hidden && o.text === '第 5 句中文配音', '显示第 5 句');
  check(ov.centered && ov.pointer === 'none' && ov.fromBottom === 60, `配音放到 0:21：画面底部居中显示"${ov.text}"（控制栏上方：离底边 ${ov.fromBottom} 像素），只显示中文那一行，不挡点击`);
  check(
    (await page.evaluate(() => document.querySelectorAll('[data-tubemuse]').length)) === 1 && (await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('[data-tubemuse="dubsubs"]')).parentElement?.id)) === 'movie_player',
    '字幕层是播放器里的一层（Shadow DOM），别的什么都没加',
  );
  const nowText = async () => ((await panel.getByTestId('dub-subs-now').textContent()) ?? '').trim();
  for (let i = 0; i < 30 && !(await nowText()).includes('句中文配音'); i++) await page.waitForTimeout(100);
  check((await nowText()).startsWith('此刻（中文 0:2') && /第 [56] 句中文配音/.test(await nowText()), `侧边栏也写着此刻这一句：${await nowText()}`);
  // 字幕跟配音走，不是跟视频走：偏移 +10 秒（中文推后），视频 0:50 时配音在 0:40 → 显示的是第 10 句，不是第 12 句
  await panel.getByTestId('dub-delay-input').fill('10');
  await panel.getByTestId('dub-delay-input').blur();
  await waitStored((x) => x.delaySec === 10, '字幕：偏移 +10');
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime = 50.5));
  await waitState((x) => x.playing && x.videoTime > 50.8 && Math.abs(x.videoTime - 10 - x.dubTime) < 0.4, '偏移 +10 后从 0:50 放');
  ov = await waitOverlay((o) => !!o && o.text === '第 10 句中文配音', '偏移后显示第 10 句');
  s = await dubState();
  check(cueOf(s.videoTime) === '第 12 句中文配音', `偏移 +10 秒：视频在 ${s.videoTime.toFixed(1)} 秒（按视频时间会是第 12 句），配音在 ${s.dubTime.toFixed(1)} 秒，画面上是"${ov.text}"——字幕跟配音走`);
  // 中文还没开始时不显示（按偏移，视频 0:10 之前配音没在放）
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime = 3));
  await waitState((x) => x.reason === 'before-start', '中文还没开始');
  ov = await waitOverlay((o) => !!o && o.hidden, '中文没开始时隐藏');
  for (let i = 0; i < 30 && !(await nowText()).includes('不显示'); i++) await page.waitForTimeout(100);
  check(ov.text === '' && (await nowText()).includes('此刻不显示：中文还没开始'), `中文还没开始（视频 0:03，偏移 +10）：画面上不显示字幕；侧边栏说明：${await nowText()}`);
  // 视频暂停：字幕停在配音停下的那一句
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime = 37));
  await waitOverlay((o) => !!o && o.text === '第 6 句中文配音', '0:37 − 10 → 第 6 句');
  await playBtn.click();
  s = await waitState((x) => x.reason === 'paused', '字幕：暂停');
  await page.waitForTimeout(600);
  let m = await shownMatchesDub();
  const pausedAt = m.st.dubTime;
  const pausedText = m.o?.text;
  await page.waitForTimeout(600);
  check(m.ok && (await overlay())?.text === pausedText && Math.abs((await dubState()).dubTime - pausedAt) < 0.05, `视频暂停：字幕留在配音停下的那一句不动（中文 ${pausedAt.toFixed(1)} 秒，"${pausedText}"）`);
  // 用控制键跳：停着时前进 15 秒，字幕换到配音新位置的那一句
  await seekBtn(15).click();
  ov = await waitOverlay((o) => !!o && o.text === cueOf(pausedAt + 15), '停着时前进 15 秒 → 配音新位置的那一句');
  check(ov.text !== pausedText, `停着时点"15 秒 »"：字幕从"${pausedText}"换成"${ov.text}"（配音 ${pausedAt.toFixed(1)} → ${(pausedAt + 15).toFixed(1)} 秒）`);
  await playBtn.click();
  await waitState((x) => x.playing, '字幕：接着放');
  // 快速对齐开着时：配音在"视频 × 倍速"，字幕按那里
  await panel.getByTestId('dub-quick-apply').click();
  await waitStored((x) => x.quickRate === quickWant, '字幕：开快速对齐');
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime = 90.5));
  s = await waitState((x) => x.playing && x.videoTime > 91 && Math.abs(x.videoTime * quickWant - x.dubTime) < 0.4, '快速对齐从 1:30 放');
  await page.waitForTimeout(300);
  m = await shownMatchesDub();
  check(m.ok && cueOf(m.st.videoTime) !== m.o.text, `快速对齐（${quickLabel}）：视频 ${m.st.videoTime.toFixed(1)} 秒时配音在 ${m.st.dubTime.toFixed(1)} 秒，画面上是"${m.o?.text}"（按视频时间会是"${cueOf(m.st.videoTime)}"）`);
  await panel.getByTestId('dub-quick-off').click();
  await waitStored((x) => x.quickRate === undefined, '字幕：切回手动');
  await panel.getByTestId('dub-delay-input').fill('0');
  await panel.getByTestId('dub-delay-input').blur();
  await waitStored((x) => x.delaySec === 0, '字幕：偏移归零');
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime = 20.5));
  await waitOverlay((o) => !!o && o.text === '第 5 句中文配音', '回到 0:20');
  // 广告期间不显示
  await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.add('ad-showing'));
  ov = await waitOverlay((o) => !!o && o.hidden, '广告时隐藏');
  await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('movie_player')).classList.remove('ad-showing'));
  await waitOverlay((o) => !!o && !o.hidden, '广告结束后又显示');
  check(ov.hidden, '广告期间不显示配音字幕，广告结束接着显示');

  // 样式：字体、字号、文字颜色、背景色与不透明度、粗体、描边、抬高
  const base = await waitOverlay((o) => !!o && !o.hidden, '默认样式');
  check(
    Math.abs(base.size - 15.1) < 0.2 && base.color === 'rgb(255, 255, 255)' && base.bg === 'rgba(8, 8, 8, 0.72)' && base.weight === '500' && base.shadow !== 'none' && /Noto Sans SC|YouTube Noto/.test(base.font),
    `默认样式：白字、深色半透明底、黑体、带描边，字号按播放器高度（360 像素 → ${base.size} 像素）`,
  );
  await panel.getByTestId('dub-subs-style').locator('summary').click();
  const setRange = async (/** @type {string} */ id, /** @type {number} */ v) =>
    panel.getByTestId(id).evaluate((el, value) => {
      const i = /** @type {HTMLInputElement} */ (el);
      i.value = String(value);
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }, v);
  const setColor = async (/** @type {string} */ id, /** @type {string} */ v) =>
    panel.getByTestId(id).evaluate((el, value) => {
      const i = /** @type {HTMLInputElement} */ (el);
      i.value = value;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }, v);
  await panel.getByTestId('dub-subs-font').selectOption('kai');
  await setRange('dub-subs-scale', 1.5);
  await setColor('dub-subs-color', '#ffee00');
  await setColor('dub-subs-bg', '#000080');
  await setRange('dub-subs-bg-opacity', 0.5);
  await setRange('dub-subs-raise', 20);
  await panel.getByTestId('dub-subs-bold').check();
  await panel.getByTestId('dub-subs-outline').uncheck();
  const styled = await waitOverlay(
    (o) => !!o && !o.hidden && o.color === 'rgb(255, 238, 0)' && o.bg === 'rgba(0, 0, 128, 0.5)' && o.weight === '700' && o.shadow === 'none' && /Kaiti|KaiTi/.test(o.font) && Math.abs(o.size - base.size * 1.5) < 0.3,
    '改样式后页面上立刻变',
  );
  check(
    Math.abs(styled.fromBottom - base.fromBottom - 72) <= 2,
    `改样式，页面上立刻变：楷体、字号 150%（${styled.size} 像素）、黄字（${styled.color}）、深蓝半透明底（${styled.bg}）、粗体、不描边、抬高 20%（离底边 ${base.fromBottom} → ${styled.fromBottom} 像素）`,
  );
  const preview = await panel.getByTestId('dub-subs-preview').locator('span').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { color: cs.color, bg: cs.backgroundColor, weight: cs.fontWeight, font: cs.fontFamily, text: el.textContent };
  });
  check(preview.color === styled.color && preview.bg === styled.bg && preview.weight === '700' && /Kaiti|KaiTi/.test(preview.font) && /句中文配音/.test(preview.text ?? ''), `侧边栏的预览和页面上同一套样式：${JSON.stringify(preview)}`);
  const savedStyle = /** @type {any} */ (await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('settings'))).settings.dub.subtitles;
  check(
    // 存储不保证键的顺序：排好再比
    JSON.stringify(Object.entries(savedStyle).sort()) === JSON.stringify(Object.entries({ show: true, font: 'kai', scale: 1.5, color: '#ffee00', background: '#000080', backgroundOpacity: 0.5, bold: true, outline: false, raisePct: 20 }).sort()),
    `样式存在设置里（对所有视频生效）：${JSON.stringify(savedStyle)}`,
  );
  await panel.getByTestId('dub-subs').scrollIntoViewIfNeeded();
  await panel.screenshot({ path: join(shots, '72-dub-subtitles-panel.png'), fullPage: true });
  // 不把视频页切到前台：测试里侧边栏是一个标签页，切走之后它跟的就不是这个视频了（截图不需要在前台）
  await page.screenshot({ path: join(shots, '73-dub-subtitles-page.png') });
  await setRange('dub-subs-bg-opacity', 0);
  await waitOverlay((o) => !!o && o.bg === 'rgba(0, 0, 128, 0)', '背景全透明');
  check(((await panel.getByTestId('dub-subs-bg-opacity-value').textContent()) ?? '').trim() === '没有背景', '背景不透明度拉到 0：没有背景');
  await panel.getByTestId('dub-subs-reset').click();
  // 位置变化带 0.2 秒的过渡：等它落回原处再量
  const reset = await waitOverlay(
    (o) => !!o && !o.hidden && o.color === base.color && o.bg === base.bg && o.weight === '500' && Math.abs(o.size - base.size) < 0.2 && Math.abs(o.fromBottom - base.fromBottom) <= 2,
    '恢复默认样式',
  );
  check((await panel.getByTestId('dub-subs-show').isChecked()) && (await panel.getByTestId('dub-subs-reset').isDisabled()), `"恢复默认样式"：样式回到默认（离底边 ${reset.fromBottom} 像素），"显示"的勾不动；已经是默认时这个键停用`);

  // 关掉"显示"：字幕层整个拿掉；再勾上又出现。关掉配音也拿掉
  await panel.getByTestId('dub-subs-show').uncheck();
  for (let i = 0; i < 30 && (await overlay()) !== undefined; i++) await page.waitForTimeout(100);
  check((await overlay()) === undefined && (await page.evaluate(() => document.querySelectorAll('[data-tubemuse]').length)) === 0 && (await nowText()).includes('已关闭'), '去掉"显示"的勾：字幕层从页面上拿掉');
  await options.reload();
  await options.getByTestId('dub-subtitles-setting').waitFor();
  check(!(await options.getByTestId('dub-subtitles-setting').isChecked()), '设置页"中文配音"一节里也有这个开关，和侧边栏是同一个');
  await options.getByTestId('dub-subtitles-setting').click();
  await panel.waitForFunction(() => /** @type {any} */ (globalThis).chrome.storage.local.get('settings').then((/** @type {any} */ x) => x.settings?.dub?.subtitles?.show === true), null, { timeout: 5000 });
  // 设置页被点过之后当前标签页可能变了：切回这个视频（侧边栏跟的是当前标签页）
  await panel.evaluate((id) => /** @type {any} */ (globalThis).chrome.tabs.update(id, { active: true }), await tabOf());
  await waitOverlay((o) => !!o && !o.hidden, '再勾上又出现');
  await panel.getByTestId('dub-toggle').click();
  await waitState((x) => !x.active, '字幕：关配音');
  for (let i = 0; i < 30 && (await overlay()) !== undefined; i++) await page.waitForTimeout(100);
  check((await overlay()) === undefined && (await nowText()).includes('开启配音后显示'), '关闭配音：字幕层也拿掉（它是配音的字幕）');
  await panel.getByTestId('dub-toggle').click();
  await waitState((x) => x.active && x.playing, '字幕：再开配音');
  await waitOverlay((o) => !!o && !o.hidden, '开配音后又显示');

  // 小宇宙里已经生成的字幕：配音多半就是小宇宙上的某一集。只读本机存着的那一份，每句取它自己语言的那一行
  await panel.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const cue = (/** @type {number} */ i, /** @type {any} */ extra) => ({ id: `e2eDubEp:${i * 4000}`, start: i * 4, end: i * 4 + 4, createdAt: 1, ...extra });
    await c.storage.local.set({
      xyzTranscriptIndex: { ...((await c.storage.local.get('xyzTranscriptIndex')).xyzTranscriptIndex ?? {}), e2eDubEp: 2, e2eOtherEp: 3 },
      'xyzTranscript:e2eDubEp': {
        eid: 'e2eDubEp',
        title: 'xyz-tones',
        podcastTitle: '跨国串门儿计划',
        asrModel: 'gpt-transcribe',
        duration: 92,
        done: [[0, 40]],
        updatedAt: 2,
        cues: Array.from({ length: 10 }, (_, i) => cue(i, { raw: `小宇宙转写第${i}句`, lang: 'zh', zh: `小宇宙第 ${i} 句（校对后）`, en: `Xiaoyuzhou line ${i}`, polished: true })),
      },
      'xyzTranscript:e2eOtherEp': { eid: 'e2eOtherEp', title: '别的节目', podcastTitle: '别的播客', asrModel: 'gpt-transcribe', duration: 600, done: [[0, 600]], updatedAt: 3, cues: [cue(0, { raw: 'hello there', lang: 'en' })] },
    });
  });
  await panel.getByTestId('dub-subs-xyz').click();
  await panel.getByTestId('dub-subs-xyz-select').waitFor({ timeout: 5000 });
  // 这一组前面的小宇宙部分也可能留下了字幕（那一集的音频和这个配音一样长，同样标 ★）：只看这里放进去的两集
  const xyzOptions = (await panel.getByTestId('dub-subs-xyz-select').locator('option').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
  const mine = xyzOptions.indexOf('★ xyz-tones · 跨国串门儿计划 · 10 句');
  const other = xyzOptions.findIndex((t) => t.startsWith('别的节目 · 别的播客'));
  /** 第一个不带 ★ 的：它后面不该再有带 ★ 的 */
  const firstPlain = xyzOptions.findIndex((t) => !t.startsWith('★'));
  await panel.getByTestId('dub-subs-xyz-select').selectOption('e2eDubEp');
  let xyzNote = '';
  for (let i = 0; i < 30 && !xyzNote.includes('只生成了 0:40'); i++) {
    xyzNote = ((await panel.getByTestId('dub-subs-xyz-note').textContent()) ?? '').trim();
    await page.waitForTimeout(100);
  }
  check(
    mine >= 0 && firstPlain > mine && other >= firstPlain && xyzOptions.slice(firstPlain).every((t) => !t.startsWith('★')) && xyzNote.includes('看起来就是这个配音') && xyzNote.includes('只生成了 0:40 / 1:32'),
    `"用小宇宙里已生成的字幕"：列出本机存着的那几集，像这个配音的（标题在文件名里、时长一样）排在前面并标 ★，不像的排后面；没生成完的如实说（${xyzOptions.join(' | ')}）`,
  );
  await panel.getByTestId('dub-subs-xyz-use').click();
  r = await waitStored((x) => x.subs?.source === 'xyz', '用小宇宙的字幕');
  check(r.subs.count === 10 && r.subs.name === 'xyz-tones' && r.subs.lang === 'zh', `存成这个配音的字幕：${JSON.stringify(r.subs)}`);
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime = 12.5));
  ov = await waitOverlay((o) => !!o && o.text === '小宇宙第 3 句（校对后）', '小宇宙字幕第 3 句');
  check(true, `画面上换成小宇宙那一集的字幕，每句取中文那一行（音频的语言）："${ov.text}"`);
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime = 60.5));
  ov = await waitOverlay((o) => !!o && o.hidden, '没生成的地方没有字幕');
  for (let i = 0; i < 30 && !(await nowText()).includes('两句之间'); i++) await page.waitForTimeout(100);
  check((await nowText()).includes('两句之间，没有字幕'), `字幕没覆盖到的地方（1:00）不显示，侧边栏照实说：${await nowText()}`);
  // 测试放进去的两集小宇宙字幕用完拿掉，不留给后面的部分
  await panel.evaluate(async () => {
    const c = /** @type {any} */ (globalThis).chrome;
    const { e2eDubEp: _a, e2eOtherEp: _b, ...rest } = (await c.storage.local.get('xyzTranscriptIndex')).xyzTranscriptIndex ?? {};
    await c.storage.local.set({ xyzTranscriptIndex: rest });
    await c.storage.local.remove(['xyzTranscript:e2eDubEp', 'xyzTranscript:e2eOtherEp']);
  });
  // 去掉字幕
  await panel.getByTestId('dub-subs-remove').click();
  await waitStored((x) => x.subs === undefined, '去掉字幕');
  for (let i = 0; i < 30 && (await overlay()) !== undefined; i++) await page.waitForTimeout(100);
  const goneDoc = await panel.evaluate((k) => /** @type {any} */ (globalThis).chrome.storage.local.get(k).then((/** @type {any} */ x) => k in x), `dubSubs:${DUB_VIDEO.id}`);
  check((await overlay()) === undefined && goneDoc === false && (await page.evaluate(() => document.querySelectorAll('[data-tubemuse]').length)) === 0, '"去掉字幕"：说明和字幕本身都从本机删掉，页面上的字幕层拿掉');

  console.log('\n[中文配音：从配音音频识别字幕（DECISIONS §91）——没有字幕文件时，直接从配音的 m4a 里识别出带时间轴的字幕；花费记进"字幕 $"；被打断后接着识别]');
  asrFrom = requests.length;
  const OPENAI_KEY = 'e2e-openai-test-key-not-real';
  await fetch(`${MOCK}/e2e/transcribe-mode?mode=ok`);
  /** 改本机存着的 Key / 每日字幕预算（和在设置页改是同一份存储） */
  const setAsrEnv = (/** @type {{ openaiKey?: string | null, budgetUsd?: number }} */ env) =>
    panel.evaluate(async (env) => {
      const c = /** @type {any} */ (globalThis).chrome;
      const { secrets, settings } = await c.storage.local.get(['secrets', 'settings']);
      if (env.openaiKey !== undefined) await c.storage.local.set({ secrets: { ...(secrets ?? {}), openaiApiKey: env.openaiKey ?? undefined } });
      if (env.budgetUsd !== undefined) await c.storage.local.set({ settings: { ...settings, subtitles: { ...settings.subtitles, dailyBudgetUsd: env.budgetUsd } } });
    }, env);
  const ledgerToday = async () => {
    const days = /** @type {any} */ (await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('subtitleLedger'))).subtitleLedger?.days ?? {};
    const all = /** @type {any[]} */ (Object.values(days));
    return { asrSeconds: all.reduce((n, d) => n + (d.asrSeconds ?? 0), 0), translations: all.reduce((n, d) => n + (d.translations ?? 0), 0), spentUsd: all.reduce((n, d) => n + (d.spentUsd ?? 0), 0), holds: all.reduce((n, d) => n + (d.holds?.length ?? 0), 0) };
  };
  const asrDoc = async () => /** @type {any} */ (await panel.evaluate((k) => /** @type {any} */ (globalThis).chrome.storage.local.get(k).then((/** @type {any} */ x) => x[k]), `dubAsr:${DUB_VIDEO.id}`));
  const asrSubsDoc = async () => /** @type {any} */ (await panel.evaluate((k) => /** @type {any} */ (globalThis).chrome.storage.local.get(k).then((/** @type {any} */ x) => x[k]), `dubSubs:${DUB_VIDEO.id}`));
  await setAsrEnv({ openaiKey: OPENAI_KEY, budgetUsd: 1 });
  const aboutText = ((await panel.getByTestId('dub-subs-about').textContent()) ?? '').replace(/\s+/g, ' ');
  check(
    !aboutText.includes('不在这里转写') && aboutText.includes('从配音音频识别字幕') && aboutText.includes('发往 OpenAI') && aboutText.includes('字幕 $') && (await nowText()).includes('从配音音频识别') && (await panel.getByTestId('dub-subs-asr').isVisible()) && (await panel.getByTestId('dub-subs-pick').isVisible()),
    '没有字幕时："选字幕文件"旁边多了"从配音音频识别字幕…"，说明文字不再说"TubeMuse 不在这里转写"，写明声音发往 OpenAI、花费记在「字幕 $」里；手动选字幕文件的入口照旧',
  );
  const dubSent = () => dubTranscribes.length;
  const sentAtStart = dubSent();

  // 没有 OpenAI Key：点开就说明，开始不了
  await setAsrEnv({ openaiKey: null });
  await panel.getByTestId('dub-subs-asr').click();
  await panel.getByTestId('dub-asr-plan').waitFor({ timeout: 8000 });
  check(((await panel.getByTestId('dub-asr-problem').textContent()) ?? '').includes('需要 OpenAI API Key') && (await panel.getByTestId('dub-asr-start').isDisabled()), '没有 OpenAI Key：点开就说明要先填 Key，"开始识别"点不了');
  await panel.getByTestId('dub-asr-close').click();
  await setAsrEnv({ openaiKey: OPENAI_KEY });

  // 今天的"字幕 $"预算用完了：开始前提示，开始后立刻停下说明，一个请求都不发
  await setAsrEnv({ budgetUsd: 0 });
  await panel.getByTestId('dub-subs-asr').click();
  await panel.getByTestId('dub-asr-over-budget').waitFor({ timeout: 8000 });
  await panel.getByTestId('dub-asr-start').click();
  await panel.getByTestId('dub-asr-error').waitFor({ timeout: 15000 });
  const budgetStop = (await panel.getByTestId('dub-asr-error').textContent()) ?? '';
  check(budgetStop.includes('字幕花费已到上限') && dubSent() === sentAtStart && (await storedRec()).subs === undefined, `和自动字幕、小宇宙字幕共用每日"字幕 $"预算：不够时开始前提示、开始后停下说明，没有发出转写请求（${budgetStop.trim().slice(0, 40)}…）`);
  await panel.getByTestId('dub-asr-error').getByRole('button', { name: '知道了' }).click();
  await setAsrEnv({ budgetUsd: 1 });

  // 点开：先给你看要做什么、发到哪、大约花多少；点"开始识别"才开始
  const ledgerBefore = await ledgerToday();
  await fetch(`${MOCK}/e2e/transcribe-mode?mode=slow&delayMs=1500`);
  await panel.getByTestId('dub-subs-asr').click();
  await panel.getByTestId('dub-asr-estimate').waitFor({ timeout: 8000 });
  const planText = ((await panel.getByTestId('dub-asr-plan').textContent()) ?? '').replace(/\s+/g, ' ');
  check(
    planText.includes('一句一句发往 OpenAI') && planText.includes('gpt-transcribe') && planText.includes('claude-haiku-5-5') && planText.includes('（1:32）') && /预计约 \$0\.00\d+（转写 \$0\.00\d+ \+ 校对 \$0\.00\d+）/.test(planText) && planText.includes('记在「字幕 $」里') && planText.includes('今天还剩') && planText.includes('时间轴来自切句') && dubSent() === sentAtStart,
    `点开先说明：按停顿切句、一句一句发往 OpenAI 转写、大模型校对，预计花费和今天「字幕 $」的余额；这时还没发任何请求（${/预计约[^；]*/.exec(planText)?.[0]}）`,
  );
  await panel.getByTestId('dub-asr-start').click();
  await panel.getByTestId('dub-asr-running').waitFor({ timeout: 8000 });
  check((await panel.getByTestId('dub-subs-pick').isDisabled()) && (await nowText()).includes('正在从配音音频识别'), '识别中：显示进度，这期间不能同时选字幕文件（做完会换掉这个配音的字幕）');
  // 识别到一半点"停止"：在途的几句等它们回来，进度存在本机
  let progressText = '';
  for (let i = 0; i < 150; i++) {
    progressText = ((await panel.getByTestId('dub-asr-progress').textContent()) ?? '').trim();
    if (Number(/· (\d+) 句/.exec(progressText)?.[1] ?? 0) >= 4) break;
    await page.waitForTimeout(100);
  }
  await panel.getByTestId('dub-asr-stop').click();
  await panel.getByTestId('dub-asr-resume').waitFor({ timeout: 20000 });
  const half = await asrDoc();
  const sentAtStop = dubSent() - sentAtStart;
  const resumeText = ((await panel.getByTestId('dub-asr-resume').textContent()) ?? '').replace(/\s+/g, ' ');
  check(
    /已识别到 \d+:\d\d \/ 1:32/.test(progressText) && !!half && half.doneTo > 5 && half.doneTo < 91 && half.cues.length === sentAtStop && sentAtStop >= 4 && sentAtStop < 30 && resumeText.includes('已停止') && resumeText.includes('上次识别到') && (await storedRec()).subs === undefined,
    `识别到一半点"停止"：已经发出去的 ${sentAtStop} 句等它们回来，进度存在本机（识别到 ${half?.doneTo?.toFixed?.(1)} 秒），还没存成字幕；界面给出"接着识别 / 先用已识别的这部分 / 丢掉"（进度：${progressText}）`,
  );
  // 先用已识别的这部分：存成这个配音的字幕（和字幕文件同一个键），画面上按配音放到的位置显示
  await panel.getByTestId('dub-asr-partial').click();
  r = await waitStored((x) => x.subs?.source === 'asr', '先用已识别的部分');
  const partNote = ((await panel.getByTestId('dub-asr-note').textContent()) ?? '').trim();
  check(r.subs.count === sentAtStop && r.subs.lang === 'zh' && partNote.includes('后面没识别的地方没有字幕') && !!(await asrDoc()), `"先用已识别的这部分"：${r.subs.count} 句存成这个配音的字幕，如实说只有前面一段；进度留着，还能接着识别（${partNote.slice(0, 36)}…）`);
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime = 4));
  ov = await waitOverlay((o) => !!o && o.text === '配音第1段说的话', '识别出的字幕第 1 段');
  check(true, `识别出的字幕和选进来的字幕文件走同一套显示：配音放到 0:04 时画面底部是那一段（3.5–5.3 秒）的字幕"${ov.text}"`);
  // 接着识别：只识别剩下的，已经付过钱的不重来
  await panel.getByTestId('dub-asr-resume-open').click();
  await panel.getByTestId('dub-asr-estimate').waitFor({ timeout: 8000 });
  const resumePlan = ((await panel.getByTestId('dub-asr-plan').textContent()) ?? '').replace(/\s+/g, ' ');
  check(resumePlan.includes('接着识别剩下的') && resumePlan.includes('识别完成后会换掉现在这份字幕') && ((await panel.getByTestId('dub-asr-start').textContent()) ?? '').includes('接着识别'), '接着识别：预计花费只算剩下的那一段；已有字幕时说明做完会换掉它、做完之前照常显示');
  await fetch(`${MOCK}/e2e/transcribe-mode?mode=ok`);
  await panel.getByTestId('dub-asr-start').click();
  await panel.getByTestId('dub-asr-done').waitFor({ timeout: 40000 });
  const doneText = ((await panel.getByTestId('dub-asr-done').textContent()) ?? '').trim();
  r = await waitStored((x) => x.subs?.source === 'asr' && x.subs.count === 30, '识别完整');
  const full = await asrSubsDoc();
  const ks = /** @type {any[]} */ (full.cues).map((c) => Number(/第(\d+)段/.exec(c.text)?.[1] ?? -1));
  // 夹具（xyz-tones.m4a）：第 k 段音从 0.5 + 3k 秒响到 2.3 + 3k 秒；切句时句首、句尾各留约 0.2 秒
  const offBy = /** @type {any[]} */ (full.cues).map((c, i) => c.start - (0.5 + i * 3));
  const lens = /** @type {any[]} */ (full.cues).map((c) => c.end - c.start);
  check(ks.length === 30 && ks.every((k, i) => k === i) && /** @type {any[]} */ (full.cues).every((c) => c.text.endsWith('（校）')), `整段 30 句都识别出来了，按顺序、都校对过，存在和字幕文件同一个键（dubSubs:…）里：${doneText.slice(0, 30)}…`);
  check(
    offBy.every((d) => d > -0.4 && d < 0.15) && lens.every((d) => d > 1.8 && d < 2.6),
    `时间轴按配音文件自己的时间、来自切句：每句的开始对得上那段音（句首留白 ${Math.min(...offBy).toFixed(2)}～${Math.max(...offBy).toFixed(2)} 秒），长度也对得上（${Math.min(...lens).toFixed(2)}～${Math.max(...lens).toFixed(2)} 秒；音长 1.8 秒，句首句尾各留约 0.2 秒）`,
  );
  const sentTotal = dubSent() - sentAtStart;
  check(sentTotal === 30 && (await asrDoc()) === undefined, `接着识别时已识别的 ${sentAtStop} 句没有再发一遍（一共发了 ${sentTotal} 次转写）；做完后进度从本机删掉`);
  const asrReqs = requests.slice(asrFrom).filter((x) => x.path === '/openai/v1/audio/transcriptions');
  const proofReqs = requests.slice(asrFrom).filter((x) => x.path.startsWith('/anthropic'));
  check(
    asrReqs.length === 30 && asrReqs.every((x) => x.headers.authorization === `Bearer ${OPENAI_KEY}` && !x.body.includes(DUB_VIDEO.id)) && dubTranscribes.slice(sentAtStart).every((x) => x.prompt.startsWith('xyz-tones') && x.prompt.length <= 300),
    '转写：一句一句的音频发往 OpenAI，Key 只在请求头；提示词是配音文件名和前几句，不带视频 ID',
  );
  check(
    proofReqs.length >= 1 && dubProofs.length === proofReqs.length && proofReqs.every((x) => x.body.includes('xyz-tones') && x.body.includes('配音第') && !x.body.includes(DUB_VIDEO.id) && !x.body.includes('RIFF')),
    `校对：只把转写出的文字、配音文件名和视频标题发给大模型（${proofReqs.length} 次），不发声音、不带视频 ID`,
  );
  const ledgerAfter = await ledgerToday();
  check(
    Math.abs(ledgerAfter.asrSeconds - ledgerBefore.asrSeconds - 60) < 0.01 && ledgerAfter.translations - ledgerBefore.translations === 30 && ledgerAfter.spentUsd > ledgerBefore.spentUsd && ledgerAfter.holds === 0,
    `花费记进"字幕 $"（和自动字幕、小宇宙字幕同一本账）：转写 +${(ledgerAfter.asrSeconds - ledgerBefore.asrSeconds).toFixed(0)} 秒、校对 +${ledgerAfter.translations - ledgerBefore.translations} 句、合计 +$${(ledgerAfter.spentUsd - ledgerBefore.spentUsd).toFixed(4)}，预扣都结清`,
  );
  await page.evaluate(() => (/** @type {HTMLVideoElement} */ (document.querySelector('video')).currentTime = 76));
  ov = await waitOverlay((o) => !!o && o.text === '配音第25段说的话（校）', '识别出的字幕第 25 段');
  const metaText = ((await panel.getByTestId('dub-subs-meta').textContent()) ?? '').trim();
  check(metaText.includes('从这段配音音频识别') && ((await panel.getByTestId('dub-subs-asr').textContent()) ?? '').includes('重新从配音音频识别'), `识别完自动加载显示（配音放到 1:16 时是"${ov.text}"）；侧边栏写明这份字幕是机器识别的：${metaText}`);
  await panel.getByTestId('dub-asr-done').getByRole('button', { name: '知道了' }).click();
  asrTo = requests.length;
  await panel.getByTestId('dub-subs-remove').click();
  await waitStored((x) => x.subs === undefined, '识别检查之后去掉字幕');
  // 留一份字幕到后面："移除"配音时要一并删掉
  await panel.getByTestId('dub-subs-file').setInputFiles({ name: '配音.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(srt, 'utf8') });
  await waitStored((x) => x.subs?.source === 'file', '再存一份字幕');
  await page.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.querySelector('video'));
    v.currentTime = 20;
    void v.play();
  });
  await waitState((x) => x.playing && x.videoTime > 20.3, '字幕之后：照常放着');
  // 片段录制勾着"把字幕画进片段"时：配音字幕也是播放器里当时显示的字幕，一起画进去
  /** 录约 2 秒，取片段中间一帧，数画面底部（字幕处）和上部的亮像素 */
  const recordBurn = async () => {
    await panel.getByRole('tab', { name: '片段', exact: true }).click();
    await panel.getByTestId('clip-start').waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    await panel.getByTestId('clip-start').click();
    await panel.getByTestId('clip-status').filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(2200);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), panel.getByTestId('clip-stop').click()]);
    const b64 = readFileSync(/** @type {string} */ (await dl.path())).toString('base64');
    return page.evaluate(async (data) => {
      const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))]));
      const v = document.createElement('video');
      v.muted = true;
      v.src = url;
      await new Promise((resolve, reject) => {
        v.onloadedmetadata = resolve;
        v.onerror = () => reject(new Error('片段无法播放'));
      });
      v.currentTime = 1;
      await new Promise((r) => (v.onseeked = r));
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
      g.drawImage(v, 0, 0);
      const bright = (/** @type {number} */ y0, /** @type {number} */ y1) => {
        const d = g.getImageData(0, Math.floor(c.height * y0), c.width, Math.floor(c.height * (y1 - y0))).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (/** @type {number} */ (d[i]) + /** @type {number} */ (d[i + 1]) + /** @type {number} */ (d[i + 2]) > 600) n++;
        return n;
      };
      URL.revokeObjectURL(url);
      return { bottom: bright(0.8, 0.95), top: bright(0.05, 0.6) };
    }, b64);
  };
  const setBurn = async (/** @type {boolean} */ on) => {
    await panel.getByRole('tab', { name: '片段', exact: true }).click();
    await panel.getByTestId('clip-burn').waitFor({ timeout: 10000 });
    if ((await panel.getByTestId('clip-burn').isChecked()) !== on) await panel.getByTestId('clip-burn').click();
    await panel.waitForFunction((want) => /** @type {any} */ (globalThis).chrome.storage.local.get('settings').then((/** @type {any} */ x) => (x.settings?.clips?.burnSubtitles ?? false) === want), on, { timeout: 5000 });
    await panel.getByTestId('clip-burn').and(panel.locator(on ? ':checked' : ':not(:checked)')).waitFor({ timeout: 5000 });
  };
  await setBurn(true);
  const burned = await recordBurn();
  await panel.getByRole('tab', { name: '配音', exact: true }).click();
  await panel.getByTestId('dub-subs-show').click();
  await panel.waitForFunction(() => /** @type {any} */ (globalThis).chrome.storage.local.get('settings').then((/** @type {any} */ x) => x.settings?.dub?.subtitles?.show === false), null, { timeout: 5000 });
  for (let i = 0; i < 30 && (await overlay()) !== undefined; i++) await page.waitForTimeout(100);
  const plain = await recordBurn();
  check(
    burned.bottom > 200 && burned.top === 0 && plain.bottom === 0,
    `片段录制勾着"把字幕画进片段"：配音字幕显示着时画进了画面底部（亮像素 ${burned.bottom}），关掉配音字幕再录就没有（${plain.bottom}）`,
  );
  await setBurn(false);
  await panel.getByRole('tab', { name: '配音', exact: true }).click();
  await panel.getByTestId('dub-subs-show').click();
  await panel.waitForFunction(() => /** @type {any} */ (globalThis).chrome.storage.local.get('settings').then((/** @type {any} */ x) => x.settings?.dub?.subtitles?.show === true), null, { timeout: 5000 });
  await waitOverlay((o) => !!o && !o.hidden, '烧录检查之后字幕照常显示');

  console.log('\n[中文配音 × 片段录制：配音开着时录下的是双语混音（原声按 80% + 中文配音）；关着时和以前一样]');
  /** 录一段（约 seconds 秒）并取回下载的文件，在页面里解码量响度 */
  const recordClip = async (/** @type {number} */ seconds) => {
    await panel.getByRole('tab', { name: '片段', exact: true }).click();
    // 上一段录完后状态是"已保存：……"，开始按钮照样在
    await panel.getByTestId('clip-start').waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    const dubNote = (await panel.getByTestId('clip-dub').count()) ? ((await panel.getByTestId('clip-dub').textContent()) ?? '') : '';
    await panel.getByTestId('clip-start').click();
    await panel.getByTestId('clip-status').filter({ hasText: '正在录制' }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
    const mixingNote = (await panel.getByTestId('clip-dub').count()) ? ((await panel.getByTestId('clip-dub').textContent()) ?? '') : '';
    await page.waitForTimeout(seconds * 1000);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), panel.getByTestId('clip-stop').click()]);
    const b64 = readFileSync(/** @type {string} */ (await dl.path())).toString('base64');
    // 原声那个 200 Hz 单音的振幅（Goertzel：只量这一个频率，配音的音高不在这里）和去掉它之后剩下的响度（= 配音）。
    // 按 0.1 秒一段分别量、再取分位数：软件编码吃紧时录音偶尔掉几帧声音（咔哒一下），不让这几下左右结果
    const { tone, rest } = await page.evaluate(
      async ([b64, hz]) => {
        const bytes = Uint8Array.from(atob(/** @type {string} */ (b64)), (c) => c.charCodeAt(0));
        const ac = new AudioContext();
        try {
          const buf = await ac.decodeAudioData(bytes.buffer);
          const ch = buf.getChannelData(0);
          const win = Math.round(buf.sampleRate / 10);
          const w = (2 * Math.PI * /** @type {number} */ (hz)) / buf.sampleRate;
          /** @type {number[]} */ const tones = [];
          /** @type {number[]} */ const rests = [];
          // 去掉开头、结尾各 0.3 秒（编码器的起止过渡）
          for (let a = Math.floor(buf.sampleRate * 0.3); a + win <= ch.length - buf.sampleRate * 0.3; a += win) {
            let re = 0;
            let im = 0;
            let sum = 0;
            for (let i = a; i < a + win; i++) {
              re += ch[i] * Math.cos(w * i);
              im -= ch[i] * Math.sin(w * i);
              sum += ch[i] * ch[i];
            }
            const amp = (2 * Math.sqrt(re * re + im * im)) / win;
            tones.push(amp);
            rests.push(Math.sqrt(Math.max(0, sum / win - (amp * amp) / 2)));
          }
          const at = (/** @type {number[]} */ xs, /** @type {number} */ q) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length * q)] ?? -1;
          // 原声是连续的单音：取中位数。配音（测试音频）每 3 秒里只有 1.8 秒有声，录的这几秒落在周期的哪里不一定——
          // 有声的段数可能只比一半多一点，中位数会落在一段音的边上（2026-11-18 CI 上量到 0.006）。取上四分位：
          // 它总落在有声的那些段里；配音没录进去时各段都接近 0，上四分位也接近 0；偶尔掉几帧（咔哒一下）的那几段到不了四分之一
          return { tone: at(tones, 0.5), rest: at(rests, 0.75) };
        } catch {
          return { tone: -1, rest: -1 };
        } finally {
          void ac.close();
        }
      },
      [b64, DUB_VIDEO.toneHz],
    );
    const log = /** @type {any[]} */ (await panel.evaluate(() => /** @type {any} */ (globalThis).chrome.storage.local.get('clipLog').then((/** @type {any} */ r) => r.clipLog ?? [])));
    const readyText = (await panel.getByTestId('clip-ready').textContent()) ?? '';
    await panel.getByRole('tab', { name: '配音', exact: true }).click();
    return { tone, rest, dubNote, mixingNote, record: log[0], readyText, name: dl.suggestedFilename() };
  };
  const withDub = await recordClip(2.5);
  check(withDub.dubNote.includes('录下的片段是双语混音') && withDub.mixingNote.includes('正在录双语混音'), `片段页写明配音开着、录的是双语混音：${withDub.dubNote}`);
  check(withDub.rest > 0.05, `配音开着时录下的片段里有中文配音（去掉原声后响度 ${withDub.rest.toFixed(3)}）：${withDub.name}`);
  check(withDub.record?.dubbed === true && withDub.readyText.includes('双语混音'), '"最近录过的片段"记下这一段是双语混音');
  // 快速对齐开着时录片段（DECISIONS §82）：录下的同样是双语混音——慢放的中文也录得进去，原声仍按 80%
  await panel.getByTestId('dub-quick-apply').click();
  await waitStored((x) => x.quickRate === quickWant, '录制前开快速对齐');
  await waitState((x) => x.quickRate === quickWant && x.playing, '快速对齐放着');
  const withQuick = await recordClip(2.5);
  check(
    withQuick.rest > 0.05 && Math.abs(withQuick.tone / withDub.tone - 1) < 0.1 && withQuick.record?.dubbed === true,
    `快速对齐开着时录片段：慢放的中文也在录音里（去掉原声后响度 ${withQuick.rest.toFixed(3)}），原声照样按 80%（单音振幅 ${withQuick.tone.toFixed(3)}，不开快速对齐时 ${withDub.tone.toFixed(3)}）`,
  );
  await panel.getByTestId('dub-quick-off').click();
  await waitStored((x) => x.quickRate === undefined, '录完切回手动对齐');
  await waitState((x) => x.quickRate === undefined && x.playing, '切回后照常放');
  await panel.getByTestId('dub-toggle').click();
  await waitState((x) => !x.active && !x.playing, '关闭');
  check(Math.abs((await vol()) - 0.5) < 0.005, `关闭配音：配音停、原声恢复成你的音量（${await vol()}）`);
  const without = await recordClip(2);
  check(without.dubNote === '' && without.rest >= 0 && without.rest < 0.01 && !without.record?.dubbed, `配音关着时录片段和以前一样，只有原声（原声单音振幅 ${without.tone.toFixed(3)}，其余 ${without.rest.toFixed(4)}）`);
  const ratio = withDub.tone / without.tone;
  check(without.tone > 0.1 && Math.abs(ratio - 0.8) < 0.06, `双语混音里原声也在、按 80% 混进去：原声单音振幅 ${withDub.tone.toFixed(3)}（配音开着）÷ ${without.tone.toFixed(3)}（配音关着）= ${ratio.toFixed(2)}`);

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
  const subsAfter = await panel.evaluate((k) => /** @type {any} */ (globalThis).chrome.storage.local.get(k).then((/** @type {any} */ x) => k in x), `dubSubs:${DUB_VIDEO.id}`);
  check(JSON.stringify(after) === '{}' && idbAfter === 0 && subsAfter === false, '移除：对应关系、IndexedDB 里的音频、这个配音的字幕都删掉');
  await waitState((x) => !x.available, '移除后页面里也没有了');
  for (let i = 0; i < 20 && (await badge()) !== ''; i++) await page.waitForTimeout(150);
  check((await badge()) === '', '移除后图标上的"中"消失');

  // 全程只有页面自己取视频：除了你点"从配音音频识别字幕"并确认开始的那一节，TubeMuse 没有为配音发出任何请求
  const own = (/** @type {any} */ r) => r.path === `/watch` || r.path === `/media/${DUB_VIDEO.id}.wav` || r.path === '/favicon.ico' || r.path.startsWith('/youtube/v3/videos');
  const asrSection = requests.slice(asrFrom, asrTo).filter((r) => !own(r) && !r.path.startsWith('/e2e/'));
  check(
    asrSection.length > 0 && asrSection.every((r) => r.path === '/openai/v1/audio/transcriptions' || r.path === '/anthropic/v1/messages'),
    `"从配音音频识别字幕"那一节只发往 OpenAI 转写和你选的大模型${asrSection.length ? `（${[...new Set(asrSection.map((r) => r.path))].join(', ')}）` : ''}`,
  );
  const newReqs = [...requests.slice(reqStart, asrFrom), ...requests.slice(asrTo)].filter((r) => !own(r));
  check(newReqs.length === 0, `除此之外配音没有发出任何网络请求${newReqs.length ? `：${[...new Set(newReqs.map((r) => r.path))].join(', ')}` : ''}`);
  await page.close();
  await panel.bringToFront();
}
