// 小红书的页面内助手（2026-11-03 新增，见 DECISIONS §40）。
// 运行在小红书页面自己的环境里（manifest 的 world: MAIN）：笔记的发布时间只在页面数据（window.__INITIAL_STATE__，
// 个人主页的笔记列表、笔记详情）里，普通内容脚本（隔离环境）看不到。
// 它只应答一种请求：把页面数据里每条笔记的 ID、在列表里的位置、标题、发布时间交给本扩展的小红书脚本。
// 不发网络请求、不碰页面元素、不读写 Cookie / 本地存储、不用任何扩展接口（构建时检查）。

import { XHS_BRIDGE_LIMITS, XHS_BRIDGE_OP, XHS_BRIDGE_TAG } from '../core/xhs-protocol';

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object';
const str = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined);

/** Vue 的 ref / 响应式代理：页面数据里的列表是 ref，取原始对象（不经过响应式代理，读取没有副作用） */
function unwrap(x: unknown): unknown {
  const v = isObj(x) && x.__v_isRef === true && '_rawValue' in x ? x._rawValue : x;
  return isObj(v) && isObj(v.__v_raw) ? v.__v_raw : v;
}

interface Entry {
  id?: string;
  index?: number;
  title?: string;
  time: number;
}

/**
 * 在页面数据里找带发布时间的笔记，认两种形状：
 * - 列表项 { id, index, noteCard: { noteId, displayTitle, time } }（个人主页）
 * - 笔记本身 { noteId, title, time }（笔记详情）
 */
function collect(): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (raw: unknown, depth: number): void => {
    const x = unwrap(raw);
    if (!isObj(x) || seen.has(x) || depth > XHS_BRIDGE_LIMITS.maxDepth || out.length >= XHS_BRIDGE_LIMITS.maxEntries) return;
    if (++nodes > XHS_BRIDGE_LIMITS.maxNodes) return;
    seen.add(x);
    if (Array.isArray(x)) {
      for (const v of x) visit(v, depth + 1);
      return;
    }
    const card = unwrap(x.noteCard);
    if (isObj(card) && typeof card.time === 'number') {
      out.push({ id: str(card.noteId) ?? str(x.id), index: typeof x.index === 'number' ? x.index : undefined, title: str(card.displayTitle) ?? str(card.title), time: card.time });
    } else if (typeof x.time === 'number' && typeof x.noteId === 'string') {
      out.push({ id: str(x.noteId), title: str(x.title) ?? str(x.displayTitle), time: x.time });
    }
    for (const k of Object.keys(x)) {
      // 不进 DOM 节点与函数；Vue 内部的依赖表也不走；已经读过的 noteCard 不再进去（免得同一条记两次）
      if (k === 'dep' || k === '__v_raw' || k === '_value' || (k === 'noteCard' && isObj(card) && typeof card.time === 'number')) continue;
      const v = x[k];
      if (isObj(v) && !(typeof Node !== 'undefined' && v instanceof Node)) visit(v, depth + 1);
    }
  };
  try {
    visit((window as unknown as { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__, 0);
  } catch {
    // 页面数据的结构变了：交回已经读到的部分
  }
  return out;
}

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const m = e.data as { tag?: unknown; dir?: unknown; id?: unknown; op?: unknown } | null;
  if (!m || m.tag !== XHS_BRIDGE_TAG || m.dir !== 'req' || typeof m.id !== 'number' || m.op !== XHS_BRIDGE_OP) return;
  const hasState = (window as unknown as { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__ !== undefined;
  window.postMessage({ tag: XHS_BRIDGE_TAG, dir: 'res', id: m.id, ok: true, data: { hasState, entries: collect() } }, location.origin);
});
