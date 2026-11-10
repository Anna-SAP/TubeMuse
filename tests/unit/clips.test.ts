// 视频片段录制：时间码、文件名、编码格式与尺寸、开录前检查、录 / 等 / 停的判定、字幕烧录排版、录制记录（后台校验与保存）、Capture 截图。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIPS, DEFAULT_SETTINGS } from '../../src/config/defaults';
import {
  addClipRecord,
  atVideoEnd,
  base64ToBytes,
  bytesToBase64,
  captureFileName,
  checkCapture,
  checkClipStart,
  checkRange,
  clipFileName,
  clipUnavailable,
  clipWatchUrl,
  decideClip,
  formatBytes,
  formatTimecode,
  frameTimestamp,
  isKubbAd,
  isKubbPage,
  isXPage,
  layoutBurnIn,
  mp4TrackKinds,
  outputSize,
  parseKubbPlayUrl,
  parseTimecode,
  parseXStatusUrl,
  pickClipFormat,
  pickXVideo,
  safeFileTitle,
  sanitizeClipRecord,
  titleFromDocumentTitle,
  videoBitrate,
  visibleArea,
  wrapText,
  type ClipCaptureContext,
  type ClipControl,
  type ClipRecord,
  type ClipSample,
  type ClipStartContext,
  type MeasureText,
  type XVideoView,
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
  it('小红书：去掉" - 小红书" / " - rednote"，不动 YouTube 的写法', () => {
    expect(titleFromDocumentTitle('视频日记Day255｜一人公司怎么做? - 小红书', 'xhs')).toBe('视频日记Day255｜一人公司怎么做?');
    expect(titleFromDocumentTitle('npd父母宁愿你si - rednote', 'xhs')).toBe('npd父母宁愿你si');
    expect(titleFromDocumentTitle('访谈 - YouTube', 'xhs')).toBe('访谈 - YouTube');
    expect(titleFromDocumentTitle('访谈 - 小红书')).toBe('访谈 - 小红书');
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
    expect(clipFileName(undefined, '6ae9a4e000000000140281c6', 1.6, 98.7, 'mp4', 'xhs')).toBe('xhs-6ae9a4e000000000140281c6_00m01s-01m38s.mp4');
  });
});

describe('Capture 截图', () => {
  it('文件名里的时间精确到毫秒：时-分-秒-毫秒', () => {
    expect(frameTimestamp(30.804)).toBe('00-00-30-804');
    expect(frameTimestamp(49.743)).toBe('00-00-49-743');
    expect(frameTimestamp(0)).toBe('00-00-00-000');
    expect(frameTimestamp(3723.5)).toBe('01-02-03-500');
    // 四舍五入进位到下一秒，不写成 "60"
    expect(frameTimestamp(59.9996)).toBe('00-01-00-000');
    expect(frameTimestamp(-1)).toBe('00-00-00-000');
    expect(frameTimestamp(Number.NaN)).toBe('00-00-00-000');
    // 直播的进度可能超过 99 小时
    expect(frameTimestamp(360000)).toBe('100-00-00-000');
  });
  it('文件名：标题_时间戳_original_序号.png，与你给的样例同一格式', () => {
    expect(captureFileName("TWS (투어스) 'Freestyle' @ Spotify Performance Video", 'abc123DEF45', 30.804, 701)).toBe("TWS (투어스) 'Freestyle' @ Spotify Performance Video_00-00-30-804_original_00701.png");
    expect(captureFileName('全面接入 AI 后，我的工作方式彻底变了', 'abc123DEF45', 49.743, 576)).toBe('全面接入 AI 后，我的工作方式彻底变了_00-00-49-743_original_00576.png');
  });
  it('文件名：过滤非法字符、没有标题时用视频 ID、序号超过 5 位照常递增', () => {
    expect(captureFileName('AI: 安全/访谈?*"<>|', 'abc123DEF45', 1, 1)).toBe('AI 安全 访谈_00-00-01-000_original_00001.png');
    expect(captureFileName(undefined, 'abc123DEF45', 1, 2)).toBe('youtube-abc123DEF45_00-00-01-000_original_00002.png');
    expect(captureFileName('???', 'abc123DEF45', 1, 3)).toBe('youtube-abc123DEF45_00-00-01-000_original_00003.png');
    expect(captureFileName('CON', 'abc123DEF45', 1, 100000)).toBe('_CON_00-00-01-000_original_100000.png');
    expect(captureFileName('长'.repeat(200), 'abc123DEF45', 1, 1)).toBe(`${'长'.repeat(80)}_00-00-01-000_original_00001.png`);
  });
  const ctx = (over: Partial<ClipCaptureContext> = {}): ClipCaptureContext => ({
    enabled: true,
    videoId: 'abc123DEF45',
    shorts: false,
    hasVideo: true,
    ad: false,
    drm: false,
    ready: true,
    ...over,
  });
  it('截图前检查：能截时没有问题', () => {
    expect(checkCapture(ctx())).toBeUndefined();
    expect(checkCapture(ctx({ site: 'youtube' }))).toBeUndefined();
  });
  it('截图前检查：广告、DRM、画面没准备好、设置关闭、Shorts、不是视频页都说清楚', () => {
    expect(checkCapture(ctx({ ad: true }))).toContain('广告');
    expect(checkCapture(ctx({ drm: true }))).toContain('DRM');
    expect(checkCapture(ctx({ ready: false }))).toContain('画面还没准备好');
    expect(checkCapture(ctx({ enabled: false }))).toContain('设置中关闭');
    expect(checkCapture(ctx({ shorts: true }))).toContain('Shorts');
    expect(checkCapture(ctx({ videoId: null }))).toContain('不是视频播放页');
    expect(checkCapture(ctx({ hasVideo: false }))).toContain('没找到');
  });
  it('只限 YouTube：小红书的视频笔记不截', () => {
    expect(checkCapture(ctx({ site: 'xhs', videoId: '6ae9a4e000000000140281c6' }))).toBeUndefined();
    expect(checkCapture(ctx({ site: 'xhs', videoId: null }))).toContain('不是笔记详情');
    expect(checkCapture(ctx({ site: 'xhs', videoId: '6ae9a4e000000000140281c6', hasVideo: false }))).toContain('图文笔记');
    expect(captureFileName(undefined, '6ae9a4e000000000140281c6', 1, 2, 'xhs')).toBe('xhs-6ae9a4e000000000140281c6_00-00-01-000_original_00002.png');
  });
  it('PNG 分块传回：base64 编解码逐字节一致，超过一次 fromCharCode 的上限也行', () => {
    const bytes = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 31) % 256);
    const round = base64ToBytes(bytesToBase64(bytes));
    expect(round.length).toBe(bytes.length);
    expect(round.every((b, i) => b === bytes[i])).toBe(true);
    expect(base64ToBytes(bytesToBase64(new Uint8Array(0))).length).toBe(0);
    expect(new Uint8Array([137, 80, 78, 71])).toEqual(base64ToBytes('iVBORw=='));
  });
  it('每块转成 base64 后不超过 runtime 消息的单条上限（64 MB）', () => {
    expect((CLIPS.captureChunkBytes * 4) / 3).toBeLessThan(64 * 1024 * 1024);
  });
  it('序号存在本机：没存过是 0，存坏了回到 0，加锁递增', async () => {
    const ctx = { kv: memoryKV(), locker: memoryLocker() } as unknown as AppContext;
    expect(await stores.captureSeq.read(ctx.kv)).toBe(0);
    const next = () => stores.captureSeq.update(ctx.kv, ctx.locker, (n) => n + 1);
    // 两个标签页同时截图也不重号
    expect((await Promise.all([next(), next(), next()])).sort()).toEqual([1, 2, 3]);
    await ctx.kv.set(stores.captureSeq.key, 'x');
    expect(await stores.captureSeq.read(ctx.kv)).toBe(0);
    await ctx.kv.set(stores.captureSeq.key, -5);
    expect(await stores.captureSeq.read(ctx.kv)).toBe(0);
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
  it('按原尺寸输出；短边高于 1080 等比缩小；宽高取偶数；读不到尺寸用默认', () => {
    expect(outputSize(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(outputSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(outputSize(853, 481)).toEqual({ width: 854, height: 482 });
    expect(outputSize(0, 0)).toEqual(CLIPS.fallbackSize);
  });
  it('竖屏按短边算：X 的 720×1280 和小红书的 1080×1920 都不缩，更大的缩到短边 1080', () => {
    expect(outputSize(720, 1280)).toEqual({ width: 720, height: 1280 });
    expect(outputSize(1080, 1920)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(1440, 2560)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(2160, 3840)).toEqual({ width: 1080, height: 1920 });
  });
  it('横屏的结果与按高度算时一样：超宽屏也不多缩', () => {
    expect(outputSize(2560, 1080)).toEqual({ width: 2560, height: 1080 });
    expect(outputSize(1920, 804)).toEqual({ width: 1920, height: 804 });
  });
  it('码率按输出高度', () => {
    expect(videoBitrate(1080)).toBe(8_000_000);
    expect(videoBitrate(720)).toBe(5_000_000);
    expect(videoBitrate(482)).toBe(2_500_000);
    expect(videoBitrate(360)).toBe(1_500_000);
  });
  it('录音采样率固定 48 kHz（AAC 编码器只接受 44.1 / 48 kHz，蓝牙通话模式是 16 kHz）', () => {
    expect(CLIPS.audioSampleRate).toBe(48_000);
  });
});

describe('MP4 文件头里的轨', () => {
  const box = (type: string, ...children: Uint8Array[]): Uint8Array => {
    const len = 8 + children.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(len);
    new DataView(out.buffer).setUint32(0, len);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    let p = 8;
    for (const c of children) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  };
  const raw = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  const hdlr = (kind: string) => box('hdlr', new Uint8Array(8), raw(kind), new Uint8Array(12));
  const trak = (kind: string) => box('trak', box('tkhd', new Uint8Array(84)), box('mdia', box('mdhd', new Uint8Array(24)), hdlr(kind)));
  const cat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let p = 0;
    for (const x of parts) {
      out.set(x, p);
      p += x.length;
    }
    return out;
  };
  const ftyp = box('ftyp', raw('isom'), new Uint8Array(4));

  it('读出文件头声明的画面轨、声音轨', () => {
    expect(mp4TrackKinds(cat(ftyp, box('moov', box('mvhd', new Uint8Array(100)), trak('vide'), trak('soun'))))).toEqual(['vide', 'soun']);
    expect(mp4TrackKinds(cat(ftyp, box('moov', trak('vide')), box('moof', box('mfhd', new Uint8Array(8)))))).toEqual(['vide']);
  });
  it('文件头还没写全：返回 undefined，等更多数据再查', () => {
    const full = cat(ftyp, box('moov', trak('vide'), trak('soun')));
    expect(mp4TrackKinds(full.subarray(0, full.length - 5))).toBeUndefined();
    expect(mp4TrackKinds(ftyp)).toBeUndefined();
    expect(mp4TrackKinds(ftyp.subarray(0, 6))).toBeUndefined();
    expect(mp4TrackKinds(new Uint8Array(0))).toBeUndefined();
  });
  it('文件头之前就出现分片或数据：没有可用的文件头', () => {
    expect(mp4TrackKinds(cat(ftyp, box('moof', box('mfhd', new Uint8Array(8)))))).toEqual([]);
  });
  it('Chrome 156 实录：开头暂停过的文件头只有画面轨，正常的有两条轨', () => {
    const head = (name: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', name)));
    // 录音机 start() 后暂停 6 秒再继续（2026-11-02 用户报告的无声片段同样只有画面轨）
    expect(mp4TrackKinds(head('chrome156-mp4-head-video-only.bin'))).toEqual(['vide']);
    expect(mp4TrackKinds(head('chrome156-mp4-head-av.bin'))?.sort()).toEqual(['soun', 'vide']);
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
  it('小红书：不是笔记详情、图文笔记（没有视频）分别说清楚', () => {
    const xhs = (over: Partial<ClipStartContext> = {}) => ctx({ site: 'xhs', videoId: '6ae9a4e000000000140281c6', duration: 23.8, ...over });
    expect(checkClipStart({ mode: 'free' }, xhs())).toBeUndefined();
    expect(checkClipStart({ mode: 'free' }, xhs({ videoId: null }))).toContain('不是笔记详情');
    expect(checkClipStart({ mode: 'free' }, xhs({ hasVideo: false }))).toContain('图文笔记');
    expect(checkClipStart({ mode: 'free' }, xhs({ enabled: false }))).toContain('设置中关闭');
    expect(clipUnavailable('youtube', { enabled: true, videoId: null, shorts: false, hasVideo: false })).toContain('不是视频播放页');
  });
  it('离结尾不到半秒算到了结尾；时长未知不算', () => {
    expect(atVideoEnd(23.61, 23.77)).toBe(true);
    expect(atVideoEnd(23.2, 23.77)).toBe(false);
    expect(atVideoEnd(5000, Infinity)).toBe(false);
    expect(atVideoEnd(0, 0)).toBe(false);
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
  it('广告放完不算视频播完：接着等正片（酷播的片头广告和正片用同一个播放器放）', () => {
    expect(decideClip(control({ recordedSec: 0 }), sample({ ad: true, ended: true, paused: true }))).toEqual({ kind: 'wait', why: 'ad' });
    expect(decideClip(control({ recordedSec: 0 }), sample({ ad: true, stalled: true, currentTime: 19.9, duration: 20 }))).toEqual({ kind: 'wait', why: 'ad' });
    const range = control({ mode: 'range', start: 10, end: 60, recordedSec: 3 });
    expect(decideClip(range, sample({ ad: true, ended: true, currentTime: 20 }))).toEqual({ kind: 'wait', why: 'ad' });
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
  it('播放中进度卡住：当缓冲，不录静止画面；卡在结尾（小红书的播放器不报"播完"）：算播完', () => {
    expect(decideClip(control(), sample({ stalled: true, duration: 600 }))).toEqual({ kind: 'wait', why: 'seeking' });
    expect(decideClip(control(), sample({ stalled: true }))).toEqual({ kind: 'wait', why: 'seeking' });
    // 2026-11-04 实测：停在 23.609 秒，时长 23.767 秒，既不暂停也不 ended
    expect(decideClip(control(), sample({ stalled: true, currentTime: 23.609, duration: 23.767 }))).toEqual({ kind: 'stop', reason: 'ended' });
    // 在结尾附近但还在往前走：照录
    expect(decideClip(control(), sample({ currentTime: 23.4, duration: 23.767 }))).toEqual({ kind: 'record' });
    const range = control({ mode: 'range', start: 10, end: 23.767, recordedSec: 5 });
    expect(decideClip(range, sample({ stalled: true, currentTime: 23.609, duration: 23.767 }))).toEqual({ kind: 'stop', reason: 'range-end' });
    // 你按了暂停、标签页在后台时，先说这些原因
    expect(decideClip(control({ userPaused: true }), sample({ stalled: true }))).toEqual({ kind: 'wait', why: 'user' });
    expect(decideClip(control(), sample({ stalled: true, visible: false }))).toEqual({ kind: 'wait', why: 'hidden' });
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

const XHS_NOTE = '6ae9a4e000000000140281c6';

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
  it('回到这一段的地址；小红书回到这篇笔记', () => {
    expect(clipWatchUrl({ videoId: 'abc123DEF45', start: 723.9 })).toBe('https://www.youtube.com/watch?v=abc123DEF45&t=723s');
    expect(clipWatchUrl({ site: 'xhs', videoId: XHS_NOTE, url: `https://www.xiaohongshu.com/explore/${XHS_NOTE}?xsec_token=AB1%3D`, start: 5 })).toBe(`https://www.xiaohongshu.com/explore/${XHS_NOTE}?xsec_token=AB1%3D`);
    expect(clipWatchUrl({ site: 'xhs', videoId: XHS_NOTE, start: 5 })).toBe(`https://www.xiaohongshu.com/explore/${XHS_NOTE}`);
  });
  it('小红书的记录：笔记 ID 与链接对得上才收，链接只留 xsec_token / xsec_source；站点由后台定，不信记录自己写的', () => {
    const xhs = { ...good, videoId: XHS_NOTE, url: `https://www.xiaohongshu.com/explore/${XHS_NOTE}?xsec_token=AB1%3D&xsec_source=pc_feed&utm=x`, site: 'youtube' };
    expect(sanitizeClipRecord(xhs, 'xhs')).toEqual({ ...good, site: 'xhs', videoId: XHS_NOTE, url: `https://www.xiaohongshu.com/explore/${XHS_NOTE}?xsec_token=AB1%3D&xsec_source=pc_feed` });
    // 浮层从博主主页打开时的网址
    expect(sanitizeClipRecord({ ...xhs, url: `https://www.rednote.com/user/profile/67398f95000000001d02d725/${XHS_NOTE}` }, 'xhs')?.url).toBe(`https://www.rednote.com/user/profile/67398f95000000001d02d725/${XHS_NOTE}`);
    expect(sanitizeClipRecord({ ...xhs, url: 'https://www.xiaohongshu.com/explore/6abce5c40000000015002d3b' }, 'xhs')).toBeNull();
    expect(sanitizeClipRecord({ ...xhs, url: `https://evil.example/explore/${XHS_NOTE}` }, 'xhs')).toBeNull();
    expect(sanitizeClipRecord({ ...xhs, url: undefined }, 'xhs')).toBeNull();
    expect(sanitizeClipRecord({ ...xhs, videoId: 'abc123DEF45' }, 'xhs')).toBeNull();
    // YouTube 页面送来的记录：小红书的笔记 ID 不认；写了站点和链接也不收
    expect(sanitizeClipRecord(xhs)).toBeNull();
    expect(sanitizeClipRecord({ ...good, site: 'xhs', url: 'https://www.xiaohongshu.com/explore/x' })).toEqual(good);
  });
  it('后台：校验后存进本地，不合格的不存；可以清空', async () => {
    const ctx = { kv: memoryKV(), locker: memoryLocker() } as unknown as AppContext;
    expect(await recordSavedClip(ctx, { ...good, videoId: 'bad id' })).toBeNull();
    expect(await stores.clipLog.read(ctx.kv)).toEqual([]);
    expect(await recordSavedClip(ctx, good)).toEqual(good);
    expect(await recordSavedClip(ctx, { ...good, id: 'clip_2' })).not.toBeNull();
    expect((await stores.clipLog.read(ctx.kv)).map((x) => x.id)).toEqual(['clip_2', 'clip_1']);
    const xhs = await recordSavedClip(ctx, { ...good, id: 'clip_3', videoId: XHS_NOTE, url: `https://www.rednote.com/explore/${XHS_NOTE}?xsec_token=AB1%3D` }, 'xhs');
    expect(xhs?.site).toBe('xhs');
    expect((await stores.clipLog.read(ctx.kv)).map((x) => x.id)).toEqual(['clip_3', 'clip_2', 'clip_1']);
    await clearClipLog(ctx);
    expect(await stores.clipLog.read(ctx.kv)).toEqual([]);
  });
});

describe('X 帖子页', () => {
  const POST = '2117650684774580249';
  const record = {
    id: 'clip_x',
    videoId: POST,
    title: 'Ayo O - I reverse engineered tiktok',
    mode: 'free',
    start: 5,
    end: 15,
    durationSec: 10,
    bytes: 1_200_000,
    format: 'MP4（H.264 + AAC）',
    fileName: 'Ayo O - I reverse engineered tiktok_00m05s-00m15s.mp4',
    burned: false,
    savedAt: 1_700_000_000_000,
  };

  it('页面标题（2026-11-06 真实页面的写法）→"作者 - 正文"，去掉 t.co 短链', () => {
    expect(titleFromDocumentTitle('X 上的 Ayo O：“I reverse engineered tiktok https://t.co/TEV1YKfAZQ” / X', 'x')).toBe('Ayo O - I reverse engineered tiktok');
    expect(titleFromDocumentTitle('(3) X 上的 Ayo O：“I reverse engineered tiktok https://t.co/TEV1YKfAZQ” / X', 'x')).toBe('Ayo O - I reverse engineered tiktok');
    expect(titleFromDocumentTitle('Ayo O on X: "I reverse engineered tiktok https://t.co/TEV1YKfAZQ" / X', 'x')).toBe('Ayo O - I reverse engineered tiktok');
  });
  it('帖子只有视频、没有文字：只留作者；认不出的写法也去掉结尾和短链', () => {
    expect(titleFromDocumentTitle('X 上的 Ayo O：“https://t.co/TEV1YKfAZQ” / X', 'x')).toBe('Ayo O');
    expect(titleFromDocumentTitle('Ayo O sur X : « demo https://t.co/abc » / X', 'x')).toBe('Ayo O sur X : « demo »');
  });
  it('还在加载或不是帖子的页面标题不当视频标题', () => {
    for (const t of ['X', '帖子 / X', 'Post / X', '(2) 帖子 / X']) expect(titleFromDocumentTitle(t, 'x')).toBe('');
  });
  it('文件名：作者 - 正文_起点-终点；没有标题时用 x-帖子ID', () => {
    expect(clipFileName('Ayo O - I reverse engineered tiktok', POST, 5.2, 15.7, 'mp4', 'x')).toBe('Ayo O - I reverse engineered tiktok_00m05s-00m15s.mp4');
    expect(clipFileName(undefined, POST, 5, 15, 'webm', 'x')).toBe(`x-${POST}_00m05s-00m15s.webm`);
  });

  it('网址：帖子页、全屏视图和 /i/ 的写法都认，规范链接去掉 /video/1 和分享参数', () => {
    const canonical = { id: POST, url: `https://x.com/ayoships/status/${POST}` };
    expect(parseXStatusUrl(`https://x.com/ayoships/status/${POST}`)).toEqual(canonical);
    expect(parseXStatusUrl(`https://x.com/ayoships/status/${POST}/video/1`)).toEqual(canonical);
    expect(parseXStatusUrl(`https://x.com/ayoships/status/${POST}/photo/2?s=20&t=sharerToken`)).toEqual(canonical);
    expect(parseXStatusUrl(`https://x.com/i/status/${POST}`)).toEqual({ id: POST, url: `https://x.com/i/status/${POST}` });
    expect(parseXStatusUrl(`https://x.com/i/web/status/${POST}`)).toEqual({ id: POST, url: `https://x.com/i/status/${POST}` });
    expect(parseXStatusUrl(`https://x.com/i_love/status/${POST}`)?.url).toBe(`https://x.com/i_love/status/${POST}`);
  });
  it('网址：时间线、主页、伪造域名、官方 API 都不算帖子页', () => {
    for (const url of [
      'https://x.com/home',
      'https://x.com/ayoships',
      'https://x.com/ayoships/status/not-a-number',
      `https://x.com.evil.example/ayoships/status/${POST}`,
      `https://x.com@evil.example/ayoships/status/${POST}`,
      `https://api.x.com/2/ayoships/status/${POST}`,
      `http://x.com/ayoships/status/${POST}`,
      `https://www.youtube.com/ayoships/status/${POST}`,
      'not a url',
    ]) {
      expect(parseXStatusUrl(url)).toBeUndefined();
    }
  });
  it('判断站点：只认 x.com 本身', () => {
    expect(isXPage('https://x.com/home')).toBe(true);
    expect(isXPage('https://x.com.evil.example/home')).toBe(false);
    expect(isXPage('https://www.youtube.com/watch?v=abc')).toBe(false);
  });

  it('不能录的原因用人话说：不是帖子页 / 帖子里没有视频', () => {
    expect(clipUnavailable('x', { enabled: true, videoId: null, shorts: false, hasVideo: false })).toContain('不是帖子详情');
    expect(clipUnavailable('x', { enabled: true, videoId: POST, shorts: false, hasVideo: false })).toContain('这条帖子里没有视频');
    expect(clipUnavailable('x', { enabled: true, videoId: POST, shorts: false, hasVideo: true })).toBeUndefined();
    expect(clipUnavailable('x', { enabled: false, videoId: POST, shorts: false, hasVideo: true })).toContain('已在设置中关闭');
  });
  it('Capture：帖子页能截；不是帖子页、没有视频、受保护、画面没准备好时说明原因', () => {
    const ctx: ClipCaptureContext = { site: 'x', enabled: true, videoId: POST, shorts: false, hasVideo: true, ad: false, drm: false, ready: true };
    expect(checkCapture(ctx)).toBeUndefined();
    expect(checkCapture({ ...ctx, videoId: null })).toContain('不是帖子详情');
    expect(checkCapture({ ...ctx, hasVideo: false })).toContain('这条帖子里没有视频');
    expect(checkCapture({ ...ctx, drm: true })).toContain('DRM');
    expect(checkCapture({ ...ctx, ready: false })).toContain('画面还没准备好');
    expect(checkCapture({ ...ctx, enabled: false })).toContain('设置中关闭');
  });
  it('Capture 文件名：作者 - 正文_时间戳_original_序号；没有标题时用 x-帖子ID', () => {
    expect(captureFileName('Ayo O - I reverse engineered tiktok', POST, 30.804, 701, 'x')).toBe('Ayo O - I reverse engineered tiktok_00-00-30-804_original_00701.png');
    expect(captureFileName(undefined, POST, 1, 2, 'x')).toBe(`x-${POST}_00-00-01-000_original_00002.png`);
  });

  it('屏幕里的面积：滚到屏幕外是 0，只露一半算一半', () => {
    expect(visibleArea({ left: 184, top: 156, right: 470, bottom: 664 }, 1253, 1023)).toBe(286 * 508);
    expect(visibleArea({ left: 231, top: 1876, right: 749, bottom: 2394 }, 1253, 1023)).toBe(0);
    expect(visibleArea({ left: 0, top: 900, right: 100, bottom: 1100 }, 1253, 1000)).toBe(100 * 100);
    expect(visibleArea({ left: 0, top: -300, right: 100, bottom: -100 }, 1253, 1000)).toBe(0);
  });
  describe('一页有好几个视频时录哪个', () => {
    const v = (over: Partial<XVideoView>): XVideoView => ({ visibleArea: 0, inDialog: false, playing: false, started: false, ...over });
    it('帖子页（实测）：回复里的视频比主帖大，但在屏幕外、没播，录主帖', () => {
      expect(pickXVideo([v({ visibleArea: 145_543, playing: true, started: true }), v({}), v({})])).toBe(0);
    });
    it('全屏视图（实测）：录弹层里的，不录底下被盖住的；直接打开时它还没开始播', () => {
      expect(pickXVideo([v({ visibleArea: 539_762, inDialog: true }), v({ inDialog: true }), v({ visibleArea: 145_543 }), v({})])).toBe(0);
      // 底下的那个在页面上排在前面时也一样
      expect(pickXVideo([v({ visibleArea: 145_543 }), v({ visibleArea: 539_762, inDialog: true })])).toBe(1);
    });
    it('滚到回复区：屏幕上在播的回复视频才是你在看的', () => {
      expect(pickXVideo([v({ started: true }), v({ visibleArea: 268_000, playing: true, started: true })])).toBe(1);
    });
    it('你暂停了主帖的视频：不被屏幕上更大、没动过的回复视频抢走', () => {
      expect(pickXVideo([v({ visibleArea: 100_000, started: true }), v({ visibleArea: 200_000 })])).toBe(0);
    });
    it('都一样时取屏幕里更大的；再一样取靠前的；一个都没有返回 -1', () => {
      expect(pickXVideo([v({ visibleArea: 100 }), v({ visibleArea: 200 })])).toBe(1);
      expect(pickXVideo([v({ visibleArea: 100 }), v({ visibleArea: 100 })])).toBe(0);
      expect(pickXVideo([])).toBe(-1);
    });
  });

  it('录制记录：帖子 ID 与链接对得上才收，链接规范化；站点由后台定，不信记录自己写的', () => {
    const raw = { ...record, url: `https://x.com/ayoships/status/${POST}/video/1?s=20&t=sharerToken`, site: 'youtube' };
    expect(sanitizeClipRecord(raw, 'x')).toEqual({ ...record, site: 'x', url: `https://x.com/ayoships/status/${POST}` });
    expect(sanitizeClipRecord({ ...raw, url: 'https://x.com/ayoships/status/1' }, 'x')).toBeNull();
    expect(sanitizeClipRecord({ ...raw, url: `https://evil.example/ayoships/status/${POST}` }, 'x')).toBeNull();
    expect(sanitizeClipRecord({ ...raw, url: 'https://x.com/home' }, 'x')).toBeNull();
    expect(sanitizeClipRecord({ ...raw, url: undefined }, 'x')).toBeNull();
    expect(sanitizeClipRecord({ ...raw, videoId: 12345 }, 'x')).toBeNull();
    expect(sanitizeClipRecord({ ...raw, videoId: '../../etc' }, 'x')).toBeNull();
    // 同样的记录从 YouTube 页面送来：写了站点和链接也不收
    expect(sanitizeClipRecord({ ...raw, videoId: 'abc123DEF45' })?.site).toBeUndefined();
    expect(sanitizeClipRecord({ ...raw, videoId: 'abc123DEF45' })?.url).toBeUndefined();
  });
  it('回到这条帖子：有链接用链接，旧数据里没有时拼 /i/status/', () => {
    expect(clipWatchUrl({ site: 'x', videoId: POST, url: `https://x.com/ayoships/status/${POST}`, start: 5 })).toBe(`https://x.com/ayoships/status/${POST}`);
    expect(clipWatchUrl({ site: 'x', videoId: POST, start: 5 })).toBe(`https://x.com/i/status/${POST}`);
  });
  it('后台：X 的片段存进本地，带上站点和帖子链接', async () => {
    const ctx = { kv: memoryKV(), locker: memoryLocker() } as unknown as AppContext;
    const saved = await recordSavedClip(ctx, { ...record, url: `https://x.com/ayoships/status/${POST}` }, 'x');
    expect(saved).toMatchObject({ site: 'x', videoId: POST, url: `https://x.com/ayoships/status/${POST}` });
    expect((await stores.clipLog.read(ctx.kv)).map((x) => x.id)).toEqual(['clip_x']);
  });
});

describe('酷播播放页', () => {
  const MOVIE = '8aZsQlwuJ1E';
  const SHOW = 'e2rCXFzJUz2';
  const EPISODE = 'lIM07A3d3g8';
  const record = {
    id: 'clip_kubb',
    videoId: `${SHOW}.${EPISODE}`,
    title: '玉簟秋-02',
    mode: 'free',
    start: 107,
    end: 127,
    durationSec: 20,
    bytes: 2_400_000,
    format: 'MP4（H.264 + AAC）',
    fileName: '玉簟秋-02_01m47s-02m07s.mp4',
    burned: false,
    savedAt: 1_700_000_000_000,
  };

  it('页面标题（2026-11-10 真实页面的写法）→ 片名；剧集带集数', () => {
    expect(titleFromDocumentTitle('八仙！-免费在线观看-酷播', 'kubb')).toBe('八仙！');
    expect(titleFromDocumentTitle('玉簟秋-24-免费在线观看-酷播', 'kubb')).toBe('玉簟秋-24');
    expect(titleFromDocumentTitle('(2) 玉簟秋-02-免费在线观看-酷播', 'kubb')).toBe('玉簟秋-02');
    // 片名里自己带连字符
    expect(titleFromDocumentTitle('X-Men-免费在线观看-酷播', 'kubb')).toBe('X-Men');
  });
  it('首页的标题不当片名；认不出的写法原样用', () => {
    expect(titleFromDocumentTitle('酷播-海量高清视频免费在线观看', 'kubb')).toBe('');
    expect(titleFromDocumentTitle('酷播', 'kubb')).toBe('');
    expect(titleFromDocumentTitle('八仙！ | 酷播', 'kubb')).toBe('八仙！ | 酷播');
  });
  it('文件名：片名_起点-终点；没有标题时用 kubb-影片ID', () => {
    expect(clipFileName('八仙！', MOVIE, 5.2, 15.7, 'mp4', 'kubb')).toBe('八仙！_00m05s-00m15s.mp4');
    expect(clipFileName('玉簟秋-02', `${SHOW}.${EPISODE}`, 107, 3725, 'mp4', 'kubb')).toBe('玉簟秋-02_01m47s-1h02m05s.mp4');
    expect(clipFileName(undefined, `${SHOW}.${EPISODE}`, 5, 15, 'webm', 'kubb')).toBe(`kubb-${SHOW}.${EPISODE}_00m05s-00m15s.webm`);
    expect(captureFileName('八仙！', MOVIE, 30.804, 12, 'kubb')).toBe('八仙！_00-00-30-804_original_00012.png');
  });

  it('网址：/play/影片ID；换集带 ?id=分集ID，算另一个视频；别的参数去掉', () => {
    expect(parseKubbPlayUrl(`https://www.kubb.tv/play/${MOVIE}`)).toEqual({ id: MOVIE, url: `https://www.kubb.tv/play/${MOVIE}` });
    expect(parseKubbPlayUrl(`https://www.kubb.tv/play/${SHOW}?id=${EPISODE}`)).toEqual({ id: `${SHOW}.${EPISODE}`, url: `https://www.kubb.tv/play/${SHOW}?id=${EPISODE}` });
    expect(parseKubbPlayUrl(`https://www.kubb.tv/play/${SHOW}?from=share&id=${EPISODE}&u=someone#t=30`)?.url).toBe(`https://www.kubb.tv/play/${SHOW}?id=${EPISODE}`);
    expect(parseKubbPlayUrl(`https://www.kubb.tv/play/${MOVIE}/`)?.id).toBe(MOVIE);
    // 分集 ID 写得不像 ID：当没有，不带进链接
    expect(parseKubbPlayUrl(`https://www.kubb.tv/play/${SHOW}?id=../../x`)).toEqual({ id: SHOW, url: `https://www.kubb.tv/play/${SHOW}` });
    // 12 位的 ID 也有（当天首页上 11 位、12 位都见到了）
    expect(parseKubbPlayUrl('https://www.kubb.tv/play/abcDEF123456')?.id).toBe('abcDEF123456');
  });
  it('网址：首页、榜单、短视频页、伪造域名都不算播放页', () => {
    for (const url of [
      'https://www.kubb.tv/',
      'https://www.kubb.tv/list/drama',
      'https://www.kubb.tv/play/',
      `https://www.kubb.tv/play/${MOVIE}/extra`,
      `https://www.kubb.tv/watch?v=${MOVIE}`,
      `https://www.kubb.tv/space/${MOVIE}`,
      `https://kubb.tv/play/${MOVIE}`,
      `https://www.kubb.tv.evil.example/play/${MOVIE}`,
      `https://www.kubb.tv@evil.example/play/${MOVIE}`,
      `http://www.kubb.tv/play/${MOVIE}`,
      `https://www.youtube.com/play/${MOVIE}`,
      'not a url',
    ]) {
      expect(parseKubbPlayUrl(url)).toBeUndefined();
    }
  });
  it('判断站点：只认 www.kubb.tv 本身', () => {
    expect(isKubbPage('https://www.kubb.tv/')).toBe(true);
    expect(isKubbPage(`https://www.kubb.tv/play/${MOVIE}`)).toBe(true);
    expect(isKubbPage('https://www.kubb.tv.evil.example/')).toBe(false);
    expect(isKubbPage('https://x.com/home')).toBe(false);
    expect(isXPage(`https://www.kubb.tv/play/${MOVIE}`)).toBe(false);
  });

  it('片头广告（实测）：播放器里放的不是 blob: 流、又很短；正片、时长未知、长视频都不算', () => {
    // 2026-11-10 实测：20 秒的 VIP 宣传片，从别的域名直接给地址
    expect(isKubbAd('https://s1-a1.global-cdn.me/vod/70E1952268-10161.mp4', 20.02)).toBe(true);
    expect(isKubbAd('https://s1-a1.global-cdn.me/vod/x.mp4', CLIPS.kubbAdMaxSec)).toBe(true);
    // 正片：同源的 blob: 流（电影 8596 秒、剧集 2871 秒）
    expect(isKubbAd('blob:https://www.kubb.tv/4bd02587-f0a0-4180-8c3d-794a29649e3a', 8596.48)).toBe(false);
    expect(isKubbAd('blob:https://www.kubb.tv/f8daa22a-f47d-488d-a63e-63f5cc1119bd', 20)).toBe(false);
    // 宁可漏判：时长还不知道、直接给地址的长视频、还没有片源
    expect(isKubbAd('https://s1-a1.global-cdn.me/vod/x.mp4', NaN)).toBe(false);
    expect(isKubbAd('https://s1-a1.global-cdn.me/vod/x.mp4', Infinity)).toBe(false);
    expect(isKubbAd('https://s1-a1.global-cdn.me/vod/long.mp4', CLIPS.kubbAdMaxSec + 1)).toBe(false);
    expect(isKubbAd('', 20)).toBe(false);
  });

  it('不能录的原因用人话说：不是播放页 / 没找到视频', () => {
    expect(clipUnavailable('kubb', { enabled: true, videoId: null, shorts: false, hasVideo: false })).toContain('不是播放页');
    expect(clipUnavailable('kubb', { enabled: true, videoId: MOVIE, shorts: false, hasVideo: false })).toContain('没找到播放器里的视频');
    expect(clipUnavailable('kubb', { enabled: true, videoId: MOVIE, shorts: false, hasVideo: true })).toBeUndefined();
    expect(clipUnavailable('kubb', { enabled: false, videoId: MOVIE, shorts: false, hasVideo: true })).toContain('已在设置中关闭');
  });
  it('Capture：播放页能截；广告、受保护、画面没准备好、不是播放页时说明原因', () => {
    const ctx: ClipCaptureContext = { site: 'kubb', enabled: true, videoId: MOVIE, shorts: false, hasVideo: true, ad: false, drm: false, ready: true };
    expect(checkCapture(ctx)).toBeUndefined();
    expect(checkCapture({ ...ctx, ad: true })).toContain('广告');
    expect(checkCapture({ ...ctx, drm: true })).toContain('DRM');
    expect(checkCapture({ ...ctx, ready: false })).toContain('画面还没准备好');
    expect(checkCapture({ ...ctx, videoId: null })).toContain('不是播放页');
  });

  it('录制记录：ID 与链接对得上才收，链接规范化；站点由后台定，不信记录自己写的', () => {
    const url = `https://www.kubb.tv/play/${SHOW}?id=${EPISODE}`;
    const raw = { ...record, url: `${url}&from=share`, site: 'youtube' };
    expect(sanitizeClipRecord(raw, 'kubb')).toEqual({ ...record, site: 'kubb', url });
    // 电影：没有分集
    expect(sanitizeClipRecord({ ...raw, videoId: MOVIE, url: `https://www.kubb.tv/play/${MOVIE}` }, 'kubb')).toMatchObject({ site: 'kubb', videoId: MOVIE, url: `https://www.kubb.tv/play/${MOVIE}` });
    // 对不上：别的影片、少了分集、别的域名、不是播放页、没有链接、ID 不是字符串
    expect(sanitizeClipRecord({ ...raw, url: `https://www.kubb.tv/play/${MOVIE}?id=${EPISODE}` }, 'kubb')).toBeNull();
    expect(sanitizeClipRecord({ ...raw, url: `https://www.kubb.tv/play/${SHOW}` }, 'kubb')).toBeNull();
    expect(sanitizeClipRecord({ ...raw, url: `https://evil.example/play/${SHOW}?id=${EPISODE}` }, 'kubb')).toBeNull();
    expect(sanitizeClipRecord({ ...raw, url: 'https://www.kubb.tv/' }, 'kubb')).toBeNull();
    expect(sanitizeClipRecord({ ...raw, url: undefined }, 'kubb')).toBeNull();
    expect(sanitizeClipRecord({ ...raw, videoId: 12345 }, 'kubb')).toBeNull();
    expect(sanitizeClipRecord({ ...raw, videoId: '../../etc' }, 'kubb')).toBeNull();
    // 同样的记录从 X 页面、YouTube 页面送来：都不收成酷播的
    expect(sanitizeClipRecord(raw, 'x')).toBeNull();
    expect(sanitizeClipRecord(raw)).toBeNull();
  });
  it('回到这部影片（这一集）：有链接用链接，没有时按 ID 拼', () => {
    expect(clipWatchUrl({ site: 'kubb', videoId: MOVIE, url: `https://www.kubb.tv/play/${MOVIE}`, start: 5 })).toBe(`https://www.kubb.tv/play/${MOVIE}`);
    expect(clipWatchUrl({ site: 'kubb', videoId: MOVIE, start: 5 })).toBe(`https://www.kubb.tv/play/${MOVIE}`);
    expect(clipWatchUrl({ site: 'kubb', videoId: `${SHOW}.${EPISODE}`, start: 5 })).toBe(`https://www.kubb.tv/play/${SHOW}?id=${EPISODE}`);
  });
  it('后台：酷播的片段存进本地，带上站点和播放页链接', async () => {
    const ctx = { kv: memoryKV(), locker: memoryLocker() } as unknown as AppContext;
    const url = `https://www.kubb.tv/play/${SHOW}?id=${EPISODE}`;
    const saved = await recordSavedClip(ctx, { ...record, url }, 'kubb');
    expect(saved).toMatchObject({ site: 'kubb', videoId: `${SHOW}.${EPISODE}`, url });
    expect((await stores.clipLog.read(ctx.kv)).map((x) => x.id)).toEqual(['clip_kubb']);
  });
});

describe('设置', () => {
  it('默认：启用、不烧录字幕、停止后直接保存、单段 10 分钟；旧数据没有这一节也能读', () => {
    expect(DEFAULT_SETTINGS.clips).toEqual({ enabled: true, burnSubtitles: false, autoSave: true, maxMinutes: 10 });
    expect(mergeSettings({ subtitles: { enabled: false } }).clips).toEqual(DEFAULT_SETTINGS.clips);
    expect(mergeSettings({ clips: { burnSubtitles: true } }).clips).toEqual({ ...DEFAULT_SETTINGS.clips, burnSubtitles: true });
  });
});
