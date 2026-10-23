import { describe, expect, it } from 'vitest';
import { aggregateRecord, classifyWatch, mergeIntervals, stepTracker, videoIdFromUrl, type PlaybackSample, type TrackerState } from '../../src/core/watch';
import { DEFAULT_SETTINGS } from '../../src/config/defaults';
import type { WatchSession } from '../../src/core/types';

const T = DEFAULT_SETTINGS.tracking;
const T0 = Date.parse('2026-10-24T02:00:00Z');

/** 模拟播放器：按脚本逐秒产生采样 */
function simulate(script: (i: number) => Partial<PlaybackSample> & { advance?: number }, seconds: number, start: Partial<PlaybackSample> = {}) {
  let state: TrackerState = {};
  const finished: WatchSession[] = [];
  let ct = start.currentTime ?? 0;
  let n = 0;
  for (let i = 0; i <= seconds; i++) {
    const step = script(i);
    if (i > 0) ct += step.advance ?? 0;
    if (step.currentTime !== undefined) ct = step.currentTime;
    const s: PlaybackSample = {
      t: T0 + i * 1000,
      videoId: 'vidA',
      currentTime: ct,
      duration: 600,
      paused: false,
      ended: false,
      rate: 1,
      isAd: false,
      visible: true,
      shorts: false,
      ...start,
      ...step,
    };
    s.currentTime = ct;
    const r = stepTracker(state, s, () => `s${++n}`);
    state = r.state;
    if (r.finished) finished.push(r.finished);
  }
  return { session: state.session!, finished };
}

const rec = (s: WatchSession) => aggregateRecord('2026-10-24', [s], T)!;

describe('观看追踪：有效观看与完成率', () => {
  it('完整看完 10 分钟视频 → 看完', () => {
    const { session } = simulate(() => ({ advance: 1 }), 600);
    expect(session.playSec).toBeCloseTo(600, 0);
    expect(rec(session).status).toBe('completed');
    expect(rec(session).completion).toBeGreaterThanOrEqual(0.99);
  });

  it('秒退（3 秒）→ 瞥一眼', () => {
    const { session } = simulate(() => ({ advance: 1 }), 3);
    expect(rec(session).status).toBe('glance');
  });

  it('看一半 → 部分观看', () => {
    const { session } = simulate(() => ({ advance: 1 }), 300);
    const r = rec(session);
    expect(r.status).toBe('partial');
    expect(r.completion).toBeCloseTo(0.5, 1);
  });

  it('暂停不计时', () => {
    const { session } = simulate((i) => (i > 60 && i <= 260 ? { paused: true, advance: 0 } : { advance: 1 }), 320);
    // 播放 60 + 60 秒、中间暂停 200 秒；恢复播放的那一秒按采样粒度可能少计 1 秒
    expect(Math.abs(session.playSec - 120)).toBeLessThanOrEqual(1);
  });

  it('拖动进度条刷不了完成率：跳过的部分不计入', () => {
    const { session } = simulate((i) => (i === 20 ? { currentTime: 590 } : { advance: 1 }), 30);
    const r = rec(session);
    expect(r.completion).toBeLessThan(0.1);
    expect(r.status).toBe('glance');
  });

  it('广告时间不算有效观看，广告时长不当作视频时长', () => {
    const { session } = simulate((i) => (i <= 30 ? { isAd: true, duration: 30, advance: 1 } : i === 31 ? { currentTime: 0 } : { advance: 1 }), 100);
    expect(session.adSec).toBeGreaterThanOrEqual(30);
    expect(session.playSec).toBeCloseTo(69, 0);
    expect(session.durationSec).toBe(600);
  });

  it('后台播放：计入有效观看，单独记为后台时长；以后台为主时标为后台收听', () => {
    const { session } = simulate((i) => ({ advance: 1, visible: i < 50 }), 400);
    expect(session.bgSec).toBeGreaterThan(session.fgSec);
    expect(session.playSec).toBeCloseTo(400, 0);
    expect(rec(session).background).toBe(true);
  });

  it('2 倍速：完成率按内容算，有效观看按真实时间算', () => {
    const { session } = simulate(() => ({ advance: 2, rate: 2 }), 300);
    const r = rec(session);
    expect(r.completion).toBeGreaterThanOrEqual(0.99);
    expect(r.playSec).toBeCloseTo(300, 0);
    expect(r.status).toBe('completed');
  });

  it('后台节流：一分钟一次的采样只要进度连续也照常计时；过长的间隔（休眠）不计', () => {
    let state: TrackerState = {};
    const s = (t: number, ct: number): PlaybackSample => ({ t, videoId: 'v', currentTime: ct, duration: 3000, paused: false, ended: false, rate: 1, isAd: false, visible: false, shorts: false });
    state = stepTracker(state, s(T0, 0), () => 'x').state;
    state = stepTracker(state, s(T0 + 60_000, 60), () => 'x').state;
    expect(state.session!.playSec).toBeCloseTo(60, 0);
    state = stepTracker(state, s(T0 + 60_000 + 300_000, 360), () => 'x').state;
    expect(state.session!.playSec).toBeCloseTo(60, 0);
  });

  it('站内跳转换视频：上一段会话结束并返回', () => {
    const { finished } = simulate((i) => ({ advance: 1, videoId: i < 40 ? 'vidA' : 'vidB' }), 60);
    expect(finished).toHaveLength(1);
    expect(finished[0]!.videoId).toBe('vidA');
  });

  it('同一天分两次看同一视频：区间取并集、时长相加', () => {
    const a = simulate(() => ({ advance: 1 }), 300).session;
    const b = simulate(() => ({ advance: 1 }), 320, { currentTime: 280 }).session;
    const r = aggregateRecord('2026-10-24', [a, { ...b, id: 'other', startedAt: a.startedAt + 3_600_000 }], T)!;
    expect(r.completion).toBeGreaterThanOrEqual(0.99);
    expect(r.playSec).toBeCloseTo(620, 0);
    expect(r.status).toBe('completed');
  });
});

describe('判定阈值（按规格字面顺序）', () => {
  it('瞥一眼优先：完成率 < 15% 或有效观看 < 30 秒', () => {
    expect(classifyWatch(0.1, 500, T)).toBe('glance');
    expect(classifyWatch(0.9, 20, T)).toBe('glance');
    expect(classifyWatch(0.85, 30, T)).toBe('completed');
    expect(classifyWatch(0.5, 100, T)).toBe('partial');
  });
  it('区间合并', () => {
    expect(mergeIntervals([[10, 20], [0, 5], [19, 30], [5.3, 6]])).toEqual([[0, 6], [10, 30]]);
  });
  it('从地址取视频 ID', () => {
    expect(videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toEqual({ videoId: 'dQw4w9WgXcQ', shorts: false });
    expect(videoIdFromUrl('https://www.youtube.com/shorts/abcDEF12345')).toEqual({ videoId: 'abcDEF12345', shorts: true });
    expect(videoIdFromUrl('https://www.youtube.com/feed/subscriptions')).toEqual({ videoId: null, shorts: false });
  });
});
