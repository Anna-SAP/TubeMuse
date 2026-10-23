// Phase 3：X 热点（预算护栏、去重计费、缓存、原文链接、一键口令）与新博主发现（≤5 个、≤8 次 search、有理由、只打开不订阅）。

import { describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../../src/config/endpoints';
import { X_API } from '../../src/config/defaults';
import { assembleHotspots, chooseTopics, selectCandidates, topicQuery } from '../../src/core/hotspots';
import { planPostRead, recordPostRead, xSnapshot, markXBlocked, clearXBlocked, utcDay } from '../../src/core/x-budget';
import { aggregateHits, discoveryQueries, filterCandidates, scoreCandidates } from '../../src/core/discovery';
import type { AppContext } from '../../src/services/context';
import type { AuthProvider } from '../../src/services/auth';
import { memoryKV, memoryLocker } from '../../src/services/storage';
import { stores } from '../../src/services/repo';
import { refreshHotspots, xSpend } from '../../src/services/hotspot-service';
import { dismissCreator, runDiscovery } from '../../src/services/discovery-service';
import type { InterestCluster, XPost } from '../../src/core/types';
import { createFakeApi, type FakeVideo } from './fake-api';

const NOW = Date.parse('2026-10-24T02:00:00Z');
const DAY = 86_400_000;
const KEY = 'sk-ant-test-0123456789abcdefghijklmn';
const XTOKEN = 'AAAAAAAAAAAAAAAAAAAAAFakeXBearerTokenForTests0123456789';

const cluster = (over: Partial<InterestCluster>): InterestCluster => ({
  id: 'k',
  name: 'AI',
  description: '',
  keywords: ['LLM', '大模型'],
  channelIds: [],
  weight: 1,
  locked: false,
  source: 'llm',
  updatedAt: NOW,
  ...over,
});

describe('X 记账：按返回条数计费、同一 UTC 日去重、超预算即停', () => {
  it('同一帖子当天第二次读取不计费；跨 UTC 日重新计', () => {
    let l = { days: {} };
    let r = recordPostRead(l, ['a', 'b', 'c'], 'search', NOW);
    expect(r.costUsd).toBeCloseTo(0.015);
    l = r.ledger;
    r = recordPostRead(l, ['b', 'c', 'd'], 'search', NOW + 1000);
    expect(r.costUsd).toBeCloseTo(0.005);
    l = r.ledger;
    r = recordPostRead(l, ['a'], 'search', NOW + DAY);
    expect(r.costUsd).toBeCloseTo(0.005);
    expect(xSnapshot(r.ledger, 0.5, 0.8, NOW).spentUsd).toBeCloseTo(0.02);
  });

  it('按剩余预算缩小 max_results；不够 10 条（$0.05）就不发请求', () => {
    const ids = Array.from({ length: 90 }, (_, i) => `p${i}`);
    const l = recordPostRead({ days: {} }, ids, 'search', NOW).ledger; // 已花 $0.45
    const snap = xSnapshot(l, 0.5, 0.8, NOW);
    expect(snap.warn).toBe(true);
    expect(planPostRead(snap, 15)).toEqual({ ok: true, maxResults: 10 });
    const l2 = recordPostRead(l, ['x1', 'x2'], 'search', NOW).ledger; // $0.46
    const p = planPostRead(xSnapshot(l2, 0.5, 0.8, NOW), 15);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain('已停止调用');
  });

  it('X 官方拒绝（余额/上限）后当天停止，可手动解除', () => {
    const l = markXBlocked({ days: {} }, '余额不足', NOW);
    expect(planPostRead(xSnapshot(l, 0.5, 0.8, NOW), 15).ok).toBe(false);
    expect(planPostRead(xSnapshot(clearXBlocked(l, NOW), 0.5, 0.8, NOW), 15).ok).toBe(true);
    expect(utcDay(NOW)).toBe('2026-10-24');
  });
});

describe('X 热点：检索式与候选', () => {
  it('检索式：关键词取或、排除转发与回复、不超过 512 字符', () => {
    const q = topicQuery('AI', ['LLM', 'large language model', '大模型', ...Array.from({ length: 80 }, (_, i) => `keyword${i}longlonglong`)])!;
    expect(q.query).toContain('"large language model"');
    expect(q.query).toContain('-is:retweet -is:reply');
    expect(q.query.length).toBeLessThanOrEqual(X_API.maxQueryChars);
  });
  it('主题按兴趣簇权重选，最多 maxTopics 个', () => {
    const ts = chooseTopics([cluster({ name: '低', weight: 0.5 }), cluster({ name: '高', weight: 1.8 }), cluster({ name: '中', weight: 1 })], [], 2);
    expect(ts.map((t) => t.topic)).toEqual(['高', '中']);
  });
  it('候选按互动排序、每个主题限量、去重', () => {
    const p = (id: string, likes: number, topic = 'AI'): XPost => ({ id, text: id, createdAt: new Date(NOW - 3_600_000).toISOString(), likes, reposts: 0, replies: 0, quotes: 0, topic });
    const out = selectCandidates([p('a', 1), p('b', 1000), p('c', 50), p('b', 1000, 'Other')], 2, NOW);
    expect(out.map((x) => x.id)).toEqual(['b', 'c']);
  });
  it('每条热点必须有真实存在的原文；编造的引用被丢弃', () => {
    const refs = new Map([['p1', { id: '111', text: 't', createdAt: new Date(NOW).toISOString(), likes: 5, reposts: 1, replies: 0, quotes: 0, topic: 'AI' } as XPost]]);
    const r = assembleHotspots(
      { hotspots: [{ title: '真', summary: 's', refs: ['p1'], utterance: '找 AI 视频' }, { title: '假', summary: 's', refs: ['p99'], utterance: '找' }] },
      refs,
      8,
      () => 'h',
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.posts[0]!.url).toBe('https://x.com/i/web/status/111');
    expect(r.dropped).toBe(1);
  });
});

function setup(opts: { xToken?: boolean; budget?: number; xStatus?: number } = {}) {
  const xCalls: { query: string; max: number }[] = [];
  const llmCalls: { system: string; user: string }[] = [];
  const videos: FakeVideo[] = [
    ...['A', 'B', 'C', 'D', 'E', 'F', 'G'].flatMap((L, i) =>
      [0, 1, 2].map((j) => ({
        id: `vid${L}${j}xxxxx`,
        title: `${L} 频道的 AI 讲解 ${j}`,
        channelId: `UCnew${L}`,
        channelTitle: `新频道 ${L}`,
        publishedAt: new Date(NOW - (j + 1 + i) * DAY).toISOString(),
        duration: 'PT10M',
        views: 1000,
        likes: 50,
      })),
    ),
    { id: 'vidSubscribed1', title: '已订阅频道的视频', channelId: 'UCsub', channelTitle: '已订阅', publishedAt: new Date(NOW - DAY).toISOString(), duration: 'PT10M', views: 1, likes: 1 },
    { id: 'vidStale00001', title: '不活跃频道的旧视频', channelId: 'UCstale', channelTitle: '不活跃', publishedAt: new Date(NOW - 200 * DAY).toISOString(), duration: 'PT10M', views: 1, likes: 1 },
  ];
  const api = createFakeApi({
    now: NOW,
    llm: (req) => {
      llmCalls.push(req);
      if (req.system.includes('热点编辑')) {
        const refs = [...req.user.matchAll(/^(p\d+) \|/gm)].map((m) => m[1]!);
        return { hotspots: refs.slice(0, 6).map((r, i) => ({ title: `热点 ${i + 1}`, summary: '发生了什么', refs: [r], utterance: `找最近讲解热点 ${i + 1} 的视频` })) };
      }
      return {};
    },
    videos,
    search: (p) => (p.get('type') === 'video' && p.get('order') === 'relevance' ? videos.map((v) => v.id) : []),
    xSearch: (query, max) => {
      xCalls.push({ query, max });
      if (opts.xStatus) return { status: opts.xStatus };
      // 每次调用的帖子 ID 不同（同一 ID 当天重复读取不计费，另有用例覆盖）
      return { posts: Array.from({ length: 30 }, (_, i) => ({ id: `${xCalls.length}${String(i).padStart(4, '0')}`, text: `post ${i} about ${query.slice(0, 20)}`, likes: 100 - i, reposts: 10, hoursAgo: 2 })) };
    },
  });
  const auth: AuthProvider = { configured: () => true, getToken: async () => 'ya29.fake-token-for-tests-1234567', invalidate: async () => {}, status: async () => 'connected', disconnect: async () => {} };
  const kv = memoryKV({
    secrets: { anthropicApiKey: KEY, ...(opts.xToken === false ? {} : { xBearerToken: XTOKEN }) },
    settings: { x: { dailyBudgetUsd: opts.budget ?? 0.5 } },
    clusters: {
      clusters: [
        cluster({ id: 'k1', name: 'AI 学习', keywords: ['AI', 'LLM'], weight: 1.5, nature: 'learning' }),
        cluster({ id: 'k2', name: '编程', keywords: ['programming', '编程'], weight: 1.2, nature: 'learning' }),
        cluster({ id: 'k3', name: '摄影', keywords: ['摄影', 'photography'], weight: 1 }),
        cluster({ id: 'k4', name: '游戏', keywords: ['游戏', 'gaming'], weight: 0.8, nature: 'entertainment' }),
      ],
    },
    profile: { syncedAt: NOW, subscriptions: [{ id: 'UCsub', title: '已订阅', description: '', topicCategories: [] }], likedVideos: [], likedChannels: [] },
  });
  let now = NOW;
  const ctx: AppContext = { kv, locker: memoryLocker(), http: api.fetch, now: () => now, auth, endpoints: ENDPOINTS, timeZone: 'Asia/Shanghai' };
  return { ctx, api, xCalls, llmCalls, setNow: (t: number) => (now = t) };
}

describe('X 热点（服务层，mock X 与 LLM）', () => {
  it('拉取 → 5–8 条带原文链接与找片口令的热点；按条计费；6 小时内走缓存', async () => {
    const { ctx, xCalls, api, setNow } = setup();
    const { state, cached } = await refreshHotspots(ctx);
    expect(cached).toBe(false);
    expect(state.items.length).toBeGreaterThanOrEqual(5);
    expect(state.items.length).toBeLessThanOrEqual(8);
    for (const h of state.items) {
      expect(h.posts[0]!.url).toMatch(/^https:\/\/x\.com\/i\/web\/status\//);
      expect(h.utterance).toContain('找');
    }
    expect(xCalls).toHaveLength(4); // 4 个主题
    expect(xCalls.every((c) => c.max === 15)).toBe(true);
    const spend = await xSpend(ctx);
    expect(spend.spentUsd).toBeCloseTo(4 * 15 * 0.005); // 返回 60 条 × $0.005
    expect(state.spentUsd).toBeCloseTo(0.3);
    // 发往 X 的请求只带 Bearer Token；Token 不出现在 URL，也不发往别处
    const xReq = api.requests.filter((r) => r.url.startsWith(ENDPOINTS.x));
    expect(xReq.every((r) => r.headers.authorization === `Bearer ${XTOKEN}` && !r.url.includes(XTOKEN))).toBe(true);
    expect(api.requests.filter((r) => !r.url.startsWith(ENDPOINTS.x)).every((r) => !JSON.stringify(r).includes(XTOKEN))).toBe(true);
    // 不展开作者（用户对象另计费）
    expect(xReq.every((r) => !r.url.includes('expansions'))).toBe(true);
    // 缓存
    setNow(NOW + 5 * 3_600_000);
    expect((await refreshHotspots(ctx)).cached).toBe(true);
    expect(xCalls).toHaveLength(4);
    setNow(NOW + 7 * 3_600_000);
    expect((await refreshHotspots(ctx)).cached).toBe(false);
  });

  it('超预算立即停调并提示：预算只够一个主题', async () => {
    const { ctx, xCalls } = setup({ budget: 0.08 });
    const { state } = await refreshHotspots(ctx);
    expect(xCalls).toHaveLength(1); // 第一个主题读 15 条 = $0.075，剩 $0.005 < $0.05
    expect(state.partial).toBe(true);
    expect(state.notes.join()).toContain('已停止调用');
    expect(state.items.length).toBeGreaterThan(0);
    const again = await refreshHotspots(ctx, { force: true });
    expect(xCalls).toHaveLength(1);
    expect(again.state.items).toEqual([]);
    expect(again.state.notes.join()).toContain('已停止调用');
  });

  it('X 返回 402（余额不足/花费上限）→ 人话提示，当天停止', async () => {
    const { ctx, xCalls } = setup({ xStatus: 402 });
    const { state } = await refreshHotspots(ctx);
    expect(state.notes.join()).toContain('余额不足');
    expect(xCalls).toHaveLength(1);
    await refreshHotspots(ctx, { force: true });
    expect(xCalls).toHaveLength(1);
    expect((await xSpend(ctx)).blocked).toBeDefined();
  });

  it('没填 Token：直接提示，不发请求', async () => {
    const { ctx, api } = setup({ xToken: false });
    await expect(refreshHotspots(ctx)).rejects.toMatchObject({ kind: 'x_key' });
    expect(api.requests).toHaveLength(0);
  });

  it('发给 LLM 的只有帖子正文与互动数，不含帖子 ID 与 Token', async () => {
    const { ctx, llmCalls } = setup();
    await refreshHotspots(ctx);
    const u = llmCalls.at(-1)!.user;
    expect(u).toContain('post 0 about');
    expect(u).not.toContain(XTOKEN);
    expect(u).not.toMatch(/status\//);
  });
});

describe('新博主发现（服务层）', () => {
  it('每周 ≤5 个、每个有理由与最近 3 个视频；不含已订阅、不活跃的频道；search ≤ 8 次', async () => {
    const { ctx, api } = setup();
    const week = await runDiscovery(ctx);
    expect(week.recommendations.length).toBeGreaterThan(0);
    expect(week.recommendations.length).toBeLessThanOrEqual(5);
    for (const r of week.recommendations) {
      expect(r.reasons.length).toBeGreaterThan(0);
      expect(r.recentVideos.length).toBeLessThanOrEqual(3);
      expect(r.recentVideos.length).toBeGreaterThan(0);
      expect(r.channelId).not.toBe('UCsub');
      expect(r.channelId).not.toBe('UCstale');
    }
    const searches = api.requests.filter((r) => r.url.includes('/search?'));
    expect(searches.length).toBeLessThanOrEqual(8);
    expect(week.searchCalls).toBe(searches.length);
  });

  it('每周 search 上限用完后明确拒绝；"不感兴趣"的频道不再出现', async () => {
    const { ctx } = setup();
    await stores.settings.update(ctx.kv, ctx.locker, (s) => ({ ...s, discovery: { ...s.discovery, weeklySearchCalls: 4 } }));
    const first = await runDiscovery(ctx); // 4 个兴趣簇 → 4 次
    expect(first.searchCalls).toBe(4);
    await expect(runDiscovery(ctx)).rejects.toMatchObject({ kind: 'budget' });
    const top = first.recommendations[0]!;
    await dismissCreator(ctx, top.channelId, top.title);
    await stores.settings.update(ctx.kv, ctx.locker, (s) => ({ ...s, discovery: { ...s.discovery, weeklySearchCalls: 8 } }));
    const second = await runDiscovery(ctx);
    expect(second.recommendations.map((r) => r.channelId)).not.toContain(top.channelId);
  });
});

describe('新博主（纯逻辑）', () => {
  it('学习类兴趣优先检索', () => {
    const qs = discoveryQueries([cluster({ name: '游戏', nature: 'entertainment', weight: 2 }), cluster({ name: 'AI', nature: 'learning', weight: 1 })], 8);
    expect(qs[0]!.topic).toBe('AI');
    expect(qs[0]!.q).toContain('|');
  });
  it('不活跃的不推荐；你打过低分的频道被排除', () => {
    const hits = aggregateHits([{ topic: 'AI', clusterWeight: 1, items: [{ channelId: 'a', channelTitle: 'A', rank: 1 }, { channelId: 'b', channelTitle: 'B', rank: 2 }, { channelId: 'a', channelTitle: 'A', rank: 5 }] }]);
    const ex = { subscribed: new Set<string>(), dismissed: new Set<string>(), recentlyRecommended: new Set<string>(), channelPrefs: { b: { value: -0.4 } } };
    const kept = filterCandidates(hits, ex);
    expect(kept.map((h) => h.channelId)).toEqual(['a']);
    const recs = scoreCandidates(
      [{ hit: kept[0]!, uploads: [{ videoId: 'v', title: 't', publishedAt: new Date(NOW - 400 * DAY).toISOString() }] }],
      ex,
      new Map(),
      NOW,
      5,
    );
    expect(recs).toEqual([]);
    const ok = scoreCandidates([{ hit: kept[0]!, uploads: [{ videoId: 'v', title: 't', publishedAt: new Date(NOW - DAY).toISOString() }] }], ex, new Map(), NOW, 5);
    expect(ok[0]!.reasons[0]).toContain('出现 2 次');
  });
});
