// 新博主发现：每周一次、≤ 5 个；每周为此消耗的 search ≤ 8 次（单独记账，超出即停）。
// 只给"打开频道"，不提供订阅。

import { DISCOVERY, YOUTUBE_METHOD_COSTS, type YtMethod } from '../config/defaults';
import { aggregateHits, discoveryQueries, filterCandidates, preRank, scoreCandidates, type CandidateDetail } from '../core/discovery';
import { OperationBudget } from '../core/quota';
import { addDays, weekEndingOn } from '../core/schedule';
import { dayKey, DAY_MS, toRfc3339 } from '../core/time';
import type { DiscoveryState, DiscoveryWeek } from '../core/types';
import type { AppContext } from './context';
import { AppError } from './errors';
import { makeCharger, makeExhaustedMarker } from './quota-service';
import { stores } from './repo';
import { watchedChannelCounts } from './watch-service';
import { createYouTube } from './youtube';

export function currentWeekKey(ctx: AppContext, weekday: number): string {
  return weekEndingOn(dayKey(ctx.now(), ctx.timeZone), weekday);
}

export function emptyWeek(): DiscoveryWeek {
  return { searchCalls: 0, recommendations: [], notes: [] };
}

/**
 * 同一时间只允许一次发现：后台例行任务与手动"现在发现"可能撞在一起（各自都以为还剩 8 次）。
 * 排队期间如果另一路刚跑完，直接返回它的结果，不再花 search。
 */
export async function runDiscovery(ctx: AppContext): Promise<DiscoveryWeek> {
  const requestedAt = ctx.now();
  return ctx.locker.withLock('run:discovery', () => runDiscoveryLocked(ctx, requestedAt));
}

async function runDiscoveryLocked(ctx: AppContext, requestedAt: number): Promise<DiscoveryWeek> {
  const [settings, clusterState, profile, state, model] = await Promise.all([
    stores.settings.read(ctx.kv),
    stores.clusters.read(ctx.kv),
    stores.profile.read(ctx.kv),
    stores.discovery.read(ctx.kv),
    stores.rankingModel.read(ctx.kv),
  ]);
  if (!settings.discovery.enabled) throw new AppError('input', '新博主发现已在设置中关闭');
  if (!clusterState.clusters.length) throw new AppError('input', '还没有兴趣簇', '先在"画像"页同步并生成兴趣簇');
  const weekKey = currentWeekKey(ctx, settings.weekly.weekday);
  const week = state.weeks[weekKey] ?? emptyWeek();
  if (week.generatedAt !== undefined && week.generatedAt > requestedAt) return week;
  const remaining = settings.discovery.weeklySearchCalls - week.searchCalls;
  if (remaining <= 0) {
    throw new AppError('budget', `本周用于发现新博主的 search 次数（${settings.discovery.weeklySearchCalls} 次）已经用完`, `下周（${addDays(weekKey, 1)} 起）会自动恢复`);
  }
  const queries = discoveryQueries(clusterState.clusters, remaining);
  const budget = new OperationBudget({ searchCalls: queries.length, generalUnits: DISCOVERY.generalUnitBudget }, '本周新博主发现');
  const charge = makeCharger(ctx, budget, settings.quota);
  // 每次 search 调用前就记进本周账本（而不是跑完才记）：中途失败或后台被休眠也不会漏记
  const chargeWeekly = async (method: YtMethod) => {
    await charge(method);
    if (YOUTUBE_METHOD_COSTS[method].bucket !== 'search') return;
    await stores.discovery.update(ctx.kv, ctx.locker, (s) => {
      const cur = s.weeks[weekKey] ?? emptyWeek();
      return { ...s, weeks: { ...s.weeks, [weekKey]: { ...cur, searchCalls: cur.searchCalls + 1 } } };
    });
  };
  const yt = createYouTube({
    http: ctx.http,
    auth: ctx.auth,
    baseUrl: ctx.endpoints.youtubeApi,
    charge: chargeWeekly,
    onQuotaExhausted: makeExhaustedMarker(ctx),
  });

  const notes: string[] = [];
  const persist = async (patch: Partial<Omit<DiscoveryWeek, 'searchCalls'>>) =>
    stores.discovery.update(ctx.kv, ctx.locker, (s) => {
      const cur = s.weeks[weekKey] ?? emptyWeek();
      const weeks = { ...s.weeks, [weekKey]: { ...cur, ...patch } };
      // 只保留最近 12 周
      const keep = Object.keys(weeks).sort().slice(-12);
      return { ...s, weeks: Object.fromEntries(keep.map((k) => [k, weeks[k]!])) };
    });

  try {
    const publishedAfter = toRfc3339(ctx.now() - DISCOVERY.lookbackDays * DAY_MS);
    const results = [];
    for (const q of queries) {
      const items = await yt.searchChannels({ part: 'snippet', type: 'video', q: q.q, maxResults: '50', order: 'relevance', publishedAfter });
      results.push({ topic: q.topic, clusterWeight: q.clusterWeight, items });
    }
    const recentlyRecommended = new Set<string>();
    for (const [key, w] of Object.entries(state.weeks)) {
      if (key >= addDays(weekKey, -7 * DISCOVERY.cooldownWeeks) && key < weekKey) for (const r of w.recommendations) recentlyRecommended.add(r.channelId);
    }
    const ex = {
      subscribed: new Set(profile.subscriptions.map((s) => s.id)),
      dismissed: new Set(Object.keys(state.dismissed)),
      recentlyRecommended,
      channelPrefs: model.channelPrefs,
    };
    if (!profile.syncedAt) notes.push('还没同步订阅列表，可能会推荐你已经订阅的频道');
    const candidates = preRank(filterCandidates(aggregateHits(results), ex));
    const details: CandidateDetail[] = [];
    if (candidates.length) {
      const infos = await yt.channels(candidates.map((c) => c.channelId), 'snippet,statistics');
      const uploads = await yt.uploadsPlaylists(candidates.map((c) => c.channelId));
      for (const c of candidates) {
        const pl = uploads.find((u) => u.channelId === c.channelId);
        let vids: CandidateDetail['uploads'] = [];
        if (pl && budget.canSpend('playlistItems.list')) {
          vids = (await yt.playlistItems(pl.uploads, 5)).map((v) => ({ videoId: v.videoId, title: v.title, publishedAt: v.publishedAt }));
        }
        const info = infos.find((i) => i.id === c.channelId);
        details.push(info ? { hit: c, info, uploads: vids } : { hit: c, uploads: vids });
      }
    }
    const watched = await watchedChannelCounts(ctx);
    const recommendations = scoreCandidates(details, ex, watched, ctx.now(), Math.min(5, settings.discovery.maxChannels));
    if (!recommendations.length) notes.push('这周没找到符合条件的新博主（都已订阅、近期推荐过、不活跃，或你标过不感兴趣）');
    const updated = await persist({ generatedAt: ctx.now(), recommendations, notes });
    return updated.weeks[weekKey]!;
  } catch (e) {
    await persist({ notes: [...week.notes, `上次运行失败：${e instanceof Error ? e.message : String(e)}`] });
    throw e;
  }
}

export async function dismissCreator(ctx: AppContext, channelId: string, title: string): Promise<void> {
  await stores.discovery.update(ctx.kv, ctx.locker, (s) => ({ ...s, dismissed: { ...s.dismissed, [channelId]: { title, at: ctx.now() } } }));
}

export async function undoDismiss(ctx: AppContext, channelId: string): Promise<void> {
  await stores.discovery.update(ctx.kv, ctx.locker, (s) => {
    const dismissed = { ...s.dismissed };
    delete dismissed[channelId];
    return { ...s, dismissed };
  });
}

/** 例行任务：本周还没推荐过、已连接 YouTube、有兴趣簇时自动跑一次 */
export async function discoveryDue(ctx: AppContext, state: DiscoveryState, weekday: number): Promise<boolean> {
  const week = state.weeks[currentWeekKey(ctx, weekday)];
  return !week?.generatedAt;
}
