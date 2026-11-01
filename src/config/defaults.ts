// 所有可调数值的唯一来源。逻辑代码不得散落魔法数字；用户可调的值在设置页覆盖。
// 外部事实（配额、计费）以 2026-10 官方文档为准，见 DECISIONS.md「外部事实核实」。

import type { FactorKey } from '../core/types';

/** YouTube Data API 配额（2026-06-01 起分桶）：search.list 单独计次，其他接口共用 units。 */
export const YOUTUBE_QUOTA = {
  /** search.list 默认每天 100 次，每次计 1（Search Queries 桶） */
  searchDailyCalls: 100,
  /** 其他接口默认每天 10,000 units */
  generalDailyUnits: 10_000,
  /** 配额在美国太平洋时间零点重置 */
  resetTimeZone: 'America/Los_Angeles',
} as const;

/** 每个 API 方法计入哪个桶、计多少。来源：官方配额计算器。 */
export const YOUTUBE_METHOD_COSTS = {
  'search.list': { bucket: 'search', cost: 1 },
  'videos.list': { bucket: 'general', cost: 1 },
  'channels.list': { bucket: 'general', cost: 1 },
  'subscriptions.list': { bucket: 'general', cost: 1 },
  'playlistItems.list': { bucket: 'general', cost: 1 },
} as const;

export type YtMethod = keyof typeof YOUTUBE_METHOD_COSTS;
export type QuotaBucket = (typeof YOUTUBE_METHOD_COSTS)[YtMethod]['bucket'];

export const YOUTUBE_LIMITS = {
  /** search.list / videos.list / channels.list 单页上限 */
  maxResultsPerPage: 50,
  /** videos.list?myRating=like 最多只能翻到最近 1000 条 */
  likedVideosHardMax: 1000,
} as const;

export const DEFAULT_SETTINGS = {
  llm: {
    provider: 'anthropic' as 'anthropic' | 'openai',
    models: {
      anthropic: 'claude-opus-5-5',
      openai: 'gpt-6.1-sol',
    },
  },
  quota: {
    searchDailyCalls: YOUTUBE_QUOTA.searchDailyCalls as number,
    generalDailyUnits: YOUTUBE_QUOTA.generalDailyUnits as number,
    /** 单次口令最多几次 search.list（对应原规格"≤300 units"的本意） */
    searchCallsPerQuery: 3,
    /** 单次口令在通用桶最多花多少 units（videos.list / channels.list） */
    generalUnitsPerQuery: 50,
    /** 已用比例达到该值时提示 */
    warnRatio: 0.8,
  },
  search: {
    cacheTtlMinutes: 30,
    defaultResults: 10,
    expandedResults: 20,
    /** 留空表示不限定地区 */
    regionCode: '',
  },
  voice: {
    lang: 'zh-CN' as 'zh-CN' | 'en-US',
    preferLocal: true,
  },
  learning: {
    autoAdjustRanking: true,
    useUnderstandingCorrections: true,
  },
  profile: {
    likedVideosMax: 300,
  },
  tracking: {
    /** 在 youtube.com 读取本地播放器状态做观看追踪 */
    enabled: true,
    /** 瞥一眼：完成率 < 该值 */
    glanceCompletion: 0.15,
    /** 瞥一眼：有效观看 < 该秒数 */
    glanceSeconds: 30,
    /** 看完：完成率 ≥ 该值 */
    completeCompletion: 0.85,
  },
  summary: {
    enabled: true,
    /** 本地时间 HH:MM */
    time: '23:00',
    /** 近期学习目标（总结里"与近期目标的关联"据此撰写） */
    goals: '',
  },
  reminder: {
    enabled: true,
    /** 滚动窗口内娱乐占比 > 该值 */
    entertainmentRatio: 0.7,
    /** 且学习占比 < 该值 */
    learningRatio: 0.15,
    windowDays: 7,
    /** 两次提醒至少间隔天数 */
    minGapDays: 3,
    /** 窗口内有效观看少于该分钟数时不评估（避免看了两分钟就被提醒） */
    minTotalMinutes: 10,
  },
  weekly: {
    enabled: true,
    /** 0 = 周日 … 6 = 周六；在当天的每日总结时间生成 */
    weekday: 0,
  },
  x: {
    enabled: true,
    /** 每日 X 花费上限（美元，按 UTC 日计，与 X 的去重窗口一致） */
    dailyBudgetUsd: 0.5,
    /** 热点缓存小时数 */
    cacheHours: 6,
    minItems: 5,
    maxItems: 8,
    /** 打开"发现"页且缓存过期时自动刷新（会产生费用） */
    autoRefresh: true,
    /** 最多查几个兴趣主题 */
    maxTopics: 4,
    /** 每个主题读几条帖子（10–100） */
    postsPerTopic: 15,
  },
  discovery: {
    enabled: true,
    /** 每周最多推荐几个新博主 */
    maxChannels: 5,
    /** 每周为此最多消耗几次 search.list */
    weeklySearchCalls: 8,
  },
  douban: {
    enabled: true,
    /** 打开"豆瓣"页、且当前条目的缓存已过期时自动读取一次 RSS */
    autoRefresh: true,
    /** 当前标签页打开的是 www.douban.com 上的条目或其评论 RSS 时，"豆瓣"页自动切到该条目（只读标签页地址） */
    followActiveTab: true,
    cacheMinutes: 30,
  },
  subtitles: {
    enabled: true,
    /**
     * 播放器显示"字幕不可用"时自动开始。默认关闭（用户 2026-11-01 要求）：每个视频都由你手动开启
     * （侧边栏"字幕"页或 Alt+Shift+S）。旧版的 autoStart（默认开）不再生效，见 mergeSettings。
     */
    autoStartNoCaptions: false,
    /** 每日字幕花费上限（美元，按本地日计）：语音转写 + 翻译 */
    dailyBudgetUsd: 1,
    /** 转写方式：浏览器自带的语音识别（免费；用户 2026-11-01 选为默认）或 OpenAI 转写 */
    asrEngine: 'browser' as SubtitleAsrEngine,
    /** 浏览器识别的语言：auto = 按视频的语言（中文按简体字识别） */
    browserLang: 'auto' as BrowserSpeechLang,
    /** 装了本地语音包时在本机识别（音频不离开电脑）；否则用 Chrome 的云端识别（音频发往 Google） */
    browserPreferLocal: true,
    /** OpenAI 语音转写模型（分段上传；转写方式选 OpenAI 时用） */
    asrModel: 'gpt-transcribe',
    translate: true,
    /** 第二行译成的语言 */
    targetLang: 'zh-CN' as SubtitleLang,
    /** 原文已经是目标语言时，第二行改译成的语言 */
    altTargetLang: 'en' as SubtitleLang,
    /** 字幕翻译用的模型：默认用更快更省的小模型（用户 2026-11-01 确认）；留空 = 用"1. 大模型"里当前提供商的模型 */
    translationModels: { anthropic: 'claude-haiku-5-5', openai: 'gpt-6-luna' },
    showSource: true,
    /** 字号倍数 */
    fontScale: 1,
  },
};

export type SubtitleAsrEngine = 'browser' | 'openai';

/** 浏览器识别可选的语言（代码 → 显示名）；识别结果的字形跟语言走：zh-CN 出简体，zh-TW 出繁体 */
export const BROWSER_SPEECH_LANGS = {
  auto: '自动（按视频的语言）',
  'zh-CN': '中文（简体字）',
  'zh-TW': '中文（繁体字，台湾）',
  'yue-Hant-HK': '粤语（繁体字）',
  'en-US': 'English',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
} as const;
export type BrowserSpeechLang = keyof typeof BROWSER_SPEECH_LANGS;

/** 双语字幕可选的翻译目标语言（代码 → 显示名） */
export const SUBTITLE_LANGS = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
} as const;
export type SubtitleLang = keyof typeof SUBTITLE_LANGS;

/** 自动字幕的内部参数 */
export const SUBTITLES = {
  /** 采样率：AudioContext 直接重采样到 16 kHz 单声道，上传 16-bit WAV */
  sampleRate: 16_000,
  /** VAD 帧长（秒） */
  frameSec: 0.03,
  /** 帧能量（RMS）高于该值且高于底噪 noiseFactor 倍才算有人声 */
  minSpeechRms: 0.008,
  noiseFactor: 2.5,
  /** 说话前保留的一小段（秒），避免切掉第一个字 */
  prerollSec: 0.2,
  /** 停顿这么久算一句话说完 */
  pauseSec: 0.45,
  /** 片段短于该秒数时，再等一会儿看能否和下一句合并 */
  minSegmentSec: 1.5,
  /** 停顿超过该秒数时，短片段也直接上传 */
  longPauseSec: 1.0,
  /** 片段最长秒数：连续说话时在最安静处切开（决定第一次观看时字幕最多晚多久） */
  maxSegmentSec: 7,
  /** 片段里人声少于该秒数视为咳嗽/杂音，不上传、不花钱 */
  minSpeechSec: 0.3,
  /** 播放进度与音频节奏偏差超过该秒数，视为拖动/跳转：丢弃当前片段 */
  seekToleranceSec: 1.2,
  /** 新片段与已有字幕重叠超过该比例就不再识别（回看不重复花钱） */
  coveredRatio: 0.5,
  /** 字幕结束后再停留多久 */
  lingerSec: 0.8,
  /** 第一次观看时字幕晚于语音出现：晚到的字幕至少显示这么久 */
  liveMinShowSec: 2.5,
  /** 晚到超过该秒数的字幕不再即时显示（回看时仍按时间轴显示） */
  liveMaxLagSec: 20,
  /** 发给转写模型的前文（提高连贯性）最多多少字 */
  asrPromptChars: 200,
  /** 翻译时附带的前几句原文（只作上下文） */
  translationContextCues: 3,
  cueMaxChars: 400,
  /** 同时在途的识别请求上限（超过时跳过并提示） */
  maxInFlight: 4,
  /** 被限流且服务方没说等多久时：从这么久开始，每次翻倍，最多等到 backoffMaxMs */
  backoffBaseMs: 5_000,
  backoffMaxMs: 60_000,
  /** 本地最多保留多少个视频的字幕 */
  maxVideosKept: 100,
  /** 翻译一句的预估 token：预算护栏按此预留（偏保守），实际按返回的用量记账 */
  translationEstimate: { inputTokens: 700, outputTokens: 400 },
  /** 设置页"一小时约花多少"的估算：一句的典型用量、平均每几秒一句 */
  translationTypical: { inputTokens: 350, outputTokens: 150, secondsPerCue: 5 },
  // ── 浏览器识别 ──
  /** 识别结果边听边改：一段文字这么久不再变化才算定稿 */
  liveStableMs: 1_200,
  /** 识别结果比说话晚多少秒（据此估算每个字在视频里的时间） */
  liveLatencySec: 0.7,
  /** 一行字幕的长度：中日韩按字数，其他按字符数 */
  liveLineChars: { cjk: 16, latin: 42 },
  /** 一句定稿后太长时按这个长度再切 */
  liveMaxChars: { cjk: 24, latin: 72 },
  /** 停顿这么久（视频秒），不满一行也先定稿 */
  liveIdleCommitSec: 1.6,
  /** 屏幕上滚动显示的最近文字最多多长 */
  liveTailChars: { cjk: 30, latin: 84 },
  /** 刚定稿的那行在多少秒内仍和后面的新字一起显示 */
  liveRecentSec: 5,
  /** 识别会话很快就意外结束时，重启前等待：从这么久开始翻倍，最多 recognitionRestartMaxMs */
  recognitionRestartBaseMs: 1_000,
  recognitionRestartMaxMs: 15_000,
} as const;

/** 语音转写单价（美元/分钟；2026-11 OpenAI 定价页）。没列出的模型按最贵的实时转写价保守估算。 */
export const ASR_PRICES_PER_MINUTE: Record<string, number> = {
  'gpt-transcribe': 0.0045,
  'gpt-live-transcribe': 0.017,
  'gpt-4o-transcribe': 0.006,
  'gpt-4o-mini-transcribe': 0.003,
  'whisper-1': 0.006,
};
export const ASR_UNKNOWN_PRICE_PER_MINUTE = 0.017;

/** 文本模型单价（美元/百万 token，输入/输出；2026-11 官方定价页）。没列出的模型按最贵的一档保守估算。 */
export const LLM_PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-6.1-sol': { input: 2, output: 10 },
  'gpt-6.1-terra': { input: 1, output: 5 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
};
export const LLM_UNKNOWN_PRICE_PER_MTOK = { input: 10, output: 50 } as const;

/** X API（2026-10 官方定价页；按返回的资源条数计费，同一资源在同一 UTC 日内只计一次） */
export const X_API = {
  pricing: {
    postRead: 0.005,
    userRead: 0.01,
    trendsRequest: 0.01,
  },
  /** 按量付费账号的 recent search 查询串上限 */
  maxQueryChars: 512,
  minResults: 10,
  maxResults: 100,
  /** 只看最近多少小时的帖子 */
  lookbackHours: 24,
  /** 每个主题交给 LLM 的候选帖子数 */
  candidatesPerTopic: 10,
  postTextChars: 280,
} as const;

export const DISCOVERY = {
  /** 只看最近多少天发布的视频（找"活跃"的博主） */
  lookbackDays: 30,
  /** 最近推荐过的频道多少周内不再推荐 */
  cooldownWeeks: 4,
  /** 每次运行最多为多少个候选频道读取最近上传（每个 1 unit） */
  maxCandidatesToInspect: 10,
  generalUnitBudget: 40,
} as const;

/** 豆瓣评论 RSS 阅读器 */
export const DOUBAN = {
  /** 首次使用时预置的条目（可删除） */
  defaultSubjects: [{ id: '35299923', title: '白衣逆行者' }],
  maxSubjects: 20,
  /** 跟随标签页看过、但没订阅的条目，最多保留几份缓存（来回切换时不必反复请求豆瓣） */
  transientFeedsKept: 5,
  /** 评价词 → 星级（豆瓣五档） */
  ratingStars: { 力荐: 5, 推荐: 4, 还行: 3, 较差: 2, 很差: 1 } as Record<string, number>,
} as const;

/** 观看追踪的内部参数 */
export const WATCH = {
  tickMs: 1000,
  /** 向后台汇报进度的间隔 */
  flushEveryMs: 15_000,
  /** 后台标签页定时器会被节流：两次采样间隔超过该秒数就不计入（可能是休眠/挂起） */
  maxTickGapSec: 75,
  /** 播放进度比墙钟多走超过该秒数，视为拖动进度条 */
  seekToleranceSec: 1.5,
  /** 原始观看会话保留天数（之后只保留按天汇总的记录） */
  sessionRetentionDays: 3,
  /** 一次补全元数据最多花多少 units（videos.list 每 50 个 1 unit） */
  metadataUnitBudget: 20,
  /** 补全元数据只看最近几天的记录 */
  metadataLookbackDays: 8,
} as const;

export const SUMMARY = {
  /** 生成每日总结时参考的前几天总结 */
  contextDays: 7,
  /** 浏览器没开错过的总结，最多补算几天 */
  catchUpMaxDays: 7,
  /** 每日总结里给 LLM 的观看条目上限 */
  maxRecords: 80,
  /** 例行检查间隔（分钟）：补元数据、补算总结、评估提醒 */
  tickMinutes: 30,
} as const;

/**
 * YouTube 标准视频分类（videos.list 的 snippet.categoryId）→ 中文名与学习/娱乐倾向。
 * 只是判定学习/娱乐的信号之一，用户的纠正永远优先。
 */
export const YOUTUBE_CATEGORIES: Record<string, { name: string; lean: 'learning' | 'entertainment' | 'neutral' }> = {
  '1': { name: '电影和动画', lean: 'entertainment' },
  '2': { name: '汽车', lean: 'neutral' },
  '10': { name: '音乐', lean: 'entertainment' },
  '15': { name: '宠物和动物', lean: 'entertainment' },
  '17': { name: '体育', lean: 'entertainment' },
  '18': { name: '短片', lean: 'entertainment' },
  '19': { name: '旅游和活动', lean: 'neutral' },
  '20': { name: '游戏', lean: 'entertainment' },
  '21': { name: '视频博客', lean: 'entertainment' },
  '22': { name: '人物和博客', lean: 'neutral' },
  '23': { name: '喜剧', lean: 'entertainment' },
  '24': { name: '娱乐', lean: 'entertainment' },
  '25': { name: '新闻和政治', lean: 'neutral' },
  '26': { name: 'DIY 和生活百科', lean: 'learning' },
  '27': { name: '教育', lean: 'learning' },
  '28': { name: '科学和技术', lean: 'learning' },
  '29': { name: '公益与社会活动', lean: 'neutral' },
  '35': { name: '纪录片', lean: 'learning' },
};

/** 学习/娱乐判定：各信号的分值（总分 ≥ +1 判学习，≤ −1 判娱乐，其余为"其他"） */
export const NATURE = {
  userVideo: 100,
  userChannel: 50,
  cluster: 2,
  category: 1.5,
  keyword: 1,
  shorts: -1,
  threshold: 1,
  learningKeywords: ['教程', '讲解', '科普', '原理', '课程', '入门', '公开课', '讲座', '学习', '解读', '深度', 'tutorial', 'lecture', 'explained', 'explainer', 'course', 'how to', 'guide', 'introduction', 'deep dive'],
  entertainmentKeywords: ['搞笑', '鬼畜', '整蛊', '名场面', '游戏实况', '直播回放', '吃播', '盘点', '恶搞', 'vlog', 'reaction', 'funny', 'prank', 'meme', 'gameplay', "let's play", 'compilation', 'highlights'],
} as const;

/** 排序因子的初始权重（和为 1）。评分学习会在 [min,max] 内调整并重新归一化。 */
export const DEFAULT_FACTOR_WEIGHTS: Record<FactorKey, number> = {
  relevance: 0.25,
  topic: 0.2,
  taste: 0.2,
  quality: 0.12,
  freshness: 0.1,
  format: 0.05,
  channelPref: 0.08,
};

export const RANKING = {
  weightMin: 0.02,
  weightMax: 0.6,
  /** 意图里出现"最新"等时，新鲜度权重放大倍数 */
  freshnessBoost: 2.5,
  popularityBoost: 2,
  formatBoost: 3,
  /** 新鲜度衰减时间常数（天）：强调时效 / 一般 */
  freshnessTauDaysRecent: 3,
  freshnessTauDaysDefault: 60,
  /** RRF 融合常数 */
  rrfK: 10,
  /** 软约束满足时的加分上限 */
  softCheckBonus: 0.08,
  /** 之前打过低分（≤ lowRating）的视频得分乘数 */
  previouslyLowRatedPenalty: 0.3,
  /** 偏好频道加成 */
  preferChannelBonus: 0.1,
  maxReasons: 4,
} as const;

export const LEARNING = {
  /** ≤ 该分数视为低分，需要归因 */
  lowRatingMax: 5,
  /** 频道偏好每次调整的最大幅度 */
  channelPrefStep: 0.4,
  /** 因子权重学习率 */
  weightLearningRate: 0.15,
  /** 兴趣簇权重每次调整的最大幅度 */
  clusterWeightStep: 0.15,
  clusterWeightMin: 0.2,
  clusterWeightMax: 2,
  /** 视频与兴趣簇匹配强度达到该值才调整该簇 */
  clusterMatchThreshold: 0.5,
  /** 小于该值的权重变化不列入调整记录（仍然生效） */
  minVisibleWeightDelta: 0.003,
  /** 发给 LLM 的理解纠正最多几条 */
  maxCorrectionsInPrompt: 15,
  maxAdjustmentsKept: 200,
} as const;

export const SHORTS = {
  /** ≤ 该秒数一律视为 Shorts */
  alwaysShortsMaxSeconds: 60,
  /** ≤ 该秒数且带 #shorts 标记视为 Shorts（Shorts 最长 3 分钟） */
  taggedShortsMaxSeconds: 180,
} as const;

export const STORAGE_LIMITS = {
  searchSessionsKept: 10,
  quotaDaysKept: 7,
} as const;

export const LLM_LIMITS = {
  maxTokens: 16_000,
  timeoutMs: 90_000,
  /** 一段字幕音频的转写请求最长等待（太久的字幕已经没意义） */
  transcribeTimeoutMs: 30_000,
  maxRetries: 1,
  /** 发给 LLM 做聚类的条目上限（数据最小化 + 控制 token） */
  clusterMaxChannels: 300,
  clusterMaxLikedTitles: 300,
  /** Takeout 常看频道最多补充多少个进聚类输入（只有频道名） */
  clusterMaxWatchedChannels: 50,
  channelDescriptionChars: 120,
  utteranceMaxChars: 500,
} as const;

/** Anthropic 服务端拒答回退：'default' 在不支持的模型上等于不回退，安全。 */
export const ANTHROPIC_FALLBACK = {
  beta: 'server-side-fallback-2026-07-01',
  fallbacks: 'default',
} as const;

export const GOOGLE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

/** YouTube 授权：launchWebAuthFlow + Google 隐式授权（访问令牌约 1 小时有效，没有刷新令牌）。 */
export const GOOGLE_OAUTH = {
  /** 提前这么久视为过期，避免请求途中失效 */
  expiryMarginMs: 2 * 60_000,
  /** 回跳里没带 expires_in 时按此估算（Google 惯例 3599 秒） */
  defaultExpiresInSec: 3599,
  /** 静默续期失败后，这段时间内不再静默重试（直接请用户重新授权） */
  silentRetryAfterMs: 15 * 60_000,
  /** 静默续期（prompt=none）最长等待 */
  silentTimeoutMs: 10_000,
  /** 交互授权窗口最多等这么久（在窗口里登录、选账号）；超过后后台不再保活，界面说明"窗口没有交回结果" */
  interactiveMaxMs: 10 * 60_000,
} as const;
