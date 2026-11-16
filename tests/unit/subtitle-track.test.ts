// "保存完整双语视频"里的原声字幕（DECISIONS §84）：读字幕文件（.srt / .vtt）、整理、排成 MP4 字幕轨的样本、另存 .srt、YouTube 上取哪一条轨。

import { describe, expect, it } from 'vitest';
import type { CcTrack, CcTrackList } from '../../src/core/multi-captions';
import {
  SUB_SOURCE_LABELS,
  SubtitleFileError,
  cuesFromSamples,
  decodeTextSample,
  encodeTextSample,
  mp4Language,
  parseSubtitleFile,
  pickOriginalTrack,
  subtitleSamples,
  tidyCues,
  toSrt,
} from '../../src/core/subtitle-track';

const SRT = `1
00:00:00,500 --> 00:00:03,000
So in college,

2
00:00:03,100 --> 00:00:06,000
<i>I was a government major,</i>

3
00:00:06,200 --> 00:00:10,000
{\\an8}which means I had to write
a lot of papers.
`;

describe('读字幕文件', () => {
  it('SRT：序号、时间、多行、样式标记', () => {
    expect(parseSubtitleFile(SRT)).toEqual([
      { start: 0.5, end: 3, text: 'So in college,' },
      { start: 3.1, end: 6, text: 'I was a government major,' },
      { start: 6.2, end: 10, text: 'which means I had to write\na lot of papers.' },
    ]);
  });
  it('SRT：块之间没有空行、Windows 换行、开头带 BOM、一小时以上的时间也认', () => {
    const tight = '﻿1\r\n01:02:03,004 --> 01:02:05,000\r\nHello\r\n2\r\n01:02:05,500 --> 01:02:07,000\r\nWorld &amp; all\r\n';
    expect(parseSubtitleFile(tight)).toEqual([
      { start: 3723.004, end: 3725, text: 'Hello' },
      { start: 3725.5, end: 3727, text: 'World & all' },
    ]);
  });
  it('WebVTT：文件头、NOTE / STYLE 块、位置设置、不带小时的时间、逐词时间标记', () => {
    const vtt = `WEBVTT
Kind: captions
Language: en

NOTE this is a comment
that spans lines

STYLE
::cue { color: white }

intro
00:01.000 --> 00:02.500 align:start position:0%
Hello<00:00:01.400><c> world</c>

00:00:03.000 --> 00:00:04.000
&lt;tag&gt; &nbsp;done
`;
    expect(parseSubtitleFile(vtt)).toEqual([
      { start: 1, end: 2.5, text: 'Hello world' },
      { start: 3, end: 4, text: '<tag> done' },
    ]);
  });
  it('不是字幕文件、一句都没有：说清楚', () => {
    expect(() => parseSubtitleFile('just some text\nwithout timings')).toThrow(SubtitleFileError);
    expect(() => parseSubtitleFile('just some text')).toThrow(/一句字幕都没读到/);
    expect(() => parseSubtitleFile('{"events":[]}')).toThrow(/不是 .srt 或 .vtt/);
    expect(() => parseSubtitleFile('<?xml version="1.0"?><tt></tt>')).toThrow(/不是 .srt 或 .vtt/);
    expect(new SubtitleFileError('x', 'y')).toMatchObject({ name: 'SubtitleFileError', hint: 'y' });
  });
});

describe('整理：一次只显示一句，不重复', () => {
  it('YouTube 自动字幕导出的 .vtt：每句都带着上一句当第一行，中间夹着一闪而过的过渡句——还原成一句接一句', () => {
    // yt-dlp --write-auto-subs 存下来的样子
    const vtt = `WEBVTT

00:00:00.160 --> 00:00:02.389 align:start position:0%
 
all<00:00:00.480><c> code</c><00:00:00.800><c> is</c><00:00:01.120><c> slop</c>

00:00:02.389 --> 00:00:02.399 align:start position:0%
all code is slop
 

00:00:02.399 --> 00:00:04.710 align:start position:0%
all code is slop
except<00:00:02.800><c> mine</c>

00:00:04.710 --> 00:00:04.720 align:start position:0%
except mine
 

00:00:04.720 --> 00:00:07.000 align:start position:0%
except mine
thank<00:00:05.200><c> you</c>
`;
    expect(tidyCues(parseSubtitleFile(vtt))).toEqual([
      { start: 0.16, end: 2.399, text: 'all code is slop' },
      { start: 2.399, end: 4.72, text: 'except mine' },
      { start: 4.72, end: 7, text: 'thank you' },
    ]);
  });
  it('隔了一会儿又说同一句话：是真的又说了一遍，留着', () => {
    expect(
      tidyCues([
        { start: 1, end: 2, text: 'No.' },
        { start: 5, end: 6, text: 'No.' },
      ]),
    ).toHaveLength(2);
  });
  it('时间重叠的两句：前一句让到后一句开始为止；乱序的排好；空的、时间不对的丢掉；超出全片的截掉', () => {
    const out = tidyCues(
      [
        { start: 8, end: 12, text: 'third' },
        { start: 0, end: 5, text: 'first' },
        { start: 4, end: 8, text: 'second' },
        { start: 9, end: 9, text: 'zero length' },
        { start: 3, end: 4, text: '   ' },
        { start: 20, end: 25, text: 'after the end' },
      ],
      10,
    );
    expect(out).toEqual([
      { start: 0, end: 4, text: 'first' },
      { start: 4, end: 8, text: 'second' },
      { start: 8, end: 10, text: 'third' },
    ]);
  });
});

describe('排成 MP4 字幕轨的样本', () => {
  it('首尾相接铺满全片：句子之间、开头、结尾的空档是空样本；时间单位是毫秒', () => {
    const samples = subtitleSamples(
      [
        { start: 0.5, end: 3, text: 'a' },
        { start: 3, end: 6, text: 'b' },
        { start: 7.25, end: 9, text: 'c' },
      ],
      16,
    );
    expect(samples).toEqual([
      { duration: 500, text: '' },
      { duration: 2500, text: 'a' },
      { duration: 3000, text: 'b' },
      { duration: 1250, text: '' },
      { duration: 1750, text: 'c' },
      { duration: 7000, text: '' },
    ]);
    expect(samples.reduce((n, x) => n + x.duration, 0)).toBe(16000);
    expect(subtitleSamples([], 16)).toEqual([{ duration: 16000, text: '' }]);
  });
  it('一个样本 = 2 字节长度 + UTF-8 文字；读回来一样（中文、换行、表情都行）；空样本是两个 0', () => {
    const text = '第一行 line one\n第二行 😀';
    const bytes = encodeTextSample(text);
    expect((bytes[0]! << 8) | bytes[1]!).toBe(bytes.length - 2);
    expect(decodeTextSample(bytes)).toBe(text);
    expect(Array.from(encodeTextSample(''))).toEqual([0, 0]);
    expect(decodeTextSample(new Uint8Array([0, 0]))).toBe('');
    // 后面跟着样式盒子（别的工具写的）：只取文字
    expect(decodeTextSample(new Uint8Array([0, 2, 0x48, 0x69, 0, 0, 0, 12, 0x73, 0x74, 0x79, 0x6c]))).toBe('Hi');
  });
  it('从样本还原成一句句字幕（读原视频文件里嵌着的字幕轨时）：空样本不算', () => {
    expect(
      cuesFromSamples([
        { start: 0, end: 0.5, text: '' },
        { start: 0.5, end: 3, text: 'a' },
        { start: 3, end: 4, text: '  ' },
        { start: 4, end: 6, text: 'b\r\nc' },
      ]),
    ).toEqual([
      { start: 0.5, end: 3, text: 'a' },
      { start: 4, end: 6, text: 'b\nc' },
    ]);
  });
});

describe('另存成 .srt', () => {
  it('序号、时间、空行；再读回来一样', () => {
    const cues = [
      { start: 0.5, end: 3, text: 'So in college,' },
      { start: 3723.004, end: 3725, text: 'two\nlines' },
    ];
    expect(toSrt(cues)).toBe('1\n00:00:00,500 --> 00:00:03,000\nSo in college,\n\n2\n01:02:03,004 --> 01:02:05,000\ntwo\nlines\n');
    expect(parseSubtitleFile(toSrt(cues))).toEqual(cues);
  });
});

describe('语言', () => {
  it('写进 MP4 的语言是三个字母：en → eng、zh-Hans → zho；认不出写 und', () => {
    expect(mp4Language('en')).toBe('eng');
    expect(mp4Language('en-US')).toBe('eng');
    expect(mp4Language('zh-Hans')).toBe('zho');
    expect(mp4Language('ko')).toBe('kor');
    expect(mp4Language('eng')).toBe('eng');
    expect(mp4Language('xx')).toBe('und');
    expect(mp4Language(undefined)).toBe('und');
  });
  it('来源的说法', () => {
    expect(SUB_SOURCE_LABELS.youtube).toContain('YouTube');
    expect(SUB_SOURCE_LABELS.file).toContain('字幕文件');
    expect(SUB_SOURCE_LABELS.embedded).toContain('嵌着');
  });
});

describe('YouTube 上取哪一条字幕：和原声同一种语言的', () => {
  const track = (lang: string, kind: '' | 'asr' = '', name = ''): CcTrack => ({ lang, kind, name, label: `${lang}${kind ? ' (auto)' : ''}`, vssId: `${kind ? 'a' : ''}.${lang}`, translatable: true });
  const list = (tracks: CcTrack[]): CcTrackList => ({ videoId: 'O_zcc6XI12g', tracks, translationLangs: [], native: null });
  it('英文演讲：有作者上传的英文字幕就用它，没有就用自动生成的；别的语言的字幕不用', () => {
    expect(pickOriginalTrack(list([track('zh-Hans'), track('en'), track('en', 'asr'), track('ko')]))).toMatchObject({ lang: 'en', kind: '' });
    expect(pickOriginalTrack(list([track('zh-Hans'), track('en', 'asr')]))).toMatchObject({ lang: 'en', kind: 'asr' });
    expect(pickOriginalTrack(list([track('en-US'), track('en', 'asr')]))).toMatchObject({ lang: 'en-US', kind: '' });
  });
  it('原声不是英文（自动生成的字幕是韩文）：取韩文的，不拿英文译文充数', () => {
    expect(pickOriginalTrack(list([track('en'), track('ko', 'asr'), track('ko')]))).toMatchObject({ lang: 'ko', kind: '' });
  });
  it('没有自动生成的字幕：用官方数据里的音频语言；连它也没有时，只有一种语言就用它，有英文的用英文，否则不乱猜', () => {
    expect(pickOriginalTrack(list([track('zh-Hans'), track('en'), track('ko')]), 'ko')).toMatchObject({ lang: 'ko' });
    expect(pickOriginalTrack(list([track('fr')]))).toMatchObject({ lang: 'fr' });
    expect(pickOriginalTrack(list([track('zh-Hans'), track('en')]))).toMatchObject({ lang: 'en' });
    expect(pickOriginalTrack(list([track('zh-Hans'), track('ko')]))).toBeUndefined();
    expect(pickOriginalTrack(list([]))).toBeUndefined();
  });
  it('同一种语言有好几条作者上传的：不带别名的优先', () => {
    expect(pickOriginalTrack(list([track('en', '', 'CC (for the deaf)'), track('en'), track('en', 'asr')]))).toMatchObject({ lang: 'en', kind: '', name: '' });
  });
});
