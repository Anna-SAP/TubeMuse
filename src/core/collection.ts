// 收藏与标签的公共逻辑（小红书、eMails 共用，见 DECISIONS §44）：标签的规范化、加减、改名 / 删除、统计。
// 各模块自己决定收藏什么（笔记、博主、文章）、怎样校验；这里只管所有收藏都一样的那部分：每条收藏都有 tags。

import { TAGS } from '../config/defaults';
import { clip } from './text';

/** 能打标签的收藏 */
export interface Tagged {
  tags: string[];
}

/** 页面上的文字：去掉控制字符、合并空白、截断（不劈开 emoji） */
export function cleanText(x: unknown, max: number): string {
  return typeof x === 'string' ? clip(x.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(), max).trim() : '';
}

/** 标签：去掉开头的 #、合并空白，最多 TAGS.maxChars 个字；空的不要 */
export function normalizeTag(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^[\s#＃]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return undefined;
  return Array.from(t).slice(0, TAGS.maxChars).join('').trim() || undefined;
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

export function mergeTags(current: readonly string[], add: readonly string[], remove: readonly string[] = []): string[] {
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

/** 不可信来源的标签列表：逐个规范化，多余的不要 */
export const tagList = (x: unknown): string[] => (Array.isArray(x) ? x.slice(0, TAGS.maxPerItem * 2).map(normalizeTag).filter((t): t is string => !!t) : []);

/** 加减标签；超出上限时原样返回并说明 */
export function withTags<T extends Tagged>(item: T, add: readonly string[], remove: readonly string[] = []): { item: T; error?: string } {
  const tags = mergeTags(item.tags, add, remove);
  if (tags.length > TAGS.maxPerItem) return { item, error: `每条收藏最多 ${TAGS.maxPerItem} 个标签` };
  return { item: { ...item, tags } };
}

/** 把所有收藏上的标签 from 换成 replacement：改名放在原来的位置（新名字已经有了就合并成一个），replacement 为空就是删除 */
export function retag<T extends Tagged>(items: Record<string, T>, from: string, replacement: readonly string[]): Record<string, T> {
  return Object.fromEntries(
    Object.entries(items).map(([id, item]) => {
      const i = item.tags.findIndex((t) => tagKey(t) === tagKey(from));
      if (i < 0) return [id, item];
      return [id, { ...item, tags: mergeTags([...item.tags.slice(0, i), ...replacement, ...item.tags.slice(i + 1)], []) }];
    }),
  );
}

export interface TagCount {
  tag: string;
  count: number;
}

/** 所有标签与用了几次：多的在前，一样多按名字 */
export function countTags(items: Iterable<Tagged>): TagCount[] {
  const counts = new Map<string, TagCount>();
  for (const item of items) {
    for (const t of item.tags) {
      const c = counts.get(tagKey(t));
      if (c) c.count++;
      else counts.set(tagKey(t), { tag: t, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
}
