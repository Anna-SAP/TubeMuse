// 花费边界：先预扣后结算、异常中断不漏账、失败不重复付钱、默认不花钱。全程用假服务，不出网。

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, JOB_RETRY, LLM_TASKS } from '../../src/config/defaults';
import { ENDPOINTS } from '../../src/config/endpoints';
import { abandonLlmHold, llmHoldFits, llmSnapshot, openLlmHold, releaseLlmHold, settleLlmHold, type LlmLedger } from '../../src/core/spend';
import { jobRetryDue, nextJobRetry } from '../../src/core/schedule';
import { localPreparePairs, localTranslatePair, subtitleSnapshot } from '../../src/core/subtitles';
import { abandonXHold, releaseXHold, reserveXRead, settleXRead, xSnapshot, type XLedger } from '../../src/core/x-budget';
import type { InterestCluster } from '../../src/core/types';
import type { AuthProvider } from '../../src/services/auth';
import type { AppContext } from '../../src/services/context';
import { runDiscovery } from '../../src/services/discovery-service';
import { refreshHotspots, xRefreshMaxUsd, xSpend } from '../../src/services/hotspot-service';
import { parseUtterance } from '../../src/services/intent-service';
import { getLlm, llmSpend, pingLlm, taskModel, taskMonthlyUsd } from '../../src/services/llm-factory';
import { refusedRetryWait } from '../../src/services/llm';
import { LocalTranslateError, chromeLocalTranslator, type LocalTranslator } from '../../src/services/local-translator';
import { mergeSettings, stores } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';
import { saveTextCue, subtitleSpend, transcribeSegment, translateCue } from '../../src/services/subtitle-service';
import { generateDailySummary, runScheduledJobs } from '../../src/services/summary-service';
import { encodeWav } from '../../src/core/subtitles';
import { createFakeApi, type FakeVideo } from './fake-api';
import { fakeSecret } from './fake-secrets';

const NOW = Date.parse('2026-10-24T02:00:00Z');
const DAY_KEY = '2026-10-24';
const KEY = fakeSecret('sk-ant-', 'test-0123456789abcdefghijklmn');
const XTOKEN = 'AAAAFakeXBearerTokenForTests0123456789';
const auth: AuthProvider = { configured: () => true, getToken: async () => fakeSecret('ya29.', 'fake-token-for-tests-1234567'), invalidate: async () => {}, status: async () => 'connected', disconnect: async () => ({ revoked: false }) };

const cluster = (id: string, name: string): InterestCluster => ({ id, name, description: '', keywords: [name, `${name}2`], channelIds: [], weight: 1, locked: false, source: 'llm', updatedAt: NOW });

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const anthropicOk = (usage = { input_tokens: 1000, output_tokens: 100 }, stop_reason = 'end_turn', text = '{"ok":true}') =>
  json(200, { id: 'msg', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text }], stop_reason, stop_sequence: null, usage });

function ctxWith(http: typeof fetch, seed: Record<string, unknown> = {}, translator?: LocalTranslator): AppContext {
  return {
    kv: memoryKV({ secrets: { anthropicApiKey: KEY, openaiApiKey: 'sk-openai-test', xBearerToken: XTOKEN }, ...seed }),
    locker: memoryLocker(),
    http,
    now: () => NOW,
    auth,
    endpoints: ENDPOINTS,
    timeZone: 'Asia/Shanghai',
    ...(translator ? { translator } : {}),
  };
}

const REQ = { system: 's', user: 'u', schema: { type: 'object' }, schemaName: 'x', effort: 'low' as const };

describe('大模型账本：先预扣，后结算', () => {
  const hold = { id: 'h1', usd: 0.1, at: NOW, what: '测试' };
  const base = (): LlmLedger => openLlmHold({ days: {} }, DAY_KEY, hold);

  it('预扣算进已用：还没回来的请求也占预算', () => {
    const l = base();
    expect(llmSnapshot(l, 0.5, 0.8, DAY_KEY, NOW).remainingUsd).toBeCloseTo(0.4);
    expect(llmHoldFits(l, DAY_KEY, 0.15, 0.1)).toBe(false);
    expect(llmHoldFits(l, DAY_KEY, 0.25, 0.1)).toBe(true);
  });

  it('按实际用量结算，退回预扣与实际的差额', () => {
    const l = settleLlmHold(base(), 'h1', 'intent', 'claude-haiku-5-5', { inputTokens: 1000, outputTokens: 100 });
    const s = llmSnapshot(l, 0.5, 0.8, DAY_KEY, NOW);
    expect(s.spentUsd).toBeCloseTo(0.00015, 6);
    expect(s.heldUsd).toBe(0);
    expect(s.calls).toBe(1);
  });

  it('明确拒绝的退回；不知道有没有计费的按预扣额记成未确认', () => {
    expect(llmSnapshot(releaseLlmHold(base(), 'h1'), 0.5, 0.8, DAY_KEY, NOW).remainingUsd).toBeCloseTo(0.5);
    const s = llmSnapshot(abandonLlmHold(base(), 'h1'), 0.5, 0.8, DAY_KEY, NOW);
    expect(s.unconfirmedUsd).toBeCloseTo(0.1);
    expect(s.remainingUsd).toBeCloseTo(0.4);
  });

  it('隔天才回来的请求算回它发出的那天；结算两次不重复记账', () => {
    const later = settleLlmHold(base(), 'h1', 'daily', 'claude-haiku-5-5', { inputTokens: 1000, outputTokens: 0 });
    expect(later.days[DAY_KEY]!.spentUsd).toBeCloseTo(0.0001, 6);
    expect(settleLlmHold(later, 'h1', 'daily', 'claude-haiku-5-5', { inputTokens: 1000, outputTokens: 0 })).toBe(later);
  });

  it('不在价目表里的模型按最贵一档算，并标记', () => {
    const l = settleLlmHold(base(), 'h1', 'daily', 'some-new-model', { inputTokens: 1_000_000, outputTokens: 0 });
    const s = llmSnapshot(l, 100, 0.8, DAY_KEY, NOW);
    expect(s.spentUsd).toBeCloseTo(10);
    expect(s.estimatedPrice).toBe(true);
  });
});

describe('大模型调用经过账本', () => {
  it('预算不够：不发请求，说明要多少、剩多少', async () => {
    let calls = 0;
    const ctx = ctxWith(async () => (calls++, anthropicOk()), { settings: { llm: { dailyBudgetUsd: 0.01 } } });
    const llm = await getLlm(ctx, 'clusters'); // 主模型 + 12000 输出上限 = 最多约 $0.24
    await expect(llm.generateJson(REQ)).rejects.toMatchObject({ kind: 'llm_budget' });
    expect(calls).toBe(0);
    expect((await llmSpend(ctx)).heldUsd).toBe(0);
  });

  it('请求在路上时页面被关：预扣还在账上，下一次检查绕不过去', async () => {
    const ctx = ctxWith(() => new Promise<Response>(() => {}), { settings: { llm: { dailyBudgetUsd: 0.12 } } });
    void (await getLlm(ctx, 'intent')).generateJson(REQ).catch(() => undefined); // 主模型，4000 输出上限 ≈ $0.08
    await new Promise((r) => setTimeout(r, 20));
    const s = await llmSpend(ctx);
    expect(s.heldUsd).toBeGreaterThan(0.07);
    await expect((await getLlm(ctx, 'intent')).generateJson(REQ)).rejects.toMatchObject({ kind: 'llm_budget' });
  });

  it('输出被截断：钱花了，按服务方报告的用量记账', async () => {
    const ctx = ctxWith(async () => anthropicOk({ input_tokens: 1000, output_tokens: 6000 }, 'max_tokens'));
    await expect((await getLlm(ctx, 'daily')).generateJson(REQ)).rejects.toMatchObject({ kind: 'llm', billing: { state: 'billed' } });
    expect((await llmSpend(ctx)).spentUsd).toBeCloseTo((1000 * 0.1 + 6000 * 0.5) / 1e6, 6);
  });

  it('返回的不是 JSON：同样按用量记账', async () => {
    const ctx = ctxWith(async () => anthropicOk(undefined, 'end_turn', 'not json'));
    await expect((await getLlm(ctx, 'daily')).generateJson(REQ)).rejects.toMatchObject({ kind: 'llm' });
    expect((await llmSpend(ctx)).calls).toBe(1);
  });

  it('5xx 没有计费：退回预扣，并自动重试一次', async () => {
    let calls = 0;
    const ctx = ctxWith(async () => (++calls === 1 ? json(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }) : anthropicOk()));
    await (await getLlm(ctx, 'ping')).generateJson(REQ);
    expect(calls).toBe(2);
    const s = await llmSpend(ctx);
    expect(s.calls).toBe(1);
    expect(s.heldUsd).toBe(0);
    expect(s.unconfirmedUsd).toBe(0);
  });

  it('断网或超时：不重发（可能付两次钱），按预扣额记成未确认', async () => {
    let calls = 0;
    const ctx = ctxWith(async () => {
      calls++;
      throw new TypeError('Failed to fetch');
    });
    await expect((await getLlm(ctx, 'daily')).generateJson(REQ)).rejects.toMatchObject({ kind: 'network', billing: { state: 'unknown' } });
    expect(calls).toBe(1);
    expect((await llmSpend(ctx)).unconfirmedUsd).toBeGreaterThan(0);
  });

  it('401 没有计费：退回预扣', async () => {
    const ctx = ctxWith(async () => json(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } }));
    await expect(pingLlm(ctx)).rejects.toMatchObject({ kind: 'llm_key' });
    const s = await llmSpend(ctx);
    expect(s.heldUsd + s.unconfirmedUsd + s.spentUsd).toBe(0);
  });

  it('要等很久的限流不等：直接告诉你', () => {
    const headers = new Headers({ 'retry-after': '30' });
    expect(refusedRetryWait({ status: 429, headers }, NOW)).toBeUndefined();
    expect(refusedRetryWait({ status: 429, headers: new Headers({ 'retry-after': '2' }) }, NOW)).toBe(2000);
    expect(refusedRetryWait({ status: 400 }, NOW)).toBeUndefined();
    expect(refusedRetryWait(new Error('timeout'), NOW)).toBeUndefined();
  });

  it('每个任务的输出上限发给服务方；档位可以在设置里改', async () => {
    const seen: { model: string; max_tokens: number }[] = [];
    const ctx = ctxWith(async (_u, init) => {
      seen.push(JSON.parse(String(init?.body)));
      return anthropicOk();
    }, { settings: { llm: { taskTiers: { daily: 'main' } } } });
    await (await getLlm(ctx, 'daily')).generateJson(REQ);
    await (await getLlm(ctx, 'hotspots')).generateJson(REQ);
    expect(seen.map((b) => [b.model, b.max_tokens])).toEqual([
      ['claude-opus-5-5', LLM_TASKS.daily.maxOutputTokens],
      ['claude-haiku-5-5', LLM_TASKS.hotspots.maxOutputTokens],
    ]);
  });

  it('省钱模型留空 = 跟随主模型；理解口令和兴趣簇默认用主模型', () => {
    const s = mergeSettings({ llm: { economyModels: { anthropic: '' } } });
    expect(taskModel(s, 'daily').model).toBe('claude-opus-5-5');
    const d = mergeSettings(undefined);
    expect(taskModel(d, 'intent').model).toBe('claude-opus-5-5');
    expect(taskModel(d, 'clusters').model).toBe('claude-opus-5-5');
    expect(taskModel(d, 'emailScore').model).toBe('claude-haiku-5-5');
  });

  it('每月估算（典型用量）：全用主模型 $7.81 → 默认分档 $3.69 → 全部省钱模型 $0.19', () => {
    const tasks = ['intent', 'clusters', 'daily', 'weekly', 'hotspots', 'emailScore', 'emailVerdict'] as const;
    const total = (s: ReturnType<typeof mergeSettings>) => tasks.reduce((n, t) => n + taskMonthlyUsd(s, t), 0);
    expect(total(mergeSettings({ llm: { economyModels: { anthropic: '' } } }))).toBeCloseTo(7.81, 1);
    expect(total(mergeSettings(undefined))).toBeCloseTo(3.69, 1);
    expect(total(mergeSettings({ llm: { taskTiers: { intent: 'economy', clusters: 'economy' } } }))).toBeCloseTo(0.19, 1);
  });

  it('默认档位下，后台和批量任务比全用主模型省 90% 以上（典型用量估算）', () => {
    const economy = mergeSettings(undefined);
    const allMain = mergeSettings({ llm: { economyModels: { anthropic: '' } } });
    const tasks = ['daily', 'weekly', 'hotspots', 'emailScore', 'emailVerdict'] as const;
    const sum = (s: typeof economy) => tasks.reduce((n, t) => n + taskMonthlyUsd(s, t), 0);
    expect(sum(economy)).toBeLessThan(sum(allMain) * 0.1);
  });
});

describe('理解口令的缓存', () => {
  const intentReply = { interpretation: 'x', topic: 'AI', queries: [{ q: 'AI', language: '' }], constraints: [] };
  function setup(seed: Record<string, unknown> = {}) {
    let calls = 0;
    let now = NOW;
    const ctx: AppContext = {
      ...ctxWith(async () => (calls++, anthropicOk(undefined, 'end_turn', JSON.stringify(intentReply))), seed),
      now: () => now,
    };
    return { ctx, calls: () => calls, setNow: (t: number) => (now = t) };
  }

  it('命中时标注缓存；过期、点"重新理解"都重新调用', async () => {
    const t = setup();
    expect((await parseUtterance(t.ctx, '找 AI')).cachedAt).toBeUndefined();
    expect((await parseUtterance(t.ctx, '找 AI')).cachedAt).toBe(NOW);
    expect(t.calls()).toBe(1);
    await parseUtterance(t.ctx, '找 AI', { fresh: true });
    expect(t.calls()).toBe(2);
    t.setNow(NOW + 31 * 60_000);
    await parseUtterance(t.ctx, '找 AI');
    expect(t.calls()).toBe(3);
  });

  it('多了一条纠正、兴趣簇变了：不用旧的理解', async () => {
    const t = setup();
    await parseUtterance(t.ctx, '找 AI');
    await stores.corrections.write(t.ctx.kv, [{ id: 'u1', at: NOW, utterance: '找 AI', note: '', active: true }]);
    await parseUtterance(t.ctx, '找 AI');
    expect(t.calls()).toBe(2);
    await stores.clusters.write(t.ctx.kv, { clusters: [cluster('k1', '新兴趣')] });
    await parseUtterance(t.ctx, '找 AI');
    expect(t.calls()).toBe(3);
  });
});

describe('X 账本', () => {
  it('预扣在同一把锁里算预算：并发的两路不会都以为还有钱', () => {
    let l: XLedger = { days: {} };
    const a = reserveXRead(l, 0.08, 0.8, 10, 'a', NOW);
    expect(a.plan).toEqual({ ok: true, maxResults: 10 });
    l = a.ledger;
    const b = reserveXRead(l, 0.08, 0.8, 10, 'b', NOW);
    expect(b.plan.ok).toBe(false);
    expect(xSnapshot(l, 0.08, 0.8, NOW).heldUsd).toBeCloseTo(0.05);
  });

  it('读到了按实际新帖子结算；被拒绝的退回；不知道的记成未确认', () => {
    const l = reserveXRead({ days: {} }, 1, 0.8, 10, 'a', NOW).ledger;
    const settled = settleXRead(l, 'a', ['1', '2'], 'search', NOW).ledger;
    expect(xSnapshot(settled, 1, 0.8, NOW)).toMatchObject({ spentUsd: 0.01, heldUsd: 0 });
    expect(xSnapshot(releaseXHold(l, 'a'), 1, 0.8, NOW).remainingUsd).toBe(1);
    expect(xSnapshot(abandonXHold(l, 'a'), 1, 0.8, NOW)).toMatchObject({ unconfirmedUsd: 0.05, remainingUsd: 0.95 });
  });
});

describe('X 热点的花费边界', () => {
  const clusters = { clusters: [cluster('k1', 'AI'), cluster('k2', '编程')] };
  const hotspotReply = (req: { user: string }) => {
    const refs = [...req.user.matchAll(/^(p\d+) \|/gm)].map((m) => m[1]!);
    return { hotspots: refs.slice(0, 5).map((r, i) => ({ title: `热点 ${i}`, summary: 's', refs: [r], utterance: `找热点 ${i}` })) };
  };
  function setup(opts: { seed?: Record<string, unknown>; wrap?: (f: typeof fetch) => typeof fetch; ids?: () => string[]; status?: number } = {}) {
    let n = 0;
    const api = createFakeApi({
      now: NOW,
      llm: hotspotReply,
      videos: [] as FakeVideo[],
      search: () => [],
      xSearch: () => {
        n++;
        if (opts.status) return { status: opts.status };
        const ids = opts.ids?.() ?? Array.from({ length: 10 }, (_, i) => `${n}-${i}`);
        return { posts: ids.map((id) => ({ id, text: `post ${id}`, likes: 5, reposts: 1, hoursAgo: 1 })) };
      },
    });
    const ctx = ctxWith(opts.wrap ? opts.wrap(api.fetch) : api.fetch, { clusters, ...opts.seed });
    return { ctx, api, xRequests: () => api.requests.filter((r) => r.url.startsWith(ENDPOINTS.x)), llmRequests: () => api.requests.filter((r) => r.url.startsWith(ENDPOINTS.anthropic)) };
  }

  it('只要帖子本身：不发 expansions、user.fields、media.fields（2026-11-22 起这些都单独计费）', async () => {
    const t = setup();
    await refreshHotspots(t.ctx);
    const urls = t.xRequests().map((r) => new URL(r.url));
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect([...u.searchParams.keys()].sort()).toEqual(['max_results', 'post.fields', 'query', 'sort_order', 'start_time']);
      expect(u.searchParams.get('post.fields')).toBe('created_at,public_metrics,lang');
    }
  });

  it('默认不自动花钱；一次刷新在 X 上最多 $0.20', () => {
    const s = mergeSettings(undefined);
    expect(s.x.autoRefresh).toBe(false);
    expect(xRefreshMaxUsd(s)).toBeCloseTo(0.2);
  });

  it('大模型预算不够：一条帖子都不读', async () => {
    const t = setup({ seed: { settings: { llm: { dailyBudgetUsd: 0.0001 } } } });
    await expect(refreshHotspots(t.ctx)).rejects.toMatchObject({ kind: 'llm_budget' });
    expect(t.xRequests()).toHaveLength(0);
    expect((await xSpend(t.ctx)).spentUsd).toBe(0);
  });

  it('200 但响应读不出来：不当成读到 0 条，按最坏情况记账', async () => {
    const t = setup({
      wrap: (f) => async (input, init) => (String(input).startsWith(ENDPOINTS.x) ? new Response('<html>oops', { status: 200 }) : f(input, init)),
    });
    await expect(refreshHotspots(t.ctx)).rejects.toMatchObject({ kind: 'x', billing: { state: 'unknown' } });
    expect((await xSpend(t.ctx)).unconfirmedUsd).toBeCloseTo(0.05);
  });

  it('X 拒绝（429）：没有计费，退回预扣', async () => {
    const t = setup({ status: 429 });
    await expect(refreshHotspots(t.ctx)).rejects.toMatchObject({ kind: 'x' });
    const s = await xSpend(t.ctx);
    expect(s.spentUsd + s.unconfirmedUsd + s.heldUsd).toBe(0);
  });

  it('读到的帖子和上次一样：沿用上次的整理结果，不再付大模型的钱', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `same-${i}`);
    const t = setup({ ids: () => ids });
    await refreshHotspots(t.ctx);
    const before = t.llmRequests().length;
    const r = await refreshHotspots(t.ctx, { force: true });
    expect(t.llmRequests()).toHaveLength(before);
    expect(r.state.items.length).toBeGreaterThan(0);
    expect(r.state.notes.join()).toContain('没有再调大模型');
  });

  it('草稿过了缓存时间就作废，重新读', async () => {
    const t = setup();
    await stores.hotspotDraft.write(t.ctx.kv, { at: NOW - 7 * 3_600_000, topics: ['旧'], posts: [], spentUsd: 0, partial: false, notes: [] });
    await refreshHotspots(t.ctx);
    expect(t.xRequests().length).toBeGreaterThan(0);
    expect(await stores.hotspotDraft.read(t.ctx.kv)).toBeNull();
  });
});

describe('旧设置迁移', () => {
  it('旧版存下的自动刷新回到关闭，默认的 15 条换成 10 条', () => {
    const s = mergeSettings({ x: { autoRefresh: true, postsPerTopic: 15, dailyBudgetUsd: 1 } });
    expect(s.x).toMatchObject({ autoRefresh: false, postsPerTopic: 10, dailyBudgetUsd: 1, defaultsVersion: 2 });
  });

  it('你自己改过的条数不动；迁移之后再打开自动刷新不会被改回去', () => {
    expect(mergeSettings({ x: { postsPerTopic: 30 } }).x.postsPerTopic).toBe(30);
    expect(mergeSettings({ x: { autoRefresh: true, postsPerTopic: 15, defaultsVersion: 2 } }).x).toMatchObject({ autoRefresh: true, postsPerTopic: 15 });
  });

  it('大模型新增的设置有默认值，旧设置不丢', () => {
    const s = mergeSettings({ llm: { provider: 'openai', models: { openai: 'gpt-x' } } });
    expect(s.llm).toMatchObject({ provider: 'openai', dailyBudgetUsd: DEFAULT_SETTINGS.llm.dailyBudgetUsd, economyModels: { openai: 'gpt-6-luna' }, taskTiers: {} });
    expect(s.llm.models.openai).toBe('gpt-x');
  });
});

describe('例行任务的失败重试', () => {
  const TOMORROW = NOW + 3_600_000;

  it('钱花了结果不能用：再试一次就停', () => {
    expect(nextJobRetry({ kind: 'llm', billed: true, attempts: 1 }, NOW, TOMORROW)).toEqual({ nextRetryAt: NOW + JOB_RETRY.baseDelayMs });
    expect(nextJobRetry({ kind: 'llm', billed: true, attempts: 2 }, NOW, TOMORROW)).toEqual({ gaveUp: true });
  });

  it('没计费的失败隔得越来越久，最多一天', () => {
    expect(nextJobRetry({ kind: 'network', billed: false, attempts: 1 }, NOW, TOMORROW).nextRetryAt).toBe(NOW + JOB_RETRY.baseDelayMs);
    expect(nextJobRetry({ kind: 'network', billed: false, attempts: 2 }, NOW, TOMORROW).nextRetryAt).toBe(NOW + 2 * JOB_RETRY.baseDelayMs);
    expect(nextJobRetry({ kind: 'network', billed: false, attempts: 30 }, NOW, TOMORROW).nextRetryAt).toBe(NOW + JOB_RETRY.maxDelayMs);
  });

  it('到了每日预算等明天；没填 Key 不花钱，下一次检查就再试', () => {
    expect(nextJobRetry({ kind: 'llm_budget', billed: false, attempts: 5 }, NOW, TOMORROW)).toEqual({ nextRetryAt: TOMORROW });
    expect(nextJobRetry({ kind: 'llm_key', billed: false, attempts: 5 }, NOW, TOMORROW)).toEqual({});
  });

  it('到点判定', () => {
    expect(jobRetryDue(undefined, NOW)).toBe(true);
    expect(jobRetryDue({ nextRetryAt: NOW + 1 }, NOW)).toBe(false);
    expect(jobRetryDue({ nextRetryAt: NOW }, NOW)).toBe(true);
    expect(jobRetryDue({ gaveUp: true }, NOW + 1e9)).toBe(false);
    expect(jobRetryDue({}, NOW)).toBe(true);
  });

  it('到达预算上限的总结：记下原因，明天再试，手动成功后清掉', async () => {
    const replies = { n: 0 };
    let now = NOW;
    const api = createFakeApi({
      llm: () => (replies.n++, { headline: 'h', learned: [], revisit: [], goalLink: '' }),
      videos: [{ id: 'vidLearn0001', title: 't', channelId: 'UC1', channelTitle: 'c', publishedAt: '2026-10-20T00:00:00Z', duration: 'PT10M', views: 1, likes: 1 }],
      search: () => [],
    });
    const ctx: AppContext = { ...ctxWith(api.fetch, { settings: { llm: { dailyBudgetUsd: 0.000001 } } }), now: () => now };
    const day = '2026-10-23';
    await stores.watchLog.write(ctx.kv, { [day]: { vidLearn0001: { videoId: 'vidLearn0001', day, playSec: 600, completion: 1, status: 'completed', firstAt: NOW, lastAt: NOW, durationSec: 600, background: false, shorts: false, sessions: 1 } as never } });
    await stores.jobState.write(ctx.kv, { failures: {}, firstDay: '2026-10-20' });
    await runScheduledJobs(ctx);
    const f = (await stores.jobState.read(ctx.kv)).failures[`daily:${day}`]!;
    expect(f.message).toContain('预算');
    expect(f.nextRetryAt).toBeGreaterThan(NOW);
    now = NOW + 60_000;
    await runScheduledJobs(ctx);
    expect((await stores.jobState.read(ctx.kv)).failures[`daily:${day}`]!.attempts).toBe(1);
    await stores.settings.update(ctx.kv, ctx.locker, (s) => ({ ...s, llm: { ...s.llm, dailyBudgetUsd: 1 } }));
    await generateDailySummary(ctx, day, { manual: true });
    expect((await stores.jobState.read(ctx.kv)).failures[`daily:${day}`]).toBeUndefined();
  });

  it('force：观看记录没变也重新生成（你明确要的）', async () => {
    let n = 0;
    const api = createFakeApi({ llm: () => (n++, { headline: 'h', learned: [], revisit: [], goalLink: '' }), videos: [], search: () => [] });
    const ctx = ctxWith(api.fetch);
    const day = '2026-10-23';
    await stores.watchLog.write(ctx.kv, { [day]: { vidLearn0001: { videoId: 'vidLearn0001', day, playSec: 600, completion: 1, status: 'completed', firstAt: NOW, lastAt: NOW, durationSec: 600, background: false, shorts: false, sessions: 1 } as never } });
    await stores.videoMeta.write(ctx.kv, { vidLearn0001: { id: 'vidLearn0001', title: 't', channelId: 'c', channelTitle: 'c', durationSec: 600, tags: [], fetchedAt: NOW } });
    await generateDailySummary(ctx, day, { manual: true });
    await generateDailySummary(ctx, day, { manual: true });
    expect(n).toBe(1);
    await generateDailySummary(ctx, day, { manual: true, force: true });
    expect(n).toBe(2);
  });
});

describe('新博主发现：search 不因为后面一步失败白花', () => {
  it('读频道详情失败后再跑：直接用搜到的结果', async () => {
    let failChannels = true;
    const api = createFakeApi({
      llm: () => ({}),
      videos: [{ id: 'v1', title: 't', channelId: 'UCnew', channelTitle: 'c', publishedAt: new Date(NOW - 86_400_000).toISOString(), duration: 'PT10M', views: 1, likes: 1 }],
      search: () => ['v1'],
    });
    const http: typeof fetch = async (input, init) => {
      if (failChannels && String(input).includes('/channels?')) return json(500, { error: { code: 500, message: 'x' } });
      return api.fetch(input, init);
    };
    const ctx = ctxWith(http, { clusters: { clusters: [cluster('k1', 'AI'), cluster('k2', '编程')] }, profile: { syncedAt: NOW, subscriptions: [], likedVideos: [], likedChannels: [] } });
    await expect(runDiscovery(ctx)).rejects.toMatchObject({ kind: 'youtube' });
    const searches = () => api.requests.filter((r) => r.url.includes('/search?')).length;
    expect(searches()).toBe(2);
    failChannels = false;
    const week = await runDiscovery(ctx);
    expect(searches()).toBe(2);
    expect(week.searchCalls).toBe(2);
    expect(week.generatedAt).toBeDefined();
    expect(week.pending).toBeUndefined();
  });
});

describe('字幕翻译：默认用 Chrome 本地翻译，不花钱', () => {
  const VID = '3wP2VCoz3KM';
  const cue = { id: `${VID}:1000`, start: 1, end: 2, text: 'Where was I?', lang: 'en-US', createdAt: NOW };
  const local = (fn: LocalTranslator['translate']): LocalTranslator => ({ availability: async () => 'available', translate: fn, prepare: async () => ({ ready: 0, failed: [] }) });

  it('本地翻译：不发任何大模型请求，不记花费', async () => {
    let calls = 0;
    const seen: unknown[] = [];
    const ctx = ctxWith(async () => (calls++, anthropicOk()), {}, local(async (pair, text) => (seen.push([pair, text]), '我说到哪了？')));
    const out = await translateCue(ctx, VID, cue);
    expect(out).toMatchObject({ translation: '我说到哪了？', translationLang: 'zh-CN' });
    expect(out.translationError).toBeUndefined();
    expect(seen).toEqual([[{ source: 'en', target: 'zh' }, 'Where was I?']]);
    expect(calls).toBe(0);
    expect((await subtitleSpend(ctx)).spentUsd).toBe(0);
  });

  it('语言包没下载：说明怎么办，不悄悄改用收费的大模型', async () => {
    let calls = 0;
    const ctx = ctxWith(async () => (calls++, anthropicOk()), {}, local(async () => {
      throw new LocalTranslateError('need_download', '还没下载 en → zh 的语言包');
    }));
    const out = await translateCue(ctx, VID, cue);
    expect(out.translation).toBeUndefined();
    expect(out.translationError).toContain('语言包');
    expect(calls).toBe(0);
  });

  it('浏览器没有本地翻译：同样说明，不花钱', async () => {
    let calls = 0;
    const ctx = ctxWith(async () => (calls++, anthropicOk()));
    expect((await translateCue(ctx, VID, cue)).translationError).toContain('Chrome 138');
    expect(calls).toBe(0);
  });

  it('语言对：繁体、按文字判断、拉丁字母按英文；下载时覆盖常见原文语言', () => {
    expect(localTranslatePair('zh-TW', '你好', 'en')).toEqual({ source: 'zh-Hant', target: 'en' });
    expect(localTranslatePair(undefined, '你好世界', 'en')).toEqual({ source: 'zh', target: 'en' });
    expect(localTranslatePair(undefined, 'hello', 'zh-TW')).toEqual({ source: 'en', target: 'zh-Hant' });
    expect(localPreparePairs('zh-CN', 'en')).toEqual([
      { source: 'en', target: 'zh' },
      { source: 'ja', target: 'zh' },
      { source: 'ko', target: 'zh' },
      { source: 'zh', target: 'en' },
    ]);
  });

  it('语言包没下载时不碰 create（实测它在后台会一直挂着）；不支持的语言对说明原因', async () => {
    const g = globalThis as { Translator?: unknown };
    let creates = 0;
    const api = (status: string) => ({
      availability: async () => status,
      create: () => {
        creates++;
        return new Promise(() => {}); // 与 Chromium 156 的 service worker 里一样：不成功也不报错
      },
    });
    try {
      g.Translator = api('downloadable');
      await expect(chromeLocalTranslator()!.translate({ source: 'en', target: 'zh' }, 'hi')).rejects.toMatchObject({ reason: 'need_download' });
      g.Translator = api('downloading');
      await expect(chromeLocalTranslator()!.translate({ source: 'en', target: 'zh' }, 'hi')).rejects.toMatchObject({ reason: 'need_download' });
      g.Translator = api('unavailable');
      await expect(chromeLocalTranslator()!.translate({ source: 'en', target: 'tlh' }, 'hi')).rejects.toMatchObject({ reason: 'unsupported' });
      expect(creates).toBe(0);
      g.Translator = { availability: async () => 'available', create: async () => ({ translate: async (t: string) => `译：${t}` }) };
      const t = chromeLocalTranslator()!;
      expect(await t.translate({ source: 'en', target: 'zh' }, 'hi')).toBe('译：hi');
      expect(await t.prepare([{ source: 'en', target: 'zh' }])).toEqual({ ready: 1, failed: [] });
    } finally {
      delete g.Translator;
    }
    expect(chromeLocalTranslator()).toBeUndefined();
  });
});

describe('字幕的付费路径', () => {
  const VID = '3wP2VCoz3KM';
  const wav = encodeWav(new Float32Array(16_000), 16_000);
  const openaiEngine = { settings: { subtitles: { asrEngine: 'openai', translationEngine: 'llm' } } };

  it('转写请求断了：按预扣额记成未确认，预算绕不过去', async () => {
    const ctx = ctxWith(async () => {
      throw new TypeError('Failed to fetch');
    }, openaiEngine);
    await expect(transcribeSegment(ctx, { videoId: VID, start: 1, end: 2, wav })).rejects.toMatchObject({ kind: 'network' });
    const ledger = await stores.subtitleLedger.read(ctx.kv);
    const snap = subtitleSnapshot(ledger, 1, 0.8, DAY_KEY, NOW);
    expect(snap.unconfirmedUsd).toBeGreaterThan(0);
    expect(snap.remainingUsd).toBeLessThan(1);
  });

  it('转写被拒绝（401）：没有计费，退回预扣', async () => {
    const ctx = ctxWith(async () => json(401, { error: { message: 'bad key' } }), openaiEngine);
    await expect(transcribeSegment(ctx, { videoId: VID, start: 1, end: 2, wav })).rejects.toMatchObject({ kind: 'llm_key' });
    const snap = subtitleSnapshot(await stores.subtitleLedger.read(ctx.kv), 1, 0.8, DAY_KEY, NOW);
    expect(snap.remainingUsd).toBe(1);
  });

  it('翻译结果不能用：按用量记账，第二行写明原因', async () => {
    const ctx = ctxWith(async () => anthropicOk({ input_tokens: 500, output_tokens: 1200 }, 'max_tokens'), openaiEngine);
    const cue = await saveTextCue(ctx, { videoId: VID, start: 1, end: 2, text: 'Where was I?', lang: 'en-US' });
    const out = await translateCue(ctx, VID, cue!);
    expect(out.translationError).toContain('截断');
    expect((await subtitleSpend(ctx)).spentUsd).toBeGreaterThan(0);
  });

  it('多个请求同时在途：预扣写在账本里，守得住每日预算', async () => {
    let release: (r: Response) => void = () => {};
    const pending = new Promise<Response>((r) => (release = r));
    const ctx = ctxWith(() => pending, { settings: { subtitles: { asrEngine: 'openai', translationEngine: 'llm', dailyBudgetUsd: 0.00004 } } });
    const first = transcribeSegment(ctx, { videoId: VID, start: 1, end: 2, wav }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20));
    await expect(transcribeSegment(ctx, { videoId: VID, start: 3, end: 4, wav })).rejects.toMatchObject({ kind: 'subtitles_budget' });
    release(json(401, { error: { message: 'x' } }));
    await first;
  });
});
