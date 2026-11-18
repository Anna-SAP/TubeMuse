// 中文配音：第三种对齐方式"加快英文"和"整体变速"（DECISIONS §87，用户 2026-11-18 要求）。
// 加快英文：逻辑和快速对齐相同、方向相反——中文按原速放，英文原声（连同画面）整段按"视频时长 ÷ 中文时长"的倍速放，两边同时开始、同时结束。
// 整体变速：对齐之后两条一起加速 / 减速，对齐关系不变。
// 用用户截图里的例子核对：中文 1:19:50.7、英文 1:27:15.3，时长差 444.6 秒；快速对齐 0.9151，加快英文 1.0928。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DUB } from '../../src/config/defaults';
import { ENDPOINTS } from '../../src/config/endpoints';
import {
  VideoRateKeeper,
  dubMapOf,
  dubRateMode,
  dubReasonText,
  dubStep,
  durationNote,
  englishAlignSuggestion,
  englishModeName,
  quickAlignSuggestion,
  sanitizeDubIndex,
  sanitizeOverallRate,
  speedText,
  trackRates,
  videoRateFactor,
  type DubAudioSample,
  type DubMap,
  type DubVideoSample,
} from '../../src/core/dub';
import {
  alignNowText,
  alignOverallText,
  describeDubAt,
  describeVideoAt,
  dubAlignment,
  dubPlanAt,
  dubRemainingAt,
  englishFormulaText,
  quickFormulaText,
  remainingKind,
  remainingNoteText,
} from '../../src/core/dub-align';
import { renderPieces } from '../../src/core/dub-render';
import type { AuthProvider } from '../../src/services/auth';
import type { AppContext } from '../../src/services/context';
import { exportAll } from '../../src/services/data-service';
import { addDubAnchor, attachDub, setDubDelay, setDubEnglishRate, setDubOverallRate, setDubQuickRate, setDubRateAlign } from '../../src/services/dub-service';
import { memoryDubStore } from '../../src/services/dub-store';
import { stores } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';

/** 用户截图里的例子：中文 1:19:50.7、英文 1:27:15.3 */
const D = 79 * 60 + 50.7;
const V = 87 * 60 + 15.3;
/** 加快英文的倍速 = 英文 ÷ 中文（存 6 位小数） */
const K = 1.092805;
const MANUAL: DubMap = { delaySec: 2, anchors: [{ video: 60, dub: 50 }] };
const ENGLISH: DubMap = dubMapOf({ delaySec: MANUAL.delaySec, anchors: [...MANUAL.anchors], englishRate: K });

const video = (x: Partial<DubVideoSample> = {}): DubVideoSample => ({ currentTime: 0, paused: false, ended: false, seeking: false, canPlay: true, rate: 1, ad: false, ...x });
const audio = (x: Partial<DubAudioSample> = {}): DubAudioSample => ({ currentTime: 0, paused: false, duration: D, rate: 1, ...x });

describe('加快英文：建议倍速 = 视频时长 ÷ 中文时长', () => {
  it('用户的例子：英文 1:27:15.3 ÷ 中文 1:19:50.7 = 1.0928（约 1.09）；和快速对齐的 0.9151 互为倒数', () => {
    const e = englishAlignSuggestion(D, V)!;
    const q = quickAlignSuggestion(D, V)!;
    expect(e).toMatchObject({ rate: K, ok: true });
    expect(englishFormulaText(e)).toBe('英文 1:27:15.3 ÷ 中文 1:19:50.7 = 1.0928（约 1.09）');
    expect(quickFormulaText(q)).toBe('中文 1:19:50.7 ÷ 英文 1:27:15.3 = 0.9151（约 0.92）');
    expect(e.rate * q.rate).toBeCloseTo(1, 5);
    // 按这个倍速放：中文按原速放完的那一刻，英文正好放完
    expect(D * e.rate).toBeCloseTo(V, 2);
    expect(englishModeName(e.rate)).toBe('加快英文');
  });
  it('中文比原视频长时英文要慢放："放慢英文"；超出 0.5–2 不提供并说明；读不到时长算不出', () => {
    const slow = englishAlignSuggestion(120, 100)!;
    expect(slow).toMatchObject({ rate: 0.833333, ok: true });
    expect(englishModeName(slow.rate)).toBe('放慢英文');
    const fast = englishAlignSuggestion(100, 300)!;
    expect(fast.ok).toBe(false);
    expect(fast.why).toContain('高于 2.00×');
    expect(englishAlignSuggestion(400, 100)!.ok).toBe(false);
    expect(englishAlignSuggestion(undefined, V)).toBeUndefined();
    expect(englishAlignSuggestion(D, 0)).toBeUndefined();
    // 和快速对齐的范围一样：一个能用另一个也能用
    for (const [d, v] of [[100, 199], [100, 201], [100, 50], [100, 49]] as const) expect(englishAlignSuggestion(d, v)!.ok).toBe(quickAlignSuggestion(d, v)!.ok);
  });
});

describe('加快英文：对应关系和快速对齐一样，变速的是英文', () => {
  it('对齐信息：中文位置 = 视频位置 ÷ 英文倍速；开头偏移和对齐点留着不用', () => {
    expect(ENGLISH).toMatchObject({ quickRate: 1 / K, englishRate: K, delaySec: 2, anchors: MANUAL.anchors });
    expect(dubRateMode(ENGLISH)).toBe('english');
    expect(dubRateMode({ quickRate: 0.9 })).toBe('quick');
    expect(dubRateMode(MANUAL)).toBe('manual');
  });
  it('两条音轨各按什么倍速放：加快英文时英文 × 倍速、中文原速；整体倍速两边一起乘', () => {
    expect(trackRates(ENGLISH)).toEqual({ en: K, zh: 1 });
    expect(trackRates({ quickRate: 0.9 })).toEqual({ en: 1, zh: 0.9 });
    expect(trackRates(MANUAL)).toEqual({ en: 1, zh: 1 });
    expect(trackRates(ENGLISH, 1.25)).toEqual({ en: K * 1.25, zh: 1.25 });
    expect(trackRates({ quickRate: 0.9 }, 1.5).zh).toBeCloseTo(1.35, 9);
    expect(trackRates(MANUAL, 0.75)).toEqual({ en: 0.75, zh: 0.75 });
    // 视频要乘的：加快英文 × 整体倍速
    expect(videoRateFactor(ENGLISH, 1.25)).toBeCloseTo(1.36600625, 9);
    expect(videoRateFactor({ quickRate: 0.9 })).toBe(1);
  });
  it('跟随：视频被调到 1.0928 倍（配音脚本写进去的）时，中文的播放速度回到 1 倍、位置 = 视频位置 ÷ 1.0928', () => {
    const step = dubStep(video({ currentTime: 316, rate: K }), audio({ currentTime: 316 / K, rate: 0.5 }), ENGLISH);
    expect(step.play).toBe(true);
    expect(step.target).toBeCloseTo(289.164, 3);
    expect(step.rate).toBeCloseTo(1, 9);
    expect(step.seekTo).toBeUndefined();
    // 整体 1.25 倍：视频 1.0928 × 1.25，中文 1.25
    const fast = dubStep(video({ currentTime: 316, rate: K * 1.25 }), audio({ currentTime: 316 / K, rate: 1 }), ENGLISH);
    expect(fast.rate).toBeCloseTo(1.25, 9);
    // 手动对齐 + 整体 1.5 倍：中文和视频一样快，位置照偏移
    const manual = dubStep(video({ currentTime: 100, rate: 1.5 }), audio({ currentTime: 90, rate: 1 }), MANUAL);
    expect(manual).toMatchObject({ play: true, rate: 1.5, target: 90 });
    // 开头偏移、对齐点都不起作用：1:05 照常放，不停下等画面
    expect(dubStep(video({ currentTime: 65, rate: K }), audio({ currentTime: 65 / K, rate: 1 }), ENGLISH)).toMatchObject({ play: true, reason: 'playing' });
  });
  it('YouTube 不让改倍速（视频还是 1 倍）时：中文按对应关系慢放跟着，对齐不变', () => {
    const step = dubStep(video({ currentTime: 316, rate: 1 }), audio({ currentTime: 316 / K, rate: 1 }), ENGLISH);
    expect(step.rate).toBeCloseTo(1 / K, 9);
    expect(step.target).toBeCloseTo(289.164, 3);
  });
});

describe('加快英文："还差多少"、对齐图、各处的说法', () => {
  const al = dubAlignment(ENGLISH, V, D);
  it('一段到底：英文 0–1:27:15 ↔ 中文 0–1:19:51，没有停顿、没有跳过', () => {
    expect(al.englishRate).toBe(K);
    expect(al.pieces).toHaveLength(1);
    expect(al.pieces[0]).toMatchObject({ v0: 0, d0: 0 });
    expect(al.pieces[0]!.v1).toBeCloseTo(V, 1);
    expect(al.holds.filter((h) => h.v1 - h.v0 > 0.05)).toEqual([]);
    expect(al.skips.filter((s) => s.d1 - s.d0 > 0.05)).toEqual([]);
  });
  it('还差多少没对上：0.0 秒（截图那一刻：视频 5:16 ↔ 中文 4:49）', () => {
    const t = 316;
    const plan = dubPlanAt(al, ENGLISH, t);
    expect(plan.kind).toBe('playing');
    expect(plan.dub).toBeCloseTo(289.16, 2);
    const r = dubRemainingAt(al, plan, t)!;
    expect(Math.abs(r.remaining)).toBeLessThan(0.01);
    expect(remainingKind(r)).toBe('done');
    expect(r.englishRate).toBe(K);
    expect(remainingNoteText(al, plan, t, r)).toBe(
      '加快英文：英文原声按 1.0928× 快放、中文原速（英文 1:27:15.3 ÷ 中文 1:19:50.7），全片时长差 444.6 秒匀到整段，中文和视频同时结束 · 视频 5:16 ↔ 中文 4:49',
    );
    // 0、中间、最后一秒都是 0（不随播放变）
    for (const x of [0, 2000, V - 1]) expect(Math.abs(dubRemainingAt(al, dubPlanAt(al, ENGLISH, x), x)!.remaining)).toBeLessThan(0.01);
  });
  it('全片、此刻、指着某处、时长一行、状态：都说是英文变速、中文原速；不说逐句 / 逐词', () => {
    const overall = alignOverallText(al)!;
    expect(overall).toContain('加快英文：英文原声整段按 1.0928× 快放、中文原速，和视频同时开始、同时结束。全片中文短 7 分 25 秒，匀到了整段。');
    expect(alignNowText(dubPlanAt(al, ENGLISH, 316), 316, al)).toBe('此刻：视频 5:16 ↔ 中文 4:49，加快英文，英文 1.09× 快放');
    expect(describeVideoAt(al, 316)).toBe('视频 5:16 ↔ 中文 4:49（加快英文，英文 1.09× 快放）');
    expect(describeDubAt(al, 316 / K)).toBe('中文 4:49 → 在视频 5:16 放（加快英文，英文 1.09× 快放）');
    expect(durationNote(D, V, { englishRate: K })).toBe('中文 1:19:51 · 原视频 1:27:15，中文短 7 分 25 秒。加快英文开着：英文原声整段按 1.09× 快放、中文原速，把这段时长差匀到全片。');
    expect(durationNote(D, V)).toContain('或"加快英文"');
    expect(dubReasonText('playing', { offset: 0 }, { englishRate: K })).toBe('配音播放中：加快英文，英文原声按 1.09× 快放、中文原速跟着走');
    expect(dubReasonText('playing', { offset: 0 }, { englishRate: K, overallRate: 1.25 })).toBe('配音播放中：加快英文，英文原声按 1.09× 快放、中文原速跟着走（整体 1.25×）');
    expect(dubReasonText('playing', { offset: 0 }, { quickRate: 0.915076, overallRate: 1.5 })).toBe('配音播放中：快速对齐，中文按 0.92× 慢放跟着视频走（整体 1.5×）');
    expect(dubReasonText('playing', { offset: 0 }, { overallRate: 0.75 })).toBe('配音播放中，跟着视频走（整体 0.75×）');
    expect(dubReasonText('after-end', { offset: 0 }, { englishRate: K })).toBe('中文已经放完了');
    for (const x of [overall, durationNote(D, V, { englishRate: K })!]) expect(x).not.toMatch(/逐句|逐词/);
  });
  it('倍速和现在的时长对不上（设好之后换过文件）：如实说还差多少、应改成多少', () => {
    const shorter = dubAlignment(ENGLISH, V, D - 60);
    const t = 600;
    const r = dubRemainingAt(shorter, dubPlanAt(shorter, ENGLISH, t), t)!;
    expect(remainingKind(r)).toBe('left');
    const note = remainingNoteText(shorter, dubPlanAt(shorter, ENGLISH, t), t, r);
    expect(note).toContain('中文在视频');
    expect(note).toContain(`应是 ${(V / (D - 60)).toFixed(4)}×`);
    const longer = dubAlignment(ENGLISH, V, D + 60);
    const r2 = dubRemainingAt(longer, dubPlanAt(longer, ENGLISH, t), t)!;
    expect(remainingKind(r2)).toBe('over');
    expect(remainingNoteText(longer, dubPlanAt(longer, ENGLISH, t), t, r2)).toContain('视频放完时中文还有 60.0 秒没放到');
  });
});

describe('视频的倍速：配音脚本怎么改、怎么恢复（VideoRateKeeper）', () => {
  it('乘上去、关掉时恢复你的倍速；你在 YouTube 里改了倍速就按新的乘', () => {
    const k = new VideoRateKeeper();
    k.sync(1, 0);
    expect(k.target(K)).toBeCloseTo(K, 9);
    k.wrote(k.target(K)!);
    expect(k.boosted).toBe(true);
    // 读回来就是我们写的：不动
    k.sync(K, 10);
    expect(k.target(K)).toBeUndefined();
    // 你在 YouTube 里选了 1.5：记成你的倍速，再乘
    k.sync(1.5, 20);
    expect(k.userRate).toBe(1.5);
    expect(k.target(K)).toBeCloseTo(1.5 * K, 9);
    k.wrote(1.5 * K);
    // 关掉（或广告）：恢复 1.5
    expect(k.target(1)).toBe(1.5);
    k.wrote(1.5);
    expect(k.boosted).toBe(false);
    expect(k.target(1)).toBeUndefined();
  });
  it('没读到你的倍速之前不动；夹在浏览器允许的范围里', () => {
    const k = new VideoRateKeeper();
    expect(k.target(2)).toBeUndefined();
    k.sync(8, 0);
    expect(k.target(4)).toBe(DUB.videoRate.max);
    k.sync(0.1, 0);
    expect(k.target(0.5)).toBe(DUB.videoRate.min);
    // 读到坏值不认
    k.sync(Number.NaN, 0);
    expect(k.userRate).toBe(0.1);
  });
  it('YouTube 一再把倍速改回原值：停手，不跟它抢；重新开始后再试', () => {
    const k = new VideoRateKeeper();
    k.sync(1, 0);
    for (let i = 0; i < DUB.videoRate.maxReverts; i++) {
      const t = k.target(1.25);
      expect(t, `第 ${i + 1} 次`).toBe(1.25);
      k.wrote(t!);
      k.sync(1, i * 100);
    }
    expect(k.blocked).toBe(true);
    expect(k.target(1.25)).toBeUndefined();
    k.reset();
    k.sync(1, 10_000);
    expect(k.target(1.25)).toBe(1.25);
  });
  it('隔得很久的偶尔一次改回（例如广告之后）不算来回抢', () => {
    const k = new VideoRateKeeper();
    k.sync(1, 0);
    for (let i = 0; i < DUB.videoRate.maxReverts + 3; i++) {
      k.wrote(k.target(K)!);
      k.sync(1, i * (DUB.videoRate.revertWindowMs + 1));
    }
    expect(k.blocked).toBe(false);
  });
});

describe('整体倍速：存储', () => {
  it('只认 0.5–2、按 0.01 取整；1 = 不变速（不存）', () => {
    expect(sanitizeOverallRate(1.25)).toBe(1.25);
    expect(sanitizeOverallRate(1.254)).toBe(1.25);
    expect(sanitizeOverallRate(0.5)).toBe(0.5);
    expect(sanitizeOverallRate(2)).toBe(2);
    for (const bad of [1, 0.4, 2.5, NaN, '1.5', null]) expect(sanitizeOverallRate(bad), String(bad)).toBeUndefined();
    expect(speedText(1.25)).toBe('1.25×');
    expect(speedText(1.5)).toBe('1.5×');
    expect(speedText(1)).toBe('1×');
  });
});

const M4A = new Uint8Array(readFileSync(new URL('../fixtures/xyz-tones.m4a', import.meta.url)));
const NOW = Date.parse('2026-11-18T02:00:00Z');
const VID = 'eng_k6XI12g';

function setup() {
  const kv = memoryKV();
  const dubAudio = memoryDubStore();
  const auth = { disconnect: async () => ({ revoked: false }) } as unknown as AuthProvider;
  const blocked = (() => {
    throw new Error('配音不该发网络请求');
  }) as unknown as typeof fetch;
  const ctx: AppContext = { kv, locker: memoryLocker(), http: blocked, now: () => NOW, auth, endpoints: ENDPOINTS, timeZone: 'Asia/Shanghai', dubAudio };
  return { ctx };
}
const m4aBlob = () => new Blob([M4A as BlobPart], { type: 'audio/x-m4a' });
const read = async (ctx: AppContext) => (await stores.dubs.read(ctx.kv))[VID]!;

describe('加快英文、整体变速：存下、切换、切回', () => {
  it('开加快英文：记下倍速；和快速对齐只会开一种；切回手动后和原来一模一样', async () => {
    const { ctx } = setup();
    await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a', videoDurationSec: 120 });
    await setDubDelay(ctx, VID, 1.5);
    await addDubAnchor(ctx, VID, { video: 40, dub: 30 });
    const before = await read(ctx);

    expect(await setDubEnglishRate(ctx, VID, 1.0928049)).toBe(true);
    expect(await read(ctx)).toMatchObject({ englishRate: 1.092805, delaySec: 1.5, anchors: [{ video: 40, dub: 30 }] });
    expect('quickRate' in (await read(ctx))).toBe(false);
    // 换成快速对齐：加快英文去掉
    expect(await setDubQuickRate(ctx, VID, 0.915076)).toBe(true);
    expect(await read(ctx)).toMatchObject({ quickRate: 0.915076 });
    expect('englishRate' in (await read(ctx))).toBe(false);
    // 再换回加快英文
    expect(await setDubRateAlign(ctx, VID, { kind: 'english', rate: 1.092805 })).toBe(true);
    expect('quickRate' in (await read(ctx))).toBe(false);
    // 切回手动
    expect(await setDubRateAlign(ctx, VID, undefined)).toBe(true);
    expect(await read(ctx)).toEqual(before);
    // 不在范围里不存
    expect(await setDubEnglishRate(ctx, VID, 3)).toBe(false);
    expect(await setDubEnglishRate(ctx, 'noSuchVideo1', 1.1)).toBe(false);
  });
  it('整体倍速：存下、1 = 去掉；不在范围里不存；三种对齐方式都能和它一起用', async () => {
    const { ctx } = setup();
    await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a', videoDurationSec: 120 });
    const before = await read(ctx);
    expect(await setDubOverallRate(ctx, VID, 1.25)).toBe(true);
    expect((await read(ctx)).overallRate).toBe(1.25);
    await setDubEnglishRate(ctx, VID, 1.3);
    expect(await read(ctx)).toMatchObject({ overallRate: 1.25, englishRate: 1.3 });
    await setDubQuickRate(ctx, VID, 0.8);
    expect(await read(ctx)).toMatchObject({ overallRate: 1.25, quickRate: 0.8 });
    await setDubRateAlign(ctx, VID, undefined);
    expect(await setDubOverallRate(ctx, VID, 2.5)).toBe(false);
    expect(await setDubOverallRate(ctx, VID, 1)).toBe(true);
    expect(await read(ctx)).toEqual(before);
  });
  it('开着加快英文时换文件：倍速按新文件的时长重新算；整体倍速保留', async () => {
    const { ctx } = setup();
    const first = await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a', videoDurationSec: 120 });
    await setDubEnglishRate(ctx, VID, 1.1);
    await setDubOverallRate(ctx, VID, 1.5);
    const second = await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'b.m4a', videoDurationSec: 120 });
    expect(second.englishRate).toBe(Number((120 / first.durationSec!).toFixed(6)));
    expect(second.overallRate).toBe(1.5);
    expect(second.quickRate).toBeUndefined();
    // 差得太多：回到手动对齐
    const third = await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'c.m4a', videoDurationSec: 600 });
    expect(third.englishRate).toBeUndefined();
  });
  it('读存储时校验；随导出', async () => {
    const rec = { videoId: VID, fileId: 'dub_abcd1234', fileName: 'a.m4a', size: 10, mime: 'audio/mp4', delaySec: 2, addedAt: 1 };
    expect(sanitizeDubIndex({ [VID]: { ...rec, englishRate: 1.0928049, overallRate: 1.25 } })[VID]).toMatchObject({ englishRate: 1.092805, overallRate: 1.25 });
    // 两种都有（手改的存储）：按快速对齐算
    const both = sanitizeDubIndex({ [VID]: { ...rec, quickRate: 0.9, englishRate: 1.1 } })[VID]!;
    expect(both.quickRate).toBe(0.9);
    expect('englishRate' in both).toBe(false);
    for (const bad of [0.1, 9, 'x', null]) {
      const got = sanitizeDubIndex({ [VID]: { ...rec, englishRate: bad, overallRate: bad } })[VID]!;
      expect('englishRate' in got || 'overallRate' in got, String(bad)).toBe(false);
    }
    const { ctx } = setup();
    await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a' });
    await setDubEnglishRate(ctx, VID, 1.2);
    await setDubOverallRate(ctx, VID, 0.75);
    const file = await exportAll(ctx);
    expect((file.data.dubs as Record<string, { englishRate?: number; overallRate?: number }>)[VID]).toMatchObject({ englishRate: 1.2, overallRate: 0.75 });
  });
});

describe('保存完整双语视频：画面变速时中文放在哪里、按什么速度放（DECISIONS §87）', () => {
  it('加快英文、不整体变速：中文原样不动（速度正好是 1），铺满整个新文件；新文件和中文一样长', () => {
    const al = dubAlignment(ENGLISH, V, D);
    // 画面的实际倍速（时间单位换算后）和存下的差百万分之一级
    const speed = K * (1 + 3e-7);
    const pieces = renderPieces(al, 48000, speed);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.rate).toBe(1);
    expect(pieces[0]!.outStart).toBe(0);
    expect(pieces[0]!.outEnd / 48000).toBeCloseTo(V / speed, 3);
    expect(V / speed).toBeCloseTo(D, 0);
  });
  it('手动对齐 + 整体 1.25 倍：每段都按 1.25 倍，位置是原来的 ÷ 1.25', () => {
    const map: DubMap = { delaySec: 2, anchors: [{ video: 30, dub: 20 }] };
    const al = dubAlignment(map, 60, 50);
    const plain = renderPieces(al, 1000);
    const fast = renderPieces(al, 1000, 1.25);
    expect(fast).toHaveLength(plain.length);
    fast.forEach((p, i) => {
      expect(p.rate).toBeCloseTo(1.25, 9);
      expect(p.outStart).toBe(Math.round(plain[i]!.outStart / 1.25));
      expect(p.d0).toBeCloseTo(plain[i]!.d0, 2);
      expect(p.d1).toBe(plain[i]!.d1);
    });
  });
  it('快速对齐 + 整体 1.5 倍：中文 0.8 × 1.5 = 1.2 倍', () => {
    const al = dubAlignment({ delaySec: 0, anchors: [], quickRate: 0.8 }, 100, 80);
    const [p] = renderPieces(al, 1000, 1.5);
    expect(p!.rate).toBeCloseTo(1.2, 9);
    expect(p!.outEnd).toBe(Math.round((100 / 1.5) * 1000));
  });
});
