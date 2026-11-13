// 小宇宙（DECISIONS §72）：音频格式与时间换算、字幕的存取与导出、收藏、收听记录、快照，以及后台读音频 → 转写 → 校对 / 翻译 → 记账的流程（mock CDN / OpenAI / Anthropic）。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../../src/config/endpoints';
import { SUBTITLES, XYZ } from '../../src/config/defaults';
import {
  Mp3Scanner,
  adtsHeader,
  chromeAnchorByte,
  encodeWavPcm,
  extractWindow,
  mp3FrameAt,
  needsScan,
  openAudio,
  pageOffset,
  parseAsc,
  parseMp3Head,
  planWindow,
  syncMp3,
  waveformBars,
  type Mp3Index,
  type Mp4Index,
} from '../../src/core/podcast-audio';
import { buildXyzPolishPrompt } from '../../src/core/prompts';
import { base64ToBytes, encodeWav } from '../../src/core/subtitles';
import {
  addSnapshot,
  applyListen,
  applyXyzOp,
  checkSnapRange,
  cueLines,
  defaultSnapRange,
  emptyXyzSaved,
  estimateXyzUsd,
  exportTranscript,
  filterXyzSaved,
  formatRangeLabel,
  formatXyzTime,
  isXyzMediaUrl,
  listenCompletion,
  listenStatus,
  mergeDone,
  nextGap,
  parsePolish,
  pickXyzCue,
  sanitizeEpisodeInfo,
  sanitizeXyzSaved,
  snapShareText,
  snapTexts,
  xyzEpisodeId,
  xyzPodcastIdFromHref,
  type XyzCue,
  type XyzTranscript,
} from '../../src/core/xyz';
import type { WatchSession } from '../../src/core/types';
import type { AuthProvider } from '../../src/services/auth';
import type { AppContext } from '../../src/services/context';
import { mergeSettings, stores, xyzTranscriptStore } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';
import { ingestXyzListen, mediaFetcher, polishXyzRange, readAudioWindow, transcribeXyzSegment, xyzSession, type XyzDown } from '../../src/services/xyz-service';
import { fakeSecret } from './fake-secrets';

const EID = '6af02451b4a4e20202f67f19';
const PID = '670f3da40d2f24f28978736f';
const M4A = new Uint8Array(readFileSync(new URL('../fixtures/xyz-tones.m4a', import.meta.url)));
const VBR = new Uint8Array(readFileSync(new URL('../fixtures/xyz-tones-vbr.mp3', import.meta.url)));
const fileFetch = (buf: Uint8Array) => async (s: number, e: number) => ({ bytes: buf.slice(s, Math.min(buf.length, e + 1)), total: buf.length });

/** 合成一段恒定码率的 MPEG-1 Layer III：44.1 kHz、128 kbps、单声道，前面有 ID3 标签；像编码器一样用填充位让平均帧长是 417.96 字节 */
function cbrMp3(frames: number): Uint8Array {
  const exact = (144 * 128000) / 44100;
  const id3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(0)]);
  const out = new Uint8Array(id3.length + Math.ceil(frames * exact) + 8);
  out.set(id3);
  let at = id3.length;
  for (let i = 0; i < frames; i++) {
    const pad = Math.floor((i + 1) * exact) - Math.floor(i * exact) - 417;
    out.set([0xff, 0xfb, 0x90 | (pad ? 0x02 : 0), 0xc4], at); // 128 kbps、44.1 kHz、单声道
    out[at + 4] = i & 0xff; // 用帧号做记号
    at += 417 + pad;
  }
  return out.slice(0, at);
}

describe('音频格式：m4a', () => {
  it('从夹具读出帧表、采样率、编辑列表；ADTS 头与 AudioSpecificConfig 一致', async () => {
    const idx = (await openAudio(fileFetch(M4A))) as Mp4Index;
    expect(idx.kind).toBe('mp4');
    expect(idx.codec).toBe('aac');
    expect(idx.sampleRate).toBe(16000);
    expect(idx.channels).toBe(1);
    expect(idx.duration).toBeGreaterThan(91);
    expect(idx.duration).toBeLessThan(93);
    expect(idx.editSec).toBeGreaterThan(0);
    expect(idx.count).toBeGreaterThan(1000);
    // 帧位置单调递增、都在文件里
    for (let i = 1; i < idx.count; i++) expect(idx.offsets[i]!).toBeGreaterThan(idx.offsets[i - 1]!);
    expect(idx.offsets[idx.count - 1]! + idx.sizes[idx.count - 1]!).toBeLessThanOrEqual(M4A.length);
    const h = adtsHeader(idx.aot, idx.freqIndex, idx.channelConfig, 100);
    expect([...h.slice(0, 2)]).toEqual([0xff, 0xf1]);
    expect(((h[3]! & 3) << 11) | (h[4]! << 3) | (h[5]! >> 5)).toBe(107);
  });

  it('读一段：只读这段（含两帧预读）的字节，整理成一帧一个 ADTS 头的流，时间对得上', async () => {
    const idx = (await openAudio(fileFetch(M4A))) as Mp4Index;
    const plan = planWindow(idx, 30, 40);
    expect(plan.end - plan.start).toBeLessThan(M4A.length / 5);
    expect(plan.firstTime).toBeLessThanOrEqual(30);
    expect(plan.firstTime + plan.skipSec).toBeCloseTo(30, 1);
    const w = extractWindow(idx, plan, M4A.slice(plan.start, plan.end + 1), 40);
    expect(w.mime).toBe('audio/aac');
    expect(w.endTime).toBeGreaterThanOrEqual(40);
    // 每帧前面都是 ADTS 同步字
    let o = 0;
    let frames = 0;
    while (o < w.data.length) {
      expect(w.data[o]).toBe(0xff);
      expect(w.data[o + 1]! & 0xf6).toBe(0xf0);
      o += ((w.data[o + 3]! & 3) << 11) | (w.data[o + 4]! << 3) | (w.data[o + 5]! >> 5);
      frames++;
    }
    expect(o).toBe(w.data.length);
    expect(frames).toBeGreaterThan(150);
  });

  it('moov 在文件末尾时多读几次盒子头；HE-AAC 的配置按底层 AAC-LC 写 ADTS', async () => {
    // 把 ftyp 后面的 moov 挪到最后（只改盒子顺序，帧位置不重算：这里只验证找得到 moov）
    const ftypSize = (M4A[0]! << 24) | (M4A[1]! << 16) | (M4A[2]! << 8) | M4A[3]!;
    const moovSize = (M4A[ftypSize]! << 24) | (M4A[ftypSize + 1]! << 16) | (M4A[ftypSize + 2]! << 8) | M4A[ftypSize + 3]!;
    const moved = new Uint8Array(M4A.length);
    moved.set(M4A.subarray(0, ftypSize));
    moved.set(M4A.subarray(ftypSize + moovSize), ftypSize);
    moved.set(M4A.subarray(ftypSize, ftypSize + moovSize), M4A.length - moovSize);
    let reads = 0;
    const idx = await openAudio(async (s, e) => {
      reads++;
      return fileFetch(moved)(s, e);
    });
    expect(idx.kind).toBe('mp4');
    expect(reads).toBeGreaterThan(1);
    // AOT 5（SBR）+ 44.1 kHz 扩展 + 底层 AOT 2，22.05 kHz 双声道
    expect(parseAsc(new Uint8Array([0x2b, 0x92, 0x08, 0x00]))).toMatchObject({ aot: 2, freqIndex: 7, channelConfig: 2 });
  });
});

describe('音频格式：mp3', () => {
  it('恒定码率：跳过 ID3 认出帧，按位置推出帧号与时间', () => {
    const buf = cbrMp3(400);
    const idx = parseMp3Head(buf.slice(0, 65536), buf.length);
    expect(idx).toMatchObject({ kind: 'mp3', vbr: false, sampleRate: 44100, spf: 1152, dataStart: 30, audioStart: 30 });
    expect(mp3FrameAt(buf, 30)?.size).toBe(417);
    expect(syncMp3(buf, 31)).toBe(30 + 417);
    expect(mp3FrameAt(buf, 30 + 417)?.size).toBe(418);
    expect(needsScan(idx)).toBe(false);
    const fdur = 1152 / 44100;
    const plan = planWindow(idx, 100 * fdur, 120 * fdur);
    const w = extractWindow(idx, plan, buf.slice(plan.start, plan.end + 1), 120 * fdur);
    expect(w.mime).toBe('audio/mpeg');
    // 从要的那一帧往前多读几帧（暖解码器 + 位置余量），按位置认出是第几帧；解码后丢掉的正好是多读的那几帧
    expect(w.data[4]).toBe(97);
    expect(w.firstTime).toBeCloseTo(97 * fdur, 6);
    expect(w.firstTime + w.skipSec).toBeCloseTo(100 * fdur, 6);
    expect(pageOffset(idx, 3)).toBe(0);
  });

  it('可变码率：要先扫描；Chrome 的跳转规则下页面时间与真实时间之差（夹具上与 Chromium 实测吻合）', () => {
    const idx = parseMp3Head(VBR.slice(0, 65536), VBR.length);
    expect(idx.vbr).toBe(true);
    expect(idx.xing?.toc).toHaveLength(100);
    expect(needsScan(idx)).toBe(true);
    expect(() => planWindow(idx, 100, 110)).toThrow();
    expect(pageOffset(idx, 160)).toBeUndefined();
    const sc = new Mp3Scanner(idx);
    // 故意用奇怪的块大小：帧头被切开也要接得上
    for (let at = idx.audioStart; at < VBR.length; at += 7777) sc.push(VBR.slice(at, Math.min(VBR.length, at + 7777)), at);
    idx.scan = sc.finish();
    expect(idx.scan.anchors.every((a) => a >= 0)).toBe(true);
    expect(idx.scan.offsets.length * idx.scan.every).toBeGreaterThanOrEqual(idx.xing!.frames - idx.scan.every);
    // 没跳转过：从头连续播放，两者相同
    expect(pageOffset(idx, undefined)).toBe(0);
    // 2026-11-13 在 Chromium 156 里实测：跳到 160 秒时实际放的是 157.4 秒附近的声音（模型给 −3.63）
    expect(pageOffset(idx, 160, 'chrome')!).toBeCloseTo(-3.63, 1);
    expect(pageOffset(idx, 85, 'chrome')!).toBeCloseTo(-3.16, 1);
    // 同一个目录区间里，差值相同
    expect(pageOffset(idx, 161, 'chrome')).toBe(pageOffset(idx, 160, 'chrome'));
    expect(chromeAnchorByte(idx, 0)).toBe(idx.dataStart);
    // 扫描后能读任意一段，第一帧从检查点开始
    const plan = planWindow(idx, 157, 167);
    const w = extractWindow(idx, plan, VBR.slice(plan.start, plan.end + 1), 167);
    expect(w.firstTime + w.skipSec).toBeCloseTo(157, 1);
    expect(w.endTime).toBeGreaterThanOrEqual(167);
  });

  it('扫描时读到的字节不连续就报错（不会悄悄算错帧号）', () => {
    const idx = parseMp3Head(VBR.slice(0, 65536), VBR.length) as Mp3Index;
    const sc = new Mp3Scanner(idx);
    sc.push(VBR.slice(idx.audioStart, idx.audioStart + 1000), idx.audioStart);
    expect(() => sc.push(VBR.slice(idx.audioStart + 2000, idx.audioStart + 3000), idx.audioStart + 2000)).toThrow();
  });
});

describe('波形与 WAV', () => {
  it('响度柱按最大值归一；WAV 交错存放两个声道', () => {
    const s = new Float32Array(1000);
    for (let i = 500; i < 1000; i++) s[i] = i % 2 ? 0.5 : -0.5;
    const bars = waveformBars(s, 4);
    expect(bars).toEqual([0, 0, 1, 1]);
    const wav = encodeWavPcm([new Float32Array([0.5, -0.5]), new Float32Array([0.25, 0])], 44100);
    const v = new DataView(wav.buffer);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(40, true)).toBe(8);
    expect(v.getInt16(44, true)).toBe(Math.trunc(0.5 * 0x7fff));
    expect(v.getInt16(46, true)).toBe(Math.trunc(0.25 * 0x7fff));
  });
});

// ── 页面、单集信息 ──

describe('页面识别与单集信息', () => {
  it('只认单集页；节目链接取节目 ID', () => {
    expect(xyzEpisodeId(`https://www.xiaoyuzhoufm.com/episode/${EID}`)).toBe(EID);
    expect(xyzEpisodeId(`https://www.xiaoyuzhoufm.com/episode/${EID}?s=abc`)).toBe(EID);
    expect(xyzEpisodeId(`https://www.xiaoyuzhoufm.com/podcast/${PID}`)).toBeUndefined();
    expect(xyzEpisodeId(`https://example.com/episode/${EID}`)).toBeUndefined();
    expect(xyzPodcastIdFromHref(`/podcast/${PID}`)).toBe(PID);
  });

  it('页面内容不可信：音频只认小宇宙 CDN，封面只认图片 CDN，简介截断', () => {
    const info = sanitizeEpisodeInfo(
      {
        eid: EID,
        title: '  标题\n ',
        podcastTitle: '节目',
        pid: PID,
        cover: 'https://image.xyzcdn.net/a.png@small',
        audioUrl: 'https://media.xyzcdn.net/p/a.m4a',
        duration: 3559,
        showNotes: 'x'.repeat(10_000),
        color: '#B9B8FF',
      },
      ENDPOINTS.xyzMedia,
    )!;
    expect(info).toMatchObject({ title: '标题', audioUrl: 'https://media.xyzcdn.net/p/a.m4a', color: '#b9b8ff', duration: 3559 });
    expect(info.showNotes!.length).toBe(XYZ.showNotesMaxChars);
    const bad = sanitizeEpisodeInfo({ eid: EID, title: 't', podcastTitle: 'p', cover: 'https://evil.example/a.png', audioUrl: 'https://evil.example/a.m4a' }, ENDPOINTS.xyzMedia)!;
    expect(bad.cover).toBeUndefined();
    expect(bad.audioUrl).toBeUndefined();
    expect(sanitizeEpisodeInfo({ eid: 'nope' }, ENDPOINTS.xyzMedia)).toBeUndefined();
    expect(isXyzMediaUrl('https://media.xyzcdn.net.evil.com/a.m4a', ENDPOINTS.xyzMedia)).toBe(false);
    expect(isXyzMediaUrl('https://user:pw@media.xyzcdn.net/a.m4a', ENDPOINTS.xyzMedia)).toBe(false);
  });
});

// ── 字幕 ──

const cue = (start: number, end: number, raw: string, over: Partial<XyzCue> = {}): XyzCue => ({ id: `${EID}:${start * 1000}`, start, end, raw, createdAt: 0, ...over });

describe('字幕：已处理的时间段、显示、导出', () => {
  it('合并已处理的段；从当前位置找下一个没处理的地方', () => {
    let done: [number, number][] = [];
    done = mergeDone(done, [0, 30]);
    done = mergeDone(done, [30.2, 60]);
    done = mergeDone(done, [90, 120]);
    expect(done).toEqual([
      [0, 60],
      [90, 120],
    ]);
    expect(nextGap(done, 10, 200)).toBe(60);
    expect(nextGap(done, 95, 200)).toBe(120);
    expect(nextGap(done, 95, 110)).toBeUndefined();
  });

  it('中文、英文两行：校对好了用校对的；还没好时原文放在它自己语言的那一行', () => {
    expect(cueLines(cue(0, 2, '我说到哪里了', { lang: 'zh' }))).toEqual({ zh: '我说到哪里了', en: '', pending: true });
    expect(cueLines(cue(0, 2, 'where was I'))).toEqual({ zh: '', en: 'where was I', pending: true });
    expect(cueLines(cue(0, 2, '我说到哪里了', { polished: true, zh: '我说到哪里了？', en: 'Where was I?' }))).toEqual({ zh: '我说到哪里了？', en: 'Where was I?', pending: false });
    const cues = [cue(1, 3, 'a'), cue(4, 6, 'b')];
    expect(pickXyzCue(cues, 2)?.raw).toBe('a');
    expect(pickXyzCue(cues, 3.4)?.raw).toBe('a');
    expect(pickXyzCue(cues, 3.8)).toBeUndefined();
    expect(pickXyzCue(cues, 5)?.raw).toBe('b');
  });

  it('导出：SRT 双语 / 单语、WebVTT、Markdown；没生成完时注明覆盖范围', () => {
    const t: XyzTranscript = {
      eid: EID,
      title: '标题',
      podcastTitle: '节目',
      asrModel: 'gpt-transcribe',
      cues: [cue(1, 3.5, '你好', { polished: true, zh: '你好。', en: 'Hello.' }), cue(61, 63, '还没校对', { lang: 'zh' })],
      done: [[0, 90]],
      updatedAt: 0,
    };
    const info = { eid: EID, title: '标题', podcastTitle: '节目', duration: 3600 };
    expect(exportTranscript(t, info, 'srt-bilingual').text).toBe('1\n00:00:01,000 --> 00:00:03,500\n你好。\nHello.\n\n2\n00:01:01,000 --> 00:01:03,000\n还没校对\n');
    expect(exportTranscript(t, info, 'srt-en').text).toBe('1\n00:00:01,000 --> 00:00:03,500\nHello.\n');
    const vtt = exportTranscript(t, info, 'vtt-bilingual').text;
    expect(vtt.startsWith('WEBVTT\n')).toBe(true);
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.500');
    expect(vtt).toContain('已生成 01:30 / 1:00:00');
    const md = exportTranscript(t, info, 'md').text;
    expect(md).toContain(`https://www.xiaoyuzhoufm.com/episode/${EID}`);
    expect(md).toContain('**00:01** 你好。\n> Hello.');
  });

  it('校对结果只认对得上编号的；整集花费估算', () => {
    const refs = new Map([
      ['s1', 'a'],
      ['s2', 'b'],
    ]);
    const r = parsePolish({ items: [{ id: 's1', zh: '甲', en: 'A' }, { id: 's9', zh: 'x', en: 'y' }, { id: 's1', zh: '重复', en: '' }] }, refs);
    expect([...r.entries()]).toEqual([['a', { zh: '甲', en: 'A' }]]);
    // 一小时：转写 $0.27 + 120 次校对
    expect(estimateXyzUsd(3600, 'gpt-transcribe', undefined)).toBeCloseTo(0.27, 3);
    expect(estimateXyzUsd(3600, 'gpt-transcribe', 'claude-haiku-5-5')).toBeGreaterThan(0.27);
    expect(estimateXyzUsd(3600, undefined, 'claude-haiku-5-5')).toBeLessThan(0.1);
  });

  it('校对提示词只带节目名、标题、简介摘录与转写文字：不带链接、ID', () => {
    const p = buildXyzPolishPrompt({ podcastTitle: '节目', episodeTitle: '标题', notes: 'n'.repeat(5000), previous: ['前一句'], segments: [{ text: '我说到哪里了' }] }, [`${EID}:1000`]);
    expect(p.user).toContain('我说到哪里了');
    expect(p.user).not.toContain(EID);
    expect(p.user).not.toMatch(/https?:\/\//);
    expect(p.user.length).toBeLessThan(2000);
    expect(p.refs.get('s1')).toBe(`${EID}:1000`);
  });
});

// ── 收藏、收听记录、快照 ──

describe('收藏与标签', () => {
  it('收藏单集与节目、加标签、改名、删除标签、移出', () => {
    let st = emptyXyzSaved();
    st = applyXyzOp(st, { op: 'save', kind: 'episode', item: { id: EID, title: '单集', podcastTitle: '节目', pid: PID, tags: ['AI'], savedAt: 1 } }).state;
    st = applyXyzOp(st, { op: 'save', kind: 'podcast', item: { id: PID, title: '节目', tags: [], savedAt: 2 } }).state;
    st = applyXyzOp(st, { op: 'tags', kind: 'podcast', id: PID, add: ['ai', '科技'], remove: [] }).state;
    expect(st.podcasts[PID]!.tags).toEqual(['ai', '科技']);
    st = applyXyzOp(st, { op: 'renameTag', from: 'AI', to: '人工智能' }).state;
    expect(st.episodes[EID]!.tags).toEqual(['人工智能']);
    expect(st.podcasts[PID]!.tags).toEqual(['人工智能', '科技']);
    expect(filterXyzSaved(st, { kind: 'all', tag: '科技' }).map((x) => x.kind)).toEqual(['podcast']);
    expect(filterXyzSaved(st, { kind: 'episode', q: '节目' })).toHaveLength(1);
    st = applyXyzOp(st, { op: 'deleteTag', tag: '人工智能' }).state;
    expect(st.episodes[EID]!.tags).toEqual([]);
    expect(applyXyzOp(st, { op: 'tags', kind: 'episode', id: 'f'.repeat(24), add: ['x'], remove: [] }).error).toBeTruthy();
    st = applyXyzOp(st, { op: 'remove', kind: 'episode', id: EID }).state;
    expect(Object.keys(st.episodes)).toEqual([]);
    // 存储里读回来的不可信：坏的条目丢掉
    expect(sanitizeXyzSaved({ episodes: { x: { id: 'bad' } }, podcasts: { [PID]: { id: PID, title: 'p', tags: ['#a'], cover: 'https://evil/x.png' } } }).podcasts[PID]).toMatchObject({ tags: ['a'] });
  });
});

describe('收听记录', () => {
  const session = (over: Partial<WatchSession> = {}): WatchSession => ({ id: 's1', videoId: EID, startedAt: 1000, updatedAt: 2000, durationSec: 600, intervals: [[0, 100]], playSec: 100, fgSec: 100, bgSec: 0, adSec: 0, shorts: false, ...over });
  const info = { eid: EID, title: '标题', podcastTitle: '节目' };

  it('同一段会话的累计上报只记增量；跨天分开记；完成率按听过的内容算', () => {
    let r = applyListen(undefined, session(), info, '2026-11-13', 100);
    r = applyListen(r, session({ playSec: 150, intervals: [[0, 150]], updatedAt: 3000 }), info, '2026-11-13', 150);
    expect(r.playSec).toBe(150);
    expect(r.days['2026-11-13']).toBe(150);
    r = applyListen(r, session({ id: 's2', playSec: 400, intervals: [[150, 550]], startedAt: 90_000_000, updatedAt: 90_001_000 }), info, '2026-11-14', 550);
    expect(r.playSec).toBe(550);
    expect(r.days['2026-11-14']).toBe(400);
    expect(listenCompletion(r)).toBeCloseTo(550 / 600, 3);
    expect(listenStatus(r, { glanceCompletion: 0.15, glanceSeconds: 30, completeCompletion: 0.85 })).toBe('completed');
    expect(r.lastPos).toBe(550);
  });
});

describe('片段快照', () => {
  const cues = [cue(10, 14, 'a', { polished: true, zh: '第一句。', en: 'First.' }), cue(15, 20, 'b', { polished: true, zh: '第二句。', en: 'Second.' }), cue(40, 44, 'c', { lang: 'zh' })];
  it('起止检查、默认片段、片段里的字幕、标签文字', () => {
    expect(checkSnapRange(null, 3, 100)).toBeTruthy();
    expect(checkSnapRange(10, 10.5, 100)).toContain('至少');
    expect(checkSnapRange(0, 61, 100)).toContain('最长 60 秒');
    expect(checkSnapRange(90, 101, 100)).toContain('超出');
    expect(checkSnapRange(10, 20, 100)).toBeUndefined();
    expect(defaultSnapRange(cues, 12, 100)).toEqual({ start: 10, end: 20 });
    expect(defaultSnapRange([], 33.4, 100)).toEqual({ start: 33, end: 53 });
    expect(snapTexts(cues, 10, 20)).toMatchObject({ zh: '第一句。第二句。', en: 'First. Second.', complete: true });
    expect(snapTexts(cues, 39, 45).complete).toBe(false);
    expect(formatRangeLabel(292, 318)).toBe('04:52 – 05:18 (26s)');
    expect(formatXyzTime(3725)).toBe('1:02:05');
    const text = snapShareText({ eid: EID, title: '标题', podcastTitle: '节目' }, 292, 318);
    expect(text).toContain('04:52–05:18');
    expect(text).toContain(`https://www.xiaoyuzhoufm.com/episode/${EID}`);
    expect(text).not.toContain('?t=');
  });

  it('"我的快照"同一段只留一条，新的在前', () => {
    const rec = (id: string, start: number) => ({ id, eid: EID, title: 't', podcastTitle: 'p', start, end: start + 10, zh: '', en: '', createdAt: 0 });
    let log = addSnapshot([], rec('a', 1));
    log = addSnapshot(log, rec('b', 20));
    log = addSnapshot(log, rec('c', 1));
    expect(log.map((x) => x.id)).toEqual(['c', 'b']);
  });
});

// ── 后台流程 ──

const NOW = Date.parse('2026-11-13T04:00:00Z');
const OPENAI_KEY = fakeSecret('sk-proj-', 'xyzTestKey0123456789abcdefghijklmnopqrst');
const ANTHROPIC_KEY = fakeSecret('sk-ant-', 'xyz-test-0123456789abcdefghijklmnopq');
const AUDIO = `${ENDPOINTS.xyzMedia}/${PID}/tones.m4a`;

interface Rec {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials?: RequestCredentials | undefined;
  form?: Record<string, string>;
  body?: string;
}

function makeCtx(opts: { polish?: (user: string) => unknown; transcribe?: () => { status?: number; body: unknown }; media?: Uint8Array; mediaStatus?: number; settings?: Record<string, unknown> } = {}) {
  const requests: Rec[] = [];
  const media = opts.media ?? M4A;
  const http: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (req.url.startsWith(ENDPOINTS.xyzMedia)) {
      requests.push({ url: req.url, method: req.method, headers, credentials: init?.credentials });
      if (opts.mediaStatus) return new Response('', { status: opts.mediaStatus });
      const m = /bytes=(\d+)-(\d*)/.exec(headers.range ?? '');
      const s = Number(m?.[1] ?? 0);
      const e = m?.[2] ? Math.min(Number(m[2]), media.length - 1) : media.length - 1;
      return new Response(media.slice(s, e + 1), { status: 206, headers: { 'content-range': `bytes ${s}-${e}/${media.length}` } });
    }
    if (req.url === `${ENDPOINTS.openai}/audio/transcriptions`) {
      const fd = await req.formData();
      const form: Record<string, string> = {};
      fd.forEach((v, k) => typeof v === 'string' && (form[k] = v));
      requests.push({ url: req.url, method: req.method, headers, form });
      const r = opts.transcribe?.() ?? { body: { text: '我说到哪里了', languages: [{ code: 'zh' }], usage: { type: 'duration', seconds: 4 } } };
      return reply(r.status ?? 200, r.body);
    }
    const body = await req.text();
    requests.push({ url: req.url, method: req.method, headers, body });
    if (req.url.startsWith(ENDPOINTS.anthropic)) {
      const b = JSON.parse(body);
      const user = String(b.messages?.[0]?.content);
      const items = JSON.parse(user.slice(user.indexOf('待处理（JSON）：\n') + '待处理（JSON）：\n'.length)) as { id: string; text: string }[];
      const out = opts.polish?.(user) ?? { items: items.map((i) => ({ id: i.id, zh: `${i.text}。`, en: 'Where was I?' })) };
      return reply(200, { id: 'msg', type: 'message', role: 'assistant', model: b.model, content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 300 } });
    }
    throw new Error(`未预期的请求 ${req.url}`);
  };
  const kv = memoryKV();
  const auth = { status: async () => 'disconnected' } as unknown as AuthProvider;
  const ctx: AppContext = { kv, locker: memoryLocker(), http, now: () => NOW, auth, endpoints: ENDPOINTS, timeZone: 'Asia/Shanghai' };
  const init = async () => {
    await stores.secrets.write(kv, { openaiApiKey: OPENAI_KEY, anthropicApiKey: ANTHROPIC_KEY });
    await stores.settings.write(kv, mergeSettings(opts.settings ?? {}));
  };
  return { ctx, requests, init };
}

const INFO = { eid: EID, title: '#817.测试单集', podcastTitle: '跨国串门儿计划', pid: PID, audioUrl: AUDIO, duration: 92, showNotes: 'Lance Martin 是 Anthropic 的技术人员' };
const tone = (sec: number) => {
  const n = sec * SUBTITLES.sampleRate;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.25 * Math.sin((2 * Math.PI * 300 * i) / SUBTITLES.sampleRate);
  return out;
};

describe('后台：读音频', () => {
  it('只读小宇宙 CDN、分段读、不带 Cookie；页面上的地址不是 CDN 时直接拒绝', async () => {
    const t = makeCtx();
    await t.init();
    const w = await readAudioWindow(t.ctx, AUDIO, 30, 40);
    expect(base64ToBytes(w.audio)[0]).toBe(0xff);
    expect(w.firstTime + w.skipSec).toBeCloseTo(30, 1);
    expect(t.requests.every((r) => r.url === AUDIO && /^bytes=\d+-\d+$/.test(r.headers.range ?? '') && r.credentials === 'omit')).toBe(true);
    expect(() => mediaFetcher(t.ctx, 'https://evil.example/a.m4a')).toThrow(/不在小宇宙的公开 CDN/);
  });

  it('音频被拒（付费节目）时说清楚，会话里标成致命错误', async () => {
    const t = makeCtx({ mediaStatus: 403 });
    await t.init();
    const sent: XyzDown[] = [];
    const handle = xyzSession(t.ctx, (m) => sent.push(m));
    await handle({ type: 'hello', info: { ...INFO, eid: 'f'.repeat(24) } });
    const track = sent.find((m) => m.type === 'track') as Extract<XyzDown, { type: 'track' }>;
    expect(track.audioError?.message).toContain('拒绝访问');
    expect(track.audio).toBeUndefined();
  });
});

describe('后台：转写 → 存字幕 → 校对 / 翻译 → 记账', () => {
  it('一句一句转写：提示词带节目名与标题；存成真实时间的字幕；记进"字幕 $"', async () => {
    const t = makeCtx();
    await t.init();
    const c = await transcribeXyzSegment(t.ctx, INFO, { eid: EID, start: 12, end: 15, wav: encodeWav(tone(3), SUBTITLES.sampleRate) });
    expect(c).toMatchObject({ start: 12, end: 15, raw: '我说到哪里了', lang: 'zh' });
    const tr = t.requests.find((r) => r.url.endsWith('/audio/transcriptions'))!;
    expect(tr.form!.prompt).toContain('跨国串门儿计划：#817.测试单集');
    expect(tr.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    // 同一段再来不再花钱
    expect(await transcribeXyzSegment(t.ctx, INFO, { eid: EID, start: 12.2, end: 15, wav: encodeWav(tone(2.8), SUBTITLES.sampleRate) })).toBeUndefined();
    expect(t.requests.filter((r) => r.url.endsWith('/audio/transcriptions'))).toHaveLength(1);
    const ledger = await stores.subtitleLedger.read(t.ctx.kv);
    expect(Object.values(ledger.days)[0]!.asrSeconds).toBe(4);
  });

  it('处理完一段：记下已处理，并把这段的句子交给大模型校对 / 翻译；结果按编号对回去', async () => {
    const t = makeCtx();
    await t.init();
    const sent: XyzDown[] = [];
    const handle = xyzSession(t.ctx, (m) => sent.push(m));
    await handle({ type: 'hello', info: INFO });
    const track = sent.find((m) => m.type === 'track') as Extract<XyzDown, { type: 'track' }>;
    expect(track.audio).toMatchObject({ kind: 'mp4', needsScan: false, exact: true, vbr: false });
    for (const start of [1, 5]) await handle({ type: 'segment', seq: start, start, end: start + 3, audio: Buffer.from(encodeWav(tone(3), SUBTITLES.sampleRate)).toString('base64') });
    await handle({ type: 'processed', from: 0, to: 30 });
    const polished = sent.filter((m) => m.type === 'cues').flatMap((m) => (m as Extract<XyzDown, { type: 'cues' }>).cues);
    expect(polished.map((c) => [c.start, c.zh, c.en, c.polished])).toEqual([
      [1, '我说到哪里了。', 'Where was I?', true],
      [5, '我说到哪里了。', 'Where was I?', true],
    ]);
    const llm = t.requests.find((r) => r.url.startsWith(ENDPOINTS.anthropic))!;
    expect(llm.body).toContain('Lance Martin');
    expect(llm.body).not.toContain(AUDIO);
    expect(llm.body).not.toContain(EID);
    const saved = await xyzTranscriptStore(EID).read(t.ctx.kv);
    expect(saved!.done).toEqual([[0, 30]]);
    const day = Object.values((await stores.subtitleLedger.read(t.ctx.kv)).days)[0]!;
    expect(day.translations).toBe(2);
    expect(day.translateUsd).toBeGreaterThan(0);
  });

  it('关掉校对时不调大模型；大模型漏了一句时那句标出原因', async () => {
    const off = makeCtx({ settings: { xyz: { polish: false } } });
    await off.init();
    await transcribeXyzSegment(off.ctx, INFO, { eid: EID, start: 1, end: 4, wav: encodeWav(tone(3), SUBTITLES.sampleRate) });
    expect(await polishXyzRange(off.ctx, INFO, 0, 30)).toEqual([]);
    expect(off.requests.some((r) => r.url.startsWith(ENDPOINTS.anthropic))).toBe(false);
    const miss = makeCtx({ polish: () => ({ items: [] }) });
    await miss.init();
    await transcribeXyzSegment(miss.ctx, INFO, { eid: EID, start: 1, end: 4, wav: encodeWav(tone(3), SUBTITLES.sampleRate) });
    const [c] = await polishXyzRange(miss.ctx, INFO, 0, 30);
    expect(c!.polished).toBeFalsy();
    expect(c!.polishError).toContain('漏掉');
  });

  it('没有 OpenAI Key、预算用完：停下并说明（致命错误）', async () => {
    const t = makeCtx({ settings: { subtitles: { dailyBudgetUsd: 0 } } });
    await t.init();
    const sent: XyzDown[] = [];
    const handle = xyzSession(t.ctx, (m) => sent.push(m));
    await handle({ type: 'hello', info: INFO });
    await handle({ type: 'segment', seq: 1, start: 1, end: 4, audio: Buffer.from(encodeWav(tone(3), SUBTITLES.sampleRate)).toString('base64') });
    const err = sent.find((m) => m.type === 'error') as Extract<XyzDown, { type: 'error' }>;
    expect(err.fatal).toBe(true);
    expect(err.message).toContain('字幕花费已到上限');
    expect(t.requests.some((r) => r.url.endsWith('/audio/transcriptions'))).toBe(false);
  });

  it('拒收格式不对的音频（不是本扩展编码的 16 kHz 单声道 WAV、太长）', async () => {
    const t = makeCtx();
    await t.init();
    await expect(transcribeXyzSegment(t.ctx, INFO, { eid: EID, start: 0, end: 20, wav: encodeWav(tone(20), SUBTITLES.sampleRate) })).rejects.toThrow(/格式不对/);
    await expect(transcribeXyzSegment(t.ctx, INFO, { eid: EID, start: 0, end: 2, wav: encodeWav(tone(2), 44100) })).rejects.toThrow(/格式不对/);
  });
});

describe('后台：收听记录', () => {
  it('校验后记下；关掉收听记录时不记', async () => {
    const t = makeCtx();
    await t.init();
    const session = { id: 'abc', videoId: EID, startedAt: NOW, updatedAt: NOW + 60_000, durationSec: 92, intervals: [[0, 60]], playSec: 60, fgSec: 60, bgSec: 0 };
    await ingestXyzListen(t.ctx, { session, info: INFO, lastPos: 60 });
    const log = await stores.xyzListens.read(t.ctx.kv);
    expect(log[EID]).toMatchObject({ playSec: 60, lastPos: 60, title: '#817.测试单集', days: { '2026-11-13': 60 } });
    await ingestXyzListen(t.ctx, { session: { ...session, videoId: 'bad' }, info: INFO });
    const off = makeCtx({ settings: { xyz: { tracking: false } } });
    await off.init();
    await ingestXyzListen(off.ctx, { session, info: INFO, lastPos: 60 });
    expect(await stores.xyzListens.read(off.ctx.kv)).toEqual({});
  });
});

describe('设置', () => {
  it('默认：OpenAI 转写、手动开始、校对开、双语、记收听', () => {
    const s = mergeSettings({});
    expect(s.xyz).toMatchObject({ enabled: true, asrEngine: 'openai', autoStart: false, polish: true, display: 'bilingual', tracking: true });
    expect(mergeSettings({ xyz: { display: 'zh' } }).xyz.display).toBe('zh');
  });
});
