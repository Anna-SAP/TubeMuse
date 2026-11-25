// B 站网页版的页面脚本（2026-11-25 新增，见 DECISIONS §92）。
// 1. 发布时间：视频页右侧"接下来播放"列表（.video-page-card-small）每条视频的播放量那一行后面，写上发布时间；
//    播放列表页（/list/…，例如"UP主的全部视频"、稍后再看、收藏夹的"播放全部"）右侧的列表（.action-list-item-wrap）同样，
//    写在"N万播放"那一行后面（2026-11-25 用户在 Firefox 上的播放列表页发现没有显示，见 DECISIONS §92）
//    （30 天内"N 天前"，再早的写日期）。B 站页面上没有这个信息：由扩展后台向 B 站公开接口查（只在你勾选"显示发布时间"后），
//    这个脚本自己不发任何网络请求。列表刷新、站内跳转（B 站复用同一批卡片元素、只换内容）、点"展开"加载出的新条目都跟着更新。
// 2. 收藏与标签：每条视频的封面左上角一个"收藏"按钮（悬停时出现，收藏后常驻），点开后收进 TubeMuse、打标签。
//    写入经扩展后台校验；收藏只存在本机，不会在 B 站上收藏。
// 3. 告诉侧边栏当前页的情况；当前是视频页时，附上这个视频的标题、UP 主、发布时间（读页面自己声明的 meta），供侧边栏收藏。
// 红线：不发任何网络请求、不读写 Cookie、不点击或模拟点击 B 站的任何按钮（不会替你收藏、点赞、投币、关注），
// 写页面只用 createElement + textContent（构建时检查）；只读推荐列表里每条视频的链接、标题、UP 主、时长，不读评论、弹幕、简介。
// B 站的视频页是服务端渲染再由 Vue 接管（hydration）的：接管完之前往列表里加东西，Vue 会认为页面对不上、整页重画，
// 所以等 #app 上的 data-server-rendered 消失（Vue 接管时会去掉它，2026-11-25 实测）再动手。

import { BILI, DEFAULT_SETTINGS } from '../config/defaults';
import { BILI_PAGES } from '../config/endpoints';
import {
  BILI_MSG,
  biliPubdateHint,
  biliVideoFromUrl,
  emptyBiliState,
  formatBiliPubdate,
  isBvid,
  parseBiliDuration,
  sanitizeBiliState,
  splitTags,
  suggestBiliTags,
  type BiliPubdateReply,
  type BiliState,
  type BiliTabState,
  type BiliVideoInput,
} from '../core/bili';
import { formatDuration } from '../core/time';

type BiliSettings = typeof DEFAULT_SETTINGS.bili;

const ATTR = 'data-tubemuse';
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

let settings: BiliSettings = { ...DEFAULT_SETTINGS.bili };
let saved: BiliState = emptyBiliState();
let lastStatus = '';
let dead = false;

/** 查到的发布时间（BV 号 → 毫秒）与接口里没有的；换页不清：同一个视频的发布时间不会变 */
const times = new Map<string, number>();
const absent = new Set<string>();
/** 正在问后台的 */
const asking = new Set<string>();
/** 上一次没查成的原因与时间（过 BILI.retryMs 再试） */
let lookupError: { message: string; at: number; ids: Set<string> } | undefined;

function alive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Vue 还没接管服务端渲染的页面 */
const hydrating = (): boolean => !!document.querySelector('[data-server-rendered]');

// ── 推荐列表里的一条 ──

/**
 * 列表里的一条视频：视频页"接下来播放"的卡片、播放列表页下面的推荐卡片、播放列表页右侧列表的一项。
 * 发布时间和播放量在同一行：line 后面（"接下来播放"的 .playinfo 是 inline-flex，后面接着写），或 line 里面的末尾
 * （播放列表页推荐卡片的 .playinfo 是占满一行的 flex，播放列表那一项的 .views 所在的 .info 是固定高度、上下撑开的竖排：
 * 写在外面都会另起一行）
 */
interface CardInfo {
  video: BiliVideoInput;
  /** 这一条的根元素（找我们加过的东西） */
  root: Element;
  timeParent: Element;
  /** 时间要和它在同一行 */
  line: Element | null;
  inside: boolean;
  picBox: Element | null;
}

const SPACE_MID = /space\.bilibili\.com\/(?:[a-z]{2}-[A-Za-z]{2,4}\/)?(\d{1,20})(?:[/?#]|$)/;

function readCard(card: HTMLElement): CardInfo | undefined {
  const info = card.querySelector('.info');
  if (!info) return undefined;
  let link: { bvid: string; url: string } | undefined;
  for (const a of [...info.querySelectorAll<HTMLAnchorElement>('a[href]'), ...card.querySelectorAll<HTMLAnchorElement>('a[href]')]) {
    link = biliVideoFromUrl(a.href);
    if (link) break;
  }
  // 番剧、直播、广告之类的卡片没有视频页的 BV 号：不显示时间、不放按钮
  if (!link) return undefined;
  const titleEl = info.querySelector('.title');
  const title = titleEl?.getAttribute('title')?.trim() || text(titleEl);
  // 视频页是 .upname > a，播放列表页下面的推荐是 a.upname 本身
  const up = info.querySelector<HTMLAnchorElement>('a.upname[href], .upname a[href]');
  const upName = text(info.querySelector('.upname .name') ?? up);
  const upMid = up ? SPACE_MID.exec(up.href)?.[1] : undefined;
  const duration = parseBiliDuration(text(card.querySelector('.duration')));
  const at = times.get(link.bvid);
  const video: BiliVideoInput = {
    ...link,
    title,
    ...(upName ? { upName } : {}),
    ...(upMid ? { upMid } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(at !== undefined ? { publishedAt: at } : {}),
  };
  const playinfo = info.querySelector(':scope > .playinfo');
  // 播放量那一行占满整行（display: flex，播放列表页下面的推荐就是，2026-11-25 实测）时写在它里面，否则接在它后面
  const inside = !!playinfo && getComputedStyle(playinfo).display === 'flex';
  return { video, root: card, timeParent: inside && playinfo ? playinfo : info, line: playinfo, inside, picBox: card.querySelector('.pic-box') };
}

/** 当前页面所在的 B 站站点前缀（e2e 里是本机 mock 的 /bili/） */
const sitePrefix = (): string | undefined => BILI_PAGES.find((p) => location.href.startsWith(p));

/**
 * 播放列表页右侧列表的一项（2026-11-25 实测 /list/<ID>?bvid=…）：.action-list-item-wrap[data-key=<BV号>] > … > .main >
 * .cover（封面，position: relative）+ .info（.title[title]、.views"1.6万播放"）。没有链接：BV 号只在 data-key 上；
 * 每一项都是同一个 UP 主（或收藏夹），所以没有 UP 主名。分 P 的视频那一项 data-key 不是 BV 号的不认
 */
function readListItem(wrap: HTMLElement): CardInfo | undefined {
  const bvid = wrap.dataset.key;
  const prefix = sitePrefix();
  const info = wrap.querySelector('.info');
  const views = info?.querySelector('.views');
  if (!isBvid(bvid) || !prefix || !info || !views) return undefined;
  const link = biliVideoFromUrl(`${prefix}video/${bvid}/`);
  if (!link) return undefined;
  const titleEl = info.querySelector('.title');
  const title = titleEl?.getAttribute('title')?.trim() || text(titleEl);
  const duration = parseBiliDuration(text(wrap.querySelector('.duration')));
  const at = times.get(bvid);
  const video: BiliVideoInput = { ...link, title, ...(duration !== undefined ? { duration } : {}), ...(at !== undefined ? { publishedAt: at } : {}) };
  return { video, root: wrap, timeParent: views, line: views, inside: true, picBox: wrap.querySelector('.cover') };
}

/**
 * 页面上能放时间和按钮的每一条：视频页的"接下来播放"（.video-page-card-small）、播放列表页右侧的列表（.action-list-item-wrap）
 * 和它下面的推荐（.recommend-video-card：和"接下来播放"的卡片同一种结构，2026-11-25 实测）
 */
const LIST_ITEMS = '.video-page-card-small, .recommend-video-card, .action-list-item-wrap';

function readItem(el: HTMLElement): CardInfo | undefined {
  return el.classList.contains('action-list-item-wrap') ? readListItem(el) : readCard(el);
}

// ── 发布时间 ──

type TimeState = 'shown' | 'pending' | 'unknown' | 'failed';

function timeState(bvid: string): TimeState {
  if (times.has(bvid)) return 'shown';
  if (absent.has(bvid)) return 'unknown';
  if (lookupError?.ids.has(bvid) && !asking.has(bvid)) return 'failed';
  return 'pending';
}

/** 播放量那一行后面的发布时间：卡片插在 .playinfo 后面、播放列表插在"N万播放"的末尾（都是同一行），高度不变 */
function ensureTime(c: CardInfo, state: TimeState): void {
  let el = c.root.querySelector<HTMLElement>(`[${ATTR}="bili-pubdate"]`);
  // 位置不对了（B 站换了排版、这一行从 inline-flex 变成整行）：拿掉重放
  if (el && el.parentElement !== c.timeParent) {
    el.remove();
    el = null;
  }
  if (!el) {
    el = document.createElement('span');
    el.setAttribute(ATTR, 'bili-pubdate');
    if (c.inside) el.dataset.inline = '1';
    if (c.line && !c.inside) c.line.after(el);
    else c.timeParent.append(el);
  }
  const now = Date.now();
  const at = times.get(c.video.bvid);
  // 这一行放不下时：先把字缩小一号（data-compact="1"），还放不下再去掉年份的前两位（"2"）
  const level = el.dataset.bvid === c.video.bvid ? (el.dataset.compact ?? '') : '';
  const label = at !== undefined ? formatBiliPubdate(at, now, timeZone, level === '2') : state === 'unknown' ? '时间未知' : state === 'failed' ? '时间?' : '…';
  const hint =
    at !== undefined
      ? biliPubdateHint(at, now, timeZone)
      : state === 'unknown'
        ? 'B 站的接口里查不到这个视频的发布时间（可能已删除或不公开）'
        : state === 'failed'
          ? `没查到发布时间：${lookupError?.message ?? ''}`
          : '正在查发布时间…';
  // 站内跳转后 B 站复用了这张卡片、换成了别的视频：从头来
  const fresh = el.dataset.bvid !== c.video.bvid;
  if (fresh) {
    el.dataset.bvid = c.video.bvid;
    delete el.dataset.compact;
  }
  if (fresh || el.textContent !== label) {
    el.textContent = label;
    // 这一行放不下、折到下一行了（只在换了视频或文字变了时量）：先缩小一号字，还不行再换短写法
    // 折到下一行了，或（写在一行里面时）超出了这一行的右边
    const wrapped = () => {
      if (!c.line) return false;
      const r = el.getBoundingClientRect();
      const l = c.line.getBoundingClientRect();
      return r.top > l.top + 4 || (c.inside && r.right > l.right + 1);
    };
    if (at !== undefined && level !== '2' && wrapped()) {
      el.dataset.compact = '1';
      if (wrapped()) {
        el.dataset.compact = '2';
        el.textContent = formatBiliPubdate(at, now, timeZone, true);
      }
    }
  }
  if (el.title !== hint) el.title = hint;
  if (el.dataset.state !== state) el.dataset.state = state;
}

/** 问后台要这些视频的发布时间（后台先看本机记着的，缺的才向 B 站查） */
async function lookup(ids: string[]): Promise<void> {
  for (const id of ids) asking.add(id);
  let reply: BiliPubdateReply | undefined;
  try {
    reply = (await chrome.runtime.sendMessage({ type: BILI_MSG.pubdates, ids })) as BiliPubdateReply | undefined;
  } catch {
    reply = { ok: false, times: {}, error: 'TubeMuse 刚更新或重新加载过：刷新这个页面后再看' };
  }
  for (const id of ids) asking.delete(id);
  // 后台说"显示发布时间"没勾（刚取消勾选时的一瞬间）：设置的变化马上就到，这里不再重扫，免得来回问
  if (reply && !reply.ok && reply.off) return;
  for (const [id, t] of Object.entries(reply?.times ?? {})) {
    if (typeof t === 'number' && Number.isFinite(t)) times.set(id, t);
  }
  // 接口里没有的：查成了、或者这一批里别的没查成，已经知道的都算数
  for (const id of reply?.absent ?? []) if (typeof id === 'string') absent.add(id);
  if (reply?.ok) {
    if (lookupError) for (const id of ids) lookupError.ids.delete(id);
    if (lookupError && !lookupError.ids.size) lookupError = undefined;
  } else {
    const failed = ids.filter((id) => !times.has(id) && !absent.has(id));
    lookupError = { message: reply?.error ?? '后台没有应答', at: Date.now(), ids: new Set([...(lookupError?.ids ?? []), ...failed]) };
    setTimeout(schedule, BILI.retryMs + 50);
  }
  schedule();
}

// ── 收藏按钮 ──

interface SaveButton {
  host: HTMLElement;
  button: HTMLButtonElement;
  label: HTMLSpanElement;
  icon: SVGSVGElement;
  video: BiliVideoInput;
}

const buttons = new WeakMap<HTMLElement, SaveButton>();

const BUTTON_CSS = `
:host { all: initial; }
button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 3px; cursor: pointer; padding: 3px 7px; border-radius: 6px; color: #fff; background: rgba(0, 0, 0, .58); backdrop-filter: blur(4px); font: 500 11px/1.2 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; white-space: nowrap; }
button:hover { background: rgba(0, 0, 0, .74); }
button.on { background: #00aeec; }
button:focus-visible { outline: 2px solid #00aeec; outline-offset: 2px; }
svg { width: 11px; height: 11px; flex: none; }
`;

const SVG_NS = 'http://www.w3.org/2000/svg';
function bookmarkIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M6 3h12v18l-6-4.5L6 21z');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2.4');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/** 按钮里的点击、按下不往外传：不让 B 站把它当成"点了这条视频"去打开它，也不触发封面上的预览 */
function isolate(host: HTMLElement, events: string[]): void {
  for (const type of events) host.addEventListener(type, (e) => e.stopPropagation());
}

function makeButton(): SaveButton {
  const host = document.createElement('span');
  host.setAttribute(ATTR, 'bili-save');
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = BUTTON_CSS;
  const button = document.createElement('button');
  button.type = 'button';
  const icon = bookmarkIcon();
  const label = document.createElement('span');
  button.append(icon, label);
  root.append(style, button);
  const b: SaveButton = { host, button, label, icon, video: { bvid: '', title: '', url: '' } };
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pop?.anchor === host) closePop();
    else openPop(host, b.video);
  });
  isolate(host, ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'keydown', 'mouseover', 'mouseenter', 'pointerover']);
  buttons.set(host, b);
  return b;
}

/** 收藏状态写在按钮上："收藏 / 已收藏 · 2" */
function paintButton(b: SaveButton): void {
  const item = saved.videos[b.video.bvid];
  const on = !!item;
  const label = on ? `已收藏${item.tags.length ? ` · ${item.tags.length}` : ''}` : '收藏';
  if (b.label.textContent !== label) b.label.textContent = label;
  b.button.classList.toggle('on', on);
  b.icon.querySelector('path')?.setAttribute('fill', on ? 'currentColor' : 'none');
  if (on) b.host.setAttribute('data-saved', '');
  else b.host.removeAttribute('data-saved');
  const title = on ? `已收进 TubeMuse${item.tags.length ? `，标签：${item.tags.join('、')}` : ''}。点开改标签或移出` : '收进 TubeMuse 并打标签（只存在本机，不会在 B 站上收藏）';
  if (b.button.title !== title) b.button.title = title;
  b.host.dataset.bvid = b.video.bvid;
}

/** 封面左上角（右上角是 B 站的"稍后再看"，右下角是时长）：不占卡片的位置 */
function ensureButton(c: CardInfo): void {
  if (!c.picBox) return;
  const host = c.picBox.querySelector<HTMLElement>(`:scope > [${ATTR}="bili-save"]`);
  let b = host ? buttons.get(host) : undefined;
  if (!b) {
    host?.remove();
    b = makeButton();
    c.picBox.append(b.host);
  }
  b.video = c.video;
  paintButton(b);
  if (pop?.anchor === b.host) {
    pop.video = c.video;
    renderPop();
  }
}

// ── 全局样式（只作用于本扩展插入的元素） ──

const GLOBAL_CSS = `
[${ATTR}="bili-pubdate"] { display: inline-block; vertical-align: top; margin-left: 8px; font-size: 12px; line-height: 18px; color: var(--text3, #9499a0); white-space: nowrap; font-variant-numeric: tabular-nums; cursor: default; }
[${ATTR}="bili-pubdate"]:not([data-state="shown"]) { opacity: .6; }
[${ATTR}="bili-pubdate"][data-compact] { margin-left: 5px; font-size: 11px; letter-spacing: -.2px; }
:is(.video-page-card-small, .recommend-video-card) .pic-box > [${ATTR}="bili-save"], .action-list-item-wrap .cover > [${ATTR}="bili-save"] { position: absolute; z-index: 20; left: 6px; top: 6px; opacity: 0; transition: opacity .15s; }
.action-list-item-wrap .cover > [${ATTR}="bili-save"] { left: 4px; top: 4px; }
:is(.video-page-card-small, .recommend-video-card):hover .pic-box > [${ATTR}="bili-save"], :is(.video-page-card-small, .recommend-video-card) .pic-box > [${ATTR}="bili-save"][data-saved], :is(.video-page-card-small, .recommend-video-card) .pic-box > [${ATTR}="bili-save"]:focus-within,
.action-list-item-wrap:hover .cover > [${ATTR}="bili-save"], .action-list-item-wrap .cover > [${ATTR}="bili-save"][data-saved], .action-list-item-wrap .cover > [${ATTR}="bili-save"]:focus-within { opacity: 1; }
[${ATTR}="bili-pubdate"][data-inline] { vertical-align: baseline; line-height: 1; flex: none; }
`;

function ensureGlobalStyle(): void {
  if (document.querySelector(`style[${ATTR}="bili-style"]`)) return;
  const style = document.createElement('style');
  style.setAttribute(ATTR, 'bili-style');
  style.textContent = GLOBAL_CSS;
  (document.head ?? document.documentElement).append(style);
}

function removeAll(): void {
  for (const el of document.querySelectorAll(`[${ATTR}^="bili"]`)) el.remove();
  closePop();
}

// ── 当前视频（侧边栏收藏用）：页面自己声明的 meta，站内跳转时 B 站会一起换掉（2026-11-25 实测） ──

function meta(sel: string): string | undefined {
  return document.querySelector<HTMLMetaElement>(sel)?.content?.trim() || undefined;
}

function currentVideo(): BiliVideoInput | undefined {
  const page = biliVideoFromUrl(location.href);
  if (!page) return undefined;
  // 跳到新视频时网址先变、meta 后变：og:url 对得上这个视频才用 meta 里的标题、UP 主、发布时间
  const og = meta('meta[property="og:url"]');
  const fresh = !!og && biliVideoFromUrl(og)?.bvid === page.bvid;
  const h1 = document.querySelector('h1.video-title');
  const title = (fresh ? h1?.getAttribute('title')?.trim() || text(h1) : '') || document.title.replace(/_哔哩哔哩_bilibili$/, '').trim();
  // 查到过的发布时间按 BV 号记着，和 meta 换没换无关（播放列表页没有 video:release_date，这个视频就在右侧列表里）
  const looked = times.get(page.bvid);
  const video: BiliVideoInput = { ...page, title, ...(looked !== undefined ? { publishedAt: looked } : {}) };
  if (!fresh) return video;
  const upName = meta('meta[name="author"]');
  if (upName) video.upName = upName;
  const upHref = document.querySelector<HTMLAnchorElement>('.up-detail-top a.up-name[href]')?.href;
  const upMid = upHref ? SPACE_MID.exec(upHref)?.[1] : undefined;
  if (upMid) video.upMid = upMid;
  const release = Date.parse(meta('meta[property="video:release_date"]') ?? '');
  if (Number.isFinite(release)) video.publishedAt = release;
  const duration = parseBiliDuration(Number(meta('meta[property="video:duration"]')));
  if (duration !== undefined) video.duration = duration;
  return video;
}

// ── 扫描 ──

let scanTimer: ReturnType<typeof setTimeout> | undefined;
function schedule(): void {
  if (dead || scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = undefined;
    scan();
  }, BILI.scanDelayMs);
}

function scan(): void {
  if (!alive()) return teardown();
  const counts = { cards: 0, shown: 0, pending: 0, unknown: 0 };
  if (!settings.enabled) {
    removeAll();
    return report(counts, false);
  }
  if (hydrating()) return report(counts, true);
  ensureGlobalStyle();
  const want: string[] = [];
  const now = Date.now();
  const retry = !lookupError || now - lookupError.at >= BILI.retryMs;
  for (const card of document.querySelectorAll<HTMLElement>(LIST_ITEMS)) {
    const c = readItem(card);
    if (!c) {
      // 这张卡片换成了没有 BV 号的东西（番剧、广告）：把我们加的拿掉
      for (const el of card.querySelectorAll(`[${ATTR}^="bili"]`)) el.remove();
      continue;
    }
    counts.cards++;
    const state = timeState(c.video.bvid);
    if (settings.showPubdate) {
      if (state === 'shown') counts.shown++;
      else if (state === 'unknown') counts.unknown++;
      else counts.pending++;
      if ((state === 'pending' || (state === 'failed' && retry)) && !asking.has(c.video.bvid)) want.push(c.video.bvid);
      ensureTime(c, state);
    } else c.root.querySelector(`[${ATTR}="bili-pubdate"]`)?.remove();
    if (settings.showSave) ensureButton(c);
    else c.picBox?.querySelector(`:scope > [${ATTR}="bili-save"]`)?.remove();
  }
  settleThenLookup([...new Set(want)].slice(0, BILI.maxIdsPerAsk), now);
  report(counts, false);
}

/** 要查的那批这么久没变了才查（BILI.settleMs，最多等 settleMaxMs） */
let wantKey = '';
let wantAt = 0;
let wantFirst = 0;
function settleThenLookup(want: string[], now: number): void {
  if (!want.length) {
    wantKey = '';
    wantFirst = 0;
    return;
  }
  const key = want.join(',');
  if (key !== wantKey) {
    wantKey = key;
    wantAt = now;
    wantFirst ||= now;
  }
  if (now - wantAt >= BILI.settleMs || now - wantFirst >= BILI.settleMaxMs) {
    wantKey = '';
    wantFirst = 0;
    void lookup(want);
  } else setTimeout(schedule, BILI.settleMs - (now - wantAt) + 20);
}

// ── 状态报给侧边栏 ──

function status(counts: Pick<BiliTabState, 'cards' | 'shown' | 'pending' | 'unknown'>, waiting: boolean): BiliTabState {
  const current = settings.enabled ? currentVideo() : undefined;
  return {
    enabled: settings.enabled,
    showPubdate: settings.showPubdate,
    waiting,
    ...counts,
    ...(lookupError && settings.showPubdate ? { error: lookupError.message } : {}),
    ...(current ? { current } : {}),
  };
}

let lastCounts = { cards: 0, shown: 0, pending: 0, unknown: 0 };
let lastWaiting = false;
function report(counts: typeof lastCounts, waiting: boolean): void {
  lastCounts = counts;
  lastWaiting = waiting;
  const s = status(counts, waiting);
  const json = JSON.stringify(s);
  if (json === lastStatus) return;
  lastStatus = json;
  try {
    void chrome.runtime.sendMessage({ type: BILI_MSG.state, state: s }).catch(() => undefined);
  } catch {
    teardown();
  }
}

// ── 收藏弹窗 ──

const POP_CSS = `
:host { all: initial; }
.pop { position: fixed; z-index: 2147483000; box-sizing: border-box; width: 300px; max-height: min(480px, calc(100vh - 16px)); overflow: auto; padding: 12px 14px; border-radius: 10px; background: #fff; color: #18191c; border: 1px solid rgba(0, 0, 0, .1); box-shadow: 0 8px 28px rgba(0, 0, 0, .18); font: 13px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
header b { font-size: 13px; }
button { font: inherit; cursor: pointer; }
.x { border: 0; background: none; font-size: 18px; line-height: 1; color: #888; padding: 2px 4px; }
.name { font-weight: 600; margin: 2px 0; overflow-wrap: anywhere; }
.meta { font-size: 12px; color: #61666d; font-variant-numeric: tabular-nums; }
.row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.toggle { border: 1px solid #00aeec; color: #fff; background: #00aeec; border-radius: 6px; padding: 4px 12px; }
.toggle.on { color: #00aeec; background: transparent; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip { display: inline-flex; align-items: center; gap: 2px; padding: 2px 4px 2px 8px; border-radius: 999px; background: #dff6fd; color: #00699a; font-size: 12px; }
.chip button { border: 0; background: none; color: inherit; padding: 0 4px; font-size: 14px; line-height: 1; }
.sugg { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; align-items: center; font-size: 12px; color: #888; }
.sugg button { border: 1px dashed rgba(0, 0, 0, .25); background: none; border-radius: 999px; padding: 1px 8px; font-size: 12px; color: #555; }
.sugg button:hover { border-color: #00aeec; color: #00aeec; }
input { box-sizing: border-box; width: 100%; margin-top: 8px; padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(0, 0, 0, .18); font: inherit; background: transparent; color: inherit; }
input:focus { outline: 2px solid #00aeec; outline-offset: -1px; border-color: transparent; }
.note { font-size: 12px; color: #888; margin: 10px 0 0; }
.err { font-size: 12px; color: #b3261e; margin: 6px 0 0; }
@media (prefers-color-scheme: dark) {
  .pop { background: #232527; color: #e3e5e7; border-color: rgba(255, 255, 255, .14); }
  .meta { color: #aaa; }
  .chip { background: #0d3a4d; color: #8fdcfa; }
  .sugg button { color: #ccc; border-color: rgba(255, 255, 255, .3); }
  input { border-color: rgba(255, 255, 255, .25); }
  .err { color: #ff8a80; }
}
`;

let pop: { host: HTMLElement; root: ShadowRoot; box: HTMLElement; anchor: HTMLElement; video: BiliVideoInput; error?: string } | undefined;

function openPop(anchor: HTMLElement, video: BiliVideoInput): void {
  closePop();
  const host = document.createElement('div');
  host.setAttribute(ATTR, 'bili-pop');
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = POP_CSS;
  const box = document.createElement('div');
  box.className = 'pop';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'TubeMuse 收藏');
  root.append(style, box);
  // 在弹窗里打字、点击不惊动 B 站页面（它的快捷键、"点空白处关闭"之类）
  isolate(host, ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'input', 'wheel']);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePop(true);
  });
  document.body.append(host);
  pop = { host, root, box, anchor, video };
  renderPop();
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

/** 贴着按钮放（下方放不下就放上方）；按钮被拿掉了（列表重画、关了按钮）就关掉 */
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
    const r = (await chrome.runtime.sendMessage({ type: BILI_MSG.op, op })) as { ok?: boolean; error?: string } | undefined;
    if (!r?.ok) error = r?.error ?? '没有保存成功：后台没有应答，稍后再试';
  } catch {
    error = 'TubeMuse 刚更新或重新加载过：刷新这个页面后再试';
  }
  if (!pop) return;
  pop.error = error;
  renderPop();
}

function renderPop(): void {
  if (!pop) return;
  const { video } = pop;
  // 重画时保留输入框里没写完的字和光标
  const draft = pop.root.querySelector<HTMLInputElement>('input');
  const keep = draft?.value ?? '';
  const focused = pop.root.activeElement === draft;
  const item = saved.videos[video.bvid];
  // 查到发布时间之后点开的：用查到的
  const at = video.publishedAt ?? times.get(video.bvid);

  const header = el('header');
  header.append(el('b', undefined, 'TubeMuse 收藏'));
  const x = el('button', 'x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', '关闭');
  x.addEventListener('click', () => closePop(true));
  header.append(x);

  const parts: HTMLElement[] = [header, el('div', 'name', video.title || '（无标题）')];
  const metaBits = [video.upName ? `UP ${video.upName}` : '', at !== undefined ? `发布 ${formatBiliPubdate(at, Date.now(), timeZone)}` : '', video.duration ? formatDuration(video.duration) : ''].filter(Boolean);
  if (metaBits.length) parts.push(el('div', 'meta', metaBits.join(' · ')));

  const save = (tags: string[]) => send({ op: 'save', video: { ...video, ...(at !== undefined ? { publishedAt: at } : {}) }, tags });
  const row = el('div', 'row');
  const toggle = el('button', `toggle${item ? ' on' : ''}`, item ? '移出收藏' : '收藏这个视频');
  toggle.type = 'button';
  toggle.addEventListener('click', () => void (item ? send({ op: 'remove', bvid: video.bvid }) : save([])));
  row.append(toggle);
  if (item) row.append(el('span', 'meta', `已收藏 · ${new Date(item.savedAt).toLocaleDateString('zh-CN')}`));
  parts.push(row);

  if (item?.tags.length) {
    const chips = el('div', 'chips');
    for (const t of item.tags) {
      const chip = el('span', 'chip', `#${t}`);
      const rm = el('button', undefined, '×');
      rm.type = 'button';
      rm.setAttribute('aria-label', `去掉标签 ${t}`);
      rm.addEventListener('click', () => void send({ op: 'tags', bvid: video.bvid, add: [], remove: [t] }));
      chip.append(rm);
      chips.append(chip);
    }
    parts.push(chips);
  }

  const input = el('input');
  input.placeholder = item ? '加标签，回车确认（逗号分隔可一次加几个）' : '加标签并收藏，回车确认';
  input.setAttribute('aria-label', '给这个视频加标签');
  input.value = keep;
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const tags = splitTags(input.value);
    if (!tags.length) return;
    input.value = '';
    void (item ? send({ op: 'tags', bvid: video.bvid, add: tags, remove: [] }) : save(tags));
  });
  parts.push(input);

  const sugg = suggestBiliTags(saved, item?.tags ?? []);
  if (sugg.length) {
    const box = el('div', 'sugg', '常用：');
    for (const t of sugg) {
      const b = el('button', undefined, `+${t}`);
      b.type = 'button';
      b.addEventListener('click', () => void (item ? send({ op: 'tags', bvid: video.bvid, add: [t], remove: [] }) : save([t])));
      box.append(b);
    }
    parts.push(box);
  }
  parts.push(el('p', 'note', '只存在本机，不会在 B 站上收藏。在 TubeMuse 侧边栏的「B站」页查看、筛选、管理标签。'));
  if (pop.error) {
    const err = el('p', 'err', pop.error);
    err.setAttribute('role', 'alert');
    parts.push(err);
  }
  pop.box.replaceChildren(...parts);
  if (focused) input.focus();
  place();
}

// ── 设置与收藏数据 ──

function applySettings(raw: unknown): void {
  const x = (raw as { bili?: Partial<BiliSettings> } | undefined)?.bili;
  const before = settings.showPubdate;
  settings = { ...DEFAULT_SETTINGS.bili, ...(x && typeof x === 'object' ? x : {}) };
  // 刚勾上"显示发布时间"：上一次没查成的立刻再试
  if (settings.showPubdate && !before) lookupError = undefined;
  schedule();
}

function applySaved(raw: unknown): void {
  saved = sanitizeBiliState(raw, Date.now());
  for (const host of document.querySelectorAll<HTMLElement>(`[${ATTR}="bili-save"]`)) {
    const b = buttons.get(host);
    if (b) paintButton(b);
  }
  renderPop();
}

// ── 生命周期 ──

const ours = (n: Node): boolean => n instanceof Element && (n.hasAttribute(ATTR) || !!n.closest(`[${ATTR}]`));
/** 播放器里（弹幕、进度、控制栏、封面上的悬停预览）一直在变，和推荐列表无关：不为它们重扫 */
const inPlayer = (n: Node): boolean => (n instanceof Element ? n : n.parentElement)?.closest('#bilibili-player, .bpx-docker, .bpx-player-container') != null;
const observer = new MutationObserver((records) => {
  if (records.every((r) => ours(r.target) || inPlayer(r.target) || (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(ours)))) return;
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

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse: (s: BiliTabState) => void) => {
  if ((msg as { type?: string } | undefined)?.type !== BILI_MSG.getState) return false;
  sendResponse(status(lastCounts, lastWaiting));
  return false;
});

void chrome.storage.local
  .get(['settings', 'bili'])
  .then((r) => {
    applySettings(r.settings);
    applySaved(r.bili);
  })
  .catch(() => undefined);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || dead) return;
  if (changes.settings) applySettings(changes.settings.newValue);
  if (changes.bili) applySaved(changes.bili.newValue);
});
// 卡片换内容（站内跳转时 B 站复用卡片，只换链接和文字）、"展开"加载出新条目、Vue 接管完（去掉 data-server-rendered）、
// 换视频时 meta 跟着换：都重新扫一遍
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'data-server-rendered', 'content'] });
window.addEventListener('popstate', schedule);
schedule();
