import { describe, expect, it } from 'vitest';
import { assembleIntent } from '../../src/core/intent';
import { planSearch } from '../../src/core/planner';
import { rankCandidates } from '../../src/core/ranking';
import { learnFromRating, needsAttribution, revertChanges, summarizeChanges } from '../../src/core/learning';
import { NOW, RAW_1, UTTERANCE_1, defaultModel, makeCluster, makeVideo, plannerCtx } from './helpers';
import { RANKING } from '../../src/config/defaults';

const plan = planSearch(assembleIntent(UTTERANCE_1, RAW_1, NOW, 0), plannerCtx());
const cluster = makeCluster({ id: 'k1', keywords: ['AI', '大模型'] });

function batch() {
  const vids = [
    makeVideo({ title: 'AI 大模型 科普（爆款）', viewCount: 5_000_000, likeCount: 50_000, channelId: 'chPop', channelTitle: '爆款频道', hits: [{ queryIndex: 0, rank: 1 }] }),
    makeVideo({ title: 'AI 技术 科普', viewCount: 20_000, likeCount: 1_500, channelId: 'chNiche', channelTitle: '小众频道', hits: [{ queryIndex: 0, rank: 4 }] }),
    makeVideo({ title: '其他 AI', viewCount: 3_000, likeCount: 30, hits: [{ queryIndex: 1, rank: 6 }] }),
  ];
  return rankCandidates(vids, {
    now: NOW,
    subscriptionIds: new Set(),
    plan,
    model: defaultModel(),
    clusters: [cluster],
    likedChannelCounts: new Map(),
    ratings: {},
    hasProfile: true,
  });
}

describe('评分 → 可见调整', () => {
  it('≤5 分需要先归因', () => {
    expect(needsAttribution(3)).toBe(true);
    expect(needsAttribution(6)).toBe(false);
  });

  it('3 分 + "找错/排错"：降低频道偏好，调整因子权重，给出解释', () => {
    const b = batch();
    const top = b[0]!;
    const out = learnFromRating({ rating: 3, attribution: 'retrieval', item: top, batch: b, model: defaultModel(), clusters: [cluster], autoAdjust: true, now: NOW });
    const pref = out.changes.find((c) => c.type === 'channelPref');
    expect(pref).toBeDefined();
    expect(pref!.type === 'channelPref' && pref!.after).toBeLessThan(0);
    expect(out.changes.some((c) => c.type === 'factorWeight')).toBe(true);
    expect(out.model.version).toBe(2);
    const sum = Object.values(out.model.weights).reduce((s, x) => s + x, 0);
    expect(sum).toBeCloseTo(1, 2);
    for (const w of Object.values(out.model.weights)) {
      expect(w).toBeGreaterThanOrEqual(RANKING.weightMin - 0.01);
      expect(w).toBeLessThanOrEqual(RANKING.weightMax + 0.01);
    }
    // 解释必须是人话，且不出现"训练"之类不实表述
    for (const c of out.changes) {
      expect(c.explanation.length).toBeGreaterThan(5);
      expect(c.explanation).not.toMatch(/训练|retrain/i);
    }
  });

  it('10 分：频道偏好上升，命中的兴趣簇权重上升', () => {
    const b = batch();
    const item = b.find((x) => x.video.channelId === 'chNiche')!;
    const out = learnFromRating({ rating: 10, attribution: 'retrieval', item, batch: b, model: defaultModel(), clusters: [cluster], autoAdjust: true, now: NOW });
    const pref = out.changes.find((c) => c.type === 'channelPref');
    expect(pref && pref.type === 'channelPref' ? pref.after : 0).toBeCloseTo(0.4, 5);
    const cw = out.changes.find((c) => c.type === 'clusterWeight');
    expect(cw && cw.type === 'clusterWeight' ? cw.after : 0).toBeGreaterThan(1);
    expect(out.clusters[0]!.weight).toBeGreaterThan(1);
  });

  it('10 分之后再排序：被打高分的频道排名上升', () => {
    const b = batch();
    const item = b.find((x) => x.video.channelId === 'chNiche')!;
    const before = b.findIndex((x) => x.video.id === item.video.id);
    const out = learnFromRating({ rating: 10, attribution: 'retrieval', item, batch: b, model: defaultModel(), clusters: [cluster], autoAdjust: true, now: NOW });
    const reranked = rankCandidates(
      b.map((x) => x.video),
      { now: NOW, subscriptionIds: new Set(), plan, model: out.model, clusters: out.clusters, likedChannelCounts: new Map(), ratings: {}, hasProfile: true },
    );
    const after = reranked.findIndex((x) => x.video.id === item.video.id);
    expect(after).toBeLessThanOrEqual(before);
    expect(reranked[after]!.score).toBeGreaterThan(b[before]!.score);
  });

  it('排在后面的片子打低分，也是"调低它突出的因子"，不会被当成惊喜而调高', () => {
    const b = batch();
    const mean = (f: keyof RankedFeatures) => b.reduce((s, x) => s + x.features[f], 0) / b.length;
    type RankedFeatures = (typeof b)[number]['features'];
    // 取排名不在第一、但在某个因子上高于同批平均的那条
    const pick = b
      .slice(1)
      .map((item) => ({ item, standout: item.activeFactors.map((f) => ({ f, d: item.features[f] - mean(f) })).sort((x, y) => y.d - x.d)[0]! }))
      .find((x) => x.standout.d > 0.05)!;
    expect(pick).toBeDefined();
    const out = learnFromRating({ rating: 3, attribution: 'retrieval', item: pick.item, batch: b, model: defaultModel(), clusters: [], autoAdjust: true, now: NOW });
    expect(out.model.weights[pick.standout.f]).toBeLessThan(defaultModel().weights[pick.standout.f]);
  });

  it('展示时只列主要变化，细小权重变化折叠（不丢失）', () => {
    const b = batch();
    const out = learnFromRating({ rating: 3, attribution: 'retrieval', item: b[0]!, batch: b, model: defaultModel(), clusters: [cluster], autoAdjust: true, now: NOW });
    const { main, minor } = summarizeChanges(out.changes);
    expect(main.length + minor.length).toBe(out.changes.length);
    expect(main.filter((c) => c.type === 'factorWeight').length).toBeLessThanOrEqual(3);
    expect(main.some((c) => c.type === 'channelPref')).toBe(true);
  });

  it('"理解错了"不碰排序参数', () => {
    const b = batch();
    const out = learnFromRating({ rating: 2, attribution: 'understanding', item: b[0]!, batch: b, model: defaultModel(), clusters: [cluster], autoAdjust: true, now: NOW });
    expect(out.model).toEqual(defaultModel());
    expect(out.changes.map((c) => c.type)).toEqual(['none']);
  });

  it('未归因或关闭自动调整：只记录，明确说明未调整', () => {
    const b = batch();
    const none = learnFromRating({ rating: 2, attribution: 'none', item: b[0]!, batch: b, model: defaultModel(), clusters: [], autoAdjust: true, now: NOW });
    expect(none.changes[0]!.explanation).toContain('没有调整');
    const off = learnFromRating({ rating: 9, attribution: 'retrieval', item: b[0]!, batch: b, model: defaultModel(), clusters: [], autoAdjust: false, now: NOW });
    expect(off.changes[0]!.explanation).toContain('已关闭');
  });

  it('撤销：频道偏好与簇权重回到原值', () => {
    const b = batch();
    const item = b.find((x) => x.video.channelId === 'chNiche')!;
    const out = learnFromRating({ rating: 10, attribution: 'retrieval', item, batch: b, model: defaultModel(), clusters: [cluster], autoAdjust: true, now: NOW });
    const back = revertChanges(out.model, out.clusters, out.changes, NOW);
    expect(back.model.channelPrefs.chNiche!.value).toBeCloseTo(0, 5);
    expect(back.clusters[0]!.weight).toBeCloseTo(1, 5);
    for (const [f, w] of Object.entries(defaultModel().weights)) {
      expect(back.model.weights[f as keyof typeof back.model.weights]).toBeCloseTo(w, 2);
    }
  });
});
