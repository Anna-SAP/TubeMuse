// @ts-check
// 正式构建（dist/）冒烟测试：manifest / CSP 能被 Chromium 接受，侧边栏与设置页能渲染，
// 打开页面时不发出任何网络请求（所有外部请求都被拦截并记为失败）。
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const extDir = join(root, 'dist');
let failures = 0;
/** @param {boolean} cond @param {string} msg */
function check(cond, msg) {
  console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`);
  if (!cond) failures++;
}

const userDataDir = mkdtempSync(join(tmpdir(), 'tubemuse-smoke-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--disable-background-networking', '--disable-component-update', '--no-first-run'],
});
/** @type {string[]} */
const external = [];
await context.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith('chrome-extension://')) return route.continue();
  external.push(url);
  return route.abort();
});
/** @type {string[]} */
const errors = [];
try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  check(/^[a-p]{32}$/.test(extId), `正式版加载成功，扩展 ID：${extId}`);
  const manifest = await sw.evaluate(() => /** @type {any} */ (globalThis).chrome.runtime.getManifest());
  check(!!manifest.content_security_policy, 'CSP 已生效');
  const matches = (manifest.content_scripts ?? []).flatMap((/** @type {any} */ c) => c.matches);
  check(JSON.stringify(matches) === JSON.stringify(['https://www.youtube.com/*']), `观看追踪脚本只注入 www.youtube.com（${matches.join(', ')}）`);
  check(manifest.permissions.includes('alarms') && !manifest.permissions.includes('tabs') && !manifest.permissions.includes('scripting'), `权限最小化：${manifest.permissions.join(', ')}`);
  // 授权走 launchWebAuthFlow：不再需要 manifest 的 oauth2（那是 getAuthToken 专用，依赖浏览器级 Google 登录）
  check(!manifest.oauth2 && manifest.permissions.includes('identity'), 'manifest 不含 oauth2，授权走 launchWebAuthFlow');
  const connect = /connect-src ([^;]+)/.exec(manifest.content_security_policy.extension_pages)?.[1]?.trim().split(/\s+/) ?? [];
  const expected = ['https://www.googleapis.com', 'https://oauth2.googleapis.com', 'https://api.anthropic.com', 'https://api.openai.com', 'https://api.x.com', 'https://www.douban.com'];
  check(JSON.stringify([...connect].sort()) === JSON.stringify([...expected].sort()), `网络出口白名单只有官方 API 与豆瓣 RSS：${connect.join(' ')}`);
  check(JSON.stringify([...manifest.host_permissions].sort()) === JSON.stringify(expected.map((o) => `${o}/*`).sort()), 'host_permissions 与 connect-src 一致');
  const img = /img-src ([^;]+)/.exec(manifest.content_security_policy.extension_pages)?.[1]?.trim().split(/\s+/) ?? [];
  const doubanImg = img.filter((o) => o.endsWith('.doubanio.com'));
  check(doubanImg.length === 9 && doubanImg.every((o) => /^https:\/\/img[1-9]\.doubanio\.com$/.test(o)), `豆瓣图片域名只出现在 img-src：${doubanImg.length} 个`);
  for (const page of ['sidepanel.html', 'options.html', 'mic-permission.html']) {
    const p = await context.newPage();
    p.on('console', (m) => m.type() === 'error' && errors.push(`${page}: ${m.text()}`));
    p.on('pageerror', (e) => errors.push(`${page}: ${e.message}`));
    await p.goto(`chrome-extension://${extId}/${page}`);
    await p.waitForTimeout(800);
    const text = (await p.locator('body').textContent()) ?? '';
    check(text.trim().length > 20, `${page} 正常渲染`);
    if (page === 'sidepanel.html') check(text.includes('配置 Google OAuth 客户端') || text.includes('连接 YouTube'), '未配置时侧边栏提示下一步该做什么');
    await p.close();
  }
} catch (e) {
  failures++;
  console.error('✘ 冒烟测试异常：', e);
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}
check(external.length === 0, `打开页面时没有任何网络请求${external.length ? `：${external.join(', ')}` : ''}`);
check(errors.length === 0, `没有控制台错误${errors.length ? `：\n    ${errors.join('\n    ')}` : ''}`);
console.log(failures ? `\n✘ 正式版冒烟测试失败 ${failures} 项` : '\n✔ 正式版冒烟测试通过');
process.exit(failures ? 1 : 0);
