// 中文配音的对齐图（DECISIONS §77）：把"开头的偏移 + 对齐点"摊开成两条音轨上的对应关系，此刻的差距与全片还差多少的说法。
// 用用户手测时的真实数据（Decoder 那一期：原视频 36:52、中文 25:39，开头推后 5 秒 + 5 个对齐点）核对；
// 再和跟随本身（dubStep）逐点对照：图上画的就是播放时真的会发生的。
import { describe, expect, it } from 'vitest';
import { dubStep, withSegmentOffset, type DubMap } from '../../src/core/dub';
import {
  alignNowText,
  alignOverallText,
  alignTotals,
  describeDubAt,
  describeVideoAt,
  dubAlignment,
  dubPlanAt,
  gapText,
  mapTickStep,
} from '../../src/core/dub-align';

/** 用户 2026-11-13 截图里的状态 */
const USER: DubMap = {
  delaySec: 5,
  anchors: [
    { video: 38, dub: 30 },
    { video: 54, dub: 42 },
    { video: 68, dub: 47 },
    { video: 77, dub: 52 },
    { video: 91, dub: 66 },
  ],
};
const V = 36 * 60 + 52;
const D = 25 * 60 + 39;

describe('对齐图：摊开成两条音轨', () => {
  it('用户的真实数据：每一段中文在视频的哪里放、哪里中文停下等、中文在哪里放完', () => {
    const al = dubAlignment(USER, V, D);
    expect(al.pieces.map((p) => [p.segment, p.offset, p.v0, p.v1, p.d0, p.d1])).toEqual([
      [-1, 5, 5, 35, 0, 30],
      [0, 8, 38, 50, 30, 42],
      [1, 12, 54, 59, 42, 47],
      [2, 21, 68, 73, 47, 52],
      [3, 25, 77, 91, 52, 66],
      [4, 25, 91, 1564, 66, 1539],
    ]);
    expect(al.holds.map((h) => [h.segment, h.kind, h.v0, h.v1])).toEqual([
      [-1, 'before-start', 0, 5],
      [-1, 'wait', 35, 38],
      [0, 'wait', 50, 54],
      [1, 'wait', 59, 68],
      [2, 'wait', 73, 77],
      [4, 'after-end', 1564, V],
    ]);
    expect(al.skips).toEqual([]);
    expect(alignTotals(al)).toEqual({ waitSec: 20, skipSec: 0 });
  });

  it('全片：中文在视频 26:04 放完，最后 10 分 48 秒只有原声；全片短 11 分 13 秒，已经抵掉 25 秒', () => {
    const text = alignOverallText(dubAlignment(USER, V, D))!;
    expect(text).toContain('中文在视频 26:04 放完');
    expect(text).toContain('最后 10 分 48 秒只有原声');
    expect(text).toContain('全片中文短 11 分 13 秒');
    expect(text).toContain('已经抵掉 25 秒');
    expect(text).toContain('还差 10 分 48 秒');
    expect(text).not.toMatch(/逐句|逐词/);
  });

  it('此刻：两边各在哪里、差多少（截图那一刻：视频 1:51 ↔ 中文 1:26，晚 25 秒）', () => {
    const al = dubAlignment(USER, V, D);
    const at = (t: number) => alignNowText(dubPlanAt(al, USER, t), t);
    expect(dubPlanAt(al, USER, 111)).toMatchObject({ kind: 'playing', dub: 86 });
    expect(at(111)).toBe('此刻：视频 1:51 ↔ 中文 1:26，中文比画面晚 25 秒');
    expect(dubPlanAt(al, USER, 62)).toMatchObject({ kind: 'wait', dub: 47, until: 68 });
    expect(at(62)).toBe('此刻：视频 1:02，中文这一段已经说完、停在 0:47 等画面（只有原声），视频到 1:08 的对齐点再接着放');
    expect(dubPlanAt(al, USER, 2)).toMatchObject({ kind: 'before-start', dub: 0, until: 5 });
    expect(at(2)).toContain('中文还没开始：视频到 0:05 时从中文 0:00 开始');
    expect(dubPlanAt(al, USER, 2000)).toMatchObject({ kind: 'after-end', dub: D });
    expect(at(2000)).toContain('中文已经放完');
    expect(dubPlanAt(al, USER, V)).toMatchObject({ kind: 'ended' });
    // 正好在对齐点上：新的一段从这一刻起
    expect(dubPlanAt(al, USER, 38)).toMatchObject({ kind: 'playing', dub: 30, segment: { index: 0 } });
  });

  it('指着某一处：视频这一刻听到什么、中文这一刻在视频哪里放', () => {
    const al = dubAlignment(USER, V, D);
    expect(describeVideoAt(al, 83)).toBe('视频 1:23 ↔ 中文 0:58（第 4 个对齐点之后，中文比画面晚 25 秒）');
    expect(describeVideoAt(al, 62)).toContain('中文停下等画面，只有原声');
    expect(describeVideoAt(al, 62)).toContain('视频到 1:08 的对齐点再接着放');
    expect(describeVideoAt(al, 3)).toContain('中文还没开始');
    expect(describeVideoAt(al, 1600)).toContain('中文已经放完');
    expect(describeDubAt(al, 45)).toBe('中文 0:45 → 在视频 0:57 放（第 2 个对齐点之后）');
    expect(describeDubAt(al, D + 1)).toBe('');
  });

  it('中文说得慢：视频先到了下一个对齐点，没说完的那一点被跳过（e2e 里的那种）', () => {
    const map: DubMap = { delaySec: 0, anchors: [{ video: 70, dub: 80 }] };
    const al = dubAlignment(map, 120, 92);
    expect(al.pieces.map((p) => [p.v0, p.v1, p.d0, p.d1])).toEqual([
      [0, 70, 0, 70],
      [70, 82, 80, 92],
    ]);
    expect(al.skips).toEqual([{ segment: -1, kind: 'cut', d0: 70, d1: 80, atVideo: 70 }]);
    expect(alignTotals(al)).toEqual({ waitSec: 0, skipSec: 10 });
    expect(describeDubAt(al, 75)).toBe('中文 1:15：被跳过（这一段中文说得慢，视频先到了 1:10 的对齐点）');
    // 中文本来就比视频短，又跳过了一段：没有"已经抵掉"
    expect(alignOverallText(al)).toBe('照现在的对齐，中文在视频 1:22 放完，最后 38 秒只有原声。全片中文短 28 秒，还差 38 秒：往后在中英对不上的地方继续加对齐点。');
  });

  it('开头提前（负偏移）：中文开头被跳过；中文比视频长：视频放完时中文还剩多少', () => {
    const al = dubAlignment({ delaySec: -3, anchors: [] }, 100, 120);
    expect(al.skips.map((s) => [s.kind, s.d0, s.d1])).toEqual([
      ['head', 0, 3],
      ['tail', 103, 120],
    ]);
    expect(al.holds).toEqual([]);
    expect(describeDubAt(al, 1)).toContain('开头的偏移让中文提前了');
    expect(alignOverallText(al)).toBe('照现在的对齐，视频放完时中文还剩 17 秒没放到（中文 1:43 起）。');
  });

  it('对齐点前后颠倒：那一段整段停下等，后面重放', () => {
    const map: DubMap = { delaySec: 0, anchors: [{ video: 30, dub: 20 }, { video: 60, dub: 10 }] };
    const al = dubAlignment(map, 100, 200);
    expect(al.pieces.map((p) => p.segment)).toEqual([-1, 1]);
    expect(al.holds.map((h) => [h.segment, h.kind, h.v0, h.v1])).toEqual([
      [-1, 'wait', 20, 30],
      [0, 'wait', 30, 60],
    ]);
    expect(describeDubAt(al, 15)).toBe('中文 0:15 → 在视频 0:15 放（开头那段）；又在视频 1:05 重放（对齐点前后颠倒）');
  });

  it('读不到中文时长：最后一段一直放到视频结束，不说全片', () => {
    const al = dubAlignment({ delaySec: 0, anchors: [] }, 100);
    expect(al.pieces.map((p) => [p.v0, p.v1])).toEqual([[0, 100]]);
    expect(al.holds).toEqual([]);
    expect(alignOverallText(al)).toBeUndefined();
  });

  it('拖动时的实时偏移：换掉这一段的偏移，图跟着变（25 → 30 秒：中文晚放完 5 秒）', () => {
    const live = withSegmentOffset(USER, 4, 30);
    const text = alignOverallText(dubAlignment(live, V, D))!;
    expect(text).toContain('中文在视频 26:09 放完');
    expect(text).toContain('已经抵掉 30 秒');
  });

  it('图上画的就是跟随真的会做的：逐点和 dubStep 对照（停下等 / 还没开始 / 放完 / 放的位置）', () => {
    const maps: [DubMap, number, number][] = [
      [USER, V, D],
      [{ delaySec: 0, anchors: [{ video: 70, dub: 80 }] }, 120, 92],
      [{ delaySec: -3, anchors: [{ video: 40, dub: 50 }, { video: 80, dub: 70 }] }, 100, 90],
      [{ delaySec: 12, anchors: [{ video: 30, dub: 20 }, { video: 60, dub: 10 }] }, 100, 200],
    ];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const [map, vd, dd] of maps) {
      const al = dubAlignment(map, vd, dd);
      const edges = [0, vd, ...map.anchors.flatMap((a) => [a.video]), ...al.pieces.flatMap((p) => [p.v0, p.v1]), ...al.holds.flatMap((h) => [h.v0, h.v1])];
      for (let n = 0; n < 400; n++) {
        const t = rnd() * vd;
        if (edges.some((e) => Math.abs(e - t) < 0.05)) continue;
        const plan = dubPlanAt(al, map, t);
        const step = dubStep(
          { currentTime: t, paused: false, ended: false, seeking: false, canPlay: true, rate: 1, ad: false },
          { currentTime: plan.dub, paused: false, duration: dd, rate: 1 },
          map,
        );
        const want = { playing: 'playing', wait: 'segment-end', 'before-start': 'before-start', 'after-end': 'after-end', ended: 'ended' }[plan.kind];
        expect(step.reason, `t=${t.toFixed(2)} plan=${JSON.stringify(plan)}`).toBe(want);
        if (plan.kind === 'playing') expect(Math.abs(step.target - plan.dub)).toBeLessThan(1e-6);
        // 图上的中文位置就是跟随会把配音放到 / 停在的位置：不需要再跳
        expect(step.seekTo, `t=${t.toFixed(2)}`).toBeUndefined();
      }
    }
  });
});

describe('对齐图：说法与刻度', () => {
  it('差距的说法', () => {
    expect(gapText(25)).toBe('中文比画面晚 25 秒');
    expect(gapText(-10)).toBe('中文比画面早 10 秒');
    expect(gapText(0.02)).toBe('中文和画面同步');
    expect(gapText(90)).toBe('中文比画面晚 1 分 30 秒');
  });

  it('刻度间隔：每格至少 56 像素', () => {
    expect(mapTickStep(5)).toBe(15);
    expect(mapTickStep(1)).toBe(60);
    expect(mapTickStep(100)).toBe(1);
    expect(mapTickStep(0.4)).toBe(300);
    expect(mapTickStep(0.0001)).toBe(7200);
  });
});
