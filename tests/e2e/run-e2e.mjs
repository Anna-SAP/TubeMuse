// @ts-check
// 在 Playwright 自带的 Chromium 里加载 dist-e2e/，用本机 mock 服务把各功能真的跑一遍。
//
//   node tests/e2e/run-e2e.mjs                按顺序跑完所有组（本地 npm run e2e）
//   node tests/e2e/run-e2e.mjs --shard=clips  只跑一组（CI 每组一个 job，并行）
//
// 分组见 shards.json：每一组用一个全新的浏览器和 mock 服务，开头都走一遍"设置"（harness.mjs 的 setup：
// 填 Key、连接 YouTube），再依次跑这一组的各部分（parts/），结尾查这一组的网络红线。
// 新加的检查写进 parts/ 里对应的文件；新加一组要同时改 shards.json 和 ci.yml 的 matrix（tests/unit/ci-shards.test.ts 守着）。
// 为什么分组、怎么分的见 DECISIONS §61。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, failureCount, launch, redLines, setup, shots } from './harness.mjs';
import { clips } from './parts/clips.mjs';
import { core } from './parts/core.mjs';
import { dub } from './parts/dub.mjs';
import { emails } from './parts/emails.mjs';
import { muse } from './parts/muse.mjs';
import { settings } from './parts/settings.mjs';
import { subtitles } from './parts/subtitles.mjs';
import { xyz } from './parts/xyz.mjs';

/** @type {Record<string, (t: import('./harness.mjs').Harness) => Promise<void>>} */
const PARTS = { core, subtitles, clips, emails, muse, settings, xyz, dub };
/** @type {Record<string, string[]>} */
const SHARDS = JSON.parse(readFileSync(new URL('./shards.json', import.meta.url), 'utf8'));

const shard = process.argv.find((a) => a.startsWith('--shard='))?.slice('--shard='.length);
const startedAt = Date.now();
const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)} 秒`;

if (shard === undefined) {
  // 一组一个子进程：各组互不影响，和 CI 上每组一个 job 是同一条路径
  rmSync(shots, { recursive: true, force: true });
  const names = Object.keys(SHARDS);
  /** @type {string[]} */
  const failed = [];
  for (const [i, name] of names.entries()) {
    console.log(`\n════ e2e 第 ${i + 1}/${names.length} 组：${name}（${SHARDS[name]?.join(' → ')}）════`);
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--shard=${name}`, '--keep-shots'], { stdio: 'inherit' });
    if (r.status !== 0) failed.push(name);
  }
  console.log(failed.length ? `\n✘ e2e 没通过的组：${failed.join('、')}（共 ${names.length} 组，${elapsed()}；截图在 test-results/e2e/）` : `\n✔ e2e 全部通过（${names.length} 组，${elapsed()}；截图在 test-results/e2e/）`);
  process.exit(failed.length ? 1 : 0);
}

const partNames = SHARDS[shard];
if (!partNames || !partNames.every((p) => p in PARTS)) {
  console.error(`✘ 没有叫"${shard}"的组，或者它列了 parts/ 里没有的部分。可选的组：${Object.keys(SHARDS).join('、')}`);
  process.exit(2);
}
// 单独跑一组时清掉上一次的截图；跑全部时由上面清一次，各组的截图留在一起
if (!process.argv.includes('--keep-shots')) rmSync(shots, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });

const base = await launch();
try {
  const t = await setup(base);
  for (const name of partNames) await /** @type {(t: import('./harness.mjs').Harness) => Promise<void>} */ (PARTS[name])(t);
  redLines(t, new Set(partNames));
} catch (e) {
  fail();
  console.error('\n✘ e2e 异常：', e);
  for (const p of base.context.pages()) await p.screenshot({ path: join(shots, `error-${shard}-${Date.now()}.png`), fullPage: true }).catch(() => undefined);
} finally {
  await base.context.close();
  base.server.close();
  rmSync(base.userDataDir, { recursive: true, force: true });
}

const failures = failureCount();
console.log(failures ? `\n✘ e2e「${shard}」失败 ${failures} 项（${elapsed()}；截图在 test-results/e2e/）` : `\n✔ e2e「${shard}」全部通过（${elapsed()}；截图在 test-results/e2e/）`);
process.exit(failures ? 1 : 0);
