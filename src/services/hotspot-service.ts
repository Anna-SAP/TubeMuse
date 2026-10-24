// X 热点：选主题 → 预算护栏 → recent search → 挑候选 → LLM 归纳（带原文链接与找片口令）→ 缓存 6 小时。
// 超预算立即停调：每次请求前按最坏情况估算，不够就停，已拿到的帖子照常归纳并注明"没查完"。

import { X_API } from '../config/defaults';
import { assembleHotspots, chooseTopics, isRawHotspots, selectCandidates, toPromptPosts } from '../core/hotspots';
import { buildHotspotPrompt, HOTSPOT_SCHEMA } from '../core/prompts';
import { toRfc3339 } from '../core/time';
import type { HotspotState, XPost } from '../core/types';
import { clearXBlocked, markXBlocked, planPostRead, recordPostRead, xSnapshot, type XSnapshot } from '../core/x-budget';
import type { AppContext } from './context';
import { AppError } from './errors';
import { getLlm } from './llm-factory';
import { newId, stores } from './repo';
import { createXClient } from './x-client';

export async function xSpend(ctx: AppContext): Promise<XSnapshot> {
  const [ledger, settings] = await Promise.all([stores.xLedger.read(ctx.kv), stores.settings.read(ctx.kv)]);
  return xSnapshot(ledger, settings.x.dailyBudgetUsd, settings.quota.warnRatio, ctx.now());
}

export function hotspotsFresh(state: HotspotState | null, cacheHours: number, now: number): boolean {
  return !!state && now - state.fetchedAt < cacheHours * 3_600_000;
}

export interface RefreshOptions {
  /** 忽略 6 小时缓存（手动刷新） */
  force?: boolean;
  /** 你在 X 后台充值或调高上限后，手动解除当天的停止状态 */
  retryAfterBlock?: boolean;
}

/**
 * 同一时间只允许一次刷新：打开"发现"页的自动刷新与手动刷新可能撞在一起，
 * 各自通过预算检查后都去读 X，会让当天花费超出预算。排队期间另一路刚刷新完，直接用它的结果。
 */
export async function refreshHotspots(ctx: AppContext, opts: RefreshOptions = {}): Promise<{ state: HotspotState; cached: boolean }> {
  const requestedAt = ctx.now();
  return ctx.locker.withLock('run:hotspots', () => refreshHotspotsLocked(ctx, opts, requestedAt));
}

async function refreshHotspotsLocked(ctx: AppContext, opts: RefreshOptions, requestedAt: number): Promise<{ state: HotspotState; cached: boolean }> {
  const [settings, secrets, cached, clusterState, sessions] = await Promise.all([
    stores.settings.read(ctx.kv),
    stores.secrets.read(ctx.kv),
    stores.hotspots.read(ctx.kv),
    stores.clusters.read(ctx.kv),
    stores.searchSessions.read(ctx.kv),
  ]);
  if (!settings.x.enabled) throw new AppError('input', 'X 热点已在设置中关闭');
  if (!opts.force && cached && hotspotsFresh(cached, settings.x.cacheHours, ctx.now())) return { state: cached, cached: true };
  if (cached && cached.fetchedAt > requestedAt) return { state: cached, cached: true };
  const token = secrets.xBearerToken;
  if (!token) throw new AppError('x_key', '还没有填写 X Bearer Token', '在设置页「X 热点」里填写；Token 只保存在本机');

  if (opts.retryAfterBlock) await stores.xLedger.update(ctx.kv, ctx.locker, (l) => clearXBlocked(l, ctx.now()));
  const recentTopics = sessions.slice(0, 5).map((s) => ({ topic: s.intent.topic || s.utterance.slice(0, 12), terms: s.intent.constraints.filter((c) => c.kind === 'topic').flatMap((c) => c.params.terms ?? []) }));
  const topics = chooseTopics(clusterState.clusters, recentTopics, settings.x.maxTopics);
  if (!topics.length) throw new AppError('input', '还没有兴趣信息可以用来找热点', '先在"画像"页生成兴趣簇，或用"找片"搜几次');

  const x = createXClient({ http: ctx.http, baseUrl: ctx.endpoints.x, token });
  const startTime = toRfc3339(ctx.now() - X_API.lookbackHours * 3_600_000);
  const posts: XPost[] = [];
  const notes: string[] = [];
  let spent = 0;
  let partial = false;
  for (const [i, t] of topics.entries()) {
    const snap = await xSpend(ctx);
    const plan = planPostRead(snap, settings.x.postsPerTopic);
    if (!plan.ok) {
      partial = true;
      notes.push(`${plan.reason}；还有 ${topics.length - i} 个主题没查（${topics.slice(i).map((x) => x.topic).join('、')}）`);
      break;
    }
    try {
      const got = await x.searchRecent(t.query, plan.maxResults, startTime, t.topic);
      let cost = 0;
      await stores.xLedger.update(ctx.kv, ctx.locker, (l) => {
        const r = recordPostRead(l, got.map((p) => p.id), 'tweets/search/recent', ctx.now());
        cost = r.costUsd;
        return r.ledger;
      });
      spent += cost;
      posts.push(...got);
      if (!got.length) notes.push(`「${t.topic}」最近 ${X_API.lookbackHours} 小时没有检索到帖子`);
    } catch (e) {
      if (e instanceof AppError && e.kind === 'x_budget') {
        await stores.xLedger.update(ctx.kv, ctx.locker, (l) => markXBlocked(l, e.message, ctx.now()));
        partial = true;
        notes.push(`${e.message}，已停止调用`);
        break;
      }
      throw e;
    }
  }
  let items: HotspotState['items'] = [];
  if (posts.length) {
    const cands = selectCandidates(posts, X_API.candidatesPerTopic, ctx.now());
    const { posts: promptPosts, refs } = toPromptPosts(cands, ctx.now());
    const llm = await getLlm(ctx);
    const prompt = buildHotspotPrompt(promptPosts, settings.x.minItems, settings.x.maxItems);
    const raw = await llm.generateJson({ ...prompt, schema: HOTSPOT_SCHEMA, schemaName: 'tubemuse_hotspots', effort: 'low' });
    if (!isRawHotspots(raw)) throw new AppError('llm', 'LLM 返回的热点格式不对', '请重试（X 的帖子已经读过，今天再读不会重复计费）');
    const assembled = assembleHotspots(raw, refs, settings.x.maxItems, () => newId('h'));
    items = assembled.items;
    if (assembled.dropped) notes.push(`${assembled.dropped} 条热点没有可核实的原文或口令，已丢弃`);
    if (items.length < settings.x.minItems) notes.push(`只整理出 ${items.length} 条值得看的热点（少于 ${settings.x.minItems} 条）`);
  } else if (!partial) {
    notes.push('没有检索到帖子');
  }
  const state: HotspotState = {
    fetchedAt: ctx.now(),
    items,
    topics: topics.map((t) => t.topic),
    spentUsd: Math.round(spent * 10_000) / 10_000,
    postsRead: posts.length,
    partial,
    notes,
  };
  await stores.hotspots.write(ctx.kv, state);
  return { state, cached: false };
}
