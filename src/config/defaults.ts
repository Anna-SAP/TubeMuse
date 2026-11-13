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

/** X 热点默认值的版本：2 = 不再自动花钱、每个主题读 10 条（2026-11-06） */
export const X_DEFAULTS_VERSION = 2;

export const DEFAULT_SETTINGS = {
  llm: {
    provider: 'anthropic' as 'anthropic' | 'openai',
    models: {
      anthropic: 'claude-opus-5-5',
      openai: 'gpt-6.1-sol',
    },
    /** 省钱模型：LLM_TASKS 里 tier 为 economy 的任务默认用它；留空 = 跟随上面的主模型 */
    economyModels: { anthropic: 'claude-haiku-5-5', openai: 'gpt-6-luna' },
    /** 你把某个任务改成别的档位时记在这里（没写的按 LLM_TASKS 的默认档） */
    taskTiers: {} as Partial<Record<LlmTask, LlmTier>>,
    /** 每日大模型花费上限（美元，按本地日计；不含自动字幕，字幕有自己的预算） */
    dailyBudgetUsd: 0.5,
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
    /** 打开"发现"页且缓存过期时自动刷新。默认关闭：花钱的读取只在你点"刷新"时发生（见 DECISIONS §48） */
    autoRefresh: false,
    /** 最多查几个兴趣主题 */
    maxTopics: 4,
    /** 每个主题读几条帖子（10–100）。10 是 X 允许的最小值，也正好是每个主题交给大模型的候选数 */
    postsPerTopic: 10,
    /** 这份默认值的版本：旧版存下的设置按 mergeSettings 迁移一次 */
    defaultsVersion: X_DEFAULTS_VERSION as number,
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
    /** 第二行谁来译：Chrome 自带的本地翻译（免费，语言包在本机）或大模型（按量计费） */
    translationEngine: 'local' as SubtitleTranslationEngine,
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
  /**
   * 多语字幕（用户 2026-11-02 批准的红线变更，见 DECISIONS §37）：把视频自带的几种 YouTube 字幕（CC）
   * 同时叠加在播放器里，一种语言一行，从上到下按 langs 的顺序。
   */
  multiCaptions: {
    enabled: true,
    /**
     * 有 YouTube 字幕的视频自动显示。默认关闭（用户 2026-11-06 要求）：只在你从侧边栏"字幕"页或按 Alt+Shift+C 开启时显示。
     * 旧版的 autoOn 不再生效，见 mergeSettings。
     */
    autoShow: false,
    /** 从上到下显示的语言（最多 MULTI_CC.maxLines 种）；original = 视频原声的语言 */
    langs: ['original', 'en', 'zh-Hans'] as string[],
    /** 你选的语言这个视频没有原生字幕时，用 YouTube 自带的自动翻译补上（标注"机翻"；用户 2026-11-02 选择） */
    autoTranslate: true,
    /** 字号倍数 */
    fontScale: 1,
  },
  /** 视频片段录制（用户 2026-11-01 批准的红线变更，见 DECISIONS §36）：只在你从侧边栏或快捷键开始后录制 */
  clips: {
    enabled: true,
    /** 把播放器里当时显示的字幕（TubeMuse 自动字幕或 YouTube 原生字幕）画进片段 */
    burnSubtitles: false,
    /** 停止后直接存进浏览器的下载文件夹；关掉则停止后由你点"保存" */
    autoSave: true,
    /** 单段时长上限（分钟）：片段在保存前全部在内存里 */
    maxMinutes: 10,
  },
  /**
   * 小红书网页版（用户 2026-11-03 要求，见 DECISIONS §40）：笔记卡片上显示发布时间；在页面上把博主 / 笔记收进 TubeMuse 并打标签。
   * 只读页面里已有的数据，不向小红书发任何请求；收藏只存在本机，不会在小红书上收藏或关注。
   */
  xhs: {
    enabled: true,
    /** 笔记卡片作者那一行、笔记详情的日期旁显示发布时间 */
    showTime: true,
    /** 笔记卡片封面、博主主页名字旁、笔记详情"关注"旁显示"收藏"按钮 */
    showSave: true,
  },
  /**
   * eMails（用户 2026-11-04 要求，见 DECISIONS §44）：读 Gmail 里当前打开的文章汇总邮件，用大模型给每篇打 0–10 分，一键收藏。
   * 只在侧边栏 eMails 页开着时读邮件；只有你点"评估"才把文章的标题、摘要和元数据发给大模型。
   */
  email: {
    enabled: true,
  },
  /** 「问 muse」（DECISIONS §60、§63） */
  muse: {
    /**
     * 在 YouTube 上点「问 muse」时，自动取这个视频自带的字幕 / 转写（位置前后 30 秒）。
     * 原生字幕关着时要让播放器短暂打开一次字幕才取得到（会闪一下）；关掉这一项就只用已经读到的字幕。
     */
    fetchCaptions: true,
  },
  /**
   * 小宇宙（用户 2026-11-13 要求，见 DECISIONS §72）：单集页的中英字幕、字幕下载、收藏、收听记录、片段快照。
   * 字幕要读这一集的公开音频文件（media.xyzcdn.net），转写与校对 / 翻译的花费记在"字幕 $"里，与自动字幕共用每日预算。
   */
  xyz: {
    enabled: true,
    /** 转写方式：OpenAI（默认，用户 2026-11-13 选择：质量明显好于系统自带的实时字幕）或浏览器自带的语音识别（免费，只能按 1 倍速边放边认） */
    asrEngine: 'openai' as SubtitleAsrEngine,
    /** 打开单集页就开始出字幕。默认关闭：花钱的转写由你点"开始字幕"或按 Alt+Shift+S 开始 */
    autoStart: false,
    /** 用大模型校对转写（改错字、补标点、统一人名术语）并译出另一种语言：中文播客出英文，英文播客出中文 */
    polish: true,
    /** 边听边转写时最多提前多少秒（暂停时转写到这里就停，不一下子把整集都花掉） */
    lookaheadSec: 120,
    /** 页面上的字幕层显示什么 */
    display: 'bilingual' as 'bilingual' | 'zh' | 'en' | 'off',
    /** 字幕层字号倍数 */
    fontScale: 1,
    /** 记下在小宇宙上听了什么（只在本机） */
    tracking: true,
  },
  /**
   * 中文配音（用户 2026-11-13 要求，见 DECISIONS §74）：给 YouTube 视频关联一个本地 .m4a，开启后在播放页叠加播放，
   * 跟随视频的播放、暂停、拖动与倍速，加上你手动设的偏移；开启时原声降 20%。音频只存在本机（IndexedDB），不发任何网络请求。
   */
  dub: {
    enabled: true,
    /** 打开有中文配音的视频时提示（工具栏图标上的"中"、侧边栏顶部的一行）；配音本身仍要你点"开启" */
    prompt: true,
  },
  /** 侧边栏界面偏好 */
  ui: {
    /** 导航栏（找片、发现…）固定在头部下方，往下滚动时保持可见；默认随页面滚动 */
    pinNav: false,
  },
};

export type SubtitleAsrEngine = 'browser' | 'openai';
export type SubtitleTranslationEngine = 'local' | 'llm';

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
  translationMaxOutputTokens: 2_000,
  /** Chrome 本地翻译最多等多久（模型加载、翻一句）：语言包有问题时 Chrome 可能一直不回应 */
  localTranslateTimeoutMs: 15_000,
  /** 下载语言包最多等多久 */
  localPrepareTimeoutMs: 300_000,
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

/**
 * X API（2026-11 官方邮件与公告核实；按返回的资源条数计费，同一资源在同一 UTC 日内只计一次）。
 * 2026-11-22 起 expansions 带回来的对象也按这个价计费。热点只要帖子本身，不发 expansions（x-client.ts 有测试守着）。
 */
export const X_API = {
  pricing: {
    postRead: 0.005,
    userRead: 0.01,
    mediaRead: 0.005,
    pollRead: 0.005,
    placeRead: 0.005,
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
  /** 一次请求最多等多久：挂住的请求不能一直占着"同一时间只刷新一次"的锁 */
  timeoutMs: 30_000,
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

/** 收藏的标签（小红书、eMails 共用，见 core/collection.ts） */
export const TAGS = {
  /** 每条收藏最多几个标签、每个标签最多几个字 */
  maxPerItem: 20,
  maxChars: 20,
} as const;

/** 小红书：笔记发布时间与收藏 / 标签（见 DECISIONS §40） */
export const XHS = {
  /**
   * 笔记 ID 前 8 位十六进制是创建时刻（Unix 秒）。早于这个时间或晚于"现在 + futureSlackMs"的不认（小红书 2013 年上线）。
   * 2026-11-03 实测 6 篇：4 篇与页面数据里的发布时间一秒不差，2 篇早 2–3 小时（定时 / 审核后发布），所以界面标"≈"
   */
  idTimeMin: Date.UTC(2013, 0, 1),
  futureSlackMs: 2 * 24 * 3_600_000,
  maxTagsPerItem: TAGS.maxPerItem,
  maxTagChars: TAGS.maxChars,
  /** 笔记、博主各自最多收藏多少条 */
  maxItems: 5000,
  titleMaxChars: 200,
  nameMaxChars: 60,
  /** 收藏弹窗里"常用标签"最多列几个 */
  suggestTags: 12,
  /** 页面内助手（读页面数据里的发布时间）多久没应答算不可用 */
  bridgeTimeoutMs: 1500,
  /** 页面内容变化后多久重新扫一遍卡片（合并虚拟列表滚动时的大量变化） */
  scanDelayMs: 120,
  /** 有新卡片时最多多久重读一次页面数据（页面内助手每次最多读多少条见 core/xhs-protocol.ts） */
  timesRefreshMs: 800,
} as const;

/** eMails：文章汇总邮件的解析、评分与收藏（见 DECISIONS §44） */
export const EMAIL = {
  /** 少于这么多篇就不算文章汇总（普通邮件里偶尔有一两个长链接） */
  minArticles: 2,
  /** 一封邮件最多列多少篇 */
  maxArticles: 60,
  /** 一次最多读邮件正文里多少个文字 / 图片节点（邮件再长也不卡页面） */
  maxNodes: 8000,
  titleMaxChars: 240,
  excerptMaxChars: 400,
  nameMaxChars: 80,
  reasonMaxChars: 120,
  /** 发给大模型的摘要最多多少字（数据最小化） */
  promptExcerptChars: 240,
  /** 一次请求最多评多少篇：更长的汇总分批，先评完的先显示 */
  batchSize: 20,
  /** 分档：≥ read 值得精读；≤ skip 建议跳过；其余一般 */
  bands: { read: 7, skip: 3 },
  /** 最多缓存多少篇的评分（同一篇隔天再出现时不再花钱） */
  maxScores: 2000,
  /** 总体结论每一段最多多少字（大模型写得再长也只留这么多） */
  verdictMaxChars: 300,
  /** 写总体结论时每篇标题最多发多少字（分数和理由才是这一步的主要依据） */
  verdictTitleChars: 100,
  /** 最多留多少封邮件的总体结论 */
  maxVerdicts: 200,
  /** 最多收藏多少篇 */
  maxSaved: 5000,
  /** 侧边栏 eMails 页开着时，每隔多久看一次当前打开的是哪封邮件（Gmail 分栏阅读时换邮件，网址不变） */
  pollMs: 1500,
} as const;

/**
 * 多语字幕可选的语言（代码 → 显示名）。代码用 YouTube 字幕接口的写法（zh-Hans / zh-Hant）；
 * 其他写法（zh-CN、en-US…）在匹配字幕轨时会归并，见 core/multi-captions.ts 的 langMatchKey。
 */
export const MULTI_CC_LANGS = {
  original: '视频原声语言',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  ru: 'Русский',
  id: 'Bahasa Indonesia',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  ar: 'العربية',
  hi: 'हिन्दी',
  it: 'Italiano',
} as const;

/** 多语字幕的内部参数 */
export const MULTI_CC = {
  /** 最多同时显示几种语言（行） */
  maxLines: 4,
  /** 同一种语言同时有几句重叠时（对白、标牌）最多显示几句 */
  maxOverlapCues: 2,
  /** 一句结束后、下一句开始前的空档短于这么久（秒）时，先留着上一句，避免字幕闪一下 */
  gapBridgeSec: 0.3,
  /** 按时间找"此刻在显示的句子"时，往前最多看几句（覆盖持续很久的长句） */
  lookbackCues: 8,
  /** 一条字幕轨最多读多少句、一句最多多少字、响应最多多大 */
  maxCuesPerTrack: 20_000,
  cueMaxChars: 500,
  maxResponseBytes: 5_000_000,
  /** 让播放器取一次字幕后，最多等这么久看到它的请求 */
  primeTimeoutMs: 6_000,
  /** 同一个视频最多让播放器取几次（令牌失效时会重取一次） */
  primeMaxAttempts: 3,
  /** 两次让播放器取字幕之间至少隔多久 */
  primeRetryMs: 8_000,
  /**
   * 同时取几种语言：YouTube 的字幕接口慢起来一次要 20–40 秒（2026-11-03 实测），一种一种取会让后面的语言多等几十秒；
   * 这个站点走 HTTP/3 多路复用，同时取不多占连接
   */
  fetchConcurrency: 4,
  /** 一次字幕请求最多等多久：YouTube 自己的网关约 40 秒放弃、回 502（2026-11-03 实测），这里留余量，只防连接一直挂着 */
  fetchTimeoutMs: 60_000,
  /** YouTube 服务器出错（5xx）、限流（429）、超时或连不上：隔这么久重试，最多重试这么多次，之后停下说明 */
  fetchRetryDelaysMs: [5_000, 15_000, 30_000],
  /** 一次请求等了这么久还没回：状态里说明是 YouTube 的字幕接口慢，并显示已等了多久 */
  slowFetchMs: 8_000,
  /** 与页面内助手通话的超时 */
  bridgeTimeoutMs: 2_000,
  /** 多久向页面内助手问一次播放器的字幕状态（你可能按了 C） */
  stateRefreshMs: 1_000,
  /**
   * YouTube 按你保存的字幕偏好（开着 + 语言）在每次正片开始后自动打开原生字幕（2026-11-02 实测：重新加载后约 0.8 秒，
   * 还没开始播放）。正片开始（换视频、广告结束、页面打开）后、播放满这么多秒之前，原生字幕被打开算播放器自己的，
   * 不算你按了 C（DECISIONS §38）
   */
  autoCaptionGracePlaySec: 2,
  /** …但最多这么久（视频一直停在开头没播时也不久等；原生字幕本来关着时，多语字幕最多因此晚这么久出现） */
  autoCaptionGraceMaxMs: 8_000,
  /** 同一段等待里最多当作"播放器自动打开"几次；再打开就是你按的 */
  autoCaptionMaxAbsorb: 2,
  /** 一行字幕最宽占播放器宽度的比例（两边各留一半） */
  lineMaxWidthRatio: 0.96,
  /** 一行放不下时先缩小字号，最多缩到这个比例；还放不下才折行（用户 2026-11-03 要求：每种语言尽量只占一行） */
  fitMinScale: 0.75,
  /**
   * Shorts（竖屏）上字幕层离播放器底边多远（占播放器高度的比例）：Shorts 把频道名、标题、进度条叠在画面底部
   * （播放器外面的元素，量不到），字幕放在它们上面（2026-11-11，DECISIONS §67）
   */
  shortsBottomRatio: 0.22,
} as const;

/** 视频片段录制的内部参数 */
export const CLIPS = {
  /** 控制循环间隔：判断广告、暂停、时间段终点 */
  tickMs: 100,
  /** 画面帧率上限 */
  fps: 30,
  /** 输出画面短边最多多少像素（4K 实时编码太吃力）：更大的视频按比例缩小。按短边算，竖屏的 1080p（1080×1920）才不会被缩成 608×1080 */
  maxShortSide: 1080,
  /** 读不到画面尺寸（例如只有声音）时的输出尺寸 */
  fallbackSize: { width: 1280, height: 720 },
  /** 视频码率（按输出高度从高到低，bps） */
  videoBitrates: [
    { minHeight: 1080, bps: 8_000_000 },
    { minHeight: 720, bps: 5_000_000 },
    { minHeight: 480, bps: 2_500_000 },
    { minHeight: 0, bps: 1_500_000 },
  ],
  audioBitrate: 128_000,
  /** 录音采样率（只用于 Chrome）：AudioContext 默认跟着输出设备走，蓝牙耳机在通话模式下是 16 kHz，而 Chrome 的 AAC 编码器
   *  （Windows 上用系统自带的）只接受 44.1 / 48 kHz（2026-11-02 实测 Chrome 156）。固定 48 kHz，由浏览器重采样。
   *  Firefox 不重采样视频的音轨、固定了反而录慢、音调偏低，用默认采样率（DECISIONS §76） */
  audioSampleRate: 48_000,
  /** 等 AudioContext 启动多久（毫秒）：页面还没被点过时 resume() 不报错、也一直不返回（2026-11-06 实测 x.com），不能干等 */
  audioResumeMs: 1000,
  /** MP4 文件头（声明有哪些轨）最多在开头这么多字节里找；Chrome 交出的第一块数据就带着它，通常不到 2 KB */
  headerScanBytes: 1_000_000,
  /** 编码器每隔多久交出一块数据（毫秒）：已录大小实时可见 */
  timesliceMs: 1000,
  /** 单段最大体积（字节）：保存前全部在内存里，超过就自动结束 */
  maxBytes: 1_500_000_000,
  /** 时间段截取最短多少秒 */
  minRangeSec: 1,
  /** 拖动定位的误差：比起点早这么多也算到了起点 */
  rangeToleranceSec: 0.05,
  /** 在播放（没暂停）但进度这么久没动算卡住：缓冲中不录静止画面 */
  stallMs: 1000,
  /** 离结尾不到这么多秒、又卡住了，算播完：小红书的播放器停在最后一帧（实测差 0.16 秒）时不报"播完"（2026-11-04） */
  endSlackSec: 0.5,
  /** 酷播：播放器里放的不是正片的流（正片都是 blob:）、又不超过这么多秒，算片头广告。
   *  2026-11-10 实测到的一条是 20 秒的 VIP 宣传片；留出余量，又不至于把直接给地址的长视频当成广告一直不录 */
  kubbAdMaxSec: 120,
  /** "录过的片段"记录保留条数（只有标题、时间段、大小，没有视频本身） */
  logMax: 100,
  /** Capture：PNG 从页面传回侧边栏时每块多少字节（转 base64 后约 21 MB，runtime 消息单条上限 64 MB；8K 的 PNG 可能超过一条） */
  captureChunkBytes: 16 * 1024 * 1024,
  /** Capture：截好的 PNG 在页面内存里最多留多久（侧边栏取走后立即释放；这是侧边栏中途关掉时的兜底） */
  captureHoldMs: 30_000,
  /** Capture：PNG 交给浏览器后，写进系统剪贴板最多等多久；超过就说明没放进去，不让 Capture 按钮一直卡在"截图中" */
  captureClipboardTimeoutMs: 5_000,
  /** 编码格式，按优先级：MP4 通用性最好，浏览器不支持时退回 WebM */
  formats: [
    { mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4', label: 'MP4（H.264 + AAC）' },
    { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4', label: 'MP4（H.264 + AAC）' },
    { mimeType: 'video/webm;codecs=vp9,opus', ext: 'webm', label: 'WebM（VP9 + Opus）' },
    { mimeType: 'video/webm;codecs=vp8,opus', ext: 'webm', label: 'WebM（VP8 + Opus）' },
    { mimeType: 'video/webm', ext: 'webm', label: 'WebM' },
  ],
} as const;

/**
 * 「问 muse」（2026-11-11 新增，见 DECISIONS §60）：把正在看的这条视频整理成一段"咨询包"文字，由你自己粘贴到 Muse 聊天里。
 * 只生成文字：不调大模型、不向 Muse 发任何请求。
 */
export const MUSE = {
  /** 上下文取冻结位置前后各多少秒的字幕 / 转写 */
  windowSec: 30,
  /** 上下文最多多少个字：超过就截断，并在咨询包里注明 */
  contextMaxChars: 2000,
  /** 简介（YouTube 视频作者写的说明）最多放多少个字：超过就截断，并在咨询包里注明 */
  descriptionMaxChars: 1500,
  /** 章节标题最多多少个字 */
  chapterTitleMaxChars: 120,
  /** 标题、作者最多多少个字（页面上读来的，防止异常长） */
  titleMaxChars: 300,
  authorMaxChars: 100,
  /** 页面脚本交回的正文最多留多少个字（之后还要按 contextMaxChars 截断；这里只是不让超长的正文整段在扩展里传来传去） */
  bodyReadMaxChars: 20_000,
  /** 一次最多交回多少句字幕（前后 30 秒通常只有十几句；防止异常数据） */
  maxCues: 400,
  /** YouTube 的作者、简介（章节写在简介里）本机没有时，向官方接口查（videos.list，1 unit）最多等多久；超时就写「无」并说明，查到的结果留给下一次 */
  infoLookupMs: 5000,
  /** 本机记住最近多少个视频的作者和简介：问过的视频再问不用再查 */
  videoCacheMax: 30,
  /** 点「问 muse」时取 YouTube 自带的字幕最多等多久（读字幕轨、等播放器给出带令牌的字幕请求、取回字幕）；超时就写「无字幕」并说明 */
  captionFetchMs: 8000,
  /** 咨询包末尾给 Muse 的回答要求（用户 2026-11-11 手测后改定的原话，见 DECISIONS §63） */
  answerRule: '视频里的说法必须引用位置或原文；通用概念问题可用通用知识回答，但必须标明「这是通用知识，不是视频原话」。',
} as const;

/** 小宇宙（见 DECISIONS §72）的内部参数 */
export const XYZ = {
  titleMaxChars: 200,
  nameMaxChars: 80,
  /** 页面上读到的节目简介最多留多少字（只用来让大模型校对人名和术语） */
  showNotesMaxChars: 4000,
  /** 发给大模型的简介摘录最多多少字（数据最小化） */
  promptNotesChars: 1200,
  /** 一次读多少秒音频、切句、转写、校对（第一次开始或跳转后先读短一点，字幕出得快） */
  windowSec: 30,
  firstWindowSec: 12,
  /** 从任意位置开始读（刚开始、刚跳转）时往前多读这么多秒，好找到正在说的那句话的开头 */
  leadSec: 6,
  /** 切句：播客句子比视频长，一段最长 12 秒（更多上下文，转写更准） */
  segmenter: { pauseSec: 0.5, minSegmentSec: 2, longPauseSec: 1.0, maxSegmentSec: 12 },
  /** 一段最长多少秒（后台按这个校验收到的音频） */
  maxSegmentSec: 13,
  /** 同时在途的转写请求上限 */
  maxInFlight: 6,
  /** 转写的提示词：节目名、标题与前文，最多多少字 */
  asrPromptChars: 300,
  /** 校对 / 翻译：每次最多多少句；附带前面几句已校对的中文作上下文 */
  polishMaxCues: 24,
  polishContextCues: 3,
  polishMaxOutputTokens: 4000,
  /** 预算护栏按这个预留（偏保守），实际按返回的用量记账 */
  polishEstimate: { inputTokens: 2500, outputTokens: 1500 },
  /** 设置页"一小时约花多少"：每 windowSec 秒一次的典型用量 */
  polishTypical: { inputTokens: 1400, outputTokens: 700 },
  cueMaxChars: 600,
  /** 一句字幕结束后在屏幕上再停留多久 */
  lingerSec: 0.6,
  /** 本机最多保留多少集的字幕（超过时删最久没更新的） */
  maxTranscripts: 60,
  /** 可变码率 mp3 的扫描结果最多记几集 */
  maxScans: 20,
  /** 读音频：一次最多读多少字节（防止服务器不认分段读取时把整个文件读下来） */
  maxRangeBytes: 8 * 1024 * 1024,
  /** 扫描可变码率 mp3：整个文件最多多大 */
  maxScanBytes: 600 * 1024 * 1024,
  /** 收藏最多多少条、每条最多几个标签 */
  maxSaved: 5000,
  maxTags: 20,
  /** 收听记录最多多少集；每集只留最近多少段会话的累计值 */
  maxListens: 1000,
  listenSessionsKept: 20,
  /** 快照片段：最短、最长、默认多少秒 */
  minSnapSec: 1,
  maxSnapSec: 60,
  defaultSnapSec: 20,
  /** 快照波形：片段两边各多显示多少（占片段长度的比例，最少 6 秒） */
  snapContextRatio: 0.6,
  snapContextMinSec: 6,
  waveformBars: 72,
  /** "我的快照"最多留多少条 */
  snapshotLogMax: 100,
  /** 状态推给侧边栏的最短间隔 */
  stateEveryMs: 1000,
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

/** 没有 SDK 超时的外部请求最多等多久：挂住的请求会一直占着后台任务的锁 */
export const HTTP_TIMEOUT_MS = 30_000;

/** 例行任务失败后的重试节奏（DECISIONS §48）。服务方已经计费的失败（输出坏了、被截断）重试也要花钱，所以次数有限 */
export const JOB_RETRY = {
  /** 已计费的失败：自动试几次后停下，等你手动重试 */
  maxBilledAttempts: 2,
  /** 没计费的失败（断网、限流、服务方出错）：第一次隔这么久，之后翻倍，最多 maxDelayMs */
  baseDelayMs: 2 * 3_600_000,
  maxDelayMs: 24 * 3_600_000,
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
  /** 花费账本保留几天 */
  spendDaysKept: 7,
  /** 理解结果缓存多少句 */
  intentCacheKept: 30,
} as const;

/** 大模型任务的档位：economy 用省钱模型，main 用主模型 */
export type LlmTier = 'economy' | 'main';

/**
 * 每类大模型调用：默认档位、输出上限、典型用量（设置页估算用）。
 * 输出上限同时是花费的硬边界：调用前按它预扣预算，所以留够余量（Opus 5.5、Haiku 5.5 的思考也算输出），不会把正常结果截断。
 * main 档只留给决定后续一切的两步：理解口令、归纳兴趣簇。切换档位在设置页。
 */
export const LLM_TASKS = {
  intent: { label: '理解口令', tier: 'main', maxOutputTokens: 4_000, typical: { inputTokens: 2_200, outputTokens: 700, perDay: 5 } },
  clusters: { label: '归纳兴趣簇', tier: 'main', maxOutputTokens: 12_000, typical: { inputTokens: 25_000, outputTokens: 4_000, perDay: 0.03 } },
  daily: { label: '每日总结', tier: 'economy', maxOutputTokens: 6_000, typical: { inputTokens: 3_000, outputTokens: 1_500, perDay: 1 } },
  weekly: { label: '每周自省', tier: 'economy', maxOutputTokens: 4_000, typical: { inputTokens: 1_500, outputTokens: 800, perDay: 0.14 } },
  hotspots: { label: 'X 热点整理', tier: 'economy', maxOutputTokens: 4_000, typical: { inputTokens: 5_000, outputTokens: 1_500, perDay: 1 } },
  emailScore: { label: 'eMails 打分', tier: 'economy', maxOutputTokens: 4_000, typical: { inputTokens: 1_500, outputTokens: 1_200, perDay: 1 } },
  emailVerdict: { label: 'eMails 总体结论', tier: 'economy', maxOutputTokens: 2_000, typical: { inputTokens: 1_500, outputTokens: 500, perDay: 1 } },
  ping: { label: '测试连接', tier: 'main', maxOutputTokens: 500, typical: { inputTokens: 40, outputTokens: 20, perDay: 0 } },
} as const satisfies Record<string, { label: string; tier: LlmTier; maxOutputTokens: number; typical: { inputTokens: number; outputTokens: number; perDay: number } }>;

export type LlmTask = keyof typeof LLM_TASKS;

export const LLM_LIMITS = {
  timeoutMs: 90_000,
  /** 一段字幕音频的转写请求最长等待（太久的字幕已经没意义） */
  transcribeTimeoutMs: 30_000,
  /** SDK 不自动重试：超时后重发可能付两次钱。只有服务方明确拒绝（没有计费）时自己重试一次 */
  maxRetries: 0,
  /** 服务方说要等这么久以上就不重试了，直接告诉你 */
  maxRetryWaitMs: 5_000,
  retryDelayMs: 1_500,
  /** 估算输入 token：每个字符按这么多 token 算（中文约 1 字 0.7–1 token，取保守值） */
  tokensPerChar: 0.8,
  /** 发给 LLM 做聚类的条目上限（数据最小化 + 控制 token） */
  clusterMaxChannels: 300,
  clusterMaxLikedTitles: 300,
  /** Takeout 常看频道最多补充多少个进聚类输入（只有频道名） */
  clusterMaxWatchedChannels: 50,
  channelDescriptionChars: 120,
  utteranceMaxChars: 500,
} as const;

/** 中文配音的内部参数（DECISIONS §74） */
export const DUB = {
  /** 配音开启时原声的音量倍数：降 20%（用户 2026-11-13 指定）；配音本身保持正常音量（1） */
  originalVolume: 0.8,
  /** 两边位置差超过这么多秒才把配音拉回来（每次拉回会有一下极短的停顿；同一速度下两个播放器的走时差得很慢） */
  resyncSec: 0.3,
  /** 从暂停开始播放时，差这么多就先对齐再放 */
  startAlignSec: 0.08,
  /** 偏移的步长（秒） */
  delayStepSec: 0.1,
  /**
   * 偏移最多能设到多少秒（正负对称）。2026-11-13 手测：中文常比原视频短很多（46:02 对 1:01:43），
   * 后面几段的偏移要到十几分钟，原来的 ±600 秒不够；放宽到 6 小时，实际由对齐点算出来
   */
  maxDelaySec: 6 * 3600,
  /** 对齐点最多几个（DECISIONS §75） */
  maxAnchors: 200,
  /** 新对齐点离已有的不到这么多秒（视频时间）时，替换那一个而不是再加一个 */
  anchorMergeSec: 1,
  /** 对齐点的时间精度（秒） */
  anchorPrecisionSec: 0.01,
  /** 跟随的检查间隔（毫秒）；视频的播放、暂停、跳转、倍速事件到来时立刻检查 */
  tickMs: 200,
  /** 后台把本机的音频文件分块交给 YouTube 页面里的配音脚本：每块多少字节（base64 后约 1.33 倍） */
  chunkBytes: 4 * 1024 * 1024,
  /** 文件大小上限（字节）：开启时整份载入那个标签页的内存 */
  maxFileBytes: 500 * 1024 * 1024,
  /** m4a 的索引（moov）最多读多少字节 */
  maxMoovBytes: 32 * 1024 * 1024,
  /** 音量比较的容差 */
  volumeEps: 0.002,
  /** 原声音量被改回原值这么多次（在 revertWindowMs 内）：判定 YouTube 不让改，停手并说明，不跟它来回抢 */
  maxVolumeReverts: 5,
  revertWindowMs: 3_000,
  /** 浏览器拦下自动出声后，隔多久再试一次播放（毫秒） */
  playRetryMs: 2_000,
  /** 列表里显示的标题最多多少字 */
  titleMaxChars: 200,
  fileNameMaxChars: 200,
  /**
   * 片段录制里混入配音时的软限幅（DECISIONS §76）：原声 80% 加中文 100% 的峰值可能超过满幅，编码时会削波失真。
   * 混音后过一条固定的曲线：|x| ≤ knee 时原样不动（音量比例严格是 80% : 100%），超过 knee 的峰值平滑压到 1 以内，
   * 最多接得住 headroom 倍满幅。不用 DynamicsCompressor：它会自动加补偿增益（阈值 −3 dB 时整体抬高约 1.7 dB，Chromium 实测 ×1.22），
   * 混出来的比例就不是你听到的了。不混配音的录音不经过它，和以前一样
   */
  mixLimiter: { knee: 0.9, headroom: 2, points: 8193 },
  /** 原声混音倍数变化时的平滑时间常数（秒）：配音开 / 关、广告前后不咔哒一下 */
  mixRampSec: 0.02,
} as const;

/** Anthropic 服务端拒答回退：'default' 在不支持的模型上等于不回退，安全。 */
export const ANTHROPIC_FALLBACK = {
  beta: 'server-side-fallback-2026-07-01',
  fallbacks: 'default',
} as const;

export const GOOGLE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

/**
 * YouTube 授权：launchWebAuthFlow + Google 授权码 + PKCE，拿刷新令牌在后台续期（DECISIONS §53）。
 * 访问令牌约 1 小时有效；过期后用刷新令牌向 oauth2.googleapis.com/token 换新的，不弹窗、不依赖浏览器里的 Google 登录。
 */
export const GOOGLE_OAUTH = {
  /** 提前这么久视为过期，避免请求途中失效 */
  expiryMarginMs: 2 * 60_000,
  /** 响应里没带 expires_in 时按此估算（Google 惯例 3599 秒） */
  defaultExpiresInSec: 3599,
  /**
   * 交互授权的 prompt：consent 保证每次都发刷新令牌（Google 只在"同意"那一步发，以前授过权时不加就拿不到），
   * select_account 让浏览器里登录了多个 Google 账号时挑账号。Google 允许用空格连写多个值。
   */
  interactivePrompt: 'consent select_account',
  /** 续期请求（令牌端点）最长等待 */
  tokenTimeoutMs: 15_000,
  /** 续期被 Google 拒绝（不是网络问题）后，这段时间内不再重试，直接说原因 */
  renewRetryAfterMs: 15 * 60_000,
  /**
   * Google 的规定（外部事实，2026-11-07 核实）：OAuth 同意屏幕为"外部"、发布状态为"测试"的项目，
   * 申请 youtube.readonly 这类范围时，刷新令牌 7 天后失效；发布为"正式版"后没有这个期限（半年不用、被你移除授权时仍会失效）。
   */
  testingRefreshTtlDays: 7,
  /** 交互授权窗口最多等这么久（在窗口里登录、选账号）；超过后后台不再保活，界面说明"窗口没有交回结果" */
  interactiveMaxMs: 10 * 60_000,
} as const;
