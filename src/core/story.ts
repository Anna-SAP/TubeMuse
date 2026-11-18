// 故事（2026-11-18 新增，见 DECISIONS §88）：读你停留的新闻 / 帖子，联网调研它的来龙去脉，分清已证实的事实、说法与推测。
// 纯逻辑：校验页面交回来的内容、把联网调研的原始结果整理成"带编号的来源 + 带编号引用的笔记"、校验大模型整理出的结果、
// 本机记录（缓存、历史）。页面读取函数在 content/story-reader.ts，大模型调用在 services/story-service.ts。
//
// 可信度的底线由这里守：
// - 来源只能是联网搜索真的返回过、或回答里真的引用过的网页（来自服务方的搜索结果，不是大模型自己写的网址）；
// - 整理结果里引用的来源编号必须在这份清单里，对不上的去掉；
// - 标成"已证实"的说法，必须至少有一个清单里的来源（只有页面本身不算），否则降为"只是说法"，并告诉你降了几条。

import { STORY } from '../config/defaults';
import type { StoryPageRead, StoryXPostRead } from '../content/story-reader';
import { clip, hashString } from './text';

// ── 页面 ──

export interface StoryPost {
  author?: string;
  handle?: string;
  text: string;
  /** ISO 时间 */
  time?: string;
  timeLabel?: string;
  url?: string;
  metrics?: string;
  media: string[];
}

export type StoryPlatform = 'x' | 'web' | 'paste';

/** 校验过的页面内容：发给大模型、存进本机的都是这一份 */
export interface StoryPage {
  platform: StoryPlatform;
  /** 去掉跟踪参数的链接（粘贴的文字没有链接时为空串） */
  url: string;
  title: string;
  /** 站点名（或域名） */
  site: string;
  authors: string[];
  /** 发布时间：页面声明的原样（多为 ISO） */
  published?: string;
  modified?: string;
  description?: string;
  lang?: string;
  /** 页面声明的类型（NewsArticle…） */
  kind?: string;
  /** 正文（X：主帖的正文） */
  text: string;
  /** 正文太长、只读了前面一部分 */
  truncated: boolean;
  /** 你在页面上选中的文字 */
  selection?: string;
  /** X：主帖、被引用的帖子、链接卡片 */
  post?: StoryPost;
  quoted?: StoryPost;
  card?: { text: string; url?: string };
  /** X：帖子 ID */
  statusId?: string;
  readAt: number;
}

export type StoryReadResult =
  | { ok: true; page: StoryPage }
  | { ok: false; reason: 'skipped' | 'x-nopost' | 'x-not-found' | 'empty' | 'bad'; url?: string };

const str = (v: unknown, max: number): string => (typeof v === 'string' ? clip(v.replace(/\u0000/g, '').trim(), max) : '');
const opt = (v: unknown, max: number): string | undefined => str(v, max) || undefined;

/**
 * 跟踪参数：不是文章地址的一部分，有的还带着能认出你的标识（分享者、收件人、广告点击）。
 * 只去掉这些公认的；别的参数（有的站用 ?id= 区分文章）原样保留
 */
const TRACKING_PARAM = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|igshid|mc_cid|mc_eid|ref_src|ref_url|smid|cmpid|ocid|spm|share_source|share_medium|xtor|at_medium|at_campaign|at_custom\d*|sh|_ga|__twitter_impression)$/i;

/** 只认 http(s) 链接；去掉跟踪参数、#、账号密码 */
export function cleanStoryUrl(v: unknown): string {
  if (typeof v !== 'string') return '';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return '';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  const keys: string[] = [];
  u.searchParams.forEach((_v, k) => keys.push(k));
  for (const k of keys) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  u.hash = '';
  u.username = '';
  u.password = '';
  return u.toString();
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** ISO 或页面原样的时间：认得出就规范成 ISO */
function timeOf(v: unknown): string | undefined {
  const s = str(v, 80);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) && t > Date.UTC(1990, 0, 1) ? new Date(t).toISOString() : s;
}

function sanitizePost(raw: StoryXPostRead | undefined, url?: string): StoryPost | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const text = str(raw.text, STORY.maxPostChars);
  const media = Array.isArray(raw.media) ? raw.media.map((m) => str(m, 320)).filter((m) => /^(video|gif|photo)(:|$)/.test(m)).slice(0, 8) : [];
  const author = opt(raw.name, STORY.nameMaxChars);
  const handle = typeof raw.handle === 'string' && /^@\w{1,30}$/.test(raw.handle) ? raw.handle : undefined;
  if (!text && !author && !media.length) return undefined;
  // 主帖用规范链接（不带分享参数）；被引用的帖子用页面上它自己的链接
  const link = url ?? cleanStoryUrl(raw.url);
  const time = timeOf(raw.time);
  return {
    ...(author ? { author } : {}),
    ...(handle ? { handle } : {}),
    text,
    ...(time ? { time } : {}),
    ...(opt(raw.timeLabel, 80) ? { timeLabel: opt(raw.timeLabel, 80)! } : {}),
    ...(link ? { url: link } : {}),
    ...(opt(raw.metrics, 400) ? { metrics: opt(raw.metrics, 400)! } : {}),
    media,
  };
}

/** X 帖子的规范链接：x.com/<用户>/status/<ID>（不带分享参数） */
function xPostUrl(raw: { url: string; user: string; statusId: string }): string {
  try {
    const u = new URL(raw.url);
    const at = u.pathname.indexOf(`/${raw.user}/status/${raw.statusId}`);
    return at >= 0 ? `${u.origin}${u.pathname.slice(0, at)}/${raw.user}/status/${raw.statusId}` : cleanStoryUrl(raw.url);
  } catch {
    return '';
  }
}

/** 页面读取函数交回来的东西一律当不可信输入：类型、长度、链接都校验一遍 */
export function sanitizeStoryRead(raw: unknown, now: number): StoryReadResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'bad' };
  const r = raw as StoryPageRead;
  const url = cleanStoryUrl(r.url);
  if (r.kind === 'skipped') return { ok: false, reason: 'skipped', url };
  if (r.kind === 'x-nopost') return { ok: false, reason: 'x-nopost', url };
  const selection = opt(r.selection, STORY.maxSelectionChars);
  if (r.kind === 'x') {
    if (typeof r.statusId !== 'string' || !/^\d{5,25}$/.test(r.statusId) || typeof r.user !== 'string' || !/^\w{1,30}$/.test(r.user)) return { ok: false, reason: 'bad' };
    const link = xPostUrl({ url: str(r.url, 2000), user: r.user, statusId: r.statusId });
    const post = sanitizePost(r.post, link);
    if (!post) return { ok: false, reason: 'x-not-found', url: link };
    const quoted = sanitizePost(r.quoted);
    const cardText = r.card && typeof r.card === 'object' ? str(r.card.text, 400) : '';
    const cardUrl = r.card && typeof r.card === 'object' ? cleanStoryUrl(r.card.url) : '';
    const who = post.author ?? post.handle ?? `@${r.user}`;
    const gist = post.text || (quoted?.text ? `引用：${quoted.text}` : post.media.length ? '（只有图片 / 视频）' : '');
    return {
      ok: true,
      page: {
        platform: 'x',
        url: link,
        title: clip(`${who}：${gist.replace(/\s+/g, ' ')}`, STORY.titleMaxChars),
        site: 'X',
        authors: [post.handle ? `${post.author ?? ''} ${post.handle}`.trim() : who],
        ...(post.time ? { published: post.time } : {}),
        text: post.text,
        truncated: false,
        ...(selection ? { selection } : {}),
        post,
        ...(quoted ? { quoted } : {}),
        ...(cardText ? { card: { text: cardText, ...(cardUrl ? { url: cardUrl } : {}) } } : {}),
        statusId: r.statusId,
        readAt: now,
      },
    };
  }
  if (r.kind !== 'page') return { ok: false, reason: 'bad' };
  const text = str(r.text, STORY.maxTextChars);
  const description = opt(r.description, 1000);
  if (!text && !description && !selection) return { ok: false, reason: 'empty', url };
  const canonical = cleanStoryUrl(r.canonical);
  // 规范链接和当前网址不在同一个站上的不用（有的站把它指向首页或别的域名）
  const link = canonical && hostOf(canonical) === hostOf(url) ? canonical : url;
  const title = opt(r.title, STORY.titleMaxChars) ?? opt(r.docTitle, STORY.titleMaxChars) ?? hostOf(link);
  const authors = Array.isArray(r.authors) ? [...new Set(r.authors.map((a) => str(a, STORY.nameMaxChars)).filter((a) => !!a && !/^https?:/i.test(a)))].slice(0, 6) : [];
  const published = timeOf(r.published);
  const modified = timeOf(r.modified);
  return {
    ok: true,
    page: {
      platform: 'web',
      url: link,
      title,
      site: opt(r.siteName, STORY.nameMaxChars) ?? hostOf(link),
      authors,
      ...(published ? { published } : {}),
      ...(modified ? { modified } : {}),
      ...(description ? { description } : {}),
      ...(opt(r.lang, 20) ? { lang: opt(r.lang, 20)! } : {}),
      ...(opt(r.ldType, 80) ? { kind: opt(r.ldType, 80)! } : {}),
      text,
      truncated: r.truncated === true || (typeof r.text === 'string' && r.text.length > STORY.maxTextChars),
      ...(selection ? { selection } : {}),
      readAt: now,
    },
  };
}

/** 你自己粘贴进来的文字（读不了页面的站、或者想单独查一段话时） */
export function pastedStoryPage(text: string, link: string, now: number): StoryPage | undefined {
  const body = str(text, STORY.maxTextChars);
  if (!body) return undefined;
  const url = cleanStoryUrl(link.trim());
  return {
    platform: 'paste',
    url,
    title: clip(body.replace(/\s+/g, ' '), 80),
    site: url ? hostOf(url) : '你粘贴的文字',
    authors: [],
    text: body,
    truncated: false,
    readAt: now,
  };
}

/** 同一个页面认作同一个故事：X 按帖子 ID，网页按链接，粘贴的按文字 */
export function storyKey(page: StoryPage): string {
  if (page.platform === 'x' && page.statusId) return `x:${page.statusId}`;
  if (page.platform === 'web') return `web:${page.url}`;
  return `paste:${hashString(`${page.url}\u0000${page.text}`)}`;
}

// ── 联网调研的原始结果 → 来源清单 + 带编号引用的笔记 ──

/** 服务方交回来的联网调研结果（与服务方无关的形状；services/llm.ts 负责从各家的响应里取出） */
export interface ResearchRaw {
  /** 回答的文字，按顺序；每一段带着它引用的网页 */
  segments: { text: string; cites: { url: string; title?: string; quote?: string }[] }[];
  /** 搜索返回过的网页 */
  results: { url: string; title?: string; date?: string }[];
  /** 搜了什么 */
  queries: string[];
  /** 搜索出错的错误码（服务方在结果里报告，不是整次请求失败） */
  errors: string[];
}

export interface StorySource {
  /** S1、S2… */
  id: string;
  url: string;
  title: string;
  site: string;
  /** 搜索结果给的页面日期（原样，例如 "November 17, 2026"） */
  date?: string;
  /** 回答里引用过的原文片段 */
  quotes: string[];
  /** 回答里引用过它（不只是在搜索结果里出现过） */
  cited: boolean;
}

export interface ResearchNotes {
  notes: string;
  sources: StorySource[];
  queries: string[];
  errors: string[];
}

/** 来源去重用的键：协议、www、末尾斜杠、# 都不算 */
function sourceKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
  } catch {
    return url;
  }
}

/** 把调研结果整理成：编号的来源清单（先列回答里引用过的，再列只在搜索结果里出现过的）+ 句尾带 [S#] 的笔记 */
export function assembleResearch(raw: ResearchRaw): ResearchNotes {
  const byKey = new Map<string, StorySource>();
  const order: StorySource[] = [];
  const add = (url: string, title: string | undefined, date: string | undefined, cited: boolean): StorySource | undefined => {
    const clean = cleanStoryUrl(url);
    if (!clean) return undefined;
    const key = sourceKey(clean);
    let s = byKey.get(key);
    if (!s) {
      if (order.length >= STORY.maxSources) return undefined;
      s = { id: '', url: clean, title: str(title, STORY.titleMaxChars) || hostOf(clean), site: hostOf(clean), quotes: [], cited: false };
      byKey.set(key, s);
      order.push(s);
    }
    if (!s.date && date) s.date = str(date, 60) || undefined;
    if (s.title === s.site && title) s.title = str(title, STORY.titleMaxChars) || s.title;
    if (cited) s.cited = true;
    return s;
  };
  // 先过一遍引用（编号按回答里第一次引用的先后），再补搜索结果
  for (const seg of raw.segments) for (const c of seg.cites) add(c.url, c.title, undefined, true);
  for (const r of raw.results) add(r.url, r.title, r.date, false);
  order.sort((a, b) => Number(b.cited) - Number(a.cited));
  order.forEach((s, i) => (s.id = `S${i + 1}`));
  const parts: string[] = [];
  for (const seg of raw.segments) {
    const ids = [...new Set(seg.cites.map((c) => byKey.get(sourceKey(cleanStoryUrl(c.url)))?.id).filter((id): id is string => !!id))];
    for (const c of seg.cites) {
      const s = byKey.get(sourceKey(cleanStoryUrl(c.url)));
      const q = str(c.quote, STORY.quoteMaxChars);
      if (s && q && s.quotes.length < STORY.quotesPerSource && !s.quotes.includes(q)) s.quotes.push(q);
    }
    parts.push(ids.length ? `${seg.text.replace(/\s+$/, '')} [${ids.join(', ')}]` : seg.text);
  }
  return {
    notes: clip(parts.join('').trim(), STORY.notesMaxChars),
    sources: order,
    queries: [...new Set(raw.queries.map((q) => str(q, 200)).filter((q) => !!q))].slice(0, 20),
    errors: [...new Set(raw.errors.map((e) => str(e, 60)).filter((e) => !!e))],
  };
}

// ── 整理结果 ──

export const STORY_STATUSES = ['confirmed', 'claimed', 'disputed', 'unverified'] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

export const STORY_STATUS_LABELS: Record<StoryStatus, string> = {
  confirmed: '已证实',
  claimed: '只是说法',
  disputed: '有争议',
  unverified: '查无实据',
};

/** 图例里的一句话解释 */
export const STORY_STATUS_HINTS: Record<StoryStatus, string> = {
  confirmed: '有可查的可靠来源直接证实（原始文件、记录、当事方正式声明，或多家独立媒体一致报道）',
  claimed: '只有某一方的说法或单一来源，没有独立证实',
  disputed: '有可靠来源反驳，或各方说法互相矛盾',
  unverified: '搜索没有找到任何出处',
};

/** "页面本身"作为来源时的编号 */
export const PAGE_SOURCE_ID = 'P';

export interface StoryClaim {
  text: string;
  speaker: string;
  status: StoryStatus;
  note: string;
  sources: string[];
  /** 大模型标成"已证实"、但没有可查的来源，这里降成了"只是说法" */
  downgraded?: boolean;
}

export interface StoryFact {
  text: string;
  status: StoryStatus;
  note: string;
  sources: string[];
  downgraded?: boolean;
}

export interface StoryBrief {
  headline: string;
  summary: string;
  claims: StoryClaim[];
  timeline: { when: string; event: string; sources: string[] }[];
  perspectives: { who: string; stance: string; sources: string[] }[];
  context: StoryFact[];
  analysis: { text: string; sources: string[] }[];
  openQuestions: string[];
  caveat: string;
  /** 降级了几条（"已证实"但没有来源） */
  downgraded: number;
  /** 去掉了几个对不上的来源编号 */
  droppedRefs: number;
}

/** 解析并校验整理结果；结构不对时返回 undefined（不拿半截结果充数） */
export function parseStoryBrief(value: unknown, sourceIds: readonly string[]): StoryBrief | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const L = STORY.limits;
  const known = new Set([...sourceIds, PAGE_SOURCE_ID]);
  let dropped = 0;
  let downgraded = 0;
  const refs = (x: unknown): string[] => {
    if (!Array.isArray(x)) return [];
    const out: string[] = [];
    for (const r of x) {
      const id = typeof r === 'string' ? r.trim().replace(/^\[|\]$/g, '').toUpperCase() : '';
      if (known.has(id)) {
        if (!out.includes(id)) out.push(id);
      } else dropped++;
    }
    return out;
  };
  const list = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.filter((i): i is Record<string, unknown> => !!i && typeof i === 'object') : []);
  const status = (x: unknown): StoryStatus => (STORY_STATUSES as readonly string[]).includes(x as string) ? (x as StoryStatus) : 'unverified';
  /** "已证实"必须至少有一个清单里的来源（页面本身不算） */
  const settle = <T extends { status: StoryStatus; sources: string[]; downgraded?: boolean }>(item: T): T => {
    if (item.status === 'confirmed' && !item.sources.some((s) => s !== PAGE_SOURCE_ID)) {
      downgraded++;
      return { ...item, status: 'claimed', downgraded: true };
    }
    return item;
  };
  const headline = str(v.headline, L.shortChars);
  const summary = str(v.summary, L.textChars * 2);
  if (!headline && !summary) return undefined;
  const claims = list(v.claims)
    .map((c) => settle({ text: str(c.text, L.textChars), speaker: str(c.speaker, STORY.nameMaxChars), status: status(c.status), note: str(c.note, L.textChars), sources: refs(c.sources) }))
    .filter((c) => !!c.text)
    .slice(0, L.claims);
  const context = list(v.context)
    .map((c) => settle({ text: str(c.text, L.textChars), status: status(c.status), note: str(c.note, L.textChars), sources: refs(c.sources) }))
    .filter((c) => !!c.text)
    .slice(0, L.context);
  return {
    headline,
    summary,
    claims,
    timeline: list(v.timeline)
      .map((t) => ({ when: str(t.when, 40) || '日期不详', event: str(t.event, L.textChars), sources: refs(t.sources) }))
      .filter((t) => !!t.event)
      .slice(0, L.timeline),
    perspectives: list(v.perspectives)
      .map((p) => ({ who: str(p.who, STORY.nameMaxChars), stance: str(p.stance, L.textChars), sources: refs(p.sources) }))
      .filter((p) => !!p.who && !!p.stance)
      .slice(0, L.perspectives),
    context,
    analysis: list(v.analysis)
      .map((a) => ({ text: str(a.text, L.textChars), sources: refs(a.sources) }))
      .filter((a) => !!a.text)
      .slice(0, L.analysis),
    openQuestions: (Array.isArray(v.openQuestions) ? v.openQuestions : []).map((q) => str(q, L.textChars)).filter((q) => !!q).slice(0, L.openQuestions),
    caveat: str(v.caveat, L.textChars),
    downgraded,
    droppedRefs: dropped,
  };
}

/** 各状态各有几条（说法与背景事实一起数） */
export function statusCounts(brief: StoryBrief): Record<StoryStatus, number> {
  const counts: Record<StoryStatus, number> = { confirmed: 0, claimed: 0, disputed: 0, unverified: 0 };
  for (const c of [...brief.claims, ...brief.context]) counts[c.status]++;
  return counts;
}

/** 被整理结果引用过的来源编号（来源列表里标出"被引用"） */
export function referencedSources(brief: StoryBrief): Set<string> {
  const ids = new Set<string>();
  const addAll = (xs: { sources: string[] }[]) => xs.forEach((x) => x.sources.forEach((s) => ids.add(s)));
  addAll(brief.claims);
  addAll(brief.context);
  addAll(brief.timeline);
  addAll(brief.perspectives);
  addAll(brief.analysis);
  return ids;
}

// ── 本机记录 ──

export interface StoryRecord {
  id: string;
  key: string;
  page: StoryPage;
  brief: StoryBrief;
  sources: StorySource[];
  queries: string[];
  /** 搜索出错的错误码（这几次搜索没结果，不收费） */
  searchErrors: string[];
  searches: number;
  /** 这次调研花的钱（按服务方报告的用量与搜索次数算） */
  usd: number;
  /** 模型不在价格表里：按最贵一档估 */
  estimatedPrice: boolean;
  provider: 'anthropic' | 'openai';
  model: string;
  at: number;
}

export interface StoryState {
  /** 新的在前 */
  items: StoryRecord[];
}

export const emptyStoryState = (): StoryState => ({ items: [] });

export function sanitizeStoryState(v: unknown): StoryState {
  const items = v && typeof v === 'object' && Array.isArray((v as StoryState).items) ? (v as StoryState).items : [];
  return { items: items.filter((i) => !!i && typeof i === 'object' && typeof i.id === 'string' && typeof i.key === 'string' && !!i.page && !!i.brief).slice(0, STORY.maxKept) };
}

/** 存一条新的：同一个故事只留最新那次，总数不超过 maxKept */
export function rememberStory(state: StoryState, rec: StoryRecord): StoryState {
  return { items: [rec, ...state.items.filter((i) => i.key !== rec.key)].slice(0, STORY.maxKept) };
}

export function forgetStory(state: StoryState, id: string): StoryState {
  return { items: state.items.filter((i) => i.id !== id) };
}

/** 这个页面在 cacheHours 小时内调研过：直接给上次的结果 */
export function cachedStory(state: StoryState, key: string, now: number, cacheHours: number): StoryRecord | undefined {
  const rec = state.items.find((i) => i.key === key);
  return rec && now - rec.at < cacheHours * 3_600_000 ? rec : undefined;
}

/** 来源编号 → 来源（界面上把 [S3] 变成可以点的链接） */
export function sourceIndex(sources: readonly StorySource[]): Map<string, StorySource> {
  return new Map(sources.map((s) => [s.id, s]));
}
