// 自动字幕的纯逻辑：人声切段（VAD）、WAV 编码、原生字幕状态判定、翻译目标语言、字幕显示时机、回看去重、花费记账。
// 内容脚本（采音频、画字幕）与后台（转写、翻译、记账）都只调用这里，单测直接覆盖。

import {
  ASR_PRICES_PER_MINUTE,
  ASR_UNKNOWN_PRICE_PER_MINUTE,
  LLM_PRICES_PER_MTOK,
  LLM_UNKNOWN_PRICE_PER_MTOK,
  SUBTITLES,
  type SubtitleLang,
} from '../config/defaults';
import { dominantScript } from './text';
import type { SubtitleCue, SubtitleIndex, SubtitleTrack } from './types';

// ── 内容脚本 ↔ 后台 ──

/** 长连接名 */
export const SUBTITLE_PORT = 'tubemuse:subtitles';

/** 内容脚本 → 后台 */
export type SubtitleUp =
  | { type: 'hello'; videoId: string }
  | { type: 'segment'; videoId: string; seq: number; start: number; end: number; audio: string };

/** 后台 → 内容脚本 */
export type SubtitleDown =
  | { type: 'track'; videoId: string; cues: SubtitleCue[] }
  | { type: 'cue'; videoId: string; seq: number; cue: SubtitleCue; stage: 'source' | 'translated' }
  | { type: 'error'; videoId: string; seq?: number; message: string; hint?: string; fatal: boolean; retryAfterMs?: number }
  /** 这一段处理完了（无论成败、是否已有字幕） */
  | { type: 'done'; videoId: string; seq: number };

/** 被限流后等多久：服务方说了就照办；没说就从 backoffBaseMs 起每次翻倍，最多 backoffMaxMs */
export function backoffMs(failures: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  return Math.min(SUBTITLES.backoffMaxMs, SUBTITLES.backoffBaseMs * 2 ** Math.max(0, failures - 1));
}

/** 内容脚本报给侧边栏的状态 */
export interface SubtitleTabState {
  videoId: string | null;
  captions: NativeCaptions;
  /** 正在为这个视频采音频、出字幕 */
  active: boolean;
  /** 你在侧边栏或快捷键对这个视频的选择（覆盖"自动开启"） */
  manual?: 'on' | 'off';
  /** 一句话说明现在的状态 */
  status: string;
  cues: number;
  pending: number;
  error?: { message: string; hint?: string };
}

// ── 人声切段 ──

export interface SegmenterOptions {
  sampleRate: number;
  frameSec: number;
  minSpeechRms: number;
  noiseFactor: number;
  prerollSec: number;
  pauseSec: number;
  minSegmentSec: number;
  longPauseSec: number;
  maxSegmentSec: number;
  minSpeechSec: number;
  seekToleranceSec: number;
}

export const DEFAULT_SEGMENTER: SegmenterOptions = {
  sampleRate: SUBTITLES.sampleRate,
  frameSec: SUBTITLES.frameSec,
  minSpeechRms: SUBTITLES.minSpeechRms,
  noiseFactor: SUBTITLES.noiseFactor,
  prerollSec: SUBTITLES.prerollSec,
  pauseSec: SUBTITLES.pauseSec,
  minSegmentSec: SUBTITLES.minSegmentSec,
  longPauseSec: SUBTITLES.longPauseSec,
  maxSegmentSec: SUBTITLES.maxSegmentSec,
  minSpeechSec: SUBTITLES.minSpeechSec,
  seekToleranceSec: SUBTITLES.seekToleranceSec,
};

/** 采集回调送来的一块音频，以及送来时的视频进度与倍速 */
export interface AudioChunk {
  samples: Float32Array;
  /** 这块音频最后一个样本对应的视频时间（秒） */
  videoTime: number;
  /** 播放倍速：1 秒音频对应 rate 秒视频 */
  rate: number;
}

/** 一段待识别的音频；start/end 是视频时间（秒） */
export interface AudioSegment {
  start: number;
  end: number;
  samples: Float32Array;
  speechSec: number;
}

interface Frame {
  samples: Float32Array;
  rms: number;
  start: number;
  end: number;
  speech: boolean;
}

function rmsOf(s: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i]! * s[i]!;
  return Math.sqrt(sum / Math.max(1, s.length));
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * 按停顿把连续音频切成一句一句：说完一句（停顿 ≥ pauseSec）就交出去；太短的等下一句合并；
 * 一直不停顿时到 maxSegmentSec 在最安静的地方切开；人声太少的片段（咳嗽、杂音）直接丢弃，不花钱。
 * 播放进度跳变（拖动、跳转）时先交出已有的部分，再从新位置重新开始。
 */
export class Segmenter {
  private pending = new Float32Array(0);
  private frames: Frame[] = [];
  private preroll: Frame[] = [];
  private noise = 0;
  private lastEnd: number | undefined;
  private silenceSec = 0;
  private speechSec = 0;

  constructor(private readonly o: SegmenterOptions = DEFAULT_SEGMENTER) {}

  push(chunk: AudioChunk): AudioSegment[] {
    const o = this.o;
    const out: AudioSegment[] = [];
    const frameLen = Math.max(1, Math.round(o.frameSec * o.sampleRate));
    const all = this.pending.length ? concat([this.pending, chunk.samples]) : chunk.samples;
    const n = Math.floor(all.length / frameLen);
    for (let i = 0; i < n; i++) {
      const samples = all.slice(i * frameLen, (i + 1) * frameLen);
      const end = chunk.videoTime - ((all.length - (i + 1) * frameLen) / o.sampleRate) * chunk.rate;
      const start = end - o.frameSec * chunk.rate;
      if (this.lastEnd !== undefined && Math.abs(start - this.lastEnd) > o.seekToleranceSec) out.push(...this.flush());
      this.lastEnd = end;
      const rms = rmsOf(samples);
      const speech = rms >= Math.max(o.minSpeechRms, this.noise * o.noiseFactor);
      if (!speech) this.noise = this.noise === 0 ? rms : this.noise * 0.95 + rms * 0.05;
      out.push(...this.step({ samples, rms, start, end, speech }));
    }
    this.pending = all.slice(n * frameLen);
    return out;
  }

  /** 交出手里还没说完的一句（暂停、跳转、广告、换视频时调用），并清空状态 */
  flush(): AudioSegment[] {
    const seg = this.frames.length ? this.emit() : [];
    this.frames = [];
    this.preroll = [];
    this.pending = new Float32Array(0);
    this.lastEnd = undefined;
    this.silenceSec = 0;
    this.speechSec = 0;
    return seg;
  }

  private step(f: Frame): AudioSegment[] {
    const o = this.o;
    if (!this.frames.length) {
      if (!f.speech) {
        this.preroll.push(f);
        const keep = Math.round(o.prerollSec / o.frameSec);
        if (this.preroll.length > keep) this.preroll.splice(0, this.preroll.length - keep);
        return [];
      }
      this.frames = [...this.preroll, f];
      this.preroll = [];
      this.speechSec = o.frameSec;
      this.silenceSec = 0;
      return [];
    }
    this.frames.push(f);
    if (f.speech) {
      this.speechSec += o.frameSec;
      this.silenceSec = 0;
    } else {
      this.silenceSec += o.frameSec;
    }
    const dur = this.frames.length * o.frameSec;
    if (this.silenceSec >= o.pauseSec - 1e-9) {
      if (dur - this.silenceSec >= o.minSegmentSec || this.silenceSec >= o.longPauseSec - 1e-9) return this.emit();
      return [];
    }
    if (dur >= o.maxSegmentSec - 1e-9) return this.splitAtQuietest();
    return [];
  }

  /** 交出当前这句：去掉末尾多余的静音（保留一小段），静音部分留作下一句的前导 */
  private emit(): AudioSegment[] {
    const o = this.o;
    const keepTail = Math.round(o.prerollSec / o.frameSec);
    const trailing = Math.round(this.silenceSec / o.frameSec);
    const cut = this.frames.length - Math.max(0, trailing - keepTail);
    const used = this.frames.slice(0, cut);
    const rest = this.frames.slice(cut);
    const speechSec = this.speechSec;
    this.frames = [];
    this.preroll = rest.slice(-keepTail);
    this.silenceSec = 0;
    this.speechSec = 0;
    return speechSec >= o.minSpeechSec - 1e-9 && used.length ? [toSegment(used, speechSec)] : [];
  }

  /** 一直没有停顿：在后 60% 里能量最低的一帧切开，前半句交出去，后半句继续 */
  private splitAtQuietest(): AudioSegment[] {
    const o = this.o;
    const from = Math.floor(this.frames.length * 0.4);
    let at = this.frames.length - 1;
    for (let i = from; i < this.frames.length; i++) if (this.frames[i]!.rms < this.frames[at]!.rms) at = i;
    const head = this.frames.slice(0, at + 1);
    const tail = this.frames.slice(at + 1);
    const headSpeech = head.filter((f) => f.speech).length * o.frameSec;
    this.frames = tail;
    this.speechSec = tail.filter((f) => f.speech).length * o.frameSec;
    let silent = 0;
    for (let i = tail.length - 1; i >= 0 && !tail[i]!.speech; i--) silent++;
    this.silenceSec = silent * o.frameSec;
    return headSpeech >= o.minSpeechSec - 1e-9 ? [toSegment(head, headSpeech)] : [];
  }
}

function toSegment(frames: Frame[], speechSec: number): AudioSegment {
  return { start: Math.max(0, frames[0]!.start), end: frames[frames.length - 1]!.end, samples: concat(frames.map((f) => f.samples)), speechSec };
}

// ── WAV ──

/** 16-bit PCM 单声道 WAV */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** 校验并读出 WAV 的时长（只接受本扩展自己编码的格式：16-bit PCM 单声道） */
export function wavInfo(bytes: Uint8Array): { sampleRate: number; durationSec: number } | undefined {
  if (bytes.length < 44) return undefined;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data') return undefined;
  if (v.getUint16(20, true) !== 1 || v.getUint16(22, true) !== 1 || v.getUint16(34, true) !== 16) return undefined;
  const sampleRate = v.getUint32(24, true);
  const dataLen = v.getUint32(40, true);
  if (!sampleRate || dataLen !== bytes.length - 44) return undefined;
  return { sampleRate, durationSec: dataLen / 2 / sampleRate };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── 原生字幕 ──

export type NativeCaptions = 'available' | 'unavailable' | 'unknown';

export interface CaptionButtonAttrs {
  /** data-tooltip-title */
  tooltip?: string | null;
  /** data-title-no-tooltip */
  title?: string | null;
  /** aria-pressed */
  pressed?: string | null;
}

/**
 * 从播放器字幕按钮判断这个视频有没有原生字幕，与界面语言无关（2026-11 实测）：
 * 有字幕时提示文字是"按钮名 + 快捷键"，例如 "Subtitles/closed captions (c)"；
 * 没有字幕时提示文字与按钮名完全相同，例如两者都是 "Subtitles/closed captions unavailable"。
 * 正在显示字幕（aria-pressed=true）一定是有。判断不了就是 unknown——不会自动开启。
 */
export function nativeCaptionsState(attrs: CaptionButtonAttrs | null): NativeCaptions {
  if (!attrs) return 'unknown';
  if (attrs.pressed === 'true') return 'available';
  const tooltip = attrs.tooltip?.trim();
  const title = attrs.title?.trim();
  if (!tooltip || !title) return 'unknown';
  if (tooltip !== title && tooltip.startsWith(title) && /\(\S{1,12}\)$/.test(tooltip)) return 'available';
  if (tooltip === title) return 'unavailable';
  return 'unknown';
}

// ── 翻译目标 ──

/** 语言代码 → 语种（zh-TW、cmn、yue 都算中文） */
export function langFamily(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const base = code.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  if (!base) return undefined;
  if (['zh', 'cmn', 'yue', 'zho', 'chi', 'wuu', 'nan', 'hak'].includes(base)) return 'zh';
  if (base === 'jpn') return 'ja';
  if (base === 'kor') return 'ko';
  if (base === 'eng') return 'en';
  return base;
}

function scriptFamily(text: string): string | undefined {
  switch (dominantScript(text)) {
    case 'han':
      return 'zh';
    case 'kana':
      return 'ja';
    case 'hangul':
      return 'ko';
    default:
      return undefined;
  }
}

/** 第二行译成什么：原文与目标语言同一语种时改用备选语言；两者都相同就不翻译（返回 undefined） */
export function translationTarget(sourceLang: string | undefined, text: string, target: SubtitleLang, alt: SubtitleLang): SubtitleLang | undefined {
  const fam = langFamily(sourceLang) ?? scriptFamily(text);
  if (fam !== langFamily(target)) return target;
  if (fam !== langFamily(alt)) return alt;
  return undefined;
}

// ── 显示时机 ──

/** 第一次观看时字幕比语音晚：记下最新一句是在视频播到哪里时送到的 */
export interface LiveCue {
  id: string;
  /** 送到时的视频时间（秒） */
  arrivedAt: number;
}

export interface CueView {
  cue: SubtitleCue;
  /** 晚于语音显示（第一次观看时的即时字幕） */
  late: boolean;
}

/**
 * 当前该显示哪句：先按时间轴找正好覆盖当前时刻的（回看、拖回去时精确对齐）；
 * 找不到时显示刚送到的那句（第一次观看时比语音晚几秒，至少显示 liveMinShowSec）。
 */
export function pickCue(cues: readonly SubtitleCue[], t: number, live: LiveCue | undefined, o: { lingerSec: number; liveMinShowSec: number; liveMaxLagSec: number } = SUBTITLES): CueView | undefined {
  let best: SubtitleCue | undefined;
  for (const c of cues) {
    if (c.start > t + 0.05) break;
    if (c.text && t < c.end + o.lingerSec) best = c;
  }
  if (best) return { cue: best, late: false };
  if (!live) return undefined;
  const c = cues.find((x) => x.id === live.id);
  if (!c?.text) return undefined;
  const since = t - live.arrivedAt;
  if (since < -0.5 || since >= Math.max(o.liveMinShowSec, c.end - c.start)) return undefined;
  if (t - c.end > o.liveMaxLagSec) return undefined;
  return { cue: c, late: true };
}

/** 这段音频是否已经有字幕（回看时不再识别、不再花钱） */
export function isCovered(cues: readonly SubtitleCue[], start: number, end: number, ratio: number = SUBTITLES.coveredRatio): boolean {
  const len = end - start;
  if (len <= 0) return true;
  let overlap = 0;
  for (const c of cues) {
    const a = Math.max(start, c.start);
    const b = Math.min(end, c.end);
    if (b > a) overlap += b - a;
  }
  return overlap / len >= ratio;
}

/** 按 id 更新或按开始时间插入 */
export function upsertCue(cues: readonly SubtitleCue[], cue: SubtitleCue): SubtitleCue[] {
  const rest = cues.filter((c) => c.id !== cue.id);
  const at = rest.findIndex((c) => c.start > cue.start);
  return at < 0 ? [...rest, cue] : [...rest.slice(0, at), cue, ...rest.slice(at)];
}

export function putCue(track: SubtitleTrack | null, videoId: string, cue: SubtitleCue, asrModel: string, now: number): SubtitleTrack {
  const prev: SubtitleTrack = track ?? { videoId, cues: [], asrModel, updatedAt: now };
  return { ...prev, asrModel, cues: upsertCue(prev.cues, cue), updatedAt: now };
}

/** 超过上限时要删掉哪些视频的字幕（最久没更新的） */
export function tracksToDrop(index: SubtitleIndex, maxVideos: number = SUBTITLES.maxVideosKept): string[] {
  return Object.entries(index)
    .sort((a, b) => b[1] - a[1])
    .slice(maxVideos)
    .map(([id]) => id);
}

// ── 花费 ──

export interface SubtitleDay {
  spentUsd: number;
  asrSeconds: number;
  asrUsd: number;
  translations: number;
  inputTokens: number;
  outputTokens: number;
  translateUsd: number;
  /** 有估算单价（模型不在价目表里）参与时为 true：界面注明"按保守单价估算" */
  estimatedPrice?: boolean;
}

export interface SubtitleLedger {
  days: Record<string, SubtitleDay>;
}

export interface SubtitleSnapshot {
  day: string;
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  ratio: number;
  warn: boolean;
  exhausted: boolean;
  resetAt: number;
  asrSeconds: number;
  translations: number;
  estimatedPrice: boolean;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function asrPrice(model: string): { perMinute: number; known: boolean } {
  const p = ASR_PRICES_PER_MINUTE[model.trim()];
  return p === undefined ? { perMinute: ASR_UNKNOWN_PRICE_PER_MINUTE, known: false } : { perMinute: p, known: true };
}

export function llmPrice(model: string): { input: number; output: number; known: boolean } {
  const p = LLM_PRICES_PER_MTOK[model.trim()];
  return p ? { ...p, known: true } : { ...LLM_UNKNOWN_PRICE_PER_MTOK, known: false };
}

export function asrCostUsd(model: string, seconds: number): number {
  return round6((Math.max(0, seconds) / 60) * asrPrice(model).perMinute);
}

export function translationCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = llmPrice(model);
  return round6((inputTokens * p.input + outputTokens * p.output) / 1e6);
}

/** 一段音频最坏要花多少：转写 + （要翻译时）一次翻译的预估 */
export function estimateSegmentUsd(asrModel: string, seconds: number, translationModel: string | undefined): number {
  const e = SUBTITLES.translationEstimate;
  return round6(asrCostUsd(asrModel, seconds) + (translationModel ? translationCostUsd(translationModel, e.inputTokens, e.outputTokens) : 0));
}

function emptyDay(): SubtitleDay {
  return { spentUsd: 0, asrSeconds: 0, asrUsd: 0, translations: 0, inputTokens: 0, outputTokens: 0, translateUsd: 0 };
}

export function subtitleSnapshot(ledger: SubtitleLedger, budgetUsd: number, warnRatio: number, day: string, resetAt: number, reservedUsd = 0): SubtitleSnapshot {
  const d = ledger.days[day] ?? emptyDay();
  const spent = round6(d.spentUsd);
  const remaining = Math.max(0, round6(budgetUsd - spent - reservedUsd));
  const ratio = budgetUsd > 0 ? Math.min(1, spent / budgetUsd) : 1;
  return {
    day,
    spentUsd: spent,
    budgetUsd,
    remainingUsd: remaining,
    ratio,
    warn: ratio >= warnRatio,
    exhausted: remaining <= 0,
    resetAt,
    asrSeconds: Math.round(d.asrSeconds),
    translations: d.translations,
    estimatedPrice: !!d.estimatedPrice,
  };
}

function withDay(ledger: SubtitleLedger, day: string, fn: (d: SubtitleDay) => SubtitleDay): SubtitleLedger {
  const days = { ...ledger.days, [day]: fn({ ...(ledger.days[day] ?? emptyDay()) }) };
  const keep = Object.keys(days).sort().slice(-7);
  return { days: Object.fromEntries(keep.map((k) => [k, days[k]!])) };
}

export function recordAsr(ledger: SubtitleLedger, day: string, model: string, seconds: number): SubtitleLedger {
  const usd = asrCostUsd(model, seconds);
  return withDay(ledger, day, (d) => ({
    ...d,
    asrSeconds: round6(d.asrSeconds + seconds),
    asrUsd: round6(d.asrUsd + usd),
    spentUsd: round6(d.spentUsd + usd),
    ...(asrPrice(model).known ? {} : { estimatedPrice: true }),
  }));
}

export function recordTranslation(ledger: SubtitleLedger, day: string, model: string, inputTokens: number, outputTokens: number): SubtitleLedger {
  const usd = translationCostUsd(model, inputTokens, outputTokens);
  return withDay(ledger, day, (d) => ({
    ...d,
    translations: d.translations + 1,
    inputTokens: d.inputTokens + inputTokens,
    outputTokens: d.outputTokens + outputTokens,
    translateUsd: round6(d.translateUsd + usd),
    spentUsd: round6(d.spentUsd + usd),
    ...(llmPrice(model).known ? {} : { estimatedPrice: true }),
  }));
}

/** 一小时连续说话的视频大约花多少（设置页提示用）：按典型用量与平均句长估算 */
export function hourlyEstimateUsd(asrModel: string, translationModel: string | undefined): number {
  const e = SUBTITLES.translationTypical;
  const perCue = translationModel ? translationCostUsd(translationModel, e.inputTokens, e.outputTokens) : 0;
  return round6(asrCostUsd(asrModel, 3600) + perCue * (3600 / e.secondsPerCue));
}

/** 视频时间 → 字幕列表里显示的 m:ss / h:mm:ss */
export function formatCueTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 花费显示：不到 1 美分时多显示一位，免得一直是 $0.000 */
export function formatUsd(usd: number): string {
  return `$${usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;
}

/** 转写时长显示：不到 1 分钟显示秒 */
export function formatAudioDuration(seconds: number): string {
  return seconds < 60 ? `${Math.round(seconds)} 秒` : `${(seconds / 60).toFixed(1)} 分钟`;
}
