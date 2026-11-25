// B 站（DECISIONS §92）：收藏与标签的写入（加锁读改写），以及"接下来播放"列表里视频的发布时间。
// 发布时间只在你勾选「B站」页的"显示发布时间"后查：先看本机记着的，缺的向 B 站公开接口 x/article/cards 查——
// 只发 BV 号，不带 Cookie、不带 Referer、不跟随跳转；同一时间只有一个请求，两次之间至少隔 BILI.minIntervalMs；
// 被 B 站拦了或网络出错后退避 BILI.backoffMs，这期间不发请求、照实说明。

import { BILI, HTTP_TIMEOUT_MS } from '../config/defaults';
import {
  BiliApiError,
  applyBiliOp,
  mergePubdateCache,
  parseBiliOp,
  parseCardsResponse,
  pubdatesFromCache,
  sanitizeBvids,
  type BiliOp,
  type BiliPubdateReply,
} from '../core/bili';
import type { AppContext } from './context';
import { stores } from './repo';

export type BiliReply = { ok: true } | { ok: false; error: string };

export async function applyBili(ctx: AppContext, op: BiliOp): Promise<BiliReply> {
  let error: string | undefined;
  await stores.bili.update(ctx.kv, ctx.locker, (state) => {
    const r = applyBiliOp(state, op, ctx.now());
    error = r.error;
    return r.state;
  });
  return error ? { ok: false, error } : { ok: true };
}

/** B 站页面里的脚本发来的操作：校验不过的不写入，并说明原因 */
export async function applyBiliFromPage(ctx: AppContext, raw: unknown): Promise<BiliReply> {
  const op = parseBiliOp(raw, ctx.now(), true);
  if (!op) return { ok: false, error: '没有保存：这条内容不完整或链接不是 B 站视频页的（刷新页面后再试）' };
  return applyBili(ctx, op);
}

// ── 发布时间 ──

/** 退避到什么时候、为什么（后台休眠后重来，最多多查一次，不要紧） */
let backoff: { until: number; reason: string } | undefined;
/** 同一时间只有一个请求在路上：后来的排在后面 */
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

/** 单测用：清掉退避与节流状态 */
export function resetBiliPubdateState(): void {
  backoff = undefined;
  queue = Promise.resolve();
  lastRequestAt = 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 一次请求：GET <api>/x/article/cards?ids=BV…,BV… */
async function fetchCards(ctx: AppContext, ids: readonly string[]): Promise<{ times: Record<string, number>; absent: string[] }> {
  const wait = lastRequestAt + BILI.minIntervalMs - ctx.now();
  if (wait > 0) await sleep(Math.min(wait, BILI.minIntervalMs));
  lastRequestAt = ctx.now();
  let res: Response;
  try {
    res = await ctx.http(`${ctx.endpoints.biliApi}/x/article/cards?ids=${ids.join(',')}`, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'manual',
      cache: 'no-cache',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new BiliApiError('连不上 B 站的接口（api.bilibili.com，网络错误）', true);
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new BiliApiError('B 站把这次查询转去了别的页面（通常是验证页），没有拿到发布时间', true);
  if (res.status === 412 || res.status === 429) throw new BiliApiError(`B 站拦下了这次查询（HTTP ${res.status}）：查得太频繁时会这样`, true);
  if (!res.ok) throw new BiliApiError(`B 站接口出错（HTTP ${res.status}）`, res.status >= 500);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // 被风控时 B 站有时回一张"出错啦"网页而不是 JSON：一样退避
    throw new BiliApiError('B 站接口回了一张网页而不是数据（通常是被风控拦下了）', true);
  }
  return parseCardsResponse(json, ids, ctx.now());
}

/**
 * 页面脚本问"这些视频的发布时间"。先看本机记着的；没开"显示发布时间"、退避中时不查，照实说。
 * 查到的（和"接口里没有"的）记进本机。
 */
export async function lookupBiliPubdates(ctx: AppContext, rawIds: unknown): Promise<BiliPubdateReply> {
  const settings = await stores.settings.read(ctx.kv);
  if (!settings.bili.enabled || !settings.bili.showPubdate) return { ok: false, times: {}, error: '"显示发布时间"没有勾选', off: true };
  const ids = sanitizeBvids(rawIds);
  const cache = await stores.biliPubdates.read(ctx.kv);
  const { known, absent, missing } = pubdatesFromCache(cache, ids, ctx.now());
  if (!missing.length) return { ok: true, times: known, absent };
  if (backoff && backoff.until > ctx.now()) {
    const min = Math.max(1, Math.ceil((backoff.until - ctx.now()) / 60_000));
    return { ok: false, times: known, absent, error: `${backoff.reason}。${min} 分钟后再查` };
  }
  const run = queue.then(async (): Promise<BiliPubdateReply> => {
    const times: Record<string, number> = { ...known };
    const gone: string[] = [...absent];
    // 排队时别的标签页可能已经查过了：再看一眼本机
    const fresh = pubdatesFromCache(await stores.biliPubdates.read(ctx.kv), missing, ctx.now());
    Object.assign(times, fresh.known);
    gone.push(...fresh.absent);
    try {
      for (let i = 0; i < fresh.missing.length; i += BILI.cardsBatch) {
        if (backoff && backoff.until > ctx.now()) throw new BiliApiError(backoff.reason, true);
        const batch = fresh.missing.slice(i, i + BILI.cardsBatch);
        const got = await fetchCards(ctx, batch);
        Object.assign(times, got.times);
        gone.push(...got.absent);
        await stores.biliPubdates.update(ctx.kv, ctx.locker, (c) => mergePubdateCache(c, got.times, got.absent, ctx.now()));
      }
      return { ok: true, times, absent: gone };
    } catch (e) {
      const err = e instanceof BiliApiError ? e : new BiliApiError('查发布时间时出了意外错误', true);
      if (err.blocked && !(backoff && backoff.until > ctx.now())) backoff = { until: ctx.now() + BILI.backoffMs, reason: err.message };
      return { ok: false, times, absent: gone, error: err.blocked ? `${err.message}。${Math.round(BILI.backoffMs / 60_000)} 分钟后再查` : err.message };
    }
  });
  queue = run.catch(() => undefined);
  return run;
}
