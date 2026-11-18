// 中文配音的快速对齐（DECISIONS §82，用户 2026-11-16 要求）：按"中文时长 ÷ 视频时长"给出建议倍速，点一下中文整段按它放，
// 和原声同时开始、同时结束——"还差多少没对上"直接是 0；手动对齐的开头偏移和对齐点原样留着，可以切回。
// 用用户给的例子核对：英文 17:31.3、中文 14:38.4，中文短 172.9 秒，建议 0.8355（约 0.84）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DUB } from '../../src/config/defaults';
import { ENDPOINTS } from '../../src/config/endpoints';
import {
  dubMapOf,
  dubReasonText,
  dubSegmentAt,
  dubStep,
  durationNote,
  quickAlignSuggestion,
  rateExactText,
  rateText,
  rateWord,
  sanitizeDubIndex,
  sanitizeQuickRate,
  withSegmentOffset,
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
  quickFormulaText,
  remainingKind,
  remainingNoteText,
  secondsText,
} from '../../src/core/dub-align';
import type { AuthProvider } from '../../src/services/auth';
import type { AppContext } from '../../src/services/context';
import { exportAll } from '../../src/services/data-service';
import { addDubAnchor, attachDub, setDubDelay, setDubQuickRate, setDubSegmentOffset } from '../../src/services/dub-service';
import { memoryDubStore } from '../../src/services/dub-store';
import { stores } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';

/** 用户的例子：英文原声 17:31.3、中文克隆音频 14:38.4 */
const V = 17 * 60 + 31.3;
const D = 14 * 60 + 38.4;
const RATE = 0.835537;
/** 用户已经手动加的对齐点（截图里的前几个），加上开头不偏移 */
const MANUAL: DubMap = {
  delaySec: 0,
  anchors: [
    { video: 15, dub: 9 },
    { video: 34, dub: 24 },
    { video: 41, dub: 27 },
    { video: 54, dub: 37 },
  ],
};
const QUICK: DubMap = { ...MANUAL, quickRate: RATE };

const video = (over: Partial<DubVideoSample> = {}): DubVideoSample => ({ currentTime: 100, paused: false, ended: false, seeking: false, canPlay: true, rate: 1, ad: false, ...over });
const audio = (over: Partial<DubAudioSample> = {}): DubAudioSample => ({ currentTime: 100 * RATE, paused: false, duration: D, rate: RATE, ...over });

describe('快速对齐：建议倍速', () => {
  it('用户的例子：14:38.4 ÷ 17:31.3 = 0.8355，约 0.84', () => {
    const s = quickAlignSuggestion(D, V)!;
    expect(s).toMatchObject({ ok: true, dubSec: D, videoSec: V });
    expect(s.rate).toBe(RATE);
    expect(rateExactText(s.rate)).toBe('0.8355');
    expect(rateText(s.rate)).toBe('0.84×');
    expect(rateWord(s.rate)).toBe('慢放');
    expect(quickFormulaText(s)).toBe('中文 14:38.4 ÷ 英文 17:31.3 = 0.8355（约 0.84）');
    // 中文按这个倍速放完，正好占满整个视频（误差远小于一帧）
    expect(Math.abs(D / s.rate - V)).toBeLessThan(0.001);
  });

  it('中文比视频长时是快放；一样长是原速', () => {
    const s = quickAlignSuggestion(660, 600)!;
    expect(s).toMatchObject({ ok: true, rate: 1.1 });
    expect(rateWord(s.rate)).toBe('快放');
    expect(rateWord(quickAlignSuggestion(600, 600)!.rate)).toBe('原速');
  });

  it('读不到哪一边的时长：算不出来', () => {
    expect(quickAlignSuggestion(undefined, V)).toBeUndefined();
    expect(quickAlignSuggestion(D, undefined)).toBeUndefined();
    expect(quickAlignSuggestion(0, V)).toBeUndefined();
    expect(quickAlignSuggestion(NaN, V)).toBeUndefined();
  });

  it('差得太多（要慢到 0.5× 以下或快到 2× 以上）：给出数，但说明不提供、仍用手动对齐点', () => {
    const slow = quickAlignSuggestion(400, 1000)!;
    expect(slow).toMatchObject({ ok: false, rate: 0.4 });
    expect(slow.why).toContain('0.40×');
    expect(slow.why).toContain('手动对齐点');
    const fast = quickAlignSuggestion(2500, 1000)!;
    expect(fast.ok).toBe(false);
    expect(fast.why).toContain('2.50×');
    // 边界上的能用
    expect(quickAlignSuggestion(500, 1000)!.ok).toBe(true);
    expect(quickAlignSuggestion(2000, 1000)!.ok).toBe(true);
  });

  it('存下的倍速：只认范围内的有限数，6 位小数；别的当作没开', () => {
    expect(sanitizeQuickRate(0.8355371234)).toBe(0.835537);
    expect(sanitizeQuickRate(1)).toBe(1);
    expect(sanitizeQuickRate(0.49)).toBeUndefined();
    expect(sanitizeQuickRate(2.01)).toBeUndefined();
    expect(sanitizeQuickRate(NaN)).toBeUndefined();
    expect(sanitizeQuickRate('0.84')).toBeUndefined();
    expect(sanitizeQuickRate(undefined)).toBeUndefined();
    expect(DUB.quick.minRate).toBe(0.5);
    expect(DUB.quick.maxRate).toBe(2);
  });
});

describe('快速对齐：跟随', () => {
  it('中文位置 = 视频位置 × 倍速，中文的播放速度 = 视频倍速 × 倍速；对得上就不跳', () => {
    const step = dubStep(video({ currentTime: 939 }), audio({ currentTime: 939 * RATE }), QUICK);
    expect(step).toMatchObject({ play: true, reason: 'playing' });
    expect(step.target).toBeCloseTo(784.57, 2);
    expect(step.seekTo).toBeUndefined();
    expect(step.rate).toBeUndefined();
    // 配音还在按原速放（刚点了建议倍速）：改成慢放
    expect(dubStep(video(), audio({ rate: 1 }), QUICK).rate).toBeCloseTo(RATE, 6);
    // 视频 1.5 倍速：中文 1.5 × 0.8355
    expect(dubStep(video({ rate: 1.5 }), audio(), QUICK).rate).toBeCloseTo(1.5 * RATE, 6);
  });

  it('手动的开头偏移和对齐点留着但不用：不停下等画面、不跳、没有"还没开始"', () => {
    // 手动对齐时，视频 30 秒处中文这一段（到 24 秒）已经说完，停下等画面
    expect(dubStep(video({ currentTime: 33 }), audio({ currentTime: 24, rate: 1 }), MANUAL).reason).toBe('segment-end');
    // 快速对齐：同一处照常放
    const step = dubStep(video({ currentTime: 33 }), audio({ currentTime: 33 * RATE }), QUICK);
    expect(step).toMatchObject({ play: true, reason: 'playing' });
    expect(step.seekTo).toBeUndefined();
    // 开头推后 5 秒的也不等
    const delayed = dubStep(video({ currentTime: 1 }), audio({ currentTime: RATE }), { ...QUICK, delaySec: 5 });
    expect(delayed).toMatchObject({ play: true, reason: 'playing' });
    expect(delayed.target).toBeCloseTo(RATE, 6);
    expect(dubSegmentAt(QUICK, 33)).toEqual({ index: -1, fromVideo: 0, offset: Number((33 * (1 - RATE)).toFixed(2)) });
  });

  it('拖动进度后差得多：拉到视频位置 × 倍速；暂停时也把位置对好', () => {
    expect(dubStep(video({ currentTime: 600 }), audio({ currentTime: 10 }), QUICK).seekTo).toBeCloseTo(600 * RATE, 6);
    const paused = dubStep(video({ currentTime: 600, paused: true }), audio({ currentTime: 10 }), QUICK);
    expect(paused).toMatchObject({ play: false, reason: 'paused' });
    expect(paused.seekTo).toBeCloseTo(600 * RATE, 6);
    expect(dubStep(video({ paused: true }), audio(), QUICK).seekTo).toBeUndefined();
    // 从暂停开始放时先对准
    expect(dubStep(video(), audio({ paused: true, currentTime: 100 * RATE - 0.2 }), QUICK).seekTo).toBeCloseTo(100 * RATE, 6);
  });

  it('跳转中 / 缓冲 / 广告 / 放完：配音停', () => {
    expect(dubStep(video({ seeking: true }), audio(), QUICK)).toMatchObject({ play: false, reason: 'seeking' });
    expect(dubStep(video({ canPlay: false }), audio(), QUICK)).toMatchObject({ play: false, reason: 'buffering' });
    expect(dubStep(video({ ad: true }), audio(), QUICK)).toMatchObject({ play: false, reason: 'ad' });
    expect(dubStep(video({ ended: true }), audio(), QUICK)).toMatchObject({ play: false, reason: 'ended' });
  });

  it('放到视频最后一秒中文也还在放（同时结束）；倍速和时长对不上时中文放完就停', () => {
    expect(dubStep(video({ currentTime: V - 1 }), audio({ currentTime: (V - 1) * RATE }), QUICK)).toMatchObject({ play: true, reason: 'playing' });
    // 换了一个更短的文件（13:38.4），倍速没变：中文在视频 16:19 放完
    expect(dubStep(video({ currentTime: 1000 }), audio({ duration: D - 60, currentTime: D - 60 }), QUICK)).toMatchObject({ play: false, reason: 'after-end' });
  });

  it('状态的说法：写明是快速对齐和倍速', () => {
    expect(dubReasonText('playing', { offset: 0 }, { quickRate: RATE })).toBe('配音播放中：快速对齐，中文按 0.84× 慢放跟着视频走');
    expect(dubReasonText('paused', { offset: 0 }, { quickRate: RATE })).toBe('视频暂停，配音跟着暂停');
    expect(dubReasonText('playing', { offset: 0 })).toBe('配音播放中，跟着视频走');
  });

  it('拖动时的实时偏移不影响快速对齐（倍速留在对齐信息里）', () => {
    expect(withSegmentOffset(QUICK, -1, 12).quickRate).toBe(RATE);
    expect(withSegmentOffset(QUICK, 1, 12).quickRate).toBe(RATE);
    expect(dubMapOf({ delaySec: 0, anchors: MANUAL.anchors as never, quickRate: RATE }).quickRate).toBe(RATE);
    expect('quickRate' in dubMapOf({ delaySec: 0 })).toBe(false);
  });
});

describe('快速对齐：还差多少没对上直接是 0', () => {
  const al = dubAlignment(QUICK, V, D);

  it('一段到底：中文 0–14:38.4 放满视频 0–17:31.3，没有停下等、没有跳过', () => {
    expect(al.quickRate).toBe(RATE);
    expect(al.pieces).toHaveLength(1);
    const p = al.pieces[0]!;
    expect(p).toMatchObject({ segment: -1, v0: 0, d0: 0, rate: RATE });
    expect(p.v1).toBeCloseTo(V, 2);
    expect(p.d1).toBeCloseTo(D, 2);
    expect(al.holds).toEqual([]);
    expect(al.skips).toEqual([]);
  });

  it('用户截图那一刻（视频 15:39）：手动对齐还差 31.9 秒，点了建议倍速之后是 0.0 秒', () => {
    const t = 15 * 60 + 39;
    // 手动：第 56 个对齐点之后中文滞后 141 秒 → 172.9 − 141.0 = 31.9
    const manual: DubMap = { delaySec: 0, anchors: [{ video: 933, dub: 792 }] };
    const mal = dubAlignment(manual, V, D);
    const before = dubRemainingAt(mal, dubPlanAt(mal, manual, t), t)!;
    expect(secondsText(before.remaining)).toBe('31.9 秒');
    // 快速对齐
    const plan = dubPlanAt(al, QUICK, t);
    expect(plan.kind).toBe('playing');
    expect(plan.dub).toBeCloseTo(t * RATE, 6);
    const r = dubRemainingAt(al, plan, t)!;
    expect(secondsText(r.remaining)).toBe('0.0 秒');
    expect(secondsText(r.total)).toBe('172.9 秒');
    expect(remainingKind(r)).toBe('done');
    expect(remainingNoteText(al, plan, t, r)).toBe('快速对齐：中文按 0.8355× 慢放（中文 14:38.4 ÷ 英文 17:31.3），全片时长差 172.9 秒匀到整段，中文和视频同时结束 · 视频 15:39 ↔ 中文 13:05');
  });

  it('全程都是 0：不随播放位置变（刚开始、中间、最后一秒、放完）', () => {
    for (const t of [0, 1, 300, 939, V - 1, V]) {
      const r = dubRemainingAt(al, dubPlanAt(al, QUICK, t), t)!;
      expect(secondsText(r.remaining), `t=${t}`).toBe('0.0 秒');
      expect(remainingKind(r)).toBe('done');
    }
  });

  it('全片与此刻的说法：同时开始、同时结束，时长差匀到整段；不说成逐句对上', () => {
    const overall = alignOverallText(al)!;
    expect(overall).toContain('快速对齐：中文整段按 0.8355× 慢放，和视频同时开始、同时结束');
    expect(overall).toContain('全片中文短 2 分 53 秒，匀到了整段');
    expect(overall).toContain('切回手动对齐点');
    expect(overall).not.toMatch(/逐句|逐词/);
    const t = 939;
    expect(alignNowText(dubPlanAt(al, QUICK, t), t, { quickRate: RATE })).toBe('此刻：视频 15:39 ↔ 中文 13:05，快速对齐，中文 0.84× 慢放');
    expect(describeVideoAt(al, 600)).toBe('视频 10:00 ↔ 中文 8:21（快速对齐，中文 0.84× 慢放）');
    expect(describeDubAt(al, 600 * RATE)).toBe('中文 8:21 → 在视频 10:00 放（快速对齐，中文 0.84× 慢放）');
    const note = durationNote(D, V, { quickRate: RATE })!;
    expect(note).toContain('中文 14:38 · 原视频 17:31，中文短 2 分 53 秒');
    expect(note).toContain('快速对齐开着：中文整段按 0.84× 慢放');
    expect(note).not.toMatch(/逐句|逐词/);
    // 没开时提到两条路：快速对齐，或加对齐点
    expect(durationNote(D, V)).toContain('快速对齐');
    expect(durationNote(D, V)).toContain('加对齐点');
  });

  it('图上画的就是跟随真的会做的：逐点和 dubStep 对照', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const dd of [D, D - 60, D + 45]) {
      const a = dubAlignment(QUICK, V, dd);
      const edges = [0, V, ...a.pieces.flatMap((p) => [p.v0, p.v1])];
      for (let n = 0; n < 300; n++) {
        const t = rnd() * V;
        if (edges.some((e) => Math.abs(e - t) < 0.05)) continue;
        const plan = dubPlanAt(a, QUICK, t);
        const step = dubStep(video({ currentTime: t }), audio({ currentTime: plan.dub, duration: dd }), QUICK);
        expect(step.reason, `t=${t.toFixed(2)} dd=${dd}`).toBe(plan.kind === 'playing' ? 'playing' : 'after-end');
        if (plan.kind === 'playing') expect(Math.abs(step.target - plan.dub)).toBeLessThan(1e-6);
        expect(step.seekTo, `t=${t.toFixed(2)}`).toBeUndefined();
      }
    }
  });

  it('倍速和现在的时长对不上（设好之后换了文件）：如实显示还差多少，并说怎么办', () => {
    // 中文短了 60 秒：按原来的倍速在视频 16:19 就放完，最后 71.8 秒只有原声
    const short = dubAlignment(QUICK, V, D - 60);
    expect(short.holds).toEqual([{ segment: -1, kind: 'after-end', v0: (D - 60) / RATE, v1: V }]);
    const t = 500;
    const r1 = dubRemainingAt(short, dubPlanAt(short, QUICK, t), t)!;
    expect(remainingKind(r1)).toBe('left');
    expect(r1.remaining).toBeCloseTo(60 / RATE, 1);
    const n1 = remainingNoteText(short, dubPlanAt(short, QUICK, t), t, r1);
    expect(n1).toContain('在视频 16:19 就放完了，最后 71.8 秒只有原声');
    expect(n1).toContain('点下面的建议倍速重新对齐');
    expect(n1).toContain(`应是 ${rateExactText((D - 60) / V)}×`);
    expect(alignOverallText(short)).toContain('最后 1 分 12 秒只有原声');
    // 放到中文已经放完之后
    const late = dubPlanAt(short, QUICK, 1000);
    expect(late.kind).toBe('after-end');
    expect(remainingNoteText(short, late, 1000, dubRemainingAt(short, late, 1000)!)).toContain('中文在视频 16:19 已经放完，后面只有原声');
    // 中文长了 45 秒：视频放完时还有 45 秒没放到
    const long = dubAlignment(QUICK, V, D + 45);
    expect(long.skips).toHaveLength(1);
    expect(long.skips[0]).toMatchObject({ kind: 'tail' });
    const r2 = dubRemainingAt(long, dubPlanAt(long, QUICK, t), t)!;
    expect(remainingKind(r2)).toBe('over');
    expect(remainingNoteText(long, dubPlanAt(long, QUICK, t), t, r2)).toContain('视频放完时中文还有 45.0 秒没放到');
    expect(alignOverallText(long)).toContain('视频放完时中文还剩 45 秒没放到');
  });

  it('读不到中文时长时算不出还差多少（和手动对齐一样）', () => {
    const open = dubAlignment(QUICK, V);
    expect(dubRemainingAt(open, dubPlanAt(open, QUICK, 100), 100)).toBeUndefined();
    expect(open.pieces[0]).toMatchObject({ v0: 0, v1: V, d0: 0 });
  });
});

const M4A = new Uint8Array(readFileSync(new URL('../fixtures/xyz-tones.m4a', import.meta.url)));
const NOW = Date.parse('2026-11-16T02:00:00Z');
const VID = 'O_zcc6XI12g';

function setup() {
  const kv = memoryKV();
  const dubAudio = memoryDubStore();
  const auth = { disconnect: async () => ({ revoked: false }) } as unknown as AuthProvider;
  const blocked = (() => {
    throw new Error('配音不该发网络请求');
  }) as unknown as typeof fetch;
  const ctx: AppContext = { kv, locker: memoryLocker(), http: blocked, now: () => NOW, auth, endpoints: ENDPOINTS, timeZone: 'Asia/Shanghai', dubAudio };
  return { ctx, kv };
}
const m4aBlob = () => new Blob([M4A as BlobPart], { type: 'audio/x-m4a' });

describe('快速对齐：存下、切回手动', () => {
  it('开启：记下倍速，开头偏移和对齐点原样留着；切回手动：倍速去掉，偏移和对齐点照旧', async () => {
    const { ctx } = setup();
    await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a', videoDurationSec: 120 });
    await setDubDelay(ctx, VID, 1.5);
    for (const a of MANUAL.anchors) await addDubAnchor(ctx, VID, a);
    const before = (await stores.dubs.read(ctx.kv))[VID]!;
    expect(before.quickRate).toBeUndefined();

    expect(await setDubQuickRate(ctx, VID, 0.8355371)).toBe(true);
    const on = (await stores.dubs.read(ctx.kv))[VID]!;
    expect(on.quickRate).toBe(0.835537);
    expect(on.delaySec).toBe(1.5);
    expect(on.anchors).toEqual(MANUAL.anchors);
    expect(dubMapOf(on).quickRate).toBe(0.835537);

    expect(await setDubQuickRate(ctx, VID, undefined)).toBe(true);
    const off = (await stores.dubs.read(ctx.kv))[VID]!;
    // 和开启之前一模一样
    expect(off).toEqual(before);
    expect('quickRate' in off).toBe(false);
  });

  it('不在范围里的倍速不存；没有这个视频时不存', async () => {
    const { ctx } = setup();
    await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a' });
    expect(await setDubQuickRate(ctx, VID, 0.3)).toBe(false);
    expect(await setDubQuickRate(ctx, VID, NaN)).toBe(false);
    expect((await stores.dubs.read(ctx.kv))[VID]!.quickRate).toBeUndefined();
    expect(await setDubQuickRate(ctx, 'noSuchVideo1', 0.8)).toBe(false);
  });

  it('快速对齐开着时改手动的偏移（切回之前的残留操作）不会把倍速弄丢', async () => {
    const { ctx } = setup();
    await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a' });
    await setDubQuickRate(ctx, VID, 0.8);
    await setDubSegmentOffset(ctx, VID, -1, 3);
    await addDubAnchor(ctx, VID, { video: 40, dub: 30 });
    expect((await stores.dubs.read(ctx.kv))[VID]).toMatchObject({ quickRate: 0.8, delaySec: 3, anchors: [{ video: 40, dub: 30 }] });
  });

  it('开着时换文件：倍速按新文件的时长重新算；算不出来时先留着旧的', async () => {
    const { ctx } = setup();
    const first = await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a', videoDurationSec: 120 });
    await setDubQuickRate(ctx, VID, 0.9);
    // 同一个视频（2 分钟）换一版配音（92 秒）：92 ÷ 120
    const second = await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'b.m4a', videoDurationSec: 120 });
    expect(second.quickRate).toBe(Number((first.durationSec! / 120).toFixed(6)));
    expect(second.quickRate).toBeCloseTo(0.7667, 3);
    // 新文件和视频差得太多（92 秒对 10 分钟）：回到手动对齐
    const third = await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'c.m4a', videoDurationSec: 600 });
    expect(third.quickRate).toBeUndefined();
  });

  it('没开过的视频换文件不会自己开', async () => {
    const { ctx } = setup();
    await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a', videoDurationSec: 120 });
    expect((await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'b.m4a', videoDurationSec: 120 })).quickRate).toBeUndefined();
  });

  it('读存储时校验：坏掉的倍速丢掉（当作手动对齐），别的照旧；随导出', async () => {
    const rec = { videoId: VID, fileId: 'dub_abcd1234', fileName: 'a.m4a', size: 10, mime: 'audio/mp4', delaySec: 2, addedAt: 1, anchors: [{ video: 15, dub: 9 }] };
    expect(sanitizeDubIndex({ [VID]: { ...rec, quickRate: 0.8355371 } })[VID]).toMatchObject({ quickRate: 0.835537, delaySec: 2, anchors: [{ video: 15, dub: 9 }] });
    for (const bad of [0.1, 9, 'x', null, Infinity]) {
      const got = sanitizeDubIndex({ [VID]: { ...rec, quickRate: bad } })[VID]!;
      expect('quickRate' in got, String(bad)).toBe(false);
      expect(got.anchors).toEqual([{ video: 15, dub: 9 }]);
    }
    const { ctx } = setup();
    await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a' });
    await setDubQuickRate(ctx, VID, 0.84);
    const file = await exportAll(ctx);
    expect((file.data.dubs as Record<string, { quickRate?: number }>)[VID]?.quickRate).toBe(0.84);
  });
});
