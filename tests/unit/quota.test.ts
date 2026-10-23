import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  EMPTY_LEDGER,
  OperationBudget,
  checkPlanAffordable,
  markExhausted,
  nextQuotaReset,
  quotaDayKey,
  recordCall,
  snapshot,
  type QuotaLimits,
} from '../../src/core/quota';
import { planCacheKey, lookup, store } from '../../src/core/cache';
import { assembleIntent } from '../../src/core/intent';
import { planSearch } from '../../src/core/planner';
import { NOW, RAW_1, UTTERANCE_1, makeVideo, plannerCtx } from './helpers';
import { DEFAULT_SETTINGS } from '../../src/config/defaults';

const limits: QuotaLimits = DEFAULT_SETTINGS.quota;

describe('配额日界：美国太平洋时间零点', () => {
  it('夏令时期间（PDT, UTC-7）', () => {
    // 2026-10-24 06:59Z = 10-23 23:59 PDT；07:00Z = 10-24 00:00 PDT
    expect(quotaDayKey(Date.parse('2026-10-24T06:59:00Z'))).toBe('2026-10-23');
    expect(quotaDayKey(Date.parse('2026-10-24T07:00:00Z'))).toBe('2026-10-24');
    expect(new Date(nextQuotaReset(Date.parse('2026-10-24T02:00:00Z'))).toISOString()).toBe('2026-10-24T07:00:00.000Z');
  });
  it('冬令时期间（PST, UTC-8）与切换日', () => {
    expect(new Date(nextQuotaReset(Date.parse('2026-12-01T12:00:00Z'))).toISOString()).toBe('2026-12-02T08:00:00.000Z');
    // 2026-11-01 是夏令时结束日：当天 00:00 PDT = 07:00Z，次日 00:00 PST = 11-02 08:00Z
    expect(new Date(nextQuotaReset(Date.parse('2026-11-01T10:00:00Z'))).toISOString()).toBe('2026-11-02T08:00:00.000Z');
    // 2026-03-08 夏令时开始：3-8 00:00 PST = 08:00Z，3-9 00:00 PDT = 07:00Z
    expect(new Date(nextQuotaReset(Date.parse('2026-03-08T12:00:00Z'))).toISOString()).toBe('2026-03-09T07:00:00.000Z');
  });
});

describe('记账：两个桶分开', () => {
  it('search.list 计入 search 桶，其他接口计入通用桶', () => {
    let l = EMPTY_LEDGER;
    l = recordCall(l, 'search.list', NOW);
    l = recordCall(l, 'search.list', NOW);
    l = recordCall(l, 'videos.list', NOW);
    l = recordCall(l, 'channels.list', NOW);
    const s = snapshot(l, limits, NOW);
    expect(s.search.used).toBe(2);
    expect(s.search.remaining).toBe(98);
    expect(s.general.used).toBe(2);
    expect(s.general.remaining).toBe(9998);
  });
  it('跨过太平洋时间零点后重新计数', () => {
    let l = recordCall(EMPTY_LEDGER, 'search.list', Date.parse('2026-10-24T06:00:00Z'));
    l = recordCall(l, 'search.list', Date.parse('2026-10-24T08:00:00Z'));
    expect(snapshot(l, limits, Date.parse('2026-10-24T08:00:00Z')).search.used).toBe(1);
  });
  it('接近上限时提示（≥80%）', () => {
    let l = EMPTY_LEDGER;
    for (let i = 0; i < 80; i++) l = recordCall(l, 'search.list', NOW);
    expect(snapshot(l, limits, NOW).search.warn).toBe(true);
  });
  it('官方返回配额耗尽 → 剩余视为 0', () => {
    const l = markExhausted(EMPTY_LEDGER, 'search', NOW);
    const s = snapshot(l, limits, NOW);
    expect(s.search.remaining).toBe(0);
    expect(s.search.exhausted).toBe(true);
  });
  it('只保留最近 7 天', () => {
    let l = EMPTY_LEDGER;
    for (let d = 0; d < 10; d++) l = recordCall(l, 'videos.list', NOW + d * 86_400_000);
    expect(Object.keys(l.days)).toHaveLength(7);
  });
});

describe('单次操作预算', () => {
  it('超过单次 search 预算立刻抛错，不会悄悄多花', () => {
    const b = new OperationBudget({ searchCalls: 3, generalUnits: 50 }, '本次找片');
    b.spend('search.list');
    b.spend('search.list');
    b.spend('search.list');
    expect(() => b.spend('search.list')).toThrow(BudgetExceededError);
    expect(b.searchCalls).toBe(3);
    b.spend('videos.list');
    expect(b.generalUnits).toBe(1);
  });
});

describe('计划是否负担得起', () => {
  const plan = planSearch(assembleIntent(UTTERANCE_1, RAW_1, NOW, 0), plannerCtx());
  it('配额充足', () => {
    expect(checkPlanAffordable(plan, snapshot(EMPTY_LEDGER, limits, NOW))).toEqual({ ok: true });
  });
  it('只剩 1 次 → 建议缩减（交给用户确认）', () => {
    let l = EMPTY_LEDGER;
    for (let i = 0; i < 99; i++) l = recordCall(l, 'search.list', NOW);
    const r = checkPlanAffordable(plan, snapshot(l, limits, NOW));
    expect(r).toMatchObject({ ok: false, kind: 'reduce', maxQueries: 1 });
  });
  it('用完 → 阻止', () => {
    let l = EMPTY_LEDGER;
    for (let i = 0; i < 100; i++) l = recordCall(l, 'search.list', NOW);
    expect(checkPlanAffordable(plan, snapshot(l, limits, NOW))).toMatchObject({ ok: false, kind: 'blocked' });
  });
});

describe('缓存', () => {
  it('同一意图在不同时刻得到同一个键（时间窗按相对小时记）', () => {
    const intent = assembleIntent(UTTERANCE_1, RAW_1, NOW, 0);
    const a = planCacheKey(planSearch(intent, plannerCtx({ now: NOW })));
    const b = planCacheKey(planSearch(intent, plannerCtx({ now: NOW + 10 * 60_000 })));
    expect(a).toBe(b);
  });
  it('检索参数不同则键不同', () => {
    const intent = assembleIntent(UTTERANCE_1, RAW_1, NOW, 0);
    const p = planSearch(intent, plannerCtx());
    const p2 = { ...p, queries: [{ ...p.queries[0]!, params: { ...p.queries[0]!.params, q: 'other' } }] };
    expect(planCacheKey(p)).not.toBe(planCacheKey(p2));
  });
  it('30 分钟内命中，过期不命中，写入时清理过期项', () => {
    const ttl = 30 * 60_000;
    let c = store({}, { key: 'a', createdAt: NOW, candidates: [makeVideo()], fetchedCount: 1, extraPagesUsed: 0 }, NOW, ttl);
    expect(lookup(c, 'a', NOW + ttl - 1, ttl)).toBeDefined();
    expect(lookup(c, 'a', NOW + ttl + 1, ttl)).toBeUndefined();
    c = store(c, { key: 'b', createdAt: NOW + ttl + 1, candidates: [], fetchedCount: 0, extraPagesUsed: 0 }, NOW + ttl + 1, ttl);
    expect(Object.keys(c)).toEqual(['b']);
  });
});
