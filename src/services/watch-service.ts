// 观看记录：接收内容脚本上报的会话 → 按"本地日期 + 视频"汇总；补全元数据（官方 API）；学习/娱乐判定与纠正。

import { WATCH } from '../config/defaults';
import { applyCorrection, classifyNature, windowStats } from '../core/nature';
import { OperationBudget } from '../core/quota';
import type { DayEntry } from '../core/summary';
import { dayKey, DAY_MS } from '../core/time';
import type { Nature, NatureVerdict, WatchRecord, WatchSession, WindowStats } from '../core/types';
import { aggregateRecord, classifyWatch } from '../core/watch';
import type { AppContext } from './context';
import { AppError } from './errors';
import { isLinked } from './auth';
import { makeCharger, makeExhaustedMarker } from './quota-service';
import { stores } from './repo';
import { createYouTube } from './youtube';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** 内容脚本发来的数据不完全可信：只保留需要的字段并校验类型。 */
export function sanitizeSession(raw: unknown): WatchSession | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.videoId !== 'string' || !/^[\w-]{6,20}$/.test(r.videoId)) return undefined;
  const intervals = Array.isArray(r.intervals)
    ? (r.intervals as unknown[])
        .filter((iv): iv is [number, number] => Array.isArray(iv) && iv.length === 2 && iv.every((x) => typeof x === 'number' && Number.isFinite(x)))
        .slice(0, 2000)
    : [];
  return {
    id: r.id.slice(0, 64),
    videoId: r.videoId,
    startedAt: num(r.startedAt),
    updatedAt: num(r.updatedAt),
    durationSec: num(r.durationSec),
    intervals,
    playSec: num(r.playSec),
    fgSec: num(r.fgSec),
    bgSec: num(r.bgSec),
    adSec: num(r.adSec),
    shorts: r.shorts === true,
  };
}

/** 收到一次会话上报（累计值，可重复）：更新会话，重算当天该视频的汇总记录。 */
export async function ingestSession(ctx: AppContext, raw: unknown): Promise<WatchRecord | undefined> {
  const settings = await stores.settings.read(ctx.kv);
  if (!settings.tracking.enabled) return undefined;
  const session = sanitizeSession(raw);
  if (!session || session.playSec <= 0) return undefined;
  const day = dayKey(session.startedAt, ctx.timeZone);
  return ctx.locker.withLock('watch', async () => {
    const sessions = await stores.watchSessions.read(ctx.kv);
    const prev = sessions[session.id];
    if (prev && prev.updatedAt > session.updatedAt) return undefined; // 乱序的旧上报
    sessions[session.id] = session;
    const cutoff = ctx.now() - WATCH.sessionRetentionDays * DAY_MS;
    for (const [id, s] of Object.entries(sessions)) if (s.updatedAt < cutoff) delete sessions[id];
    await stores.watchSessions.write(ctx.kv, sessions);

    const same = Object.values(sessions).filter((s) => s.videoId === session.videoId && dayKey(s.startedAt, ctx.timeZone) === day);
    const record = aggregateRecord(day, same, settings.tracking);
    if (!record) return undefined;
    const log = await stores.watchLog.read(ctx.kv);
    log[day] = { ...(log[day] ?? {}), [record.videoId]: record };
    await stores.watchLog.write(ctx.kv, log);
    await stores.jobState.update(ctx.kv, ctx.locker, (j) => (j.firstDay ? j : { ...j, firstDay: day }));
    return record;
  });
}

/** 改了判定阈值后，按新阈值重判已有记录（只改 status，不动时长） */
export async function reclassifyRecords(ctx: AppContext): Promise<void> {
  const settings = await stores.settings.read(ctx.kv);
  await stores.watchLog.update(ctx.kv, ctx.locker, (log) => {
    for (const day of Object.keys(log)) {
      for (const r of Object.values(log[day]!)) {
        const status = classifyWatch(r.completion, r.playSec, settings.tracking);
        log[day]![r.videoId] = { ...r, status };
      }
    }
    return log;
  });
}

/**
 * 给最近几天还没有标题/分类的记录补元数据：videos.list，每 50 个视频 1 unit。
 * 没连接 YouTube 时不弹授权窗口，直接返回原因（界面会显示"未取到标题"）。
 */
export async function enrichMetadata(ctx: AppContext): Promise<{ fetched: number; skipped?: string }> {
  const [log, metas, settings] = await Promise.all([stores.watchLog.read(ctx.kv), stores.videoMeta.read(ctx.kv), stores.settings.read(ctx.kv)]);
  const since = dayKey(ctx.now() - WATCH.metadataLookbackDays * DAY_MS, ctx.timeZone);
  const need = new Set<string>();
  for (const [day, recs] of Object.entries(log)) {
    if (day < since) continue;
    for (const id of Object.keys(recs)) if (!metas[id]) need.add(id);
  }
  if (!need.size) return { fetched: 0 };
  if (!isLinked(await ctx.auth.status())) return { fetched: 0, skipped: '尚未连接 YouTube，暂时取不到视频标题与分类' };
  const budget = new OperationBudget({ searchCalls: 0, generalUnits: WATCH.metadataUnitBudget }, '补全观看记录的元数据');
  const yt = createYouTube({
    http: ctx.http,
    auth: ctx.auth,
    baseUrl: ctx.endpoints.youtubeApi,
    charge: makeCharger(ctx, budget, settings.quota),
    onQuotaExhausted: makeExhaustedMarker(ctx),
  });
  const ids = [...need].slice(0, WATCH.metadataUnitBudget * 50);
  const fetched = await yt.videoMetas(ids, ctx.now());
  await stores.videoMeta.update(ctx.kv, ctx.locker, (m) => {
    for (const x of fetched) m[x.id] = x;
    return m;
  });
  return { fetched: fetched.length };
}

export interface NatureContext {
  verdict: (record: WatchRecord) => NatureVerdict;
}

/** 构造当前的学习/娱乐判定函数（读取元数据、兴趣簇、用户纠正） */
export async function natureContext(ctx: AppContext): Promise<NatureContext> {
  const [metas, clusters, rules] = await Promise.all([stores.videoMeta.read(ctx.kv), stores.clusters.read(ctx.kv), stores.natureRules.read(ctx.kv)]);
  return { verdict: (r) => classifyNature(r.videoId, metas[r.videoId], r.shorts, clusters.clusters, rules) };
}

export async function dayEntries(ctx: AppContext, day: string): Promise<(DayEntry & { verdict: NatureVerdict })[]> {
  const [log, metas, nc] = await Promise.all([stores.watchLog.read(ctx.kv), stores.videoMeta.read(ctx.kv), natureContext(ctx)]);
  return Object.values(log[day] ?? {})
    .sort((a, b) => b.lastAt - a.lastAt)
    .map((record) => {
      const verdict = nc.verdict(record);
      const meta = metas[record.videoId];
      return meta ? { record, meta, nature: verdict.nature, verdict } : { record, nature: verdict.nature, verdict };
    });
}

export async function currentWindowStats(ctx: AppContext, windowDays: number, at = ctx.now()): Promise<WindowStats> {
  const [log, nc] = await Promise.all([stores.watchLog.read(ctx.kv), natureContext(ctx)]);
  return windowStats(log, (r) => nc.verdict(r).nature, at, windowDays, ctx.timeZone);
}

/** 纠正学习/娱乐判定：只改这条，或改整个频道；nature=null 表示撤销纠正 */
export async function correctNature(ctx: AppContext, videoId: string, nature: Nature | null, scope: 'video' | 'channel'): Promise<void> {
  const metas = await stores.videoMeta.read(ctx.kv);
  const meta = metas[videoId];
  if (scope === 'channel' && (!meta || !meta.channelId)) {
    throw new AppError('input', '还不知道这条视频属于哪个频道（需要先取到元数据）', '连接 YouTube 后稍等片刻，或先只纠正这一条');
  }
  await stores.natureRules.update(ctx.kv, ctx.locker, (rules) =>
    applyCorrection(rules, videoId, nature, scope === 'channel' && meta ? { id: meta.channelId, title: meta.channelTitle } : undefined),
  );
}

/** 画像用：每个频道被看过（看完或部分观看）几次 */
export async function watchedChannelCounts(ctx: AppContext): Promise<Map<string, number>> {
  const [log, metas, takeout] = await Promise.all([stores.watchLog.read(ctx.kv), stores.videoMeta.read(ctx.kv), stores.takeout.read(ctx.kv)]);
  const counts = new Map<string, number>();
  for (const c of takeout?.channels ?? []) counts.set(c.channelId, c.count);
  for (const recs of Object.values(log)) {
    for (const r of Object.values(recs)) {
      const ch = metas[r.videoId]?.channelId;
      if (ch && r.status !== 'glance') counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
  }
  return counts;
}
