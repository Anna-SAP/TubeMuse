// 类型化的本地数据仓库：每个键一个 Store，读时补默认值，改时加锁。

import { DEFAULT_FACTOR_WEIGHTS, DEFAULT_SETTINGS, DOUBAN, X_DEFAULTS_VERSION } from '../config/defaults';
import { EMPTY_LEDGER, type QuotaLedger } from '../core/quota';
import type { SearchCache } from '../core/cache';
import type { XLedger } from '../core/x-budget';
import { EMPTY_LLM_LEDGER, type LlmLedger } from '../core/spend';
import type { DiscoveryState, DoubanState, HotspotDraft, HotspotState, Intent, SubtitleIndex, SubtitleTrack } from '../core/types';
import type { SubtitleLedger } from '../core/subtitles';
import type { ClipRecord } from '../core/clips';
import type { MuseVideoInfo } from '../core/muse';
import { sanitizeCcLangs } from '../core/multi-captions';
import { emptyXhsState, sanitizeXhsState, type XhsState } from '../core/xhs';
import { emptyEmailState, sanitizeEmailState, type EmailScores, type EmailState, type EmailVerdicts } from '../core/email';
import { emptyXyzSaved, sanitizeXyzSaved, type XyzListen, type XyzSaved, type XyzSnapshotRecord, type XyzTranscript } from '../core/xyz';
import type { Mp3Scan } from '../core/podcast-audio';
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
  /**
   * Google Cloud 里那个"Web 应用"OAuth 客户端的 Client Secret：换授权码、用刷新令牌续期时要带（DECISIONS §53）。
   * 和其他 Key 一样只存本机、不进导出，只随请求体发往 oauth2.googleapis.com/token。
   */
  googleClientSecret?: string;
  /**
   * 同一个客户端的 Client ID：不是机密，通常在构建时从 local/config.json 注入；没注入的构建（例如别处打好的 Firefox 安装包）
   * 在设置页填这里（DECISIONS §69）。和 Client Secret 放在一起，不进导出。
   */
  googleClientId?: string;
}

/** 旧版的"无字幕时自动开始"（autoStart，默认开）：改为默认关闭后换了新键，旧值丢弃，大家都从"关"开始 */
function withoutLegacySubtitleKeys(stored: unknown): object {
  if (!stored || typeof stored !== 'object') return {};
  const { autoStart: _legacy, ...rest } = stored as Record<string, unknown>;
  return rest;
}

/** 旧版的"有字幕的视频自动显示"（autoOn）：用户要求默认关闭后换了新键，旧值丢弃，大家都从"关"开始（内容脚本不经过这里，读的也是新键） */
function withoutLegacyMultiCcKeys(stored: unknown): object {
  if (!stored || typeof stored !== 'object') return {};
  const { autoOn: _legacy, ...rest } = stored as Record<string, unknown>;
  return rest;
}

/**
 * X 设置从旧版迁移一次：花钱的自动刷新回到"关"（这一步要你明确打开，DECISIONS §48），旧默认的每主题 15 条换成 10 条。
 * 你之后再改的值带着新版本号存下，不会被改回来。
 */
function xSettings(stored: unknown): Settings['x'] {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<Settings['x']>;
  const merged = { ...DEFAULT_SETTINGS.x, ...s };
  if ((s.defaultsVersion ?? 1) >= X_DEFAULTS_VERSION) return merged;
  return {
    ...merged,
    autoRefresh: false,
    postsPerTopic: s.postsPerTopic === 15 ? DEFAULT_SETTINGS.x.postsPerTopic : merged.postsPerTopic,
    defaultsVersion: X_DEFAULTS_VERSION,
  };
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
      economyModels: { ...d.llm.economyModels, ...((s.llm?.economyModels as object) ?? {}) },
      taskTiers: { ...((s.llm?.taskTiers as object) ?? {}) },
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
    x: xSettings(s.x),
    discovery: { ...d.discovery, ...(s.discovery as object) },
    douban: { ...d.douban, ...(s.douban as object) },
    subtitles: {
      ...d.subtitles,
      ...withoutLegacySubtitleKeys(s.subtitles),
      translationModels: { ...d.subtitles.translationModels, ...((s.subtitles?.translationModels as object) ?? {}) },
    },
    multiCaptions: {
      ...d.multiCaptions,
      ...withoutLegacyMultiCcKeys(s.multiCaptions),
      langs: sanitizeCcLangs(s.multiCaptions?.langs) ?? [...d.multiCaptions.langs],
    },
    clips: { ...d.clips, ...(s.clips as object) },
    xhs: { ...d.xhs, ...(s.xhs as object) },
    email: { ...d.email, ...(s.email as object) },
    muse: { ...d.muse, ...(s.muse as object) },
    xyz: { ...d.xyz, ...(s.xyz as object) },
    ui: { ...d.ui, ...(s.ui as object) },
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
  /** 大模型花费记账（按本地日），含进行中的预扣 */
  llmLedger: new Store<LlmLedger>('llmLedger', () => EMPTY_LLM_LEDGER),
  /** 最近理解过的口令：同一句话短时间内再提交不再调大模型 */
  intentCache: new Store<IntentCacheEntry[]>('intentCache', () => []),
  hotspots: new Store<HotspotState | null>('hotspots', () => null),
  /** 读到了、还没整理成热点的帖子：下次刷新直接用，不再读 X */
  hotspotDraft: new Store<HotspotDraft | null>('hotspotDraft', () => null),
  discovery: new Store<DiscoveryState>('discovery', () => ({ weeks: {}, dismissed: {} })),
  /** 豆瓣评论 RSS：订阅的条目与各自最近一次读取的结果 */
  douban: new Store<DoubanState>('douban', defaultDoubanState),
  /** 自动字幕：哪些视频有字幕（字幕本身按视频分键存放，见 subtitleTrackStore） */
  subtitleIndex: new Store<SubtitleIndex>('subtitleIndex', () => ({})),
  /** 自动字幕花费记账（按本地日） */
  subtitleLedger: new Store<SubtitleLedger>('subtitleLedger', () => ({ days: {} })),
  /** 录过并保存的视频片段（只有标题、时间段、大小、文件名；视频文件在浏览器的下载文件夹，不在这里） */
  clipLog: new Store<ClipRecord[]>('clipLog', () => []),
  /** Capture 截图用过的最大序号（全局递增，写进文件名；截图文件在浏览器的下载文件夹，不在这里） */
  captureSeq: new Store<number>('captureSeq', () => 0, (v) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : 0)),
  /** 「问 muse」：最近问过的 YouTube 视频的标题、作者和简介（官方 videos.list 查来的；同一个视频再问不用再查，只留最近几十个） */
  museVideos: new Store<Record<string, MuseVideoInfo>>('museVideos', () => ({})),
  /** 小红书：收进 TubeMuse 的笔记与博主，各自的标签（只存在本机，与小红书账号里的收藏、关注无关） */
  xhs: new Store<XhsState>('xhs', emptyXhsState, (v) => sanitizeXhsState(v, Date.now())),
  /** eMails：收藏的文章与各自的标签（只存在本机，与邮箱、Medium 账号无关） */
  emailSaved: new Store<EmailState>('emailSaved', emptyEmailState, sanitizeEmailState),
  /** eMails：大模型给每篇文章打的分（按文章缓存：同一篇隔天再出现时不再花钱） */
  emailScores: new Store<EmailScores>('emailScores', () => ({})),
  /** eMails：每封邮件的总体结论（键是 verdictKey：文章和分数都对得上才显示） */
  emailVerdicts: new Store<EmailVerdicts>('emailVerdicts', () => ({})),
  /** 小宇宙：哪些单集有字幕（字幕本身按单集分键存放，见 xyzTranscriptStore） */
  xyzTranscriptIndex: new Store<Record<string, number>>('xyzTranscriptIndex', () => ({})),
  /** 小宇宙：收藏的单集与节目、各自的标签（只存在本机，与小宇宙账号里的订阅、收藏无关） */
  xyzSaved: new Store<XyzSaved>('xyzSaved', emptyXyzSaved, (v) => sanitizeXyzSaved(v)),
  /** 小宇宙：收听记录（单集 ID → 累计） */
  xyzListens: new Store<Record<string, XyzListen>>('xyzListens', () => ({})),
  /** 小宇宙：做过的片段快照（只有元数据；图片与音频在下载文件夹） */
  xyzSnapshots: new Store<XyzSnapshotRecord[]>('xyzSnapshots', () => []),
  /** 小宇宙：可变码率 mp3 的帧位置索引（音频地址 → 扫描结果；只有帧的位置，没有音频） */
  xyzScans: new Store<Record<string, { scan: Mp3Scan; at: number }>>('xyzScans', () => ({})),
  /** YouTube 授权：访问令牌、刷新令牌与续期状态（不进导出） */
  youtubeAuth: new Store<YouTubeAuthState | null>('youtubeAuth', () => null),
  /** 最近一次连接 / 重新授权：何时开始、是否结束、失败原因（不进导出） */
  authAttempt: new Store<AuthAttempt | null>('authAttempt', () => null),
};

/** 一个视频的字幕（按视频时间），回看时直接用、不再花钱。每个视频一个键：写入时不必把所有视频的字幕都重写一遍 */
export function subtitleTrackStore(videoId: string): Store<SubtitleTrack | null> {
  return new Store<SubtitleTrack | null>(`subtitles:${videoId}`, () => null);
}

/** 一集小宇宙的字幕（按真实时间）：每集一个键 */
export function xyzTranscriptStore(eid: string): Store<XyzTranscript | null> {
  return new Store<XyzTranscript | null>(`xyzTranscript:${eid}`, () => null);
}

export interface YouTubeAuthState {
  accessToken?: string;
  expiresAt?: number;
  scope?: string;
  /**
   * 刷新令牌（授权码流程拿到）：有它，访问令牌过期后在后台向 Google 换新的，不弹窗、不依赖浏览器里的 Google 登录。
   * 没有它的是旧版（隐式授权）记录，访问令牌过期后只能重新授权。
   */
  refreshToken?: string;
  /** 拿到这个刷新令牌的时间（Google 应用处于"测试"状态时，它 7 天后失效） */
  refreshIssuedAt?: number;
  /** Google 在响应里给了刷新令牌有效期（refresh_token_expires_in）时，它失效的时间 */
  refreshExpiresAt?: number;
  /** 首次交互授权的时间；有这条记录就算"已连接过"，断开时删除整条 */
  connectedAt: number;
  /** 最近一次续期被 Google 拒绝的时间（成功或重新授权后清除；网络问题不记） */
  renewFailedAt?: number;
  /** 那次失败的具体原因（Google 的错误码加一句人话），显示给你 */
  renewReason?: string;
  /** 续期失败后要你做的事：secret = 在设置页重新填 Client Secret（刷新令牌还在，不必重新授权）；缺省 = 重新授权 */
  renewFix?: 'secret';
}

/** 交互授权由后台执行，发起的页面可能已经关了：开始、结束与失败原因记在这里，界面重新打开后照样看得到 */
export interface AuthAttempt {
  startedAt: number;
  finishedAt?: number;
  error?: { message: string; hint?: string };
}

/** 后台任务状态：首次运行的日期（补算不早于它）、最近一次检查、失败记录（展示给用户，不静默） */
export interface JobState {
  firstDay?: string;
  lastRunAt?: number;
  lastMetadataAt?: number;
  failures: Record<string, JobFailure>;
}

export interface JobFailure {
  at: number;
  message: string;
  hint?: string;
  /** 自动试过几次 */
  attempts?: number;
  /** 到这个时间才再试（见 core/schedule.ts 的 nextJobRetry） */
  nextRetryAt?: number;
  /** 不再自动重试，等你手动再试 */
  gaveUp?: boolean;
}

export interface IntentCacheEntry {
  key: string;
  at: number;
  intent: Intent;
}

/** 导出时排除的键：API Key 与授权相关信息不进入导出文件。 */
export const EXPORT_EXCLUDED_KEYS = new Set<string>([stores.secrets.key, stores.youtubeAuth.key, stores.authAttempt.key]);

export function newId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${Date.now().toString(36)}${rand[0]!.toString(36)}${rand[1]!.toString(36)}`.slice(0, 24);
}
