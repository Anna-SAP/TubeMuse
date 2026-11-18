// 中文配音的两项新增（用户 2026-11-18 要求）：
// 1. 视频控制键（DECISIONS §85）：暂停 / 播放，后退 5/10/30/60 秒，前进 5/10/15/30/60 秒；跳完、停下之后配音照现在的对齐跟上。
// 2. 配音字幕（DECISIONS §86）：配音的字幕按配音实际放到的位置显示（不按视频时间）；语言跟配音走；样式可调；
//    字幕存在本机，随配音一起移除，进导出，不联网。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, DUB, DUB_SUB_FONTS } from '../../src/config/defaults';
import { ENDPOINTS } from '../../src/config/endpoints';
import {
  dubSeekTarget,
  dubStep,
  parseDubControl,
  sanitizeDubIndex,
  sanitizeDubSubsMeta,
  seekLabel,
  type DubAnchor,
  type DubAudioSample,
  type DubMap,
  type DubVideoSample,
} from '../../src/core/dub';
import {
  dubCueAt,
  dubPlayback,
  dubSubCss,
  dubSubFontPx,
  dubSubHiddenText,
  dubSubVisible,
  dubSubsKey,
  dubSubsMetaText,
  dubSubsNote,
  hexToRgba,
  lineLang,
  prepareDubCues,
  publishDubPlayback,
  rankXyzForDub,
  sanitizeDubSubStyle,
  sanitizeDubSubsDoc,
  xyzCueOwnLine,
  xyzCuesForDub,
} from '../../src/core/dub-subs';
import { SubtitleFileError, type SubCue } from '../../src/core/subtitle-track';
import type { XyzCue, XyzTranscript } from '../../src/core/xyz';
import type { AuthProvider } from '../../src/services/auth';
import type { AppContext } from '../../src/services/context';
import { clearAll, exportAll } from '../../src/services/data-service';
import { attachDub, copyXyzSubsForDub, listXyzSubsForDub, readDubSubtitles, removeDub, removeDubSubtitles, setDubSubtitleFile, setDubSubtitles } from '../../src/services/dub-service';
import { memoryDubStore } from '../../src/services/dub-store';
import { dubSubsStore, mergeSettings, stores, xyzTranscriptStore } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';

const M4A = new Uint8Array(readFileSync(new URL('../fixtures/xyz-tones.m4a', import.meta.url)));
const NOW = Date.parse('2026-11-18T02:00:00Z');
const VID = 'ys6YQ2yfBpM';

function setup() {
  const kv = memoryKV();
  const dubAudio = memoryDubStore();
  const auth = { disconnect: async () => ({ revoked: false }) } as unknown as AuthProvider;
  const blocked = (() => {
    throw new Error('配音字幕不该发网络请求');
  }) as unknown as typeof fetch;
  let t = NOW;
  const ctx: AppContext = { kv, locker: memoryLocker(), http: blocked, now: () => t++, auth, endpoints: ENDPOINTS, timeZone: 'Asia/Shanghai', dubAudio };
  return { ctx, kv, dubAudio };
}

const m4a = () => new Blob([M4A as BlobPart], { type: 'audio/x-m4a' });
const srtBlob = (text: string) => new Blob([text], { type: 'application/x-subrip' });

const video = (over: Partial<DubVideoSample> = {}): DubVideoSample => ({ currentTime: 100, paused: false, ended: false, seeking: false, canPlay: true, rate: 1, ad: false, ...over });
const audio = (over: Partial<DubAudioSample> = {}): DubAudioSample => ({ currentTime: 100, paused: false, duration: 4000, rate: 1, ...over });
const map = (delaySec: number, anchors: DubAnchor[] = [], quickRate?: number): DubMap => ({ delaySec, anchors, ...(quickRate !== undefined ? { quickRate } : {}) });

describe('视频控制键（DECISIONS §85）', () => {
  it('档位是用户指定的：后退 5 / 10 / 30 / 60 秒，前进 5 / 10 / 15 / 30 / 60 秒', () => {
    expect([...DUB.transport.backSec]).toEqual([5, 10, 30, 60]);
    expect([...DUB.transport.forwardSec]).toEqual([5, 10, 15, 30, 60]);
    expect(seekLabel(-30)).toBe('« 30 秒');
    expect(seekLabel(15)).toBe('15 秒 »');
  });

  it('只认像样的控制消息：暂停 / 播放，或有限、不为 0、一次不超过一小时的跳转', () => {
    expect(parseDubControl({ action: 'toggle-play' })).toEqual({ action: 'toggle-play' });
    expect(parseDubControl({ action: 'seek', by: -10 })).toEqual({ action: 'seek', by: -10 });
    expect(parseDubControl({ action: 'seek', by: 60 })).toEqual({ action: 'seek', by: 60 });
    for (const bad of [undefined, null, {}, { action: 'seek' }, { action: 'seek', by: 0 }, { action: 'seek', by: NaN }, { action: 'seek', by: '5' }, { action: 'seek', by: 1e9 }, { action: 'click' }]) {
      expect(parseDubControl(bad)).toBeUndefined();
    }
  });

  it('跳到哪里：不早于开头、不晚于结尾；读不到时长时只挡开头', () => {
    expect(dubSeekTarget(53, 5, 5235)).toBe(58);
    expect(dubSeekTarget(53, -60, 5235)).toBe(0);
    expect(dubSeekTarget(5200, 60, 5235)).toBe(5235);
    expect(dubSeekTarget(100, 30, NaN)).toBe(130);
    expect(dubSeekTarget(NaN, 30, 600)).toBe(30);
  });

  it('前进之后配音照现在的对齐跟上：手动对齐时到"视频位置 − 这一段的偏移"', () => {
    // 开头偏移 +2.5；对齐点：视频 10:00 ↔ 中文 9:40（这一段偏移 20 秒）
    const mp = map(2.5, [{ video: 600, dub: 580 }]);
    // 从 9:50 前进 30 秒到 10:20，越过了对齐点：跳转途中配音停着
    const after = dubSeekTarget(590, 30, 3600);
    expect(dubStep(video({ currentTime: after, seeking: true }), audio({ currentTime: 587.5 }), mp)).toMatchObject({ play: false, reason: 'seeking' });
    // 跳完：配音到新的一段的位置（10:20 − 20 秒 = 中文 10:00）
    expect(dubStep(video({ currentTime: after }), audio({ currentTime: 587.5 }), mp)).toMatchObject({ play: true, reason: 'playing', seekTo: 600 });
    // 后退 60 秒回到开头那一段：中文 = 视频 − 2.5
    const back = dubSeekTarget(after, -60, 3600);
    expect(dubStep(video({ currentTime: back }), audio({ currentTime: 601 }), mp)).toMatchObject({ play: true, seekTo: 557.5 });
    // 前进到这一段中文已经说完的地方（视频 9:45 → 中文该在 9:42.5，可这一段的中文到 9:40 为止）：停在段尾等画面，不乱放
    expect(dubStep(video({ currentTime: dubSeekTarget(back, 25, 3600) }), audio({ currentTime: 557.5 }), mp)).toMatchObject({ play: false, reason: 'segment-end', seekTo: 580 });
  });

  it('快速对齐开着时前进 / 后退：配音到"视频位置 × 倍速"，照样变速放', () => {
    const mp = map(0, [], 0.9151);
    const after = dubSeekTarget(53, 60, 5235);
    const step = dubStep(video({ currentTime: after }), audio({ currentTime: 48.5, rate: 0.9151 }), mp);
    expect(step).toMatchObject({ play: true, reason: 'playing' });
    expect(step.seekTo).toBeCloseTo(113 * 0.9151, 6);
    expect(step.rate).toBeUndefined();
  });

  it('暂停之后配音停下、位置对好；停着的时候跳，配音的位置也跟过去（一放就是对的）；再播放就接着放', () => {
    const mp = map(10);
    expect(dubStep(video({ paused: true }), audio({ currentTime: 90, paused: false }), mp)).toMatchObject({ play: false, reason: 'paused' });
    const after = dubSeekTarget(100, 15, 600);
    expect(dubStep(video({ currentTime: after, paused: true }), audio({ currentTime: 90, paused: true }), mp)).toMatchObject({ play: false, reason: 'paused', seekTo: 105 });
    expect(dubStep(video({ currentTime: after }), audio({ currentTime: 105, paused: true }), mp)).toMatchObject({ play: true, reason: 'playing' });
  });

  it('退到中文还没开始的地方、跳到中文已经放完的地方：配音停着，不乱放', () => {
    expect(dubStep(video({ currentTime: dubSeekTarget(20, -10, 600) }), audio({ currentTime: 5 }), map(15))).toMatchObject({ play: false, reason: 'before-start', seekTo: 0 });
    expect(dubStep(video({ currentTime: dubSeekTarget(560, 30, 600) }), audio({ currentTime: 550, duration: 580 }), map(0))).toMatchObject({ play: false, reason: 'after-end' });
  });
});

const cues = (n: number, len = 4): SubCue[] => Array.from({ length: n }, (_, i) => ({ start: i * len, end: i * len + len - 1, text: `第 ${i} 句` }));

describe('配音字幕：按配音放到的位置找这一句（DECISIONS §86）', () => {
  it('开始了、还没结束的那一句；两句之间留一小会儿就没有；下一句开始了就换', () => {
    const list = cues(5);
    expect(dubCueAt(list, -1)).toBeUndefined();
    expect(dubCueAt(list, 0)?.text).toBe('第 0 句');
    expect(dubCueAt(list, 2.99)?.text).toBe('第 0 句');
    // 结束后再留 lingerSec
    expect(dubCueAt(list, 3 + DUB.subs.lingerSec - 0.01)?.text).toBe('第 0 句');
    expect(dubCueAt(list, 3 + DUB.subs.lingerSec + 0.01)).toBeUndefined();
    expect(dubCueAt(list, 4)?.text).toBe('第 1 句');
    expect(dubCueAt(list, 18.5)?.text).toBe('第 4 句');
    expect(dubCueAt(list, 30)).toBeUndefined();
    expect(dubCueAt([], 3)).toBeUndefined();
  });

  it('紧挨着的两句：前一句不拖进后一句', () => {
    const list: SubCue[] = [
      { start: 0, end: 4, text: 'a' },
      { start: 4, end: 8, text: 'b' },
    ];
    expect(dubCueAt(list, 3.99)?.text).toBe('a');
    expect(dubCueAt(list, 4)?.text).toBe('b');
  });

  it('字幕跟配音走，不跟视频走：同一个视频位置，对齐不一样，显示的句子就不一样', () => {
    const list = cues(400);
    const at = (mp: DubMap, v: number) => dubCueAt(list, dubStep(video({ currentTime: v }), audio({ currentTime: 0 }), mp).target)?.text;
    // 不偏移：视频 1:40 → 中文 1:40 → 第 25 句
    expect(at(map(0), 100)).toBe('第 25 句');
    // 中文推后 40 秒：视频 1:40 → 中文 1:00 → 第 15 句
    expect(at(map(40), 100)).toBe('第 15 句');
    // 快速对齐 0.5×：视频 1:40 → 中文 0:50 → 第 12 句
    expect(at(map(0, [], 0.5), 100)).toBe('第 12 句');
    // 对齐点之后（视频 1:00 ↔ 中文 0:20）：视频 1:40 → 中文 1:00 → 第 15 句
    expect(at(map(0, [{ video: 60, dub: 20 }]), 100)).toBe('第 15 句');
  });

  it('什么时候显示：配音在放、或停在一句话中间时显示；没开始、说完了在等画面、放完了、广告、跳转途中、被浏览器拦下时不显示', () => {
    expect(dubSubVisible({ reason: 'playing', blocked: false })).toBe(true);
    expect(dubSubVisible({ reason: 'paused', blocked: false })).toBe(true);
    expect(dubSubVisible({ reason: 'buffering', blocked: false })).toBe(true);
    expect(dubSubVisible({ reason: 'playing', blocked: true })).toBe(false);
    for (const reason of ['before-start', 'segment-end', 'after-end', 'ad', 'ended', 'seeking'] as const) {
      expect(dubSubVisible({ reason, blocked: false })).toBe(false);
      expect(dubSubHiddenText({ reason, blocked: false })).not.toBe('');
    }
    expect(dubSubVisible({ blocked: false })).toBe(false);
    expect(dubSubHiddenText({ reason: 'segment-end', blocked: false })).toContain('等画面');
    expect(dubSubHiddenText({ reason: 'playing', blocked: true })).toContain('拦下');
  });

  it('配音脚本把"此刻放到哪了"交给字幕脚本；摘掉后取不到；不像样的不认', () => {
    publishDubPlayback(() => ({ videoId: VID, time: 48.2, running: true, blocked: false, reason: 'playing' }));
    expect(dubPlayback()).toEqual({ videoId: VID, time: 48.2, running: true, blocked: false, reason: 'playing' });
    publishDubPlayback(() => undefined);
    expect(dubPlayback()).toBeUndefined();
    publishDubPlayback(() => ({ videoId: VID, time: NaN, running: true, blocked: false }));
    expect(dubPlayback()).toBeUndefined();
    publishDubPlayback(undefined);
    expect(dubPlayback()).toBeUndefined();
    (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('tubemuse.dub.playback')] = { time: 1 };
    expect(dubPlayback()).toBeUndefined();
    publishDubPlayback(undefined);
  });
});

describe('配音字幕：语言跟配音走', () => {
  it('按文字认一行是什么语言', () => {
    expect(lineLang('今天我们聊聊 Muse 的崛起')).toBe('zh');
    expect(lineLang('Today we talk about the rise of Muse')).toBe('latin');
    expect(lineLang('こんにちは')).toBe('ja');
    expect(lineLang('안녕하세요')).toBe('ko');
    expect(lineLang('12:30 —— ?!')).toBeUndefined();
  });

  it('中英双语的字幕：只留中文那几行（配音是中文配音）', () => {
    const p = prepareDubCues([
      { start: 0, end: 3, text: '今天我们聊聊 Muse 的崛起\nToday we talk about the rise of Muse' },
      { start: 3, end: 6, text: 'It started as a side project\n它一开始只是个业余项目' },
      { start: 6, end: 9, text: '后来呢？\nAnd then?' },
    ]);
    expect(p.reduced).toBe(true);
    expect(p.lang).toBe('zh');
    expect(p.cues.map((c) => c.text)).toEqual(['今天我们聊聊 Muse 的崛起', '它一开始只是个业余项目', '后来呢？']);
    expect(dubSubsNote({ ...p, count: p.cues.length })).toContain('只显示中文那几行');
  });

  it('双语字幕里只有英文的句子原样留着（那一句配音说的可能就是它）', () => {
    const p = prepareDubCues([
      { start: 0, end: 3, text: '第一句\nLine one' },
      { start: 3, end: 6, text: '第二句\nLine two' },
      { start: 6, end: 9, text: 'OK, cool.' },
    ]);
    expect(p.reduced).toBe(true);
    expect(p.cues.map((c) => c.text)).toEqual(['第一句', '第二句', 'OK, cool.']);
  });

  it('只有中文的字幕：原样；中文里夹几个英文词的行不当成双语', () => {
    const p = prepareDubCues([
      { start: 0, end: 3, text: '我们用 Transformer 模型\n训练了一个 agent' },
      { start: 3, end: 6, text: '效果很好' },
    ]);
    expect(p.reduced).toBe(false);
    expect(p.lang).toBe('zh');
    expect(p.cues[0]?.text).toBe('我们用 Transformer 模型\n训练了一个 agent');
    expect(dubSubsNote({ ...p, count: 2 })).toBe('2 句，中文');
  });

  it('不是配音的语言（只有英文）的字幕：照样显示，但如实说', () => {
    const p = prepareDubCues([{ start: 0, end: 3, text: 'So in college I built this thing' }]);
    expect(p.reduced).toBe(false);
    expect(p.lang).toBe('latin');
    expect(dubSubsNote({ ...p, count: 1 })).toContain('看起来不是配音的语言（中文）');
  });

  it('整理：按时间排好、重叠的让开、空的丢掉；太长的句子截掉', () => {
    const p = prepareDubCues([
      { start: 10, end: 14, text: '第二句' },
      { start: 0, end: 12, text: '第一句' },
      { start: 20, end: 21, text: '   ' },
      { start: 30, end: 32, text: '长'.repeat(DUB.subs.maxCueChars + 50) },
    ]);
    expect(p.cues.map((c) => [c.start, c.end, c.text.length])).toEqual([
      [0, 10, 3],
      [10, 14, 3],
      [30, 32, DUB.subs.maxCueChars],
    ]);
    expect(p.truncated).toBe(false);
  });

  it('小宇宙的字幕：每句取它自己语言的那一行（校对过用校对后的，没校对用转写的原文）', () => {
    const c = (over: Partial<XyzCue>): XyzCue => ({ id: 'e:0', start: 0, end: 3, raw: '', createdAt: 1, ...over });
    // 中文播客：校对后的中文
    expect(xyzCueOwnLine(c({ raw: '今天聊聊缪斯', lang: 'zh', zh: '今天聊聊 Muse。', en: 'Today we talk about Muse.', polished: true }))).toBe('今天聊聊 Muse。');
    // 这一句说的是英文：英文那一行
    expect(xyzCueOwnLine(c({ raw: 'so in college', lang: 'en', zh: '所以在大学里', en: 'So, in college…', polished: true }))).toBe('So, in college…');
    // 还没校对：转写的原文
    expect(xyzCueOwnLine(c({ raw: '还没校对的一句', lang: 'zh' }))).toBe('还没校对的一句');
    expect(xyzCuesForDub([c({ raw: '一', lang: 'zh', start: 0, end: 2 }), c({ raw: '', start: 2, end: 4 }), c({ raw: '二', lang: 'zh', start: 4, end: 6 })]).map((x) => x.text)).toEqual(['一', '二']);
  });

  it('哪一集是这个配音：标题在配音的文件名里，或两边一样长的排最前', () => {
    const t = (over: Partial<XyzTranscript>): XyzTranscript => ({
      eid: 'e1',
      title: '别的',
      podcastTitle: '播客',
      asrModel: 'gpt-transcribe',
      cues: [{ id: 'x', start: 0, end: 2, raw: '一句', createdAt: 1 }],
      done: [[0, 100]],
      updatedAt: 1,
      ...over,
    });
    const list = rankXyzForDub(
      [
        t({ eid: 'new', title: '最新的另一集', updatedAt: 9, duration: 300 }),
        t({ eid: 'byTitle', title: '#833. Muse 的崛起：本年度最成功消费产品发布内幕', updatedAt: 2, duration: 4000 }),
        t({ eid: 'byLen', title: '标题对不上', updatedAt: 3, duration: 4790.9 }),
        t({ eid: 'empty', title: '没有字幕的', cues: [], updatedAt: 10 }),
      ],
      { fileName: '#833. Muse 的崛起：本年度最成功消费产品发布内幕 - 跨国串门儿计划 - 小宇宙 - 听播客，上小宇宙.m4a', durationSec: 4790.7 },
    );
    expect(list.map((x) => [x.eid, x.match])).toEqual([
      ['byLen', true],
      ['byTitle', true],
      ['new', false],
    ]);
    expect(list[0]).toMatchObject({ count: 1, coveredSec: 100, durationSec: 4790.9 });
  });
});

describe('配音字幕：样式', () => {
  it('默认：显示、黑体、白字、深色半透明底、带描边、在画面底部', () => {
    const d = DEFAULT_SETTINGS.dub.subtitles;
    expect(d).toEqual({ show: true, font: 'sans', scale: 1, color: '#ffffff', background: '#080808', backgroundOpacity: 0.72, bold: false, outline: true, raisePct: 0 });
    expect(sanitizeDubSubStyle(undefined)).toEqual(d);
    expect(dubSubCss(d)).toMatchObject({ color: '#ffffff', background: 'rgba(8, 8, 8, 0.72)', fontWeight: '500', fontFamily: DUB_SUB_FONTS.sans.css });
    expect(dubSubCss(d).textShadow).toContain('rgba(0, 0, 0');
  });

  it('可调：字体、字号、文字颜色、背景色与不透明度、粗体、描边、抬高', () => {
    const s = sanitizeDubSubStyle({ show: false, font: 'kai', scale: 1.5, color: '#FFEE00', background: '#000080', backgroundOpacity: 0.5, bold: true, outline: false, raisePct: 20 });
    expect(s).toEqual({ show: false, font: 'kai', scale: 1.5, color: '#ffee00', background: '#000080', backgroundOpacity: 0.5, bold: true, outline: false, raisePct: 20 });
    expect(dubSubCss(s)).toEqual({ fontFamily: DUB_SUB_FONTS.kai.css, color: '#ffee00', background: 'rgba(0, 0, 128, 0.5)', fontWeight: '700', textShadow: 'none' });
    expect(Object.keys(DUB_SUB_FONTS)).toEqual(['sans', 'serif', 'kai', 'round', 'mono']);
  });

  it('深色的字配浅色描边', () => {
    expect(dubSubCss(sanitizeDubSubStyle({ color: '#101010' })).textShadow).toContain('rgba(255, 255, 255');
  });

  it('认不出的字体、颜色回到默认；超出范围的数夹进范围', () => {
    const s = sanitizeDubSubStyle({ font: 'comic', scale: 99, color: 'red', background: 'url(x)', backgroundOpacity: 7, raisePct: -5, bold: 'yes' });
    expect(s).toMatchObject({ font: 'sans', scale: DUB.subs.scale.max, color: '#ffffff', background: '#080808', backgroundOpacity: 1, raisePct: 0, bold: false });
    expect(sanitizeDubSubStyle({ scale: 0.01, raisePct: 500 })).toMatchObject({ scale: DUB.subs.scale.min, raisePct: DUB.subs.raisePct.max });
    expect(hexToRgba('#000080', 0)).toBe('rgba(0, 0, 128, 0)');
    expect(hexToRgba('nope', 2)).toBe('rgba(0, 0, 0, 1)');
  });

  it('字号随播放器高度变（全屏自动变大），再乘你设的倍数；竖屏的 Shorts 按短边算', () => {
    expect(dubSubFontPx({ scale: 1 }, 640, 360, false)).toBe(15.1);
    expect(dubSubFontPx({ scale: 1.5 }, 640, 360, false)).toBe(22.7);
    expect(dubSubFontPx({ scale: 1 }, 1920, 1080, false)).toBe(DUB.subs.base.maxPx);
    expect(dubSubFontPx({ scale: 2 }, 1920, 1080, false)).toBe(DUB.subs.base.maxPx * 2);
    expect(dubSubFontPx({ scale: 1 }, 200, 120, false)).toBe(DUB.subs.base.minPx);
    expect(dubSubFontPx({ scale: 1 }, 405, 720, true)).toBe(17);
  });

  it('读设置时：旧版本存下的设置没有这一项也能用；别的配音设置不受影响', () => {
    const old = mergeSettings({ dub: { enabled: false, prompt: false } });
    expect(old.dub).toMatchObject({ enabled: false, prompt: false, exportSubtitles: true, subtitles: DEFAULT_SETTINGS.dub.subtitles });
    const mine = mergeSettings({ dub: { subtitles: { scale: 1.25, color: '#00ff00', font: 'serif' } } });
    expect(mine.dub.subtitles).toEqual({ ...DEFAULT_SETTINGS.dub.subtitles, scale: 1.25, color: '#00ff00', font: 'serif' });
    expect(mine.dub.enabled).toBe(true);
  });
});

const SRT = ['1', '00:00:01,000 --> 00:00:04,000', '今天我们聊聊 Muse 的崛起', 'Today we talk about the rise of Muse', '', '2', '00:00:04,000 --> 00:00:08,500', '它一开始只是个业余项目', 'It started as a side project', ''].join('\n');

describe('配音字幕：存在本机', () => {
  it('选字幕文件：字幕按视频单独存一个键，记录里只记是哪来的、多少句', async () => {
    const { ctx, kv } = setup();
    await attachDub(ctx, { videoId: VID, file: m4a(), fileName: '#833.m4a' });
    const saved = await setDubSubtitleFile(ctx, VID, srtBlob(SRT), '#833.zh-en.srt');
    expect(saved?.meta).toMatchObject({ name: '#833.zh-en.srt', count: 2, lang: 'zh', source: 'file', reduced: true });
    const rec = (await stores.dubs.read(kv))[VID]!;
    expect(rec.subs).toEqual(saved?.meta);
    expect(dubSubsMetaText(rec.subs!)).toBe('#833.zh-en.srt · 2 句 · 中文');
    expect(await kv.get(dubSubsKey(VID))).toEqual({
      videoId: VID,
      cues: [
        { start: 1, end: 4, text: '今天我们聊聊 Muse 的崛起' },
        { start: 4, end: 8.5, text: '它一开始只是个业余项目' },
      ],
    });
    expect((await readDubSubtitles(ctx, VID))?.cues).toHaveLength(2);
    // 对应关系里没有字幕文字：调偏移、加对齐点时不必重写
    expect(JSON.stringify(rec)).not.toContain('业余项目');
  });

  it('不是字幕的文件、太大的文件、一句都读不到的：说明原因，不存', async () => {
    const { ctx, kv } = setup();
    await attachDub(ctx, { videoId: VID, file: m4a(), fileName: 'a.m4a' });
    await expect(setDubSubtitleFile(ctx, VID, srtBlob('{"a": 1}'), 'x.srt')).rejects.toBeInstanceOf(SubtitleFileError);
    await expect(setDubSubtitleFile(ctx, VID, srtBlob('随便写的几行字\n没有时间'), 'x.srt')).rejects.toThrow('一句字幕都没读到');
    await expect(setDubSubtitleFile(ctx, VID, new Blob([new Uint8Array(DUB.export.maxSubtitleFileBytes + 1)]), 'big.srt')).rejects.toThrow('太大');
    expect((await stores.dubs.read(kv))[VID]?.subs).toBeUndefined();
    expect(await kv.get(dubSubsKey(VID))).toBeUndefined();
  });

  it('这个视频没有配音：字幕不存', async () => {
    const { ctx, kv } = setup();
    expect(await setDubSubtitleFile(ctx, VID, srtBlob(SRT), 'a.srt')).toBeUndefined();
    expect(await kv.getAll()).toEqual({});
  });

  it('换一份字幕：整份换掉；去掉字幕：说明和字幕本身都删', async () => {
    const { ctx, kv } = setup();
    await attachDub(ctx, { videoId: VID, file: m4a(), fileName: 'a.m4a' });
    const first = await setDubSubtitleFile(ctx, VID, srtBlob(SRT), 'a.srt');
    const second = await setDubSubtitles(ctx, VID, { name: 'b.vtt', source: 'file', cues: [{ start: 0, end: 2, text: '只有一句' }] });
    expect(second?.meta.count).toBe(1);
    expect(second?.meta.addedAt).toBeGreaterThan(first!.meta.addedAt);
    expect((await readDubSubtitles(ctx, VID))?.cues).toEqual([{ start: 0, end: 2, text: '只有一句' }]);
    await removeDubSubtitles(ctx, VID);
    expect((await stores.dubs.read(kv))[VID]?.subs).toBeUndefined();
    expect(await kv.get(dubSubsKey(VID))).toBeUndefined();
    // 配音本身还在
    expect((await stores.dubs.read(kv))[VID]?.fileName).toBe('a.m4a');
  });

  it('换音频文件：字幕保留（和偏移、对齐点一样）；移除配音：字幕一并删掉', async () => {
    const { ctx, kv } = setup();
    await attachDub(ctx, { videoId: VID, file: m4a(), fileName: 'a.m4a' });
    await setDubSubtitleFile(ctx, VID, srtBlob(SRT), 'a.srt');
    const replaced = await attachDub(ctx, { videoId: VID, file: m4a(), fileName: 'b.m4a' });
    expect(replaced.subs).toMatchObject({ name: 'a.srt', count: 2 });
    expect((await readDubSubtitles(ctx, VID))?.cues).toHaveLength(2);
    await removeDub(ctx, VID);
    expect(await kv.get(dubSubsKey(VID))).toBeUndefined();
    expect(await stores.dubs.read(kv)).toEqual({});
  });

  it('用小宇宙里已经生成的字幕：只读本机存着的那一集，抄一份；不联网', async () => {
    const { ctx, kv } = setup();
    await attachDub(ctx, { videoId: VID, file: m4a(), fileName: '#833. Muse 的崛起 - 小宇宙.m4a' });
    const t: XyzTranscript = {
      eid: 'ep833',
      title: '#833. Muse 的崛起',
      podcastTitle: '跨国串门儿计划',
      asrModel: 'gpt-transcribe',
      duration: 4790,
      done: [[0, 60]],
      updatedAt: 5,
      cues: [
        { id: 'ep833:0', start: 0, end: 3, raw: '今天聊聊缪斯', lang: 'zh', zh: '今天聊聊 Muse。', en: 'Today: Muse.', polished: true, createdAt: 1 },
        { id: 'ep833:3000', start: 3, end: 6, raw: '还没校对的一句', lang: 'zh', createdAt: 1 },
      ],
    };
    await xyzTranscriptStore('ep833').write(kv, t);
    await stores.xyzTranscriptIndex.write(kv, { ep833: 5, gone: 4 });
    const list = await listXyzSubsForDub(ctx, (await stores.dubs.read(kv))[VID]!);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ eid: 'ep833', match: true, count: 2, coveredSec: 60, durationSec: 4790 });
    const saved = await copyXyzSubsForDub(ctx, VID, 'ep833');
    expect(saved?.meta).toMatchObject({ name: '#833. Muse 的崛起', source: 'xyz', count: 2, lang: 'zh' });
    expect((await readDubSubtitles(ctx, VID))?.cues.map((c) => c.text)).toEqual(['今天聊聊 Muse。', '还没校对的一句']);
    expect(dubSubsMetaText(saved!.meta)).toContain('取自小宇宙里已生成的字幕');
    // 小宇宙那边的字幕原样不动
    expect(await xyzTranscriptStore('ep833').read(kv)).toEqual(t);
    await expect(copyXyzSubsForDub(ctx, VID, 'gone')).rejects.toThrow('不见了');
  });

  it('读存储时校验：坏掉的句子丢弃、一句不剩当作没有；别的视频的字幕不认', async () => {
    expect(sanitizeDubSubsDoc({ videoId: VID, cues: [{ start: 5, end: 7, text: '后' }, { start: 'x', end: 2, text: '坏' }, { start: 3, end: 2, text: '倒了' }, { start: 0, end: 2, text: '  先  ' }, null] }, VID)).toEqual({
      videoId: VID,
      cues: [
        { start: 0, end: 2, text: '先' },
        { start: 5, end: 7, text: '后' },
      ],
    });
    expect(sanitizeDubSubsDoc({ videoId: 'other000001', cues: [{ start: 0, end: 2, text: 'a' }] }, VID)).toBeNull();
    expect(sanitizeDubSubsDoc({ videoId: VID, cues: [] }, VID)).toBeNull();
    expect(sanitizeDubSubsDoc('nope', VID)).toBeNull();
    const { ctx, kv } = setup();
    await kv.set(dubSubsKey(VID), { videoId: VID, cues: 'broken' });
    expect(await dubSubsStore(VID).read(kv)).toBeNull();
    expect(await readDubSubtitles(ctx, VID)).toBeNull();
  });

  it('记录里的字幕说明：坏掉的丢弃（配音本身照常用）', () => {
    expect(sanitizeDubSubsMeta({ name: 'a.srt', count: 12, lang: 'zh', source: 'file', addedAt: 5 })).toEqual({ name: 'a.srt', count: 12, lang: 'zh', source: 'file', addedAt: 5 });
    expect(sanitizeDubSubsMeta({ name: 'a', count: 3, lang: 'klingon', source: 'web', reduced: true })).toEqual({ name: 'a', count: 3, lang: 'other', source: 'file', reduced: true, addedAt: 0 });
    expect(sanitizeDubSubsMeta({ name: 'a.srt', count: 0 })).toBeUndefined();
    expect(sanitizeDubSubsMeta('x')).toBeUndefined();
    const idx = sanitizeDubIndex({ [VID]: { videoId: VID, fileId: 'dub_abcd1234', fileName: 'a.m4a', size: 10, mime: 'audio/mp4', delaySec: 0, addedAt: 1, subs: { count: -1 } } });
    expect(idx[VID]).toBeDefined();
    expect(idx[VID]?.subs).toBeUndefined();
  });

  it('导出里有配音字幕的文字（是你给的文本，不是音频）；清空时一并删掉', async () => {
    const { ctx, dubAudio } = setup();
    await attachDub(ctx, { videoId: VID, file: m4a(), fileName: 'a.m4a' });
    await setDubSubtitleFile(ctx, VID, srtBlob(SRT), 'a.srt');
    const file = await exportAll(ctx);
    expect(file.data[dubSubsKey(VID)]).toBeDefined();
    expect(file.note).toContain('配音字幕的文字');
    expect(file.note).toContain('不含音频文件本身');
    await clearAll(ctx);
    expect(await ctx.kv.getAll()).toEqual({});
    expect(dubAudio.data.size).toBe(0);
  });
});
