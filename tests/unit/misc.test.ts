import { describe, expect, it } from 'vitest';
import { formatDuration, formatRelative, parseIsoDuration } from '../../src/core/time';
import { formatCount } from '../../src/core/format';
import { redact } from '../../src/core/redact';
import { buildClusterPrompt, buildIntentPrompt } from '../../src/core/prompts';
import { mergeClusterOutput, moveChannel, editCluster } from '../../src/core/clusters';
import { containsTerm, dominantScript } from '../../src/core/text';
import { NOW, makeCluster } from './helpers';

describe('时间与格式', () => {
  it('ISO 8601 时长', () => {
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('PT45S')).toBe(45);
    expect(parseIsoDuration('P1DT1H')).toBe(90000);
    expect(parseIsoDuration('P0D')).toBe(0);
    expect(parseIsoDuration('garbage')).toBe(0);
  });
  it('展示格式', () => {
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatCount(8523)).toBe('8,523');
    expect(formatCount(123_456)).toBe('12.3 万');
    expect(formatCount(340_000_000)).toBe('3.4 亿');
    expect(formatRelative(NOW - 3 * 3_600_000, NOW)).toBe('3 小时前');
  });
  it('词项匹配：中文子串、英文词边界', () => {
    expect(containsTerm('大模型原理讲解', '大模型')).toBe(true);
    expect(containsTerm('Explained: AI safety', 'AI')).toBe(true);
    expect(containsTerm('MAIN street', 'AI')).toBe(false);
    expect(dominantScript('Transformer 原理')).toBe('han');
    expect(dominantScript('How transformers work')).toBe('latin');
  });
});

describe('脱敏：密钥与令牌不进入报错信息', () => {
  it('已知密钥值与常见格式都被替换', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
    const msg = `401 invalid x-api-key: ${key}; Authorization: Bearer ya29.a0AfB_byC123456789 url?key=AIzaSyA1234567890abcdefghij&x=1`;
    const out = redact(msg, [key]);
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out).not.toContain('ya29.a0AfB');
    expect(out).not.toContain('AIzaSyA1234567890');
    expect(out).toContain('[已隐藏]');
  });
});

describe('发给 LLM 的内容：数据最小化', () => {
  it('意图解析只含口令、时间、兴趣簇名与关键词、理解纠正', () => {
    const { system, user } = buildIntentPrompt({
      utterance: '帮我找 AI 视频',
      nowIso: '2026-10-24T10:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      clusters: [{ name: 'AI 研究', keywords: ['LLM'] }],
      corrections: [
        { id: 'x', at: NOW, utterance: '找 AI 科普', constraint: { kind: 'format', span: '科普', label: '形式：科普讲解' }, note: '我要的是入门级', active: true },
      ],
    });
    expect(user).toBe('帮我找 AI 视频');
    expect(system).toContain('AI 研究');
    expect(system).toContain('我要的是入门级');
  });

  it('聚类：频道用本地编号，不发送真实频道 ID', () => {
    const { system, user, refs } = buildClusterPrompt({
      channels: [{ id: 'UCsecretChannelId123', title: 'Two Minute Papers', description: 'AI research', topicCategories: ['https://en.wikipedia.org/wiki/Technology'] }],
      likedVideos: [{ id: 'videoIdXYZ', title: 'GPT explained', channelId: 'UCsecretChannelId123', channelTitle: 'Two Minute Papers', publishedAt: '', tags: [] }],
      locked: [],
    });
    expect(system + user).not.toContain('UCsecretChannelId123');
    expect(system + user).not.toContain('videoIdXYZ');
    expect(user).toContain('c1 | Two Minute Papers');
    expect(user).toContain('Technology');
    expect(refs.get('c1')).toBe('UCsecretChannelId123');
  });
});

describe('兴趣簇', () => {
  it('合并 LLM 输出：锁定簇保留，未知编号忽略，频道不重复归属', () => {
    const locked = makeCluster({ id: 'L', name: '我的 AI', locked: true, channelIds: ['A'] });
    let n = 0;
    const merged = mergeClusterOutput(
      { clusters: [
        { name: '我的 AI', description: '', keywords: [], channelRefs: ['c2'] },
        { name: '音乐', description: '听歌', keywords: ['music'], channelRefs: ['c1', 'c3', 'c99'] },
      ] },
      new Map([['c1', 'A'], ['c2', 'B'], ['c3', 'C']]),
      [locked],
      NOW,
      () => `n${++n}`,
    );
    expect(merged.find((c) => c.id === 'L')!.channelIds).toEqual(['A', 'B']);
    expect(merged.find((c) => c.name === '音乐')!.channelIds).toEqual(['C']);
  });
  it('编辑与移动频道会自动加锁', () => {
    const cs = [makeCluster({ id: 'a', channelIds: ['X'] }), makeCluster({ id: 'b', name: '其他' })];
    const moved = moveChannel(cs, 'X', 'b', NOW);
    expect(moved.find((c) => c.id === 'b')!.channelIds).toEqual(['X']);
    expect(moved.every((c) => c.locked)).toBe(true);
    expect(editCluster(cs, 'a', { name: '新名字' }, NOW)[0]).toMatchObject({ name: '新名字', locked: true });
  });
});
