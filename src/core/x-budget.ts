// X 花费记账（纯函数）。X 按"返回的资源条数"计费，同一资源在同一 UTC 日内重复读取只计一次——本地账本照此去重。
// 预算护栏：每次请求前按"最坏情况全部是新资源"估算，超出就不发；请求后按实际返回的新资源记账。

import { X_API } from '../config/defaults';

export interface XRequestLog {
  at: number;
  endpoint: string;
  resources: number;
  newResources: number;
  costUsd: number;
}

export interface XDay {
  spentUsd: number;
  postIds: string[];
  userIds: string[];
  requests: XRequestLog[];
  /** 本地护栏或 X 官方拒绝（余额/花费上限）时记录 */
  blocked?: { at: number; reason: string };
}

export interface XLedger {
  days: Record<string, XDay>;
}

export interface XSnapshot {
  day: string;
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  ratio: number;
  warn: boolean;
  exhausted: boolean;
  /** 下一次 UTC 零点 */
  resetAt: number;
  blocked?: { at: number; reason: string };
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function emptyDay(): XDay {
  return { spentUsd: 0, postIds: [], userIds: [], requests: [] };
}

export function xSnapshot(ledger: XLedger, budgetUsd: number, warnRatio: number, now: number): XSnapshot {
  const day = utcDay(now);
  const d = ledger.days[day] ?? emptyDay();
  const remaining = Math.max(0, round4(budgetUsd - d.spentUsd));
  const ratio = budgetUsd > 0 ? Math.min(1, d.spentUsd / budgetUsd) : 1;
  const snap: XSnapshot = {
    day,
    spentUsd: round4(d.spentUsd),
    budgetUsd,
    remainingUsd: remaining,
    ratio,
    warn: ratio >= warnRatio,
    exhausted: remaining < X_API.pricing.postRead * X_API.minResults,
    resetAt: nextUtcMidnight(now),
  };
  if (d.blocked) snap.blocked = d.blocked;
  return snap;
}

export type PostReadPlan = { ok: true; maxResults: number } | { ok: false; reason: string };

/** 这次最多能读几条帖子：不超过期望值、不超过剩余预算可承受的最坏情况；不足 X 的最小值（10 条）就不读。 */
export function planPostRead(snap: XSnapshot, desired: number): PostReadPlan {
  if (snap.blocked) return { ok: false, reason: `今天的 X 请求已被停止：${snap.blocked.reason}` };
  const affordable = Math.floor(round4(snap.remainingUsd / X_API.pricing.postRead));
  const n = Math.min(X_API.maxResults, Math.max(X_API.minResults, desired), affordable);
  if (n < X_API.minResults) {
    return {
      ok: false,
      reason: `今日 X 预算还剩 $${snap.remainingUsd.toFixed(3)}，不够再读 ${X_API.minResults} 条帖子（$${(X_API.minResults * X_API.pricing.postRead).toFixed(3)}），已停止调用`,
    };
  }
  return { ok: true, maxResults: n };
}

function record(ledger: XLedger, kind: 'post' | 'user', ids: string[], endpoint: string, now: number): { ledger: XLedger; costUsd: number; newCount: number } {
  const day = utcDay(now);
  const d = { ...(ledger.days[day] ?? emptyDay()) };
  const seen = new Set(kind === 'post' ? d.postIds : d.userIds);
  const fresh = [...new Set(ids)].filter((id) => !seen.has(id));
  const price = kind === 'post' ? X_API.pricing.postRead : X_API.pricing.userRead;
  const costUsd = round4(fresh.length * price);
  if (kind === 'post') d.postIds = [...d.postIds, ...fresh];
  else d.userIds = [...d.userIds, ...fresh];
  d.spentUsd = round4(d.spentUsd + costUsd);
  d.requests = [...d.requests, { at: now, endpoint, resources: ids.length, newResources: fresh.length, costUsd }];
  // 只保留最近 7 个 UTC 日
  const days = { ...ledger.days, [day]: d };
  const keep = Object.keys(days).sort().slice(-7);
  return { ledger: { days: Object.fromEntries(keep.map((k) => [k, days[k]!])) }, costUsd, newCount: fresh.length };
}

export function recordPostRead(ledger: XLedger, postIds: string[], endpoint: string, now: number) {
  return record(ledger, 'post', postIds, endpoint, now);
}

export function recordUserRead(ledger: XLedger, userIds: string[], endpoint: string, now: number) {
  return record(ledger, 'user', userIds, endpoint, now);
}

/** X 官方拒绝（余额不足 / 花费上限）后，当天不再尝试 */
export function markXBlocked(ledger: XLedger, reason: string, now: number): XLedger {
  const day = utcDay(now);
  return { days: { ...ledger.days, [day]: { ...(ledger.days[day] ?? emptyDay()), blocked: { at: now, reason } } } };
}

/** 你在 X 后台充值或调高上限后，可以手动解除当天的停止状态 */
export function clearXBlocked(ledger: XLedger, now: number): XLedger {
  const day = utcDay(now);
  const d = ledger.days[day];
  if (!d?.blocked) return ledger;
  const next = { ...d };
  delete next.blocked;
  return { days: { ...ledger.days, [day]: next } };
}
