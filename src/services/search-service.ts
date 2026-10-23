// 找片编排：计划 → 缓存 → 配额检查 → search/videos/channels → 过滤（不足时预算内翻页）→ 排序 → 会话。

import { STORAGE_LIMITS } from '../config/defaults';
import { lookup, planCacheKey, store } from '../core/cache';
import { planSearch, type PlannerContext } from '../core/planner';
import { applyFilters } from '../core/postfilter';
import { checkPlanAffordable, OperationBudget, snapshot } from '../core/quota';
import { rankCandidates, type RankContext } from '../core/ranking';
import { formatClock } from '../core/time';
import type {
  ClusterState,
  Intent,
  Profile,
  RankedItem,
  RankingModel,
  RatingRecord,
  SearchPlan,
  SearchSession,
  VideoCandidate,
} from '../core/types';
import type { AppContext } from './context';
import { AppError } from './errors';
import { makeCharger, makeExhaustedMarker } from './quota-service';
import { newId, stores, type Settings } from './repo';
import { watchedChannelCounts } from './watch-service';
import { createYouTube, type YouTubeClient } from './youtube';

export function plannerContext(settings: Settings, profile: Profile, now: number): PlannerContext {
  const ctx: PlannerContext = {
    now,
    subscriptions: profile.subscriptions.map((s) => ({ id: s.id, title: s.title })),
    profileSynced: !!profile.syncedAt,
    searchCallsPerQuery: settings.quota.searchCallsPerQuery,
    generalUnitsPerQuery: settings.quota.generalUnitsPerQuery,
    defaultResults: settings.search.defaultResults,
    expandedResults: settings.search.expandedResults,
  };
  if (settings.search.regionCode) ctx.regionCode = settings.search.regionCode;
  return ctx;
}

/** 不发请求，只算出计划（回显在搜索开始前就能展示每个约束的落实方式） */
export async function previewPlan(ctx: AppContext, intent: Intent): Promise<SearchPlan> {
  const [settings, profile] = await Promise.all([stores.settings.read(ctx.kv), stores.profile.read(ctx.kv)]);
  return planSearch(intent, plannerContext(settings, profile, ctx.now()));
}

/** 只保留前 n 条检索词（用户确认缩减后使用） */
export function reducePlan(plan: SearchPlan, n: number): SearchPlan {
  const queries = plan.queries.slice(0, Math.max(1, n));
  return {
    ...plan,
    queries,
    estimatedCost: { searchCalls: queries.length, generalUnits: queries.length * 2 },
    maxExtraPages: 0,
    notes: [...plan.notes, `今日配额不足，按你的确认只用了 ${queries.length} 条检索词`],
  };
}

export interface RankingData {
  /** 看过的频道计数（观看记录 + Takeout） */
  watched: Map<string, number>;
  profile: Profile;
  clusters: ClusterState;
  model: RankingModel;
  ratings: Record<string, RatingRecord>;
}

export async function loadRankingData(ctx: AppContext): Promise<RankingData> {
  const [profile, clusters, model, ratings, watched] = await Promise.all([
    stores.profile.read(ctx.kv),
    stores.clusters.read(ctx.kv),
    stores.rankingModel.read(ctx.kv),
    stores.ratings.read(ctx.kv),
    watchedChannelCounts(ctx),
  ]);
  return { profile, clusters, model, ratings, watched };
}

export function rankContext(now: number, plan: SearchPlan, data: RankingData): RankContext {
  const liked = new Map<string, number>();
  for (const v of data.profile.likedVideos) liked.set(v.channelId, (liked.get(v.channelId) ?? 0) + 1);
  return {
    now,
    plan,
    model: data.model,
    clusters: data.clusters.clusters,
    subscriptionIds: new Set(data.profile.subscriptions.map((s) => s.id)),
    likedChannelCounts: liked,
    watchedChannelCounts: data.watched,
    ratings: data.ratings,
    hasProfile: !!data.profile.syncedAt || data.clusters.clusters.length > 0 || data.watched.size > 0,
  };
}

/**
 * 用当前排序模型给会话里的候选重新过滤、排序（不消耗配额）。
 * 以搜索发生的时刻为基准：隔几天再打开，也不会因为"两天内"之类的时间窗把当时的结果全部滤掉。
 */
export function rankSession(session: SearchSession, data: RankingData): RankedItem[] {
  const rctx = rankContext(session.createdAt, session.plan, data);
  const { kept } = applyFilters(session.candidates, session.plan.postFilters, rctx);
  return rankCandidates(kept, rctx);
}

export type SearchOutcome =
  | { kind: 'done'; session: SearchSession; ranked: RankedItem[] }
  | { kind: 'confirm'; reason: string; maxQueries: number; plan: SearchPlan };

async function fetchCandidates(
  yt: YouTubeClient,
  plan: SearchPlan,
  isEnough: (cands: VideoCandidate[]) => boolean,
  budget: OperationBudget,
): Promise<{ candidates: VideoCandidate[]; extraPagesUsed: number }> {
  const byId = new Map<string, VideoCandidate>();
  const subscriberCounts = new Map<string, number | undefined>();
  const nextTokens: (string | undefined)[] = [];

  const ingest = async (hitsPerQuery: { queryIndex: number; hits: { videoId: string; rank: number }[] }[]) => {
    const newIds = hitsPerQuery.flatMap((h) => h.hits.map((x) => x.videoId)).filter((id) => !byId.has(id));
    const details = newIds.length ? await yt.videos(newIds) : [];
    const detailMap = new Map(details.map((d) => [d.id, d]));
    const newChannels = [...new Set(details.map((d) => d.channelId))].filter((c) => c && !subscriberCounts.has(c));
    if (newChannels.length) {
      const chans = await yt.channels(newChannels, 'statistics');
      for (const c of newChannels) subscriberCounts.set(c, chans.find((x) => x.id === c)?.subscriberCount);
    }
    for (const { queryIndex, hits } of hitsPerQuery) {
      for (const h of hits) {
        const existing = byId.get(h.videoId);
        if (existing) {
          existing.hits.push({ queryIndex, rank: h.rank });
          continue;
        }
        const d = detailMap.get(h.videoId);
        if (!d) continue; // 搜索结果里有、但 videos.list 查不到（被删除/私有）
        const cand: VideoCandidate = { ...d, hits: [{ queryIndex, rank: h.rank }] };
        const subs = subscriberCounts.get(d.channelId);
        if (subs !== undefined) cand.channelSubscriberCount = subs;
        byId.set(h.videoId, cand);
      }
    }
  };

  const first: { queryIndex: number; hits: { videoId: string; rank: number }[] }[] = [];
  for (const [i, q] of plan.queries.entries()) {
    const r = await yt.search(q.params);
    nextTokens[i] = r.nextPageToken;
    first.push({ queryIndex: i, hits: r.hits });
  }
  await ingest(first);

  let extraPagesUsed = 0;
  while (extraPagesUsed < plan.maxExtraPages && !isEnough([...byId.values()]) && budget.canSpend('search.list')) {
    const qi = nextTokens.findIndex((t) => !!t);
    if (qi < 0) break;
    const r = await yt.search(plan.queries[qi]!.params, nextTokens[qi], 50 * (extraPagesUsed + 1));
    nextTokens[qi] = r.nextPageToken;
    extraPagesUsed++;
    await ingest([{ queryIndex: qi, hits: r.hits }]);
  }
  return { candidates: [...byId.values()], extraPagesUsed };
}

export interface SearchRequest {
  intent: Intent;
  /** 用户确认"配额不足、缩减检索词"后传入 */
  reduceTo?: number;
}

export async function runSearch(ctx: AppContext, req: SearchRequest): Promise<SearchOutcome> {
  const now = ctx.now();
  const [settings, data, ledger, cache] = await Promise.all([
    stores.settings.read(ctx.kv),
    loadRankingData(ctx),
    stores.quotaLedger.read(ctx.kv),
    stores.searchCache.read(ctx.kv),
  ]);
  let plan = planSearch(req.intent, plannerContext(settings, data.profile, now));
  if (req.reduceTo) plan = reducePlan(plan, req.reduceTo);
  const ttl = settings.search.cacheTtlMinutes * 60_000;
  const key = planCacheKey(plan);
  const hit = lookup(cache, key, now, ttl);
  const rctx = rankContext(now, plan, data);

  let candidates: VideoCandidate[];
  let fromCache = false;
  let cacheAgeMs: number | undefined;
  let extraPagesUsed = 0;
  const cost = { searchCalls: 0, generalUnits: 0 };

  if (hit) {
    candidates = hit.candidates;
    fromCache = true;
    cacheAgeMs = now - hit.createdAt;
    extraPagesUsed = hit.extraPagesUsed;
  } else {
    const snap = snapshot(ledger, settings.quota, now);
    const aff = checkPlanAffordable(plan, snap);
    if (!aff.ok) {
      if (aff.kind === 'blocked') {
        throw new AppError('quota', aff.reason, `配额在太平洋时间零点重置，也就是你本地时间 ${formatClock(snap.resetAt)}`);
      }
      return { kind: 'confirm', reason: aff.reason, maxQueries: aff.maxQueries, plan };
    }
    const budget = new OperationBudget(
      { searchCalls: settings.quota.searchCallsPerQuery, generalUnits: settings.quota.generalUnitsPerQuery },
      '本次找片',
    );
    const yt = createYouTube({
      http: ctx.http,
      auth: ctx.auth,
      baseUrl: ctx.endpoints.youtubeApi,
      charge: makeCharger(ctx, budget, settings.quota),
      onQuotaExhausted: makeExhaustedMarker(ctx),
    });
    const isEnough = (cands: VideoCandidate[]) => applyFilters(cands, plan.postFilters, rctx).kept.length >= plan.resultCount;
    const fetched = await fetchCandidates(yt, plan, isEnough, budget);
    candidates = fetched.candidates;
    extraPagesUsed = fetched.extraPagesUsed;
    cost.searchCalls = budget.searchCalls;
    cost.generalUnits = budget.generalUnits;
    await stores.searchCache.update(ctx.kv, ctx.locker, (c) =>
      store(c, { key, createdAt: now, candidates, fetchedCount: candidates.length, extraPagesUsed }, now, ttl),
    );
  }

  const filtered = applyFilters(candidates, plan.postFilters, rctx);
  const ranked = rankCandidates(filtered.kept, rctx);
  const session: SearchSession = {
    id: newId('s'),
    createdAt: now,
    utterance: req.intent.utterance,
    intent: req.intent,
    plan,
    candidates,
    fetchedCount: candidates.length,
    filterStats: filtered.stats,
    rankedIds: ranked.map((r) => r.video.id),
    modelVersion: data.model.version,
    fromCache,
    cost,
    extraPagesUsed,
  };
  if (cacheAgeMs !== undefined) session.cacheAgeMs = cacheAgeMs;
  await stores.searchSessions.update(ctx.kv, ctx.locker, (list) => [session, ...list].slice(0, STORAGE_LIMITS.searchSessionsKept));
  return { kind: 'done', session, ranked };
}

/** 按最新偏好重排当前会话，并记下新顺序（之后的评分以新顺序作为"展示位置"）。 */
export async function rerankSession(ctx: AppContext, sessionId: string): Promise<{ session: SearchSession; ranked: RankedItem[] } | undefined> {
  const [sessions, data] = await Promise.all([stores.searchSessions.read(ctx.kv), loadRankingData(ctx)]);
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return undefined;
  const ranked = rankSession(session, data);
  const updated: SearchSession = { ...session, rankedIds: ranked.map((r) => r.video.id), modelVersion: data.model.version };
  await stores.searchSessions.update(ctx.kv, ctx.locker, (list) => list.map((s) => (s.id === sessionId ? updated : s)));
  return { session: updated, ranked };
}

export async function latestSession(ctx: AppContext): Promise<{ session: SearchSession; ranked: RankedItem[] } | undefined> {
  const [sessions, data] = await Promise.all([stores.searchSessions.read(ctx.kv), loadRankingData(ctx)]);
  const session = sessions[0];
  if (!session) return undefined;
  // 恢复时保持当时的展示顺序（不悄悄重排）
  const ranked = rankSession(session, data);
  const order = new Map(session.rankedIds.map((id, i) => [id, i]));
  ranked.sort((a, b) => (order.get(a.video.id) ?? 1e9) - (order.get(b.video.id) ?? 1e9));
  return { session, ranked };
}
