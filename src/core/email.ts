// eMails（2026-11-04 新增，见 DECISIONS §44）：从文章汇总邮件里认出文章、评分结果、收藏与标签。
// 纯逻辑，邮件脚本、侧边栏、服务层共用。结构照 2026-11-04 读到的真实 Medium Daily Digest：
//   作者链接（头像 + 名字）、"in"、刊物链接 → 配图链接（alt 是完整标题）→ 标题链接（<h2> 标题，会被截断加"…"；<h3> 摘要）
//   → "Member-only content"图标、"8 min read"、Claps 图标 + 数字、Responses 图标 + 数字
// 其他汇总邮件没有这么规整：按"链接里的标题 > 链接里的粗体 > 长文字链接"三档认，认不出就明说，不瞎猜。
// 邮件内容一律当不可信输入：链接只认 http(s)，文字限长，发给大模型前不带链接。

import { EMAIL } from '../config/defaults';
import { cleanText, countTags, retag, tagKey, tagList, withTags, type TagCount } from './collection';
import { hashString } from './text';

export const EMAIL_MSG = {
  /** 侧边栏 → 邮件脚本：读当前打开的邮件。脚本只回答这一种消息，不主动做任何事 */
  getState: 'tubemuse:email:get-state',
  /** 脚本不主动推送（useActiveTabState 需要一个类型，这个类型从来不会有人发） */
  state: 'tubemuse:email:state',
} as const;

// ── 链接 ──

/** 这些参数不是文章地址的一部分。Medium 的 source 里带着收件人的用户 ID，token / email 也能认出你：存之前必须去掉 */
const TRACKING_PARAM = /^(utm_[a-z_]+|source|ref|ref_src|referrer|mc_cid|mc_eid|fbclid|gclid|igshid|token|email|uid|user_id)$/i;

/** 邮件里的非文章链接：应用商店、社交账号、帮助与条款站点 */
const BOILERPLATE_HOST = /^(?:(?:itunes|apps)\.apple\.com|play\.google\.com|(?:www\.)?(?:twitter|x|facebook|instagram|linkedin|tiktok)\.com|(?:help|policy|support|privacy)\..+)$/i;

/** 路径里出现这些完整的一段就不是文章（"how-to-subscribe-…"这样的标题不算） */
const BOILERPLATE_SEGMENT = /^(?:unsubscribe|preferences|email-?settings|notifications|manage|privacy|privacy-policy|terms|tos|legal|help|hc|support|careers|jobs|about|login|signin|sign-in|signup|sign-up|subscribe|account|settings|missioncontrol)$/i;

/** 文章的规范链接：只认 http(s)，去掉跟踪参数和 #；站点首页、退订、应用商店之类不是文章，返回 undefined */
export function canonicalArticleUrl(href: unknown): { url: string; site: string } | undefined {
  if (typeof href !== 'string') return undefined;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  const segments = u.pathname.split('/').filter(Boolean);
  if (!segments.length || BOILERPLATE_HOST.test(u.hostname) || segments.some((s) => BOILERPLATE_SEGMENT.test(s))) return undefined;
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  u.hash = '';
  u.username = '';
  u.password = '';
  return { url: u.toString(), site: u.hostname.replace(/^www\./, '') };
}

// ── 从邮件正文认出文章 ──

/** 邮件正文里的一个节点（邮件脚本按文档顺序读出来的：文字，或图片的 alt） */
export interface EmailNode {
  kind: 'text' | 'img';
  text: string;
  /** 在链接里时：链接地址 */
  href?: string;
  /** 在 h1–h4 里时：1–4 */
  heading?: number;
  /** 粗体或大字 */
  strong?: boolean;
}

export interface EmailArticle {
  /** 规范链接的哈希：同一篇在不同邮件里是同一个 ID */
  id: string;
  title: string;
  url: string;
  /** 文章所在站点（medium.com…） */
  site: string;
  excerpt?: string;
  author?: string;
  publication?: string;
  readMinutes?: number;
  claps?: number;
  responses?: number;
  memberOnly?: boolean;
}

/** 按钮文字、页脚之类：长得再像标题也不是文章 */
const CTA = /^(?:read more|read on|continue reading|keep reading|view (?:in|online|this|all|more)|open in|learn more|click here|see (?:more|all)|sign up|subscribe|unsubscribe|get the app|download|阅读(?:全文|更多)|查看|点击|了解更多|退订|取消订阅)/i;

const cjkCount = (s: string): number => (s.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g) ?? []).length;
const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/** 档位：1 链接里的标题（h1–h4）；2 链接里的粗体 / 大字；3 够长的普通文字链接 */
type Tier = 1 | 2 | 3;

function nodeTier(n: EmailNode): Tier | undefined {
  if (n.kind !== 'text' || !n.href) return undefined;
  const t = n.text.trim();
  if (CTA.test(t)) return undefined;
  if (n.heading && t.length >= 4) return 1;
  if (n.strong && (cjkCount(t) >= 6 || t.length >= 12)) return 2;
  return cjkCount(t) >= 10 || wordCount(t) >= 5 ? 3 : undefined;
}

const ELLIPSIS = /\s*(?:…|\.\.\.)$/;

/** Medium 的 <h2> 标题太长时被截断加"…"，配图的 alt 才是完整标题 */
function fullTitle(title: string, alts: readonly string[]): string {
  if (!ELLIPSIS.test(title)) return title;
  const stem = title.replace(ELLIPSIS, '');
  return alts.find((a) => a.startsWith(stem) && a.length > stem.length) ?? title;
}

/** "936"、"1.3K"、"2,048" → 数字；不是数字时 undefined */
export function parseCount(text: string): number | undefined {
  const m = /^([\d.,]+)\s*([KkMm]?)$/.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * (m[2]?.toLowerCase() === 'k' ? 1_000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1));
}

const READ_TIME = /(\d+)\s*(?:min(?:ute)?s?\s*read|分钟)/i;
const isMetaText = (s: string): boolean => READ_TIME.test(s) || parseCount(s) !== undefined || /^[·•|\-–—]$/.test(s);

/** 标题前面这段（上一篇结束之后）里的署名："作者 in 刊物"，或者只有作者 */
function readByline(before: readonly EmailNode[]): { author?: string; publication?: string } {
  const names = before.filter((n) => n.kind === 'text' && n.href && !CTA.test(n.text) && n.text.length <= EMAIL.nameMaxChars && wordCount(n.text) <= 8);
  const last = names[names.length - 1];
  if (!last) return {};
  const lastAt = before.lastIndexOf(last);
  const prev = names[names.length - 2];
  if (prev && before.slice(before.lastIndexOf(prev) + 1, lastAt).some((n) => n.kind === 'text' && /^(?:in|于|发表于)$/i.test(n.text.trim()))) {
    return { author: prev.text, publication: last.text };
  }
  return { author: last.text };
}

/** 标题后面这段（到下一篇的链接为止）里的摘要、阅读时长、互动数据 */
function readAfter(after: readonly EmailNode[], title: string, href: string): Pick<EmailArticle, 'excerpt' | 'readMinutes' | 'claps' | 'responses' | 'memberOnly'> & { author?: string } {
  const out: Pick<EmailArticle, 'excerpt' | 'readMinutes' | 'claps' | 'responses' | 'memberOnly'> & { author?: string } = {};
  let pending: 'claps' | 'responses' | undefined;
  for (const n of after) {
    const t = n.text.trim();
    if (n.kind === 'img') {
      if (/member-only/i.test(t)) out.memberOnly = true;
      pending = /^claps?$/i.test(t) ? 'claps' : /^(?:responses?|comments?)$/i.test(t) ? 'responses' : undefined;
      continue;
    }
    if (pending) {
      const count = parseCount(t);
      if (count !== undefined) out[pending] = count;
      pending = undefined;
      continue;
    }
    const read = READ_TIME.exec(t);
    if (read) {
      out.readMinutes = Number(read[1]);
      continue;
    }
    const by = /^(?:by|作者[:：]?)\s+(.+)$/i.exec(t);
    if (by && by[1]!.length <= EMAIL.nameMaxChars) {
      out.author ??= by[1]!;
      continue;
    }
    // 摘要：在这篇自己的链接里，或者紧跟在后面的普通文字（页脚那种标题不算）
    if (!out.excerpt && !isMetaText(t) && t !== title && (n.href === href || (!n.href && !n.heading)) && t.length >= 12) out.excerpt = t;
  }
  return out;
}

/**
 * 认出邮件里的文章。按档位从严到宽：只要某一档已经够 minArticles 篇，就不看更宽松的——
 * Medium 的文章都是"链接里的标题"，页脚的"Control your recommendations"这种就不会混进来。
 * 一篇都认不出（普通邮件）时返回空数组，界面说明，不发给大模型。
 */
export function extractArticles(nodes: readonly EmailNode[]): EmailArticle[] {
  interface Group {
    url: string;
    site: string;
    href: string;
    at: number;
    /** 标题节点的位置与档位 */
    titleAt?: number;
    tier?: Tier;
    last: number;
    alts: string[];
  }
  const groups = new Map<string, Group>();
  nodes.forEach((n, i) => {
    if (!n.href) return;
    const canon = canonicalArticleUrl(n.href);
    if (!canon) return;
    let g = groups.get(canon.url);
    if (!g) {
      g = { url: canon.url, site: canon.site, href: n.href, at: i, last: i, alts: [] };
      groups.set(canon.url, g);
    }
    g.last = i;
    if (n.kind === 'img' && n.text) g.alts.push(n.text);
    const tier = nodeTier(n);
    if (tier && (g.tier === undefined || tier < g.tier)) {
      g.tier = tier;
      g.titleAt = i;
    }
  });

  const candidates = [...groups.values()].filter((g) => g.tier !== undefined);
  const picked = ([1, 2, 3] as const).map((tier) => candidates.filter((g) => g.tier! <= tier)).find((list) => list.length >= EMAIL.minArticles);
  if (!picked) return [];
  const list = picked.sort((a, b) => a.at - b.at).slice(0, EMAIL.maxArticles);

  // 署名在标题之前、摘要在标题之后：两篇之间的节点按"属于哪一篇的链接"分开
  const belongs = new Map<string, Group>(list.map((g) => [g.url, g]));
  const sameArticle = (n: EmailNode, g: Group): boolean => !n.href || canonicalArticleUrl(n.href)?.url === g.url;

  return list.map((g, i) => {
    const prevEnd = i > 0 ? list[i - 1]!.last + 1 : 0;
    const before = nodes.slice(prevEnd, g.at).filter((n) => !(n.href && belongs.has(canonicalArticleUrl(n.href)?.url ?? '')));
    const rest = nodes.slice(g.titleAt! + 1, list[i + 1]?.at ?? nodes.length);
    const stop = rest.findIndex((n) => !sameArticle(n, g));
    const title = cleanText(fullTitle(nodes[g.titleAt!]!.text.trim(), g.alts), EMAIL.titleMaxChars);
    const { author: byAuthor, ...after } = readAfter(stop < 0 ? rest : rest.slice(0, stop), title, g.href);
    const byline = readByline(before);
    const author = cleanText(byline.author ?? byAuthor, EMAIL.nameMaxChars);
    const publication = cleanText(byline.publication, EMAIL.nameMaxChars);
    const excerpt = cleanText(after.excerpt, EMAIL.excerptMaxChars);
    return {
      id: hashString(g.url),
      title,
      url: g.url,
      site: g.site,
      ...(excerpt ? { excerpt } : {}),
      ...(author ? { author } : {}),
      ...(publication ? { publication } : {}),
      ...(after.readMinutes !== undefined ? { readMinutes: after.readMinutes } : {}),
      ...(after.claps !== undefined ? { claps: after.claps } : {}),
      ...(after.responses !== undefined ? { responses: after.responses } : {}),
      ...(after.memberOnly ? { memberOnly: true } : {}),
    };
  });
}

/** 邮件脚本报给侧边栏的状态（"不静默"：没打开邮件、读不到正文、被 Gmail 截断都看得见） */
export interface EmailTabState {
  /** none：没有打开的邮件；mail：读到了正文；unreadable：看得到打开了邮件，读不到正文（Gmail 可能改版了） */
  page: 'none' | 'mail' | 'unreadable';
  subject?: string;
  sender?: string;
  articles: EmailArticle[];
  /** Gmail 把长邮件截断了，后面的文章读不到 */
  clipped: boolean;
}

const isPositive = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

/** 校验一篇文章（来自邮件或存储）：链接必须是 http(s)，ID 与链接对得上，文字限长 */
export function sanitizeArticle(raw: unknown): EmailArticle | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const canon = canonicalArticleUrl(r.url);
  const title = cleanText(r.title, EMAIL.titleMaxChars);
  if (!canon || !title) return undefined;
  const excerpt = cleanText(r.excerpt, EMAIL.excerptMaxChars);
  const author = cleanText(r.author, EMAIL.nameMaxChars);
  const publication = cleanText(r.publication, EMAIL.nameMaxChars);
  return {
    id: hashString(canon.url),
    title,
    url: canon.url,
    site: canon.site,
    ...(excerpt ? { excerpt } : {}),
    ...(author ? { author } : {}),
    ...(publication ? { publication } : {}),
    ...(isPositive(r.readMinutes) ? { readMinutes: r.readMinutes } : {}),
    ...(isPositive(r.claps) ? { claps: r.claps } : {}),
    ...(isPositive(r.responses) ? { responses: r.responses } : {}),
    ...(r.memberOnly === true ? { memberOnly: true } : {}),
  };
}

// ── 评分 ──

export interface EmailScore {
  /** 0–10 的整数 */
  score: number;
  reason: string;
  at: number;
  model: string;
}

export type EmailScores = Record<string, EmailScore>;

/** 大模型的回答：逐条校验。分数不是 0–10、引用了没发过去的文章的不要（由调用方报告"没有评到"，不补分） */
export function parseScores(value: unknown, refs: ReadonlyMap<string, string>): Map<string, { score: number; reason: string }> {
  const out = new Map<string, { score: number; reason: string }>();
  const items = (value as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return out;
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? refs.get(r.id) : undefined;
    const score = typeof r.score === 'number' ? Math.round(r.score) : NaN;
    const reason = cleanText(r.reason, EMAIL.reasonMaxChars);
    if (id && score >= 0 && score <= 10 && reason) out.set(id, { score, reason });
  }
  return out;
}

/** 只留最近评的 max 篇 */
export function pruneScores(scores: EmailScores, max: number = EMAIL.maxScores): EmailScores {
  const entries = Object.entries(scores);
  if (entries.length <= max) return scores;
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, max));
}

export type EmailBand = 'read' | 'maybe' | 'skip';

export function scoreBand(score: number): EmailBand {
  return score >= EMAIL.bands.read ? 'read' : score <= EMAIL.bands.skip ? 'skip' : 'maybe';
}

export interface EmailRow {
  article: EmailArticle;
  score?: EmailScore;
}

/** 当前邮件的列表：评过的按分数从高到低（同分保持邮件里的顺序），没评过的排在后面 */
export function rankArticles(articles: readonly EmailArticle[], scores: EmailScores): EmailRow[] {
  return articles
    .map((article, i) => {
      const score = scores[article.id];
      return { row: { article, ...(score ? { score } : {}) } as EmailRow, i };
    })
    .sort((a, b) => (b.row.score?.score ?? -1) - (a.row.score?.score ?? -1) || a.i - b.i)
    .map((x) => x.row);
}

export function bandCounts(rows: readonly EmailRow[]): Record<EmailBand, number> {
  const c: Record<EmailBand, number> = { read: 0, maybe: 0, skip: 0 };
  for (const r of rows) if (r.score) c[scoreBand(r.score.score)]++;
  return c;
}

// ── 收藏与标签（结构与小红书的笔记收藏一样：id / 标题 / 链接 / 作者 / 收藏时间 / 标签）──

export interface EmailSavedArticle extends EmailArticle {
  score?: number;
  reason?: string;
  savedAt: number;
  tags: string[];
}

export interface EmailState {
  articles: Record<string, EmailSavedArticle>;
}

export const emptyEmailState = (): EmailState => ({ articles: {} });

export type EmailOp =
  | { op: 'save'; article: EmailArticle; score?: { score: number; reason: string }; tags: string[] }
  | { op: 'remove'; id: string }
  | { op: 'tags'; id: string; add: string[]; remove: string[] }
  | { op: 'renameTag'; from: string; to: string }
  | { op: 'deleteTag'; tag: string }
  | { op: 'restore'; item: EmailSavedArticle };

/** 执行一条操作；超出上限等情况返回原状态与人话原因 */
export function applyEmailOp(state: EmailState, op: EmailOp, now: number): { state: EmailState; error?: string } {
  switch (op.op) {
    case 'save': {
      const prev = state.articles[op.article.id];
      if (!prev && Object.keys(state.articles).length >= EMAIL.maxSaved) return { state, error: `收藏的文章已满 ${EMAIL.maxSaved} 篇：先移出一些` };
      const merged: EmailSavedArticle = {
        ...op.article,
        ...(op.score ? op.score : prev?.score !== undefined ? { score: prev.score, ...(prev.reason ? { reason: prev.reason } : {}) } : {}),
        savedAt: prev?.savedAt ?? now,
        tags: prev?.tags ?? [],
      };
      const r = withTags(merged, op.tags);
      return r.error ? { state, error: r.error } : { state: { articles: { ...state.articles, [op.article.id]: r.item } } };
    }
    case 'remove': {
      const { [op.id]: _gone, ...articles } = state.articles;
      return { state: { articles } };
    }
    case 'tags': {
      const item = state.articles[op.id];
      if (!item) return { state, error: '这篇已经不在收藏里了：先收藏再加标签' };
      const r = withTags(item, op.add, op.remove);
      return r.error ? { state, error: r.error } : { state: { articles: { ...state.articles, [op.id]: r.item } } };
    }
    case 'renameTag':
      return { state: { articles: retag(state.articles, op.from, [op.to]) } };
    case 'deleteTag':
      return { state: { articles: retag(state.articles, op.tag, []) } };
    case 'restore':
      return { state: { articles: { ...state.articles, [op.item.id]: op.item } } };
  }
}

function sanitizeSaved(raw: unknown): EmailSavedArticle | undefined {
  const base = sanitizeArticle(raw);
  const r = raw as Record<string, unknown> | undefined;
  if (!base || !r || typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) return undefined;
  const score = typeof r.score === 'number' && Number.isInteger(r.score) && r.score >= 0 && r.score <= 10 ? r.score : undefined;
  const reason = cleanText(r.reason, EMAIL.reasonMaxChars);
  return { ...base, ...(score !== undefined ? { score } : {}), ...(score !== undefined && reason ? { reason } : {}), savedAt: r.savedAt, tags: tagList(r.tags) };
}

/** 存储里读出来的数据：逐条校验，坏的丢掉（旧版本或手改过的数据也能读） */
export function sanitizeEmailState(raw: unknown): EmailState {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const articles: Record<string, EmailSavedArticle> = {};
  for (const v of Object.values(r.articles && typeof r.articles === 'object' ? r.articles : {})) {
    const a = sanitizeSaved(v);
    if (a) articles[a.id] = a;
  }
  return { articles };
}

export function emailTagCounts(state: EmailState): TagCount[] {
  return countTags(Object.values(state.articles));
}

/** 收藏列表：按标签、关键词（标题、作者、刊物、标签）筛选，最近收藏的在前 */
export function filterEmail(state: EmailState, f: { tag?: string; q?: string }): EmailSavedArticle[] {
  const q = f.q?.trim().toLocaleLowerCase() ?? '';
  const tag = f.tag ? tagKey(f.tag) : undefined;
  return Object.values(state.articles)
    .filter((a) => !tag || a.tags.some((t) => tagKey(t) === tag))
    .filter((a) => !q || [a.title, a.author ?? '', a.publication ?? '', ...a.tags].some((s) => s.toLocaleLowerCase().includes(q)))
    .sort((a, b) => b.savedAt - a.savedAt);
}
