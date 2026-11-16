// 侧边栏整体缩放（用户 2026-11-16 要求，见 DECISIONS §80）：头部、导航栏和各页内容一起放大 / 缩小。
// 做法是在根元素上设 CSS zoom——样式里的尺寸全是 px，zoom 让它们按同一个倍数缩放并重新排版（不出现横向滚动条）。
// 入口：头部品牌名下面的「− 100% +」，Ctrl（Mac 上 ⌘）加 + / − / 0，Ctrl + 滚轮。档位与校正在 core/zoom.ts。
// 选的档位存在设置的 ui.zoom 里：重新打开后保留，多个窗口的侧边栏同步，随设置导出、随"清空"复位。

import { useEffect, useRef, useState } from 'preact/hooks';
import { UI_ZOOM } from '../../config/defaults';
import { canZoomIn, canZoomOut, emptyWheelZoom, normalizeZoom, stepZoom, wheelZoom, zoomFactor, zoomLabel } from '../../core/zoom';
import { stores } from '../../services/repo';
import { appCtx } from '../shared/app';

/** 连按 / 连滚时只在停下来之后存一次（毫秒） */
const SAVE_DELAY_MS = 200;

/** 把缩放用到整个侧边栏页面上（根元素）。100% 时去掉这条样式，和没有这个功能时完全一样 */
export function applyZoom(percent: number): void {
  const root = document.documentElement;
  const f = zoomFactor(percent);
  if (f === 1) root.style.removeProperty('zoom');
  else root.style.setProperty('zoom', String(f));
}

/** 吸顶的头部（和固定并吸附着的导航栏）下沿在视口里的位置：这条线以下才是会随页面滚动的内容 */
function stickyBottom(): number {
  const header = document.querySelector('header.top')?.getBoundingClientRect().bottom ?? 0;
  const nav = document.querySelector('.tabs.pinned.stuck')?.getBoundingClientRect().bottom ?? 0;
  return Math.max(0, header, nav);
}

interface ScrollAnchor {
  el: Element;
  /** 锚点在这个元素高度上的比例（0 = 顶，1 = 底）：缩放后文字重新折行、高度变了，也落回同一处 */
  frac: number;
}

/** 视口高度 y 处的内容元素；那里是吸顶的头部 / 导航栏、或什么都没有时不设锚点 */
function pickAnchor(x: number, y: number): ScrollAnchor | undefined {
  const el = document.elementFromPoint(x, y);
  if (!el || el === document.documentElement || el === document.body || el.closest('header.top, .tabs.pinned')) return undefined;
  const r = el.getBoundingClientRect();
  return { el, frac: r.height > 0 ? Math.min(1, Math.max(0, (y - r.top) / r.height)) : 0 };
}

/**
 * 换一档缩放，并让正在看的内容留在原处：
 * at 给了（Ctrl + 滚轮时的鼠标位置）就让鼠标下面那一处不动；没给就让紧贴头部 / 导航栏下面的那一处不动。
 * 页面在最顶上时不动滚动位置。
 */
function zoomKeepingPlace(next: number, at?: { x: number; y: number }): void {
  const pointer = at ? pickAnchor(at.x, at.y) : undefined;
  const line = stickyBottom() + 1;
  const anchor = window.scrollY > 0 ? (pointer ?? pickAnchor(window.innerWidth / 2, line)) : undefined;
  applyZoom(next);
  if (!anchor || !anchor.el.isConnected) return;
  // 读位置会让浏览器按新的缩放排好版；同一轮里改滚动位置，中间不会画出跳动的一帧
  const r = anchor.el.getBoundingClientRect();
  const target = pointer && at ? at.y : stickyBottom() + 1;
  window.scrollBy({ top: r.top + anchor.frac * r.height - target, behavior: 'instant' });
}

export interface ZoomState {
  /** 当前档位（百分比） */
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

/**
 * 缩放状态与快捷键。stored 是设置里存的值（还没读到时 undefined），initial 是页面画出来之前已经用上的值。
 * 本页刚改的值立刻生效、稍后存；存好之前不理会存储里的旧值（免得连按时闪回去）。别的窗口改了设置，这里跟着变。
 */
export function useZoom(stored: number | undefined, initial: number): ZoomState {
  const [zoom, setZoom] = useState(initial);
  /** 最新的档位：连按 / 连滚时不等重新渲染 */
  const live = useRef(initial);
  const saving = useRef<{ timer?: ReturnType<typeof setTimeout>; writes: number }>({ writes: 0 });
  const wheel = useRef(emptyWheelZoom());

  const show = (next: number, at?: { x: number; y: number }) => {
    if (next === live.current) return;
    live.current = next;
    zoomKeepingPlace(next, at);
    setZoom(next);
  };
  const change = (next: number, at?: { x: number; y: number }) => {
    if (next === live.current) return;
    show(next, at);
    const s = saving.current;
    if (s.timer !== undefined) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = undefined;
      s.writes++;
      const value = live.current;
      void stores.settings
        .update(appCtx().kv, appCtx().locker, (cur) => ({ ...cur, ui: { ...cur.ui, zoom: value } }))
        // 存不上（存储满了之类）不影响这一次的缩放，只是下次打开回到上一次存下的档位
        .catch((e: unknown) => console.warn('[TubeMuse] 缩放档位没有存下', e))
        .finally(() => {
          s.writes--;
        });
    }, SAVE_DELAY_MS);
  };
  // 一直指向最新一次渲染的函数：下面的监听只装一次
  const act = useRef({ change });
  act.current = { change };

  useEffect(() => {
    const s = saving.current;
    if (stored === undefined || s.timer !== undefined || s.writes > 0) return;
    show(normalizeZoom(stored));
  }, [stored]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const dir = e.key === '+' || e.key === '=' ? 1 : e.key === '-' || e.key === '_' ? -1 : e.key === '0' ? 0 : undefined;
      if (dir === undefined) return;
      // 自己处理了就不再交给浏览器：免得浏览器另外再缩放一次
      e.preventDefault();
      act.current.change(dir === 0 ? UI_ZOOM.default : stepZoom(live.current, dir));
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = wheelZoom(wheel.current, e.deltaY, e.deltaMode, Date.now());
      wheel.current = r.state;
      if (r.dir !== 0) act.current.change(stepZoom(live.current, r.dir), { x: e.clientX, y: e.clientY });
    };
    window.addEventListener('keydown', onKey);
    // passive: false——要拦下浏览器自己的 Ctrl + 滚轮缩放
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onWheel);
    };
  }, []);

  return {
    zoom,
    zoomIn: () => change(stepZoom(live.current, 1)),
    zoomOut: () => change(stepZoom(live.current, -1)),
    reset: () => change(UI_ZOOM.default),
  };
}

/** 快捷键提示里的修饰键：Mac 上是 ⌘ */
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/** 头部品牌名下面的「− 100% +」：缩小 / 当前档位（点一下恢复 100%）/ 放大 */
export function ZoomControl({ state }: { state: ZoomState }) {
  const { zoom } = state;
  const changed = zoom !== UI_ZOOM.default;
  return (
    <div class="zoom" role="group" aria-label="侧边栏缩放" data-testid="zoom" data-zoom={zoom}>
      <button class="zoom-step" title={`缩小：字变小，一屏看到更多（${MOD}−，或 Ctrl+滚轮）`} aria-label="缩小侧边栏" disabled={!canZoomOut(zoom)} data-testid="zoom-out" onClick={state.zoomOut}>
        −
      </button>
      <button
        class={`zoom-level${changed ? ' changed' : ''}`}
        title={changed ? `现在 ${zoomLabel(zoom)}，点一下恢复 ${zoomLabel(UI_ZOOM.default)}（${MOD}0）` : `侧边栏缩放：现在 ${zoomLabel(zoom)}（默认）`}
        aria-label={`侧边栏缩放 ${zoomLabel(zoom)}${changed ? `，点一下恢复 ${zoomLabel(UI_ZOOM.default)}` : ''}`}
        data-testid="zoom-reset"
        onClick={state.reset}
      >
        {zoomLabel(zoom)}
      </button>
      <button class="zoom-step" title={`放大：看清某一处（${MOD}+，或 Ctrl+滚轮）`} aria-label="放大侧边栏" disabled={!canZoomIn(zoom)} data-testid="zoom-in" onClick={state.zoomIn}>
        +
      </button>
    </div>
  );
}
