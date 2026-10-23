// Phase 2 服务层流程（不出网）：观看上报 → 汇总 → 元数据 → 当日总结；补算；导师提醒只触发一次；周报；Takeout。

import { describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../../src/config/endpoints';
import type { AppContext } from '../../src/services/context';
import type { AuthProvider } from '../../src/services/auth';
import { memoryKV, memoryLocker } from '../../src/services/storage';
import { stores } from '../../src/services/repo';
import { correctNature, currentWindowStats, dayEntries, enrichMetadata, ingestSession, watchedChannelCounts } from '../../src/services/watch-service';
import { generateDailySummary, generateWeeklyReport, runScheduledJobs } from '../../src/services/summary-service';
import { checkReminder, reminderActions } from '../../src/services/reminder-service';
import { importTakeout } from '../../src/services/takeout-service';
import { exportAll } from '../../src/services/data-service';
import type { WatchSession } from '../../src/core/types';
import { createFakeApi, type FakeVideo } from './fake-api';

const TZ = 'Asia/Shanghai';
const NOW = Date.parse('2026-10-24T02:00:00Z'); // 北京时间 10:00
const HOUR = 3_600_000;
const KEY = 'sk-ant-test-0123456789abcdefghijklmn';

const V: FakeVideo[] = [
  { id: 'vidComplete1', title: 'Transformer 原理讲解', channelId: 'UClearn01', channelTitle: '学习频道', publishedAt: '2026-10-20T00:00:00Z', duration: 'PT10M', views: 1, likes: 1, categoryId: '27' },
  { id: 'vidGlance002', title: '搞笑合集', channelId: 'UCfun0001', channelTitle: '娱乐频道', publishedAt: '2026-10-20T00:00:00Z', duration: 'PT15M', views: 1, likes: 1, categoryId: '24' },
  { id: 'vidHalf00003', title: '分布式系统课程 第 3 讲', channelId: 'UClearn01', channelTitle: '学习频道', publishedAt: '2026-10-20T00:00:00Z', duration: 'PT20M', views: 1, likes: 1, categoryId: '27' },
  { id: 'vidGame00004', title: '游戏实况 第 12 期', channelId: 'UCgame001', channelTitle: '游戏频道', publishedAt: '2026-10-20T00:00:00Z', duration: 'PT40M', views: 1, likes: 1, categoryId: '20' },
  { id: 'vidNewLearn5', title: '新课：注意力机制', channelId: 'UClearn01', channelTitle: '学习频道', publishedAt: '2026-10-23T00:00:00Z', duration: 'PT12M', views: 1, likes: 1, categoryId: '27' },
];

function session(id: string, videoId: string, durationSec: number, watched: number, opts: Partial<WatchSession> = {}): WatchSession {
  return {
    id,
    videoId,
    startedAt: NOW - HOUR,
    updatedAt: NOW - HOUR + watched * 1000,
    durationSec,
    intervals: watched > 0 ? [[0, watched]] : [],
    playSec: watched,
    fgSec: watched,
    bgSec: 0,
    adSec: 0,
    shorts: false,
    ...opts,
  };
}

function setup(opts: { key?: boolean; connected?: boolean } = {}) {
  const llmCalls: { system: string; user: string }[] = [];
  const api = createFakeApi({
    llm: (req) => {
      llmCalls.push(req);
      if (req.system.includes('学习记录助手')) {
        return { headline: '今天在补 Transformer', learned: [{ ref: 'v1', takeaway: '理解了注意力' }], revisit: [{ ref: 'v2', reason: '只看了一半' }], goalLink: '推进了"学大模型"' };
      }
      if (req.system.includes('自省助手')) return { overview: '低分集中在流量号', patterns: [{ pattern: '标题党排得太前', suggestion: '降低热度权重', refs: ['r1'] }] };
      return {};
    },
    videos: V,
    search: () => [],
  });
  let now = NOW;
  const auth: AuthProvider = {
    configured: () => true,
    getToken: async () => 'ya29.fake-token-for-tests-1234567',
    invalidate: async () => {},
    status: async () => (opts.connected === false ? 'disconnected' : 'connected'),
    disconnect: async () => {},
  };
  const ctx: AppContext = {
    kv: memoryKV(opts.key === false ? {} : { secrets: { anthropicApiKey: KEY } }),
    locker: memoryLocker(),
    http: api.fetch,
    now: () => now,
    auth,
    endpoints: ENDPOINTS,
    timeZone: TZ,
  };
  return { ctx, api, llmCalls, setNow: (t: number) => (now = t) };
}

async function watchThree(ctx: AppContext) {
  await ingestSession(ctx, session('s1', 'vidComplete1', 600, 600));
  await ingestSession(ctx, session('s2', 'vidGlance002', 900, 3));
  await ingestSession(ctx, session('s3', 'vidHalf00003', 1200, 600));
}

describe('验收：看 3 个视频（看完 / 秒退 / 看一半）→ 当日总结分类正确', () => {
  it('分类、补元数据、总结结构与"只是路过"', async () => {
    const { ctx, api, llmCalls } = setup();
    await watchThree(ctx);
    const log = await stores.watchLog.read(ctx.kv);
    const day = log['2026-10-24']!;
    expect(day.vidComplete1!.status).toBe('completed');
    expect(day.vidGlance002!.status).toBe('glance');
    expect(day.vidHalf00003!.status).toBe('partial');

    const s = await generateDailySummary(ctx, '2026-10-24', { manual: true });
    expect(s.stats).toMatchObject({ videos: 3, completed: 1, partial: 1, glance: 1 });
    expect(s.passingBy.map((i) => i.title)).toEqual(['搞笑合集']);
    expect(s.learned[0]!.title).toBe('Transformer 原理讲解');
    expect(s.revisit[0]!.title).toBe('分布式系统课程 第 3 讲');
    expect(s.markdown).toContain('## 只是路过');
    // 元数据：一次 videos.list（3 个 id，1 unit）
    const metaCalls = api.requests.filter((r) => r.url.includes('/videos?') && r.url.includes('part=snippet%2CcontentDetails'));
    expect(metaCalls).toHaveLength(1);
    // 发给 LLM 的只有看完/部分观看的两条，且不含视频 ID
    const call = llmCalls.at(-1)!;
    expect(call.user).toContain('Transformer 原理讲解');
    expect(call.user).not.toContain('搞笑合集');
    expect(call.user).not.toContain('vidComplete1');
  });

  it('上报是幂等的，乱序的旧上报被忽略；关闭追踪后不再记录', async () => {
    const { ctx } = setup();
    await ingestSession(ctx, session('s1', 'vidComplete1', 600, 300));
    await ingestSession(ctx, session('s1', 'vidComplete1', 600, 600));
    await ingestSession(ctx, session('s1', 'vidComplete1', 600, 300)); // 迟到的旧数据
    expect((await stores.watchLog.read(ctx.kv))['2026-10-24']!.vidComplete1!.playSec).toBe(600);
    await stores.settings.update(ctx.kv, ctx.locker, (s) => ({ ...s, tracking: { ...s.tracking, enabled: false } }));
    await ingestSession(ctx, session('s9', 'vidGame00004', 2400, 2000));
    expect((await stores.watchLog.read(ctx.kv))['2026-10-24']!.vidGame00004).toBeUndefined();
  });

  it('后台收听：照常记录并标注', async () => {
    const { ctx } = setup();
    await ingestSession(ctx, session('s1', 'vidHalf00003', 1200, 1100, { fgSec: 100, bgSec: 1000 }));
    const r = (await stores.watchLog.read(ctx.kv))['2026-10-24']!.vidHalf00003!;
    expect(r.background).toBe(true);
    expect(r.status).toBe('completed');
  });

  it('没连接 YouTube：不弹授权，如实说明取不到标题', async () => {
    const { ctx } = setup({ connected: false });
    await watchThree(ctx);
    const r = await enrichMetadata(ctx);
    expect(r.skipped).toContain('尚未连接 YouTube');
    const entries = await dayEntries(ctx, '2026-10-24');
    expect(entries[0]!.verdict.reasons[0]).toContain('元数据');
  });
});

describe('学习 / 娱乐占比与导师提醒', () => {
  it('人为把娱乐占比调过阈值 → 触发且只触发一次；带具体的学习视频台阶', async () => {
    const { ctx } = setup();
    // 先建一个"学习"兴趣簇，台阶会从这里找
    await stores.profile.write(ctx.kv, { syncedAt: NOW, subscriptions: [{ id: 'UClearn01', title: '学习频道', description: '', topicCategories: [] }], likedVideos: [], likedChannels: [] });
    await stores.clusters.write(ctx.kv, { clusters: [{ id: 'k1', name: 'AI 学习', description: '', keywords: ['AI'], channelIds: ['UClearn01'], weight: 1, locked: false, source: 'llm', updatedAt: NOW, nature: 'learning' }] });
    await watchThree(ctx);
    await ingestSession(ctx, session('s4', 'vidGame00004', 2400, 2400));
    await enrichMetadata(ctx);

    // 学习占比高 → 不触发
    let state = await checkReminder(ctx);
    expect(state.active).toBeUndefined();

    // 把学习视频纠正为娱乐（整个频道）→ 娱乐 > 70% 且学习 < 15%
    await correctNature(ctx, 'vidComplete1', 'entertainment', 'channel');
    const stats = await currentWindowStats(ctx, 7);
    expect(stats.entertainmentRatio).toBeGreaterThan(0.7);
    state = await checkReminder(ctx);
    expect(state.active?.dismissed).toBe(false);
    expect(state.active?.step).toMatchObject({ kind: 'video', videoId: 'vidNewLearn5' });
    const firstAt = state.lastTriggeredAt;

    // 再次评估（同一天、关闭横幅后）→ 不会再触发
    await reminderActions.dismiss(ctx);
    state = await checkReminder(ctx);
    expect(state.lastTriggeredAt).toBe(firstAt);
    expect(state.active?.dismissed).toBe(true);
  });

  it('纠正可撤销：撤销后回到信号判定', async () => {
    const { ctx } = setup();
    await watchThree(ctx);
    await enrichMetadata(ctx);
    await correctNature(ctx, 'vidComplete1', 'entertainment', 'video');
    expect((await dayEntries(ctx, '2026-10-24')).find((e) => e.record.videoId === 'vidComplete1')!.nature).toBe('entertainment');
    await correctNature(ctx, 'vidComplete1', null, 'video');
    expect((await dayEntries(ctx, '2026-10-24')).find((e) => e.record.videoId === 'vidComplete1')!.nature).toBe('learning');
  });
});

describe('定时与补算', () => {
  it('浏览器第二天才打开：补算前一天的总结；再跑一次不重复生成', async () => {
    const { ctx, llmCalls, setNow } = setup();
    await watchThree(ctx);
    await runScheduledJobs(ctx); // 当天 10:00：还没到 23:00
    expect(await stores.summaries.read(ctx.kv)).toEqual({});
    setNow(Date.parse('2026-10-25T01:00:00Z')); // 次日 09:00
    const r = await runScheduledJobs(ctx);
    expect(r.daily).toEqual(['2026-10-24']);
    const calls = llmCalls.length;
    const again = await runScheduledJobs(ctx);
    expect(again.daily).toEqual([]);
    expect(llmCalls.length).toBe(calls);
  });

  it('没填 Key：失败被记录下来给用户看，不抛出、不静默', async () => {
    const { ctx, setNow } = setup({ key: false });
    await watchThree(ctx);
    setNow(Date.parse('2026-10-25T01:00:00Z'));
    const r = await runScheduledJobs(ctx);
    expect(r.failed).toEqual(['2026-10-24']);
    const job = await stores.jobState.read(ctx.kv);
    expect(job.failures['daily:2026-10-24']!.message).toContain('API Key');
  });
});

describe('每周自省', () => {
  it('低分案例共性（LLM）+ 本周自动调整（确定性）', async () => {
    const { ctx, llmCalls } = setup();
    await stores.ratings.write(ctx.kv, {
      x: { videoId: 'x', rating: 3, searchId: 's', utterance: '找 AI 科普', at: Date.parse('2026-10-15T02:00:00Z'), attribution: 'retrieval', video: { title: '震惊！AI', channelId: 'c1', channelTitle: '流量号' } },
      y: { videoId: 'y', rating: 9, searchId: 's', utterance: '找 AI 科普', at: Date.parse('2026-10-16T02:00:00Z'), attribution: 'retrieval', video: { title: '好视频', channelId: 'c2', channelTitle: '好频道' } },
    });
    await stores.adjustments.write(ctx.kv, [
      { id: 'a1', at: Date.parse('2026-10-15T02:00:00Z'), trigger: { videoId: 'x', title: '震惊！AI', rating: 3, attribution: 'retrieval', searchId: 's', utterance: 'u' }, changes: [{ type: 'channelPref', channelId: 'c1', channelTitle: '流量号', before: 0, after: -0.22, explanation: '' }], reverted: false },
    ]);
    const w = await generateWeeklyReport(ctx, '2026-10-18');
    expect(w.lowRatings).toBe(1);
    expect(w.patterns[0]!.examples[0]).toContain('震惊！AI');
    expect(w.adjustments[0]).toContain('「流量号」-0.22');
    expect(llmCalls.at(-1)!.user).not.toContain('好视频');
    expect(w.markdown).toContain('## 本周已自动调整了什么');
  });
});

describe('Takeout 导入', () => {
  it('导入后进入画像（看过的频道计数），导出包含观看与总结数据但不含 Key', async () => {
    const { ctx } = setup();
    const file = JSON.stringify([
      { header: 'YouTube', title: 'Watched A', titleUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', subtitles: [{ name: '学习频道', url: 'https://www.youtube.com/channel/UClearn01xxxxx' }], time: '2026-10-01T00:00:00Z' },
      { header: 'YouTube', title: 'Watched B', titleUrl: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', subtitles: [{ name: '学习频道', url: 'https://www.youtube.com/channel/UClearn01xxxxx' }], time: '2026-10-02T00:00:00Z' },
    ]);
    const p = await importTakeout(ctx, file);
    expect(p.totalEntries).toBe(2);
    expect((await watchedChannelCounts(ctx)).get('UClearn01xxxxx')).toBe(2);
    await expect(importTakeout(ctx, 'not json')).rejects.toMatchObject({ kind: 'input' });
    await watchThree(ctx);
    const exp = JSON.stringify(await exportAll(ctx));
    expect(exp).toContain('watchLog');
    expect(exp).toContain('takeout');
    expect(exp).not.toContain(KEY);
  });
});
