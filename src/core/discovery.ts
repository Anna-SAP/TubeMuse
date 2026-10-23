// 新博主发现（纯逻辑）：按兴趣簇检索最近的视频 → 按频道聚合 → 排除已订阅/近期推荐过/不感兴趣 → 打分并写理由。
// 只推荐、不订阅；每周 ≤ 5 个，每周为此消耗的 search ≤ 8 次。

import { DISCOVERY } from '../config/defaults';
import { formatCount } from './format';
import type { ChannelInfo, CreatorRecommendation, InterestCluster } from './types';

export interface DiscoveryQuery {
  topic: string;
  q: string;
  clusterWeight: number;
}

/** 学习类兴趣优先，其次按权重；每个兴趣一条检索（关键词用 | 取或），最多 maxCalls 条。 */
export function discoveryQueries(clusters: InterestCluster[], maxCalls: number): DiscoveryQuery[] {
  const rank = (c: InterestCluster) => (c.nature === 'learning' ? 2 : c.nature === 'entertainment' ? 0 : 1);
  const sorted = [...clusters].filter((c) => c.keywords.length || c.name).sort((a, b) => rank(b) - rank(a) || b.weight - a.weight);
  const out: DiscoveryQuery[] = [];
  for (const c of sorted) {
    if (out.length >= maxCalls) break;
    const terms = [c.name, ...c.keywords].map((t) => t.replace(/[|"]/g, '').trim()).filter((t) => t.length >= 2).slice(0, 4);
    if (!terms.length) continue;
    out.push({ topic: c.name, q: terms.join('|'), clusterWeight: c.weight });
  }
  return out;
}

export interface ChannelHit {
  channelId: string;
  channelTitle: string;
  topic: string;
  /** 在检索结果里出现的次数与最好名次 */
  count: number;
  bestRank: number;
  clusterWeight: number;
}

export function aggregateHits(results: { topic: string; clusterWeight: number; items: { channelId: string; channelTitle: string; rank: number }[] }[]): ChannelHit[] {
  const map = new Map<string, ChannelHit>();
  for (const r of results) {
    for (const it of r.items) {
      const cur = map.get(it.channelId);
      if (cur) {
        cur.count++;
        cur.bestRank = Math.min(cur.bestRank, it.rank);
        if (r.clusterWeight > cur.clusterWeight) {
          cur.topic = r.topic;
          cur.clusterWeight = r.clusterWeight;
        }
      } else {
        map.set(it.channelId, { channelId: it.channelId, channelTitle: it.channelTitle, topic: r.topic, count: 1, bestRank: it.rank, clusterWeight: r.clusterWeight });
      }
    }
  }
  return [...map.values()];
}

export interface ExclusionContext {
  subscribed: ReadonlySet<string>;
  dismissed: ReadonlySet<string>;
  /** 最近几周推荐过的 */
  recentlyRecommended: ReadonlySet<string>;
  /** 排序模型里的频道偏好（来自你的评分） */
  channelPrefs: Readonly<Record<string, { value: number }>>;
}

export function filterCandidates(hits: ChannelHit[], ex: ExclusionContext): ChannelHit[] {
  return hits.filter(
    (h) =>
      !ex.subscribed.has(h.channelId) &&
      !ex.dismissed.has(h.channelId) &&
      !ex.recentlyRecommended.has(h.channelId) &&
      (ex.channelPrefs[h.channelId]?.value ?? 0) > -0.15,
  );
}

/** 先粗排（只用检索数据），决定为哪些候选去读最近上传 */
export function preRank(hits: ChannelHit[]): ChannelHit[] {
  return [...hits].sort((a, b) => b.count - a.count || a.bestRank - b.bestRank || b.clusterWeight - a.clusterWeight).slice(0, DISCOVERY.maxCandidatesToInspect);
}

export interface CandidateDetail {
  hit: ChannelHit;
  info?: ChannelInfo;
  uploads: { videoId: string; title: string; publishedAt: string }[];
}

/** 打分 + 人话理由。活跃（30 天内有更新）是硬条件：不活跃的不推荐。 */
export function scoreCandidates(details: CandidateDetail[], ex: ExclusionContext, watched: ReadonlyMap<string, number>, now: number, maxChannels: number): CreatorRecommendation[] {
  const recs: CreatorRecommendation[] = [];
  for (const d of details) {
    const recent = d.uploads.filter((u) => now - Date.parse(u.publishedAt) <= DISCOVERY.lookbackDays * 86_400_000);
    if (!recent.length) continue;
    const pref = ex.channelPrefs[d.hit.channelId]?.value ?? 0;
    const seen = watched.get(d.hit.channelId) ?? 0;
    const subs = d.info?.subscriberCount;
    let score = d.hit.count * 1.0 + d.hit.clusterWeight + 0.5 * Math.min(recent.length, 4) + 2 * Math.max(0, pref) + 0.3 * Math.min(seen, 5);
    // 过大的频道（> 500 万订阅）通常你早就知道了，略微降权
    if (subs && subs > 5_000_000) score -= 1;
    const reasons: string[] = [];
    reasons.push(
      d.hit.count > 1
        ? `在你的兴趣「${d.hit.topic}」相关的近期视频里出现 ${d.hit.count} 次`
        : `出现在你的兴趣「${d.hit.topic}」的近期视频检索第 ${d.hit.bestRank} 位`,
    );
    reasons.push(`最近 ${DISCOVERY.lookbackDays} 天更新了 ${recent.length >= 10 ? '10+' : recent.length} 个视频`);
    if (subs) reasons.push(`${formatCount(subs)} 订阅`);
    if (pref > 0.15) reasons.push(`你给它的视频打过高分（偏好 +${pref.toFixed(2)}）`);
    if (seen > 0) reasons.push(`你看过它 ${seen} 个视频，但还没订阅`);
    recs.push({
      channelId: d.hit.channelId,
      title: d.info?.title || d.hit.channelTitle,
      ...(subs !== undefined ? { subscriberCount: subs } : {}),
      topic: d.hit.topic,
      reasons,
      recentVideos: d.uploads.slice(0, 3),
      score: Math.round(score * 100) / 100,
    });
  }
  return recs.sort((a, b) => b.score - a.score).slice(0, maxChannels);
}

export function channelUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`;
}
