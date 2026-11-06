// 花费账本（纯函数）：所有按量计费的调用都走"先预扣、后结算"。
// 预扣写进持久存储：页面被关、service worker 被回收、响应在路上丢了，这笔钱都还在账上，下一次检查预算时绕不过去。
// 结算三种结果：知道实际用量 → 按实际记；服务方明确拒绝（没有计费）→ 退回；不知道有没有计费（超时、断网、响应读不出来）→ 按预扣额记成"未确认"。

import { LLM_LIMITS, LLM_PRICES_PER_MTOK, LLM_UNKNOWN_PRICE_PER_MTOK, STORAGE_LIMITS, type LlmTask } from '../config/defaults';

/** 一笔进行中的预扣 */
export interface SpendHold {
  id: string;
  usd: number;
  at: number;
  /** 做什么用的（界面显示） */
  what: string;
}

/** 各账本（大模型、X、字幕）共用的部分 */
export interface HoldDay {
  /** 进行中的预扣：请求没回来就一直算在账上 */
  holds?: SpendHold[];
  /** 不知道有没有计费的调用，按预扣额计入 */
  unconfirmedUsd?: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function llmPrice(model: string): { input: number; output: number; known: boolean } {
  const p = LLM_PRICES_PER_MTOK[model.trim()];
  return p ? { ...p, known: true } : { ...LLM_UNKNOWN_PRICE_PER_MTOK, known: false };
}

export function llmCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = llmPrice(model);
  return round6((inputTokens * p.input + outputTokens * p.output) / 1e6);
}

export function heldUsd(day: HoldDay | undefined): number {
  return round6((day?.holds ?? []).reduce((s, h) => s + h.usd, 0));
}

/** 已确认之外的部分：预扣 + 未确认。检查预算时都要算上 */
export function pendingUsd(day: HoldDay | undefined): number {
  return round6(heldUsd(day) + (day?.unconfirmedUsd ?? 0));
}

export function addHold<D extends HoldDay>(day: D, hold: SpendHold): D {
  return { ...day, holds: [...(day.holds ?? []), hold] };
}

/** 从账本里取走一笔预扣（可能跨了日子）：返回它所在的日期与金额；找不到时 hold 为空（已经结算过） */
export function takeHold<D extends HoldDay>(days: Record<string, D>, holdId: string): { days: Record<string, D>; day?: string; hold?: SpendHold } {
  for (const [key, d] of Object.entries(days)) {
    const hold = d.holds?.find((h) => h.id === holdId);
    if (!hold) continue;
    const holds = d.holds!.filter((h) => h.id !== holdId);
    const next = { ...d };
    if (holds.length) next.holds = holds;
    else delete next.holds;
    return { days: { ...days, [key]: next }, day: key, hold };
  }
  return { days };
}

export function keepRecentDays<D>(days: Record<string, D>, keep: number = STORAGE_LIMITS.spendDaysKept): Record<string, D> {
  return Object.fromEntries(
    Object.keys(days)
      .sort()
      .slice(-keep)
      .map((k) => [k, days[k]!]),
  );
}

// ── 大模型 ──

export interface LlmTaskUsage {
  calls: number;
  usd: number;
}

export interface LlmDay extends HoldDay {
  spentUsd: number;
  byTask: Partial<Record<LlmTask, LlmTaskUsage>>;
  /** 有估算单价（模型不在价目表里）参与时为 true */
  estimatedPrice?: boolean;
}

export interface LlmLedger {
  days: Record<string, LlmDay>;
}

export interface LlmSnapshot {
  day: string;
  /** 已确认的花费 */
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
  resetAt: number;
  calls: number;
  estimatedPrice: boolean;
}

export const EMPTY_LLM_LEDGER: LlmLedger = { days: {} };

function emptyLlmDay(): LlmDay {
  return { spentUsd: 0, byTask: {} };
}

export function llmSnapshot(ledger: LlmLedger, budgetUsd: number, warnRatio: number, day: string, resetAt: number): LlmSnapshot {
  const d = ledger.days[day] ?? emptyLlmDay();
  const committed = round6(d.spentUsd + pendingUsd(d));
  const remaining = Math.max(0, round6(budgetUsd - committed));
  const ratio = budgetUsd > 0 ? Math.min(1, committed / budgetUsd) : 1;
  return {
    day,
    spentUsd: round6(d.spentUsd),
    unconfirmedUsd: round6(d.unconfirmedUsd ?? 0),
    heldUsd: heldUsd(d),
    budgetUsd,
    remainingUsd: remaining,
    ratio,
    warn: ratio >= warnRatio,
    exhausted: remaining <= 0,
    resetAt,
    calls: Object.values(d.byTask).reduce((s, t) => s + (t?.calls ?? 0), 0),
    estimatedPrice: !!d.estimatedPrice,
  };
}

export function llmHoldFits(ledger: LlmLedger, day: string, budgetUsd: number, usd: number): boolean {
  const d = ledger.days[day] ?? emptyLlmDay();
  return round6(d.spentUsd + pendingUsd(d) + usd) <= budgetUsd;
}

export function openLlmHold(ledger: LlmLedger, day: string, hold: SpendHold): LlmLedger {
  return { days: keepRecentDays({ ...ledger.days, [day]: addHold(ledger.days[day] ?? emptyLlmDay(), hold) }) };
}

function charge(day: LlmDay, task: LlmTask, usd: number): LlmDay {
  const cur = day.byTask[task] ?? { calls: 0, usd: 0 };
  return { ...day, spentUsd: round6(day.spentUsd + usd), byTask: { ...day.byTask, [task]: { calls: cur.calls + 1, usd: round6(cur.usd + usd) } } };
}

/** 按服务方报告的用量结算（请求已计费，哪怕结果不能用） */
export function settleLlmHold(ledger: LlmLedger, holdId: string, task: LlmTask, model: string, usage: { inputTokens: number; outputTokens: number }): LlmLedger {
  const t = takeHold(ledger.days, holdId);
  if (!t.day) return ledger;
  const usd = llmCostUsd(model, usage.inputTokens, usage.outputTokens);
  const next = charge(t.days[t.day]!, task, usd);
  return { days: { ...t.days, [t.day]: llmPrice(model).known ? next : { ...next, estimatedPrice: true } } };
}

/** 服务方明确拒绝，没有计费：退回预扣 */
export function releaseLlmHold(ledger: LlmLedger, holdId: string): LlmLedger {
  const t = takeHold(ledger.days, holdId);
  return t.day ? { days: t.days } : ledger;
}

/** 不知道有没有计费（超时、断网）：按预扣额记成"未确认"，不退回 */
export function abandonLlmHold(ledger: LlmLedger, holdId: string): LlmLedger {
  const t = takeHold(ledger.days, holdId);
  if (!t.day) return ledger;
  const d = t.days[t.day]!;
  return { days: { ...t.days, [t.day]: { ...d, unconfirmedUsd: round6((d.unconfirmedUsd ?? 0) + t.hold!.usd) } } };
}

/** 按字符数估算输入 token（偏保守）：要预扣的是上限，不是平均值 */
export function estimateInputTokens(...texts: readonly string[]): number {
  return Math.ceil(texts.reduce((s, t) => s + t.length, 0) * LLM_LIMITS.tokensPerChar);
}

/** 一次调用最多花多少：输入按估算，输出按上限 */
export function worstCaseLlmUsd(model: string, inputTokens: number, maxOutputTokens: number): number {
  return llmCostUsd(model, inputTokens, maxOutputTokens);
}
