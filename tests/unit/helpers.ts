import { DEFAULT_FACTOR_WEIGHTS, DEFAULT_SETTINGS } from '../../src/config/defaults';
import { rawConstraint, type RawConstraint, type RawIntent } from '../../src/core/constraints';
import type { PlannerContext } from '../../src/core/planner';
import type { InterestCluster, RankingModel, VideoCandidate } from '../../src/core/types';

/** 2026-10-24 10:00 北京时间 */
export const NOW = Date.parse('2026-10-24T02:00:00Z');
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

let vid = 0;
export function makeVideo(over: Partial<VideoCandidate> = {}): VideoCandidate {
  vid++;
  return {
    id: `v${vid}`,
    title: `Video ${vid}`,
    description: '',
    channelId: `ch${vid}`,
    channelTitle: `Channel ${vid}`,
    publishedAt: new Date(NOW - DAY).toISOString(),
    durationSec: 900,
    viewCount: 10_000,
    likeCount: 300,
    caption: false,
    definition: 'hd',
    tags: [],
    liveBroadcastContent: 'none',
    channelSubscriberCount: 50_000,
    hits: [{ queryIndex: 0, rank: vid }],
    ...over,
  };
}

export function rc(partial: Partial<RawConstraint> & { kind: string; span: string }): RawConstraint {
  return rawConstraint(partial);
}

export function rawIntent(constraints: RawConstraint[], queries: { q: string; language: string }[], extra: Partial<RawIntent> = {}): RawIntent {
  return { interpretation: '测试', topic: '', queries, constraints, ...extra };
}

export function plannerCtx(over: Partial<PlannerContext> = {}): PlannerContext {
  return {
    now: NOW,
    subscriptions: [],
    profileSynced: true,
    searchCallsPerQuery: DEFAULT_SETTINGS.quota.searchCallsPerQuery,
    generalUnitsPerQuery: DEFAULT_SETTINGS.quota.generalUnitsPerQuery,
    defaultResults: DEFAULT_SETTINGS.search.defaultResults,
    expandedResults: DEFAULT_SETTINGS.search.expandedResults,
    ...over,
  };
}

export function defaultModel(): RankingModel {
  return { weights: { ...DEFAULT_FACTOR_WEIGHTS }, channelPrefs: {}, version: 1 };
}

export function makeCluster(over: Partial<InterestCluster> = {}): InterestCluster {
  return {
    id: 'k1',
    name: 'AI 研究',
    description: '',
    keywords: ['AI', '大模型', 'LLM'],
    channelIds: [],
    weight: 1,
    locked: false,
    source: 'llm',
    updatedAt: NOW,
    ...over,
  };
}

/** 验收口令 1 的"LLM 输出"样例 */
export const UTTERANCE_1 = '帮我找两天内最新的 AI 技术科普视频';
export const RAW_1 = rawIntent(
  [
    rc({ kind: 'recency', span: '两天内', withinHours: 48 }),
    rc({ kind: 'sort', span: '最新', sortBy: 'recency' }),
    rc({ kind: 'topic', span: 'AI 技术', terms: ['AI 技术', 'AI', '人工智能', 'artificial intelligence'] }),
    rc({ kind: 'format', span: '科普', format: 'explainer', terms: ['科普', '讲解', 'explained'] }),
  ],
  [
    { q: 'AI 技术 科普', language: 'zh' },
    { q: 'AI explained', language: 'en' },
  ],
  { topic: 'AI 技术' },
);

/** 验收口令 2：6 个以上约束 */
export const UTTERANCE_2 = '英文、一小时以上、近一周、带字幕、不要 Shorts 的 AI 安全访谈';
export const RAW_2 = rawIntent(
  [
    rc({ kind: 'language', span: '英文', language: 'en' }),
    rc({ kind: 'duration', span: '一小时以上', minMinutes: 60 }),
    rc({ kind: 'recency', span: '近一周', withinHours: 168 }),
    rc({ kind: 'caption', span: '带字幕' }),
    rc({ kind: 'exclude_shorts', span: '不要 Shorts' }),
    rc({ kind: 'topic', span: 'AI 安全', terms: ['AI safety', 'AI 安全', 'alignment'] }),
    rc({ kind: 'format', span: '访谈', format: 'interview', terms: ['interview', 'podcast', 'conversation'] }),
  ],
  [{ q: 'AI safety interview', language: 'en' }],
  { topic: 'AI 安全' },
);
