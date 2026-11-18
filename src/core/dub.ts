// 中文配音（用户 2026-11-13 要求，见 DECISIONS §74、§75）的纯逻辑：配音记录、对齐点与分段、跟随判定、原声降音量、偏移与时长的说法、m4a 的检查。
// 配音是重新录制的克隆音频，时长和原视频不完全一致：同步只做"跟随播放状态 + 你手动设的偏移 / 对齐点"，不做、也不假装做逐句 / 逐词对齐。
// 对齐点（§75，手测后用户要求）：你在几处标"视频这一刻 ↔ 中文这一刻"，把全程分成几段，每段有自己的偏移；
// 一段里中文按正常速度放，中文先说完就停下等画面，中文说得慢就在下一个对齐点跳过去。
// 快速对齐（§82，用户 2026-11-16 要求）：不想一个个加对齐点时，中文整段按"中文时长 ÷ 视频时长"的倍速放，和视频同时开始、同时结束；
// 开头的偏移和对齐点留着不用，随时切回手动。
// 加快英文（§87，用户 2026-11-18 要求）：方向相反——中文按原速放，英文原声（连同画面）整段按"视频时长 ÷ 中文时长"的倍速放；
// 两边的对应关系和快速对齐一模一样（中文位置 = 视频位置 × 中文时长 ÷ 视频时长），只是变速的是英文。
// 整体变速（§87）：对齐之后两条一起加速 / 减速（视频的倍速再乘上它，中文跟着视频走），对应关系不变。
// 播放与降音量在 content/dub.ts（YouTube 播放页）；音频文件在扩展自己的 IndexedDB（services/dub-store.ts），由后台分块交给页面里的脚本。

import { DUB } from '../config/defaults';

/** 侧边栏 / 后台 ↔ 配音脚本的消息类型 */
export const DUB_MSG = {
  getState: 'tubemuse:dub:get-state',
  /** 配音脚本主动推送的状态变化 */
  state: 'tubemuse:dub:state',
  /** 侧边栏 → 配音脚本：开 / 关这个视频的配音（{ on?: boolean }） */
  toggle: 'tubemuse:dub:toggle',
  /**
   * 侧边栏 → 配音脚本：拖动"中文位置"时的实时偏移（不存；松手后侧边栏存进本机，脚本从存储里读到）。
   * { videoId, segment, offset } 或 { videoId, segment, dubAt }（让此刻放中文的 dubAt 秒处，由脚本按此刻的视频位置算出偏移）
   */
  setDelay: 'tubemuse:dub:set-delay',
  /** 侧边栏 → 配音脚本：此刻的视频位置与中文位置（加对齐点用），回复 DubMark */
  mark: 'tubemuse:dub:mark',
  /** 配音脚本 → 后台：工具栏图标上的"中" */
  badge: 'tubemuse:dub:badge',
  /**
   * 侧边栏 → 配音脚本：视频控制键（DECISIONS §85）。{ action: 'toggle-play' } 暂停 / 继续播放；
   * { action: 'seek', by } 前进（正）或后退（负）by 秒。回复 DubControlReply
   */
  control: 'tubemuse:dub:control',
} as const;

/** 配音脚本 → 后台：要这个视频的配音音频（长连接，后台分块回传） */
export const DUB_PORT = 'tubemuse:dub-audio';

/** 一个视频关联的中文配音（只有元数据；音频本身在 IndexedDB，按 fileId 存） */
export interface DubRecord {
  videoId: string;
  /** IndexedDB 里音频的键 */
  fileId: string;
  fileName: string;
  /** 字节数 */
  size: number;
  mime: string;
  /** 文件里写的时长（秒）；读不出来时为空 */
  durationSec?: number;
  /** 关联时原视频的时长（秒），用来对比两者的长度 */
  videoDurationSec?: number;
  /** 关联时的视频标题（页面标题），列表里显示 */
  title?: string;
  /** 开头那一段（第一个对齐点之前）的偏移：中文推后多少秒（负数 = 提前），配音位置 = 视频位置 − delaySec */
  delaySec: number;
  /** 对齐点（按视频时间排好；§75）：从每个对齐点起，配音位置 = 视频位置 − (video − dub) */
  anchors?: DubAnchor[];
  /**
   * 快速对齐（§82）：有这一项 = 开着，中文整段按这个倍速放（中文位置 = 视频位置 × 倍速），开头的偏移和对齐点留着不用；
   * 去掉这一项 = 切回手动对齐，偏移和对齐点照旧生效
   */
  quickRate?: number;
  /**
   * 加快英文（§87）：有这一项 = 开着，英文原声（YouTube 页面里的视频，连同画面）整段按这个倍速放、中文按原速放，
   * 对应关系和快速对齐一样（中文位置 = 视频位置 ÷ 这个倍速）；开头的偏移和对齐点同样留着不用。和 quickRate 只会有一个
   */
  englishRate?: number;
  /** 整体倍速（§87）：对齐之后两边一起变快 / 变慢（视频的倍速再乘上它，中文跟着视频走）。不写 = 1 */
  overallRate?: number;
  /** 配音字幕（§86）：这个配音有字幕时记着它是哪来的、有多少句；字幕本身按视频分键存放（dubSubsStore） */
  subs?: DubSubsMeta;
  addedAt: number;
}

/** 配音字幕是什么语言：按文字认（中文、日文、韩文、拉丁字母——多半是英文），认不出时 other */
export type DubSubLang = 'zh' | 'ja' | 'ko' | 'latin' | 'other';

/** 一个配音的字幕的说明（字幕本身另存） */
export interface DubSubsMeta {
  /** 字幕文件名，或小宇宙那一集的标题 */
  name: string;
  /** 多少句 */
  count: number;
  lang: DubSubLang;
  /** 哪来的：你选的字幕文件，或小宇宙里已经生成的那一集字幕 */
  source: 'file' | 'xyz';
  /** 双语字幕里只留了配音语言的那几行 */
  reduced?: boolean;
  addedAt: number;
}

const SUB_LANGS: readonly DubSubLang[] = ['zh', 'ja', 'ko', 'latin', 'other'];

export function sanitizeDubSubsMeta(v: unknown): DubSubsMeta | undefined {
  const m = v as Partial<DubSubsMeta> | undefined;
  if (!m || typeof m !== 'object') return undefined;
  const count = typeof m.count === 'number' && Number.isInteger(m.count) && m.count > 0 ? m.count : 0;
  if (!count) return undefined;
  return {
    name: text(m.name, DUB.fileNameMaxChars) || '字幕',
    count,
    lang: SUB_LANGS.includes(m.lang as DubSubLang) ? (m.lang as DubSubLang) : 'other',
    source: m.source === 'xyz' ? 'xyz' : 'file',
    ...(m.reduced === true ? { reduced: true } : {}),
    addedAt: typeof m.addedAt === 'number' && Number.isFinite(m.addedAt) ? m.addedAt : 0,
  };
}

/** 对齐点：视频的这一刻对应中文的这一刻（秒） */
export interface DubAnchor {
  video: number;
  dub: number;
}

/**
 * 跟随用的对齐信息：开头的偏移 + 对齐点；按倍速对齐时只看 quickRate（偏移和对齐点留着不用）。
 * quickRate = 中文位置 ÷ 视频位置：快速对齐时是中文的倍速；加快英文时（englishRate 有值）是 1 ÷ 英文的倍速——两种对应关系一样，只是变速的那一边不同
 */
export interface DubMap {
  delaySec: number;
  anchors: readonly DubAnchor[];
  quickRate?: number;
  /** 加快英文（§87）开着时英文的倍速（这时 quickRate = 1 ÷ 它） */
  englishRate?: number;
}

/** 按倍速对齐的两种：快速对齐（中文变速）/ 加快英文（英文变速）；manual = 偏移和对齐点 */
export type DubRateMode = 'manual' | 'quick' | 'english';

/** 两种按倍速对齐的倍速（记录、对齐信息、摊开的结果都有这两项） */
export interface DubRates {
  quickRate?: number;
  englishRate?: number;
}

export function dubRateMode(m: DubRates): DubRateMode {
  return m.englishRate !== undefined ? 'english' : m.quickRate !== undefined ? 'quick' : 'manual';
}

/** 视频 ID → 配音 */
export type DubIndex = Record<string, DubRecord>;

const VIDEO_ID_RE = /^[\w-]{6,20}$/;
const FILE_ID_RE = /^dub_[\w]{4,40}$/;

export const isDubVideoId = (x: unknown): x is string => typeof x === 'string' && VIDEO_ID_RE.test(x);
export const isDubFileId = (x: unknown): x is string => typeof x === 'string' && FILE_ID_RE.test(x);

const finitePos = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined);
const text = (x: unknown, max: number): string => (typeof x === 'string' ? x.trim().slice(0, max) : '');

/** 偏移：限制在范围内，按 0.1 秒取整 */
export function clampDelay(x: unknown): number {
  const n = typeof x === 'number' && Number.isFinite(x) ? x : 0;
  const c = Math.max(-DUB.maxDelaySec, Math.min(DUB.maxDelaySec, n));
  const r = Math.round(c / DUB.delayStepSec) * DUB.delayStepSec;
  // 去掉 -0 与浮点尾巴（0.30000000000000004）
  return Number(r.toFixed(1)) || 0;
}

/** 读存储时校验每一条：坏掉的丢弃（存储被手改、旧版本格式） */
export function sanitizeDubIndex(v: unknown): DubIndex {
  const out: DubIndex = {};
  if (!v || typeof v !== 'object') return out;
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    const r = raw as Partial<DubRecord> | undefined;
    if (!r || typeof r !== 'object' || !isDubVideoId(key) || r.videoId !== key || !isDubFileId(r.fileId)) continue;
    const size = finitePos(r.size);
    if (!size) continue;
    const rec: DubRecord = {
      videoId: key,
      fileId: r.fileId,
      fileName: text(r.fileName, DUB.fileNameMaxChars) || '配音.m4a',
      size,
      mime: text(r.mime, 60) || 'audio/mp4',
      delaySec: clampDelay(r.delaySec),
      addedAt: typeof r.addedAt === 'number' && Number.isFinite(r.addedAt) ? r.addedAt : 0,
    };
    const d = finitePos(r.durationSec);
    if (d) rec.durationSec = d;
    const vd = finitePos(r.videoDurationSec);
    if (vd) rec.videoDurationSec = vd;
    const title = text(r.title, DUB.titleMaxChars);
    if (title) rec.title = title;
    const anchors = sanitizeAnchors(r.anchors);
    if (anchors.length) rec.anchors = anchors;
    const quick = sanitizeQuickRate(r.quickRate);
    if (quick !== undefined) rec.quickRate = quick;
    // 两种按倍速对齐只会开一种（存储被手改出两项时按先有的快速对齐算）
    const english = quick === undefined ? sanitizeQuickRate(r.englishRate) : undefined;
    if (english !== undefined) rec.englishRate = english;
    const overall = sanitizeOverallRate(r.overallRate);
    if (overall !== undefined) rec.overallRate = overall;
    const subs = sanitizeDubSubsMeta(r.subs);
    if (subs) rec.subs = subs;
    out[key] = rec;
  }
  return out;
}

// ── 对齐点 ──

const roundAnchor = (x: number) => Math.round(x / DUB.anchorPrecisionSec) * DUB.anchorPrecisionSec;
const tidy = (x: number) => Number(roundAnchor(x).toFixed(2)) || 0;

/** 读存储时：只留数字对的、按视频时间排好、太近的合并（留后面那个），最多 maxAnchors 个 */
export function sanitizeAnchors(v: unknown): DubAnchor[] {
  if (!Array.isArray(v)) return [];
  let out: DubAnchor[] = [];
  for (const a of v) {
    const x = a as Partial<DubAnchor> | undefined;
    if (!x || typeof x.video !== 'number' || typeof x.dub !== 'number' || !Number.isFinite(x.video) || !Number.isFinite(x.dub)) continue;
    if (x.video <= 0 || x.video > DUB.maxDelaySec * 4 || x.dub < 0 || x.dub > DUB.maxDelaySec * 4) continue;
    out = withAnchor(out, { video: x.video, dub: x.dub });
  }
  return out.slice(0, DUB.maxAnchors);
}

/** 加一个对齐点：离已有的不到 anchorMergeSec 时替换它；保持按视频时间排好 */
export function withAnchor(anchors: readonly DubAnchor[], a: DubAnchor): DubAnchor[] {
  const next = { video: tidy(a.video), dub: Math.max(0, tidy(a.dub)) };
  return [...anchors.filter((x) => Math.abs(x.video - next.video) >= DUB.anchorMergeSec), next].sort((x, y) => x.video - y.video);
}

export function dubMapOf(rec: Pick<DubRecord, 'delaySec' | 'anchors' | 'quickRate' | 'englishRate'>): DubMap {
  const base = { delaySec: rec.delaySec, anchors: rec.anchors ?? [] };
  if (rec.quickRate !== undefined) return { ...base, quickRate: rec.quickRate };
  // 加快英文：对应关系和快速对齐一样（中文位置 = 视频位置 ÷ 英文倍速），跟随、对齐图、"还差多少"都按 quickRate 算
  if (rec.englishRate !== undefined) return { ...base, quickRate: 1 / rec.englishRate, englishRate: rec.englishRate };
  return base;
}

// ── 快速对齐（§82）──

/** 快速对齐的倍速：只认范围内的有限数，按 decimals 位小数取整；别的一律当作没开 */
export function sanitizeQuickRate(x: unknown): number | undefined {
  if (typeof x !== 'number' || !Number.isFinite(x)) return undefined;
  const r = Number(x.toFixed(DUB.quick.decimals));
  return r >= DUB.quick.minRate && r <= DUB.quick.maxRate ? r : undefined;
}

/** 建议的倍速：快速对齐是中文时长 ÷ 视频时长，加快英文是视频时长 ÷ 中文时长。ok = 在能用的范围里；不能用时 why 说原因 */
export interface QuickAlignSuggestion {
  rate: number;
  dubSec: number;
  videoSec: number;
  ok: boolean;
  why?: string;
}

/**
 * 快速对齐的建议倍速 = 中文时长 ÷ 视频时长（例：14:38.4 ÷ 17:31.3 = 0.8355）：中文整段按它放，正好和视频同时结束。
 * 读不到哪一边的时长时算不出来（undefined）；倍速超出 DUB.quick 的范围时给出数但不能用
 */
export function quickAlignSuggestion(dubSec: number | undefined, videoSec: number | undefined): QuickAlignSuggestion | undefined {
  if (!dubSec || !videoSec || !Number.isFinite(dubSec) || !Number.isFinite(videoSec) || dubSec <= 0 || videoSec <= 0) return undefined;
  const rate = Number((dubSec / videoSec).toFixed(DUB.quick.decimals));
  const base = { rate, dubSec, videoSec };
  if (rate < DUB.quick.minRate) {
    return { ...base, ok: false, why: `中文只有原视频的 ${Math.round(rate * 100)}%，要慢到 ${rateText(rate)} 才能放满：低于 ${rateText(DUB.quick.minRate)} 声音失真得厉害，不提供快速对齐，用手动对齐点。` };
  }
  if (rate > DUB.quick.maxRate) {
    return { ...base, ok: false, why: `中文是原视频的 ${Math.round(rate * 100)}%，要快到 ${rateText(rate)} 才能放完：高于 ${rateText(DUB.quick.maxRate)} 听不清，不提供快速对齐，用手动对齐点。` };
  }
  return { ...base, ok: true };
}

/**
 * 加快英文（§87）的建议倍速 = 视频时长 ÷ 中文时长（例：1:27:15.3 ÷ 1:19:50.7 = 1.0928）：英文原声整段按它放、中文原速，正好同时结束。
 * 范围和快速对齐一样（0.5–2）：两者互为倒数，一个能用另一个也能用
 */
export function englishAlignSuggestion(dubSec: number | undefined, videoSec: number | undefined): QuickAlignSuggestion | undefined {
  if (!dubSec || !videoSec || !Number.isFinite(dubSec) || !Number.isFinite(videoSec) || dubSec <= 0 || videoSec <= 0) return undefined;
  const rate = Number((videoSec / dubSec).toFixed(DUB.quick.decimals));
  const base = { rate, dubSec, videoSec };
  if (rate > DUB.quick.maxRate) {
    return { ...base, ok: false, why: `英文要快到 ${rateText(rate)} 才能和中文同时结束：高于 ${rateText(DUB.quick.maxRate)} 听不清，不提供加快英文，用手动对齐点。` };
  }
  if (rate < DUB.quick.minRate) {
    return { ...base, ok: false, why: `英文要慢到 ${rateText(rate)} 才能和中文同时结束：低于 ${rateText(DUB.quick.minRate)} 声音失真得厉害，不提供，用手动对齐点。` };
  }
  return { ...base, ok: true };
}

/** 加快英文这种对齐叫什么：英文要快放时"加快英文"，中文比原视频还长、英文要慢放时"放慢英文" */
export const englishModeName = (rate: number): string => (rate < 0.99995 ? '放慢英文' : '加快英文');

// ── 整体变速（§87）──

/** 整体倍速：只认范围内的有限数，按 0.01 取整；1（不变速）和别的一律当作没设 */
export function sanitizeOverallRate(x: unknown): number | undefined {
  if (typeof x !== 'number' || !Number.isFinite(x)) return undefined;
  const r = Number(x.toFixed(2));
  return r >= DUB.overall.min && r <= DUB.overall.max && r !== 1 ? r : undefined;
}

/**
 * 两条音轨各按什么倍速放（不含你在 YouTube 播放器里选的倍速，那个再乘上去）：
 * 手动对齐两边都是整体倍速；快速对齐中文再乘它的倍速；加快英文英文（连同画面）再乘英文的倍速
 */
export function trackRates(m: DubRates, overallRate?: number): { en: number; zh: number } {
  const s = overallRate ?? 1;
  const mode = dubRateMode(m);
  if (mode === 'english') return { en: s * m.englishRate!, zh: s };
  if (mode === 'quick') return { en: s, zh: s * m.quickRate! };
  return { en: s, zh: s };
}

/** 视频（英文原声）的倍速要在你选的倍速上再乘多少：加快英文的倍速 × 整体倍速 */
export const videoRateFactor = (m: DubRates, overallRate?: number): number => trackRates(m, overallRate).en;

/** 1.25× 这种倍速的写法：去掉多余的 0（1×、1.5×、1.25×） */
export const speedText = (rate: number): string => `${Number(rate.toFixed(2))}×`;

/** 倍速的写法：0.84×（两位小数，给人看的"约"数） */
export const rateText = (rate: number): string => `${rate.toFixed(2)}×`;

/** 倍速的精确写法：0.8355（四位小数；实际用的还要再精确两位） */
export const rateExactText = (rate: number): string => rate.toFixed(4);

/** 这个倍速是慢放、快放还是原速 */
export const rateWord = (rate: number): string => (rate < 0.99995 ? '慢放' : rate > 1.00005 ? '快放' : '原速');

/** 一段：从 fromVideo 起，中文位置 = 视频位置 − offset；到 nextVideo 换下一段。这一段的中文到 dubEnd 为止（下一个对齐点的中文位置） */
export interface DubSegment {
  /** −1 = 开头那一段（第一个对齐点之前，偏移就是 delaySec）；k = 第 k 个对齐点（从 0 数）之后那一段 */
  index: number;
  fromVideo: number;
  /** 正 = 中文推后（比画面晚），负 = 中文提前 */
  offset: number;
  nextVideo?: number;
  dubEnd?: number;
}

/** 视频的 t 秒落在哪一段。快速对齐开着时全程一段，"偏移"是此刻视频位置 − 中文位置（随播放连续变） */
export function dubSegmentAt(map: DubMap, t: number): DubSegment {
  if (map.quickRate !== undefined) return { index: -1, fromVideo: 0, offset: Number((t * (1 - map.quickRate)).toFixed(2)) || 0 };
  let i = -1;
  for (let k = 0; k < map.anchors.length; k++) {
    if (map.anchors[k]!.video <= t) i = k;
    else break;
  }
  const a = i >= 0 ? map.anchors[i]! : undefined;
  const next = map.anchors[i + 1];
  return {
    index: i,
    fromVideo: a ? a.video : 0,
    offset: a ? Number((a.video - a.dub).toFixed(2)) : map.delaySec,
    ...(next ? { nextVideo: next.video, dubEnd: next.dub } : {}),
  };
}

/** 改某一段的偏移：开头那段改 delaySec；第 k 段改第 k 个对齐点的中文位置（视频位置不动） */
export function withSegmentOffset(map: DubMap, index: number, offset: number): DubMap {
  if (index < 0 || index >= map.anchors.length) return { ...map, delaySec: clampDelay(offset), anchors: [...map.anchors] };
  const anchors = map.anchors.map((a, k) => (k === index ? { video: a.video, dub: Math.max(0, tidy(a.video - clampDelay(offset))) } : a));
  return { ...map, anchors };
}

/** 前后颠倒的对齐点（中文位置不比前一个靠后）：这几个之前那一段的中文会被整段跳过或重放，界面上标出来 */
export function misorderedAnchors(map: DubMap): number[] {
  const bad: number[] = [];
  let prev = Math.max(0, -map.delaySec);
  map.anchors.forEach((a, k) => {
    if (a.dub <= prev) bad.push(k);
    prev = a.dub;
  });
  return bad;
}

// ── 选文件 ──

export class DubFileError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'DubFileError';
  }
}

/** 只收 .m4a（MP4 容器里的音频）：看扩展名或浏览器给的类型，内容另由 probeM4a 检查 */
export function checkDubFile(name: string, type: string, size: number): void {
  const okName = /\.m4a$/i.test(name);
  const okType = /^audio\/(mp4|x-m4a|m4a|aac)$/i.test(type);
  if (!okName && !okType) throw new DubFileError(`"${name}" 不是 .m4a 文件`, '中文配音只收 .m4a 音频文件。');
  if (size <= 0) throw new DubFileError(`"${name}" 是空文件`);
  if (size > DUB.maxFileBytes) {
    throw new DubFileError(`"${name}" 太大（${formatBytes(size)}）`, `最大 ${formatBytes(DUB.maxFileBytes)}：开启配音时整份文件要载入那个标签页的内存。`);
  }
}

/** 读文件的 [start, end)；越界部分截掉 */
export type BlobRead = (start: number, end: number) => Promise<Uint8Array>;

export interface M4aProbe {
  /** 文件里写的时长（秒）；分片格式可能写 0，这时为空 */
  durationSec?: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

interface Box {
  type: string;
  body: number;
  end: number;
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    const type = tag(b, o + 4);
    let body = o + 8;
    if (size === 1) {
      if (o + 16 > end) return;
      size = u64(b, o + 8);
      body = o + 16;
    } else if (size === 0) size = end - o;
    if (size < body - o || o + size > end) return;
    yield { type, body, end: o + size };
    o += size;
  }
}

const child = (b: Uint8Array, parent: Box, type: string) => {
  for (const x of boxes(b, parent.body, parent.end)) if (x.type === type) return x;
  return undefined;
};

/**
 * 认出 m4a 并读出时长：开头要有 ftyp；找到 moov（可能在文件末尾，只读盒子头和 moov 本身），
 * 读 mvhd 的时长（分片格式写 0 时看 mehd），再看有没有声音轨。不是 m4a、没有声音轨时抛 DubFileError。
 */
export async function probeM4a(read: BlobRead, total: number): Promise<M4aProbe> {
  const notM4a = new DubFileError('这个文件不是 m4a 音频', '文件开头没有 MP4 的标记（ftyp）。中文配音只收 .m4a 文件，改了扩展名的别的格式也不行。');
  const head = await read(0, Math.min(total, 64 * 1024));
  if (head.length < 16 || tag(head, 4) !== 'ftyp') throw notM4a;
  let o = 0;
  for (let guard = 0; guard < 256 && o + 8 <= total; guard++) {
    const h = o + 16 <= head.length ? head.subarray(o, o + 16) : await read(o, Math.min(total, o + 16));
    if (h.length < 8) break;
    let size = u32(h, 0);
    const type = tag(h, 4);
    if (size === 1) size = h.length >= 16 ? u64(h, 8) : 0;
    else if (size === 0) size = total - o;
    if (size < 8) throw new DubFileError('m4a 的结构不对，读不出来', '文件可能没写完或已损坏：重新导出一份再试。');
    if (type === 'moov') {
      if (size > DUB.maxMoovBytes) throw new DubFileError('m4a 的索引太大，读不出来');
      const moov = await read(o, o + size);
      if (moov.length < size) throw new DubFileError('m4a 的索引没读全', '文件可能没写完：重新导出一份再试。');
      return probeMoov(moov);
    }
    o += size;
  }
  throw new DubFileError('m4a 文件里没找到索引（moov）', '文件可能没写完或已损坏：重新导出一份再试。');
}

function probeMoov(moov: Uint8Array): M4aProbe {
  const root: Box = { type: 'root', body: 0, end: moov.length };
  const mv = child(moov, root, 'moov');
  if (!mv) throw new DubFileError('m4a 文件里没找到索引（moov）');
  let durationSec: number | undefined;
  const mvhd = child(moov, mv, 'mvhd');
  if (mvhd) {
    const v = moov[mvhd.body]!;
    const timescale = v === 1 ? u32(moov, mvhd.body + 20) : u32(moov, mvhd.body + 12);
    const duration = v === 1 ? u64(moov, mvhd.body + 24) : u32(moov, mvhd.body + 16);
    if (timescale > 0 && duration > 0 && duration !== 0xffffffff) durationSec = duration / timescale;
    // 分片 MP4：mvhd 写 0，总时长在 mvex/mehd
    const mehd = durationSec === undefined ? (() => { const mvex = child(moov, mv, 'mvex'); return mvex ? child(moov, mvex, 'mehd') : undefined; })() : undefined;
    if (mehd && timescale > 0) {
      const ev = moov[mehd.body]!;
      const d = ev === 1 ? u64(moov, mehd.body + 4) : u32(moov, mehd.body + 4);
      if (d > 0) durationSec = d / timescale;
    }
  }
  let hasAudio = false;
  let hasVideo = false;
  for (const trak of boxes(moov, mv.body, mv.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    const kind = hdlr && hdlr.body + 12 <= hdlr.end ? tag(moov, hdlr.body + 8) : '';
    if (kind === 'soun') hasAudio = true;
    if (kind === 'vide') hasVideo = true;
  }
  if (!hasAudio) throw new DubFileError('这个 m4a 里没有声音', '文件里没有音轨。');
  return { ...(durationSec !== undefined ? { durationSec: Math.round(durationSec * 1000) / 1000 } : {}), hasAudio, hasVideo };
}

// ── 跟随 ──

/** 视频此刻的样子（YouTube 播放器里的 <video>） */
export interface DubVideoSample {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  /** readyState ≥ HAVE_FUTURE_DATA：不在缓冲 */
  canPlay: boolean;
  rate: number;
  /** 正在放广告（广告和正片在同一个播放器里） */
  ad: boolean;
}

/** 配音此刻的样子（配音脚本自己的 <audio>，不放进页面） */
export interface DubAudioSample {
  currentTime: number;
  paused: boolean;
  /** 读不出时长时为 NaN */
  duration: number;
  rate: number;
}

export type DubReason = 'playing' | 'paused' | 'seeking' | 'buffering' | 'ad' | 'ended' | 'before-start' | 'after-end' | 'segment-end';

export interface DubStep {
  play: boolean;
  /** 要把配音跳到这里（秒） */
  seekTo?: number;
  /** 要把配音的倍速改成这个 */
  rate?: number;
  reason: DubReason;
  /** 配音此刻应在的位置（视频位置 − 这一段的偏移） */
  target: number;
  segment: DubSegment;
  /** 视频再放这么多秒，跟随要换个做法（这一段中文说完、到下一个对齐点）：到时候立刻再检查一次，不等下一次例行检查 */
  wakeIn?: number;
}

/**
 * 跟随：找出视频此刻落在哪一段，配音位置 = 视频位置 − 这一段的偏移。视频在放（不在缓冲、不在跳转、不是广告）且这个位置落在配音里时放，否则停；
 * 两边差过 resyncSec 就把配音拉回来；倍速跟着视频。
 * 有对齐点时：这一段的中文到下一个对齐点的中文位置为止——中文先说完就停在那里等画面，视频到了下一个对齐点再接着放；
 * 中文说得慢、视频先到了下一个对齐点，就跳到下一段的位置（两边差过 resyncSec 的那一下）。
 * 不做逐句对齐：两段录音的语速、停顿本来就不一样，对齐点之间中文始终按正常速度放。
 */
export function dubStep(v: DubVideoSample, a: DubAudioSample, map: DubMap, resyncSec: number = DUB.resyncSec): DubStep {
  if (map.quickRate !== undefined) return quickStep(v, a, map, map.quickRate, resyncSec);
  const segment = dubSegmentAt(map, v.currentTime);
  const target = v.currentTime - segment.offset;
  const stop = (reason: DubReason, seekTo?: number, wakeIn?: number): DubStep => ({
    play: false,
    reason,
    target,
    segment,
    ...(seekTo !== undefined ? { seekTo } : {}),
    ...(wakeIn !== undefined ? { wakeIn } : {}),
  });
  if (v.ad) return stop('ad');
  if (v.seeking) return stop('seeking');
  if (v.ended) return stop('ended');
  if (target < 0) return stop('before-start', a.currentTime > 0.05 ? 0 : undefined, v.paused ? undefined : -target);
  const toNext = segment.nextVideo !== undefined ? segment.nextVideo - v.currentTime : undefined;
  if (segment.dubEnd !== undefined && target >= segment.dubEnd) {
    // 这一段中文已经说完：停在这一段的末尾等画面（视频到下一个对齐点时正好从这里接着放）
    const end = Number.isFinite(a.duration) ? Math.min(segment.dubEnd, a.duration) : segment.dubEnd;
    return stop('segment-end', Math.abs(a.currentTime - end) > resyncSec ? end : undefined, v.paused ? undefined : toNext);
  }
  if (Number.isFinite(a.duration) && target >= a.duration) return stop('after-end');
  const off = Math.abs(a.currentTime - target);
  // 停着的时候也把位置对好：一放就是对的
  if (v.paused) return stop('paused', off > resyncSec ? target : undefined);
  if (!v.canPlay) return stop('buffering', off > resyncSec ? target : undefined);
  const step: DubStep = { play: true, reason: 'playing', target, segment };
  if (off > (a.paused ? DUB.startAlignSec : resyncSec)) step.seekTo = target;
  if (Math.abs(a.rate - v.rate) > 1e-3) step.rate = v.rate;
  const toEnd = segment.dubEnd !== undefined ? segment.dubEnd - target : undefined;
  const wake = [toEnd, toNext].filter((x): x is number => x !== undefined && x > 0);
  if (wake.length) step.wakeIn = Math.min(...wake);
  return step;
}

/**
 * 快速对齐（§82）的跟随：中文位置 = 视频位置 × 倍速，中文的播放速度 = 视频倍速 × 倍速（浏览器变速不变调）。
 * 全程一段：没有偏移、没有对齐点、不停下等画面也不跳——差过 resyncSec（两个播放器走时有出入时）才把配音拉回来。
 * 仍然不是逐句对上：只是把时长差匀到整段
 */
function quickStep(v: DubVideoSample, a: DubAudioSample, map: DubMap, rate: number, resyncSec: number): DubStep {
  const segment = dubSegmentAt(map, v.currentTime);
  const target = v.currentTime * rate;
  const stop = (reason: DubReason, seekTo?: number): DubStep => ({ play: false, reason, target, segment, ...(seekTo !== undefined ? { seekTo } : {}) });
  if (v.ad) return stop('ad');
  if (v.seeking) return stop('seeking');
  if (v.ended) return stop('ended');
  if (Number.isFinite(a.duration) && target >= a.duration) return stop('after-end');
  const off = Math.abs(a.currentTime - target);
  if (v.paused) return stop('paused', off > resyncSec ? target : undefined);
  if (!v.canPlay) return stop('buffering', off > resyncSec ? target : undefined);
  const step: DubStep = { play: true, reason: 'playing', target, segment };
  if (off > (a.paused ? DUB.startAlignSec : resyncSec)) step.seekTo = target;
  const want = v.rate * rate;
  if (Math.abs(a.rate - want) > 1e-4) step.rate = want;
  // 中文快放完时（倍速和现在的时长对不上的情况）：到点立刻停，不等下一次例行检查
  if (Number.isFinite(a.duration)) step.wakeIn = (a.duration - target) / rate;
  return step;
}

// ── 视频控制键（§85）──

/** 侧边栏 → 配音脚本：控制页面里的视频 */
export type DubControl = { action: 'toggle-play' } | { action: 'seek'; by: number };

/** 认出一条控制消息；跳转只认有限、不为 0、不超过 maxSeekSec 的秒数 */
export function parseDubControl(x: unknown): DubControl | undefined {
  const m = x as { action?: unknown; by?: unknown } | undefined;
  if (m?.action === 'toggle-play') return { action: 'toggle-play' };
  if (m?.action === 'seek' && typeof m.by === 'number' && Number.isFinite(m.by) && m.by !== 0 && Math.abs(m.by) <= DUB.transport.maxSeekSec) return { action: 'seek', by: m.by };
  return undefined;
}

/** 从 currentTime 前进 / 后退 by 秒后落在哪里：不早于开头、不晚于结尾（读不到时长时只挡开头） */
export function dubSeekTarget(currentTime: number, by: number, duration: number): number {
  const t = (Number.isFinite(currentTime) ? currentTime : 0) + by;
  const end = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return Math.max(0, Math.min(end, t));
}

/** 配音脚本 → 侧边栏：控制键做了什么；没做成时 problem 说原因（界面上照实显示） */
export interface DubControlReply {
  ok: boolean;
  problem?: string;
  /** 做完之后的状态（位置是新的） */
  state: DubTabState;
}

/** 控制键的说法：« 30 秒、5 秒 » */
export const seekLabel = (by: number): string => (by < 0 ? `« ${-by} 秒` : `${by} 秒 »`);

/** 整体倍速（§87）不是 1 时加在状态后面："（整体 1.25×）" */
const overallSuffix = (overallRate?: number) => (overallRate !== undefined && Math.abs(overallRate - 1) > 1e-9 ? `（整体 ${speedText(overallRate)}）` : '');

/** 跟随状态的说法（segment：视频此刻所在的那一段；rates：按倍速对齐时的倍速与整体倍速） */
export function dubReasonText(reason: DubReason, segment: Pick<DubSegment, 'offset' | 'nextVideo'>, rates: DubRates & { overallRate?: number } = {}): string {
  const mode = dubRateMode(rates);
  const overall = overallSuffix(rates.overallRate);
  if (mode === 'english') {
    const k = rates.englishRate!;
    if (reason === 'playing') return `配音播放中：${englishModeName(k)}，英文原声按 ${rateText(k)} ${rateWord(k)}、中文原速跟着走${overall}`;
    if (reason === 'after-end') return '中文已经放完了';
  }
  if (mode === 'quick') {
    const q = rates.quickRate!;
    if (reason === 'playing') return `配音播放中：快速对齐，中文按 ${rateText(q)} ${rateWord(q)}跟着视频走${overall}`;
    if (reason === 'after-end') return '中文已经放完了';
  }
  switch (reason) {
    case 'playing':
      return `配音播放中，跟着视频走${overall}`;
    case 'paused':
      return '视频暂停，配音跟着暂停';
    case 'seeking':
      return '正在跳转，配音等视频';
    case 'buffering':
      return '视频在缓冲，配音等它';
    case 'ad':
      return '正在放广告：配音暂停，原声恢复原来的音量';
    case 'ended':
      return '视频放完了';
    case 'before-start':
      return `中文还没开始：按偏移，视频放到 ${formatClockSec(segment.offset)} 时中文才开始`;
    case 'after-end':
      return '中文已经放完了（原视频比中文长）';
    case 'segment-end':
      return segment.nextVideo !== undefined
        ? `中文这一段已经说完，等画面到 ${formatClockSec(segment.nextVideo)} 的对齐点再接着放（这时听到的是原声）`
        : '中文这一段已经说完';
  }
}

// ── 原声降音量 ──

/**
 * 配音开启时把原声降到你的音量的 80%，关闭时恢复。不经过 YouTube 的音量设置：直接改 <video> 的音量，
 * 所以要分清"我们改的"和"你（或 YouTube）改的"——后者记成你的新音量，再按它降。
 * YouTube 一再把音量改回原值时（来回抢），停手并说明，不跟它抢。
 */
export class VolumeDuck {
  /** 你的音量（不是我们写进去的那个） */
  private base: number | undefined;
  /** 我们最近一次写进去的降低后的音量；没在降时为空 */
  private written: number | undefined;
  private reverts: number[] = [];
  private blockedFlag = false;

  constructor(
    readonly ratio: number = DUB.originalVolume,
    private readonly eps: number = DUB.volumeEps,
  ) {}

  /** 看一眼视频现在的音量：不是我们写的，就是你（或 YouTube）改的，记成你的新音量 */
  sync(volume: number, now: number): void {
    if (this.written !== undefined) {
      if (Math.abs(volume - this.written) <= this.eps) return;
      // 降着的时候被改回了原值：多半是 YouTube 自己恢复它记着的音量
      if (this.base !== undefined && Math.abs(volume - this.base) <= this.eps) {
        this.reverts = [...this.reverts.filter((t) => now - t < DUB.revertWindowMs), now];
        if (this.reverts.length >= DUB.maxVolumeReverts) this.blockedFlag = true;
      }
      this.written = undefined;
    }
    this.base = volume;
  }

  /**
   * 此刻要把视频音量设成多少（undefined = 不动）。duck：配音在开着且不是广告。
   * 返回值写进视频后要调 wrote()。
   */
  target(duck: boolean): number | undefined {
    if (this.base === undefined) return undefined;
    if (duck && !this.blockedFlag) {
      const t = Math.round(this.base * this.ratio * 1000) / 1000;
      return this.written !== undefined && Math.abs(this.written - t) <= this.eps ? undefined : t;
    }
    // 不降（或被挡住）：之前降过就恢复
    return this.written !== undefined ? this.base : undefined;
  }

  /** 已把音量设成了 value */
  wrote(value: number): void {
    this.written = this.base !== undefined && Math.abs(value - this.base) <= this.eps ? undefined : value;
  }

  /** 现在是不是降着 */
  get ducked(): boolean {
    return this.written !== undefined;
  }

  get blocked(): boolean {
    return this.blockedFlag;
  }

  /** 你的音量 */
  get userVolume(): number | undefined {
    return this.base;
  }

  /** 换视频、重新开启：重新开始（之前被挡住的也再试一次） */
  reset(): void {
    this.base = undefined;
    this.written = undefined;
    this.reverts = [];
    this.blockedFlag = false;
  }
}

// ── 视频的倍速（§87）──

/**
 * 加快英文、整体变速开着时把 <video> 的倍速设成"你的倍速 × 要乘的倍数"，关掉时恢复。和 VolumeDuck 一个做法：
 * 不经过 YouTube 的倍速设置，直接改 <video> 的 playbackRate，所以要分清"我们改的"和"你（或 YouTube）改的"——后者记成你的新倍速，再按它乘。
 * YouTube 一再把倍速改回原值时（来回抢），停手并说明，不跟它抢
 */
export class VideoRateKeeper {
  /** 你的倍速（YouTube 播放器里选的，不是我们写进去的那个） */
  private base: number | undefined;
  /** 我们最近一次写进去的倍速；没在乘时为空 */
  private written: number | undefined;
  private reverts: number[] = [];
  private blockedFlag = false;

  constructor(private readonly eps: number = DUB.videoRate.eps) {}

  /** 看一眼视频现在的倍速：不是我们写的，就是你（或 YouTube）改的，记成你的新倍速 */
  sync(rate: number, now: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    if (this.written !== undefined) {
      if (Math.abs(rate - this.written) <= this.eps) return;
      // 乘着的时候被改回了原值：多半是 YouTube 自己恢复它记着的倍速
      if (this.base !== undefined && Math.abs(rate - this.base) <= this.eps) {
        this.reverts = [...this.reverts.filter((t) => now - t < DUB.videoRate.revertWindowMs), now];
        if (this.reverts.length >= DUB.videoRate.maxReverts) this.blockedFlag = true;
      }
      this.written = undefined;
    }
    this.base = rate;
  }

  /**
   * 此刻要把视频倍速设成多少（undefined = 不动）。factor：要乘的倍数（配音没开、广告时传 1 = 恢复）。
   * 返回值写进视频后要调 wrote()
   */
  target(factor: number): number | undefined {
    if (this.base === undefined) return undefined;
    if (Math.abs(factor - 1) > 1e-9 && !this.blockedFlag) {
      const t = Math.max(DUB.videoRate.min, Math.min(DUB.videoRate.max, this.base * factor));
      return this.written !== undefined && Math.abs(this.written - t) <= this.eps ? undefined : t;
    }
    // 不乘（或被挡住）：之前乘过就恢复
    return this.written !== undefined ? this.base : undefined;
  }

  /** 已把倍速设成了 value */
  wrote(value: number): void {
    this.written = this.base !== undefined && Math.abs(value - this.base) <= this.eps ? undefined : value;
  }

  /** 现在是不是乘着 */
  get boosted(): boolean {
    return this.written !== undefined;
  }

  get blocked(): boolean {
    return this.blockedFlag;
  }

  /** 你的倍速 */
  get userRate(): number | undefined {
    return this.base;
  }

  /** 换视频、重新开启：重新开始（之前被挡住的也再试一次） */
  reset(): void {
    this.base = undefined;
    this.written = undefined;
    this.reverts = [];
    this.blockedFlag = false;
  }
}

// ── 说法 ──

/** 1:04:02、3:05、0:42 */
export function formatClockSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** 1.5 秒、13 秒、2 分 05 秒 */
export function formatSeconds(sec: number): string {
  const s = Math.abs(sec);
  if (s < 60) return `${Number(s.toFixed(1))} 秒`;
  const r = Math.round(s);
  return `${Math.floor(r / 60)} 分 ${String(r % 60).padStart(2, '0')} 秒`;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** 开头那一段偏移的说法 */
export function delayText(delaySec: number): string {
  const d = clampDelay(delaySec);
  if (d === 0) return '不偏移：中文从视频开头一起开始';
  return d > 0 ? `中文推后 ${formatSeconds(d)}：视频放到 ${formatClockSec(d)} 时中文才开始` : `中文提前 ${formatSeconds(d)}：跳过中文开头的 ${formatSeconds(d)}`;
}

/** 某一段偏移的说法：开头那段沿用 delayText；对齐点之后的说"中文比画面晚 / 早多少" */
export function segmentOffsetText(segment: Pick<DubSegment, 'index' | 'offset'>): string {
  if (segment.index < 0) return delayText(segment.offset);
  const d = Number(segment.offset.toFixed(1)) || 0;
  if (d === 0) return '这一段中文和画面同步（偏移 0）';
  return d > 0 ? `这一段中文比画面晚 ${formatSeconds(d)}` : `这一段中文比画面早 ${formatSeconds(d)}`;
}

/**
 * 两者长度的对比。差得不多时如实说"对齐开头后越往后可能差得越多"，不承诺逐句对齐。
 * 例：中文 1:04:02、原视频 1:03:49 → 中文长 13 秒。
 */
export function durationNote(dubSec: number | undefined, videoSec: number | undefined, rates: DubRates = {}): string | undefined {
  if (!dubSec || !videoSec) return undefined;
  const diff = Math.round(dubSec - videoSec);
  const both = `中文 ${formatClockSec(dubSec)} · 原视频 ${formatClockSec(videoSec)}`;
  if (Math.abs(diff) < 1) return `${both}：长度一样。`;
  const longer = diff > 0 ? `中文长 ${formatSeconds(diff)}` : `中文短 ${formatSeconds(diff)}`;
  const mode = dubRateMode(rates);
  if (mode === 'quick') return `${both}，${longer}。快速对齐开着：中文整段按 ${rateText(rates.quickRate!)} ${rateWord(rates.quickRate!)}，把这段时长差匀到全片。`;
  if (mode === 'english') {
    const k = rates.englishRate!;
    return `${both}，${longer}。${englishModeName(k)}开着：英文原声整段按 ${rateText(k)} ${rateWord(k)}、中文原速，把这段时长差匀到全片。`;
  }
  return `${both}，${longer}。两段是分别录的，语速和停顿不一样（中文还可能删掉了一些段落）：对齐开头后越往后差得越多——用下面的"快速对齐"让中文整段变速放满全片（或"${diff < 0 ? '加快' : '放慢'}英文"：中文原速，英文整段变速），或者在对不上的地方加对齐点，从那里起单独调。`;
}

// ── 配音脚本的状态（交给侧边栏）──

export type DubPhase = 'disabled' | 'none' | 'off' | 'loading' | 'ready' | 'error';

export interface DubTabState {
  videoId: string | null;
  /** 设置里有没有启用中文配音 */
  enabled: boolean;
  /** 这个视频有没有关联配音 */
  available: boolean;
  fileName?: string;
  /** 你在这个标签页里开启了这个视频的配音 */
  active: boolean;
  phase: DubPhase;
  status: string;
  /** 载入进度（0–1） */
  progress?: number;
  /** 配音此刻在不在出声 */
  playing: boolean;
  /** 跟随状态（配音已载入、检查过之后才有）与"浏览器拦下了配音出声"：侧边栏据此说配音字幕此刻显示不显示（DECISIONS §86） */
  reason?: DubReason;
  blocked?: boolean;
  /** 页面标题（关联时记下，列表里显示） */
  title?: string;
  videoTime?: number;
  videoDuration?: number;
  /** 视频在不在放（不是暂停、跳转、放完、广告）与倍速：侧边栏的对齐图在两次读位置之间据此把播放头往前推（DECISIONS §77） */
  videoPlaying?: boolean;
  videoRate?: number;
  /** 视频是不是停着（暂停或放完；跳转、缓冲途中不算停）：视频控制键上写"暂停"还是"播放"（DECISIONS §85） */
  videoPaused?: boolean;
  dubTime?: number;
  dubDuration?: number;
  /** 视频此刻所在那一段的偏移（拖动"中文位置"时是实时值） */
  delaySec?: number;
  /** 视频此刻所在的那一段（拖动"中文位置"时已算上实时值）；count：一共几个对齐点 */
  segment?: DubSegment & { count: number };
  /** 此刻中文应在的位置（视频位置 − 这一段的偏移；快速对齐开着时是视频位置 × 倍速） */
  target?: number;
  /** 快速对齐（§82）开着时的倍速 */
  quickRate?: number;
  /** 加快英文（§87）开着时英文的倍速 */
  englishRate?: number;
  /** 整体倍速（§87；1 时不写） */
  overallRate?: number;
  /** 原声：你的音量、现在的音量、是不是降着、YouTube 是否把它改回去了 */
  volume?: { user: number; now: number; ducked: boolean; blocked: boolean; muted: boolean };
  /**
   * 视频（英文原声）的倍速（§87；配音开着时）：你在 YouTube 里选的、现在实际的、要乘上去的（加快英文 × 整体倍速）、
   * 是不是正乘着、YouTube 是否一再把它改回去（这时停手）、浏览器是不是保持音调
   */
  speed?: { user: number; now: number; want: number; boosted: boolean; blocked: boolean; pitch: boolean };
  error?: { message: string; hint?: string };
}

/** 配音脚本 → 侧边栏：此刻的视频位置与中文位置（加对齐点用） */
export interface DubMark {
  video: number;
  dub: number;
}

/** 后台 → 配音脚本：音频分块 */
export type DubPortReply =
  | { type: 'meta'; size: number; mime: string }
  | { type: 'chunk'; data: string }
  | { type: 'done' }
  | { type: 'error'; message: string; hint?: string };

/** 配音脚本 → 后台：要哪个视频的哪个文件 */
export interface DubPortRequest {
  type: 'open';
  videoId: string;
  fileId: string;
}

export function isDubPortRequest(x: unknown): x is DubPortRequest {
  const m = x as Partial<DubPortRequest> | undefined;
  return !!m && m.type === 'open' && isDubVideoId(m.videoId) && isDubFileId(m.fileId);
}

/** 页面标题去掉" - YouTube"和前面的未读数"(3) " */
export function cleanVideoTitle(title: string): string {
  return title
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s*-\s*YouTube\s*$/i, '')
    .trim()
    .slice(0, DUB.titleMaxChars);
}
