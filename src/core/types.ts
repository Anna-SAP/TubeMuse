// 领域类型。core/ 下全部是纯逻辑（无 chrome / fetch / 时钟副作用），可直接单测。

export type FactorKey = 'relevance' | 'topic' | 'taste' | 'quality' | 'freshness' | 'format' | 'channelPref';

export const FACTOR_LABELS: Record<FactorKey, string> = {
  relevance: '检索相关度',
  topic: '主题命中',
  taste: '个人品味',
  quality: '热度与质量',
  freshness: '新鲜度',
  format: '形式匹配',
  channelPref: '频道偏好',
};

// ───────────────────────── 约束与意图 ─────────────────────────

export type ConstraintKind =
  | 'topic'
  | 'language'
  | 'recency'
  | 'duration'
  | 'format'
  | 'quality'
  | 'caption'
  | 'exclude_shorts'
  | 'exclude_terms'
  | 'channel'
  | 'subscriptions_only'
  | 'min_views'
  | 'definition'
  | 'live'
  | 'region'
  | 'sort'
  | 'count'
  | 'other';

export const CONSTRAINT_KINDS: readonly ConstraintKind[] = [
  'topic',
  'language',
  'recency',
  'duration',
  'format',
  'quality',
  'caption',
  'exclude_shorts',
  'exclude_terms',
  'channel',
  'subscriptions_only',
  'min_views',
  'definition',
  'live',
  'region',
  'sort',
  'count',
  'other',
];

export const KIND_LABELS: Record<ConstraintKind, string> = {
  topic: '主题',
  language: '语言',
  recency: '时效',
  duration: '时长',
  format: '形式',
  quality: '质量',
  caption: '字幕',
  exclude_shorts: '排除 Shorts',
  exclude_terms: '排除词',
  channel: '频道',
  subscriptions_only: '仅订阅频道',
  min_views: '播放量',
  definition: '清晰度',
  live: '直播',
  region: '地区',
  sort: '排序偏好',
  count: '数量',
  other: '其他要求',
};

export type FormatKind =
  | 'interview'
  | 'tutorial'
  | 'lecture'
  | 'explainer'
  | 'podcast'
  | 'documentary'
  | 'review'
  | 'news'
  | 'other';
export const FORMAT_KINDS: readonly FormatKind[] = [
  'interview',
  'tutorial',
  'lecture',
  'explainer',
  'podcast',
  'documentary',
  'review',
  'news',
  'other',
];
export type QualityAspect = 'popular' | 'high_engagement' | 'authoritative' | 'in_depth' | 'production' | 'other';
export const QUALITY_ASPECTS: readonly QualityAspect[] = [
  'popular',
  'high_engagement',
  'authoritative',
  'in_depth',
  'production',
  'other',
];
export type SortBy = 'recency' | 'popularity' | 'rating' | 'relevance';
export const SORT_BYS: readonly SortBy[] = ['recency', 'popularity', 'rating', 'relevance'];
export type ChannelMode = 'only' | 'exclude' | 'prefer';
export const CHANNEL_MODES: readonly ChannelMode[] = ['only', 'exclude', 'prefer'];
export type EventType = 'live' | 'completed' | 'upcoming';
export const EVENT_TYPES: readonly EventType[] = ['live', 'completed', 'upcoming'];

export interface ConstraintParams {
  terms?: string[];
  language?: string;
  withinHours?: number;
  minMinutes?: number;
  maxMinutes?: number;
  format?: FormatKind;
  aspect?: QualityAspect;
  channelNames?: string[];
  mode?: ChannelMode;
  minViews?: number;
  count?: number;
  sortBy?: SortBy;
  eventType?: EventType;
  regionCode?: string;
  description?: string;
}

export type ConstraintSource = 'llm' | 'rule' | 'coverage' | 'user';

export interface Constraint {
  id: string;
  kind: ConstraintKind;
  /** 原句中的片段（用户手动添加时为空） */
  span: string;
  /** 人话描述 */
  label: string;
  importance: 'hard' | 'soft';
  source: ConstraintSource;
  params: ConstraintParams;
  /** 规范化过程中产生的提示（例如字段无效被改为"其他"） */
  normalizationNote?: string;
}

export interface QuerySpec {
  q: string;
  /** ISO 639-1，空表示未指定 */
  language?: string;
}

export interface Intent {
  utterance: string;
  interpretation: string;
  topic: string;
  queries: QuerySpec[];
  constraints: Constraint[];
  /** 本次解析参考了几条理解纠正 */
  correctionsUsed: number;
  parsedAt: number;
  /** 解析过程的提示，例如"本地规则补充了 1 个约束" */
  notes: string[];
}

// ───────────────────────── 落实方式（回显用） ─────────────────────────

export type Disposition =
  | { type: 'api_param'; param: string; value: string; note?: string }
  | { type: 'query_term'; detail: string }
  | { type: 'post_filter'; detail: string; note?: string }
  | { type: 'rank_factor'; detail: string; note?: string }
  | { type: 'result_count'; detail: string }
  | { type: 'unsupported'; reason: string }
  | { type: 'reference_only'; reason: string };

/**
 * enforced：有硬信号（API 参数或后置过滤）；approximate：仅检索词/排序因子；
 * partial：部分落实、部分无法满足；reference_only：仅作参考；unsupported：无法满足。
 */
export type CoverageStatus = 'enforced' | 'approximate' | 'partial' | 'reference_only' | 'unsupported';

export type CheckKind =
  | 'language'
  | 'recency'
  | 'duration'
  | 'caption'
  | 'not_shorts'
  | 'exclude_terms'
  | 'channel_only'
  | 'channel_exclude'
  | 'subscribed'
  | 'min_views'
  | 'definition_hd'
  | 'live';

export interface CheckSpec {
  id: string;
  kind: CheckKind;
  constraintId: string;
  label: string;
  language?: string;
  withinHours?: number;
  minSeconds?: number;
  maxSeconds?: number;
  terms?: string[];
  channelIds?: string[];
  channelNames?: string[];
  minViews?: number;
  eventType?: EventType;
}

export interface PlannedQuery {
  q: string;
  params: Record<string, string>;
}

export interface RankDirectives {
  freshness: boolean;
  popularity: boolean;
  engagement: boolean;
  authority: boolean;
  depth: boolean;
  formatTerms: string[];
  topicTerms: string[];
  referenceTerms: string[];
  preferChannelIds: string[];
  preferChannelNames: string[];
}

export interface SearchPlan {
  queries: PlannedQuery[];
  /** 公共 API 参数里的时间窗以"相对小时数"记录，便于缓存键稳定 */
  withinHours?: number;
  postFilters: CheckSpec[];
  softChecks: CheckSpec[];
  rank: RankDirectives;
  resultCount: number;
  dispositions: Record<string, Disposition[]>;
  coverage: Record<string, CoverageStatus>;
  estimatedCost: { searchCalls: number; generalUnits: number };
  /** 过滤后不足时，在预算内最多追加翻页几次 */
  maxExtraPages: number;
  notes: string[];
}

// ───────────────────────── 视频与画像 ─────────────────────────

export interface VideoCandidate {
  id: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  durationSec: number;
  viewCount?: number;
  likeCount?: number;
  caption: boolean;
  definition: 'hd' | 'sd';
  defaultAudioLanguage?: string;
  defaultLanguage?: string;
  tags: string[];
  thumbnailUrl?: string;
  liveBroadcastContent: 'none' | 'live' | 'upcoming';
  channelSubscriberCount?: number;
  /** 在哪些检索词的结果里出现、排第几（1 起） */
  hits: { queryIndex: number; rank: number }[];
}

export interface ChannelInfo {
  id: string;
  title: string;
  description: string;
  topicCategories: string[];
  subscriberCount?: number;
}

export interface LikedVideo {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  tags: string[];
}

export interface Profile {
  syncedAt?: number;
  subscriptions: ChannelInfo[];
  likedVideos: LikedVideo[];
  /** 喜欢的视频里出现、但未订阅的频道 */
  likedChannels: ChannelInfo[];
}

export interface InterestCluster {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  channelIds: string[];
  /** 0.2–2，默认 1 */
  weight: number;
  /** 用户编辑过：重新生成时保留 */
  locked: boolean;
  source: 'llm' | 'user';
  updatedAt: number;
  /** 学习/娱乐倾向（LLM 给出初值，可在"画像"页修改）；Phase 1 生成的簇没有这个字段 */
  nature?: Nature;
}

export interface ClusterState {
  clusters: InterestCluster[];
  generatedAt?: number;
}

// ───────────────────────── 排序模型与学习 ─────────────────────────

export interface ChannelPref {
  value: number;
  title: string;
  ratings: number;
}

export interface RankingModel {
  weights: Record<FactorKey, number>;
  channelPrefs: Record<string, ChannelPref>;
  version: number;
  updatedAt?: number;
}

export interface RankedItem {
  video: VideoCandidate;
  features: Record<FactorKey, number>;
  activeFactors: FactorKey[];
  score: number;
  reasons: string[];
  badges: string[];
  warnings: string[];
  matchedClusterIds: string[];
  previousRating?: number;
}

export type Attribution = 'understanding' | 'retrieval' | 'none' | 'pending';

export interface RatingRecord {
  videoId: string;
  rating: number;
  searchId: string;
  utterance: string;
  at: number;
  attribution: Attribution;
  /** 理解错时：哪个约束（id）或 'whole' */
  understandingAspect?: string;
  note?: string;
  video: { title: string; channelId: string; channelTitle: string };
  adjustmentId?: string;
}

export type Change =
  | { type: 'channelPref'; channelId: string; channelTitle: string; before: number; after: number; explanation: string }
  | { type: 'factorWeight'; factor: FactorKey; before: number; after: number; explanation: string }
  | { type: 'clusterWeight'; clusterId: string; clusterName: string; before: number; after: number; explanation: string }
  | { type: 'correction'; correctionId: string; explanation: string }
  | { type: 'none'; explanation: string };

export interface Adjustment {
  id: string;
  at: number;
  trigger: {
    videoId: string;
    title: string;
    rating: number;
    attribution: Attribution;
    searchId: string;
    utterance: string;
  };
  changes: Change[];
  reverted: boolean;
}

export interface UnderstandingCorrection {
  id: string;
  at: number;
  utterance: string;
  /** 被理解错的约束（快照）；整体理解错时为空 */
  constraint?: { kind: ConstraintKind; span: string; label: string };
  note: string;
  active: boolean;
}

// ───────────────────────── 搜索会话 ─────────────────────────

export interface FilterStat {
  checkId: string;
  label: string;
  removed: number;
}

export interface SearchSession {
  id: string;
  createdAt: number;
  utterance: string;
  intent: Intent;
  plan: SearchPlan;
  candidates: VideoCandidate[];
  fetchedCount: number;
  filterStats: FilterStat[];
  rankedIds: string[];
  modelVersion: number;
  fromCache: boolean;
  cacheAgeMs?: number;
  cost: { searchCalls: number; generalUnits: number };
  extraPagesUsed: number;
}

// ───────────────────────── Phase 2：观看、总结、提醒 ─────────────────────────

export type WatchStatus = 'completed' | 'partial' | 'glance';
export const WATCH_STATUS_LABELS: Record<WatchStatus, string> = { completed: '看完', partial: '部分观看', glance: '瞥一眼' };

/** 一次连续的观看会话（内容脚本按 sessionId 上报累计值，重复上报是幂等的） */
export interface WatchSession {
  id: string;
  videoId: string;
  startedAt: number;
  updatedAt: number;
  /** 播放器报告的视频时长（秒） */
  durationSec: number;
  /** 实际播放过的内容区间（秒，已合并）；拖动进度条跳过的部分不在其中 */
  intervals: [number, number][];
  /** 有效观看（墙钟秒）：正在播放、不是广告时才计 */
  playSec: number;
  /** 其中标签页在前台 / 后台的部分 */
  fgSec: number;
  bgSec: number;
  /** 广告播放时长（不计入有效观看） */
  adSec: number;
  shorts: boolean;
}

/** 按"本地日期 + 视频"汇总的观看记录 */
export interface WatchRecord {
  day: string;
  videoId: string;
  sessionIds: string[];
  firstAt: number;
  lastAt: number;
  durationSec: number;
  /** 0–1：播放过的内容区间并集 / 时长 */
  completion: number;
  playSec: number;
  fgSec: number;
  bgSec: number;
  status: WatchStatus;
  /** 以后台为主（后台时长 > 前台时长）：标为"后台收听" */
  background: boolean;
  shorts: boolean;
}

export interface VideoMeta {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  categoryId?: string;
  durationSec: number;
  tags: string[];
  fetchedAt: number;
  /** 视频已删除/私有，API 查不到 */
  missing?: boolean;
}

export type Nature = 'learning' | 'entertainment' | 'other';
export const NATURE_LABELS: Record<Nature, string> = { learning: '学习', entertainment: '娱乐', other: '其他' };

export interface NatureVerdict {
  nature: Nature;
  score: number;
  /** 判定依据（人话），例如"YouTube 分类：教育（+1.5）" */
  reasons: string[];
  /** user：被用户纠正过 */
  source: 'user_video' | 'user_channel' | 'signals';
}

export interface NatureRules {
  channels: Record<string, { nature: Nature; title: string }>;
  videos: Record<string, Nature>;
}

export interface WindowStats {
  fromDay: string;
  toDay: string;
  totalSec: number;
  learningSec: number;
  entertainmentSec: number;
  otherSec: number;
  learningRatio: number;
  entertainmentRatio: number;
}

export interface SummaryItem {
  videoId: string;
  title: string;
  channelTitle: string;
  text: string;
}

export interface DailySummary {
  day: string;
  generatedAt: number;
  /** 用户手动生成（之后到点会按完整的一天重新生成） */
  manual: boolean;
  headline: string;
  learned: SummaryItem[];
  revisit: SummaryItem[];
  passingBy: SummaryItem[];
  goalLink: string;
  stats: {
    videos: number;
    completed: number;
    partial: number;
    glance: number;
    background: number;
    playMinutes: number;
    learningMinutes: number;
    entertainmentMinutes: number;
  };
  notes: string[];
  markdown: string;
}

export interface WeeklyReport {
  weekKey: string;
  fromDay: string;
  toDay: string;
  generatedAt: number;
  lowRatings: number;
  patterns: { pattern: string; suggestion: string; examples: string[] }[];
  overview: string;
  adjustments: string[];
  stats: WindowStats;
  notes: string[];
  markdown: string;
}

export interface ReminderStep {
  kind: 'video' | 'search';
  title: string;
  videoId?: string;
  channelTitle?: string;
  utterance?: string;
  why: string;
}

export interface ActiveReminder {
  id: string;
  createdAt: number;
  stats: WindowStats;
  message: string;
  step?: ReminderStep;
  dismissed: boolean;
}

export interface ReminderState {
  lastTriggeredAt?: number;
  mutedUntil?: number;
  disabled?: boolean;
  active?: ActiveReminder;
}

export interface TakeoutChannel {
  channelId: string;
  title: string;
  count: number;
  lastWatched: string;
}

export interface TakeoutProfile {
  importedAt: number;
  totalEntries: number;
  firstWatched?: string;
  lastWatched?: string;
  channels: TakeoutChannel[];
  recent: { videoId: string; title: string; channelTitle: string; time: string }[];
  skipped: { ads: number; noVideo: number; invalid: number };
}

// ───────────────────────── Phase 3：X 热点、新博主 ─────────────────────────

export interface XPost {
  id: string;
  text: string;
  createdAt: string;
  lang?: string;
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  /** 由哪个兴趣主题检索到 */
  topic: string;
}

export interface Hotspot {
  id: string;
  title: string;
  summary: string;
  /** 一键找片用的口令 */
  utterance: string;
  topic: string;
  posts: { id: string; url: string; text: string; likes: number; reposts: number; createdAt: string }[];
}

export interface HotspotState {
  fetchedAt: number;
  items: Hotspot[];
  topics: string[];
  /** 这次刷新实际花费（美元，按本地账本） */
  spentUsd: number;
  postsRead: number;
  /** 因预算不足等原因没查完 */
  partial: boolean;
  notes: string[];
}

export interface CreatorRecommendation {
  channelId: string;
  title: string;
  subscriberCount?: number;
  topic: string;
  reasons: string[];
  recentVideos: { videoId: string; title: string; publishedAt: string }[];
  score: number;
}

export interface DiscoveryWeek {
  searchCalls: number;
  generatedAt?: number;
  recommendations: CreatorRecommendation[];
  notes: string[];
}

export interface DiscoveryState {
  /** 周键 = 该周结束日（与每周自省相同） */
  weeks: Record<string, DiscoveryWeek>;
  /** 你点过"不感兴趣"的频道，不再推荐 */
  dismissed: Record<string, { title: string; at: number }>;
}

// ── 豆瓣评论 RSS ──

export interface DoubanReview {
  /** 评论 ID（取自链接 /review/<ID>/；取不到时用 guid / 链接） */
  id: string;
  title: string;
  /** 评论原文链接（只接受 https 的 douban.com 地址，否则不给链接） */
  url?: string;
  author: string;
  authorUrl?: string;
  /** 毫秒时间戳；RSS 里没有或解析不了时为 0 */
  publishedAt: number;
  /** RSS 只附开头一小段（豆瓣在服务端就截断了） */
  excerpt: string;
  truncated: boolean;
  /** 评价词（力荐 / 推荐 / 还行 / 较差 / 很差，或其他原文）；RSS 里常为空 */
  rating?: string;
}

export interface DoubanFeed {
  subjectId: string;
  /** 条目名，例如"白衣逆行者" */
  title: string;
  /** 条目页（movie / book / music.douban.com） */
  subjectUrl?: string;
  /** 电影 / 图书 / 音乐 / 条目 */
  kind: string;
  /** 条目海报（只接受豆瓣图片域名） */
  posterUrl?: string;
  /** 按发布时间从新到旧 */
  reviews: DoubanReview[];
}

export interface DoubanSubject {
  id: string;
  /** 读取 RSS 之前不知道条目名 */
  title?: string;
  addedAt: number;
}

export interface DoubanState {
  subjects: DoubanSubject[];
  feeds: Record<string, { fetchedAt: number; feed: DoubanFeed }>;
  /** 上次看的条目 */
  selected?: string;
}
