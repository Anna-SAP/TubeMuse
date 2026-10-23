import { describe, expect, it } from 'vitest';
import { applyCorrection, classifyNature, EMPTY_RULES, windowStats } from '../../src/core/nature';
import { dueSummaryDays, dueWeeklyReport, nextDailyRun, zonedTime, weekEndingOn, addDays } from '../../src/core/schedule';
import { evaluateReminder, triggerReminder, muteReminder, disableReminder, dismissReminder } from '../../src/core/reminder';
import { aggregateTakeout, parseTakeoutWatchHistory } from '../../src/core/takeout';
import { buildDailySummary, promptItems, renderMemoryLibrary, summarizeAdjustments, buildWeeklyReport, weeklyCases, type DayEntry } from '../../src/core/summary';
import { buildDailySummaryPrompt } from '../../src/core/prompts';
import { DEFAULT_SETTINGS } from '../../src/config/defaults';
import type { Adjustment, VideoMeta, WatchRecord } from '../../src/core/types';
import { makeCluster } from './helpers';

const TZ = 'Asia/Shanghai';
const NOW = Date.parse('2026-10-24T02:00:00Z'); // 北京时间 10:00
const DAY = 86_400_000;

function meta(over: Partial<VideoMeta> = {}): VideoMeta {
  return { id: 'v1', title: 'Some video', channelId: 'ch1', channelTitle: 'Chan', durationSec: 600, tags: [], fetchedAt: NOW, ...over };
}

function record(over: Partial<WatchRecord> = {}): WatchRecord {
  return {
    day: '2026-10-24',
    videoId: 'v1',
    sessionIds: ['s1'],
    firstAt: NOW,
    lastAt: NOW,
    durationSec: 600,
    completion: 1,
    playSec: 600,
    fgSec: 600,
    bgSec: 0,
    status: 'completed',
    background: false,
    shorts: false,
    ...over,
  };
}

describe('学习 / 娱乐判定：可解释、可纠正', () => {
  it('YouTube 分类 + 标题关键词 → 学习，并写明依据', () => {
    const v = classifyNature('v1', meta({ categoryId: '27', title: 'Transformer 原理讲解' }), false, [], EMPTY_RULES);
    expect(v.nature).toBe('learning');
    expect(v.reasons.join()).toContain('教育');
    expect(v.reasons.join()).toContain('讲解');
  });
  it('游戏分类 + Shorts → 娱乐', () => {
    expect(classifyNature('v1', meta({ categoryId: '20' }), true, [], EMPTY_RULES).nature).toBe('entertainment');
  });
  it('中性信号 → 其他', () => {
    expect(classifyNature('v1', meta({ categoryId: '22' }), false, [], EMPTY_RULES).nature).toBe('other');
  });
  it('兴趣簇倾向参与判定', () => {
    const c = makeCluster({ channelIds: ['ch1'], nature: 'learning' });
    const v = classifyNature('v1', meta({ categoryId: '22' }), false, [c], EMPTY_RULES);
    expect(v.nature).toBe('learning');
    expect(v.reasons[0]).toContain('兴趣簇');
  });
  it('用户纠正优先：视频 > 频道 > 信号', () => {
    let rules = applyCorrection(EMPTY_RULES, 'v1', 'entertainment', { id: 'ch1', title: 'Chan' });
    expect(classifyNature('v1', meta({ categoryId: '27' }), false, [], rules)).toMatchObject({ nature: 'entertainment', source: 'user_channel' });
    rules = applyCorrection(rules, 'v1', 'learning');
    expect(classifyNature('v1', meta({ categoryId: '27' }), false, [], rules)).toMatchObject({ nature: 'learning', source: 'user_video' });
    expect(classifyNature('v2', meta({ id: 'v2', categoryId: '27' }), false, [], rules).nature).toBe('entertainment');
  });
  it('没有元数据时如实说明', () => {
    expect(classifyNature('v1', undefined, false, [], EMPTY_RULES).reasons[0]).toContain('元数据');
  });
  it('滚动 7 天占比按有效观看时长计算', () => {
    const log = {
      '2026-10-24': { a: record({ videoId: 'a', playSec: 700 }), b: record({ videoId: 'b', playSec: 100 }) },
      '2026-10-20': { c: record({ videoId: 'c', playSec: 200 }) },
      '2026-10-10': { d: record({ videoId: 'd', playSec: 9999 }) },
    };
    const s = windowStats(log, (r) => (r.videoId === 'b' ? 'learning' : 'entertainment'), NOW, 7, TZ);
    expect(s.totalSec).toBe(1000);
    expect(s.entertainmentRatio).toBeCloseTo(0.9);
    expect(s.learningRatio).toBeCloseTo(0.1);
    expect(s.fromDay).toBe('2026-10-18');
  });
});

describe('定时：到点生成、浏览器没开时补算', () => {
  it('下一次 23:00（本地时区）', () => {
    expect(new Date(nextDailyRun(NOW, '23:00', TZ)).toISOString()).toBe('2026-10-24T15:00:00.000Z');
    expect(new Date(nextDailyRun(Date.parse('2026-10-24T15:30:00Z'), '23:00', TZ)).toISOString()).toBe('2026-10-25T15:00:00.000Z');
  });
  it('夏令时地区：23:00 落在正确的 UTC 时刻', () => {
    expect(new Date(zonedTime('2026-11-01', '23:00', 'America/Los_Angeles')).toISOString()).toBe('2026-11-02T07:00:00.000Z');
    expect(new Date(zonedTime('2026-10-31', '23:00', 'America/Los_Angeles')).toISOString()).toBe('2026-11-01T06:00:00.000Z');
  });
  it('浏览器关了三天：补算错过的每一天（最多 7 天）', () => {
    const jobs = dueSummaryDays(NOW, '23:00', TZ, { '2026-10-20': { generatedAt: 0, manual: false } }, 7, '2026-10-20');
    expect(jobs.map((j) => j.day)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
  });
  it('白天手动生成过的总结：到点后按完整的一天重新生成', () => {
    const manualAt = Date.parse('2026-10-23T08:00:00Z');
    const jobs = dueSummaryDays(NOW, '23:00', TZ, { '2026-10-23': { generatedAt: manualAt, manual: true } }, 2, undefined);
    expect(jobs).toEqual([{ day: '2026-10-23', regenerate: true }]);
  });
  it('周报：周日 23:00 之后生成该周；之前不生成', () => {
    expect(weekEndingOn('2026-10-24', 0)).toBe('2026-10-25');
    expect(dueWeeklyReport(NOW, '23:00', 0, TZ, new Set())).toBe('2026-10-18');
    expect(dueWeeklyReport(NOW, '23:00', 0, TZ, new Set(['2026-10-18']))).toBeUndefined();
    expect(dueWeeklyReport(Date.parse('2026-10-25T15:30:00Z'), '23:00', 0, TZ, new Set(['2026-10-18']))).toBe('2026-10-25');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
  });
});

describe('导师提醒：触发一次、间隔 3 天、可静音或关闭', () => {
  const S = DEFAULT_SETTINGS.reminder;
  const heavy = { fromDay: 'a', toDay: 'b', totalSec: 3600, learningSec: 100, entertainmentSec: 3000, otherSec: 500, learningRatio: 100 / 3600, entertainmentRatio: 3000 / 3600 };
  it('娱乐 > 70% 且学习 < 15% → 触发', () => {
    expect(evaluateReminder({}, heavy, S, NOW)).toEqual({ trigger: true });
  });
  it('触发后 3 天内不再触发；3 天后可以', () => {
    const st = triggerReminder({}, heavy, 7, undefined, NOW, 'r1');
    expect(evaluateReminder(st, heavy, S, NOW + DAY)).toMatchObject({ trigger: false });
    expect(evaluateReminder(st, heavy, S, NOW + 3 * DAY)).toEqual({ trigger: true });
  });
  it('静音 7 天 / 永久关闭 / 设置关闭', () => {
    expect(evaluateReminder(muteReminder({}, 7, NOW), heavy, S, NOW + 6 * DAY)).toMatchObject({ trigger: false });
    expect(evaluateReminder(muteReminder({}, 7, NOW), heavy, S, NOW + 8 * DAY)).toEqual({ trigger: true });
    expect(evaluateReminder(disableReminder({}), heavy, S, NOW)).toMatchObject({ trigger: false });
    expect(evaluateReminder({}, heavy, { ...S, enabled: false }, NOW)).toMatchObject({ trigger: false });
  });
  it('学习占比够高或总时长太短不触发', () => {
    expect(evaluateReminder({}, { ...heavy, learningRatio: 0.2 }, S, NOW)).toMatchObject({ trigger: false });
    expect(evaluateReminder({}, { ...heavy, totalSec: 120 }, S, NOW)).toMatchObject({ trigger: false });
  });
  it('关闭横幅只是隐藏，不影响间隔', () => {
    const st = dismissReminder(triggerReminder({}, heavy, 7, undefined, NOW, 'r1'));
    expect(st.active?.dismissed).toBe(true);
    expect(st.lastTriggeredAt).toBe(NOW);
  });
  it('文案语气轻、不说教，带具体台阶', () => {
    const st = triggerReminder({}, heavy, 7, { kind: 'video', title: 't', videoId: 'x', why: 'w' }, NOW, 'r1');
    expect(st.active!.message).toContain('放松挺好的');
    expect(st.active!.message).not.toMatch(/应该|必须|浪费/);
  });
});

describe('每日总结与周报', () => {
  const entries: DayEntry[] = [
    { record: record({ videoId: 'a', status: 'completed', playSec: 900 }), meta: meta({ id: 'a', title: '大模型原理讲解', categoryId: '27' }), nature: 'learning' },
    { record: record({ videoId: 'b', status: 'partial', completion: 0.5, playSec: 400 }), meta: meta({ id: 'b', title: '分布式系统课程 第 3 讲' }), nature: 'learning' },
    { record: record({ videoId: 'c', status: 'glance', completion: 0.02, playSec: 5 }), meta: meta({ id: 'c', title: '搞笑合集' }), nature: 'entertainment' },
  ];
  it('瞥一眼的不发给 LLM，直接进"只是路过"；LLM 引用不存在的条目被丢弃并注明', () => {
    const { items, refs } = promptItems(entries);
    expect(items.map((i) => i.title)).toEqual(['大模型原理讲解', '分布式系统课程 第 3 讲']);
    const s = buildDailySummary(
      '2026-10-24',
      entries,
      { headline: '今天在补大模型基础', learned: [{ ref: 'v1', takeaway: '理解了注意力机制' }, { ref: 'v9', takeaway: '编造的' }], revisit: [{ ref: 'v2', reason: '只看了一半' }], goalLink: '推进了目标' },
      refs,
      { now: NOW, manual: false, goals: '学大模型' },
    );
    expect(s.learned.map((i) => i.videoId)).toEqual(['a']);
    expect(s.revisit.map((i) => i.videoId)).toEqual(['b']);
    expect(s.passingBy.map((i) => i.videoId)).toEqual(['c']);
    expect(s.notes.join()).toContain('不存在');
    expect(s.stats).toMatchObject({ completed: 1, partial: 1, glance: 1 });
    for (const h of ['## 今日学了什么', '## 值得回看', '## 只是路过', '## 与近期目标的关联']) expect(s.markdown).toContain(h);
  });
  it('没有观看记录的日子：不调用 LLM 也能生成', () => {
    const s = buildDailySummary('2026-10-24', [], undefined, new Map(), { now: NOW, manual: false, goals: '' });
    expect(s.headline).toContain('没有观看记录');
  });
  it('提示词不含视频 ID，带前 7 天总结与目标', () => {
    const { items } = promptItems(entries);
    const p = buildDailySummaryPrompt({ day: '2026-10-24', goals: '学大模型', items, previous: [{ day: '2026-10-23', headline: '昨天看了 RAG', learned: ['RAG 基础'] }], utterances: ['找 RAG 教程'] });
    expect(p.user).not.toMatch(/\ba\b \|/);
    expect(p.user).toContain('学大模型');
    expect(p.user).toContain('昨天看了 RAG');
  });
  it('周报："本周已自动调整了什么"按净变化汇总，撤销的不算', () => {
    const adj = (over: Partial<Adjustment>): Adjustment => ({
      id: 'x',
      at: NOW,
      trigger: { videoId: 'v', title: 'T', rating: 3, attribution: 'retrieval', searchId: 's', utterance: 'u' },
      changes: [],
      reverted: false,
      ...over,
    });
    const lines = summarizeAdjustments([
      adj({ changes: [{ type: 'channelPref', channelId: 'c1', channelTitle: '流量号', before: 0, after: -0.22, explanation: '' }] }),
      adj({ changes: [{ type: 'channelPref', channelId: 'c1', channelTitle: '流量号', before: -0.22, after: -0.44, explanation: '' }] }),
      adj({ reverted: true, changes: [{ type: 'channelPref', channelId: 'c2', channelTitle: '别的', before: 0, after: 0.4, explanation: '' }] }),
    ]);
    expect(lines[0]).toContain('「流量号」-0.44');
    expect(lines.join()).not.toContain('别的');
    expect(lines.join()).toContain('撤销了 1 次');
  });
  it('周报 Markdown 与记忆库', () => {
    const stats = { fromDay: '2026-10-12', toDay: '2026-10-18', totalSec: 7200, learningSec: 3600, entertainmentSec: 3600, otherSec: 0, learningRatio: 0.5, entertainmentRatio: 0.5 };
    const { refs } = weeklyCases([], 5);
    const w = buildWeeklyReport('2026-10-18', '2026-10-12', stats, 0, refs, [], undefined, NOW);
    expect(w.markdown).toContain('没有低分');
    const daily = buildDailySummary('2026-10-24', [], undefined, new Map(), { now: NOW, manual: false, goals: '' });
    const lib = renderMemoryLibrary([daily], [w], NOW);
    expect(lib.indexOf('2026-10-24 学习总结')).toBeLessThan(lib.indexOf('每周自省'));
  });
});

describe('Takeout 导入', () => {
  const sample = [
    { header: 'YouTube', title: 'Watched How transformers work', titleUrl: 'https://www.youtube.com/watch?v=abcdefghijk', subtitles: [{ name: 'Explain Lab', url: 'https://www.youtube.com/channel/UCexplainLab00000001' }], time: '2026-10-20T10:00:00.000Z' },
    { header: 'YouTube', title: '观看了 大模型原理', titleUrl: 'https://www.youtube.com/watch?v=bcdefghijkl', subtitles: [{ name: 'Explain Lab', url: 'https://www.youtube.com/channel/UCexplainLab00000001' }], time: '2026-10-21T10:00:00.000Z' },
    { header: 'YouTube', title: 'Watched Ad', titleUrl: 'https://www.youtube.com/watch?v=cdefghijklm', time: '2026-10-21T10:00:00.000Z', details: [{ name: 'From Google Ads' }] },
    { header: 'YouTube', title: 'Watched a video that has been removed', time: '2026-10-21T10:00:00.000Z' },
  ];
  it('跳过广告与已删除视频，去掉"Watched / 观看了"前缀，按频道计数', () => {
    const { entries, skipped } = parseTakeoutWatchHistory(sample);
    expect(entries.map((e) => e.title)).toEqual(['How transformers work', '大模型原理']);
    expect(skipped).toEqual({ ads: 1, noVideo: 1, invalid: 0 });
    const p = aggregateTakeout(entries, skipped, NOW);
    expect(p.channels[0]).toMatchObject({ channelId: 'UCexplainLab00000001', count: 2 });
    expect(p.lastWatched).toBe('2026-10-21T10:00:00.000Z');
  });
  it('不是数组 → 人话报错', () => {
    expect(() => parseTakeoutWatchHistory({})).toThrow(/JSON/);
  });
});

describe('LLM 输出校验', () => {
  it('条目字段不是字符串时判为格式不对（不会在后续处理时崩溃）', async () => {
    const { isDailyLlmOutput, isWeeklyLlmOutput } = await import('../../src/core/summary');
    expect(isDailyLlmOutput({ headline: 'h', goalLink: 'g', learned: [{ ref: null, takeaway: 'x' }], revisit: [] })).toBe(false);
    expect(isDailyLlmOutput({ headline: 'h', goalLink: 'g', learned: [{ ref: 'v1', takeaway: 'x' }], revisit: [] })).toBe(true);
    expect(isWeeklyLlmOutput({ overview: 'o', patterns: [{ pattern: 'p', suggestion: 's', refs: [undefined] }] })).toBe(false);
  });
});
