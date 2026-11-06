// X 花费记账（纯函数）。X 按"返回的资源条数"计费，同一资源在同一 UTC 日内重复读取只计一次——本地账本照此去重。
// 预算护栏：每次请求前按"最坏情况全部是新资源"预扣（写进账本，页面被关也不丢），超出就不发；请求后按实际返回的新资源结算。

import { X_API } from '../config/defaults';
import { addHold, heldUsd, keepRecentDays, pendingUsd, takeHold, type HoldDay } from './spend';

export interface XRequestLog {
  at: number;
  endpoint: string;
  resources: number;
  newResources: number;
  costUsd: number;
}

export interface XDay extends HoldDay {
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
  /** 不知道有没有计费、按最坏情况记着的部分 */
  unconfirmedUsd: number;
  /** 进行中的预扣 */
  heldUsd: number;
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
  const committed = d.spentUsd + pendingUsd(d);
  const remaining = Math.max(0, round4(budgetUsd - committed));
  const ratio = budgetUsd > 0 ? Math.min(1, committed / budgetUsd) : 1;
  const snap: XSnapshot = {
    day,
    spentUsd: round4(d.spentUsd),
    unconfirmedUsd: round4(d.unconfirmedUsd ?? 0),
    heldUsd: heldUsd(d),
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

/** 预扣一次读取：在同一把锁里算预算、写账本，并发的两路不会都以为还有钱 */
export function reserveXRead(ledger: XLedger, budgetUsd: number, warnRatio: number, desired: number, holdId: string, now: number): { ledger: XLedger; plan: PostReadPlan } {
  const plan = planPostRead(xSnapshot(ledger, budgetUsd, warnRatio, now), desired);
  if (!plan.ok) return { ledger, plan };
  const day = utcDay(now);
  const hold = { id: holdId, usd: round4(plan.maxResults * X_API.pricing.postRead), at: now, what: 'tweets/search/recent' };
  return { ledger: { days: keepRecentDays({ ...ledger.days, [day]: addHold(ledger.days[day] ?? emptyDay(), hold) }) }, plan };
}

/** X 明确拒绝，没有计费：退回预扣 */
export function releaseXHold(ledger: XLedger, holdId: string): XLedger {
  const t = takeHold(ledger.days, holdId);
  return t.day ? { days: t.days } : ledger;
}

/** 不知道有没有计费（超时、断网、响应读不出来）：按预扣额记成"未确认"，不退回 */
export function abandonXHold(ledger: XLedger, holdId: string): XLedger {
  const t = takeHold(ledger.days, holdId);
  if (!t.day) return ledger;
  const d = t.days[t.day]!;
  return { days: { ...t.days, [t.day]: { ...d, unconfirmedUsd: round4((d.unconfirmedUsd ?? 0) + t.hold!.usd) } } };
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

/** 读到了：去掉预扣，按实际返回的新帖子记账 */
export function settleXRead(ledger: XLedger, holdId: string, postIds: string[], endpoint: string, now: number) {
  return recordPostRead(releaseXHold(ledger, holdId), postIds, endpoint, now);
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
