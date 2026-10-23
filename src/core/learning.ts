// 评分 → 可见的调整。只调整排序参数与理解提示，不训练任何模型。
//  - 归因为"找错/排错"（或高分）：调整频道偏好、因子权重、兴趣簇权重；
//  - 归因为"理解错了"：不碰排序参数，记录一条理解纠正（由 rating-service 落库）；
//  - 未归因 / 自动调整关闭：只记录评分，明确说明"未调整"。

import { LEARNING, RANKING } from '../config/defaults';
import { formatSigned } from './format';
import { ALL_FACTORS } from './ranking';
import { FACTOR_LABELS, type Attribution, type Change, type FactorKey, type InterestCluster, type RankedItem, type RankingModel } from './types';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round = (x: number) => Math.round(x * 1000) / 1000;

export function normalizeWeights(w: Record<FactorKey, number>): Record<FactorKey, number> {
  const clamped = {} as Record<FactorKey, number>;
  for (const f of ALL_FACTORS) clamped[f] = clamp(w[f], RANKING.weightMin, RANKING.weightMax);
  const sum = ALL_FACTORS.reduce((s, f) => s + clamped[f], 0);
  const out = {} as Record<FactorKey, number>;
  for (const f of ALL_FACTORS) out[f] = round(clamped[f] / sum);
  return out;
}

export interface LearnInput {
  rating: number;
  attribution: Attribution;
  item: RankedItem;
  /** 当时展示给用户的那一批结果（按展示顺序） */
  batch: RankedItem[];
  model: RankingModel;
  clusters: InterestCluster[];
  autoAdjust: boolean;
  now: number;
}

export interface LearnOutput {
  model: RankingModel;
  clusters: InterestCluster[];
  changes: Change[];
}

/** 是否需要先问用户"为什么低分"。 */
export function needsAttribution(rating: number): boolean {
  return rating <= LEARNING.lowRatingMax;
}

export function learnFromRating(input: LearnInput): LearnOutput {
  const { rating, attribution, item, batch, model, clusters, autoAdjust, now } = input;
  const unchanged = (explanation: string): LearnOutput => ({ model, clusters, changes: [{ type: 'none', explanation }] });
  if (attribution === 'pending') return unchanged('等待你说明低分原因后再调整');
  if (attribution === 'none') return unchanged('已记录评分；没有归因，所以没有调整任何参数');
  if (attribution === 'understanding') return unchanged('归因为"理解错了"：不调整排序参数');
  if (!autoAdjust) return unchanged('已记录评分；设置中"根据评分自动调整排序"已关闭，未做调整');

  const y = (rating - 1) / 9;
  const v = item.video;
  const changes: Change[] = [];

  // 1) 频道偏好
  const prefBefore = model.channelPrefs[v.channelId]?.value ?? 0;
  const prefAfter = round(clamp(prefBefore + LEARNING.channelPrefStep * (y - 0.5) * 2, -1, 1));
  const channelPrefs = { ...model.channelPrefs };
  channelPrefs[v.channelId] = {
    value: prefAfter,
    title: v.channelTitle,
    ratings: (model.channelPrefs[v.channelId]?.ratings ?? 0) + 1,
  };
  if (prefAfter !== prefBefore) {
    changes.push({
      type: 'channelPref',
      channelId: v.channelId,
      channelTitle: v.channelTitle,
      before: prefBefore,
      after: prefAfter,
      explanation: `你给「${v.channelTitle}」的视频打了 ${rating} 分 → 频道偏好 ${formatSigned(prefBefore)} → ${formatSigned(prefAfter)}，之后它的视频会${prefAfter > prefBefore ? '更靠前' : '更靠后'}`,
    });
  }

  // 2) 因子权重：评分相对中性分（5.5）的偏离 × 该条在各因子上相对同批平均的偏离。
  //    低分 → 调低它"突出"的因子；高分 → 调高。不用"排名预期"：排得靠后的片子打低分不该被当成惊喜。
  const n = batch.length;
  const err = y - 0.5;
  const raw = { ...model.weights };
  const grads = {} as Record<FactorKey, number>;
  for (const f of ALL_FACTORS) {
    if (!item.activeFactors.includes(f) || n === 0) {
      grads[f] = 0;
      continue;
    }
    const mean = batch.reduce((s, b) => s + b.features[f], 0) / n;
    grads[f] = LEARNING.weightLearningRate * err * (item.features[f] - mean);
    raw[f] = raw[f] + grads[f];
  }
  const weights = normalizeWeights(raw);
  for (const f of ALL_FACTORS) {
    const delta = weights[f] - model.weights[f];
    if (Math.abs(delta) < LEARNING.minVisibleWeightDelta) continue;
    const g = grads[f];
    const direct = Math.abs(g) >= LEARNING.minVisibleWeightDelta / 2;
    const relation = item.features[f] >= batch.reduce((s, b) => s + b.features[f], 0) / Math.max(1, n) ? '高于' : '低于';
    changes.push({
      type: 'factorWeight',
      factor: f,
      before: model.weights[f],
      after: weights[f],
      explanation: direct
        ? `你给了 ${rating} 分（${err < 0 ? '偏低' : '偏高'}），它的「${FACTOR_LABELS[f]}」${relation}同批平均 → 权重 ${model.weights[f].toFixed(3)} → ${weights[f].toFixed(3)}`
        : `其他因子调整后重新归一化 → 「${FACTOR_LABELS[f]}」权重 ${model.weights[f].toFixed(3)} → ${weights[f].toFixed(3)}`,
    });
  }

  // 3) 兴趣簇权重
  const nextClusters = clusters.map((c) => {
    if (!item.matchedClusterIds.includes(c.id)) return c;
    const before = c.weight;
    const after = round(clamp(before + LEARNING.clusterWeightStep * (y - 0.5) * 2, LEARNING.clusterWeightMin, LEARNING.clusterWeightMax));
    if (after === before) return c;
    changes.push({
      type: 'clusterWeight',
      clusterId: c.id,
      clusterName: c.name,
      before,
      after,
      explanation: `这条视频契合兴趣簇「${c.name}」，你打了 ${rating} 分 → 兴趣簇权重 ${before.toFixed(2)} → ${after.toFixed(2)}`,
    });
    return { ...c, weight: after, updatedAt: now };
  });

  if (!changes.length) return unchanged('评分与当前排序预期一致，参数无需调整');
  return {
    model: { weights, channelPrefs, version: model.version + 1, updatedAt: now },
    clusters: nextClusters,
    changes,
  };
}

/** 展示用：频道/兴趣簇/纠正等全部列出；因子权重只列变化最大的几项，其余归为"小幅调整"。 */
export function summarizeChanges(changes: Change[], topFactors = 3): { main: Change[]; minor: Change[] } {
  const factors = changes
    .filter((c): c is Extract<Change, { type: 'factorWeight' }> => c.type === 'factorWeight')
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
  const top = new Set<Change>(factors.slice(0, topFactors));
  return {
    main: changes.filter((c) => c.type !== 'factorWeight' || top.has(c)),
    minor: changes.filter((c) => c.type === 'factorWeight' && !top.has(c)),
  };
}

/** 撤销一次调整：对数值类变化施加反向增量（之后若还有别的调整，结果是近似回退）。 */
export function revertChanges(model: RankingModel, clusters: InterestCluster[], changes: Change[], now: number): { model: RankingModel; clusters: InterestCluster[] } {
  const channelPrefs = { ...model.channelPrefs };
  const raw = { ...model.weights };
  let touchedWeights = false;
  let nextClusters = clusters;
  for (const ch of changes) {
    if (ch.type === 'channelPref') {
      const cur = channelPrefs[ch.channelId];
      if (cur) {
        channelPrefs[ch.channelId] = {
          ...cur,
          value: round(clamp(cur.value - (ch.after - ch.before), -1, 1)),
          ratings: Math.max(0, cur.ratings - 1),
        };
      }
    } else if (ch.type === 'factorWeight') {
      raw[ch.factor] -= ch.after - ch.before;
      touchedWeights = true;
    } else if (ch.type === 'clusterWeight') {
      nextClusters = nextClusters.map((c) =>
        c.id === ch.clusterId
          ? { ...c, weight: round(clamp(c.weight - (ch.after - ch.before), LEARNING.clusterWeightMin, LEARNING.clusterWeightMax)), updatedAt: now }
          : c,
      );
    }
  }
  return {
    model: {
      weights: touchedWeights ? normalizeWeights(raw) : model.weights,
      channelPrefs,
      version: model.version + 1,
      updatedAt: now,
    },
    clusters: nextClusters,
  };
}
