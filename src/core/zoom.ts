// 侧边栏整体缩放（用户 2026-11-16 要求，见 DECISIONS §80）的纯逻辑：档位、上一档 / 下一档、保存值的校正、
// Ctrl + 滚轮的累计。真正把缩放用到页面上、以及按钮和快捷键，在 ui/sidepanel/zoom.tsx。

import { UI_ZOOM } from '../config/defaults';

const LEVELS: readonly number[] = UI_ZOOM.levels;
export const ZOOM_MIN = LEVELS[0]!;
export const ZOOM_MAX = LEVELS[LEVELS.length - 1]!;

/** 保存的缩放值校正成一个能用的百分比：不是数字（旧设置里没有、被改坏）回到默认，超出范围的收回到两端 */
export function normalizeZoom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UI_ZOOM.default;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value)));
}

/** 放大（dir = 1）或缩小（dir = -1）一档；已经在两端时原样返回。当前值不在档位上（手改过设置）时走到相邻的那一档 */
export function stepZoom(current: number, dir: 1 | -1): number {
  const now = normalizeZoom(current);
  if (dir > 0) return LEVELS.find((l) => l > now) ?? ZOOM_MAX;
  return [...LEVELS].reverse().find((l) => l < now) ?? ZOOM_MIN;
}

export const canZoomIn = (current: number): boolean => normalizeZoom(current) < ZOOM_MAX;
export const canZoomOut = (current: number): boolean => normalizeZoom(current) > ZOOM_MIN;

/** 百分比 → CSS zoom 的倍数 */
export const zoomFactor = (percent: number): number => normalizeZoom(percent) / 100;

/** 界面上的写法：「110%」 */
export const zoomLabel = (percent: number): string => `${normalizeZoom(percent)}%`;

/** Ctrl + 滚轮的累计状态：攒够 UI_ZOOM.wheelStepPx 走一档，停顿之后零头作废 */
export interface WheelZoomState {
  /** 还没用掉的滚动量（像素，向下为正） */
  acc: number;
  /** 上一次滚动的时间 */
  at: number;
}

export const emptyWheelZoom = (): WheelZoomState => ({ acc: 0, at: 0 });

/**
 * 一次 Ctrl + 滚轮事件：返回要走的方向（向上滚 = 放大 = 1，向下滚 = 缩小 = -1，还没攒够 = 0）和新的累计状态。
 * deltaMode 1（按行，Firefox 的鼠标滚轮）和 2（按页）换算成像素；一次事件最多走一档，换方向时从头攒。
 */
export function wheelZoom(state: WheelZoomState, deltaY: number, deltaMode: number, now: number): { dir: 1 | -1 | 0; state: WheelZoomState } {
  if (!Number.isFinite(deltaY) || deltaY === 0) return { dir: 0, state };
  const px = deltaY * (deltaMode === 1 ? UI_ZOOM.wheelStepPx / 3 : deltaMode === 2 ? UI_ZOOM.wheelStepPx : 1);
  const stale = now - state.at > UI_ZOOM.wheelIdleMs || Math.sign(state.acc) === -Math.sign(px);
  const acc = (stale ? 0 : state.acc) + px;
  if (Math.abs(acc) < UI_ZOOM.wheelStepPx) return { dir: 0, state: { acc, at: now } };
  return { dir: acc < 0 ? 1 : -1, state: { acc: 0, at: now } };
}
