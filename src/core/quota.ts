// YouTube 配额记账（纯函数）。两个桶：search.list 按次计；其他接口共用 units。
// 本地只能统计本扩展发出的调用（官方 API 不提供剩余配额查询），界面上会注明"本地估算"。

import { STORAGE_LIMITS, YOUTUBE_METHOD_COSTS, YOUTUBE_QUOTA, type QuotaBucket, type YtMethod } from '../config/defaults';
import { dayKey, nextMidnight } from './time';
import type { SearchPlan } from './types';

export interface DayUsage {
  searchCalls: number;
  generalUnits: number;
  byMethod: Partial<Record<YtMethod, number>>;
  /** 官方 API 已返回配额耗尽 */
  exhausted: Partial<Record<QuotaBucket, boolean>>;
}

export interface QuotaLedger {
  days: Record<string, DayUsage>;
}

export interface QuotaLimits {
  searchDailyCalls: number;
  generalDailyUnits: number;
  searchCallsPerQuery: number;
  generalUnitsPerQuery: number;
  warnRatio: number;
}

export interface BucketSnapshot {
  used: number;
  limit: number;
  remaining: number;
  ratio: number;
  warn: boolean;
  exhausted: boolean;
}

export interface QuotaSnapshot {
  dayKey: string;
  search: BucketSnapshot;
  general: BucketSnapshot;
  resetAt: number;
}

export const EMPTY_LEDGER: QuotaLedger = { days: {} };

export function quotaDayKey(now: number): string {
  return dayKey(now, YOUTUBE_QUOTA.resetTimeZone);
}

export function nextQuotaReset(now: number): number {
  return nextMidnight(now, YOUTUBE_QUOTA.resetTimeZone);
}

function emptyDay(): DayUsage {
  return { searchCalls: 0, generalUnits: 0, byMethod: {}, exhausted: {} };
}

export function usageFor(ledger: QuotaLedger, now: number): DayUsage {
  return ledger.days[quotaDayKey(now)] ?? emptyDay();
}

function prune(days: Record<string, DayUsage>): Record<string, DayUsage> {
  const keys = Object.keys(days).sort().slice(-STORAGE_LIMITS.quotaDaysKept);
  return Object.fromEntries(keys.map((k) => [k, days[k]!]));
}

export function recordCall(ledger: QuotaLedger, method: YtMethod, now: number): QuotaLedger {
  const key = quotaDayKey(now);
  const day = { ...(ledger.days[key] ?? emptyDay()) };
  const { bucket, cost } = YOUTUBE_METHOD_COSTS[method];
  if (bucket === 'search') day.searchCalls += cost;
  else day.generalUnits += cost;
  day.byMethod = { ...day.byMethod, [method]: (day.byMethod[method] ?? 0) + 1 };
  return { days: prune({ ...ledger.days, [key]: day }) };
}

export function markExhausted(ledger: QuotaLedger, bucket: QuotaBucket, now: number): QuotaLedger {
  const key = quotaDayKey(now);
  const day = { ...(ledger.days[key] ?? emptyDay()) };
  day.exhausted = { ...day.exhausted, [bucket]: true };
  return { days: prune({ ...ledger.days, [key]: day }) };
}

function bucketSnapshot(used: number, limit: number, warnRatio: number, exhausted: boolean): BucketSnapshot {
  const remaining = exhausted ? 0 : Math.max(0, limit - used);
  const ratio = limit > 0 ? Math.min(1, used / limit) : 1;
  return { used, limit, remaining, ratio, warn: exhausted || ratio >= warnRatio, exhausted: exhausted || remaining <= 0 };
}

export function snapshot(ledger: QuotaLedger, limits: QuotaLimits, now: number): QuotaSnapshot {
  const day = usageFor(ledger, now);
  return {
    dayKey: quotaDayKey(now),
    search: bucketSnapshot(day.searchCalls, limits.searchDailyCalls, limits.warnRatio, !!day.exhausted.search),
    general: bucketSnapshot(day.generalUnits, limits.generalDailyUnits, limits.warnRatio, !!day.exhausted.general),
    resetAt: nextQuotaReset(now),
  };
}

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    readonly bucket: QuotaBucket,
    readonly scope: 'operation' | 'daily',
  ) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/** 单次操作（一次找片 / 一次同步）的预算。每次调用前 spend()，超出即抛错——不会悄悄多花。 */
export class OperationBudget {
  searchCalls = 0;
  generalUnits = 0;
  constructor(
    readonly limits: { searchCalls: number; generalUnits: number },
    readonly label: string,
  ) {}

  canSpend(method: YtMethod): boolean {
    const { bucket, cost } = YOUTUBE_METHOD_COSTS[method];
    return bucket === 'search' ? this.searchCalls + cost <= this.limits.searchCalls : this.generalUnits + cost <= this.limits.generalUnits;
  }

  spend(method: YtMethod): void {
    const { bucket, cost } = YOUTUBE_METHOD_COSTS[method];
    if (!this.canSpend(method)) {
      throw new BudgetExceededError(
        bucket === 'search'
          ? `${this.label}的 search 预算（${this.limits.searchCalls} 次）已用完`
          : `${this.label}的配额预算（${this.limits.generalUnits} units）已用完`,
        bucket,
        'operation',
      );
    }
    if (bucket === 'search') this.searchCalls += cost;
    else this.generalUnits += cost;
  }
}

export type Affordability =
  | { ok: true }
  | { ok: false; kind: 'reduce'; reason: string; maxQueries: number }
  | { ok: false; kind: 'blocked'; reason: string };

/** 今日剩余配额是否够执行这个计划；不够时给出"缩减到几条检索词"的方案，交给用户确认。 */
export function checkPlanAffordable(plan: SearchPlan, snap: QuotaSnapshot): Affordability {
  const needSearch = plan.estimatedCost.searchCalls;
  const needGeneral = plan.estimatedCost.generalUnits;
  if (snap.search.remaining <= 0) {
    return { ok: false, kind: 'blocked', reason: `今日 search 次数已用完（本地计数 ${snap.search.used}/${snap.search.limit}${snap.search.exhausted && snap.search.used < snap.search.limit ? '，官方 API 已返回配额耗尽' : ''}）` };
  }
  if (snap.general.remaining < 2) {
    return { ok: false, kind: 'blocked', reason: `今日其他接口配额已用完（本地计数 ${snap.general.used}/${snap.general.limit} units）` };
  }
  const maxBySearch = snap.search.remaining;
  const maxByGeneral = Math.floor(snap.general.remaining / 2);
  const maxQueries = Math.min(maxBySearch, maxByGeneral);
  if (needSearch <= snap.search.remaining && needGeneral <= snap.general.remaining) return { ok: true };
  return {
    ok: false,
    kind: 'reduce',
    reason: `本次计划需要 search ×${needSearch}，今日只剩 ${snap.search.remaining} 次`,
    maxQueries: Math.max(1, maxQueries),
  };
}

/** 同步画像的成本估算（全部计入通用桶）。 */
export function estimateSyncCost(subscriptionCount: number | undefined, likedMax: number): { units: number; detail: string } {
  const subsPages = Math.max(1, Math.ceil((subscriptionCount ?? 200) / 50));
  const likedPages = Math.max(1, Math.ceil(likedMax / 50));
  const channelPages = Math.ceil(((subscriptionCount ?? 200) + likedMax / 3) / 50);
  const units = subsPages + likedPages + channelPages;
  return {
    units,
    detail: `订阅列表约 ${subsPages} 页 + 喜欢的视频约 ${likedPages} 页 + 频道详情约 ${channelPages} 次，每次 1 unit`,
  };
}
