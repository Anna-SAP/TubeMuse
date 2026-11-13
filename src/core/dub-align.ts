// 中文配音的对齐图（用户 2026-11-13 手测后要求，见 DECISIONS §77）的纯逻辑：
// 把"开头的偏移 + 对齐点"按跟随的规则（core/dub.ts 的 dubStep）摊开成两条音轨上的对应关系——
// 中文的哪一段在视频的哪一段放（色带）、哪里中文停下等画面 / 还没开始 / 已经放完（这时只有原声）、哪里的中文被跳过；
// 再给出此刻的位置与差距、全片还差多少的说法，以及刻度间隔。界面在 ui/sidepanel/DubAlignMap.tsx。
// 只是把已有的规则画出来：不改跟随的做法，不做、也不暗示逐句对齐。

import { DUB } from '../config/defaults';
import { dubSegmentAt, formatClockSec, formatSeconds, type DubMap, type DubSegment } from './dub';

/** 中文的 [d0, d1] 在视频的 [v0, v1] 放（一段里中文按正常速度放，所以两边一样长） */
export interface DubPiece {
  /** −1 = 开头那一段；k = 第 k 个对齐点（从 0 数）之后那一段 */
  segment: number;
  /** 这一段的偏移（视频位置 − 中文位置；正 = 中文比画面晚） */
  offset: number;
  v0: number;
  v1: number;
  d0: number;
  d1: number;
}

/** 视频的 [v0, v1] 这时没有中文、只有原声：还没开始 / 这一段中文说完了在等画面 / 中文已经放完 */
export type DubHoldKind = 'before-start' | 'wait' | 'after-end';

export interface DubHold {
  segment: number;
  kind: DubHoldKind;
  v0: number;
  v1: number;
}

/** 中文的 [d0, d1] 不会放到：开头的偏移让中文提前（head）/ 视频先到了下一个对齐点（cut）/ 视频放完时还没放到（tail） */
export type DubSkipKind = 'head' | 'cut' | 'tail';

export interface DubSkip {
  segment: number;
  kind: DubSkipKind;
  d0: number;
  d1: number;
  /** cut：视频先到的那个对齐点 */
  atVideo?: number;
}

export interface DubAlignment {
  videoDuration: number;
  /** 读不到中文时长时为空：最后一段一直放到视频结束 */
  dubDuration?: number;
  pieces: DubPiece[];
  holds: DubHold[];
  skips: DubSkip[];
}

const EPS = 0.01;

/**
 * 按跟随的规则摊开：每一段从 fromVideo 起，中文位置 = 视频位置 − 偏移；中文放到这一段的终点（下一个对齐点的中文位置）为止，
 * 先说完就停下等画面；视频先到了下一个对齐点就跳过去（没说完的那一点跳过）；最后一段放到中文结束或视频结束。
 */
export function dubAlignment(map: DubMap, videoDuration: number, dubDuration?: number): DubAlignment {
  const V = Math.max(0, videoDuration);
  const D = dubDuration !== undefined && Number.isFinite(dubDuration) && dubDuration > 0 ? dubDuration : undefined;
  const pieces: DubPiece[] = [];
  const holds: DubHold[] = [];
  const skips: DubSkip[] = [];
  const anchors = map.anchors;
  for (let i = -1; i < anchors.length; i++) {
    const a = i >= 0 ? anchors[i]! : undefined;
    const from = a ? a.video : 0;
    if (from >= V) break;
    const next = anchors[i + 1];
    const to = next ? Math.min(next.video, V) : V;
    const offset = a ? Number((a.video - a.dub).toFixed(2)) : map.delaySec;
    const end = next ? next.dub : undefined;
    // 这一段中文最多放到哪里：下一个对齐点的中文位置；中文本身的结尾（读得到时）
    const cap = end !== undefined ? (D !== undefined ? Math.min(end, D) : end) : D;
    const d0 = Math.max(0, from - offset);
    const v0 = d0 + offset;
    if (i < 0 && d0 > EPS) skips.push({ segment: i, kind: 'head', d0: 0, d1: d0 });
    if (v0 > from + EPS) holds.push({ segment: i, kind: 'before-start', v0: from, v1: Math.min(v0, to) });
    if (v0 >= to - EPS) continue;
    // 视频到这一段终点时，中文该在的位置
    const atTo = to - offset;
    const d1 = cap !== undefined ? Math.min(cap, atTo) : atTo;
    const v1 = d1 > d0 ? d1 + offset : v0;
    if (d1 > d0 + EPS) pieces.push({ segment: i, offset, v0, v1, d0, d1 });
    if (v1 < to - EPS) {
      // 中文先停了：停在下一个对齐点的中文位置（等画面），或者中文已经放完
      const waiting = end !== undefined && (D === undefined || end <= D) && d1 >= end - EPS;
      holds.push({ segment: i, kind: waiting ? 'wait' : 'after-end', v0: Math.max(v1, from), v1: to });
    }
    if (d1 >= atTo - EPS) {
      // 视频先到了这一段的终点：中文没说完的那一点不会放——到了下一个对齐点就跳过去（cut），视频放完了就是没放到（tail）
      if (next && next.video <= V + EPS && end !== undefined) {
        const stop = D !== undefined ? Math.min(end, D) : end;
        if (stop > d1 + EPS) skips.push({ segment: i, kind: 'cut', d0: d1, d1: stop, atVideo: next.video });
      } else if (D !== undefined && D > d1 + EPS) skips.push({ segment: i, kind: 'tail', d0: d1, d1: D });
    }
  }
  return { videoDuration: V, ...(D !== undefined ? { dubDuration: D } : {}), pieces, holds, skips: skips.filter((s) => s.d1 > s.d0 + EPS) };
}

export type DubPlanKind = 'playing' | DubHoldKind | 'ended';

/** 视频的 t 秒：按对齐此刻应放中文的哪里（停着等的时候是停在哪里） */
export interface DubPlan {
  kind: DubPlanKind;
  segment: DubSegment;
  /** 中文此刻在（或停在）的位置 */
  dub: number;
  /** 停着时：视频到这里中文再动（等画面 = 下一个对齐点；还没开始 = 中文开始的那一刻） */
  until?: number;
}

export function dubPlanAt(al: DubAlignment, map: DubMap, t: number): DubPlan {
  const segment = dubSegmentAt(map, t);
  const piece = al.pieces.find((p) => p.segment === segment.index);
  if (t >= al.videoDuration) return { kind: 'ended', segment, dub: piece ? piece.d1 : Math.max(0, t - segment.offset) };
  if (piece && t >= piece.v0 && t < piece.v1) return { kind: 'playing', segment, dub: piece.d0 + (t - piece.v0) };
  const hold = al.holds.find((h) => h.segment === segment.index && t >= h.v0 - EPS && t < h.v1);
  if (hold) {
    const dub = hold.kind === 'before-start' ? (piece?.d0 ?? Math.max(0, t - segment.offset)) : hold.kind === 'wait' ? (piece?.d1 ?? segment.dubEnd ?? 0) : (al.dubDuration ?? piece?.d1 ?? 0);
    return { kind: hold.kind, segment, dub, ...(hold.kind === 'after-end' ? {} : { until: hold.v1 }) };
  }
  // 边界上（正好在一段的起点）：按偏移算
  return { kind: 'playing', segment, dub: Math.max(0, t - segment.offset) };
}

// ── 说法 ──

const clock = formatClockSec;

/** 这一段中文比画面晚 / 早多少 */
export function gapText(offset: number): string {
  const o = Number(offset.toFixed(1)) || 0;
  if (o === 0) return '中文和画面同步';
  return o > 0 ? `中文比画面晚 ${formatSeconds(o)}` : `中文比画面早 ${formatSeconds(o)}`;
}

const segmentName = (index: number) => (index < 0 ? '开头那段' : `第 ${index + 1} 个对齐点之后`);

/** 此刻：两边各在哪里、差多少 */
export function alignNowText(plan: DubPlan, t: number): string {
  const at = `此刻：视频 ${clock(t)}`;
  switch (plan.kind) {
    case 'playing':
      return `${at} ↔ 中文 ${clock(plan.dub)}，${gapText(plan.segment.offset)}`;
    case 'wait':
      return `${at}，中文这一段已经说完、停在 ${clock(plan.dub)} 等画面（只有原声），视频到 ${clock(plan.until ?? t)} 的对齐点再接着放`;
    case 'before-start':
      return `${at}，中文还没开始：视频到 ${clock(plan.until ?? t)} 时从中文 ${clock(plan.dub)} 开始`;
    case 'after-end':
      return `${at}，中文已经放完（只有原声）`;
    case 'ended':
      return `${at}，视频放完了`;
  }
}

/**
 * 此刻的差距（秒，DECISIONS §78）：视频位置 − 中文位置，正 = 中文比画面晚。中文在放时就是这一段的偏移；
 * 中文停着（还没开始 / 停下等画面 / 已经放完）时，视频照常走、中文不动，差距随播放变大
 */
export function dubGapAt(plan: DubPlan, t: number): number {
  return t - plan.dub;
}

/** 差距读数下面那一行：差距的意思、两边各在哪里、停着时为什么在变 */
export function gapNoteText(plan: DubPlan, t: number): string {
  const gap = dubGapAt(plan, t);
  switch (plan.kind) {
    case 'playing':
      return `${gapText(gap)} · 视频 ${clock(t)} ↔ 中文 ${clock(plan.dub)}`;
    case 'wait':
      return `中文这一段已经说完、停在 ${clock(plan.dub)} 等画面（只有原声），差距随播放变大；视频到 ${clock(plan.until ?? t)} 的对齐点再接着放`;
    case 'before-start':
      return `中文还没开始（视频到 ${clock(plan.until ?? t)} 时从中文 ${clock(plan.dub)} 开始），差距随播放变大`;
    case 'after-end':
      return `中文已经放完（只有原声），差距随播放变大`;
    case 'ended':
      return '视频放完了';
  }
}

/**
 * 全片：照现在的对齐，中文在视频的哪一刻放完、后面还有多少只有原声（或者视频放完时中文还剩多少）。
 * 中文比视频短时再说全片差多少、现在的偏移和对齐点已经抵掉多少——剩下的要往后继续加对齐点
 */
export function alignOverallText(al: DubAlignment): string | undefined {
  const D = al.dubDuration;
  if (D === undefined) return undefined;
  const V = al.videoDuration;
  const last = al.holds[al.holds.length - 1];
  const tail = last && last.kind === 'after-end' && last.v1 >= V - EPS ? last : undefined;
  const unplayed = al.skips.find((s) => s.kind === 'tail');
  if (tail) {
    const rest = V - tail.v0;
    const total = V - D;
    const absorbed = total - rest;
    const sum =
      total > 1
        ? `全片中文短 ${formatSeconds(total)}${absorbed >= 1 ? `，开头的偏移和对齐点已经抵掉 ${formatSeconds(absorbed)}` : ''}，还差 ${formatSeconds(rest)}：往后在中英对不上的地方继续加对齐点。`
        : '';
    return `照现在的对齐，中文在视频 ${clock(tail.v0)} 放完，最后 ${formatSeconds(rest)}只有原声。${sum}`;
  }
  if (unplayed) return `照现在的对齐，视频放完时中文还剩 ${formatSeconds(unplayed.d1 - unplayed.d0)}没放到（中文 ${clock(unplayed.d0)} 起）。`;
  return '照现在的对齐，中文和视频差不多同时结束。';
}

/** 指着视频的 v 秒：这时听到的是什么 */
export function describeVideoAt(al: DubAlignment, v: number): string {
  if (v < 0 || v > al.videoDuration) return '';
  const p = al.pieces.find((x) => v >= x.v0 && v < x.v1);
  if (p) return `视频 ${clock(v)} ↔ 中文 ${clock(p.d0 + (v - p.v0))}（${segmentName(p.segment)}，${gapText(p.offset)}）`;
  const h = al.holds.find((x) => v >= x.v0 && v < x.v1);
  if (!h) return `视频 ${clock(v)}`;
  if (h.kind === 'wait') return `视频 ${clock(v)}：中文停下等画面，只有原声（${segmentName(h.segment)}的中文已经说完，视频到 ${clock(h.v1)} 的对齐点再接着放）`;
  if (h.kind === 'before-start') return `视频 ${clock(v)}：中文还没开始，只有原声（视频到 ${clock(h.v1)} 时中文才开始）`;
  return `视频 ${clock(v)}：中文已经放完，只有原声`;
}

/** 指着中文的 d 秒：它在视频的哪里放（或者为什么不放） */
export function describeDubAt(al: DubAlignment, d: number): string {
  if (d < 0 || (al.dubDuration !== undefined && d > al.dubDuration)) return '';
  const hits = al.pieces.filter((x) => d >= x.d0 && d < x.d1);
  if (hits.length) {
    const [first, ...again] = hits;
    const at = (p: DubPiece) => clock(p.v0 + (d - p.d0));
    return `中文 ${clock(d)} → 在视频 ${at(first!)} 放（${segmentName(first!.segment)}）${again.length ? `；又在视频 ${again.map(at).join('、')} 重放（对齐点前后颠倒）` : ''}`;
  }
  const s = al.skips.find((x) => d >= x.d0 && d < x.d1);
  if (s?.kind === 'cut') return `中文 ${clock(d)}：被跳过（这一段中文说得慢，视频先到了 ${clock(s.atVideo ?? 0)} 的对齐点）`;
  if (s?.kind === 'head') return `中文 ${clock(d)}：被跳过（开头的偏移让中文提前了）`;
  if (s?.kind === 'tail') return `中文 ${clock(d)}：视频放完时还没放到`;
  return `中文 ${clock(d)}：照现在的对齐不会放到`;
}

/** 刻度间隔（秒）：每格至少 minPx 像素 */
export function mapTickStep(pxPerSec: number, minPx: number = DUB.map.minTickPx): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  return steps.find((s) => s * pxPerSec >= minPx) ?? steps[steps.length - 1]!;
}

/** 两段里中文停下等（只有原声）与被跳过的总时长：图例里说 */
export function alignTotals(al: DubAlignment): { waitSec: number; skipSec: number } {
  return {
    waitSec: al.holds.filter((h) => h.kind === 'wait').reduce((n, h) => n + (h.v1 - h.v0), 0),
    skipSec: al.skips.filter((s) => s.kind === 'cut').reduce((n, s) => n + (s.d1 - s.d0), 0),
  };
}
