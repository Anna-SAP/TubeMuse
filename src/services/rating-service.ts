// 评分：记录 → （低分）归因 → 调整 → 写入"改进记录"。所有调整可撤销。

import { LEARNING } from '../config/defaults';
import { learnFromRating, needsAttribution, revertChanges } from '../core/learning';
import { clip } from '../core/text';
import type { Adjustment, Attribution, Change, RatingRecord, SearchSession, UnderstandingCorrection } from '../core/types';
import type { AppContext } from './context';
import { AppError } from './errors';
import { newId, stores } from './repo';
import { loadRankingData, rankSession } from './search-service';

const LEARNING_LOCK = 'learning';

async function findSession(ctx: AppContext, id: string): Promise<SearchSession> {
  const s = (await stores.searchSessions.read(ctx.kv)).find((x) => x.id === id);
  if (!s) throw new AppError('internal', '找不到这次搜索的记录（可能已被清理）');
  return s;
}

async function pushAdjustment(ctx: AppContext, adj: Adjustment): Promise<void> {
  await stores.adjustments.update(ctx.kv, ctx.locker, (list) => [adj, ...list].slice(0, LEARNING.maxAdjustmentsKept));
}

/** 撤销某条调整（不加锁版本，供已持锁的调用方使用） */
async function revertUnlocked(ctx: AppContext, adjustmentId: string): Promise<Adjustment | undefined> {
  const list = await stores.adjustments.read(ctx.kv);
  const adj = list.find((a) => a.id === adjustmentId);
  if (!adj || adj.reverted) return adj;
  const numeric = adj.changes.filter((c) => c.type === 'channelPref' || c.type === 'factorWeight' || c.type === 'clusterWeight');
  if (numeric.length) {
    const [model, clusterState] = await Promise.all([stores.rankingModel.read(ctx.kv), stores.clusters.read(ctx.kv)]);
    const back = revertChanges(model, clusterState.clusters, numeric, ctx.now());
    await stores.rankingModel.write(ctx.kv, back.model);
    await stores.clusters.write(ctx.kv, { ...clusterState, clusters: back.clusters });
  }
  const correctionIds = adj.changes.flatMap((c) => (c.type === 'correction' ? [c.correctionId] : []));
  if (correctionIds.length) {
    await stores.corrections.update(ctx.kv, ctx.locker, (cs) => cs.map((c) => (correctionIds.includes(c.id) ? { ...c, active: false } : c)));
  }
  const updated = { ...adj, reverted: true };
  await stores.adjustments.update(ctx.kv, ctx.locker, (l) => l.map((a) => (a.id === adjustmentId ? updated : a)));
  return updated;
}

export async function revertAdjustment(ctx: AppContext, adjustmentId: string): Promise<Adjustment | undefined> {
  return ctx.locker.withLock(LEARNING_LOCK, () => revertUnlocked(ctx, adjustmentId));
}

/** 对一条评分做"排序侧"学习，返回调整记录 */
async function applyRankingLearning(ctx: AppContext, record: RatingRecord, session: SearchSession): Promise<Adjustment> {
  const [settings, data] = await Promise.all([stores.settings.read(ctx.kv), loadRankingData(ctx)]);
  const ranked = rankSession(session, data);
  const order = new Map(session.rankedIds.map((id, i) => [id, i]));
  ranked.sort((a, b) => (order.get(a.video.id) ?? 1e9) - (order.get(b.video.id) ?? 1e9));
  const item = ranked.find((r) => r.video.id === record.videoId);
  if (!item) throw new AppError('internal', '这条视频已不在本次结果中，无法据此调整');
  const shown = Math.max(session.plan.resultCount, ranked.indexOf(item) + 1);
  const out = learnFromRating({
    rating: record.rating,
    attribution: record.attribution,
    item,
    batch: ranked.slice(0, shown),
    model: data.model,
    clusters: data.clusters.clusters,
    autoAdjust: settings.learning.autoAdjustRanking,
    now: ctx.now(),
  });
  if (out.model !== data.model) await stores.rankingModel.write(ctx.kv, out.model);
  if (out.clusters !== data.clusters.clusters) await stores.clusters.write(ctx.kv, { ...data.clusters, clusters: out.clusters });
  return makeAdjustment(ctx, record, out.changes);
}

function makeAdjustment(ctx: AppContext, record: RatingRecord, changes: Change[]): Adjustment {
  return {
    id: newId('a'),
    at: ctx.now(),
    trigger: {
      videoId: record.videoId,
      title: record.video.title,
      rating: record.rating,
      attribution: record.attribution,
      searchId: record.searchId,
      utterance: record.utterance,
    },
    changes,
    reverted: false,
  };
}

export interface RateResult {
  record: RatingRecord;
  adjustment?: Adjustment;
  needsAttribution: boolean;
}

export async function rate(ctx: AppContext, sessionId: string, videoId: string, rating: number): Promise<RateResult> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) throw new AppError('input', '评分必须是 1–10 的整数');
  return ctx.locker.withLock(LEARNING_LOCK, async () => {
    const session = await findSession(ctx, sessionId);
    const video = session.candidates.find((c) => c.id === videoId);
    if (!video) throw new AppError('internal', '找不到这条视频');
    const ratings = await stores.ratings.read(ctx.kv);
    // 改分：先撤销上一次评分带来的调整，避免重复计入
    const prev = ratings[videoId];
    if (prev?.adjustmentId) await revertUnlocked(ctx, prev.adjustmentId);

    const record: RatingRecord = {
      videoId,
      rating,
      searchId: sessionId,
      utterance: session.utterance,
      at: ctx.now(),
      attribution: needsAttribution(rating) ? 'pending' : 'retrieval',
      video: { title: video.title, channelId: video.channelId, channelTitle: video.channelTitle },
    };
    if (record.attribution === 'pending') {
      await stores.ratings.update(ctx.kv, ctx.locker, (r) => ({ ...r, [videoId]: record }));
      return { record, needsAttribution: true };
    }
    const adjustment = await applyRankingLearning(ctx, record, session);
    record.adjustmentId = adjustment.id;
    await pushAdjustment(ctx, adjustment);
    await stores.ratings.update(ctx.kv, ctx.locker, (r) => ({ ...r, [videoId]: record }));
    return { record, adjustment, needsAttribution: false };
  });
}

export interface AttributionInput {
  videoId: string;
  attribution: Exclude<Attribution, 'pending'>;
  /** 理解错时：被理解错的约束 id；'whole' 表示整体理解错 */
  aspect?: string;
  note?: string;
}

export async function attribute(ctx: AppContext, input: AttributionInput): Promise<{ record: RatingRecord; adjustment: Adjustment; correction?: UnderstandingCorrection }> {
  return ctx.locker.withLock(LEARNING_LOCK, async () => {
    const ratings = await stores.ratings.read(ctx.kv);
    const prev = ratings[input.videoId];
    if (!prev) throw new AppError('internal', '找不到这条评分');
    if (prev.adjustmentId) await revertUnlocked(ctx, prev.adjustmentId);
    const session = await findSession(ctx, prev.searchId);
    const record: RatingRecord = { ...prev, attribution: input.attribution };
    delete record.adjustmentId;
    if (input.aspect) record.understandingAspect = input.aspect;
    if (input.note?.trim()) record.note = clip(input.note.trim(), 300);

    let adjustment: Adjustment;
    let correction: UnderstandingCorrection | undefined;
    if (input.attribution === 'understanding') {
      const c = input.aspect && input.aspect !== 'whole' ? session.intent.constraints.find((x) => x.id === input.aspect) : undefined;
      correction = {
        id: newId('u'),
        at: ctx.now(),
        utterance: session.utterance,
        note: record.note ?? '',
        active: true,
        ...(c ? { constraint: { kind: c.kind, span: c.span, label: c.label } } : {}),
      };
      const saved = correction;
      await stores.corrections.update(ctx.kv, ctx.locker, (cs) => [saved, ...cs]);
      const what = c ? `「${c.span || c.label}」被理解成「${c.label}」是错的` : '整体意图理解错了';
      adjustment = makeAdjustment(ctx, record, [
        {
          type: 'correction',
          correctionId: correction.id,
          explanation: `已记录理解纠正：原句「${session.utterance}」中${what}${record.note ? `（你的说明：${record.note}）` : ''}。之后解析口令时，这条纠正会作为参考一起发给 LLM；排序参数没有改动。`,
        },
      ]);
    } else if (input.attribution === 'retrieval') {
      adjustment = await applyRankingLearning(ctx, record, session);
    } else {
      adjustment = makeAdjustment(ctx, record, [{ type: 'none', explanation: `已记录 ${record.rating} 分；你选择不归因，所以没有调整任何参数` }]);
    }
    record.adjustmentId = adjustment.id;
    await pushAdjustment(ctx, adjustment);
    await stores.ratings.update(ctx.kv, ctx.locker, (r) => ({ ...r, [input.videoId]: record }));
    return correction ? { record, adjustment, correction } : { record, adjustment };
  });
}

export async function setCorrectionActive(ctx: AppContext, id: string, active: boolean): Promise<void> {
  await stores.corrections.update(ctx.kv, ctx.locker, (cs) => cs.map((c) => (c.id === id ? { ...c, active } : c)));
}

export async function deleteCorrection(ctx: AppContext, id: string): Promise<void> {
  await stores.corrections.update(ctx.kv, ctx.locker, (cs) => cs.filter((c) => c.id !== id));
}
