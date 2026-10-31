// 类型化的本地数据仓库：每个键一个 Store，读时补默认值，改时加锁。

import { DEFAULT_FACTOR_WEIGHTS, DEFAULT_SETTINGS, DOUBAN } from '../config/defaults';
import { EMPTY_LEDGER, type QuotaLedger } from '../core/quota';
import type { SearchCache } from '../core/cache';
import type { XLedger } from '../core/x-budget';
import type { DiscoveryState, DoubanState, HotspotState, SubtitleIndex, SubtitleTrack } from '../core/types';
import type { SubtitleLedger } from '../core/subtitles';
import type {
  Adjustment,
  ClusterState,
  DailySummary,
  NatureRules,
  ReminderState,
  TakeoutProfile,
  VideoMeta,
  WatchRecord,
  WatchSession,
  WeeklyReport,
  Profile,
  RankingModel,
  RatingRecord,
  SearchSession,
  UnderstandingCorrection,
} from '../core/types';
import type { KV, Locker } from './storage';

export type Settings = typeof DEFAULT_SETTINGS;

export interface Secrets {
  anthropicApiKey?: string;
  /** Anthropic 工作区 ID：Key 没有绑定工作区时才需要；和 Key 放在一起，不进导出 */
  anthropicWorkspaceId?: string;
  openaiApiKey?: string;
  /** X API 的 App-only Bearer Token */
  xBearerToken?: string;
}

/** 旧版的"无字幕时自动开始"（autoStart，默认开）：改为默认关闭后换了新键，旧值丢弃，大家都从"关"开始 */
function withoutLegacySubtitleKeys(stored: unknown): object {
  if (!stored || typeof stored !== 'object') return {};
  const { autoStart: _legacy, ...rest } = stored as Record<string, unknown>;
  return rest;
}

/** 设置按分区与默认值合并，旧版本存下的数据缺字段也能正常读取。 */
export function mergeSettings(stored: unknown): Settings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<Record<keyof Settings, Record<string, unknown>>>;
  const d = DEFAULT_SETTINGS;
  return {
    llm: {
      ...d.llm,
      ...(s.llm as object),
      models: { ...d.llm.models, ...((s.llm?.models as object) ?? {}) },
    },
    quota: { ...d.quota, ...(s.quota as object) },
    search: { ...d.search, ...(s.search as object) },
    voice: { ...d.voice, ...(s.voice as object) },
    learning: { ...d.learning, ...(s.learning as object) },
    profile: { ...d.profile, ...(s.profile as object) },
    tracking: { ...d.tracking, ...(s.tracking as object) },
    summary: { ...d.summary, ...(s.summary as object) },
    reminder: { ...d.reminder, ...(s.reminder as object) },
    weekly: { ...d.weekly, ...(s.weekly as object) },
    x: { ...d.x, ...(s.x as object) },
    discovery: { ...d.discovery, ...(s.discovery as object) },
    douban: { ...d.douban, ...(s.douban as object) },
    subtitles: {
      ...d.subtitles,
      ...withoutLegacySubtitleKeys(s.subtitles),
      translationModels: { ...d.subtitles.translationModels, ...((s.subtitles?.translationModels as object) ?? {}) },
    },
  } as Settings;
}

export class Store<T> {
  constructor(
    readonly key: string,
    private readonly fallback: () => T,
    private readonly fix: (stored: unknown) => T = (v) => (v === undefined ? fallback() : (v as T)),
  ) {}

  async read(kv: KV): Promise<T> {
    return this.fix(await kv.get(this.key));
  }

  async write(kv: KV, value: T): Promise<void> {
    await kv.set(this.key, value);
  }

  /** 加锁读改写；返回新值 */
  async update(kv: KV, locker: Locker, fn: (current: T) => T | Promise<T>): Promise<T> {
    return locker.withLock(this.key, async () => {
      const next = await fn(await this.read(kv));
      await kv.set(this.key, next);
      return next;
    });
  }
}

export const defaultRankingModel = (): RankingModel => ({ weights: { ...DEFAULT_FACTOR_WEIGHTS }, channelPrefs: {}, version: 1 });
export const defaultDoubanState = (): DoubanState => ({ subjects: DOUBAN.defaultSubjects.map((s) => ({ ...s, addedAt: 0 })), feeds: {} });
export const emptyProfile = (): Profile => ({ subscriptions: [], likedVideos: [], likedChannels: [] });

export const stores = {
  settings: new Store<Settings>('settings', () => mergeSettings(undefined), mergeSettings),
  secrets: new Store<Secrets>('secrets', () => ({})),
  profile: new Store<Profile>('profile', emptyProfile, (v) => ({ ...emptyProfile(), ...((v as object) ?? {}) })),
  clusters: new Store<ClusterState>('clusters', () => ({ clusters: [] })),
  rankingModel: new Store<RankingModel>('rankingModel', defaultRankingModel, (v) => {
    const m = v as RankingModel | undefined;
    return m ? { ...m, weights: { ...DEFAULT_FACTOR_WEIGHTS, ...m.weights } } : defaultRankingModel();
  }),
  ratings: new Store<Record<string, RatingRecord>>('ratings', () => ({})),
  adjustments: new Store<Adjustment[]>('adjustments', () => []),
  corrections: new Store<UnderstandingCorrection[]>('corrections', () => []),
  quotaLedger: new Store<QuotaLedger>('quotaLedger', () => EMPTY_LEDGER),
  searchCache: new Store<SearchCache>('searchCache', () => ({})),
  searchSessions: new Store<SearchSession[]>('searchSessions', () => []),
  // Phase 2
  /** 进行中/最近的原始观看会话（按 id），保留几天后只留汇总 */
  watchSessions: new Store<Record<string, WatchSession>>('watchSessions', () => ({})),
  /** 按本地日期 → 视频 ID 汇总的观看记录 */
  watchLog: new Store<Record<string, Record<string, WatchRecord>>>('watchLog', () => ({})),
  videoMeta: new Store<Record<string, VideoMeta>>('videoMeta', () => ({})),
  natureRules: new Store<NatureRules>('natureRules', () => ({ channels: {}, videos: {} })),
  summaries: new Store<Record<string, DailySummary>>('summaries', () => ({})),
  weeklyReports: new Store<Record<string, WeeklyReport>>('weeklyReports', () => ({})),
  reminderState: new Store<ReminderState>('reminderState', () => ({})),
  takeout: new Store<TakeoutProfile | null>('takeout', () => null),
  jobState: new Store<JobState>('jobState', () => ({ failures: {} })),
  // Phase 3
  xLedger: new Store<XLedger>('xLedger', () => ({ days: {} })),
  hotspots: new Store<HotspotState | null>('hotspots', () => null),
  discovery: new Store<DiscoveryState>('discovery', () => ({ weeks: {}, dismissed: {} })),
  /** 豆瓣评论 RSS：订阅的条目与各自最近一次读取的结果 */
  douban: new Store<DoubanState>('douban', defaultDoubanState),
  /** 自动字幕：哪些视频有字幕（字幕本身按视频分键存放，见 subtitleTrackStore） */
  subtitleIndex: new Store<SubtitleIndex>('subtitleIndex', () => ({})),
  /** 自动字幕花费记账（按本地日） */
  subtitleLedger: new Store<SubtitleLedger>('subtitleLedger', () => ({ days: {} })),
  /** YouTube 授权：当前访问令牌与续期状态（不进导出） */
  youtubeAuth: new Store<YouTubeAuthState | null>('youtubeAuth', () => null),
};

/** 一个视频的字幕（按视频时间），回看时直接用、不再花钱。每个视频一个键：写入时不必把所有视频的字幕都重写一遍 */
export function subtitleTrackStore(videoId: string): Store<SubtitleTrack | null> {
  return new Store<SubtitleTrack | null>(`subtitles:${videoId}`, () => null);
}

export interface YouTubeAuthState {
  accessToken?: string;
  expiresAt?: number;
  scope?: string;
  /** 首次交互授权的时间；有这条记录就算"已连接过"，断开时删除整条 */
  connectedAt: number;
  /** 最近一次静默续期失败的时间与原因（成功或重新授权后清除） */
  renewFailedAt?: number;
  renewError?: string;
}

/** 后台任务状态：首次运行的日期（补算不早于它）、最近一次检查、失败记录（展示给用户，不静默） */
export interface JobState {
  firstDay?: string;
  lastRunAt?: number;
  lastMetadataAt?: number;
  failures: Record<string, { at: number; message: string; hint?: string }>;
}

/** 导出时排除的键：API Key 与授权相关信息不进入导出文件。 */
export const EXPORT_EXCLUDED_KEYS = new Set<string>([stores.secrets.key, stores.youtubeAuth.key]);

export function newId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${Date.now().toString(36)}${rand[0]!.toString(36)}${rand[1]!.toString(36)}`.slice(0, 24);
}
