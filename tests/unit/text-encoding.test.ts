// 截断与编码：不把 emoji 劈成两半，发给大模型的文本一定是合法 UTF-16（否则服务端拒收整个请求）。
// 复现：生成兴趣簇时频道简介按 120 字截断，正好切在 emoji 中间 → Anthropic 400 "unexpected end of hex escape"。

import { describe, expect, it } from 'vitest';
import { buildClusterPrompt } from '../../src/core/prompts';
import { clip, truncate, wellFormed } from '../../src/core/text';

const EMOJI = '😀'; // 占 2 个 UTF-16 单元
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe('不劈开 emoji 的截断', () => {
  it('截断点落在 emoji 中间：整颗 emoji 一起去掉', () => {
    const s = 'a'.repeat(119) + EMOJI + 'b';
    expect(s.slice(0, 120)).toMatch(LONE); // 旧写法会留下半个 emoji
    expect(clip(s, 120)).toBe('a'.repeat(119));
    expect(truncate(s, 120)).toBe(`${'a'.repeat(119)}…`);
  });

  it('截断点刚好在 emoji 之后：保留整颗 emoji', () => {
    const s = 'a'.repeat(118) + EMOJI + 'b';
    expect(clip(s, 120)).toBe('a'.repeat(118) + EMOJI);
  });

  it('不超长时原样返回', () => {
    expect(clip(`短${EMOJI}`, 10)).toBe(`短${EMOJI}`);
    expect(truncate(`短${EMOJI}`, 10)).toBe(`短${EMOJI}`);
  });
});

describe('兜底清洗孤立代理项', () => {
  it('孤立的高位 / 低位代理换成 U+FFFD，成对的保持不变', () => {
    expect(wellFormed('x\ud83d')).toBe('x�');
    expect(wellFormed('\ude00y')).toBe('�y');
    expect(wellFormed(`ok${EMOJI}好`)).toBe(`ok${EMOJI}好`);
    expect(wellFormed('\ud83d😀')).toBe(`�${EMOJI}`);
  });
});

describe('兴趣簇提示词', () => {
  it('频道简介与视频标题在截断边界上带 emoji，也不会产生半个字符', () => {
    const p = buildClusterPrompt({
      channels: [{ id: 'UC1', title: `频道${EMOJI}`, description: 'a'.repeat(119) + EMOJI + '后面还有很多介绍', topicCategories: [] }],
      likedVideos: [{ id: 'v1', title: 't'.repeat(99) + EMOJI + '尾巴', channelId: 'UC1', channelTitle: '频道', publishedAt: '', tags: [] }],
      locked: [],
    });
    expect(p.user).not.toMatch(LONE);
    expect(p.system).not.toMatch(LONE);
    expect(JSON.stringify(p.user)).not.toMatch(/\\ud[89a-f]/i);
  });
});
