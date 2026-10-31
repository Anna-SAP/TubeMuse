// 豆瓣条目评论 RSS（https://www.douban.com/feed/subject/<ID>/reviews）的解析。纯函数，不出网。
// RSS 2.0 结构固定，按元素名取值即可，不引入 XML 解析依赖（见 DECISIONS §28）。
// 订阅源里的 HTML 一律不渲染：只从中取海报地址与作者主页，且都要过域名白名单。

import { DOUBAN } from '../config/defaults';
import { wellFormed } from './text';
import type { DoubanFeed, DoubanReview } from './types';

export class DoubanFeedError extends Error {}

const SUBJECT_ID = /^\d{4,12}$/;

function isDoubanHost(host: string): boolean {
  return host === 'douban.com' || host.endsWith('.douban.com');
}

/** 从你粘贴的内容里认出条目 ID：纯数字、条目页链接（电影 / 图书 / 音乐 / 移动版）、RSS 地址都行。 */
export function parseSubjectInput(input: string): string | undefined {
  const s = input.trim();
  if (SUBJECT_ID.test(s)) return s;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return undefined;
  }
  if (!isDoubanHost(url.hostname)) return undefined;
  return /\/subject\/(\d{4,12})(?:\/|$)/.exec(url.pathname)?.[1];
}

/**
 * 标签页地址 → 条目 ID：豆瓣（https）的条目页与评论 RSS。feedBase 是 RSS 所在的源（正式版即 www.douban.com，
 * e2e 是本机 mock），这样 mock 的 RSS 页面也能被跟随。浏览器只把有主机权限的标签页地址交给扩展。
 */
export function subjectFromTabUrl(url: string | undefined, feedBase: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith(`${feedBase}/`)) return /\/subject\/(\d{4,12})(?:\/|$)/.exec(url.slice(feedBase.length))?.[1];
  return url.startsWith('https://') ? parseSubjectInput(url) : undefined;
}

export function doubanFeedUrl(base: string, subjectId: string): string {
  return `${base}/feed/subject/${encodeURIComponent(subjectId)}/reviews`;
}

/** 只接受 https 的 douban.com 链接（订阅源里的 javascript: 之类地址一律不给链接） */
export function safeDoubanUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' && isDoubanHost(u.hostname) ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function safeImageUrl(raw: string | undefined, origins: readonly string[]): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw.trim());
    return origins.includes(u.origin) ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// ── XML ──

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** 元素文本：CDATA 段原样保留，其余部分解码实体 */
function xmlText(raw: string): string {
  let out = '';
  let last = 0;
  for (const m of raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)) {
    out += decodeEntities(raw.slice(last, m.index)) + m[1];
    last = m.index + m[0].length;
  }
  return out + decodeEntities(raw.slice(last));
}

/** 第一个 <tag>…</tag> 的文本（RSS 的 item 子元素不会同名嵌套） */
function childText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`).exec(xml);
  return m ? xmlText(m[1]!) : undefined;
}

// ── 文本 ──

/** 去掉末尾被劈开的半个 emoji，其余孤立代理项换成 U+FFFD */
function tidy(s: string): string {
  return wellFormed(s.replace(/[\ud800-\udbff]$/, ''))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 解 JSON 字符串字面量的内容；遇到被截断的转义（如 \u66）就停下 */
function unescapeJsonFragment(s: string): string {
  const simple: Record<string, string> = { n: '\n', t: ' ', r: '', b: '', f: '', '"': '"', '\\': '\\', '/': '/' };
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) break;
    if (next === 'u') {
      const hex = s.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else {
      out += simple[next] ?? next;
      i += 1;
    }
  }
  return out;
}

const CUT_MARK = /(?:\.\.\.|…)$/;

/**
 * 豆瓣把评论正文（Draft.js 的 JSON）截断后放进 description，例如
 * {"blocks":[{"key":"24j0s","text":"几乎是哭着看完了全片","type":"unstyled",…,"entityRan...
 * JSON 不完整，只能逐个取出 "text" 字段；最后一段可能断在转义或半个 emoji 中间。
 */
function draftExcerpt(body: string): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let truncated = CUT_MARK.test(body);
  for (const m of body.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\[\s\S])*)("?)/g)) {
    let raw = m[1]!;
    if (!m[2]) {
      truncated = true;
      raw = raw.replace(CUT_MARK, '');
    }
    const t = tidy(unescapeJsonFragment(raw));
    if (t) parts.push(t);
  }
  return { text: parts.join('\n'), truncated };
}

/**
 * description 的结构：
 *   <作者>评论: <条目> (<条目链接>)
 *   评价: <力荐 / 推荐 / …，常为空>
 *   <正文开头，Draft.js JSON 或纯文本>...
 */
export function parseDescription(desc: string): { excerpt: string; truncated: boolean; rating?: string } {
  const lines = decodeEntities(desc).replace(/\r\n?/g, '\n').trim().split('\n');
  const label = /^\s*(?:评价|推荐)\s*[:：]/;
  const ri = lines.findIndex((l) => label.test(l));
  const rating = ri >= 0 ? lines[ri]!.replace(label, '').trim() : '';
  const start = ri >= 0 ? ri + 1 : /评论\s*[:：]/.test(lines[0] ?? '') ? 1 : 0;
  const body = lines.slice(start).join('\n').trim();
  const out = body.startsWith('{')
    ? draftExcerpt(body)
    : {
        text: tidy(
          body
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(CUT_MARK, ''),
        ),
        truncated: CUT_MARK.test(body),
      };
  return { excerpt: out.text, truncated: out.truncated, ...(rating ? { rating } : {}) };
}

/** "太感动了，哭了好几次 (评论: 白衣逆行者)" → 标题 + 条目名 */
export function splitReviewTitle(t: string): { title: string; subject?: string } {
  const m = /\s*[(（]\s*(?:评论|影评|书评|乐评)\s*[:：]\s*(.+?)\s*[)）]\s*$/.exec(t);
  if (!m) return { title: t.trim() };
  return { title: t.slice(0, m.index).trim() || t.trim(), subject: m[1]! };
}

const KINDS: Record<string, string> = { movie: '电影', book: '图书', music: '音乐' };

export function subjectKind(subjectUrl: string | undefined): string {
  if (!subjectUrl) return '条目';
  return KINDS[new URL(subjectUrl).hostname.split('.')[0] ?? ''] ?? '条目';
}

/** 星级（1–5）：评价词按豆瓣五档换算，也认"★★★★"；认不出返回 undefined（界面原样显示评价词） */
export function ratingStars(rating: string | undefined): number | undefined {
  const r = rating?.trim();
  if (!r) return undefined;
  const stars = /^★{1,5}/.exec(r)?.[0].length;
  return stars ?? DOUBAN.ratingStars[r];
}

/** 头像底色：同一个名字总是同一个色相 */
export function hueOf(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

/** 只保留订阅条目的缓存，外加最近读过的 keep 个未订阅条目（跟随标签页时看过的） */
export function pruneTransientFeeds<T extends { fetchedAt: number }>(feeds: Record<string, T>, subscribed: readonly string[], keep: number): Record<string, T> {
  const ids = new Set(subscribed);
  const transient = Object.entries(feeds)
    .filter(([id]) => !ids.has(id))
    .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
    .slice(0, keep)
    .map(([id]) => id);
  for (const id of transient) ids.add(id);
  return Object.fromEntries(Object.entries(feeds).filter(([id]) => ids.has(id)));
}

export function doubanFresh(entry: { fetchedAt: number } | undefined, cacheMinutes: number, now: number): boolean {
  return !!entry && now - entry.fetchedAt < cacheMinutes * 60_000;
}

// ── 订阅源 ──

function parseItem(item: string, index: number): { review: DoubanReview; poster?: string; subject?: string } {
  const link = safeDoubanUrl(childText(item, 'link'));
  const guid = childText(item, 'guid')?.trim();
  const html = childText(item, 'content:encoded') ?? '';
  const desc = childText(item, 'description') ?? '';
  const { title, subject } = splitReviewTitle(childText(item, 'title') ?? '');
  const authorLink = /<a\b[^>]*\bhref\s*=\s*["']([^"']*\/people\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i.exec(html);
  const author =
    childText(item, 'dc:creator')?.trim() ||
    decodeEntities(authorLink?.[2]?.replace(/<[^>]+>/g, '') ?? '').trim() ||
    /^\s*(.+?)评论\s*[:：]/.exec(decodeEntities(desc))?.[1]?.trim() ||
    '豆瓣用户';
  const authorUrl = safeDoubanUrl(authorLink?.[1]);
  const published = Date.parse(childText(item, 'pubDate')?.trim() ?? '');
  const review: DoubanReview = {
    id: /\/review\/(\d+)/.exec(link ?? guid ?? '')?.[1] ?? guid ?? link ?? `item-${index}`,
    title: title || '（无标题）',
    author: tidy(author),
    publishedAt: Number.isFinite(published) ? published : 0,
    ...parseDescription(desc),
  };
  if (link) review.url = link;
  if (authorUrl) review.authorUrl = authorUrl;
  const poster = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  return { review, ...(poster ? { poster } : {}), ...(subject ? { subject } : {}) };
}

/** 解析豆瓣评论 RSS。不是 RSS（例如被转去了验证页）时抛 DoubanFeedError，绝不当成"没有评论"。 */
export function parseDoubanFeed(xml: string, subjectId: string, imageOrigins: readonly string[]): DoubanFeed {
  if (!/<rss[\s>]/.test(xml) || !/<channel[\s>]/.test(xml)) {
    throw new DoubanFeedError(/<html[\s>]/i.test(xml.slice(0, 4000)) ? '豆瓣返回的是网页而不是 RSS（可能是验证页或登录页）' : '豆瓣返回的内容不是 RSS');
  }
  const channel = /<channel(?:\s[^>]*)?>([\s\S]*?)(?:<\/channel\s*>|$)/.exec(xml)?.[1] ?? '';
  const firstItem = channel.search(/<item[\s>]/);
  const head = firstItem >= 0 ? channel.slice(0, firstItem) : channel;
  const subjectLink = safeDoubanUrl(childText(head, 'link'))?.replace(/reviews\/?$/, '');
  const subjectUrl = subjectLink && /\/subject\/\d+\/$/.test(subjectLink) ? subjectLink : `https://www.douban.com/subject/${subjectId}/`;

  const reviews: DoubanReview[] = [];
  const seen = new Set<string>();
  let posterUrl: string | undefined;
  let subjectFromItems: string | undefined;
  for (const [i, m] of [...channel.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/g)].entries()) {
    const { review, poster, subject } = parseItem(m[1]!, i);
    posterUrl ??= safeImageUrl(poster, imageOrigins);
    subjectFromItems ??= subject;
    if (seen.has(review.id)) continue;
    seen.add(review.id);
    reviews.push(review);
  }
  reviews.sort((a, b) => b.publishedAt - a.publishedAt);

  const channelTitle = (childText(head, 'title') ?? '').trim();
  const title = /^关于(.+)的最新评论$/.exec(channelTitle)?.[1]?.trim() || subjectFromItems || channelTitle || `条目 ${subjectId}`;
  return {
    subjectId,
    title,
    subjectUrl,
    kind: subjectKind(subjectUrl),
    ...(posterUrl ? { posterUrl } : {}),
    reviews,
  };
}
