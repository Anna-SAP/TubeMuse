// 花钱场景的回归与对比：同一份脚本可以在任何版本上跑（设了 COST_REPORT 时把结果写成 JSON，不做断言），
// 用来比较改动前后的"发了几次付费请求、记了多少账"。没设时断言当前版本的结果。全程用假服务，不出网。

import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../../src/config/endpoints';
import type { EmailArticle } from '../../src/core/email';
import type { InterestCluster } from '../../src/core/types';
import type { AuthProvider } from '../../src/services/auth';
import type { AppContext } from '../../src/services/context';
import { scoreArticles } from '../../src/services/email-service';
import { refreshHotspots, xSpend } from '../../src/services/hotspot-service';
import { parseUtterance } from '../../src/services/intent-service';
import { stores } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';
import { generateDailySummary, generateWeeklyReport, runScheduledJobs } from '../../src/services/summary-service';
import { ingestSession } from '../../src/services/watch-service';
import { createFakeApi, type FakeVideo } from './fake-api';
import { fakeSecret } from './fake-secrets';

const NOW = Date.parse('2026-10-24T02:00:00Z'); // 北京时间 10:00
const HOUR = 3_600_000;
const COMPARE = !!process.env.COST_REPORT;
const report: Record<string, unknown> = {};
const asserted = (fn: () => void) => {
  if (!COMPARE) fn();
};

afterAll(() => {
  if (COMPARE) writeFileSync(process.env.COST_REPORT!, JSON.stringify(report, null, 2));
});

const VIDEOS: FakeVideo[] = [
  { id: 'vidLearn0001', title: 'Transformer 原理讲解', channelId: 'UClearn01', channelTitle: '学习频道', publishedAt: '2026-10-20T00:00:00Z', duration: 'PT10M', views: 1, likes: 1, categoryId: '27' },
];

const cluster = (id: string, name: string, keywords: string[]): InterestCluster => ({ id, name, description: '', keywords, channelIds: [], weight: 1, locked: false, source: 'llm', updatedAt: NOW });

type LlmReply = (req: { system: string; user: string; provider: 'anthropic' | 'openai' }) => unknown;

function setup(opts: { llm?: LlmReply; xSearch?: Parameters<typeof createFakeApi>[0]['xSearch']; llmKey?: boolean; wrapHttp?: (f: typeof fetch) => typeof fetch } = {}) {
  let xCalls = 0;
  const api = createFakeApi({
    now: NOW,
    llm: opts.llm ?? (() => ({})),
    videos: VIDEOS,
    search: () => [],
    xSearch:
      opts.xSearch ??
      (() => {
        xCalls++;
        return { posts: Array.from({ length: 30 }, (_, i) => ({ id: `${xCalls}${String(i).padStart(4, '0')}`, text: `post ${i}`, likes: 100 - i, reposts: 10, hoursAgo: 2 })) };
      }),
  });
  let now = NOW;
  const auth: AuthProvider = { configured: () => true, getToken: async () => fakeSecret('ya29.', 'fake-token-for-tests-1234567'), invalidate: async () => {}, status: async () => 'connected', disconnect: async () => ({ revoked: false }) };
  const ctx: AppContext = {
    kv: memoryKV({
      secrets: { ...(opts.llmKey === false ? {} : { anthropicApiKey: fakeSecret('sk-ant-', 'test-0123456789abcdefghijklmn') }), xBearerToken: 'AAAAFakeXBearerTokenForTests0123456789' },
      clusters: { clusters: [cluster('k1', 'AI', ['AI', 'LLM']), cluster('k2', '编程', ['programming', '编程'])] },
    }),
    locker: memoryLocker(),
    http: opts.wrapHttp ? opts.wrapHttp(api.fetch) : api.fetch,
    now: () => now,
    auth,
    endpoints: ENDPOINTS,
    timeZone: 'Asia/Shanghai',
  };
  const count = (base: string) => api.requests.filter((r) => r.url.startsWith(base)).length;
  return { ctx, api, setNow: (t: number) => (now = t), llmRequests: () => count(ENDPOINTS.anthropic), xRequests: () => count(ENDPOINTS.x) };
}

async function watch(ctx: AppContext, startedAt: number, id = 's1'): Promise<void> {
  await ingestSession(ctx, { id, videoId: 'vidLearn0001', startedAt, updatedAt: startedAt + 600_000, durationSec: 600, intervals: [[0, 600]], playSec: 600, fgSec: 600, bgSec: 0, adSec: 0, shorts: false });
}

const HOTSPOTS: LlmReply = (req) => {
  const refs = [...req.user.matchAll(/^(p\d+) \|/gm)].map((m) => m[1]!);
  return { hotspots: refs.slice(0, 6).map((r, i) => ({ title: `热点 ${i + 1}`, summary: '发生了什么', refs: [r], utterance: `找讲解热点 ${i + 1} 的视频` })) };
};

const models = (api: ReturnType<typeof createFakeApi>) =>
  api.requests
    .filter((r) => r.url.startsWith(ENDPOINTS.anthropic))
    .map((r) => JSON.parse(r.body ?? '{}') as { model: string; max_tokens: number })
    .map((b) => ({ model: b.model, max_tokens: b.max_tokens }));

describe('后台例行任务', () => {
  it('大模型一直返回坏结果：一天 48 次检查，不会每次都重新花钱', async () => {
    const t = setup({ llm: () => ({ nonsense: true }) });
    await watch(t.ctx, NOW - 24 * HOUR);
    for (let i = 0; i < 48; i++) {
      t.setNow(NOW + i * 30 * 60_000);
      await runScheduledJobs(t.ctx);
    }
    report.badOutput48Ticks = { llmRequests: t.llmRequests() };
    asserted(() => expect(t.llmRequests()).toBe(2));
    const failure = Object.values((await stores.jobState.read(t.ctx.kv)).failures)[0];
    asserted(() => expect(failure?.message).toBeTruthy());
  });

  it('手动生成后没有新观看：到点不再重新生成；连点三次也只花一次钱', async () => {
    const t = setup({ llm: () => ({ headline: '今天', learned: [{ ref: 'v1', takeaway: '学到了' }], revisit: [], goalLink: '' }) });
    await watch(t.ctx, NOW - HOUR);
    for (let i = 0; i < 3; i++) await generateDailySummary(t.ctx, '2026-10-24', { manual: true });
    t.setNow(Date.parse('2026-10-24T15:30:00Z')); // 北京时间 23:30，已过总结时刻
    await runScheduledJobs(t.ctx);
    report.summaryNoNewData = { llmRequests: t.llmRequests() };
    asserted(() => expect(t.llmRequests()).toBe(1));
  });

  it('本周只有一个低分：一个案例看不出共性，不调大模型', async () => {
    const t = setup({ llm: () => ({ overview: '', patterns: [] }) });
    await stores.ratings.write(t.ctx.kv, { v1: { videoId: 'v1', rating: 2, searchId: 's', utterance: 'u', at: NOW - HOUR, attribution: 'retrieval', video: { title: 't', channelId: 'c', channelTitle: 'ct' } } });
    await generateWeeklyReport(t.ctx, '2026-10-24');
    report.weeklySingleCase = { llmRequests: t.llmRequests() };
    asserted(() => expect(t.llmRequests()).toBe(0));
  });
});

describe('X 热点', () => {
  it('没填大模型 Key：一条帖子都不读', async () => {
    const t = setup({ llmKey: false });
    await refreshHotspots(t.ctx).catch(() => undefined);
    report.hotspotsNoLlmKey = { xRequests: t.xRequests(), xSpentUsd: (await xSpend(t.ctx)).spentUsd };
    asserted(() => expect(t.xRequests()).toBe(0));
  });

  it('大模型失败三次再成功：帖子只读一遍，三次重试不再花 X 的钱', async () => {
    let ok = false;
    const t = setup({ llm: (req) => (ok ? HOTSPOTS(req) : { hotspots: 'broken' }) });
    for (let i = 0; i < 3; i++) await refreshHotspots(t.ctx, { force: true }).catch(() => undefined);
    ok = true;
    const r = await refreshHotspots(t.ctx, { force: true });
    report.hotspotsLlmRetry = { xRequests: t.xRequests(), xSpentUsd: (await xSpend(t.ctx)).spentUsd, items: r.state.items.length };
    asserted(() => {
      expect(t.xRequests()).toBe(2); // 两个主题各一次
      expect(r.state.items.length).toBeGreaterThan(0);
    });
  });

  it('第二个主题被限流：第一个主题已经付过钱的帖子照常整理，不丢', async () => {
    let calls = 0;
    const t = setup({
      llm: HOTSPOTS,
      xSearch: () => {
        calls++;
        return calls === 2 ? { status: 429 } : { posts: Array.from({ length: 15 }, (_, i) => ({ id: `${calls}-${i}`, text: `post ${i}`, likes: 9, reposts: 1, hoursAgo: 1 })) };
      },
    });
    const r = await refreshHotspots(t.ctx).catch(() => undefined);
    report.hotspotsPartialFailure = { xRequests: t.xRequests(), items: r?.state.items.length ?? 0, savedState: !!(await stores.hotspots.read(t.ctx.kv)) };
    asserted(() => expect(r?.state.items.length).toBeGreaterThan(0));
  });

  it('响应在路上丢了（X 已计费）：账上按最坏情况记着，预算绕不过去', async () => {
    const t = setup({
      wrapHttp: (f) => async (input, init) => {
        const res = await f(input, init);
        if (String(input).startsWith(ENDPOINTS.x)) throw new TypeError('Failed to fetch');
        return res;
      },
    });
    await refreshHotspots(t.ctx).catch(() => undefined);
    const spent = await xSpend(t.ctx);
    report.xResponseLost = { xRequests: t.xRequests(), committedUsd: spent.spentUsd + spent.unconfirmedUsd };
    asserted(() => expect(report.xResponseLost).toMatchObject({ committedUsd: 0.05 }));
  });
});

describe('大模型', () => {
  it('同一句口令 30 分钟内重复提交：只调一次大模型', async () => {
    const t = setup({ llm: () => ({ interpretation: '找 AI 视频', topic: 'AI', queries: [{ q: 'AI', language: '' }], constraints: [] }) });
    for (let i = 0; i < 5; i++) {
      t.setNow(NOW + i * 60_000);
      await parseUtterance(t.ctx, '帮我找 AI 视频');
    }
    report.repeatUtterance = { llmRequests: t.llmRequests() };
    asserted(() => expect(t.llmRequests()).toBe(1));
  });

  it('后台和批量任务用便宜模型，每次请求有输出上限', async () => {
    const t = setup({ llm: (req) => (req.system.includes('学习记录助手') ? { headline: 'h', learned: [], revisit: [], goalLink: '' } : req.system.includes('热点编辑') ? HOTSPOTS(req) : { scores: [], summary: '', whyNone: '' }) });
    await watch(t.ctx, NOW - HOUR);
    await generateDailySummary(t.ctx, '2026-10-24', { manual: true });
    await refreshHotspots(t.ctx);
    const article: EmailArticle = { id: 'a1', title: 'A long read', url: 'https://medium.com/a', site: 'medium.com' };
    await scoreArticles(t.ctx, [article]);
    const sent = models(t.api);
    report.models = sent;
    asserted(() => {
      expect(new Set(sent.map((s) => s.model))).toEqual(new Set(['claude-haiku-5-5']));
      expect(sent.every((s) => s.max_tokens < 16_000)).toBe(true);
    });
  });
});
