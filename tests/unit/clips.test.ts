// 视频片段录制：时间码、文件名、编码格式与尺寸、开录前检查、录 / 等 / 停的判定、字幕烧录排版、录制记录（后台校验与保存）。

import { describe, expect, it } from 'vitest';
import { CLIPS, DEFAULT_SETTINGS } from '../../src/config/defaults';
import {
  addClipRecord,
  checkClipStart,
  checkRange,
  clipFileName,
  clipWatchUrl,
  decideClip,
  formatBytes,
  formatTimecode,
  layoutBurnIn,
  outputSize,
  parseTimecode,
  pickClipFormat,
  safeFileTitle,
  sanitizeClipRecord,
  titleFromDocumentTitle,
  videoBitrate,
  wrapText,
  type ClipControl,
  type ClipRecord,
  type ClipSample,
  type ClipStartContext,
  type MeasureText,
} from '../../src/core/clips';
import { mergeSettings, stores } from '../../src/services/repo';
import { clearClipLog, recordSavedClip } from '../../src/services/clip-service';
import { memoryKV, memoryLocker } from '../../src/services/storage';
import type { AppContext } from '../../src/services/context';

describe('时间码', () => {
  it('认得各种写法', () => {
    expect(parseTimecode('12:03')).toBe(723);
    expect(parseTimecode('1:02:03')).toBe(3723);
    expect(parseTimecode('75')).toBe(75);
    expect(parseTimecode('12:03.5')).toBe(723.5);
    expect(parseTimecode(' 0:07 ')).toBe(7);
    expect(parseTimecode('1：02')).toBe(62);
    expect(parseTimecode('1h2m3s')).toBe(3723);
    expect(parseTimecode('2m')).toBe(120);
    expect(parseTimecode('90s')).toBe(90);
    expect(parseTimecode('75:00')).toBe(4500);
  });
  it('认不出就返回 null，不瞎猜', () => {
    for (const bad of ['', 'abc', '1:2:3:4', '12:', ':30', '1:60', '1:61:00', '-5', '1.5:00', '12:3a']) expect(parseTimecode(bad)).toBeNull();
  });
  it('显示：m:ss / h:mm:ss，有小数时保留一位', () => {
    expect(formatTimecode(0)).toBe('0:00');
    expect(formatTimecode(723)).toBe('12:03');
    expect(formatTimecode(3723)).toBe('1:02:03');
    expect(formatTimecode(12.34)).toBe('0:12.3');
    expect(formatTimecode(59.96)).toBe('1:00');
    expect(parseTimecode(formatTimecode(3723.4))).toBe(3723.4);
  });
  it('大小显示', () => {
    expect(formatBytes(500 * 1024)).toBe('500 KB');
    expect(formatBytes(12.34 * 1024 * 1024)).toBe('12.3 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.50 GB');
  });
});

describe('文件名', () => {
  it('页面标题去掉通知数与" - YouTube"', () => {
    expect(titleFromDocumentTitle('(629) 【康永你OK嗎？】專訪 蔡康永 - YouTube')).toBe('【康永你OK嗎？】專訪 蔡康永');
    expect(titleFromDocumentTitle('AI Safety Interview – YouTube')).toBe('AI Safety Interview');
    expect(titleFromDocumentTitle('YouTube')).toBe('YouTube');
  });
  it('去掉文件系统不允许的字符，限长，避开 Windows 保留名', () => {
    expect(safeFileTitle('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    expect(safeFileTitle('  ...hidden.  ')).toBe('hidden');
    expect([...safeFileTitle('长'.repeat(200))].length).toBe(80);
    expect(safeFileTitle('CON')).toBe('_CON');
    expect(safeFileTitle('line\nbreak\ttab')).toBe('line break tab');
  });
  it('标题_起点-终点.扩展名；没有标题用视频 ID', () => {
    expect(clipFileName('AI: 安全访谈?', 'abc123DEF45', 723.9, 790.2, 'mp4')).toBe('AI 安全访谈_12m03s-13m10s.mp4');
    expect(clipFileName(undefined, 'abc123DEF45', 3723, 3730, 'webm')).toBe('youtube-abc123DEF45_1h02m03s-1h02m10s.webm');
    expect(clipFileName('???', 'abc123DEF45', 0, 5, 'mp4')).toBe('youtube-abc123DEF45_00m00s-00m05s.mp4');
  });
});

describe('编码格式与尺寸', () => {
  it('优先 MP4（H.264 + AAC），不支持时退回 WebM，都不支持返回 undefined', () => {
    expect(pickClipFormat(() => true)?.ext).toBe('mp4');
    const webmOnly = pickClipFormat((m) => m.startsWith('video/webm'));
    expect(webmOnly).toMatchObject({ ext: 'webm', mimeType: 'video/webm;codecs=vp9,opus' });
    expect(pickClipFormat(() => false)).toBeUndefined();
    expect(
      pickClipFormat(() => {
        throw new Error('boom');
      }),
    ).toBeUndefined();
  });
  it('按原尺寸输出；高于 1080 等比缩小；宽高取偶数；读不到尺寸用默认', () => {
    expect(outputSize(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(outputSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(outputSize(853, 481)).toEqual({ width: 854, height: 482 });
    expect(outputSize(1080, 1920)).toEqual({ width: 608, height: 1080 });
    expect(outputSize(0, 0)).toEqual(CLIPS.fallbackSize);
  });
  it('码率按输出高度', () => {
    expect(videoBitrate(1080)).toBe(8_000_000);
    expect(videoBitrate(720)).toBe(5_000_000);
    expect(videoBitrate(482)).toBe(2_500_000);
    expect(videoBitrate(360)).toBe(1_500_000);
  });
});

describe('开录前检查', () => {
  const ctx = (over: Partial<ClipStartContext> = {}): ClipStartContext => ({
    enabled: true,
    videoId: 'abc123DEF45',
    shorts: false,
    hasVideo: true,
    busy: false,
    duration: 600,
    currentTime: 30,
    ended: false,
    maxSec: 600,
    ...over,
  });
  it('自由录制：设置关闭、Shorts、不是视频页、没有播放器、已在录、已播完都说清楚', () => {
    expect(checkClipStart({ mode: 'free' }, ctx())).toBeUndefined();
    expect(checkClipStart({ mode: 'free' }, ctx({ enabled: false }))).toContain('设置中关闭');
    expect(checkClipStart({ mode: 'free' }, ctx({ shorts: true }))).toContain('Shorts');
    expect(checkClipStart({ mode: 'free' }, ctx({ videoId: null }))).toContain('不是视频播放页');
    expect(checkClipStart({ mode: 'free' }, ctx({ hasVideo: false }))).toContain('没找到');
    expect(checkClipStart({ mode: 'free' }, ctx({ busy: true }))).toContain('已经在录');
    expect(checkClipStart({ mode: 'free' }, ctx({ ended: true }))).toContain('播完');
  });
  it('时间段：格式、先后、最短、超出时长、超过上限', () => {
    expect(checkClipStart({ mode: 'range', start: 10, end: 20 }, ctx())).toBeUndefined();
    expect(checkClipStart({ mode: 'range', end: 20 }, ctx())).toContain('起点格式');
    expect(checkClipStart({ mode: 'range', start: 10 }, ctx())).toContain('终点格式');
    expect(checkClipStart({ mode: 'range', start: 20, end: 10 }, ctx())).toContain('晚于起点');
    expect(checkClipStart({ mode: 'range', start: 10, end: 10.5 }, ctx())).toContain('至少');
    expect(checkClipStart({ mode: 'range', start: 700, end: 710 }, ctx())).toContain('超出了视频时长');
    expect(checkClipStart({ mode: 'range', start: 0, end: 601 }, ctx({ duration: 3600 }))).toContain('单段时长上限');
    // 时间段不要求视频没播完；直播（时长未知）不限制起点
    expect(checkClipStart({ mode: 'range', start: 10, end: 20 }, ctx({ ended: true }))).toBeUndefined();
    expect(checkClipStart({ mode: 'range', start: 5000, end: 5010 }, ctx({ duration: Infinity }))).toBeUndefined();
    expect(checkRange(-1, 5, 100, 600)).toContain('早于 0:00');
  });
});

describe('录 / 等 / 停', () => {
  const control = (over: Partial<ClipControl> = {}): ClipControl => ({
    mode: 'free',
    videoId: 'abc123DEF45',
    recordedSec: 5,
    bytes: 1000,
    maxSec: 600,
    maxBytes: CLIPS.maxBytes,
    userPaused: false,
    ...over,
  });
  const sample = (over: Partial<ClipSample> = {}): ClipSample => ({
    videoId: 'abc123DEF45',
    currentTime: 30,
    paused: false,
    ended: false,
    seeking: false,
    ready: true,
    ad: false,
    visible: true,
    ...over,
  });
  it('正常播放时录', () => {
    expect(decideClip(control(), sample())).toEqual({ kind: 'record' });
  });
  it('广告、暂停、缓冲、标签页在后台、你按了暂停：暂停录制并说明原因', () => {
    expect(decideClip(control(), sample({ ad: true }))).toEqual({ kind: 'wait', why: 'ad' });
    expect(decideClip(control(), sample({ paused: true }))).toEqual({ kind: 'wait', why: 'paused' });
    expect(decideClip(control(), sample({ seeking: true }))).toEqual({ kind: 'wait', why: 'seeking' });
    expect(decideClip(control(), sample({ ready: false }))).toEqual({ kind: 'wait', why: 'seeking' });
    expect(decideClip(control(), sample({ visible: false }))).toEqual({ kind: 'wait', why: 'hidden' });
    expect(decideClip(control({ userPaused: true }), sample())).toEqual({ kind: 'wait', why: 'user' });
    // 广告优先于"视频暂停"：广告期间暂停也说是广告
    expect(decideClip(control(), sample({ ad: true, paused: true }))).toEqual({ kind: 'wait', why: 'ad' });
  });
  it('切到别的视频、到时长上限、太大、播完：结束这一段', () => {
    expect(decideClip(control(), sample({ videoId: 'other000000' }))).toEqual({ kind: 'stop', reason: 'video-changed' });
    expect(decideClip(control(), sample({ videoId: null }))).toEqual({ kind: 'stop', reason: 'video-changed' });
    expect(decideClip(control({ recordedSec: 600 }), sample())).toEqual({ kind: 'stop', reason: 'max-duration' });
    expect(decideClip(control({ bytes: CLIPS.maxBytes }), sample())).toEqual({ kind: 'stop', reason: 'max-bytes' });
    expect(decideClip(control(), sample({ ended: true }))).toEqual({ kind: 'stop', reason: 'ended' });
    // 暂停中也会因为切视频而结束
    expect(decideClip(control({ userPaused: true }), sample({ videoId: 'other000000' }))).toEqual({ kind: 'stop', reason: 'video-changed' });
  });
  it('时间段：等到起点才录，到终点结束；拖出范围暂停', () => {
    const range = (over: Partial<ClipControl> = {}) => control({ mode: 'range', start: 60, end: 70, recordedSec: 0, ...over });
    // 刚跳到起点：拖动中 → 等
    expect(decideClip(range(), sample({ currentTime: 60, seeking: true }))).toEqual({ kind: 'wait', why: 'seeking' });
    expect(decideClip(range(), sample({ currentTime: 59.97 }))).toEqual({ kind: 'record' });
    expect(decideClip(range(), sample({ currentTime: 40 }))).toEqual({ kind: 'wait', why: 'before-range' });
    expect(decideClip(range({ recordedSec: 3 }), sample({ currentTime: 65 }))).toEqual({ kind: 'record' });
    expect(decideClip(range({ recordedSec: 3 }), sample({ currentTime: 40 }))).toEqual({ kind: 'wait', why: 'outside-range' });
    expect(decideClip(range({ recordedSec: 10 }), sample({ currentTime: 70 }))).toEqual({ kind: 'stop', reason: 'range-end' });
    expect(decideClip(range({ recordedSec: 3 }), sample({ currentTime: 66, ended: true }))).toEqual({ kind: 'stop', reason: 'range-end' });
    // 还没录到东西时，位置在终点之后（起步前的旧位置）不算结束
    expect(decideClip(range(), sample({ currentTime: 80 }))).toEqual({ kind: 'wait', why: 'outside-range' });
  });
});

describe('字幕烧录排版', () => {
  /** 假的量宽：中日韩字算 1 个字号宽，其他字符算 0.5 个字号宽 */
  const measure: MeasureText = (t, px) => [...t].reduce((w, ch) => w + (/[⺀-鿿＀-￯　-〿]/.test(ch) ? px : px * 0.5), 0);
  it('中文逐字折行，英文按词折行，超长的词硬切', () => {
    expect(wrapText('一二三四五六七八九十', 100, 20, measure)).toEqual(['一二三四五', '六七八九十']);
    expect(wrapText('the quick brown fox jumps', 100, 20, measure)).toEqual(['the quick', 'brown fox', 'jumps']);
    expect(wrapText('abcdefghijklmnopqrstuvwxyz', 100, 20, measure)).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz']);
    expect(wrapText('第一行\n第二行', 1000, 20, measure)).toEqual(['第一行', '第二行']);
    expect(wrapText('中文 mixed 文字', 1000, 20, measure)).toEqual(['中文 mixed 文字']);
    expect(wrapText('   ', 100, 20, measure)).toEqual([]);
  });
  it('画在底部居中，从下往上堆；译文略小；不超出画面', () => {
    const boxes = layoutBurnIn(
      [
        { text: 'Where was I?', tone: 'source' },
        { text: '我说到哪里了？', tone: 'translation' },
      ],
      { width: 1280, height: 720, measure },
    );
    expect(boxes.map((b) => b.text)).toEqual(['Where was I?', '我说到哪里了？']);
    const [src, tr] = boxes as [(typeof boxes)[0], (typeof boxes)[0]];
    expect(src.y + src.h).toBeLessThan(tr.y);
    expect(tr.y + tr.h).toBeLessThanOrEqual(720 - 0.06 * 720 + 0.001);
    expect(tr.fontPx).toBeCloseTo(src.fontPx * 0.88);
    for (const b of boxes) {
      expect(b.cx).toBe(640);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(1280);
    }
  });
  it('字号随画面高度与字号倍数缩放；放不下的更早的行不画', () => {
    const small = layoutBurnIn([{ text: '字', tone: 'source' }], { width: 640, height: 360, measure })[0]!;
    const big = layoutBurnIn([{ text: '字', tone: 'source' }], { width: 1920, height: 1080, measure })[0]!;
    const scaled = layoutBurnIn([{ text: '字', tone: 'source' }], { width: 1920, height: 1080, fontScale: 1.5, measure })[0]!;
    expect(big.fontPx).toBeGreaterThan(small.fontPx);
    expect(scaled.fontPx).toBeCloseTo(big.fontPx * 1.5);
    const many = layoutBurnIn(
      Array.from({ length: 40 }, (_, i) => ({ text: `第 ${i} 行`, tone: 'source' as const })),
      { width: 640, height: 360, measure },
    );
    expect(many.length).toBeLessThan(40);
    expect(many.at(-1)!.text).toBe('第 39 行');
    expect(many.every((b) => b.y >= 0)).toBe(true);
  });
  it('没有字幕时什么也不画', () => {
    expect(layoutBurnIn([], { width: 1280, height: 720, measure })).toEqual([]);
  });
});

describe('录制记录', () => {
  const good = {
    id: 'clip_1',
    videoId: 'abc123DEF45',
    title: '访谈',
    mode: 'range',
    start: 60,
    end: 70,
    durationSec: 10,
    bytes: 1_200_000,
    format: 'MP4（H.264 + AAC）',
    fileName: '访谈_01m00s-01m10s.mp4',
    burned: true,
    savedAt: 1_700_000_000_000,
  };
  it('合格的记录原样保留，多余字段丢弃', () => {
    expect(sanitizeClipRecord({ ...good, extra: 'x' })).toEqual(good);
    const { title: _t, ...noTitle } = good;
    expect(sanitizeClipRecord(noTitle)).toEqual(noTitle);
  });
  it('来自网页环境的记录逐项校验：缺字段、类型不对、视频 ID 不像、数值越界都丢弃', () => {
    expect(sanitizeClipRecord(null)).toBeNull();
    expect(sanitizeClipRecord('x')).toBeNull();
    expect(sanitizeClipRecord({ ...good, videoId: '../../etc' })).toBeNull();
    expect(sanitizeClipRecord({ ...good, mode: 'evil' })).toBeNull();
    expect(sanitizeClipRecord({ ...good, bytes: -1 })).toBeNull();
    expect(sanitizeClipRecord({ ...good, start: Number.NaN })).toBeNull();
    expect(sanitizeClipRecord({ ...good, fileName: '' })).toBeNull();
    expect(sanitizeClipRecord({ ...good, burned: 'yes' })?.burned).toBe(false);
    expect(sanitizeClipRecord({ ...good, title: 'x'.repeat(500) })?.title).toHaveLength(200);
  });
  it('新的在前；同一片段再存一次只更新；最多保留 N 条', () => {
    const r = (id: string, savedAt: number): ClipRecord => ({ ...(good as ClipRecord), id, savedAt });
    let log: ClipRecord[] = [];
    log = addClipRecord(log, r('a', 1));
    log = addClipRecord(log, r('b', 2));
    log = addClipRecord(log, r('a', 3));
    expect(log.map((x) => `${x.id}@${x.savedAt}`)).toEqual(['a@3', 'b@2']);
    expect(addClipRecord(log, r('c', 4), 2).map((x) => x.id)).toEqual(['c', 'a']);
  });
  it('回到这一段的地址', () => {
    expect(clipWatchUrl({ videoId: 'abc123DEF45', start: 723.9 })).toBe('https://www.youtube.com/watch?v=abc123DEF45&t=723s');
  });
  it('后台：校验后存进本地，不合格的不存；可以清空', async () => {
    const ctx = { kv: memoryKV(), locker: memoryLocker() } as unknown as AppContext;
    expect(await recordSavedClip(ctx, { ...good, videoId: 'bad id' })).toBeNull();
    expect(await stores.clipLog.read(ctx.kv)).toEqual([]);
    expect(await recordSavedClip(ctx, good)).toEqual(good);
    expect(await recordSavedClip(ctx, { ...good, id: 'clip_2' })).not.toBeNull();
    expect((await stores.clipLog.read(ctx.kv)).map((x) => x.id)).toEqual(['clip_2', 'clip_1']);
    await clearClipLog(ctx);
    expect(await stores.clipLog.read(ctx.kv)).toEqual([]);
  });
});

describe('设置', () => {
  it('默认：启用、不烧录字幕、停止后直接保存、单段 10 分钟；旧数据没有这一节也能读', () => {
    expect(DEFAULT_SETTINGS.clips).toEqual({ enabled: true, burnSubtitles: false, autoSave: true, maxMinutes: 10 });
    expect(mergeSettings({ subtitles: { enabled: false } }).clips).toEqual(DEFAULT_SETTINGS.clips);
    expect(mergeSettings({ clips: { burnSubtitles: true } }).clips).toEqual({ ...DEFAULT_SETTINGS.clips, burnSubtitles: true });
  });
});
