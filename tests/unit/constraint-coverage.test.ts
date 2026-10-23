// 产品原则 1「理解不丢约束」的核心测试：每个约束要么落成可执行信号，要么被明确标注。

import { describe, expect, it } from 'vitest';
import { assembleIntent } from '../../src/core/intent';
import { coverageStatus, deriveVideoDuration, planSearch } from '../../src/core/planner';
import { normalizeConstraint } from '../../src/core/constraints';
import { extractByRules } from '../../src/core/rule-extractor';
import { leftoverSegments, locateSpan } from '../../src/core/coverage';
import { toRfc3339 } from '../../src/core/time';
import { NOW, RAW_1, RAW_2, UTTERANCE_1, UTTERANCE_2, plannerCtx, rawIntent, rc } from './helpers';
import type { Disposition, Intent } from '../../src/core/types';

function plan(intent: Intent, over = {}) {
  return planSearch(intent, plannerCtx(over));
}

function types(ds: Disposition[] | undefined) {
  return (ds ?? []).map((d) => d.type);
}

describe('验收口令 2：含 6 个以上约束', () => {
  const intent = assembleIntent(UTTERANCE_2, RAW_2, NOW, 0);
  const p = plan(intent);
  const byKind = (k: string) => intent.constraints.find((c) => c.kind === k)!;

  it('LLM 给出的 7 个约束全部保留，且没有多出"未识别片段"', () => {
    expect(intent.constraints.map((c) => c.kind).sort()).toEqual(
      ['caption', 'duration', 'exclude_shorts', 'format', 'language', 'recency', 'topic'].sort(),
    );
    expect(intent.constraints.filter((c) => c.source !== 'llm')).toEqual([]);
  });

  it('每个约束至少有一条落实方式，状态不是"静默"', () => {
    for (const c of intent.constraints) {
      expect(p.dispositions[c.id]?.length, c.kind).toBeGreaterThan(0);
      expect(p.coverage[c.id], c.kind).toBeDefined();
    }
  });

  it('语言 → relevanceLanguage（注明只影响相关性）+ 后置过滤', () => {
    const ds = p.dispositions[byKind('language').id]!;
    const api = ds.find((d) => d.type === 'api_param');
    expect(api).toMatchObject({ param: 'relevanceLanguage', value: 'en' });
    expect(api && 'note' in api ? api.note : '').toContain('只影响相关性');
    expect(types(ds)).toContain('post_filter');
    expect(p.queries.every((q) => q.params.relevanceLanguage === 'en')).toBe(true);
  });

  it('一小时以上 → videoDuration=long + 精确时长过滤 ≥ 3600 秒', () => {
    expect(p.queries[0]!.params.videoDuration).toBe('long');
    const f = p.postFilters.find((f) => f.kind === 'duration');
    expect(f?.minSeconds).toBe(3600);
    expect(p.coverage[byKind('duration').id]).toBe('enforced');
  });

  it('近一周 → publishedAfter = 现在 - 168 小时 + 复核', () => {
    expect(p.queries[0]!.params.publishedAfter).toBe(toRfc3339(NOW - 168 * 3_600_000));
    expect(p.withinHours).toBe(168);
  });

  it('带字幕 → videoCaption=closedCaption + 复核；注明不含自动字幕', () => {
    expect(p.queries[0]!.params.videoCaption).toBe('closedCaption');
    const ds = p.dispositions[byKind('caption').id]!;
    expect(JSON.stringify(ds)).toContain('自动生成字幕');
  });

  it('不要 Shorts → 后置过滤，并说明判定规则', () => {
    const ds = p.dispositions[byKind('exclude_shorts').id]!;
    expect(types(ds)).toEqual(['post_filter']);
    expect(p.postFilters.some((f) => f.kind === 'not_shorts')).toBe(true);
  });

  it('访谈 → 排序因子（近似），并诚实说明无法可靠判定形式', () => {
    const ds = p.dispositions[byKind('format').id]!;
    expect(types(ds)).toContain('rank_factor');
    expect(p.coverage[byKind('format').id]).toBe('approximate');
    expect(JSON.stringify(ds)).toContain('近似');
  });

  it('单次口令 search 次数不超过预算', () => {
    expect(p.estimatedCost.searchCalls).toBeLessThanOrEqual(3);
    expect(p.estimatedCost.generalUnits).toBeLessThanOrEqual(50);
  });
});

describe('验收口令 1：两天内最新的 AI 技术科普', () => {
  const intent = assembleIntent(UTTERANCE_1, RAW_1, NOW, 0);
  const p = plan(intent);

  it('时效落成 publishedAfter，"最新"落成新鲜度排序，不用 order=date', () => {
    expect(p.queries[0]!.params.publishedAfter).toBe(toRfc3339(NOW - 48 * 3_600_000));
    expect(p.queries[0]!.params.order).toBeUndefined();
    expect(p.rank.freshness).toBe(true);
  });

  it('未指定语言时中英文检索词各一条，并在 notes 中说明', () => {
    expect(p.queries.map((q) => q.params.relevanceLanguage)).toEqual(['zh-Hans', 'en']);
    expect(p.notes.join()).toContain('未指定语言');
  });

  it('原句中没有遗漏的片段', () => {
    expect(intent.constraints.every((c) => c.source === 'llm')).toBe(true);
  });
});

describe('守卫：LLM 漏掉约束时由本地规则补上', () => {
  it('LLM 漏了"带字幕"和"不要 Shorts" → 规则补入并注明来源', () => {
    const raw = rawIntent(
      [rc({ kind: 'topic', span: 'AI 安全', terms: ['AI safety'] }), rc({ kind: 'language', span: '英文', language: 'en' })],
      [{ q: 'AI safety', language: 'en' }],
    );
    const intent = assembleIntent('英文、带字幕、不要 Shorts 的 AI 安全', raw, NOW, 0);
    const added = intent.constraints.filter((c) => c.source === 'rule').map((c) => c.kind);
    expect(added.sort()).toEqual(['caption', 'exclude_shorts']);
    expect(intent.notes.some((n) => n.includes('本地规则补充'))).toBe(true);
    const p = plan(intent);
    for (const c of intent.constraints) expect(p.dispositions[c.id]!.length).toBeGreaterThan(0);
  });

  it('没人认领的片段 → "其他要求（仅作参考）"，不会消失', () => {
    const raw = rawIntent([rc({ kind: 'topic', span: '量子计算', terms: ['量子计算'] })], [{ q: '量子计算', language: 'zh' }]);
    const intent = assembleIntent('量子计算，主讲人最好是女性科学家', raw, NOW, 0);
    const other = intent.constraints.find((c) => c.source === 'coverage');
    expect(other?.kind).toBe('other');
    expect(other?.span).toContain('主讲人');
    const p = plan(intent);
    expect(p.coverage[other!.id]).toBe('reference_only');
  });

  it('无法近似的要求 → 明确标注"无法满足"', () => {
    const raw = rawIntent(
      [rc({ kind: 'topic', span: '宇宙', terms: ['宇宙'] }), rc({ kind: 'other', span: '不要 AI 配音', description: '排除使用 AI 合成配音的视频' })],
      [{ q: '宇宙 科普', language: 'zh' }],
    );
    const intent = assembleIntent('宇宙，不要 AI 配音', raw, NOW, 0);
    const p = plan(intent);
    const other = intent.constraints.find((c) => c.kind === 'other')!;
    expect(p.coverage[other.id]).toBe('unsupported');
    expect(types(p.dispositions[other.id])).toEqual(['unsupported']);
  });

  it('要 4K → 高清已落实、4K 标注无法满足（部分落实）', () => {
    const raw = rawIntent([rc({ kind: 'definition', span: '4K', terms: ['4K'] })], [{ q: 'nature', language: 'en' }]);
    const intent = assembleIntent('4K nature', raw, NOW, 0);
    const p = plan(intent);
    const c = intent.constraints.find((x) => x.kind === 'definition')!;
    expect(p.coverage[c.id]).toBe('partial');
    expect(p.queries[0]!.params.videoDefinition).toBe('high');
  });
});

describe('规范化：无效字段降级为"其他要求"而不是丢弃', () => {
  it('未知类别', () => {
    const c = normalizeConstraint(rc({ kind: 'mood', span: '轻松一点', description: '氛围轻松' }), 'c1');
    expect(c.kind).toBe('other');
    expect(c.normalizationNote).toContain('未知约束类别');
  });
  it('无效语言代码', () => {
    const c = normalizeConstraint(rc({ kind: 'language', span: '火星语', language: 'martian!!' }), 'c1');
    expect(c.kind).toBe('other');
  });
  it('时长下限大于上限', () => {
    const c = normalizeConstraint(rc({ kind: 'duration', span: 'x', minMinutes: 30, maxMinutes: 10 }), 'c1');
    expect(c.kind).toBe('other');
  });
});

describe('仅订阅频道：未同步画像时明确标注无法满足', () => {
  it('profileSynced=false', () => {
    const raw = rawIntent([rc({ kind: 'subscriptions_only', span: '我订阅的' })], [{ q: 'ai', language: '' }]);
    const intent = assembleIntent('我订阅的 ai', raw, NOW, 0);
    const p = plan(intent, { profileSynced: false });
    const c = intent.constraints.find((x) => x.kind === 'subscriptions_only')!;
    expect(p.coverage[c.id]).toBe('unsupported');
  });
});

describe('辅助逻辑', () => {
  it('videoDuration 档位推导', () => {
    expect(deriveVideoDuration(60)).toBe('long');
    expect(deriveVideoDuration(undefined, 3)).toBe('short');
    expect(deriveVideoDuration(5, 15)).toBe('medium');
    expect(deriveVideoDuration(10)).toBeUndefined();
  });
  it('覆盖状态', () => {
    expect(coverageStatus([{ type: 'api_param', param: 'a', value: 'b' }])).toBe('enforced');
    expect(coverageStatus([{ type: 'rank_factor', detail: '' }])).toBe('approximate');
    expect(coverageStatus([{ type: 'reference_only', reason: '' }])).toBe('reference_only');
    expect(coverageStatus([{ type: 'unsupported', reason: '' }])).toBe('unsupported');
    expect(coverageStatus([{ type: 'post_filter', detail: '' }, { type: 'unsupported', reason: '' }])).toBe('partial');
    expect(coverageStatus([])).toBe('unsupported');
  });
  it('定位片段忽略空白与大小写', () => {
    expect(locateSpan('不要 Shorts 的', '不要shorts')).toEqual({ start: 0, end: 9 });
  });
  it('填充词不会被当成遗漏', () => {
    expect(leftoverSegments('帮我找一些相关的视频吧', [])).toEqual([]);
  });
  it('规则提取器识别验收口令 2 的全部可识别约束', () => {
    const kinds = extractByRules(UTTERANCE_2).map((h) => h.raw.kind);
    expect(kinds).toEqual(expect.arrayContaining(['language', 'duration', 'recency', 'caption', 'exclude_shorts', 'format']));
    const dur = extractByRules(UTTERANCE_2).find((h) => h.raw.kind === 'duration')!;
    expect(dur.raw.minMinutes).toBe(60);
    const rec = extractByRules(UTTERANCE_2).find((h) => h.raw.kind === 'recency')!;
    expect(rec.raw.withinHours).toBe(168);
  });
  it('规则提取器：两天内 = 48 小时；英文时长表达', () => {
    expect(extractByRules('两天内的新闻').find((h) => h.raw.kind === 'recency')?.raw.withinHours).toBe(48);
    expect(extractByRules('talks over an hour from the past 3 days').map((h) => [h.raw.kind, h.raw.minMinutes || h.raw.withinHours])).toEqual(
      expect.arrayContaining([
        ['duration', 60],
        ['recency', 72],
      ]),
    );
  });
});
