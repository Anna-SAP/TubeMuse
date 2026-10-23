// 观看追踪的纯逻辑：把每秒一次的播放器采样累计成会话，再按"本地日期 + 视频"汇总。
// 规则：有效观看只在"正在播放且不是广告"时计时（暂停不计）；
// 完成率 = 实际播放过的内容区间并集 / 时长——拖动进度条跳过的部分不算，所以刷不了完成率。

import { WATCH } from '../config/defaults';
import type { WatchRecord, WatchSession, WatchStatus } from './types';

export interface PlaybackSample {
  /** 采样时刻（毫秒） */
  t: number;
  videoId: string | null;
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  rate: number;
  isAd: boolean;
  /** 标签页是否在前台可见 */
  visible: boolean;
  shorts: boolean;
}

export interface TrackerState {
  session?: WatchSession;
  last?: PlaybackSample;
}

export interface StepResult {
  state: TrackerState;
  /** 换了视频 / 离开播放页时，上一段会话结束 */
  finished?: WatchSession;
}

export function mergeIntervals(list: [number, number][]): [number, number][] {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const prev = out[out.length - 1];
    if (prev && a <= prev[1] + 0.5) prev[1] = Math.max(prev[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function coveredSeconds(list: [number, number][]): number {
  return mergeIntervals(list).reduce((s, [a, b]) => s + (b - a), 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 处理一次采样。纯函数：同样的采样序列得到同样的结果。 */
export function stepTracker(state: TrackerState, s: PlaybackSample, newId: () => string): StepResult {
  let session = state.session;
  let finished: WatchSession | undefined;

  // 换视频（含 YouTube 站内跳转）或离开播放页：结束上一段
  if (session && s.videoId !== session.videoId) {
    finished = session;
    session = undefined;
  }
  if (!s.videoId) return finished ? { state: { last: s }, finished } : { state: { last: s } };

  if (!session) {
    session = {
      id: newId(),
      videoId: s.videoId,
      startedAt: s.t,
      updatedAt: s.t,
      durationSec: 0,
      intervals: [],
      playSec: 0,
      fgSec: 0,
      bgSec: 0,
      adSec: 0,
      shorts: s.shorts,
    };
  } else {
    session = { ...session, intervals: session.intervals.map((iv) => [iv[0], iv[1]] as [number, number]) };
  }
  if (!s.isAd && Number.isFinite(s.duration) && s.duration > 0) session.durationSec = round2(s.duration);

  const last = state.last;
  if (last && last.videoId === s.videoId) {
    const wall = (s.t - last.t) / 1000;
    const wasPlaying = !last.paused && !last.ended;
    if (wall > 0 && wall <= WATCH.maxTickGapSec && wasPlaying) {
      if (s.isAd || last.isAd) {
        session.adSec = round2(session.adSec + wall);
      } else {
        const advanced = s.currentTime - last.currentTime;
        const rate = last.rate > 0 ? last.rate : 1;
        const expected = wall * rate;
        // 正常播放：进度前进且不超过"墙钟 × 倍速 + 容差"；否则视为拖动，不计入
        if (advanced > 0 && advanced <= expected + WATCH.seekToleranceSec) {
          session.intervals = mergeIntervals([...session.intervals, [last.currentTime, s.currentTime]]);
          const watched = Math.min(wall, advanced / rate);
          session.playSec = round2(session.playSec + watched);
          if (last.visible && s.visible) session.fgSec = round2(session.fgSec + watched);
          else session.bgSec = round2(session.bgSec + watched);
        }
      }
    }
  }
  session.updatedAt = s.t;
  const next: TrackerState = { session, last: s };
  return finished ? { state: next, finished } : { state: next };
}

export interface WatchThresholds {
  glanceCompletion: number;
  glanceSeconds: number;
  completeCompletion: number;
}

/**
 * 判定（按规格字面顺序）：
 *   瞥一眼 = 完成率 < glanceCompletion 或 有效观看 < glanceSeconds；
 *   看完   = 完成率 ≥ completeCompletion；
 *   其余   = 部分观看。
 * 注意：时长不足 glanceSeconds 的视频即使看完也算"瞥一眼"（见 DECISIONS.md）。
 */
export function classifyWatch(completion: number, playSec: number, t: WatchThresholds): WatchStatus {
  if (completion < t.glanceCompletion || playSec < t.glanceSeconds) return 'glance';
  if (completion >= t.completeCompletion) return 'completed';
  return 'partial';
}

/** 把同一天同一视频的多段会话合成一条记录（区间取并集，时长相加）。 */
export function aggregateRecord(day: string, sessions: WatchSession[], t: WatchThresholds): WatchRecord | undefined {
  if (!sessions.length) return undefined;
  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  const durationSec = Math.max(...sorted.map((s) => s.durationSec));
  const intervals = mergeIntervals(sorted.flatMap((s) => s.intervals));
  const covered = coveredSeconds(intervals);
  const completion = durationSec > 0 ? Math.min(1, covered / durationSec) : 0;
  const playSec = round2(sorted.reduce((s, x) => s + x.playSec, 0));
  const fgSec = round2(sorted.reduce((s, x) => s + x.fgSec, 0));
  const bgSec = round2(sorted.reduce((s, x) => s + x.bgSec, 0));
  return {
    day,
    videoId: sorted[0]!.videoId,
    sessionIds: sorted.map((s) => s.id),
    firstAt: sorted[0]!.startedAt,
    lastAt: Math.max(...sorted.map((s) => s.updatedAt)),
    durationSec,
    completion: round2(completion),
    playSec,
    fgSec,
    bgSec,
    status: classifyWatch(completion, playSec, t),
    background: bgSec > fgSec,
    shorts: sorted.some((s) => s.shorts),
  };
}

/** 从地址里取视频 ID：/watch?v=…、/shorts/…、/live/…（站内跳转不刷新页面，所以每次采样都重新取） */
export function videoIdFromUrl(href: string): { videoId: string | null; shorts: boolean } {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { videoId: null, shorts: false };
  }
  const valid = (id: string | null | undefined) => (id && /^[\w-]{6,20}$/.test(id) ? id : null);
  if (u.pathname === '/watch') return { videoId: valid(u.searchParams.get('v')), shorts: false };
  const m = /^\/(shorts|live)\/([\w-]+)/.exec(u.pathname);
  if (m) return { videoId: valid(m[2]), shorts: m[1] === 'shorts' };
  return { videoId: null, shorts: false };
}
