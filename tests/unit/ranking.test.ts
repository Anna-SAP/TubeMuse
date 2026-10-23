import { describe, expect, it } from 'vitest';
import { assembleIntent } from '../../src/core/intent';
import { planSearch } from '../../src/core/planner';
import { effectiveWeights, rankCandidates, scoreBreakdown, type RankContext } from '../../src/core/ranking';
import { applyFilters, isShorts, checkLanguage } from '../../src/core/postfilter';
import { DAY, NOW, RAW_1, RAW_2, UTTERANCE_1, UTTERANCE_2, defaultModel, makeCluster, makeVideo, plannerCtx } from './helpers';
import type { RankingModel } from '../../src/core/types';

const plan1 = planSearch(assembleIntent(UTTERANCE_1, RAW_1, NOW, 0), plannerCtx());
const plan2 = planSearch(assembleIntent(UTTERANCE_2, RAW_2, NOW, 0), plannerCtx());

function ctx(over: Partial<RankContext> = {}): RankContext {
  return {
    now: NOW,
    subscriptionIds: new Set(),
    plan: plan1,
    model: defaultModel(),
    clusters: [],
    likedChannelCounts: new Map(),
    ratings: {},
    hasProfile: true,
    ...over,
  };
}

describe('后置过滤', () => {
  it('Shorts 判定：≤60 秒一律算；≤3 分钟需带 #shorts', () => {
    expect(isShorts(makeVideo({ durationSec: 45 }))).toBe(true);
    expect(isShorts(makeVideo({ durationSec: 150, title: 'cool #shorts' }))).toBe(true);
    expect(isShorts(makeVideo({ durationSec: 150, title: 'normal clip' }))).toBe(false);
    expect(isShorts(makeVideo({ durationSec: 0, liveBroadcastContent: 'live' }))).toBe(false);
  });

  it('语言：有元数据按元数据；没有时按标题文字推断并标注', () => {
    expect(checkLanguage(makeVideo({ defaultAudioLanguage: 'en-US' }), 'en')).toMatchObject({ pass: true, badge: '✓ 英文' });
    expect(checkLanguage(makeVideo({ defaultAudioLanguage: 'zh-CN' }), 'en').pass).toBe(false);
    expect(checkLanguage(makeVideo({ title: 'How transformers work' }), 'en')).toMatchObject({ pass: true, inferred: true });
    expect(checkLanguage(makeVideo({ title: '大模型原理讲解' }), 'en').pass).toBe(false);
    expect(checkLanguage(makeVideo({ title: '大模型原理讲解' }), 'zh')).toMatchObject({ pass: true, inferred: true });
  });

  it('验收口令 2 的过滤：每条淘汰只记在第一个失败的过滤器上', () => {
    const good = makeVideo({ title: 'AI safety interview', defaultAudioLanguage: 'en', durationSec: 4000, caption: true, publishedAt: new Date(NOW - 2 * DAY).toISOString() });
    const short = makeVideo({ defaultAudioLanguage: 'en', durationSec: 50, caption: true });
    const noCaption = makeVideo({ defaultAudioLanguage: 'en', durationSec: 4000, caption: false });
    const old = makeVideo({ defaultAudioLanguage: 'en', durationSec: 4000, caption: true, publishedAt: new Date(NOW - 10 * DAY).toISOString() });
    const zh = makeVideo({ defaultAudioLanguage: 'zh', durationSec: 4000, caption: true });
    const out = applyFilters([good, short, noCaption, old, zh], plan2.postFilters, { now: NOW, subscriptionIds: new Set() });
    expect(out.kept.map((v) => v.id)).toEqual([good.id]);
    expect(out.stats.reduce((s, x) => s + x.removed, 0)).toBe(4);
  });
});

describe('排序', () => {
  it('确定性：相同输入得到相同顺序', () => {
    const vids = [makeVideo(), makeVideo(), makeVideo()];
    const a = rankCandidates(vids, ctx()).map((r) => r.video.id);
    const b = rankCandidates(vids, ctx()).map((r) => r.video.id);
    expect(a).toEqual(b);
  });

  it('有效权重归一化，且没有形式词时形式因子不参与', () => {
    const p = { ...plan1, rank: { ...plan1.rank, formatTerms: [] } };
    const w = effectiveWeights(defaultModel(), p, true);
    expect(w.format).toBe(0);
    expect(Object.values(w).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 6);
  });

  it('"最新"放大新鲜度：同等条件下更新的排前面', () => {
    const fresh = makeVideo({ title: 'AI 科普', publishedAt: new Date(NOW - 0.2 * DAY).toISOString(), hits: [{ queryIndex: 0, rank: 2 }] });
    const stale = makeVideo({ title: 'AI 科普', publishedAt: new Date(NOW - 1.9 * DAY).toISOString(), hits: [{ queryIndex: 0, rank: 1 }] });
    const ranked = rankCandidates([stale, fresh], ctx());
    expect(ranked[0]!.video.id).toBe(fresh.id);
  });

  it('频道偏好与兴趣簇进入排序，并生成"为什么推给你"', () => {
    const cluster = makeCluster({ channelIds: ['chFav'] });
    const fav = makeVideo({ channelId: 'chFav', channelTitle: '最爱频道', title: 'AI 技术科普：大模型', hits: [{ queryIndex: 0, rank: 8 }] });
    const other = makeVideo({ title: '随便一个视频', hits: [{ queryIndex: 0, rank: 3 }] });
    const model: RankingModel = { ...defaultModel(), channelPrefs: { chFav: { value: 0.8, title: '最爱频道', ratings: 2 } } };
    const ranked = rankCandidates([other, fav], ctx({ model, clusters: [cluster], subscriptionIds: new Set(['chFav']) }));
    expect(ranked[0]!.video.id).toBe(fav.id);
    const reasons = ranked[0]!.reasons.join('|');
    expect(reasons).toContain('订阅的频道「最爱频道」');
    expect(reasons).toContain('AI 研究');
    expect(ranked[0]!.reasons.length).toBeGreaterThan(0);
    expect(ranked[0]!.reasons.length).toBeLessThanOrEqual(4);
  });

  it('之前打过低分的视频被压低，并给出提示', () => {
    const a = makeVideo({ title: 'AI 科普 A', hits: [{ queryIndex: 0, rank: 1 }] });
    const b = makeVideo({ title: 'AI 科普 B', hits: [{ queryIndex: 0, rank: 2 }] });
    const ranked = rankCandidates([a, b], ctx({ ratings: { [a.id]: { rating: 2 } } }));
    expect(ranked[0]!.video.id).toBe(b.id);
    expect(ranked[1]!.warnings.join()).toContain('2 分');
  });

  it('打分明细的贡献之和等于线性分（无额外加分时）', () => {
    const v = makeVideo({ title: 'AI 技术 科普' });
    const p = { ...plan1, softChecks: [], rank: { ...plan1.rank, referenceTerms: [], preferChannelIds: [], preferChannelNames: [] } };
    const [item] = rankCandidates([v], ctx({ plan: p }));
    const parts = scoreBreakdown(item!, defaultModel(), p, true);
    expect(parts.reduce((s, x) => s + x.contribution, 0)).toBeCloseTo(item!.score, 6);
  });

  it('通过的硬过滤会作为徽标展示在卡片上', () => {
    const v = makeVideo({ defaultAudioLanguage: 'en', durationSec: 4000, caption: true, title: 'AI safety interview' });
    const [item] = rankCandidates([v], ctx({ plan: plan2 }));
    expect(item!.badges).toEqual(expect.arrayContaining(['✓ 英文', '✓ 有字幕', '✓ 非 Shorts']));
    expect(item!.badges.some((b) => b.startsWith('✓ 时长'))).toBe(true);
  });
});
