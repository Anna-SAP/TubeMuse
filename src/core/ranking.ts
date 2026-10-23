// 排序：可解释的线性打分。每个因子 0–1，权重来自排序模型（会随评分调整），
// 推荐理由由贡献最大的因子确定性生成——不调用 LLM，不编造。

import { RANKING } from '../config/defaults';
import { matchClusters } from './clusters';
import { formatPercent, formatViews } from './format';
import { ageDays, evaluateCheck, type CheckContext } from './postfilter';
import { containsTerm, matchedTerms } from './text';
import { formatRelative } from './time';
import { FACTOR_LABELS, type FactorKey, type InterestCluster, type RankedItem, type RankingModel, type SearchPlan, type VideoCandidate } from './types';

export interface RankContext extends CheckContext {
  plan: SearchPlan;
  model: RankingModel;
  clusters: InterestCluster[];
  likedChannelCounts: ReadonlyMap<string, number>;
  /** 看过（看完/部分观看）该频道几次：本扩展的观看记录 + Takeout 历史 */
  watchedChannelCounts?: ReadonlyMap<string, number>;
  ratings: Readonly<Record<string, { rating: number }>>;
  /** 是否有任何画像数据（订阅/喜欢/兴趣簇）。没有时"个人品味"因子不参与 */
  hasProfile: boolean;
}

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

export const ALL_FACTORS: FactorKey[] = ['relevance', 'topic', 'taste', 'quality', 'freshness', 'format', 'channelPref'];

/** 本次计划下哪些因子生效、各自的有效权重（已归一化）。 */
export function effectiveWeights(model: RankingModel, plan: SearchPlan, hasProfile: boolean): Record<FactorKey, number> {
  const raw: Record<FactorKey, number> = { ...model.weights };
  if (plan.rank.freshness) raw.freshness *= RANKING.freshnessBoost;
  if (plan.rank.popularity || plan.rank.engagement || plan.rank.authority || plan.rank.depth) raw.quality *= RANKING.popularityBoost;
  if (plan.rank.formatTerms.length) raw.format *= RANKING.formatBoost;
  else raw.format = 0;
  if (!plan.rank.topicTerms.length) raw.topic = 0;
  if (!hasProfile) raw.taste = 0;
  const sum = ALL_FACTORS.reduce((s, f) => s + raw[f], 0) || 1;
  const out = {} as Record<FactorKey, number>;
  for (const f of ALL_FACTORS) out[f] = raw[f] / sum;
  return out;
}

interface Explained {
  value: number;
  reason?: string;
}

function relevanceRaw(v: VideoCandidate): number {
  return v.hits.reduce((s, h) => s + 1 / (RANKING.rrfK + h.rank), 0);
}

function topicFeature(v: VideoCandidate, terms: string[]): Explained {
  if (!terms.length) return { value: 0 };
  const inTitle = matchedTerms(v.title, terms);
  const elsewhere = matchedTerms(`${v.tags.join(' ')}\n${v.description.slice(0, 300)}`, terms).filter((t) => !inTitle.includes(t));
  const denom = Math.min(terms.length, 3);
  const value = clamp((inTitle.length + 0.5 * elsewhere.length) / denom);
  return { value, reason: inTitle.length ? `标题命中「${inTitle.slice(0, 3).join('、')}」` : undefined };
}

function tasteFeature(v: VideoCandidate, ctx: RankContext): Explained & { clusterIds: string[] } {
  const matches = matchClusters(v, ctx.clusters);
  const best = matches[0];
  const clusterScore = best ? best.strength * clamp(best.cluster.weight / 2, 0, 1) : 0;
  const subscribed = ctx.subscriptionIds.has(v.channelId);
  const liked = ctx.likedChannelCounts.get(v.channelId) ?? 0;
  const watched = ctx.watchedChannelCounts?.get(v.channelId) ?? 0;
  const value = clamp(clusterScore + (subscribed ? 0.25 : 0) + 0.15 * Math.min(1, liked / 3) + 0.1 * Math.min(1, watched / 10));
  const parts: string[] = [];
  if (subscribed) parts.push(`来自你订阅的频道「${v.channelTitle}」`);
  if (best && best.strength >= 0.35) {
    parts.push(
      best.viaChannel
        ? `契合你的兴趣簇「${best.cluster.name}」`
        : `契合你的兴趣簇「${best.cluster.name}」（命中：${best.keywords.slice(0, 2).join('、')}）`,
    );
  }
  if (!subscribed && liked > 0) parts.push(`你点赞过该频道 ${liked} 个视频`);
  if (!subscribed && !liked && watched >= 3) parts.push(`你看过该频道 ${watched} 个视频`);
  return {
    value,
    reason: parts.length ? parts.join('；') : undefined,
    clusterIds: matches.filter((m) => m.strength >= 0.35).map((m) => m.cluster.id),
  };
}

function qualityFeature(v: VideoCandidate, plan: SearchPlan): Explained {
  const views = v.viewCount ?? 0;
  const viewScore = clamp(Math.log10(views + 1) / 6.5);
  const likeRatio = v.likeCount !== undefined && views > 0 ? v.likeCount / views : undefined;
  const engagement = likeRatio === undefined ? 0.3 : clamp(likeRatio / 0.05);
  const scale = clamp(Math.log10((v.channelSubscriberCount ?? 0) + 1) / 7);
  const r = plan.rank;
  let w = [0.5, 0.3, 0.2];
  if (r.popularity && !r.engagement) w = [0.8, 0.1, 0.1];
  else if (r.engagement && !r.popularity) w = [0.2, 0.7, 0.1];
  else if (r.authority) w = [0.3, 0.2, 0.5];
  let value = w[0]! * viewScore + w[1]! * engagement + w[2]! * scale;
  if (r.depth) value = 0.5 * value + 0.5 * clamp(v.durationSec / 3600);
  const bits: string[] = [];
  if (views >= 100_000 || (r.popularity && views > 0)) bits.push(formatViews(views));
  if (likeRatio !== undefined && likeRatio >= 0.03) bits.push(`点赞率 ${formatPercent(likeRatio)}`);
  if (r.authority && v.channelSubscriberCount) bits.push(`频道 ${formatViews(v.channelSubscriberCount).replace('次播放', '订阅')}`);
  return { value: clamp(value), reason: bits.length ? bits.join('，') : undefined };
}

function freshnessFeature(v: VideoCandidate, ctx: RankContext): Explained {
  const days = ageDays(v, ctx.now);
  const tau = ctx.plan.rank.freshness ? RANKING.freshnessTauDaysRecent : RANKING.freshnessTauDaysDefault;
  const value = Math.exp(-days / tau);
  return { value, reason: ctx.plan.rank.freshness ? `${formatRelative(Date.parse(v.publishedAt), ctx.now)}发布，够新` : undefined };
}

function formatFeature(v: VideoCandidate, terms: string[]): Explained {
  if (!terms.length) return { value: 0 };
  const inTitle = matchedTerms(v.title, terms);
  if (inTitle.length) return { value: 1, reason: `形式匹配：标题含「${inTitle[0]}」` };
  const elsewhere = matchedTerms(`${v.description.slice(0, 300)}\n${v.tags.join(' ')}`, terms);
  return elsewhere.length ? { value: 0.6, reason: `形式匹配：简介/标签含「${elsewhere[0]}」` } : { value: 0 };
}

function channelPrefFeature(v: VideoCandidate, model: RankingModel): Explained {
  const pref = model.channelPrefs[v.channelId]?.value ?? 0;
  return { value: (pref + 1) / 2, reason: pref > 0.15 ? `你给该频道的视频打过高分（偏好 +${pref.toFixed(2)}）` : undefined };
}

/** 对过滤后的候选打分排序。 */
export function rankCandidates(cands: VideoCandidate[], ctx: RankContext): RankedItem[] {
  const weights = effectiveWeights(ctx.model, ctx.plan, ctx.hasProfile);
  const active = ALL_FACTORS.filter((f) => weights[f] > 0);
  const maxRel = Math.max(1e-9, ...cands.map(relevanceRaw));
  const queries = ctx.plan.queries.map((q) => q.q);

  const items = cands.map((v): RankedItem => {
    const bestHit = [...v.hits].sort((a, b) => a.rank - b.rank)[0];
    const rel: Explained = {
      value: relevanceRaw(v) / maxRel,
      reason: bestHit && bestHit.rank <= 5 ? `「${queries[bestHit.queryIndex] ?? ''}」检索第 ${bestHit.rank} 位` : undefined,
    };
    const taste = tasteFeature(v, ctx);
    const explained: Record<FactorKey, Explained> = {
      relevance: rel,
      topic: topicFeature(v, ctx.plan.rank.topicTerms),
      taste,
      quality: qualityFeature(v, ctx.plan),
      freshness: freshnessFeature(v, ctx),
      format: formatFeature(v, ctx.plan.rank.formatTerms),
      channelPref: channelPrefFeature(v, ctx.model),
    };
    const features = {} as Record<FactorKey, number>;
    for (const f of ALL_FACTORS) features[f] = explained[f].value;

    let score = active.reduce((s, f) => s + weights[f] * features[f], 0);
    const reasons: { w: number; text: string }[] = active
      .filter((f) => explained[f].reason && features[f] >= 0.3)
      .map((f) => ({ w: weights[f] * features[f], text: explained[f].reason! }));

    // 硬过滤通过的证据做成徽标；软约束按满足比例加分
    const badges: string[] = [];
    const warnings: string[] = [];
    for (const f of ctx.plan.postFilters) {
      const r = evaluateCheck(f, v, ctx);
      if (r.badge) badges.push(r.badge);
    }
    if (ctx.plan.softChecks.length) {
      const results = ctx.plan.softChecks.map((s) => ({ s, r: evaluateCheck(s, v, ctx) }));
      const ok = results.filter((x) => x.r.pass);
      score += (RANKING.softCheckBonus * ok.length) / results.length;
      if (ok.length) reasons.push({ w: 0.01, text: `满足偏好：${ok.map((x) => x.s.label).join('、')}` });
    }
    // 仅作参考的关键词
    const refHits = matchedTerms(`${v.title}\n${v.description.slice(0, 300)}`, ctx.plan.rank.referenceTerms);
    if (refHits.length) {
      score += 0.04 * Math.min(1, refHits.length / ctx.plan.rank.referenceTerms.length);
      reasons.push({ w: 0.005, text: `参考词命中「${refHits.slice(0, 2).join('、')}」` });
    }
    // 偏好频道
    if (
      ctx.plan.rank.preferChannelIds.includes(v.channelId) ||
      ctx.plan.rank.preferChannelNames.some((n) => containsTerm(v.channelTitle, n))
    ) {
      score += RANKING.preferChannelBonus;
      reasons.push({ w: 1, text: `你指定优先的频道「${v.channelTitle}」` });
    }
    const pref = ctx.model.channelPrefs[v.channelId]?.value ?? 0;
    if (pref < -0.15) warnings.push(`你给该频道的视频打过低分（偏好 ${pref.toFixed(2)}）`);
    const previous = ctx.ratings[v.id]?.rating;
    if (previous !== undefined) {
      warnings.push(`你之前给这条打过 ${previous} 分`);
      if (previous <= 4) score *= RANKING.previouslyLowRatedPenalty;
    }

    reasons.sort((a, b) => b.w - a.w);
    const item: RankedItem = {
      video: v,
      features,
      activeFactors: active,
      score,
      reasons: reasons.slice(0, RANKING.maxReasons).map((r) => r.text),
      badges,
      warnings,
      matchedClusterIds: taste.clusterIds,
    };
    if (previous !== undefined) item.previousRating = previous;
    return item;
  });

  return items.sort((a, b) => b.score - a.score || b.features.relevance - a.features.relevance);
}

/** 打分明细（"为什么排在这里"展开用） */
export function scoreBreakdown(item: RankedItem, model: RankingModel, plan: SearchPlan, hasProfile: boolean): { factor: FactorKey; label: string; weight: number; value: number; contribution: number }[] {
  const w = effectiveWeights(model, plan, hasProfile);
  return item.activeFactors
    .map((f) => ({ factor: f, label: FACTOR_LABELS[f], weight: w[f], value: item.features[f], contribution: w[f] * item.features[f] }))
    .sort((a, b) => b.contribution - a.contribution);
}
