import { describe, expect, it } from 'vitest';
import { UI_ZOOM } from '../../src/config/defaults';
import { canZoomIn, canZoomOut, emptyWheelZoom, normalizeZoom, stepZoom, wheelZoom, ZOOM_MAX, ZOOM_MIN, zoomFactor, zoomLabel, type WheelZoomState } from '../../src/core/zoom';
import { mergeSettings } from '../../src/services/repo';

describe('侧边栏缩放：档位', () => {
  it('档位从小到大、不重复，包含默认的 100%，两端是 50% 和 200%', () => {
    const levels = [...UI_ZOOM.levels];
    expect(levels).toEqual([...new Set(levels)].sort((a, b) => a - b));
    expect(levels).toContain(UI_ZOOM.default);
    expect(UI_ZOOM.default).toBe(100);
    expect([ZOOM_MIN, ZOOM_MAX]).toEqual([50, 200]);
  });

  it('放大 / 缩小一次走一档', () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(110, 1)).toBe(125);
    expect(stepZoom(67, -1)).toBe(50);
    expect(stepZoom(175, 1)).toBe(200);
  });

  it('从最小一路放大到最大，再一路缩小回来，经过每一档', () => {
    const up: number[] = [ZOOM_MIN];
    while (canZoomIn(up[up.length - 1]!)) up.push(stepZoom(up[up.length - 1]!, 1));
    expect(up).toEqual([...UI_ZOOM.levels]);
    const down: number[] = [ZOOM_MAX];
    while (canZoomOut(down[down.length - 1]!)) down.push(stepZoom(down[down.length - 1]!, -1));
    expect(down).toEqual([...UI_ZOOM.levels].reverse());
  });

  it('到了两端不再变，按钮该变灰', () => {
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
    expect(canZoomIn(ZOOM_MAX)).toBe(false);
    expect(canZoomOut(ZOOM_MIN)).toBe(false);
    expect(canZoomIn(100) && canZoomOut(100)).toBe(true);
  });

  it('当前值不在档位上（手改过设置）时，走到相邻的那一档', () => {
    expect(stepZoom(95, 1)).toBe(100);
    expect(stepZoom(95, -1)).toBe(90);
    expect(stepZoom(130, 1)).toBe(150);
    expect(stepZoom(130, -1)).toBe(125);
  });
});

describe('侧边栏缩放：保存的值', () => {
  it('不是数字的回到 100%，超出范围的收回到两端，小数取整', () => {
    for (const bad of [undefined, null, 'big', NaN, Infinity, {}, true]) expect(normalizeZoom(bad)).toBe(100);
    expect(normalizeZoom(10)).toBe(50);
    expect(normalizeZoom(0)).toBe(50);
    expect(normalizeZoom(-80)).toBe(50);
    expect(normalizeZoom(1000)).toBe(200);
    expect(normalizeZoom(124.6)).toBe(125);
    expect(normalizeZoom(80)).toBe(80);
  });

  it('倍数与界面上的写法', () => {
    expect(zoomFactor(100)).toBe(1);
    expect(zoomFactor(67)).toBeCloseTo(0.67);
    expect(zoomFactor(200)).toBe(2);
    expect(zoomFactor(Number.NaN)).toBe(1);
    expect(zoomLabel(110)).toBe('110%');
    expect(zoomLabel(5000)).toBe('200%');
  });

  it('默认 100%；旧设置（没有 ui 分区、或 ui 里没有 zoom）也能读；存下的选择生效；存坏了的值校正', () => {
    expect(mergeSettings(undefined).ui.zoom).toBe(100);
    expect(mergeSettings({ quota: { searchDailyCalls: 50 } }).ui.zoom).toBe(100);
    expect(mergeSettings({ ui: { pinNav: true } }).ui).toEqual({ pinNav: true, zoom: 100 });
    expect(mergeSettings({ ui: { zoom: 75 } }).ui).toEqual({ pinNav: false, zoom: 75 });
    expect(mergeSettings({ ui: { zoom: 'huge' } }).ui.zoom).toBe(100);
    expect(mergeSettings({ ui: { zoom: 9999 } }).ui.zoom).toBe(200);
  });
});

describe('侧边栏缩放：Ctrl + 滚轮', () => {
  /** 依次喂一串滚轮事件，返回每次走的方向 */
  const feed = (events: [deltaY: number, at: number, mode?: number][]) => {
    let state: WheelZoomState = emptyWheelZoom();
    return events.map(([dy, at, mode]) => {
      const r = wheelZoom(state, dy, mode ?? 0, at);
      state = r.state;
      return r.dir;
    });
  };

  it('鼠标滚轮一格走一档：往上滚放大，往下滚缩小', () => {
    expect(feed([[-100, 1000]])).toEqual([1]);
    expect(feed([[100, 1000]])).toEqual([-1]);
    expect(
      feed([
        [-120, 1000],
        [-120, 1050],
        [120, 1100],
      ]),
    ).toEqual([1, 1, -1]);
  });

  it('触控板的细碎滚动攒够一格才走一档，走完从头攒', () => {
    expect(
      feed([
        [-30, 1000],
        [-30, 1020],
        [-30, 1040],
        [-30, 1060],
        [-30, 1080],
      ]),
    ).toEqual([0, 0, 0, 1, 0]);
  });

  it('一次事件最多走一档（再大的滚动量也是）', () => {
    expect(feed([[-900, 1000]])).toEqual([1]);
    expect(
      feed([
        [-900, 1000],
        [-10, 1010],
      ]),
    ).toEqual([1, 0]);
  });

  it('停顿之后，之前没攒够的零头作废', () => {
    expect(
      feed([
        [-60, 1000],
        [-60, 1000 + UI_ZOOM.wheelIdleMs + 1],
      ]),
    ).toEqual([0, 0]);
    expect(
      feed([
        [-60, 1000],
        [-60, 1000 + UI_ZOOM.wheelIdleMs],
      ]),
    ).toEqual([0, 1]);
  });

  it('中途换方向从头攒，不会用反方向的零头抵掉', () => {
    expect(
      feed([
        [-80, 1000],
        [60, 1010],
        [60, 1020],
      ]),
    ).toEqual([0, 0, -1]);
  });

  it('按行滚动（Firefox 的鼠标滚轮，一格 3 行）和按页滚动都换算成一档', () => {
    expect(feed([[-3, 1000, 1]])).toEqual([1]);
    expect(feed([[3, 1000, 1]])).toEqual([-1]);
    expect(
      feed([
        [1, 1000, 1],
        [1, 1010, 1],
        [1, 1020, 1],
      ]),
    ).toEqual([0, 0, -1]);
    expect(feed([[1, 1000, 2]])).toEqual([-1]);
  });

  it('没有纵向滚动量（横向滚动、坏数据）不动', () => {
    const start = emptyWheelZoom();
    expect(wheelZoom(start, 0, 0, 1000)).toEqual({ dir: 0, state: start });
    expect(wheelZoom(start, Number.NaN, 0, 1000)).toEqual({ dir: 0, state: start });
  });
});
