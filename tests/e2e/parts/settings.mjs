// @ts-check
// 设置页每一项都存得上，然后重启浏览器。重启后这一组的页面全部关掉了：这一部分必须排在一组的最后。
// 它前面还要有别的部分：这里比较的是"点之前存储里的设置"，全新的浏览器里设置还没写进过存储，
// 第一个勾选框会报"复原不了"（tests/unit/ci-shards.test.ts 守着这两条）。
import { check } from '../harness.mjs';

/** @param {import('../harness.mjs').Harness} t */
export async function settings(t) {
  const { extId, options, requests, consoleErrors, readAuth, tokenGrants } = t;
  let { context } = t;

  // ───────────────────────── 设置页 ─────────────────────────
  // 回归：事件处理函数在异步回调里才读 e.currentTarget 时，设置存不上、也不报错（DECISIONS §45）。遍历所有勾选框，新加的开关也覆盖到
  console.log('\n[设置页：每一项改了都真的存进去，改回来能复原]');
  // 设置页要在前台：Playwright 点击前要等两帧确认元素不动，而后台标签页一秒才出一帧，
  // 每点一下约 2 秒，28 个勾选框各点两下就是将近 2 分钟（DECISIONS §60）。你自己改设置时这一页也在前台。
  await options.bringToFront();
  /** @param {unknown} v @returns {unknown} */
  const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(/** @type {Record<string, unknown>} */ (v)[k])])) : v);
  const storedSettings = async () => sortKeys(await options.evaluate(async () => (await /** @type {any} */ (globalThis).chrome.storage.local.get('settings')).settings));
  const settingsJson = async () => JSON.stringify(await storedSettings());
  /**
   * 等到 ok 成立（后台标签页里 requestAnimationFrame 不走，不能用 waitForFunction）
   * @param {() => Promise<boolean>} ok
   */
  const settled = async (ok) => {
    for (let i = 0; i < 60; i++) {
      if (await ok()) return true;
      await options.waitForTimeout(50);
    }
    return false;
  };
  const boxes = options.locator('input[type="checkbox"]');
  // 前面的自动字幕一节切到了 OpenAI 转写，"优先本机识别"那一项是藏着的：切回浏览器识别，让所有勾选框都在
  const asrEngine = options.locator('input[type="radio"][name="asr-engine"]');
  await asrEngine.first().check();
  await settled(async () => (await boxes.count()) >= 28);
  const boxCount = await boxes.count();
  /** @type {string[]} */
  const badBoxes = [];
  for (let i = 0; i < boxCount; i++) {
    const before = await settingsJson();
    await boxes.nth(i).click();
    const saved = await settled(async () => (await settingsJson()) !== before);
    await boxes.nth(i).click();
    const restored = await settled(async () => (await settingsJson()) === before);
    if (!saved || !restored) badBoxes.push(`#${i}${saved ? '' : ' 存不上'}${restored ? '' : ' 复原不了'} ${await boxes.nth(i).evaluate((el) => el.closest('label')?.textContent?.trim().slice(0, 30) ?? '')}`);
  }
  check(boxCount >= 28 && badBoxes.length === 0, `${boxCount} 个勾选框都存得上、都能复原${badBoxes.length ? `，有问题：${badBoxes.join('；')}` : ''}`);
  await asrEngine.nth(1).check();
  const voiceLang = options.getByTestId('voice-lang');
  await voiceLang.selectOption('en-US');
  const voiceSaved = await settled(async () => /** @type {any} */ (await storedSettings()).voice.lang === 'en-US');
  await voiceLang.selectOption('zh-CN');
  check(voiceSaved && (await settled(async () => /** @type {any} */ (await storedSettings()).voice.lang === 'zh-CN')), '语音默认语言存得上');
  for (const provider of ['anthropic', 'openai']) {
    const input = options.getByTestId(`model-${provider}`);
    const original = await input.inputValue();
    // 输入框的值跟着存储走：刚存完时界面还要重绘一次，这时候输入会被盖掉（实测不等时 25 轮只过 12–18 轮，等 200 毫秒 25 轮全过；人的手速碰不到）
    await options.waitForTimeout(200);
    await input.fill('e2e-test-model');
    await input.blur();
    const modelSaved = await settled(async () => /** @type {any} */ (await storedSettings()).llm.models[provider] === 'e2e-test-model');
    await options.waitForTimeout(200);
    await input.fill('');
    await input.blur();
    check(modelSaved && (await settled(async () => /** @type {any} */ (await storedSettings()).llm.models[provider] === original)), `${provider} 模型名存得上，清空后回到默认模型`);
  }

  // ── 关掉浏览器再打开（同一个用户目录）：service worker 与所有页面重启、内存清空，授权状态仍在，过期后照样自动续期 ──
  // 想测的是"在扩展管理页重新加载扩展"，但 Playwright 的 Chromium 对命令行加载的扩展执行 chrome.runtime.reload() 后
  // 不会再启用它（页面报 ERR_BLOCKED_BY_CLIENT），只能测更彻底的整个浏览器重启；两者存储都由 Chrome 保留（DECISIONS §53）。
  console.log('\n[重启浏览器]');
  {
    const before = await readAuth();
    await context.close();
    context = t.context = await t.launchBrowser();
    await context.route('**/*', t.guard);
    let [sw2] = context.serviceWorkers();
    sw2 ??= await context.waitForEvent('serviceworker', { timeout: 20000 });
    check(new URL(sw2.url()).host === extId, '重启后扩展 ID 不变');
    const after = await readAuth(sw2);
    check(!!after?.refreshToken && after.refreshToken === before?.refreshToken && after.connectedAt === before?.connectedAt, '重启后，存储里的授权（含刷新令牌）原样还在');
    // 计数要在让令牌过期之前记下：浏览器一启动，后台的例行任务（onStartup）就可能先用到 YouTube、先续上
    const authorizeN = requests.filter((r) => r.path === '/oauth/authorize').length;
    const refreshN = tokenGrants('refresh_token').length;
    // 模拟又过了几个小时：访问令牌已过期
    await sw2.evaluate((st) => /** @type {any} */ (globalThis).chrome.storage.local.set({ youtubeAuth: st }), { ...after, expiresAt: Date.now() - 3 * 3_600_000 });
    const opts2 = await context.newPage();
    opts2.on('pageerror', (e) => consoleErrors.push(`options(restart) pageerror: ${e.message}`));
    await opts2.goto(`chrome-extension://${extId}/options.html`);
    await opts2.getByTestId('auth-status').filter({ hasText: '自动续期已开启' }).waitFor({ timeout: 10000 });
    check(true, '重启后设置页显示"已连接，自动续期已开启"（访问令牌过期也算：有刷新令牌）');
    const panel2 = await context.newPage();
    panel2.on('pageerror', (e) => consoleErrors.push(`sidepanel(restart) pageerror: ${e.message}`));
    await panel2.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel2.getByRole('tab', { name: '画像' }).click();
    await panel2.getByRole('button', { name: '同步订阅与喜欢的视频' }).click();
    await panel2.getByText(/同步完成/).waitFor({ timeout: 15000 });
    const renewedAfterRestart = await readAuth(sw2);
    const refreshed2 = tokenGrants('refresh_token').length - refreshN;
    const authorized2 = requests.filter((r) => r.path === '/oauth/authorize').length - authorizeN;
    const banner2 = await panel2.getByText('YouTube 授权已过期').count();
    check(
      refreshed2 > 0 && authorized2 === 0 && renewedAfterRestart?.expiresAt > Date.now() + 30 * 60_000 && !renewedAfterRestart?.renewFailedAt && banner2 === 0,
      `重启后用 YouTube：后台自动续期，不弹授权窗口，没有"已过期"横幅（续期 ${refreshed2} 次、授权窗口 ${authorized2} 次、横幅 ${banner2}）`,
    );
  }
}
