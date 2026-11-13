// 对齐图（用户 2026-11-13 手测后要求，见 DECISIONS §77）：用两条音轨画出英文原声与中文配音此刻的对齐状态，随播放与对齐实时更新。
// 「全片」：两条按各自的时间、同一个比例画——中文短，所以短一截；色带把同时听到的两处连起来，越往后斜得越厉害；
//   看得出照现在的对齐中文在视频哪里放完、后面还有多少只有原声。
// 「附近」：播放头前后一小段放大；下面的中文按这一段的偏移错开画，竖着对上的就是同时听到的；
//   斜纹 = 这时只有原声（中文还没开始 / 停下等画面 / 已经放完），红斜纹 = 被跳过的中文；每条色带上写着那一段差多少。
//   左右拖下面的中文 = 调这一段的偏移（和"中文位置"滑块一样：拖动时实时生效，松手后存下）。
// 只画跟随本来的规则（core/dub-align.ts，和 dubStep 逐点对照过），不做、也不暗示逐句对齐。

import type { RefObject } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DUB } from '../../config/defaults';
import { clampDelay, formatClockSec, formatSeconds, type DubMap } from '../../core/dub';
import {
  alignNowText,
  alignOverallText,
  alignTotals,
  describeDubAt,
  describeVideoAt,
  dubAlignment,
  dubPlanAt,
  mapTickStep,
  type DubAlignment,
  type DubPlan,
} from '../../core/dub-align';

export interface DubAlignMapProps {
  map: DubMap;
  videoDuration?: number;
  dubDuration?: number;
  /** 最近一次读到的视频位置，和读到它的时刻（performance.now()） */
  videoTime?: number;
  stamp: number;
  /** 视频在放：两次读位置之间按倍速把播放头往前推 */
  playing: boolean;
  rate: number;
  /** 侧边栏此刻在调的那一段（拖动只在图上的"这一段"就是它时可用） */
  segment: number;
  /** 拖下面的中文：拖动中（实时生效）/ 松手（存下） */
  onPreview?: (offset: number) => void;
  onCommit?: (offset: number) => void;
}

/** 左边写"英文 / 中文"的那一栏、右边留白（像素） */
const GUTTER = 30;
const RIGHT = 6;
/** 「全片」：上条、色带、下条的纵向位置 */
const O = { enY: 4, barH: 8, zhY: 34, h: 46 };
/** 「附近」：上刻度、上条、色带、下条、下刻度 */
const N = { rulerTop: 10, enY: 15, barH: 22, zhY: 79, rulerBottom: 113, h: 118 };
const RIB_MID = (N.enY + N.barH + N.zhY) / 2;

let instances = 0;

const signed = (x: number) => {
  const r = Number(x.toFixed(1)) || 0;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)} 秒`;
};
const parity = (segment: number) => (segment % 2 === 0 ? 'even' : 'odd');

/** 视频此刻的位置：读到的位置 + 之后按倍速走过的时间（视频在放时；最多推 extrapolateMaxSec 秒） */
function usePlayhead(p: Pick<DubAlignMapProps, 'videoTime' | 'stamp' | 'playing' | 'rate'>, videoDuration: number): number | undefined {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!p.playing) return;
    let raf = 0;
    const loop = () => {
      setNow(performance.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [p.playing]);
  if (p.videoTime === undefined) return undefined;
  const ran = p.playing ? Math.min(DUB.map.extrapolateMaxSec, Math.max(0, (now - p.stamp) / 1000)) * (p.rate > 0 ? p.rate : 1) : 0;
  return Math.min(videoDuration, p.videoTime + ran);
}

function useWidth(): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.max(200, Math.round(el.getBoundingClientRect().width)));
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(200, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** 斜纹：只有原声（还没开始 / 等画面）、中文已经放完、被跳过的中文 */
function Hatches({ id }: { id: string }) {
  const one = (name: string) => (
    <pattern id={`${id}-${name}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" class={`hatch-bg ${name}`} />
      <line x1="0" y1="0" x2="0" y2="6" class={`hatch ${name}`} />
    </pattern>
  );
  return (
    <>
      {one('hold')}
      {one('end')}
      {one('skip')}
    </>
  );
}

const holdFill = (id: string, kind: string) => `url(#${id}-${kind === 'after-end' ? 'end' : 'hold'})`;

/** 「全片」：两条都从 0 画、同一个比例 */
function Overview({ al, map, plan, t, width, windowSec, id }: { al: DubAlignment; map: DubMap; plan?: DubPlan; t?: number; width: number; windowSec: number; id: string }) {
  const plotW = width - GUTTER - RIGHT;
  const D = al.dubDuration;
  const s = plotW / Math.max(al.videoDuration, D ?? 0, 1);
  const x = (sec: number) => GUTTER + sec * s;
  const enB = O.enY + O.barH;
  const zhEnd = D ?? Math.max(0, ...al.pieces.map((p) => p.d1));
  return (
    <svg class="dub-map-svg" width={width} height={O.h} data-testid="dub-map-overview" aria-hidden="true">
      <defs>
        <Hatches id={id} />
      </defs>
      <text x={2} y={O.enY + 7} class="dub-map-lbl">
        英文
      </text>
      <text x={2} y={O.zhY + 7} class="dub-map-lbl">
        中文
      </text>
      <rect class="dub-map-bar en" x={GUTTER} y={O.enY} width={al.videoDuration * s} height={O.barH} />
      <rect class={`dub-map-bar zh${D === undefined ? ' open' : ''}`} x={GUTTER} y={O.zhY} width={zhEnd * s} height={O.barH} />
      {al.pieces.map((p) => (
        <polygon class={`dub-map-rib ${parity(p.segment)}${plan && p.segment === plan.segment.index ? ' cur' : ''}`} points={`${x(p.v0)},${enB} ${x(p.v1)},${enB} ${x(p.d1)},${O.zhY} ${x(p.d0)},${O.zhY}`} />
      ))}
      {al.pieces.map((p) => (
        <>
          <rect class="dub-map-en-on" x={x(p.v0)} y={O.enY} width={Math.max(0.5, (p.v1 - p.v0) * s)} height={O.barH} />
          <rect class={`dub-map-zh-on ${parity(p.segment)}`} x={x(p.d0)} y={O.zhY} width={Math.max(0.5, (p.d1 - p.d0) * s)} height={O.barH} />
        </>
      ))}
      {al.holds.map((h) => (
        <rect data-testid="dub-map-hold" data-kind={h.kind} fill={holdFill(id, h.kind)} x={x(h.v0)} y={O.enY} width={Math.max(0.5, (h.v1 - h.v0) * s)} height={O.barH} />
      ))}
      {al.skips.map((k) => (
        <rect data-testid="dub-map-skip" data-kind={k.kind} fill={`url(#${id}-skip)`} x={x(k.d0)} y={O.zhY} width={Math.max(0.5, (k.d1 - k.d0) * s)} height={O.barH} />
      ))}
      {map.anchors.map((a) => (
        <line class="dub-map-anchor-tick" data-testid="dub-map-overview-anchor" x1={x(a.video)} y1={O.enY - 2} x2={x(a.video)} y2={enB} />
      ))}
      {t !== undefined && (
        <rect class="dub-map-window" x={x(Math.max(0, t - windowSec / 2))} y={O.enY - 3} width={Math.max(2, (Math.min(al.videoDuration, t + windowSec / 2) - Math.max(0, t - windowSec / 2)) * s)} height={O.barH + 6} />
      )}
      {t !== undefined && plan && (
        <g class="dub-map-ph">
          <line x1={x(t)} y1={O.enY - 3} x2={x(t)} y2={enB} />
          <line class="link" x1={x(t)} y1={enB} x2={x(plan.dub)} y2={O.zhY} />
          <line x1={x(plan.dub)} y1={O.zhY} x2={x(plan.dub)} y2={O.zhY + O.barH + 3} />
        </g>
      )}
    </svg>
  );
}

interface Hover {
  x: number;
  y: number;
}

/** 「附近」：播放头在正中；下面的中文按这一段的偏移错开画 */
function Nearby(props: {
  al: DubAlignment;
  map: DubMap;
  plan?: DubPlan;
  t?: number;
  width: number;
  windowSec: number;
  id: string;
  canDrag: boolean;
  onHover: (h: Hover | undefined) => void;
  hover?: Hover;
  onPreview?: (offset: number) => void;
  onCommit?: (offset: number) => void;
}) {
  const { al, map, plan, width, windowSec, id } = props;
  const t = props.t ?? 0;
  const plotW = width - GUTTER - RIGHT;
  const s = plotW / windowSec;
  const start = t - windowSec / 2;
  const shift = plan ? plan.segment.offset : 0;
  const xt = (v: number) => GUTTER + (v - start) * s;
  const xb = (d: number) => GUTTER + (d + shift - start) * s;
  const V = al.videoDuration;
  const D = al.dubDuration;
  const enB = N.enY + N.barH;
  const zhB = N.zhY + N.barH;
  const lo = GUTTER - 40;
  const hi = GUTTER + plotW + 40;
  const seen = (a: number, b: number) => b >= lo && a <= hi;
  /** 字放在 x 处会不会被图边切掉 */
  const fits = (x: number, half = 16) => x - half >= GUTTER && x + half <= GUTTER + plotW;
  const step = mapTickStep(s);
  const centerX = xt(t);
  const dubX = plan ? xb(plan.dub) : centerX;
  const drag = useRef<{ x0: number; off0: number; last: number; sent: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const ticks = (from: number, to: number, max: number | undefined) => {
    const out: number[] = [];
    for (let k = Math.ceil(Math.max(0, from) / step) * step; k <= to && (max === undefined || k <= max + 1e-6); k += step) out.push(k);
    return out;
  };
  const local = (e: PointerEvent) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const finish = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;
    if (commit && d.last !== d.off0) props.onCommit?.(d.last);
    else if (!commit && d.sent !== d.off0) props.onPreview?.(d.off0);
  };

  return (
    <svg
      class={`dub-map-svg nearby${props.canDrag ? ' can-drag' : ''}${dragging ? ' dragging' : ''}`}
      width={width}
      height={N.h}
      data-testid="dub-map-detail"
      aria-hidden="true"
      onPointerMove={(e) => {
        const p = local(e);
        const d = drag.current;
        if (d) {
          const off = clampDelay(d.off0 + (p.x - d.x0) / s);
          if (off !== d.last) {
            d.last = off;
            d.sent = off;
            props.onPreview?.(off);
          }
          return;
        }
        props.onHover(p);
      }}
      onPointerLeave={() => !drag.current && props.onHover(undefined)}
      onPointerDown={(e) => {
        const p = local(e);
        if (!props.canDrag || p.y < RIB_MID || e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
        drag.current = { x0: p.x, off0: shift, last: shift, sent: shift };
        setDragging(true);
        props.onHover(undefined);
      }}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => drag.current && finish(true)}
    >
      <defs>
        <Hatches id={id} />
        <clipPath id={`${id}-clip`}>
          <rect x={GUTTER} y={0} width={plotW} height={N.h} />
        </clipPath>
      </defs>
      <text x={2} y={N.enY + 15} class="dub-map-lbl">
        英文
      </text>
      <text x={2} y={N.zhY + 15} class="dub-map-lbl">
        中文
      </text>
      <g clip-path={`url(#${id}-clip)`}>
        {/* 刻度：上面是视频的时间，下面是中文的时间 */}
        {ticks(start, start + windowSec, V).map((k) => (
          <>
            <line class="dub-map-tick" x1={xt(k)} y1={N.enY - 3} x2={xt(k)} y2={N.enY} />
            {Math.abs(xt(k) - centerX) > 30 && fits(xt(k), 12) && (
              <text class="dub-map-tick-lbl" x={xt(k)} y={N.rulerTop - 2} text-anchor="middle">
                {formatClockSec(k)}
              </text>
            )}
          </>
        ))}
        {ticks(start - shift, start - shift + windowSec, D).map((k) => (
          <>
            <line class="dub-map-tick" x1={xb(k)} y1={zhB} x2={xb(k)} y2={zhB + 3} />
            {Math.abs(xb(k) - dubX) > 30 && fits(xb(k), 12) && (
              <text class="dub-map-tick-lbl" x={xb(k)} y={N.rulerBottom} text-anchor="middle">
                {formatClockSec(k)}
              </text>
            )}
          </>
        ))}
        <rect class="dub-map-bar en" x={xt(0)} y={N.enY} width={V * s} height={N.barH} />
        <rect class={`dub-map-bar zh${D === undefined ? ' open' : ''}`} x={xb(0)} y={N.zhY} width={(D ?? Math.max(0, ...al.pieces.map((p) => p.d1))) * s} height={N.barH} />
        {al.pieces
          .filter((p) => seen(xt(p.v0), xt(p.v1)) || seen(xb(p.d0), xb(p.d1)))
          .map((p) => {
            const cur = plan && p.segment === plan.segment.index;
            const mid = (xt(p.v0) + xt(p.v1) + xb(p.d0) + xb(p.d1)) / 4;
            const wide = (p.v1 - p.v0) * s >= DUB.map.labelMinPx;
            return (
              <>
                <polygon class={`dub-map-rib ${parity(p.segment)}${cur ? ' cur' : ''}`} points={`${xt(p.v0)},${enB} ${xt(p.v1)},${enB} ${xb(p.d1)},${N.zhY} ${xb(p.d0)},${N.zhY}`} />
                <rect class="dub-map-en-on" x={xt(p.v0)} y={N.enY} width={(p.v1 - p.v0) * s} height={N.barH} />
                <rect class={`dub-map-zh-on ${parity(p.segment)}${cur ? ' cur' : ''}`} x={xb(p.d0)} y={N.zhY} width={(p.d1 - p.d0) * s} height={N.barH} />
                {wide && !cur && fits(mid, 24) && (
                  <text class="dub-map-rib-lbl" data-testid="dub-map-gap" x={mid} y={RIB_MID + 4} text-anchor="middle">
                    {signed(p.offset)}
                  </text>
                )}
              </>
            );
          })}
        {al.holds
          .filter((h) => seen(xt(h.v0), xt(h.v1)))
          .map((h) => (
            <>
              <rect data-testid="dub-map-detail-hold" data-kind={h.kind} fill={holdFill(id, h.kind)} x={xt(h.v0)} y={N.enY} width={(h.v1 - h.v0) * s} height={N.barH} />
              {(h.v1 - h.v0) * s >= DUB.map.labelMinPx && (
                <text class="dub-map-in-lbl" x={(Math.max(xt(h.v0), GUTTER) + Math.min(xt(h.v1), GUTTER + plotW)) / 2} y={N.enY + 15} text-anchor="middle">
                  {h.kind === 'wait' ? `原声 ${formatSeconds(h.v1 - h.v0)}` : h.kind === 'before-start' ? '中文未开始' : '中文已放完'}
                </text>
              )}
            </>
          ))}
        {al.skips
          .filter((k) => seen(xb(k.d0), xb(k.d1)))
          .map((k) => (
            <>
              <rect data-testid="dub-map-detail-skip" data-kind={k.kind} fill={`url(#${id}-skip)`} x={xb(k.d0)} y={N.zhY} width={(k.d1 - k.d0) * s} height={N.barH} />
              {(k.d1 - k.d0) * s >= DUB.map.labelMinPx && (
                <text class="dub-map-in-lbl skip" x={(Math.max(xb(k.d0), GUTTER) + Math.min(xb(k.d1), GUTTER + plotW)) / 2} y={N.zhY + 15} text-anchor="middle">
                  跳过 {formatSeconds(k.d1 - k.d0)}
                </text>
              )}
            </>
          ))}
        {/* 对齐点：视频这一刻 ↔ 中文这一刻，编号和下面的列表一样 */}
        {map.anchors.map((a, k) =>
          seen(xt(a.video), xt(a.video)) || seen(xb(a.dub), xb(a.dub)) ? (
            <g class="dub-map-anchor" data-testid="dub-map-anchor">
              <line x1={xt(a.video)} y1={N.enY} x2={xt(a.video)} y2={enB} />
              <line class="link" x1={xt(a.video)} y1={enB} x2={xb(a.dub)} y2={N.zhY} />
              <line x1={xb(a.dub)} y1={N.zhY} x2={xb(a.dub)} y2={zhB} />
              <circle cx={(xt(a.video) + xb(a.dub)) / 2} cy={RIB_MID} r={7} />
              <text x={(xt(a.video) + xb(a.dub)) / 2} y={RIB_MID + 3} text-anchor="middle">
                {k + 1}
              </text>
            </g>
          ) : null,
        )}
        {props.hover && !dragging && (
          <line class="dub-map-hover-line" x1={props.hover.x} y1={props.hover.y < RIB_MID ? N.enY - 2 : N.zhY} x2={props.hover.x} y2={props.hover.y < RIB_MID ? enB : zhB + 2} />
        )}
        {props.t !== undefined && plan && (
          <g class="dub-map-ph" data-testid="dub-map-playhead">
            <line x1={centerX} y1={N.enY - 3} x2={centerX} y2={enB} />
            <line class={`link${plan.kind === 'playing' ? '' : ' held'}`} x1={centerX} y1={enB} x2={dubX} y2={N.zhY} />
            <line x1={dubX} y1={N.zhY} x2={dubX} y2={zhB + 3} />
            <text class="dub-map-rib-lbl cur" data-testid="dub-map-now-gap" x={centerX + 7} y={enB + 11}>
              {plan.kind === 'playing' ? signed(plan.segment.offset) : plan.kind === 'wait' ? '中文停下等' : plan.kind === 'before-start' ? '中文未开始' : plan.kind === 'after-end' ? '中文已放完' : ''}
            </text>
            <rect class="chip" x={centerX - 22} y={0} width={44} height={12} rx={3} />
            <text class="chip-lbl" x={centerX} y={9} text-anchor="middle">
              {formatClockSec(t)}
            </text>
            <rect class="chip" x={dubX - 22} y={N.rulerBottom - 9} width={44} height={12} rx={3} />
            <text class="chip-lbl" x={dubX} y={N.rulerBottom} text-anchor="middle">
              {formatClockSec(plan.dub)}
            </text>
          </g>
        )}
      </g>
      {/* 下面那条（中文）是拖动区 */}
      <rect class="dub-map-drag" data-testid="dub-map-zh" x={GUTTER} y={RIB_MID} width={plotW} height={N.h - RIB_MID} />
    </svg>
  );
}

export function DubAlignMap(props: DubAlignMapProps) {
  const [box, width] = useWidth();
  const [zoom, setZoom] = useState<number>(DUB.map.defaultZoomSec);
  const [hover, setHover] = useState<Hover>();
  const id = useMemo(() => `dubmap${++instances}`, []);
  const V = props.videoDuration;
  const al = useMemo(() => (V ? dubAlignment(props.map, V, props.dubDuration) : undefined), [props.map, V, props.dubDuration]);
  const t = usePlayhead(props, V ?? 0);
  // 读不到位置时（广告中）停在上次的位置
  const lastT = useRef<number>();
  if (t !== undefined) lastT.current = t;
  const at = t ?? lastT.current;
  if (!V || !al) {
    return (
      <div class="dub-map" data-testid="dub-map">
        <p class="muted small">读到视频的时长后显示对齐图。</p>
      </div>
    );
  }
  const plan = at !== undefined ? dubPlanAt(al, props.map, at) : undefined;
  const now = plan && at !== undefined ? alignNowText(plan, at) : '读不到视频此刻的位置（正在放广告？）';
  const overall = alignOverallText(al);
  const totals = alignTotals(al);
  const canDrag = !!props.onCommit && !!plan && plan.segment.index === props.segment && plan.kind !== 'ended';
  const plotW = width - GUTTER - RIGHT;
  let hoverText: string | undefined;
  if (hover && at !== undefined && hover.x >= GUTTER && hover.x <= GUTTER + plotW) {
    const sec = (hover.x - GUTTER) / (plotW / zoom) + at - zoom / 2;
    hoverText = hover.y < RIB_MID ? describeVideoAt(al, sec) : describeDubAt(al, sec - (plan?.segment.offset ?? 0));
  }
  return (
    <div class="dub-map" data-testid="dub-map" ref={box}>
      <div class="row dub-map-head">
        <strong>对齐图</strong>
        <span class="muted small">
          英文 {formatClockSec(V)} · 中文 {props.dubDuration ? formatClockSec(props.dubDuration) : '时长未知'}
        </span>
      </div>
      <p class="dub-map-now" data-testid="dub-map-now" aria-live="polite">
        {now}
      </p>
      {overall && (
        <p class="muted small dub-map-overall" data-testid="dub-map-overall">
          {overall}
        </p>
      )}
      <div class="dub-map-sub muted small">全片（两条按各自的时间画，同一个比例）</div>
      <Overview al={al} map={props.map} {...(plan ? { plan } : {})} {...(at !== undefined ? { t: at } : {})} width={width} windowSec={zoom} id={`${id}o`} />
      <div class="row dub-map-sub">
        <span class="muted small">附近（中文按这一段的偏移错开画，竖着对上的是同时听到的）</span>
        <span class="dub-map-zoom" role="group" aria-label="附近显示多长">
          {DUB.map.zoomsSec.map((z) => (
            <button class={`btn small${z === zoom ? ' on' : ''}`} data-testid="dub-map-zoom" aria-pressed={z === zoom} onClick={() => setZoom(z)}>
              {z < 60 ? `${z} 秒` : `${z / 60} 分`}
            </button>
          ))}
        </span>
      </div>
      <Nearby
        al={al}
        map={props.map}
        {...(plan ? { plan } : {})}
        {...(at !== undefined ? { t: at } : {})}
        width={width}
        windowSec={zoom}
        id={`${id}n`}
        canDrag={canDrag}
        onHover={setHover}
        {...(hover ? { hover } : {})}
        {...(props.onPreview ? { onPreview: props.onPreview } : {})}
        {...(props.onCommit ? { onCommit: props.onCommit } : {})}
      />
      <p class="muted small dub-map-hover" data-testid="dub-map-hover">
        {hoverText || (
          <>
            <span class="dub-map-key rib" />
            色带：同时听到的两处，上面写着那一段中文比画面晚 / 早多少
            <span class="dub-map-key hold" />
            只有原声（中文还没开始 / 停下等画面{totals.waitSec >= 1 ? `，共 ${formatSeconds(totals.waitSec)}` : ''}）
            <span class="dub-map-key end" />
            中文已放完
            <span class="dub-map-key skip" />
            被跳过的中文{totals.skipSec >= 1 ? `（共 ${formatSeconds(totals.skipSec)}）` : ''}
            {canDrag ? ' · 左右拖下面的中文：调这一段的偏移' : ''}
          </>
        )}
      </p>
    </div>
  );
}
