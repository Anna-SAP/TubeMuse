// B 站网页版（2026-11-25 新增，见 DECISIONS §92）："接下来播放"列表的发布时间、收藏与标签。
// 纯逻辑，页面脚本、后台、侧边栏共用。
// 发布时间：B 站页面上没有，页面数据（window.__INITIAL_STATE__.related）里的推荐列表也没有（2026-11-25 实测，
// 站内跳转之后也没有），所以由扩展后台向 B 站的公开接口 x/article/cards 查（只发 BV 号，不带 Cookie），查过的记在本机。

import { BILI, TAGS } from '../config/defaults';
import { cleanText, countTags, mergeTags, normalizeTag, retag, tagKey, tagList, withTags, type TagCount } from './collection';
import { parseBiliUrl } from './clips';
import { formatDateTime, formatRelative } from './time';

export { normalizeTag, splitTags, tagKey } from './collection';

export const BILI_MSG = {
  /** 页面脚本 → 后台：收藏 / 移出 / 加减标签（后台校验后写入） */
  op: 'tubemuse:bili:op',
  /** 页面脚本 → 后台：这些视频的发布时间（后台查本机缓存，缺的向 B 站接口查） */
  pubdates: 'tubemuse:bili:pubdates',
  /** 页面脚本 → 后台：这个分 P 视频每一 P 的上传时间（视频页右侧的分 P 列表用） */
  parts: 'tubemuse:bili:parts',
  /** 侧边栏 → 页面脚本：要当前页的状态 */
  getState: 'tubemuse:bili:get-state',
  /** 页面脚本 → 侧边栏：当前页的状态变了 */
  state: 'tubemuse:bili:state',
} as const;

// ── 视频 ID 与链接 ──

const BVID = /^BV[0-9A-Za-z]{10}$/;

/** B 站视频的 BV 号：BV 加 10 位字母数字 */
export function isBvid(x: unknown): x is string {
  return typeof x === 'string' && BVID.test(x);
}

/**
 * 页面上的视频链接 → BV 号与规范链接（站点 + /video/<BV 号>/，分 P 的带 ?p=；语言前缀、来源统计参数去掉）。
 * 只认普通视频的 BV 号：av 号、番剧、课程、直播和别的页面返回 undefined。
 */
export function biliVideoFromUrl(url: string): { bvid: string; url: string } | undefined {
  const page = parseBiliUrl(url);
  if (page?.kind !== 'video') return undefined;
  const bvid = page.id.replace(/\.p\d+$/, '');
  return isBvid(bvid) ? { bvid, url: page.url } : undefined;
}

// ── 发布时间 ──

export function isPlausiblePubdate(ms: unknown, now: number): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= BILI.pubdateMin && ms <= now + BILI.futureSlackMs;
}

function ymd(at: number, timeZone: string): string {
  return formatDateTime(at, timeZone).slice(0, 10).replace(/\//g, '-');
}

/**
 * 卡片上显示的发布时间：一眼看出发布了多久——30 天之内写"N 分钟前 / N 小时前 / N 天前"，再早的写日期 YYYY-MM-DD。
 * compact：这一行放不下时用的短写法（日期去掉年份的前两位：22-07-27）。
 */
export function formatBiliPubdate(at: number, now: number, timeZone: string, compact = false): string {
  const diff = Math.max(0, now - at);
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${Math.max(1, min)}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  if (d < BILI.relativeDays) return `${d}天前`;
  const date = ymd(at, timeZone);
  return compact ? date.slice(2) : date;
}

/** 悬停提示：精确到分钟的发布时间与"多久以前"（分 P 列表里的一 P 写"这一 P 上传于"：每一 P 是分开上传的） */
export function biliPubdateHint(at: number, now: number, timeZone: string, kind: 'video' | 'part' = 'video'): string {
  return `${kind === 'part' ? '这一 P 上传于' : '发布于'} ${formatDateTime(at, timeZone)}（${formatRelative(at, now)}）· TubeMuse`;
}

/** 本机记着的发布时间：BV 号 → { 发布时间（毫秒；0 = B 站接口里没有这个视频）, 查的时间 } */
export type BiliPubdateCache = Record<string, { t: number; at: number }>;

/** 从本机记着的里面取：查到过的直接用；接口里没有的过一天再查；没查过的要查 */
export function pubdatesFromCache(cache: BiliPubdateCache, ids: readonly string[], now: number): { known: Record<string, number>; absent: string[]; missing: string[] } {
  const known: Record<string, number> = {};
  const absent: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const e = cache[id];
    if (e && e.t > 0) known[id] = e.t;
    else if (e && now - e.at < BILI.absentRetryMs) absent.push(id);
    else missing.push(id);
  }
  return { known, absent, missing };
}

/** 页面脚本问的那些 ID：当不可信输入，只留 BV 号、去重、限量 */
export function sanitizeBvids(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isBvid))].slice(0, BILI.maxIdsPerAsk);
}

/** B 站接口拒绝 / 拦截了这次请求（不是网络断了）：code 是 B 站自己的错误码 */
export class BiliApiError extends Error {
  constructor(
    message: string,
    /** 被风控拦了（-412、-352、-509）：要退避一阵 */
    readonly blocked: boolean,
  ) {
    super(message);
    this.name = 'BiliApiError';
  }
}

/** B 站接口回答里的 code 不是 0：-412 / -352 / -509 / -799 是被风控拦下（要退避） */
function checkBiliCode(r: Record<string, unknown> | undefined): void {
  if (!r || typeof r.code !== 'number') throw new BiliApiError('B 站接口的回答看不懂（不是预期的格式）', false);
  if (r.code === 0) return;
  const blocked = r.code === -412 || r.code === -352 || r.code === -509 || r.code === -799;
  const msg = typeof r.message === 'string' ? cleanText(r.message, 60) : '';
  throw new BiliApiError(blocked ? `B 站拦下了这次查询（${r.code}${msg ? ` ${msg}` : ''}）：查得太频繁时会这样` : `B 站接口出错（${r.code}${msg ? ` ${msg}` : ''}）`, blocked);
}

/**
 * 解析 x/article/cards 的回答：{ code: 0, data: { "BV…": { bvid, pubdate(秒), … } } }。
 * 只取问到的那些 BV 号的 pubdate（不合理的当没有）；问了但没出现在结果里的记为"接口里没有"。
 */
export function parseCardsResponse(json: unknown, requested: readonly string[], now: number): { times: Record<string, number>; absent: string[] } {
  const r = json && typeof json === 'object' ? (json as Record<string, unknown>) : undefined;
  checkBiliCode(r);
  const data = r!.data && typeof r!.data === 'object' ? (r!.data as Record<string, unknown>) : {};
  const times: Record<string, number> = {};
  const absent: string[] = [];
  for (const id of requested) {
    const v = data[id] as Record<string, unknown> | undefined;
    const sec = v && typeof v === 'object' ? v.pubdate : undefined;
    const ms = typeof sec === 'number' ? sec * 1000 : NaN;
    if ((v?.bvid === undefined || v.bvid === id) && isPlausiblePubdate(ms, now)) times[id] = ms;
    else absent.push(id);
  }
  return { times, absent };
}

/** 把查到的记进本机：满了先丢最早查的 */
export function mergePubdateCache(cache: BiliPubdateCache, times: Record<string, number>, absent: readonly string[], now: number, max: number = BILI.cacheMax): BiliPubdateCache {
  const next: BiliPubdateCache = { ...cache };
  for (const [id, t] of Object.entries(times)) next[id] = { t, at: now };
  for (const id of absent) next[id] = { t: 0, at: now };
  const ids = Object.keys(next);
  if (ids.length <= max) return next;
  const keep = ids.sort((a, b) => next[b]!.at - next[a]!.at).slice(0, max);
  return Object.fromEntries(keep.map((id) => [id, next[id]!]));
}

export function sanitizePubdateCache(raw: unknown, now: number): BiliPubdateCache {
  const out: BiliPubdateCache = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isBvid(id) || !v || typeof v !== 'object') continue;
    const { t, at } = v as Record<string, unknown>;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    if (t === 0 || isPlausiblePubdate(t, now)) out[id] = { t: t as number, at };
  }
  return out;
}

// ── 分 P 视频每一 P 的上传时间 ──

/** cid（每一 P 的编号）：数字 */
export const isCid = (x: unknown): x is string => typeof x === 'string' && /^\d{1,20}$/.test(x);

/**
 * 解析 x/player/pagelist?bvid=… 的回答（2026-11-25 实测）：{ code: 0, data: [{ cid, page, part, duration, ctime(秒) }, …] }。
 * ctime 是这一 P 上传的时间（同一个视频的各 P 可以隔几年上传）；是 0 或不合理的不要（那一 P 显示"时间未知"）
 */
export function parsePagelistResponse(json: unknown, now: number): Record<string, number> {
  const r = json && typeof json === 'object' ? (json as Record<string, unknown>) : undefined;
  checkBiliCode(r);
  const out: Record<string, number> = {};
  for (const p of (Array.isArray(r!.data) ? r!.data : []).slice(0, BILI.maxParts)) {
    if (!p || typeof p !== 'object') continue;
    const { cid, ctime } = p as Record<string, unknown>;
    const id = typeof cid === 'number' && Number.isSafeInteger(cid) && cid > 0 ? String(cid) : undefined;
    const ms = typeof ctime === 'number' ? ctime * 1000 : NaN;
    if (id && isPlausiblePubdate(ms, now)) out[id] = ms;
  }
  return out;
}

/** 本机记着的分 P 上传时间：BV 号 → { 查的时间, cid → 上传时间（毫秒） } */
export type BiliPartsCache = Record<string, { at: number; parts: Record<string, number> }>;

export function sanitizePartsCache(raw: unknown, now: number): BiliPartsCache {
  const out: BiliPartsCache = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [bvid, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isBvid(bvid) || !v || typeof v !== 'object') continue;
    const { at, parts } = v as Record<string, unknown>;
    if (typeof at !== 'number' || !Number.isFinite(at) || !parts || typeof parts !== 'object') continue;
    const clean: Record<string, number> = {};
    for (const [cid, t] of Object.entries(parts as Record<string, unknown>).slice(0, BILI.maxParts)) if (isCid(cid) && isPlausiblePubdate(t, now)) clean[cid] = t;
    out[bvid] = { at, parts: clean };
  }
  return out;
}

/** 记进本机：满了先丢最早查的 */
export function mergePartsCache(cache: BiliPartsCache, bvid: string, parts: Record<string, number>, now: number, max: number = BILI.partsCacheMax): BiliPartsCache {
  const next: BiliPartsCache = { ...cache, [bvid]: { at: now, parts } };
  const ids = Object.keys(next);
  if (ids.length <= max) return next;
  return Object.fromEntries(ids.sort((a, b) => next[b]!.at - next[a]!.at).slice(0, max).map((id) => [id, next[id]!]));
}

/** 后台对"这个视频每一 P 的上传时间"的回答 */
export type BiliPartsReply = { ok: true; parts: Record<string, number> } | { ok: false; error: string; off?: boolean };

/** 后台对"这些视频的发布时间"的回答 */
export type BiliPubdateReply =
  /** times：查到的；absent：接口里没有的（删了、不公开、番剧之类） */
  | { ok: true; times: Record<string, number>; absent: string[] }
  /** 没查成：已经知道的照样给（times；absent：已经知道接口里没有的），error 是人话原因 */
  | { ok: false; times: Record<string, number>; absent?: string[]; error: string; off?: boolean };

// ── 收藏与标签 ──

export interface BiliVideoInput {
  bvid: string;
  title: string;
  /** 视频页的规范链接（biliVideoFromUrl） */
  url: string;
  /** UP 主的名字与 UID（页面上读到的；读不到就没有） */
  upName?: string;
  upMid?: string;
  /** 发布时间（毫秒） */
  publishedAt?: number;
  /** 时长（秒） */
  duration?: number;
}

export interface BiliSavedVideo extends BiliVideoInput {
  savedAt: number;
  tags: string[];
}

export interface BiliState {
  videos: Record<string, BiliSavedVideo>;
}

export const emptyBiliState = (): BiliState => ({ videos: {} });

export type BiliOp =
  | { op: 'save'; video: BiliVideoInput; tags: string[] }
  | { op: 'remove'; bvid: string }
  | { op: 'tags'; bvid: string; add: string[]; remove: string[] }
  /** 以下只在侧边栏用：改名（新名字已存在时合并）、删除标签、撤销移出 */
  | { op: 'renameTag'; from: string; to: string }
  | { op: 'deleteTag'; tag: string }
  | { op: 'restore'; item: BiliSavedVideo };

/** 页面脚本只能发这几种（改名、删除标签、撤销只在侧边栏） */
const PAGE_OPS = new Set(['save', 'remove', 'tags']);

const UP_MID = /^\d{1,20}$/;

/** 时长：页面上的"1:02:03 / 02:03"或秒数 */
export function parseBiliDuration(x: unknown): number | undefined {
  if (typeof x === 'number') return Number.isInteger(x) && x > 0 && x <= BILI.maxDurationSec ? x : undefined;
  if (typeof x !== 'string') return undefined;
  const m = /^\s*(?:(\d{1,4}):)?(\d{1,3}):(\d{2})\s*$/.exec(x);
  if (!m) return undefined;
  const sec = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return sec > 0 && sec <= BILI.maxDurationSec && Number(m[3]) < 60 ? sec : undefined;
}

function sanitizeVideoInput(raw: unknown, now: number): BiliVideoInput | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const page = typeof r.url === 'string' ? biliVideoFromUrl(r.url) : undefined;
  if (!isBvid(r.bvid) || page?.bvid !== r.bvid) return undefined;
  const video: BiliVideoInput = { bvid: r.bvid, title: cleanText(r.title, BILI.titleMaxChars), url: page.url };
  const upName = cleanText(r.upName, BILI.nameMaxChars);
  if (upName) video.upName = upName;
  if (typeof r.upMid === 'string' && UP_MID.test(r.upMid)) video.upMid = r.upMid;
  if (isPlausiblePubdate(r.publishedAt, now)) video.publishedAt = r.publishedAt;
  const duration = parseBiliDuration(r.duration);
  if (duration !== undefined) video.duration = duration;
  return video;
}

function sanitizeSaved(raw: unknown, now: number): BiliSavedVideo | undefined {
  const base = sanitizeVideoInput(raw, now);
  const r = raw as Record<string, unknown> | undefined;
  if (!base || !r || typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) return undefined;
  return { ...base, savedAt: r.savedAt, tags: mergeTags([], tagList(r.tags)).slice(0, TAGS.maxPerItem) };
}

/**
 * 校验一条操作。fromPage：来自 B 站页面里的脚本（页面内容不可信），只接受收藏 / 移出 / 加减标签。
 * 不合格时 undefined。
 */
export function parseBiliOp(raw: unknown, now: number, fromPage: boolean): BiliOp | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.op !== 'string' || (fromPage && !PAGE_OPS.has(r.op))) return undefined;
  switch (r.op) {
    case 'save': {
      const video = sanitizeVideoInput(r.video, now);
      return video && { op: 'save', video, tags: tagList(r.tags) };
    }
    case 'remove':
      return isBvid(r.bvid) ? { op: 'remove', bvid: r.bvid } : undefined;
    case 'tags':
      return isBvid(r.bvid) ? { op: 'tags', bvid: r.bvid, add: tagList(r.add), remove: tagList(r.remove) } : undefined;
    case 'renameTag': {
      const from = normalizeTag(r.from);
      const to = normalizeTag(r.to);
      return from && to ? { op: 'renameTag', from, to } : undefined;
    }
    case 'deleteTag': {
      const tag = normalizeTag(r.tag);
      return tag ? { op: 'deleteTag', tag } : undefined;
    }
    case 'restore': {
      const item = sanitizeSaved(r.item, now);
      return item && { op: 'restore', item };
    }
    default:
      return undefined;
  }
}

/** 执行一条操作；超出上限等情况返回原状态与人话原因 */
export function applyBiliOp(state: BiliState, op: BiliOp, now: number): { state: BiliState; error?: string } {
  switch (op.op) {
    case 'save': {
      const prev = state.videos[op.video.bvid];
      if (!prev && Object.keys(state.videos).length >= BILI.maxItems) return { state, error: `收藏的视频已满 ${BILI.maxItems} 个：先在侧边栏「B站」页移出一些` };
      // 再次收藏同一个：用新读到的标题、UP 主等更新，新的没读到的项保留旧的；收藏时间与标签不变
      const merged: BiliSavedVideo = {
        ...prev,
        ...op.video,
        title: op.video.title || prev?.title || '',
        ...(op.video.upName ? {} : prev?.upName ? { upName: prev.upName } : {}),
        ...(op.video.upMid ? {} : prev?.upMid ? { upMid: prev.upMid } : {}),
        ...(op.video.publishedAt !== undefined ? {} : prev?.publishedAt !== undefined ? { publishedAt: prev.publishedAt } : {}),
        ...(op.video.duration !== undefined ? {} : prev?.duration !== undefined ? { duration: prev.duration } : {}),
        savedAt: prev?.savedAt ?? now,
        tags: prev?.tags ?? [],
      };
      const r = withTags(merged, op.tags);
      return r.error ? { state, error: r.error } : { state: { videos: { ...state.videos, [op.video.bvid]: r.item } } };
    }
    case 'remove': {
      const { [op.bvid]: _gone, ...videos } = state.videos;
      return { state: { videos } };
    }
    case 'tags': {
      const item = state.videos[op.bvid];
      if (!item) return { state, error: '这个视频已经不在收藏里了：先收藏再加标签' };
      const r = withTags(item, op.add, op.remove);
      return r.error ? { state, error: r.error } : { state: { videos: { ...state.videos, [op.bvid]: r.item } } };
    }
    case 'renameTag':
      return { state: { videos: retag(state.videos, op.from, [op.to]) } };
    case 'deleteTag':
      return { state: { videos: retag(state.videos, op.tag, []) } };
    case 'restore':
      return { state: { videos: { ...state.videos, [op.item.bvid]: op.item } } };
  }
}

/** 存储里读出来的数据：逐条校验，坏的丢掉（旧版本或手改过的数据也能读） */
export function sanitizeBiliState(raw: unknown, now: number): BiliState {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const videos: Record<string, BiliSavedVideo> = {};
  for (const v of Object.values(r.videos && typeof r.videos === 'object' ? r.videos : {})) {
    const item = sanitizeSaved(v, now);
    if (item) videos[item.bvid] = item;
  }
  return { videos };
}

/** 所有标签与用了几次：多的在前，一样多按名字 */
export function biliTagCounts(state: BiliState): TagCount[] {
  return countTags(Object.values(state.videos));
}

/** 收藏弹窗里的"常用标签"：还没打在这一个上的、最常用的几个 */
export function suggestBiliTags(state: BiliState, current: readonly string[], n: number = BILI.suggestTags): string[] {
  const have = new Set(current.map(tagKey));
  return biliTagCounts(state)
    .filter((c) => !have.has(tagKey(c.tag)))
    .slice(0, n)
    .map((c) => c.tag);
}

/** 侧边栏的列表：按标签、关键词（标题、UP 主、标签）筛选，最近收藏的在前 */
export function filterBili(state: BiliState, f: { tag?: string; q?: string }): BiliSavedVideo[] {
  const q = f.q?.trim().toLocaleLowerCase() ?? '';
  const tag = f.tag ? tagKey(f.tag) : undefined;
  return Object.values(state.videos)
    .filter((v) => !tag || v.tags.some((t) => tagKey(t) === tag))
    .filter((v) => !q || [v.title, v.upName ?? '', v.bvid, ...v.tags].some((s) => s.toLocaleLowerCase().includes(q)))
    .sort((a, b) => b.savedAt - a.savedAt);
}

/** 当前标签页的 B 站脚本报给侧边栏的状态（"不静默"：在等页面、查不到、被拦了都看得见） */
export interface BiliTabState {
  enabled: boolean;
  showPubdate: boolean;
  /** B 站还没把服务端渲染的页面接管完（这之前往列表里加东西会让 B 站整页重画），先等着 */
  waiting: boolean;
  /** 右侧列表（"接下来播放"、播放列表、合集 / 分 P）里找到的条目 */
  cards: number;
  /** 其中显示了发布时间的 / 还在查的 / B 站接口里查不到的 */
  shown: number;
  pending: number;
  unknown: number;
  /** 上一次查发布时间没成功的原因 */
  error?: string;
  /** 当前是视频页时，这个视频（从页面自己声明的标题、作者、发布时间读） */
  current?: BiliVideoInput;
}
