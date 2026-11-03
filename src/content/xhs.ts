// 小红书网页版的页面脚本（2026-11-03 新增，见 DECISIONS §40）。
// 1. 发布时间：笔记卡片作者那一行（作者名与点赞数之间）、笔记详情的日期旁。不给卡片加新行——
//    小红书的瀑布流按预先算好的高度摆放卡片（2026-11-03 实测），卡片变高就会压住下面那张。
// 2. 收藏与标签：卡片封面左下角（悬停时出现，收藏后常驻）、博主主页名字旁、笔记详情"关注"旁各一个按钮，
//    点开后收藏笔记 / 博主、加减标签。写入经扩展后台校验；收藏只存在本机。
// 红线：不发任何网络请求、不读写 Cookie、不点击小红书自己的任何按钮（不会替你收藏、点赞、关注），
// 写页面只用 createElement + textContent（构建时检查）。发布时间来自页面数据（经页面内助手 xhs-bridge）或笔记 ID。

import { DEFAULT_SETTINGS, XHS } from '../config/defaults';
import { XHS_BRIDGE_OP, XHS_BRIDGE_TAG } from '../core/xhs-protocol';
import {
  XHS_MSG,
  cardTime,
  emptyXhsState,
  formatXhsTime,
  indexTimes,
  parseXhsUrl,
  sanitizeTimeEntries,
  sanitizeXhsState,
  splitTags,
  suggestTags,
  xhsPageKind,
  xhsPath,
  type XhsCardInfo,
  type XhsKind,
  type XhsPageTimes,
  type XhsState,
  type XhsTabState,
  type XhsTimeSource,
} from '../core/xhs';

type XhsSettings = typeof DEFAULT_SETTINGS.xhs;

const ATTR = 'data-tubemuse';
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const ID_HINT = '由笔记 ID 推算的创建时间：这一页的页面数据里没有发布时间。多数笔记与发布时间一致；定时发布或审核后发布的笔记，实际发布时间会晚一些';
const UNKNOWN_HINT = '读不到这篇笔记的发布时间（未登录时卡片上没有笔记 ID）';

let settings: XhsSettings = { ...DEFAULT_SETTINGS.xhs };
let saved: XhsState = emptyXhsState();
let times: XhsPageTimes = indexTimes([]);
let pageData: XhsTabState['pageData'] = 'none';
let timesAt = 0;
let askedKeys = new Set<string>();
let lastHref = location.href;
let lastStatus = '';
let dead = false;

function alive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// ── 页面内助手：读页面数据里的发布时间 ──

let reqId = 0;
const waiting = new Map<number, (data: unknown) => void>();

function askBridge(): Promise<unknown> {
  const id = ++reqId;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    setTimeout(() => {
      if (waiting.delete(id)) resolve(undefined); // 助手没加载（例如页面在扩展安装前打开）
    }, XHS.bridgeTimeoutMs);
    window.postMessage({ tag: XHS_BRIDGE_TAG, dir: 'req', id, op: XHS_BRIDGE_OP }, location.origin);
  });
}

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const m = e.data as { tag?: unknown; dir?: unknown; id?: unknown; data?: unknown } | null;
  if (!m || m.tag !== XHS_BRIDGE_TAG || m.dir !== 'res' || typeof m.id !== 'number') return;
  const resolve = waiting.get(m.id);
  if (!resolve) return;
  waiting.delete(m.id);
  resolve(m.data);
});

let refreshing = false;
async function refreshTimes(keys: string[]): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  timesAt = Date.now();
  for (const k of keys) askedKeys.add(k);
  try {
    const data = (await askBridge()) as { hasState?: unknown; entries?: unknown } | undefined;
    if (!data) {
      pageData = 'unavailable';
      return;
    }
    const entries = sanitizeTimeEntries(data.entries, Date.now());
    times = indexTimes(entries);
    pageData = entries.length ? 'ok' : 'none';
  } finally {
    refreshing = false;
    schedule();
  }
}

// ── 页面上的笔记卡片 ──

interface UserTarget {
  id: string;
  name: string;
  url: string;
}

interface NoteTarget {
  /** 未登录时个人主页的卡片上没有笔记 ID：只能看时间，不能收藏这篇 */
  id?: string;
  title: string;
  url?: string;
  author?: UserTarget;
  time?: { at: number; source: XhsTimeSource };
}

interface PopTarget {
  note?: NoteTarget;
  user?: UserTarget;
}

const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function userFrom(a: HTMLAnchorElement | null, name: string): UserTarget | undefined {
  const link = a ? parseXhsUrl(a.href) : undefined;
  return link?.kind === 'user' ? { id: link.userId, name, url: a!.href } : undefined;
}

/** 读一张卡片：笔记链接（封面、标题、隐藏链接里带笔记 ID 的那个，优先带 xsec_token 的）、位置、标题、作者 */
function readCard(el: HTMLElement): { info: XhsCardInfo; note: NoteTarget } {
  let url: string | undefined;
  let noteId: string | undefined;
  let userId: string | undefined;
  for (const a of el.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const link = parseXhsUrl(a.href);
    if (link?.kind !== 'note') continue;
    if (!url || (!url.includes('xsec_token=') && a.href.includes('xsec_token='))) {
      url = a.href;
      noteId = link.noteId;
      userId = link.userId;
    }
  }
  const title = text(el.querySelector('.footer .title'));
  const authorA = el.querySelector<HTMLAnchorElement>('.footer a.author');
  const prefix = url ? xhsPath(url)?.prefix : undefined;
  const author = userFrom(authorA, text(authorA?.querySelector('.name') ?? authorA)) ?? (userId && prefix ? { id: userId, name: '', url: `${prefix}user/profile/${userId}` } : undefined);
  const rawIndex = el.dataset.index;
  const index = rawIndex !== undefined && /^\d+$/.test(rawIndex) ? Number(rawIndex) : undefined;
  const info: XhsCardInfo = { title, ...(noteId ? { noteId } : {}), ...(index !== undefined ? { index } : {}) };
  return { info, note: { title, ...(noteId ? { id: noteId, url: url! } : {}), ...(author ? { author } : {}) } };
}

function keyOf(info: XhsCardInfo): string {
  return info.noteId ?? `${info.index ?? '?'}:${info.title}`;
}

/** 卡片作者那一行的发布时间：插在作者与点赞数之间，靠右；作者名放不下时由小红书自己的省略号截断 */
function ensureTime(row: Element, t: { at: number; source: XhsTimeSource } | undefined): void {
  let el = row.querySelector<HTMLTimeElement>(`:scope > [${ATTR}="xhs-time"]`);
  if (!el) {
    el = document.createElement('time');
    el.setAttribute(ATTR, 'xhs-time');
    row.insertBefore(el, row.querySelector(':scope > .like-wrapper'));
  }
  setTimeText(el, t, '');
}

function setTimeText(el: HTMLTimeElement, t: { at: number; source: XhsTimeSource } | undefined, prefix: string): void {
  const label = t ? prefix + formatXhsTime(t.at, t.source, timeZone) : '时间未知';
  if (el.textContent !== label) el.textContent = label;
  const iso = t ? new Date(t.at).toISOString() : '';
  if (el.dateTime !== iso) el.dateTime = iso;
  const source = t?.source ?? 'unknown';
  if (el.dataset.source !== source) el.dataset.source = source;
  const hint = !t ? UNKNOWN_HINT : t.source === 'id' ? ID_HINT : '';
  if (el.title !== hint) el.title = hint;
}

// ── 收藏按钮 ──

interface SaveButton {
  host: HTMLElement;
  button: HTMLButtonElement;
  label: HTMLSpanElement;
  icon: SVGSVGElement;
  target: PopTarget;
  variant: 'card' | 'inline';
}

const buttons = new WeakMap<HTMLElement, SaveButton>();

const BUTTON_CSS = `
:host { all: initial; }
button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; font: 500 12px/1 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; white-space: nowrap; border-radius: 999px; }
button:focus-visible { outline: 2px solid #c8364a; outline-offset: 2px; }
svg { width: 13px; height: 13px; flex: none; }
.card { padding: 6px 10px; color: #fff; background: rgba(0, 0, 0, .58); backdrop-filter: blur(4px); }
.card:hover { background: rgba(0, 0, 0, .72); }
.card.on { background: #c8364a; }
.inline { padding: 6px 12px; color: #333; background: #fff; border: 1px solid rgba(0, 0, 0, .14); }
.inline:hover { border-color: #c8364a; color: #c8364a; }
.inline.on { color: #c8364a; border-color: #c8364a; background: #fdf1f3; }
@media (prefers-color-scheme: dark) {
  .inline { color: #eee; background: #2a2a2a; border-color: rgba(255, 255, 255, .2); }
  .inline.on { background: #3d2328; color: #ef6b7d; border-color: #ef6b7d; }
}
`;

const SVG_NS = 'http://www.w3.org/2000/svg';
function bookmarkIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M6 3h12v18l-6-4.5L6 21z');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/** 按钮里的点击、按下不往外传：不让小红书把它当成"点了卡片"去打开笔记 */
function isolate(host: HTMLElement, events: string[]): void {
  for (const type of events) host.addEventListener(type, (e) => e.stopPropagation());
}

function makeButton(variant: SaveButton['variant'], kind: string): SaveButton {
  const host = document.createElement('span');
  host.setAttribute(ATTR, kind);
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = BUTTON_CSS;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = variant;
  const icon = bookmarkIcon();
  const label = document.createElement('span');
  button.append(icon, label);
  root.append(style, button);
  const b: SaveButton = { host, button, label, icon, target: {}, variant };
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pop?.anchor === host) closePop();
    else openPop(host, b.target);
  });
  isolate(host, ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'keydown']);
  buttons.set(host, b);
  return b;
}

/** 收藏状态写在按钮上：卡片按钮"收藏 / 已收藏 · 2"，博主主页"收藏博主 / 已收藏博主" */
function paintButton(b: SaveButton): void {
  const { note, user } = b.target;
  const item = note?.id ? saved.notes[note.id] : user ? saved.users[user.id] : undefined;
  const on = !!item;
  const what = note ? '' : '博主';
  const label = on ? `已收藏${what}${item.tags.length ? ` · ${item.tags.length}` : ''}` : `收藏${what}`;
  if (b.label.textContent !== label) b.label.textContent = label;
  b.button.classList.toggle('on', on);
  b.icon.querySelector('path')?.setAttribute('fill', on ? 'currentColor' : 'none');
  if (on) b.host.setAttribute('data-saved', '');
  else b.host.removeAttribute('data-saved');
  const title = on ? `已收进 TubeMuse${item.tags.length ? `，标签：${item.tags.join('、')}` : ''}。点开改标签或移出` : '收进 TubeMuse 并打标签（只存在本机，不会在小红书上收藏或关注）';
  if (b.button.title !== title) b.button.title = title;
}

/** 卡片的收藏按钮放在 footer 开头，绝对定位到封面左下角：不占卡片高度 */
function ensureCardButton(footer: Element, note: NoteTarget): void {
  const host = footer.querySelector<HTMLElement>(`:scope > [${ATTR}="xhs-save"]`);
  let b = host ? buttons.get(host) : undefined;
  if (!b) {
    host?.remove();
    b = makeButton('card', 'xhs-save');
    footer.insertBefore(b.host, footer.firstChild);
  }
  b.target = { note };
  paintButton(b);
  if (pop?.anchor === b.host) pop.target = b.target;
}

// ── 全局样式（只作用于本扩展插入的元素；卡片作者那一行给头像留出位置） ──

const GLOBAL_CSS = `
[${ATTR}="xhs-time"] { flex: 0 0 auto; margin: 0 8px 0 auto; font-size: 12px; line-height: 20px; color: inherit; opacity: .78; white-space: nowrap; font-variant-numeric: tabular-nums; }
[${ATTR}="xhs-time"][data-source="unknown"] { opacity: .5; }
section.note-item .author-wrapper:has(> [${ATTR}="xhs-time"]) > a.author { min-width: 20px; }
section.note-item [${ATTR}="xhs-save"] { position: absolute; z-index: 3; left: 12px; margin-top: -46px; opacity: 0; transition: opacity .15s; }
section.note-item:hover [${ATTR}="xhs-save"], section.note-item [${ATTR}="xhs-save"][data-saved], section.note-item [${ATTR}="xhs-save"]:focus-within { opacity: 1; }
[${ATTR}="xhs-save-inline"] { display: inline-flex; vertical-align: middle; margin: 0 12px; flex: none; }
[${ATTR}="xhs-save-inline"][data-for="note"] { margin: 0 8px 0 auto; }
[${ATTR}="xhs-detail-time"] { margin-left: 8px; font-variant-numeric: tabular-nums; }
`;

function ensureGlobalStyle(): void {
  if (document.querySelector(`style[${ATTR}="xhs-style"]`)) return;
  const style = document.createElement('style');
  style.setAttribute(ATTR, 'xhs-style');
  style.textContent = GLOBAL_CSS;
  (document.head ?? document.documentElement).append(style);
}

function removeAll(): void {
  for (const el of document.querySelectorAll(`[${ATTR}^="xhs"]`)) el.remove();
  closePop();
}

// ── 扫描 ──

let scanTimer: ReturnType<typeof setTimeout> | undefined;
function schedule(): void {
  if (dead || scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = undefined;
    scan();
  }, XHS.scanDelayMs);
}

function scan(): void {
  if (!alive()) return teardown();
  if (location.href !== lastHref) {
    // 站内跳转（小红书是单页应用）：页面数据换了，重新读
    lastHref = location.href;
    askedKeys = new Set();
    timesAt = 0;
  }
  if (!settings.enabled) {
    removeAll();
    return report({ cards: 0, exact: 0, approx: 0, unknown: 0 });
  }
  ensureGlobalStyle();
  const now = Date.now();
  const counts = { cards: 0, exact: 0, approx: 0, unknown: 0 };
  const missing: string[] = [];
  for (const card of document.querySelectorAll<HTMLElement>('section.note-item')) {
    const footer = card.querySelector('.footer');
    const row = footer?.querySelector('.author-wrapper');
    if (!footer || !row) continue;
    const { info, note } = readCard(card);
    const t = cardTime(info, times, now);
    if (t) note.time = t;
    counts.cards++;
    if (t?.source === 'page') counts.exact++;
    else if (t) counts.approx++;
    else counts.unknown++;
    if (t?.source !== 'page' && !askedKeys.has(keyOf(info))) missing.push(keyOf(info));
    if (settings.showTime) ensureTime(row, t);
    else row.querySelector(`:scope > [${ATTR}="xhs-time"]`)?.remove();
    if (settings.showSave) ensureCardButton(footer, note);
    else footer.querySelector(`:scope > [${ATTR}="xhs-save"]`)?.remove();
  }
  scanProfile();
  const detailMissing = scanDetail(now);
  if (detailMissing) missing.push(detailMissing);
  // 有还没在页面数据里找过的卡片：重读页面数据（虚拟列表滚动、加载下一页、打开笔记详情时）
  if (missing.length && now - timesAt >= XHS.timesRefreshMs) void refreshTimes(missing);
  else if (missing.length) schedule();
  report(counts);
}

/** 博主主页：名字旁一个"收藏博主" */
function scanProfile(): void {
  const link = parseXhsUrl(location.href);
  const nameEl = link?.kind === 'user' ? document.querySelector('.user-info .user-name') : null;
  const existing = document.querySelector<HTMLElement>(`[${ATTR}="xhs-save-inline"][data-for="profile"]`);
  if (!nameEl || !settings.showSave || link?.kind !== 'user') return existing?.remove();
  let b = existing ? buttons.get(existing) : undefined;
  if (!b || existing!.previousElementSibling !== nameEl) {
    existing?.remove();
    b = makeButton('inline', 'xhs-save-inline');
    b.host.dataset.for = 'profile';
    nameEl.after(b.host);
  }
  b.target = { user: { id: link.userId, name: text(nameEl), url: location.href } };
  paintButton(b);
  if (pop?.anchor === b.host) pop.target = b.target;
}

const shown = (e: Element): boolean => e.getClientRects().length > 0;

/**
 * 笔记详情里作者那一栏（头像、名字、"关注"）。页面里有两份：视频笔记顶上那份（.author）是藏起来的，
 * 看得见的在右侧互动区（.interaction-container .author-container）——2026-11-04 实测。按钮放进看得见的那份，
 * 否则会被一起藏起来。评论区每条评论也有 .author-wrapper，但里面没有 .info，不会认错。
 */
function detailAuthorRow(container: Element): Element | undefined {
  const rows = [...container.querySelectorAll('.author-wrapper:has(> .info)')];
  return rows.find(shown) ?? rows[0];
}

/** 笔记详情（单独的页面或弹出的浮层）：日期旁显示精确发布时间，"关注"旁一个"收藏"。返回还没在页面数据里找过的笔记 */
function scanDetail(now: number): string | undefined {
  const container = document.querySelector('#noteContainer, .note-container');
  const existing = document.querySelectorAll<HTMLElement>(`[${ATTR}="xhs-save-inline"][data-for="note"], [${ATTR}="xhs-detail-time"]`);
  const link = parseXhsUrl(location.href);
  if (!container || link?.kind !== 'note') {
    for (const el of existing) el.remove();
    return undefined;
  }
  const info: XhsCardInfo = { noteId: link.noteId, title: '' };
  const t = cardTime(info, times, now);
  const row = detailAuthorRow(container);
  const authorA = row?.querySelector<HTMLAnchorElement>('a.name') ?? container.querySelector<HTMLAnchorElement>('.author-wrapper a.name, .author-container a.name');
  const author = userFrom(authorA, text(authorA));
  const note: NoteTarget = { id: link.noteId, url: location.href, title: text(container.querySelector('#detail-title, .note-content .title')), ...(author ? { author } : {}), ...(t ? { time: t } : {}) };

  const date = container.querySelector('.bottom-container .date');
  let timeEl = container.querySelector<HTMLTimeElement>(`[${ATTR}="xhs-detail-time"]`);
  if (date && settings.showTime) {
    if (!timeEl || timeEl.previousElementSibling !== date) {
      timeEl?.remove();
      timeEl = document.createElement('time');
      timeEl.setAttribute(ATTR, 'xhs-detail-time');
      date.after(timeEl);
    }
    setTimeText(timeEl, t, '发布于 ');
  } else timeEl?.remove();

  // 放在"关注"前面；没有"关注"（例如你自己的笔记）时放在这一栏末尾
  const follow = row?.querySelector(':scope > .note-detail-follow-btn') ?? null;
  let host = container.querySelector<HTMLElement>(`[${ATTR}="xhs-save-inline"][data-for="note"]`);
  if (row && settings.showSave) {
    let b = host ? buttons.get(host) : undefined;
    if (!b || host!.parentElement !== row || host!.nextElementSibling !== follow) {
      host?.remove();
      b = makeButton('inline', 'xhs-save-inline');
      b.host.dataset.for = 'note';
      row.insertBefore(b.host, follow);
      host = b.host;
    }
    b.target = { note };
    paintButton(b);
    if (pop?.anchor === b.host) pop.target = b.target;
  } else host?.remove();
  return t?.source !== 'page' && !askedKeys.has(link.noteId) ? link.noteId : undefined;
}

// ── 状态报给侧边栏 ──

function status(counts: Pick<XhsTabState, 'cards' | 'exact' | 'approx' | 'unknown'>): XhsTabState {
  return { page: xhsPageKind(location.href), enabled: settings.enabled, ...counts, pageData };
}

let lastCounts = { cards: 0, exact: 0, approx: 0, unknown: 0 };
function report(counts: typeof lastCounts): void {
  lastCounts = counts;
  const s = status(counts);
  const json = JSON.stringify(s);
  if (json === lastStatus) return;
  lastStatus = json;
  try {
    void chrome.runtime.sendMessage({ type: XHS_MSG.state, state: s }).catch(() => undefined);
  } catch {
    teardown();
  }
}

// ── 收藏弹窗 ──

const POP_CSS = `
:host { all: initial; }
.pop { position: fixed; z-index: 2147483000; box-sizing: border-box; width: 300px; max-height: min(520px, calc(100vh - 16px)); overflow: auto; padding: 12px 14px; border-radius: 12px; background: #fff; color: #222; border: 1px solid rgba(0, 0, 0, .1); box-shadow: 0 8px 28px rgba(0, 0, 0, .18); font: 13px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
header b { font-size: 13px; }
button { font: inherit; cursor: pointer; }
.x { border: 0; background: none; font-size: 18px; line-height: 1; color: #888; padding: 2px 4px; }
section { padding: 10px 0; border-top: 1px solid rgba(0, 0, 0, .08); }
.kind { font-size: 11px; color: #888; }
.name { font-weight: 600; margin: 2px 0; overflow-wrap: anywhere; }
.meta { font-size: 12px; color: #666; font-variant-numeric: tabular-nums; }
.row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.toggle { border: 1px solid #c8364a; color: #fff; background: #c8364a; border-radius: 999px; padding: 4px 12px; }
.toggle.on { color: #c8364a; background: transparent; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip { display: inline-flex; align-items: center; gap: 2px; padding: 2px 4px 2px 8px; border-radius: 999px; background: #fbe7ea; color: #a12a3b; font-size: 12px; }
.chip button { border: 0; background: none; color: inherit; padding: 0 4px; font-size: 14px; line-height: 1; }
.sugg { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; align-items: center; font-size: 12px; color: #888; }
.sugg button { border: 1px dashed rgba(0, 0, 0, .25); background: none; border-radius: 999px; padding: 1px 8px; font-size: 12px; color: #555; }
.sugg button:hover { border-color: #c8364a; color: #c8364a; }
input { box-sizing: border-box; width: 100%; margin-top: 8px; padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(0, 0, 0, .18); font: inherit; background: transparent; color: inherit; }
input:focus { outline: 2px solid #c8364a; outline-offset: -1px; border-color: transparent; }
.note { font-size: 12px; color: #888; margin: 8px 0 0; }
.err { font-size: 12px; color: #b3261e; margin: 6px 0 0; }
@media (prefers-color-scheme: dark) {
  .pop { background: #222; color: #eee; border-color: rgba(255, 255, 255, .14); }
  section { border-color: rgba(255, 255, 255, .1); }
  .meta { color: #aaa; }
  .chip { background: #3d2328; color: #f4a3ae; }
  .sugg button { color: #ccc; border-color: rgba(255, 255, 255, .3); }
  input { border-color: rgba(255, 255, 255, .25); }
  .err { color: #ff8a80; }
}
`;

let pop: { host: HTMLElement; root: ShadowRoot; box: HTMLElement; anchor: HTMLElement; target: PopTarget; error?: string } | undefined;

function openPop(anchor: HTMLElement, target: PopTarget): void {
  closePop();
  const host = document.createElement('div');
  host.setAttribute(ATTR, 'xhs-pop');
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = POP_CSS;
  const box = document.createElement('div');
  box.className = 'pop';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'TubeMuse 收藏');
  root.append(style, box);
  // 在弹窗里打字、点击不惊动小红书页面（它的快捷键、"点空白处关闭"之类）
  isolate(host, ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'input', 'wheel']);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePop(true);
  });
  document.body.append(host);
  pop = { host, root, box, anchor, target };
  renderPop();
  place();
  root.querySelector<HTMLInputElement>('input')?.focus();
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('scroll', place, { capture: true, passive: true });
  window.addEventListener('resize', place, { passive: true });
}

function closePop(refocus = false): void {
  if (!pop) return;
  const anchor = pop.anchor;
  pop.host.remove();
  pop = undefined;
  document.removeEventListener('pointerdown', outside, true);
  window.removeEventListener('scroll', place, { capture: true });
  window.removeEventListener('resize', place);
  if (refocus) buttons.get(anchor)?.button.focus();
}

function outside(e: Event): void {
  if (pop && !e.composedPath().some((n) => n === pop!.host || n === pop!.anchor)) closePop();
}

/** 贴着按钮放（下方放不下就放上方）；按钮被虚拟列表回收了就关掉 */
function place(): void {
  if (!pop) return;
  if (!pop.anchor.isConnected) return closePop();
  const r = pop.anchor.getBoundingClientRect();
  const w = pop.box.offsetWidth;
  const h = pop.box.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8 && r.top - 6 - h >= 8) top = r.top - 6 - h;
  top = Math.max(8, Math.min(top, innerHeight - h - 8));
  const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  pop.box.style.top = `${top}px`;
  pop.box.style.left = `${left}px`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, label?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (label !== undefined) e.textContent = label;
  return e;
}

async function send(op: Record<string, unknown>): Promise<void> {
  if (!pop) return;
  let error: string | undefined;
  try {
    const r = (await chrome.runtime.sendMessage({ type: XHS_MSG.op, op })) as { ok?: boolean; error?: string } | undefined;
    if (!r?.ok) error = r?.error ?? '没有保存成功：后台没有应答，稍后再试';
  } catch {
    error = 'TubeMuse 刚更新或重新加载过：刷新这个页面后再试';
  }
  if (!pop) return;
  pop.error = error;
  renderPop();
}

function noteInput(n: NoteTarget): Record<string, unknown> {
  return {
    id: n.id,
    title: n.title,
    url: n.url,
    ...(n.author ? { authorId: n.author.id, authorName: n.author.name } : {}),
    ...(n.time ? { publishedAt: n.time.at, timeSource: n.time.source } : {}),
  };
}

/** 弹窗里的一节（笔记或博主）：收藏 / 移出、已有标签、加标签、常用标签 */
function renderSection(kind: XhsKind, target: PopTarget): HTMLElement {
  const s = el('section');
  s.dataset.kind = kind;
  const note = target.note;
  // 博主：主页上的按钮直接给博主；卡片和详情里的按钮给的是笔记，博主是它的作者
  const user = target.user ?? note?.author;
  const id = kind === 'note' ? note?.id : user?.id;
  const item = !id ? undefined : kind === 'note' ? saved.notes[id] : saved.users[id];
  s.append(el('div', 'kind', kind === 'note' ? '笔记' : '博主'));
  s.append(el('div', 'name', kind === 'note' ? note?.title || '（无标题）' : user?.name || '（未知博主）'));
  if (kind === 'note' && note?.time) s.append(el('div', 'meta', `发布 ${formatXhsTime(note.time.at, note.time.source, timeZone)}${note.time.source === 'id' ? '（由笔记 ID 推算）' : ''}`));
  if (!id) {
    s.append(el('p', 'note', '未登录时小红书的卡片上没有笔记链接，登录后才能收藏这篇笔记（博主照常可以收藏）'));
    return s;
  }
  const save = (tags: string[]) =>
    kind === 'note' ? send({ op: 'saveNote', note: noteInput(note!), tags }) : send({ op: 'saveUser', user: { id: user!.id, name: user!.name, url: user!.url }, tags });

  const row = el('div', 'row');
  const toggle = el('button', `toggle${item ? ' on' : ''}`, item ? '移出收藏' : kind === 'note' ? '收藏这篇笔记' : '收藏这位博主');
  toggle.type = 'button';
  toggle.addEventListener('click', () => void (item ? send({ op: 'remove', kind, id }) : save([])));
  row.append(toggle);
  if (item) row.append(el('span', 'meta', `已收藏 · ${new Date(item.savedAt).toLocaleDateString('zh-CN')}`));
  s.append(row);

  if (item?.tags.length) {
    const chips = el('div', 'chips');
    for (const t of item.tags) {
      const chip = el('span', 'chip', `#${t}`);
      const x = el('button', undefined, '×');
      x.type = 'button';
      x.setAttribute('aria-label', `去掉标签 ${t}`);
      x.addEventListener('click', () => void send({ op: 'tags', kind, id, add: [], remove: [t] }));
      chip.append(x);
      chips.append(chip);
    }
    s.append(chips);
  }

  const input = el('input');
  input.placeholder = item ? '加标签，回车确认（逗号分隔可一次加几个）' : '加标签并收藏，回车确认';
  input.setAttribute('aria-label', kind === 'note' ? '给这篇笔记加标签' : '给这位博主加标签');
  input.dataset.kind = kind;
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const tags = splitTags(input.value);
    if (!tags.length) return;
    input.value = '';
    void (item ? send({ op: 'tags', kind, id, add: tags, remove: [] }) : save(tags));
  });
  s.append(input);

  const current = item?.tags ?? [];
  const sugg = suggestTags(saved, current);
  if (sugg.length) {
    const box = el('div', 'sugg', '常用：');
    for (const t of sugg) {
      const b = el('button', undefined, `+${t}`);
      b.type = 'button';
      b.addEventListener('click', () => void (item ? send({ op: 'tags', kind, id, add: [t], remove: [] }) : save([t])));
      box.append(b);
    }
    s.append(box);
  }
  return s;
}

function renderPop(): void {
  if (!pop) return;
  // 重画时保留输入框里没写完的字和光标
  const active = pop.root.activeElement as HTMLInputElement | null;
  const drafts = new Map<string, string>();
  for (const i of pop.root.querySelectorAll<HTMLInputElement>('input')) drafts.set(i.dataset.kind ?? '', i.value);
  const focusKind = active?.tagName === 'INPUT' ? active.dataset.kind : undefined;

  const header = el('header');
  header.append(el('b', undefined, 'TubeMuse 收藏'));
  const x = el('button', 'x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', '关闭');
  x.addEventListener('click', () => closePop(true));
  header.append(x);
  const parts: HTMLElement[] = [header];
  if (pop.target.note) parts.push(renderSection('note', pop.target));
  if (pop.target.user || pop.target.note?.author) parts.push(renderSection('user', pop.target));
  parts.push(el('p', 'note', '只存在本机，不会在小红书上收藏或关注。在 TubeMuse 侧边栏的"小红书"页查看、筛选、管理标签。'));
  if (pop.error) {
    const err = el('p', 'err', pop.error);
    err.setAttribute('role', 'alert');
    parts.push(err);
  }
  pop.box.replaceChildren(...parts);
  for (const i of pop.root.querySelectorAll<HTMLInputElement>('input')) {
    i.value = drafts.get(i.dataset.kind ?? '') ?? '';
    if (i.dataset.kind === focusKind) i.focus();
  }
  place();
}

// ── 设置与收藏数据 ──

function applySettings(raw: unknown): void {
  const x = (raw as { xhs?: Partial<XhsSettings> } | undefined)?.xhs;
  settings = { ...DEFAULT_SETTINGS.xhs, ...(x && typeof x === 'object' ? x : {}) };
  schedule();
}

function applySaved(raw: unknown): void {
  saved = sanitizeXhsState(raw, Date.now());
  schedule();
  renderPop();
}

// ── 生命周期 ──

const ours = (n: Node): boolean => n instanceof Element && (n.hasAttribute(ATTR) || !!n.closest(`[${ATTR}]`));
const observer = new MutationObserver((records) => {
  if (records.every((r) => ours(r.target) || (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(ours)))) return;
  schedule();
});

function teardown(): void {
  if (dead) return;
  dead = true;
  observer.disconnect();
  try {
    removeAll();
  } catch {
    // 页面正在卸载
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse: (s: XhsTabState) => void) => {
  if ((msg as { type?: string } | undefined)?.type !== XHS_MSG.getState) return false;
  sendResponse(status(lastCounts));
  return false;
});

void chrome.storage.local
  .get(['settings', 'xhs'])
  .then((r) => {
    applySettings(r.settings);
    applySaved(r.xhs);
  })
  .catch(() => undefined);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || dead) return;
  if (changes.settings) applySettings(changes.settings.newValue);
  if (changes.xhs) applySaved(changes.xhs.newValue);
});
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'data-index'] });
window.addEventListener('popstate', schedule);
// 窗口宽窄变了，笔记详情里看得见的作者栏可能换成另一份：重新放按钮
window.addEventListener('resize', schedule, { passive: true });
schedule();
