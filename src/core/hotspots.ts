// X 热点（纯逻辑）：从兴趣簇生成检索式、挑选高互动候选、校验 LLM 归纳结果。
// 热点来源 = 用你的兴趣关键词检索最近 24 小时的帖子（而不是全站 Trends：那与兴趣无关，也没有原文链接）。

import { X_API } from '../config/defaults';
import type { HotspotPromptPost } from './prompts';
import { uniqueStrings } from './text';
import type { Hotspot, InterestCluster, XPost } from './types';

export interface TopicQuery {
  topic: string;
  query: string;
}

function quoteTerm(t: string): string {
  const s = t.replace(/["()]/g, '').trim();
  if (!s) return '';
  return /[\s:-]/.test(s) ? `"${s}"` : s;
}

/** 一个主题一条检索式：关键词 OR 起来，排除转发与回复；不超过 X 的 512 字符上限。 */
export function topicQuery(topic: string, keywords: string[], langs: string[] = []): TopicQuery | undefined {
  const suffix = ` -is:retweet -is:reply${langs.length ? ` (${langs.map((l) => `lang:${l}`).join(' OR ')})` : ''}`;
  const terms = uniqueStrings(keywords.map(quoteTerm)).filter((t) => t.length >= 2);
  const picked: string[] = [];
  for (const t of terms) {
    const candidate = `(${[...picked, t].join(' OR ')})${suffix}`;
    if (candidate.length > X_API.maxQueryChars) break;
    picked.push(t);
    if (picked.length >= 8) break;
  }
  if (!picked.length) return undefined;
  return { topic, query: `(${picked.join(' OR ')})${suffix}` };
}

/** 选主题：按兴趣簇权重从高到低，取前 maxTopics 个；没有兴趣簇时用最近的找片主题。 */
export function chooseTopics(clusters: InterestCluster[], recentTopics: { topic: string; terms: string[] }[], maxTopics: number): TopicQuery[] {
  const fromClusters = [...clusters]
    .filter((c) => c.keywords.length)
    .sort((a, b) => b.weight - a.weight)
    .map((c) => topicQuery(c.name, [c.name, ...c.keywords]))
    .filter((q): q is TopicQuery => !!q);
  const fromSearches = recentTopics.map((t) => topicQuery(t.topic, t.terms)).filter((q): q is TopicQuery => !!q);
  const seen = new Set<string>();
  const out: TopicQuery[] = [];
  for (const q of [...fromClusters, ...fromSearches]) {
    if (seen.has(q.topic)) continue;
    seen.add(q.topic);
    out.push(q);
    if (out.length >= maxTopics) break;
  }
  return out;
}

/** 互动热度（对数压缩，转发权重更高），按发帖时间衰减 */
export function engagementScore(p: XPost, now: number): number {
  const hours = Math.max(0, (now - Date.parse(p.createdAt)) / 3_600_000);
  const raw = Math.log1p(p.likes) + 2 * Math.log1p(p.reposts) + Math.log1p(p.quotes) + 0.5 * Math.log1p(p.replies);
  return raw * Math.exp(-hours / 48);
}

/** 每个主题取前 N 条，去重 */
export function selectCandidates(posts: XPost[], perTopic: number, now: number): XPost[] {
  const byTopic = new Map<string, XPost[]>();
  const seen = new Set<string>();
  for (const p of [...posts].sort((a, b) => engagementScore(b, now) - engagementScore(a, now))) {
    if (seen.has(p.id)) continue;
    const list = byTopic.get(p.topic) ?? [];
    if (list.length >= perTopic) continue;
    seen.add(p.id);
    list.push(p);
    byTopic.set(p.topic, list);
  }
  return [...byTopic.values()].flat();
}

export function toPromptPosts(cands: XPost[], now: number): { posts: HotspotPromptPost[]; refs: Map<string, XPost> } {
  const refs = new Map<string, XPost>();
  const posts = cands.map((p, i) => {
    const ref = `p${i + 1}`;
    refs.set(ref, p);
    return {
      ref,
      topic: p.topic,
      text: p.text.slice(0, X_API.postTextChars),
      likes: p.likes,
      reposts: p.reposts,
      hoursAgo: Math.max(0, Math.round((now - Date.parse(p.createdAt)) / 3_600_000)),
    };
  });
  return { posts, refs };
}

export interface RawHotspots {
  hotspots: { title: string; summary: string; refs: string[]; utterance: string }[];
}

export function isRawHotspots(v: unknown): v is RawHotspots {
  const o = v as RawHotspots;
  const s = (x: unknown) => typeof x === 'string';
  return !!o && Array.isArray(o.hotspots) && o.hotspots.every((h) => s(h?.title) && s(h?.summary) && s(h?.utterance) && Array.isArray(h?.refs) && h.refs.every(s));
}

export function postUrl(id: string): string {
  return `https://x.com/i/web/status/${encodeURIComponent(id)}`;
}

/** 校验并组装：每条热点至少要有一个真实存在的原文帖子；空口令的丢弃；最多 maxItems 条。 */
export function assembleHotspots(raw: RawHotspots, refs: Map<string, XPost>, maxItems: number, newId: () => string): { items: Hotspot[]; dropped: number } {
  const items: Hotspot[] = [];
  let dropped = 0;
  for (const h of raw.hotspots) {
    const posts = uniqueStrings(h.refs.map((r) => r.trim()))
      .map((r) => refs.get(r))
      .filter((p): p is XPost => !!p);
    if (!posts.length || !h.utterance.trim() || !h.title.trim()) {
      dropped++;
      continue;
    }
    items.push({
      id: newId(),
      title: h.title.trim().slice(0, 40),
      summary: h.summary.trim().slice(0, 300),
      utterance: h.utterance.trim().slice(0, 120),
      topic: posts[0]!.topic,
      posts: posts.slice(0, 3).map((p) => ({ id: p.id, url: postUrl(p.id), text: p.text.slice(0, 200), likes: p.likes, reposts: p.reposts, createdAt: p.createdAt })),
    });
    if (items.length >= maxItems) break;
  }
  return { items, dropped };
}
