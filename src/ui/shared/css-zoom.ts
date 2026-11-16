// 侧边栏整体缩放（DECISIONS §80）之后，页面上有两种像素：
// getBoundingClientRect、鼠标事件的 clientX / clientY、window.scrollY 是缩放之后的视口像素；
// 写进 CSS（top、宽高、CSS 变量）和 SVG 属性的长度、ResizeObserver 的 contentRect 是缩放之前的。
// 两边换算都除以 / 乘以这个倍数。

/**
 * 元素此刻受到的 CSS zoom 倍数（没缩放时 1）。
 * 读不到 currentCSSZoom 的旧浏览器按 1 算：那些浏览器的 getBoundingClientRect 本来就不含缩放，正好不用换算。
 */
export function cssZoomOf(el: Element | null | undefined): number {
  const z = (el as (Element & { currentCSSZoom?: number }) | null | undefined)?.currentCSSZoom;
  return typeof z === 'number' && z > 0 ? z : 1;
}
