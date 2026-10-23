// 找片结果缓存：键 = "会产生 API 调用的那部分计划"（检索词 + API 参数，时间窗按相对小时数记），
// 所以只改后置过滤 / 排序的编辑会命中缓存、不再消耗配额。

import { canonicalJson, hashString } from './text';
import type { SearchPlan, VideoCandidate } from './types';

export interface CacheEntry {
  key: string;
  createdAt: number;
  candidates: VideoCandidate[];
  fetchedCount: number;
  extraPagesUsed: number;
}

export type SearchCache = Record<string, CacheEntry>;

export function planCacheKey(plan: SearchPlan): string {
  const queries = plan.queries.map((q) => {
    const { publishedAfter: _ignored, ...rest } = q.params;
    return rest;
  });
  return hashString(canonicalJson({ queries, withinHours: plan.withinHours ?? null }));
}

export function lookup(cache: SearchCache, key: string, now: number, ttlMs: number): CacheEntry | undefined {
  const e = cache[key];
  return e && now - e.createdAt <= ttlMs ? e : undefined;
}

export function store(cache: SearchCache, entry: CacheEntry, now: number, ttlMs: number): SearchCache {
  const next: SearchCache = {};
  for (const [k, e] of Object.entries(cache)) if (now - e.createdAt <= ttlMs) next[k] = e;
  next[entry.key] = entry;
  return next;
}
