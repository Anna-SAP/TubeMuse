// 小红书网页版（2026-11-03 新增，见 DECISIONS §40）：笔记发布时间、站内链接识别、收藏与标签。
// 纯逻辑，页面脚本、后台、侧边栏共用。
// 发布时间有两个来源，都不发网络请求：
//   1. 页面数据里小红书自己的发布时间（time，毫秒）——个人主页的笔记列表、笔记详情里有，精确；
//   2. 笔记 ID 前 8 位十六进制 = 创建时刻（Unix 秒）——首页、搜索结果只有这个。多数笔记与发布时间一秒不差，
//      定时发布 / 审核后发布的会早几个小时，所以界面标"≈"。

import { XHS } from '../config/defaults';
import { XHS_PAGES } from '../config/endpoints';
import { clip } from './text';
import { formatDateTime } from './time';
import { XHS_BRIDGE_LIMITS } from './xhs-protocol';

export const XHS_MSG = {
  /** 页面脚本 → 后台：收藏 / 移出 / 加减标签（后台校验后写入） */
  op: 'tubemuse:xhs:op',
  /** 侧边栏 → 页面脚本：要当前页的状态 */
  getState: 'tubemuse:xhs:get-state',
  /** 页面脚本 → 侧边栏：当前页的状态变了 */
  state: 'tubemuse:xhs:state',
} as const;

// ── 时间 ──

const HEX24 = /^[0-9a-f]{24}$/;

/** 小红书的笔记 ID、用户 ID：24 位小写十六进制 */
export function isXhsId(x: unknown): x is string {
  return typeof x === 'string' && HEX24.test(x);
}

export function isPlausibleTime(ms: unknown, now: number): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= XHS.idTimeMin && ms <= now + XHS.futureSlackMs;
}

/** 笔记 ID 里的创建时刻（毫秒）；不是合法 ID 或时刻不合理时 undefined */
export function timeFromNoteId(id: string, now: number): number | undefined {
  if (!isXhsId(id)) return undefined;
  const ms = parseInt(id.slice(0, 8), 16) * 1000;
  return isPlausibleTime(ms, now) ? ms : undefined;
}

export type XhsTimeSource = 'page' | 'id';

/** 卡片上显示的时间：页面数据的发布时间原样显示；由 ID 推算的加"≈" */
export function formatXhsTime(at: number, source: XhsTimeSource, timeZone: string): string {
  return `${source === 'id' ? '≈' : ''}${formatDateTime(at, timeZone)}`;
}

/** 页面内助手从页面数据里读到的一条发布时间（未登录时个人主页的笔记没有 ID，只能按位置 + 标题对上） */
export interface XhsTimeEntry {
  id?: string;
  index?: number;
  title?: string;
  time: number;
}

/** 助手的回答是不可信输入（页面能伪造 postMessage）：逐项校验、截断 */
export function sanitizeTimeEntries(raw: unknown, now: number): XhsTimeEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: XhsTimeEntry[] = [];
  for (const e of raw.slice(0, XHS_BRIDGE_LIMITS.maxEntries)) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (!isPlausibleTime(r.time, now)) continue;
    const entry: XhsTimeEntry = { time: r.time };
    if (isXhsId(r.id)) entry.id = r.id;
    if (typeof r.index === 'number' && Number.isInteger(r.index) && r.index >= 0) entry.index = r.index;
    if (typeof r.title === 'string') entry.title = clip(r.title, XHS.titleMaxChars);
    out.push(entry);
  }
  return out;
}

export interface XhsPageTimes {
  byId: Map<string, number>;
  /** 位置 + 标题 → 时间；同一键对上两个不同时间的记 NaN（宁可不显示也不显示错的） */
  byIndexTitle: Map<string, number>;
}

const titleKey = (index: number, title: string) => `${index}\u0000${title.replace(/\s+/g, ' ').trim()}`;

export function indexTimes(entries: readonly XhsTimeEntry[]): XhsPageTimes {
  const byId = new Map<string, number>();
  const byIndexTitle = new Map<string, number>();
  for (const e of entries) {
    if (e.id) byId.set(e.id, e.time);
    if (e.index !== undefined && e.title?.trim()) {
      const k = titleKey(e.index, e.title);
      const prev = byIndexTitle.get(k);
      byIndexTitle.set(k, prev === undefined || prev === e.time ? e.time : NaN);
    }
  }
  return { byId, byIndexTitle };
}

/** 卡片上能读到的东西：笔记 ID（登录后链接里有）、在列表里的位置（data-index）、标题 */
export interface XhsCardInfo {
  noteId?: string;
  index?: number;
  title: string;
}

/** 一张卡片的发布时间：页面数据 > 笔记 ID；都没有时 undefined（界面显示"时间未知"） */
export function cardTime(card: XhsCardInfo, times: XhsPageTimes, now: number): { at: number; source: XhsTimeSource } | undefined {
  const byId = card.noteId ? times.byId.get(card.noteId) : undefined;
  if (byId !== undefined) return { at: byId, source: 'page' };
  if (card.index !== undefined && card.title.trim()) {
    const t = times.byIndexTitle.get(titleKey(card.index, card.title));
    if (t !== undefined && !Number.isNaN(t)) return { at: t, source: 'page' };
  }
  const fromId = card.noteId ? timeFromNoteId(card.noteId, now) : undefined;
  return fromId === undefined ? undefined : { at: fromId, source: 'id' };
}

// ── 站内链接 ──

export type XhsLink = { kind: 'note'; noteId: string; userId?: string } | { kind: 'user'; userId: string };

/** 网址属于小红书网页版（或 e2e 的 mock）时，返回站内路径（以 / 开头）与查询参数 */
export function xhsPath(url: string): { prefix: string; path: string; search: URLSearchParams } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const full = u.origin + u.pathname;
  const prefix = XHS_PAGES.find((p) => full.startsWith(p));
  return prefix ? { prefix, path: '/' + full.slice(prefix.length), search: u.searchParams } : undefined;
}

/** 认出笔记或博主：/explore/<id>、/discovery/item/<id>、/search_result/<id>、/user/profile/<用户>/<笔记>、/user/profile/<用户> */
export function parseXhsPath(path: string): XhsLink | undefined {
  const note = /^\/(?:explore|discovery\/item|search_result)\/([0-9a-f]{24})\/?$/.exec(path);
  if (note) return { kind: 'note', noteId: note[1]! };
  const profile = /^\/user\/profile\/([0-9a-f]{24})(?:\/([0-9a-f]{24}))?\/?$/.exec(path);
  if (!profile) return undefined;
  return profile[2] ? { kind: 'note', noteId: profile[2], userId: profile[1]! } : { kind: 'user', userId: profile[1]! };
}

export function parseXhsUrl(url: string): XhsLink | undefined {
  const p = xhsPath(url);
  return p ? parseXhsPath(p.path) : undefined;
}

/**
 * 收藏里存的链接：站点 + 路径 + xsec_token / xsec_source（从外面打开笔记要带 xsec_token，否则小红书显示"暂时无法浏览"），
 * 其余参数（来源统计之类）去掉。不是小红书网页版的网址、或认不出笔记 / 博主时 undefined。
 */
export function canonicalXhsUrl(url: string): { url: string; link: XhsLink } | undefined {
  const p = xhsPath(url);
  const link = p && parseXhsPath(p.path);
  if (!p || !link) return undefined;
  const keep = new URLSearchParams();
  for (const k of ['xsec_token', 'xsec_source']) {
    const v = p.search.get(k);
    if (v && v.length <= 200) keep.set(k, v);
  }
  const q = keep.toString();
  return { url: `${p.prefix}${p.path.slice(1)}${q ? `?${q}` : ''}`, link };
}

export type XhsPageKind = 'profile' | 'note' | 'feed' | 'other';

/** 当前页面是什么：博主主页、笔记详情、首页 / 搜索（卡片流）、其他 */
export function xhsPageKind(url: string): XhsPageKind {
  const p = xhsPath(url);
  if (!p) return 'other';
  const link = parseXhsPath(p.path);
  if (link?.kind === 'user') return 'profile';
  if (link?.kind === 'note') return 'note';
  return /^\/(?:explore|search_result)?\/?$/.test(p.path) ? 'feed' : 'other';
}

// ── 收藏与标签 ──

export type XhsKind = 'note' | 'user';

export interface XhsSavedNote {
  id: string;
  title: string;
  url: string;
  authorId?: string;
  authorName?: string;
  /** 收藏时读到的发布时间与来源 */
  publishedAt?: number;
  timeSource?: XhsTimeSource;
  savedAt: number;
  tags: string[];
}

export interface XhsSavedUser {
  id: string;
  name: string;
  url: string;
  savedAt: number;
  tags: string[];
}

export interface XhsState {
  notes: Record<string, XhsSavedNote>;
  users: Record<string, XhsSavedUser>;
}

export const emptyXhsState = (): XhsState => ({ notes: {}, users: {} });

/** 页面上的文字：去掉控制字符、合并空白、截断（不劈开 emoji） */
function cleanText(x: unknown, max: number): string {
  return typeof x === 'string' ? clip(x.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(), max).trim() : '';
}

/** 标签：去掉开头的 #、合并空白，最多 maxTagChars 个字；空的不要 */
export function normalizeTag(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^[\s#＃]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return undefined;
  return Array.from(t).slice(0, XHS.maxTagChars).join('').trim() || undefined;
}

/** 输入框里一次写好几个标签：逗号、顿号、分号、换行分开（空格不分，标签里可以有空格） */
export function splitTags(input: string): string[] {
  return input
    .split(/[,，、;；\n]/)
    .map(normalizeTag)
    .filter((t): t is string => !!t);
}

/** 标签比较不分大小写：AI 和 ai 是同一个标签（保留先出现的写法） */
export const tagKey = (t: string): string => t.toLocaleLowerCase();

function mergeTags(current: readonly string[], add: readonly string[], remove: readonly string[] = []): string[] {
  const drop = new Set(remove.map(tagKey));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...current, ...add]) {
    const k = tagKey(t);
    if (drop.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export interface XhsNoteInput {
  id: string;
  title: string;
  url: string;
  authorId?: string;
  authorName?: string;
  publishedAt?: number;
  timeSource?: XhsTimeSource;
}

export interface XhsUserInput {
  id: string;
  name: string;
  url: string;
}

export type XhsOp =
  | { op: 'saveNote'; note: XhsNoteInput; tags: string[] }
  | { op: 'saveUser'; user: XhsUserInput; tags: string[] }
  | { op: 'remove'; kind: XhsKind; id: string }
  | { op: 'tags'; kind: XhsKind; id: string; add: string[]; remove: string[] }
  /** 以下只在侧边栏用：改名（新名字已存在时合并）、删除标签、撤销移出 */
  | { op: 'renameTag'; from: string; to: string }
  | { op: 'deleteTag'; tag: string }
  | { op: 'restore'; kind: 'note'; item: XhsSavedNote }
  | { op: 'restore'; kind: 'user'; item: XhsSavedUser };

/** 页面脚本只能发这几种（改名、删除标签、撤销只在侧边栏） */
const PAGE_OPS = new Set(['saveNote', 'saveUser', 'remove', 'tags']);

function sanitizeNoteInput(raw: unknown, now: number): XhsNoteInput | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const canon = typeof r.url === 'string' ? canonicalXhsUrl(r.url) : undefined;
  if (!isXhsId(r.id) || canon?.link.kind !== 'note' || canon.link.noteId !== r.id) return undefined;
  const note: XhsNoteInput = { id: r.id, title: cleanText(r.title, XHS.titleMaxChars), url: canon.url };
  const authorId = isXhsId(r.authorId) ? r.authorId : canon.link.userId;
  if (authorId) note.authorId = authorId;
  const authorName = cleanText(r.authorName, XHS.nameMaxChars);
  if (authorName) note.authorName = authorName;
  if (isPlausibleTime(r.publishedAt, now) && (r.timeSource === 'page' || r.timeSource === 'id')) {
    note.publishedAt = r.publishedAt;
    note.timeSource = r.timeSource;
  }
  return note;
}

function sanitizeUserInput(raw: unknown): XhsUserInput | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const canon = typeof r.url === 'string' ? canonicalXhsUrl(r.url) : undefined;
  if (!isXhsId(r.id) || canon?.link.kind !== 'user' || canon.link.userId !== r.id) return undefined;
  return { id: r.id, name: cleanText(r.name, XHS.nameMaxChars), url: canon.url };
}

const tagList = (x: unknown): string[] => (Array.isArray(x) ? x.slice(0, XHS.maxTagsPerItem * 2).map(normalizeTag).filter((t): t is string => !!t) : []);
const isKind = (x: unknown): x is XhsKind => x === 'note' || x === 'user';

function sanitizeSavedNote(raw: unknown, now: number): XhsSavedNote | undefined {
  const base = sanitizeNoteInput(raw, now);
  const r = raw as Record<string, unknown> | undefined;
  if (!base || !r || typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) return undefined;
  return { ...base, savedAt: r.savedAt, tags: mergeTags([], tagList(r.tags)).slice(0, XHS.maxTagsPerItem) };
}

function sanitizeSavedUser(raw: unknown): XhsSavedUser | undefined {
  const base = sanitizeUserInput(raw);
  const r = raw as Record<string, unknown> | undefined;
  if (!base || !r || typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) return undefined;
  return { ...base, savedAt: r.savedAt, tags: mergeTags([], tagList(r.tags)).slice(0, XHS.maxTagsPerItem) };
}

/**
 * 校验一条操作。fromPage：来自小红书页面里的脚本（页面内容不可信），只接受收藏 / 移出 / 加减标签。
 * 不合格时 undefined。
 */
export function parseXhsOp(raw: unknown, now: number, fromPage: boolean): XhsOp | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.op !== 'string' || (fromPage && !PAGE_OPS.has(r.op))) return undefined;
  switch (r.op) {
    case 'saveNote': {
      const note = sanitizeNoteInput(r.note, now);
      return note && { op: 'saveNote', note, tags: tagList(r.tags) };
    }
    case 'saveUser': {
      const user = sanitizeUserInput(r.user);
      return user && { op: 'saveUser', user, tags: tagList(r.tags) };
    }
    case 'remove':
      return isKind(r.kind) && isXhsId(r.id) ? { op: 'remove', kind: r.kind, id: r.id } : undefined;
    case 'tags':
      return isKind(r.kind) && isXhsId(r.id) ? { op: 'tags', kind: r.kind, id: r.id, add: tagList(r.add), remove: tagList(r.remove) } : undefined;
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
      if (r.kind === 'note') {
        const item = sanitizeSavedNote(r.item, now);
        return item && { op: 'restore', kind: 'note', item };
      }
      if (r.kind === 'user') {
        const item = sanitizeSavedUser(r.item);
        return item && { op: 'restore', kind: 'user', item };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function withTags<T extends { tags: string[] }>(item: T, add: readonly string[], remove: readonly string[] = []): { item: T; error?: string } {
  const tags = mergeTags(item.tags, add, remove);
  if (tags.length > XHS.maxTagsPerItem) return { item, error: `每条收藏最多 ${XHS.maxTagsPerItem} 个标签` };
  return { item: { ...item, tags } };
}

/** 执行一条操作；超出上限等情况返回原状态与人话原因 */
export function applyXhsOp(state: XhsState, op: XhsOp, now: number): { state: XhsState; error?: string } {
  switch (op.op) {
    case 'saveNote': {
      const prev = state.notes[op.note.id];
      if (!prev && Object.keys(state.notes).length >= XHS.maxItems) return { state, error: `收藏的笔记已满 ${XHS.maxItems} 篇：先在侧边栏移出一些` };
      // 再次收藏同一篇：更新标题、链接、作者；时间只升级（页面数据的发布时间比 ID 推算的准），不降级
      const keepTime = prev?.timeSource === 'page' && op.note.timeSource !== 'page';
      const merged: XhsSavedNote = {
        ...prev,
        ...op.note,
        ...(keepTime ? { publishedAt: prev.publishedAt, timeSource: prev.timeSource } : {}),
        title: op.note.title || prev?.title || '',
        savedAt: prev?.savedAt ?? now,
        tags: prev?.tags ?? [],
      };
      const r = withTags(merged, op.tags);
      return r.error ? { state, error: r.error } : { state: { ...state, notes: { ...state.notes, [op.note.id]: r.item } } };
    }
    case 'saveUser': {
      const prev = state.users[op.user.id];
      if (!prev && Object.keys(state.users).length >= XHS.maxItems) return { state, error: `收藏的博主已满 ${XHS.maxItems} 位：先在侧边栏移出一些` };
      const merged: XhsSavedUser = { ...prev, ...op.user, name: op.user.name || prev?.name || '', savedAt: prev?.savedAt ?? now, tags: prev?.tags ?? [] };
      const r = withTags(merged, op.tags);
      return r.error ? { state, error: r.error } : { state: { ...state, users: { ...state.users, [op.user.id]: r.item } } };
    }
    case 'remove': {
      if (op.kind === 'note') {
        const { [op.id]: _gone, ...notes } = state.notes;
        return { state: { ...state, notes } };
      }
      const { [op.id]: _gone, ...users } = state.users;
      return { state: { ...state, users } };
    }
    case 'tags': {
      const item = op.kind === 'note' ? state.notes[op.id] : state.users[op.id];
      if (!item) return { state, error: '这条已经不在收藏里了：先收藏再加标签' };
      const r = withTags(item, op.add, op.remove);
      if (r.error) return { state, error: r.error };
      return op.kind === 'note'
        ? { state: { ...state, notes: { ...state.notes, [op.id]: r.item as XhsSavedNote } } }
        : { state: { ...state, users: { ...state.users, [op.id]: r.item as XhsSavedUser } } };
    }
    case 'renameTag':
    case 'deleteTag': {
      const from = op.op === 'renameTag' ? op.from : op.tag;
      const replace = op.op === 'renameTag' ? [op.to] : [];
      const fix = <T extends { tags: string[] }>(m: Record<string, T>): Record<string, T> =>
        Object.fromEntries(
          Object.entries(m).map(([id, item]) => {
            const i = item.tags.findIndex((t) => tagKey(t) === tagKey(from));
            if (i < 0) return [id, item];
            // 改名：放在原来的位置；新名字已经有了就合并成一个
            const tags = mergeTags([...item.tags.slice(0, i), ...replace, ...item.tags.slice(i + 1)], []);
            return [id, { ...item, tags }];
          }),
        );
      return { state: { notes: fix(state.notes), users: fix(state.users) } };
    }
    case 'restore':
      return op.kind === 'note'
        ? { state: { ...state, notes: { ...state.notes, [op.item.id]: op.item } } }
        : { state: { ...state, users: { ...state.users, [op.item.id]: op.item } } };
  }
}

/** 存储里读出来的数据：逐条校验，坏的丢掉（旧版本或手改过的数据也能读） */
export function sanitizeXhsState(raw: unknown, now: number): XhsState {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const notes: Record<string, XhsSavedNote> = {};
  const users: Record<string, XhsSavedUser> = {};
  for (const v of Object.values(r.notes && typeof r.notes === 'object' ? r.notes : {})) {
    const n = sanitizeSavedNote(v, now);
    if (n) notes[n.id] = n;
  }
  for (const v of Object.values(r.users && typeof r.users === 'object' ? r.users : {})) {
    const u = sanitizeSavedUser(v);
    if (u) users[u.id] = u;
  }
  return { notes, users };
}

export interface XhsTagCount {
  tag: string;
  count: number;
}

/** 所有标签与用了几次：多的在前，一样多按名字 */
export function tagCounts(state: XhsState): XhsTagCount[] {
  const counts = new Map<string, XhsTagCount>();
  for (const item of [...Object.values(state.notes), ...Object.values(state.users)]) {
    for (const t of item.tags) {
      const c = counts.get(tagKey(t));
      if (c) c.count++;
      else counts.set(tagKey(t), { tag: t, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
}

/** 收藏弹窗里的"常用标签"：还没打在这一条上的、最常用的几个 */
export function suggestTags(state: XhsState, current: readonly string[], n: number = XHS.suggestTags): string[] {
  const have = new Set(current.map(tagKey));
  return tagCounts(state)
    .filter((c) => !have.has(tagKey(c.tag)))
    .slice(0, n)
    .map((c) => c.tag);
}

export type XhsListItem = { kind: 'note'; item: XhsSavedNote } | { kind: 'user'; item: XhsSavedUser };

/** 侧边栏的列表：按类型、标签、关键词（标题、作者、博主名、标签）筛选，最近收藏的在前 */
export function filterXhs(state: XhsState, f: { kind: 'all' | XhsKind; tag?: string; q?: string }): XhsListItem[] {
  const q = f.q?.trim().toLocaleLowerCase() ?? '';
  const tag = f.tag ? tagKey(f.tag) : undefined;
  const all: XhsListItem[] = [
    ...(f.kind !== 'user' ? Object.values(state.notes).map((item) => ({ kind: 'note' as const, item })) : []),
    ...(f.kind !== 'note' ? Object.values(state.users).map((item) => ({ kind: 'user' as const, item })) : []),
  ];
  return all
    .filter(({ item }) => !tag || item.tags.some((t) => tagKey(t) === tag))
    .filter((x) => {
      if (!q) return true;
      const text = x.kind === 'note' ? [x.item.title, x.item.authorName ?? ''] : [x.item.name];
      return [...text, ...x.item.tags].some((s) => s.toLocaleLowerCase().includes(q));
    })
    .sort((a, b) => b.item.savedAt - a.item.savedAt);
}

/** 当前标签页的小红书脚本报给侧边栏的状态（"不静默"：读不到页面数据、找不到卡片都看得见） */
export interface XhsTabState {
  page: XhsPageKind;
  enabled: boolean;
  /** 页面上找到的笔记卡片 */
  cards: number;
  /** 其中显示了页面数据里的发布时间 / 由 ID 推算的时间 / 时间未知 */
  exact: number;
  approx: number;
  unknown: number;
  /** 页面内助手：读到了页面数据 / 页面数据里没有发布时间 / 助手没有应答 */
  pageData: 'ok' | 'none' | 'unavailable';
}
