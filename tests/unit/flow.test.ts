// 服务层端到端（不出网）：口令 → 理解 → 找片 → 打分 → 归因 → 可见调整；以及配额、缓存、导出、红线检查。

import { describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../../src/config/endpoints';
import type { AppContext } from '../../src/services/context';
import type { AuthProvider } from '../../src/services/auth';
import { memoryKV, memoryLocker } from '../../src/services/storage';
import { stores } from '../../src/services/repo';
import { parseUtterance } from '../../src/services/intent-service';
import { latestSession, rerankSession, runSearch } from '../../src/services/search-service';
import { attribute, rate, revertAdjustment } from '../../src/services/rating-service';
import { generateClusters, syncProfile } from '../../src/services/profile-service';
import { clearAll, exportAll } from '../../src/services/data-service';
import { AppError } from '../../src/services/errors';
import { recordCall, EMPTY_LEDGER } from '../../src/core/quota';
import { createFakeApi, type FakeVideo } from './fake-api';
import { DAY, NOW, RAW_1, RAW_2, UTTERANCE_1, UTTERANCE_2 } from './helpers';

const ANTHROPIC_KEY = 'sk-ant-test-0123456789abcdefghijklmn';
const OPENAI_KEY = 'sk-test-openai-0123456789abcdefghij';
const TOKEN = 'ya29.fake-youtube-access-token-123456';

function fakeAuth(): AuthProvider {
  return {
    configured: () => true,
    getToken: async () => TOKEN,
    invalidate: async () => {},
    status: async () => 'connected',
    disconnect: async () => {},
  };
}

function iso(daysAgo: number) {
  return new Date(NOW - daysAgo * DAY).toISOString();
}

const VIDEOS: FakeVideo[] = [
  { id: 'a1', title: 'AI 技术科普：大模型是怎么工作的', channelId: 'UCsub1', channelTitle: '科普君', publishedAt: iso(0.5), duration: 'PT12M', views: 230_000, likes: 12_000, lang: 'zh' },
  { id: 'a2', title: 'AI explained: transformers in 10 minutes', channelId: 'UCx2', channelTitle: 'Explain Lab', publishedAt: iso(1), duration: 'PT10M', views: 90_000, likes: 4_000, lang: 'en' },
  { id: 'a3', title: '【爆款】AI 一夜改变世界？', channelId: 'UCx3', channelTitle: '流量号', publishedAt: iso(0.2), duration: 'PT8M', views: 2_000_000, likes: 10_000, lang: 'zh' },
  { id: 'a4', title: 'AI 技术 周报', channelId: 'UCx4', channelTitle: '周报台', publishedAt: iso(1.5), duration: 'PT20M', views: 5_000, likes: 300, lang: 'zh' },
  { id: 'a5', title: 'AI #shorts', channelId: 'UCx5', channelTitle: '短视频', publishedAt: iso(0.1), duration: 'PT40S', views: 50_000, likes: 3_000, lang: 'zh' },
  { id: 'b1', title: 'AI safety interview with a researcher', channelId: 'UCx6', channelTitle: 'Safety Pod', publishedAt: iso(3), duration: 'PT1H20M', views: 40_000, likes: 2_000, lang: 'en', caption: true },
  { id: 'b2', title: 'AI safety in 60 seconds', channelId: 'UCx7', channelTitle: 'Quick', publishedAt: iso(2), duration: 'PT55S', views: 9_000, likes: 100, lang: 'en', caption: true },
];

function setup(opts: Partial<Parameters<typeof createFakeApi>[0]> = {}, provider: 'anthropic' | 'openai' = 'anthropic') {
  const seenSystems: string[] = [];
  const api = createFakeApi({
    llm: (req) => {
      seenSystems.push(req.system);
      if (req.system.includes('兴趣画像')) {
        return { clusters: [{ name: 'AI 科普', description: '人工智能讲解', keywords: ['AI', '大模型', 'transformer'], channelRefs: ['c1'] }] };
      }
      if (req.user.includes('Shorts')) return RAW_2;
      return RAW_1;
    },
    videos: VIDEOS,
    search: (p) => (p.get('q')?.includes('safety') ? ['b1', 'b2'] : ['a1', 'a2', 'a3', 'a4', 'a5']),
    subscriptions: [{ id: 'UCsub1', title: '科普君' }],
    liked: [VIDEOS[0]!],
    ...opts,
  });
  const kv = memoryKV({
    secrets: { anthropicApiKey: ANTHROPIC_KEY, openaiApiKey: OPENAI_KEY },
    settings: { llm: { provider, models: { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol' } } },
  });
  let now = NOW;
  const ctx: AppContext = {
    kv,
    locker: memoryLocker(),
    http: api.fetch,
    now: () => now,
    auth: fakeAuth(),
    endpoints: ENDPOINTS,
    timeZone: 'Asia/Shanghai',
  };
  return { ctx, api, kv, seenSystems, advance: (ms: number) => (now += ms) };
}

describe('Phase 1 验收主流程（服务层，mock 外部服务）', () => {
  it('口令 → 回显 → 带理由的结果 → 3 分 & 10 分 → 可见调整', async () => {
    const { ctx, api } = setup();
    await syncProfile(ctx);
    await generateClusters(ctx);

    const intent = await parseUtterance(ctx, UTTERANCE_1);
    expect(intent.constraints.map((c) => c.kind)).toEqual(expect.arrayContaining(['recency', 'sort', 'topic', 'format']));

    const out = await runSearch(ctx, { intent });
    if (out.kind !== 'done') throw new Error('expected done');
    const { session, ranked } = out;
    // 2 条检索词各 1 次；过滤后不足 10 条时在单次预算（3 次）内追加翻页
    expect(session.cost.searchCalls).toBe(2 + session.extraPagesUsed);
    expect(session.cost.searchCalls).toBeLessThanOrEqual(3);
    expect(ranked.length).toBeGreaterThan(0);
    for (const r of ranked) expect(r.reasons.length).toBeGreaterThan(0);
    // 订阅频道 + 兴趣簇进入理由
    const top = ranked.find((r) => r.video.id === 'a1')!;
    expect(top.reasons.join()).toContain('订阅的频道');

    // 打一个 3 分（流量号）→ 需要归因 → 选"找错/排错"
    const low = await rate(ctx, session.id, 'a3', 3);
    expect(low.needsAttribution).toBe(true);
    const att = await attribute(ctx, { videoId: 'a3', attribution: 'retrieval' });
    expect(att.adjustment.changes.length).toBeGreaterThan(0);
    expect(att.adjustment.changes.some((c) => c.type === 'channelPref')).toBe(true);

    // 打一个 10 分 → 直接调整
    const high = await rate(ctx, session.id, 'a4', 10);
    expect(high.needsAttribution).toBe(false);
    const pref = high.adjustment!.changes.find((c) => c.type === 'channelPref');
    expect(pref && pref.type === 'channelPref' ? pref.after : 0).toBeGreaterThan(0);

    // 改进记录里能看到两条
    const adjustments = await stores.adjustments.read(ctx.kv);
    expect(adjustments).toHaveLength(2);
    for (const a of adjustments) for (const c of a.changes) expect(c.explanation).not.toMatch(/训练|retrain/i);

    // 按新偏好重排：10 分频道上升，3 分频道下降
    const before = session.rankedIds;
    const re = await rerankSession(ctx, session.id);
    const after = re!.session.rankedIds;
    expect(after.indexOf('a4')).toBeLessThanOrEqual(before.indexOf('a4'));
    expect(after.indexOf('a3')).toBeGreaterThanOrEqual(before.indexOf('a3'));

    // 红线：Key 只出现在发往 Anthropic 的请求头里；YouTube 令牌只发往 YouTube
    for (const r of api.requests) {
      const blob = JSON.stringify(r);
      if (!r.url.startsWith(ENDPOINTS.anthropic)) expect(blob).not.toContain(ANTHROPIC_KEY);
      if (!r.url.startsWith(ENDPOINTS.youtubeApi)) expect(blob).not.toContain(TOKEN);
      expect(blob).not.toContain(OPENAI_KEY);
      // URL 里不带任何凭据
      expect(r.url).not.toContain(TOKEN);
      expect(r.url).not.toContain(ANTHROPIC_KEY);
    }
    const llmReq = api.requests.find((r) => r.url.startsWith(ENDPOINTS.anthropic))!;
    // SDK 1.x 以 Authorization: Bearer 发送 Key（旧版为 x-api-key），两者都只发往 Anthropic
    expect([llmReq.headers['x-api-key'], llmReq.headers.authorization]).toContain(
      llmReq.headers['x-api-key'] ? ANTHROPIC_KEY : `Bearer ${ANTHROPIC_KEY}`,
    );
    expect(llmReq.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(llmReq.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    const body = JSON.parse(llmReq.body!);
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.fallbacks).toBe('default');
  });

  it('相同意图 30 分钟内命中缓存，不再消耗配额', async () => {
    const { ctx, advance } = setup();
    const intent = await parseUtterance(ctx, UTTERANCE_1);
    const first = await runSearch(ctx, { intent });
    const ledger1 = await stores.quotaLedger.read(ctx.kv);
    advance(10 * 60_000);
    const second = await runSearch(ctx, { intent });
    if (first.kind !== 'done' || second.kind !== 'done') throw new Error();
    expect(second.session.fromCache).toBe(true);
    expect(second.session.cost).toEqual({ searchCalls: 0, generalUnits: 0 });
    expect(await stores.quotaLedger.read(ctx.kv)).toEqual(ledger1);
    advance(25 * 60_000);
    const third = await runSearch(ctx, { intent });
    if (third.kind !== 'done') throw new Error();
    expect(third.session.fromCache).toBe(false);
  });

  it('验收口令 2：过滤后每条结果都满足硬约束，Shorts 被剔除', async () => {
    const { ctx } = setup();
    const intent = await parseUtterance(ctx, UTTERANCE_2);
    const out = await runSearch(ctx, { intent });
    if (out.kind !== 'done') throw new Error();
    expect(out.ranked.map((r) => r.video.id)).toEqual(['b1']);
    expect(out.session.filterStats.reduce((s, f) => s + f.removed, 0)).toBe(1);
    // 不足 10 条 → 预算内追加翻页（1 条检索词，最多再翻 2 页）
    expect(out.session.extraPagesUsed).toBeGreaterThan(0);
    expect(out.session.cost.searchCalls).toBeLessThanOrEqual(3);
  });

  it('"理解错了" → 记录纠正，下次解析时发给 LLM；不改排序参数', async () => {
    const { ctx, seenSystems } = setup();
    const intent = await parseUtterance(ctx, UTTERANCE_1);
    const out = await runSearch(ctx, { intent });
    if (out.kind !== 'done') throw new Error();
    const modelBefore = await stores.rankingModel.read(ctx.kv);
    await rate(ctx, out.session.id, 'a2', 2);
    const formatC = intent.constraints.find((c) => c.kind === 'format')!;
    const res = await attribute(ctx, { videoId: 'a2', attribution: 'understanding', aspect: formatC.id, note: '我要中文的入门科普，不是英文速览' });
    expect(res.correction?.constraint?.kind).toBe('format');
    expect(await stores.rankingModel.read(ctx.kv)).toEqual(modelBefore);
    await parseUtterance(ctx, UTTERANCE_1);
    expect(seenSystems.at(-1)).toContain('我要中文的入门科普');
    // 撤销后纠正失效
    await revertAdjustment(ctx, res.adjustment.id);
    expect((await stores.corrections.read(ctx.kv))[0]!.active).toBe(false);
  });

  it('几天后重新打开侧边栏：恢复当时的结果与顺序，不会被"两天内"滤空', async () => {
    const { ctx, advance } = setup();
    const intent = await parseUtterance(ctx, UTTERANCE_1);
    const out = await runSearch(ctx, { intent });
    if (out.kind !== 'done') throw new Error();
    advance(5 * DAY);
    const restored = await latestSession(ctx);
    expect(restored!.ranked.map((r) => r.video.id)).toEqual(out.ranked.map((r) => r.video.id));
  });

  it('撤销调整：频道偏好回到原值', async () => {
    const { ctx } = setup();
    const intent = await parseUtterance(ctx, UTTERANCE_1);
    const out = await runSearch(ctx, { intent });
    if (out.kind !== 'done') throw new Error();
    const r = await rate(ctx, out.session.id, 'a4', 10);
    expect((await stores.rankingModel.read(ctx.kv)).channelPrefs.UCx4!.value).toBeGreaterThan(0);
    await revertAdjustment(ctx, r.adjustment!.id);
    expect((await stores.rankingModel.read(ctx.kv)).channelPrefs.UCx4!.value).toBeCloseTo(0, 5);
  });

  it('改分会先撤销上一次调整，不重复计入', async () => {
    const { ctx } = setup();
    const intent = await parseUtterance(ctx, UTTERANCE_1);
    const out = await runSearch(ctx, { intent });
    if (out.kind !== 'done') throw new Error();
    await rate(ctx, out.session.id, 'a4', 10);
    await rate(ctx, out.session.id, 'a4', 10);
    expect((await stores.rankingModel.read(ctx.kv)).channelPrefs.UCx4!.value).toBeCloseTo(0.4, 5);
  });
});

describe('配额与失败处理', () => {
  it('今日 search 只剩 1 次 → 先请用户确认缩减；确认后只用 1 次', async () => {
    const { ctx } = setup();
    let l = EMPTY_LEDGER;
    for (let i = 0; i < 99; i++) l = recordCall(l, 'search.list', NOW);
    await stores.quotaLedger.write(ctx.kv, l);
    const intent = await parseUtterance(ctx, UTTERANCE_1);
    const out = await runSearch(ctx, { intent });
    expect(out.kind).toBe('confirm');
    const done = await runSearch(ctx, { intent, reduceTo: 1 });
    if (done.kind !== 'done') throw new Error();
    expect(done.session.cost.searchCalls).toBe(1);
  });

  it('官方返回 quotaExceeded → 人话报错，本地账本标记耗尽', async () => {
    const { ctx } = setup({ failWith: { path: 'search', status: 403, reason: 'quotaExceeded' } });
    const intent = await parseUtterance(ctx, UTTERANCE_1);
    await expect(runSearch(ctx, { intent })).rejects.toMatchObject({ kind: 'quota' });
    const day = Object.values((await stores.quotaLedger.read(ctx.kv)).days)[0]!;
    expect(day.exhausted.search).toBe(true);
  });

  it('没填 Key → 直接提示，不发任何请求', async () => {
    const { ctx, api, kv } = setup();
    await kv.set('secrets', {});
    await expect(parseUtterance(ctx, UTTERANCE_1)).rejects.toBeInstanceOf(AppError);
    expect(api.requests).toHaveLength(0);
  });

  it('OpenAI 路径：Responses API + 严格 JSON Schema', async () => {
    const { ctx, api } = setup({}, 'openai');
    const intent = await parseUtterance(ctx, UTTERANCE_1);
    expect(intent.constraints.length).toBeGreaterThan(0);
    const req = api.requests.find((r) => r.url.startsWith(ENDPOINTS.openai))!;
    expect(req.url).toBe(`${ENDPOINTS.openai}/responses`);
    expect(req.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    const body = JSON.parse(req.body!);
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.store).toBe(false);
  });
});

describe('画像与数据', () => {
  it('同步 + 聚类：频道 ID 不发给 LLM，结果映射回真实频道', async () => {
    const { ctx, api } = setup();
    const { profile, unitsSpent } = await syncProfile(ctx);
    expect(profile.subscriptions[0]!.id).toBe('UCsub1');
    expect(unitsSpent).toBe(3); // 订阅 1 页 + 喜欢 1 页 + 频道详情 1 次
    const clusters = await generateClusters(ctx);
    expect(clusters[0]!.channelIds).toEqual(['UCsub1']);
    const llmReq = api.requests.filter((r) => r.url.startsWith(ENDPOINTS.anthropic)).at(-1)!;
    expect(llmReq.body).not.toContain('UCsub1');
  });

  it('导出不含 API Key；清空后什么都不剩', async () => {
    const { ctx } = setup();
    const intent = await parseUtterance(ctx, UTTERANCE_1);
    await runSearch(ctx, { intent });
    const file = await exportAll(ctx);
    const text = JSON.stringify(file);
    expect(text).not.toContain(ANTHROPIC_KEY);
    expect(text).not.toContain(OPENAI_KEY);
    expect(file.data.searchSessions).toBeDefined();
    await clearAll(ctx);
    expect(await ctx.kv.getAll()).toEqual({});
    expect(await latestSession(ctx)).toBeUndefined();
  });
});
