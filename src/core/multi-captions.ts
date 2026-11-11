// 多语字幕（用户 2026-11-02 批准的红线变更，见 DECISIONS §37）的纯逻辑：
// - 解析 YouTube 字幕文件（json3）；
// - 按播放进度挑出每种语言此刻该显示的那句（各语言用各自的时间轴，互不硬对齐）；
// - 按你的语言偏好从视频的字幕轨里选轨，没有原生轨时用 YouTube 自动翻译补上（标注"机翻"）；
// - 复用播放器自己的字幕请求（带 pot 令牌）、只换语言参数的地址；
// - 页面内助手（MAIN world）与内容脚本之间的消息校验：页面能看到、也能伪造这些消息，一律当不可信输入。

import { MULTI_CC } from '../config/defaults';
import { isLangCode } from './multicc-protocol';

export { BRIDGE_OPS, BRIDGE_TAG, isLangCode, playerRootId, type BridgeOp } from './multicc-protocol';

export const MULTICC_MSG = {
  getState: 'tubemuse:multicc:get-state',
  state: 'tubemuse:multicc:state',
  toggle: 'tubemuse:multicc:toggle',
  setLangs: 'tubemuse:multicc:set-langs',
  /** 内容脚本 → 后台：视频原声的语言（官方 videos.list，与自动字幕共用缓存） */
  videoLang: 'tubemuse:multicc:video-lang',
} as const;

/** 语言偏好里的"视频原声语言" */
export const ORIGINAL = 'original';

const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

/** 设置或侧边栏传来的语言列表：只留合法代码、去重、最多 max 种；不是数组时返回 undefined */
export function sanitizeCcLangs(raw: unknown, max: number = MULTI_CC.maxLines): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const x of raw) if ((x === ORIGINAL || isLangCode(x)) && !out.includes(x)) out.push(x);
  return out.slice(0, max);
}

// ── 字幕轨 ──

/** 'asr' = YouTube 自动生成的字幕 */
export type TrackKind = 'asr' | '';

/** 视频里的一条字幕轨（来自播放器） */
export interface CcTrack {
  /** 字幕接口的 lang 参数（例如 zh-Hans、en、ko） */
  lang: string;
  kind: TrackKind;
  /** 字幕接口的 name 参数（多数轨为空） */
  name: string;
  /** 播放器字幕菜单里的名字 */
  label: string;
  vssId: string;
  /** YouTube 能否把这条轨自动翻译成别的语言 */
  translatable: boolean;
}

/** 播放器当前显示的原生字幕 */
export interface NativeState {
  lang: string;
  kind: TrackKind;
  tlang?: string;
}

export interface CcTrackList {
  videoId: string;
  tracks: CcTrack[];
  /** YouTube 自动翻译能译成的语言 */
  translationLangs: { code: string; label: string }[];
  /** null = 原生字幕关着 */
  native: NativeState | null;
}

const str = (x: unknown, max: number): string => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const kindOf = (x: unknown): TrackKind => (x === 'asr' ? 'asr' : '');

/** 页面内助手报来的字幕轨列表（不可信）：逐项校验，格式不对的丢掉；整体不对时返回 undefined */
export function sanitizeTrackList(raw: unknown): CcTrackList | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.videoId !== 'string' || !VIDEO_ID.test(r.videoId)) return undefined;
  const tracks: CcTrack[] = [];
  for (const t of Array.isArray(r.tracks) ? r.tracks.slice(0, 300) : []) {
    if (!t || typeof t !== 'object') continue;
    const x = t as Record<string, unknown>;
    if (!isLangCode(x.lang)) continue;
    tracks.push({ lang: x.lang, kind: kindOf(x.kind), name: str(x.name, 150), label: str(x.label, 120) || x.lang, vssId: str(x.vssId, 200), translatable: x.translatable === true });
  }
  const translationLangs: CcTrackList['translationLangs'] = [];
  for (const l of Array.isArray(r.translationLangs) ? r.translationLangs.slice(0, 400) : []) {
    const x = l as Record<string, unknown> | null;
    if (x && isLangCode(x.code)) translationLangs.push({ code: x.code, label: str(x.label, 120) || x.code });
  }
  let native: NativeState | null = null;
  const n = r.native as Record<string, unknown> | null | undefined;
  if (n && typeof n === 'object' && isLangCode(n.lang)) native = { lang: n.lang, kind: kindOf(n.kind), ...(isLangCode(n.tlang) ? { tlang: n.tlang } : {}) };
  return { videoId: r.videoId, tracks, translationLangs, native };
}

// ── 选轨 ──

const ALIASES: Record<string, string> = { iw: 'he', in: 'id', ji: 'yi', jw: 'jv' };

/** 匹配字幕轨时用的归并键：中文按字形分简 / 繁（zh-CN = zh-Hans），其他语言只看主语言（en-GB、en-US 都算 en） */
export function langMatchKey(code: string): string {
  const parts = code.toLowerCase().split('-');
  const primary = ALIASES[parts[0]!] ?? parts[0]!;
  if (primary !== 'zh') return primary;
  const rest = parts.slice(1);
  return rest.includes('hant') || rest.some((p) => p === 'tw' || p === 'hk' || p === 'mo') ? 'zh-hant' : 'zh-hans';
}

const sameLang = (a: string, b: string) => langMatchKey(a) === langMatchKey(b);
export const trackKey = (t: Pick<CcTrack, 'lang' | 'kind' | 'name'>) => `${t.lang}|${t.kind}|${t.name}`;

/** 某种语言最合适的原生轨：人工字幕优先于自动生成，同等时代码完全一致的优先；没有返回 undefined */
export function bestTrack(tracks: readonly CcTrack[], want: string): CcTrack | undefined {
  let best: CcTrack | undefined;
  let bestScore = -1;
  for (const t of tracks) {
    if (!sameLang(t.lang, want)) continue;
    const score = (t.kind === '' ? 2 : 0) + (t.lang.toLowerCase() === want.toLowerCase() ? 1 : 0);
    if (score > bestScore) [best, bestScore] = [t, score];
  }
  return best;
}

/** 视频原声的语言：自动生成字幕的语言（YouTube 按说话声音识别）；没有时用官方数据里的音频语言 */
export function originalLangOf(list: CcTrackList, videoLang?: string): string | undefined {
  const asr = list.tracks.find((t) => t.kind === 'asr');
  if (asr) return asr.lang;
  return isLangCode(videoLang) ? videoLang : undefined;
}

/** 自动翻译的源轨：原声语言的人工字幕 > 其他人工字幕 > 自动生成的字幕（都要 YouTube 标了可翻译） */
export function translationBase(list: CcTrackList, originalLang: string | undefined): CcTrack | undefined {
  const ok = list.tracks.filter((t) => t.translatable);
  return (originalLang ? ok.find((t) => t.kind === '' && sameLang(t.lang, originalLang)) : undefined) ?? ok.find((t) => t.kind === '') ?? ok[0];
}

/** 要显示的一行（一种语言） */
export interface CcSource {
  /** 同一条轨 + 同一个翻译目标只取一次 */
  key: string;
  /** 实际的语言（"原声语言"已换成具体语言） */
  want: string;
  /** 来自偏好里的哪一项（original 或语言代码）：侧边栏取消勾选时按它删 */
  pref: string;
  label: string;
  track: CcTrack;
  /** YouTube 自动翻译的目标语言 */
  tlang?: string;
  autoTranslated: boolean;
}

export interface CcResolution {
  sources: CcSource[];
  /** 选了但这个视频给不出的语言，以及原因 */
  missing: { pref: string; want?: string; reason: string }[];
  originalLang?: string;
}

/**
 * 按偏好顺序选轨：有原生轨用原生轨；没有时（且允许）用 YouTube 自动翻译补上；"原声语言"不用翻译补
 * （译成原声语言的字幕不是原话）。同一种语言只出现一次，最多 maxLines 行。
 */
export function resolveSources(list: CcTrackList, langs: readonly string[], opts: { autoTranslate: boolean; videoLang?: string; maxLines?: number }): CcResolution {
  const originalLang = originalLangOf(list, opts.videoLang);
  const sources: CcSource[] = [];
  const missing: CcResolution['missing'] = [];
  for (const pref of langs) {
    const isOriginal = pref === ORIGINAL;
    const want = isOriginal ? originalLang : pref;
    if (!want) {
      missing.push({ pref, reason: '看不出视频原声是什么语言（没有自动生成的字幕，YouTube 数据里也没写）' });
      continue;
    }
    if (sources.some((s) => sameLang(s.want, want))) continue;
    const track = bestTrack(list.tracks, want);
    if (track) {
      sources.push({ key: trackKey(track), want, pref, label: track.label, track, autoTranslated: false });
      continue;
    }
    if (isOriginal) {
      missing.push({ pref, want, reason: '这个视频没有原声语言的字幕' });
      continue;
    }
    if (!opts.autoTranslate) {
      missing.push({ pref, want, reason: '这个视频没有这种语言的字幕' });
      continue;
    }
    const base = translationBase(list, originalLang);
    const targets = list.translationLangs.filter((l) => sameLang(l.code, want));
    const target = targets.find((l) => l.code.toLowerCase() === want.toLowerCase()) ?? targets[0];
    if (!base) missing.push({ pref, want, reason: '这个视频的字幕不支持 YouTube 自动翻译' });
    else if (!target) missing.push({ pref, want, reason: 'YouTube 不能自动翻译成这种语言' });
    else sources.push({ key: `${trackKey(base)}>${target.code}`, want, pref, label: target.label, track: base, tlang: target.code, autoTranslated: true });
  }
  return { sources: sources.slice(0, opts.maxLines ?? MULTI_CC.maxLines), missing, ...(originalLang ? { originalLang } : {}) };
}

/** 侧边栏里的一个勾选项 */
export interface CcOption {
  /** 勾选 / 取消时写进语言列表的值（original 或语言代码） */
  code: string;
  label: string;
  kind: 'native' | 'asr' | 'auto' | 'missing';
  checked: boolean;
  original?: boolean;
  note?: string;
  /** 正在显示的语言：读到的句数，或没读到的原因（内容脚本填） */
  cues?: number;
  error?: string;
}

/** 侧边栏的勾选项：先是正在显示（或选了但没有）的语言，按显示顺序；再是这个视频其他的原生字幕 */
export function ccOptions(list: CcTrackList, res: CcResolution, langs: readonly string[]): CcOption[] {
  const out: CcOption[] = [];
  for (const pref of langs) {
    const s = res.sources.find((x) => x.pref === pref);
    if (s) {
      out.push({ code: pref, label: s.label, kind: s.autoTranslated ? 'auto' : s.track.kind === 'asr' ? 'asr' : 'native', checked: true, ...(pref === ORIGINAL ? { original: true } : {}) });
      continue;
    }
    const m = res.missing.find((x) => x.pref === pref);
    if (m) out.push({ code: pref, label: m.want ?? pref, kind: 'missing', checked: true, note: m.reason, ...(pref === ORIGINAL ? { original: true } : {}) });
  }
  const shown = (lang: string) => res.sources.some((s) => sameLang(s.want, lang)) || out.some((o) => o.code !== ORIGINAL && sameLang(o.code, lang));
  for (const t of list.tracks) {
    if (shown(t.lang)) continue;
    const best = bestTrack(list.tracks, t.lang)!;
    out.push({ code: best.lang, label: best.label, kind: best.kind === 'asr' ? 'asr' : 'native', checked: false });
  }
  return out;
}

/** 两份语言列表是否完全一样（顺序不同也算不一样） */
export function sameCcLangs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** 播放器里真正有一行的语言，按显示顺序（这个视频给不出的语言勾着也没有行，不算） */
export function ccLineCodes(options: readonly CcOption[]): string[] {
  return options.filter((o) => o.checked && o.kind !== 'missing').map((o) => o.code);
}

/**
 * 把一行往上（delta = -1）或往下（delta = 1）挪一位，返回新的语言列表；挪不动时返回 undefined。
 * langs：这个视频用的语言列表；lines：ccLineCodes 的结果。只在真正显示的行之间换位，所以每按一次屏幕上都有变化。
 * langs 里没有行的语言（这个视频没有的；和别的行重复而没显示的，例如原声就是英语时的 en）留在列表里，
 * 跟着排在它前面的那一行走：换到别的视频上它们可能又有行了，不能因为在这个视频上调了顺序就丢掉。
 */
export function moveCcLang(langs: readonly string[], lines: readonly string[], code: string, delta: -1 | 1): string[] | undefined {
  const head: string[] = [];
  const blocks: string[][] = [];
  for (const l of langs) {
    if (lines.includes(l)) blocks.push([l]);
    else (blocks[blocks.length - 1] ?? head).push(l);
  }
  const i = blocks.findIndex((b) => b[0] === code);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= blocks.length) return undefined;
  [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
  return [...head, ...blocks.flat()];
}

/**
 * 让播放器自己取一次字幕（拿到带令牌的请求）用哪条轨：优先第一行用到的轨；
 * 已经让它取过的轨跳过（播放器可能有缓存，不再发请求）。
 */
export function primeTrack(list: CcTrackList, sources: readonly CcSource[], primed: ReadonlySet<string>): CcTrack | undefined {
  const fresh = (t: CcTrack) => !primed.has(trackKey(t)) && !t.name;
  return sources.map((s) => s.track).find(fresh) ?? list.tracks.find((t) => fresh(t) && t.kind === '') ?? list.tracks.find(fresh);
}

// ── 原生字幕是谁打开的 ──

/**
 * 区分"播放器按你保存的偏好自动打开原生字幕"与"你按了 C"。
 * YouTube 在每次正片开始（页面打开、站内换视频、广告结束）后约 1 秒自动打开你上次用的字幕（实测 0.8 秒，
 * 还没开始播放）；多语字幕若恰在这之前开启，就会把这次自动打开当成你的操作而让开（2026-11-02 用户报告的 bug）。
 * 正片开始后、播放满 autoCaptionGracePlaySec 秒（且不超过 autoCaptionGraceMaxMs）之前算"播放器可能自动打开"的窗口，
 * 窗口内最多吸收 autoCaptionMaxAbsorb 次。纯逻辑：由主循环每轮喂播放器状态。
 */
export class AutoCaptionWindow {
  private startAt: number;
  private lastAt: number;
  private played = 0;
  private wasAd = false;
  private absorbed = 0;

  constructor(
    now: number,
    private readonly o: { autoCaptionGracePlaySec: number; autoCaptionGraceMaxMs: number; autoCaptionMaxAbsorb: number } = MULTI_CC,
  ) {
    this.startAt = now;
    this.lastAt = now;
  }

  /** 正片重新开始（换视频）：重新计时 */
  restart(now: number): void {
    this.startAt = now;
    this.lastAt = now;
    this.played = 0;
    this.absorbed = 0;
  }

  /** 每轮喂一次：是否在播广告、正片是否在播放。广告结束 = 正片重新开始 */
  sample(s: { now: number; ad: boolean; playing: boolean }): void {
    if (this.wasAd && !s.ad) this.restart(s.now);
    this.wasAd = s.ad;
    // 标签页在后台时定时器被节流：一轮最多按 1 秒算，免得一下子把窗口跳过去
    if (s.playing && !s.ad) this.played += Math.min(Math.max(0, s.now - this.lastAt), 1_000) / 1_000;
    this.lastAt = s.now;
  }

  /** 现在播放器还可能按你的偏好自动打开原生字幕 */
  isOpen(now: number): boolean {
    return this.played < this.o.autoCaptionGracePlaySec && now - this.startAt < this.o.autoCaptionGraceMaxMs;
  }

  /** 原生字幕被打开了（不是我们打开的）：算播放器自动打开的就返回 true（并记一次），否则是你按的 */
  absorb(now: number): boolean {
    if (!this.isOpen(now) || this.absorbed >= this.o.autoCaptionMaxAbsorb) return false;
    this.absorbed++;
    return true;
  }
}

// ── 字幕请求地址 ──

/** 播放器自己发出的字幕请求（同源的 /api/timedtext，带 pot 令牌）→ 视频 ID；不是就返回 undefined */
export function timedtextVideoId(url: string, pageOrigin: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.origin !== pageOrigin || u.pathname !== '/api/timedtext' || !u.searchParams.get('pot')) return undefined;
  const v = u.searchParams.get('v');
  return v && VIDEO_ID.test(v) ? v : undefined;
}

/** 复用播放器自己的字幕请求，只换语言参数（lang / kind / name / tlang），格式固定 json3 */
export function trackUrl(template: string, pageOrigin: string, videoId: string, src: Pick<CcSource, 'track' | 'tlang'>): string | undefined {
  if (timedtextVideoId(template, pageOrigin) !== videoId) return undefined;
  const u = new URL(template);
  const p = u.searchParams;
  p.set('lang', src.track.lang);
  if (src.track.kind) p.set('kind', src.track.kind);
  else p.delete('kind');
  if (src.track.name) p.set('name', src.track.name);
  else p.delete('name');
  if (src.tlang) p.set('tlang', src.tlang);
  else p.delete('tlang');
  p.delete('type');
  p.set('fmt', 'json3');
  return u.toString();
}

// ── 取字幕：失败、重试、等待 ──

/** 一种语言（轨 + 翻译目标）的读取状态；attempt = 第几次请求（从 1 起） */
export type CcLoad =
  | { state: 'loading'; since: number; attempt: number }
  | { state: 'retry'; message: string; at: number; attempt: number }
  | { state: 'ok'; cues: CcCue[] }
  | { state: 'error'; message: string; hint?: string };

/** 取字幕失败的原因：HTTP 状态码、超时（我们放弃等待）、连不上 */
export type CcFetchFailure = { http: number } | { timeout: true } | { network: true };

/**
 * 取字幕失败后怎么办。YouTube 服务器出错（5xx）、限流（429）、超时、连不上都是暂时的：隔 delays[attempt-1] 再试，
 * 最多重试 delays.length 次，之后停下并说明（2026-11-03 实测：字幕接口整体变慢时，同一请求有时 20 秒后成功、多数 40 秒后 502，
 * YouTube 播放器自己的字幕请求也一样）。其余 HTTP 错误（4xx）重试也没用，直接说明。attempt：刚失败的是第几次（从 1 起）。
 */
export function ccFetchRetry(
  f: CcFetchFailure,
  attempt: number,
  o: { retryDelaysMs: readonly number[]; timeoutMs: number } = { retryDelaysMs: MULTI_CC.fetchRetryDelaysMs, timeoutMs: MULTI_CC.fetchTimeoutMs },
): { message: string; retryInMs?: number; hint?: string } {
  if ('http' in f && f.http < 500 && f.http !== 429) return { message: `YouTube 的字幕接口返回 HTTP ${f.http}` };
  const message =
    'network' in f
      ? '连不上 YouTube 的字幕接口'
      : 'timeout' in f
        ? `YouTube 的字幕接口 ${Math.round(o.timeoutMs / 1000)} 秒没有回应`
        : f.http === 429
          ? 'YouTube 的字幕接口暂时限流（HTTP 429）'
          : `YouTube 的字幕服务器出错（HTTP ${f.http}）`;
  const delay = o.retryDelaysMs[attempt - 1];
  if (delay !== undefined) return { message, retryInMs: delay };
  return {
    message: attempt > 1 ? `${message}，重试 ${attempt - 1} 次仍不行` : message,
    hint:
      'network' in f
        ? '检查网络（或代理）后，关掉再打开多语字幕即重试'
        : '这是 YouTube 那边暂时的问题，不是 TubeMuse 的设置问题；这时 YouTube 自带的字幕通常也出不来。过几分钟关掉再打开多语字幕即重试',
  };
}

/**
 * 还一种语言都没读到时，说明在等什么：有请求已等了 slowFetchMs 以上 → YouTube 的字幕接口慢、已等几秒；
 * 没有在途的请求、都在等重试 → 出了什么错、几秒后第几次重试；否则"正在读取字幕…"。
 */
export function ccWaitStatus(
  loads: readonly (CcLoad | undefined)[],
  now: number,
  o: { slowFetchMs: number; maxRetries: number } = { slowFetchMs: MULTI_CC.slowFetchMs, maxRetries: MULTI_CC.fetchRetryDelaysMs.length },
): string {
  let oldest: Extract<CcLoad, { state: 'loading' }> | undefined;
  let next: Extract<CcLoad, { state: 'retry' }> | undefined;
  for (const x of loads) {
    if (x?.state === 'loading' && (!oldest || x.since < oldest.since)) oldest = x;
    if (x?.state === 'retry' && (!next || x.at < next.at)) next = x;
  }
  if (oldest && now - oldest.since >= o.slowFetchMs) {
    return `YouTube 的字幕接口响应很慢，已等 ${Math.floor((now - oldest.since) / 1000)} 秒…${oldest.attempt > 1 ? `（第 ${oldest.attempt - 1} 次重试）` : ''}`;
  }
  if (!oldest && next) return `${next.message}，${Math.max(1, Math.ceil((next.at - now) / 1000))} 秒后重试（第 ${next.attempt - 1} 次，最多 ${o.maxRetries} 次）`;
  return '正在读取字幕…';
}

// ── 字幕文件（json3）──

/** 自动生成的字幕逐词出现：at = 这个词相对句首的秒数 */
export interface CcWord {
  at: number;
  text: string;
}

/** 一句字幕，时间是视频秒 */
export interface CcCue {
  start: number;
  end: number;
  text: string;
  words?: CcWord[];
}

const CONTROL = new RegExp(`[\\x00-\\x08\\x0B-\\x1F\\x7F${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200d, 0x2028, 0x2029, 0xfeff)}]`, 'g');

/** 统一换行、去掉控制字符和零宽字符、每行压缩空白；空行丢掉 */
export function cleanCueText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .split('\n')
    .map((l) => l.replace(/[ \t\xA0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * 解析 YouTube 的 json3 字幕：events[].tStartMs / dDurationMs / segs[].utf8（自动生成字幕的 segs 带 tOffsetMs）。
 * 跳过只定义字幕窗口的事件和自动生成字幕的换行事件（aAppend）。
 * 自动生成的字幕是两行滚动显示，相邻句子时间重叠：这里把每句截到下一句开始，一种语言一次只占一行。
 */
export function parseJson3(raw: unknown, opts: { asr: boolean; maxCues?: number; maxChars?: number }): CcCue[] {
  const events = (raw as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return [];
  const maxCues = opts.maxCues ?? MULTI_CC.maxCuesPerTrack;
  const maxChars = opts.maxChars ?? MULTI_CC.cueMaxChars;
  const cues: CcCue[] = [];
  for (const ev of events) {
    if (cues.length >= maxCues) break;
    if (!ev || typeof ev !== 'object') continue;
    const e = ev as { tStartMs?: unknown; dDurationMs?: unknown; segs?: unknown; aAppend?: unknown };
    if (!Array.isArray(e.segs) || e.aAppend || !finite(e.tStartMs) || e.tStartMs < 0 || !finite(e.dDurationMs) || e.dDurationMs <= 0) continue;
    const words: CcWord[] = [];
    for (const s of e.segs) {
      const seg = s as { utf8?: unknown; tOffsetMs?: unknown } | null;
      if (typeof seg?.utf8 !== 'string') continue;
      words.push({ at: finite(seg.tOffsetMs) && seg.tOffsetMs > 0 ? seg.tOffsetMs / 1000 : 0, text: seg.utf8.replace(CONTROL, '') });
    }
    const text = cleanCueText(words.map((w) => w.text).join('')).slice(0, maxChars);
    if (!text) continue;
    const cue: CcCue = { start: e.tStartMs / 1000, end: (e.tStartMs + e.dDurationMs) / 1000, text };
    if (opts.asr && words.some((w) => w.at > 0)) cue.words = words;
    cues.push(cue);
  }
  cues.sort((a, b) => a.start - b.start);
  if (opts.asr) {
    for (let i = 0; i < cues.length - 1; i++) {
      const c = cues[i]!;
      const next = cues[i + 1]!;
      if (next.start < c.end) c.end = Math.max(next.start, c.start + 0.05);
    }
  }
  return cues;
}

/** 这句在第 t 秒显示的文字：自动生成的字幕只显示已经说到的词 */
function visibleText(cue: CcCue, t: number): string {
  if (!cue.words) return cue.text;
  return cleanCueText(
    cue.words
      .filter((w) => cue.start + w.at <= t + 1e-3)
      .map((w) => w.text)
      .join(''),
  );
}

/**
 * 这种语言在第 t 秒该显示的文字（没有就是空串）。cues 必须按开始时间排好序。
 * 二分找到最后一句开始的，再往前看几句有没有还没结束的（重叠的对白、标牌）；
 * 两句之间的空档很短时留着上一句，免得字幕闪一下。
 */
export function textAt(cues: readonly CcCue[], t: number, o: { gapBridgeSec: number; lookbackCues: number; maxOverlapCues: number } = MULTI_CC): string {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= t) lo = mid + 1;
    else hi = mid;
  }
  const last = lo - 1;
  if (last < 0) return '';
  const active: CcCue[] = [];
  for (let i = last; i >= 0 && i > last - o.lookbackCues; i--) if (cues[i]!.end > t) active.push(cues[i]!);
  if (!active.length) {
    const prev = cues[last]!;
    const next = cues[last + 1];
    if (next && next.start - prev.end < o.gapBridgeSec) active.push(prev);
  }
  return active
    .slice(0, o.maxOverlapCues)
    .reverse()
    .map((c) => visibleText(c, t))
    .filter(Boolean)
    .join('\n');
}

// ── 一种语言一行 ──

/** 中日韩全角标点结尾：后面直接接下一行，不加空格 */
const FULLWIDTH_END = /[，。！？、；：…」』》〉】）〕]$/;

/**
 * 一种语言尽量只占一行：把一句字幕里作者手动断开的几行（YouTube 字幕常把一句歌词拆成两行）以及同时显示的几句接成一行。
 * 中日韩全角标点之后直接接，其余用一个空格隔开。
 */
export function joinCueLines(text: string): string {
  let out = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    out = !out ? line : FULLWIDTH_END.test(out) ? out + line : `${out} ${line}`;
  }
  return out;
}

/**
 * 一行放不下时怎么办：先等比缩小字号（最多缩到 minScale），还放不下才允许折行（此时就用 minScale）。
 * naturalPx：按原字号、不折行时的宽度；availPx：可用宽度。字号、内边距、"机翻"标记都按 em 算，宽度随字号等比变化。
 */
export function fitLine(naturalPx: number, availPx: number, minScale: number = MULTI_CC.fitMinScale): { scale: number; wrap: boolean } {
  if (!(naturalPx > 0) || !(availPx > 0) || naturalPx <= availPx) return { scale: 1, wrap: false };
  const scale = Math.floor((availPx / naturalPx) * 1000) / 1000;
  return scale >= minScale ? { scale, wrap: false } : { scale: minScale, wrap: true };
}

/** 每行的颜色：第一行白色，其后浅黄、浅蓝、浅紫（片段录制烧录字幕时用同样的颜色） */
export const MULTICC_LINE_COLORS = ['#ffffff', '#ffe7a3', '#bfe4ff', '#ddd0ff'] as const;

// ── 状态（内容脚本 → 侧边栏）──

export type MultiCcPhase = 'off' | 'waiting' | 'loading' | 'showing' | 'yielded' | 'no-tracks' | 'error';

export interface MultiCcLine {
  key: string;
  label: string;
  autoTranslated: boolean;
  /** 读到的句数；还在读时没有 */
  cues?: number;
  error?: string;
}

export interface MultiCcTabState {
  videoId: string | null;
  enabled: boolean;
  active: boolean;
  manual?: 'on' | 'off';
  phase: MultiCcPhase;
  status: string;
  options: CcOption[];
  lines: MultiCcLine[];
  /** 这个视频用的语言列表（从上到下）：比勾选项多出和别的行重复而没显示的语言 */
  langs: string[];
  /** 这个视频用的是你在侧边栏单独选的语言或顺序 */
  overridden: boolean;
  /** TubeMuse 暂时关掉了 YouTube 原生字幕（关闭多语字幕时恢复） */
  nativeHidden: boolean;
  error?: { message: string; hint?: string };
}
