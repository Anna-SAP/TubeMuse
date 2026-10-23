// 后置过滤与软约束校验：用 videos.list 返回的元数据复核每条候选。

import { SHORTS } from '../config/defaults';
import { languageName, normalizeLanguage } from './constraints';
import { containsTerm, dominantScript, type Script } from './text';
import { DAY_MS, formatDuration, formatRelative } from './time';
import { formatViews } from './format';
import type { CheckSpec, FilterStat, VideoCandidate } from './types';

export interface CheckContext {
  now: number;
  subscriptionIds: ReadonlySet<string>;
}

export interface CheckResult {
  pass: boolean;
  /** 结论是推断出来的（例如语言元数据缺失时按标题文字判断） */
  inferred?: boolean;
  /** 通过时展示在结果卡上的徽标 */
  badge?: string;
}

const EXPECTED_SCRIPT: Record<string, Script> = { zh: 'han', yue: 'han', ja: 'kana', ko: 'hangul' };

export function isShorts(v: VideoCandidate): boolean {
  if (v.liveBroadcastContent !== 'none' || v.durationSec <= 0) return false;
  if (v.durationSec <= SHORTS.alwaysShortsMaxSeconds) return true;
  if (v.durationSec <= SHORTS.taggedShortsMaxSeconds) {
    const text = `${v.title} ${v.description} ${v.tags.join(' ')}`;
    return /#shorts\b/i.test(text);
  }
  return false;
}

export function checkLanguage(v: VideoCandidate, lang: string): CheckResult {
  const meta = normalizeLanguage(v.defaultAudioLanguage) ?? normalizeLanguage(v.defaultLanguage);
  const name = languageName(lang);
  if (meta) {
    const ok = meta === lang || (lang === 'yue' && meta === 'zh') || (lang === 'zh' && meta === 'yue');
    return ok ? { pass: true, badge: `✓ ${name}` } : { pass: false };
  }
  const script = dominantScript(`${v.title} ${v.description.slice(0, 200)}`);
  const expected = EXPECTED_SCRIPT[lang] ?? 'latin';
  if (script === 'unknown') return { pass: true, inferred: true, badge: `? ${name}（语言未确认）` };
  if (expected === 'latin' && lang !== 'en' && script === 'latin') {
    return { pass: true, inferred: true, badge: `? ${name}（语言未确认）` };
  }
  const ok = script === expected || (expected === 'kana' && script === 'han');
  return ok ? { pass: true, inferred: true, badge: `≈ ${name}（按标题推断）` } : { pass: false, inferred: true };
}

export function evaluateCheck(spec: CheckSpec, v: VideoCandidate, ctx: CheckContext): CheckResult {
  switch (spec.kind) {
    case 'language':
      return checkLanguage(v, spec.language ?? '');
    case 'recency': {
      const published = Date.parse(v.publishedAt);
      const ok = Number.isFinite(published) && published >= ctx.now - (spec.withinHours ?? 0) * 3_600_000;
      return ok ? { pass: true, badge: `✓ ${formatRelative(published, ctx.now)}发布` } : { pass: false };
    }
    case 'duration': {
      const d = v.durationSec;
      if (d <= 0) return { pass: false };
      const ok = (spec.minSeconds === undefined || d >= spec.minSeconds) && (spec.maxSeconds === undefined || d <= spec.maxSeconds);
      return ok ? { pass: true, badge: `✓ 时长 ${formatDuration(d)}` } : { pass: false };
    }
    case 'caption':
      return v.caption ? { pass: true, badge: '✓ 有字幕' } : { pass: false };
    case 'not_shorts':
      return isShorts(v) ? { pass: false } : { pass: true, badge: '✓ 非 Shorts' };
    case 'exclude_terms': {
      const text = `${v.title}\n${v.description}\n${v.tags.join(' ')}\n${v.channelTitle}`;
      const bad = (spec.terms ?? []).some((t) => containsTerm(text, t));
      return bad ? { pass: false } : { pass: true };
    }
    case 'channel_only': {
      const ok =
        (spec.channelIds ?? []).includes(v.channelId) ||
        (spec.channelNames ?? []).some((n) => containsTerm(v.channelTitle, n));
      return ok ? { pass: true, badge: `✓ 频道 ${v.channelTitle}` } : { pass: false };
    }
    case 'channel_exclude': {
      const hitChannel =
        (spec.channelIds ?? []).includes(v.channelId) ||
        (spec.channelNames ?? []).some((n) => containsTerm(v.channelTitle, n));
      return hitChannel ? { pass: false } : { pass: true };
    }
    case 'subscribed':
      return ctx.subscriptionIds.has(v.channelId) ? { pass: true, badge: '✓ 订阅频道' } : { pass: false };
    case 'min_views':
      return v.viewCount !== undefined && v.viewCount >= (spec.minViews ?? 0)
        ? { pass: true, badge: `✓ ${formatViews(v.viewCount)}` }
        : { pass: false };
    case 'definition_hd':
      return v.definition === 'hd' ? { pass: true, badge: '✓ 高清' } : { pass: false };
    case 'live':
      return v.liveBroadcastContent === spec.eventType ? { pass: true, badge: spec.eventType === 'live' ? '✓ 直播中' : '✓ 即将直播' } : { pass: false };
  }
}

export interface FilterOutcome {
  kept: VideoCandidate[];
  stats: FilterStat[];
}

/** 依次应用硬过滤；每条被淘汰的候选只记在第一个没通过的过滤器上。 */
export function applyFilters(cands: VideoCandidate[], filters: CheckSpec[], ctx: CheckContext): FilterOutcome {
  const removed = new Map<string, number>(filters.map((f) => [f.id, 0]));
  const kept: VideoCandidate[] = [];
  for (const v of cands) {
    const failed = filters.find((f) => !evaluateCheck(f, v, ctx).pass);
    if (failed) removed.set(failed.id, (removed.get(failed.id) ?? 0) + 1);
    else kept.push(v);
  }
  return { kept, stats: filters.map((f) => ({ checkId: f.id, label: f.label, removed: removed.get(f.id) ?? 0 })) };
}

export function ageDays(v: VideoCandidate, now: number): number {
  const t = Date.parse(v.publishedAt);
  return Number.isFinite(t) ? Math.max(0, (now - t) / DAY_MS) : 365;
}
