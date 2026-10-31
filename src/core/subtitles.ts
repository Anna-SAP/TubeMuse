// 自动字幕的纯逻辑：人声切段（VAD）、WAV 编码、原生字幕状态判定、翻译目标语言、字幕显示时机、回看去重、花费记账。
// 内容脚本（采音频、画字幕）与后台（转写、翻译、记账）都只调用这里，单测直接覆盖。

import {
  BROWSER_SPEECH_LANGS,
  ASR_PRICES_PER_MINUTE,
  ASR_UNKNOWN_PRICE_PER_MINUTE,
  LLM_PRICES_PER_MTOK,
  LLM_UNKNOWN_PRICE_PER_MTOK,
  SUBTITLES,
  type BrowserSpeechLang,
  type SubtitleAsrEngine,
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
  | { type: 'segment'; videoId: string; seq: number; start: number; end: number; audio: string }
  /** 浏览器识别出的一行（已定稿）：只送文字，不送音频 */
  | { type: 'text'; videoId: string; seq: number; start: number; end: number; text: string; lang?: string };

/** 后台 → 内容脚本 */
export type SubtitleDown =
  | { type: 'track'; videoId: string; cues: SubtitleCue[]; recognition?: RecognitionPlan }
  | { type: 'cue'; videoId: string; seq: number; cue: SubtitleCue; stage: 'source' | 'translated' }
  | { type: 'error'; videoId: string; seq?: number; message: string; hint?: string; fatal: boolean; retryAfterMs?: number }
  /** 这一段处理完了（无论成败、是否已有字幕） */
  | { type: 'done'; videoId: string; seq: number };

/** 被限流后等多久：服务方说了就照办；没说就从 backoffBaseMs 起每次翻倍，最多 backoffMaxMs */
export function backoffMs(failures: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  return Math.min(SUBTITLES.backoffMaxMs, SUBTITLES.backoffBaseMs * 2 ** Math.max(0, failures - 1));
}

/** 浏览器识别用哪种语言、为什么 */
export interface RecognitionPlan {
  lang: string;
  /** setting：设置里指定；video：视频的语言（YouTube 数据）；title：按标题文字推断；default：判断不了，用默认；manual：你在侧边栏给这个视频选的 */
  source: 'setting' | 'video' | 'title' | 'default' | 'manual';
  note?: string;
}

/** 声音交给谁识别（界面据此写明去向） */
export type RecognitionMode = 'local' | 'cloud' | 'openai';

export const RECOGNITION_MODE_LABELS: Record<RecognitionMode, string> = {
  local: '本地语音包（声音不离开电脑）',
  cloud: 'Chrome 云端识别（声音发往 Google）',
  openai: 'OpenAI 转写（声音发往 OpenAI）',
};

/** 内容脚本报给侧边栏的状态 */
export interface SubtitleTabState {
  videoId: string | null;
  captions: NativeCaptions;
  engine?: SubtitleAsrEngine;
  /** 浏览器识别：语言与去向（还没开始时为空） */
  recognition?: { lang: string; source: RecognitionPlan['source']; mode?: RecognitionMode; note?: string };
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
export function hourlyEstimateUsd(asrModel: string | undefined, translationModel: string | undefined): number {
  const e = SUBTITLES.translationTypical;
  const perCue = translationModel ? translationCostUsd(translationModel, e.inputTokens, e.outputTokens) : 0;
  return round6((asrModel ? asrCostUsd(asrModel, 3600) : 0) + perCue * (3600 / e.secondsPerCue));
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

// ── 浏览器识别 ──

export function isCjkText(text: string): boolean {
  const sc = dominantScript(text);
  return sc === 'han' || sc === 'kana' || sc === 'hangul';
}

/** 识别语言的显示名 */
export function speechLangName(lang: string): string {
  return (BROWSER_SPEECH_LANGS as Record<string, string>)[lang] ?? lang;
}

/** 语种 → 浏览器识别用的语言代码（中文按简体字识别） */
function recognitionCodeFor(code: string): string | undefined {
  const fam = langFamily(code);
  if (!fam) return undefined;
  if (fam === 'zh') return /yue|hk/i.test(code) ? 'yue-Hant-HK' : 'zh-CN';
  return ({ en: 'en-US', ja: 'ja-JP', ko: 'ko-KR' } as Record<string, string>)[fam] ?? code;
}

/**
 * 这个视频用哪种语言识别：设置里指定了就用它；自动时先看视频的语言（YouTube 数据），
 * 没有就按标题文字推断，再不行用简体中文并说明。
 */
export function recognitionLangFor(setting: BrowserSpeechLang, meta: { language?: string; title?: string } | undefined, note?: string): RecognitionPlan {
  if (setting !== 'auto') return { lang: setting, source: 'setting' };
  const byMeta = meta?.language ? recognitionCodeFor(meta.language) : undefined;
  if (byMeta) return { lang: byMeta, source: 'video' };
  const byTitle = meta?.title ? ({ han: 'zh-CN', kana: 'ja-JP', hangul: 'ko-KR' } as Record<string, string>)[dominantScript(meta.title)] : undefined;
  if (byTitle) return { lang: byTitle, source: 'title' };
  return { lang: 'zh-CN', source: 'default', note: note ?? '没能判断视频的语言，先按简体中文识别；不对的话在侧边栏"字幕"页换一种' };
}

/** 定稿的一行：视频时间（秒）与文字 */
export interface LiveLine {
  start: number;
  end: number;
  text: string;
}

export interface LiveOptions {
  stableMs: number;
  latencySec: number;
  lineChars: { cjk: number; latin: number };
  maxChars: { cjk: number; latin: number };
  idleCommitSec: number;
}

export const DEFAULT_LIVE: LiveOptions = {
  stableMs: SUBTITLES.liveStableMs,
  latencySec: SUBTITLES.liveLatencySec,
  lineChars: SUBTITLES.liveLineChars,
  maxChars: SUBTITLES.liveMaxChars,
  idleCommitSec: SUBTITLES.liveIdleCommitSec,
};

const CJK_BREAK_AFTER = new Set('了呢吗吧啊呀的嘛哦喔噢耶哈了，。！？、'.split(''));

/**
 * 把浏览器边听边改的识别结果整理成一行一行的字幕：
 * - 记下每个字第一次出现时的视频时间（减去识别延迟），作为它在视频里的时间；
 * - 一段文字 stableMs 内不再变化才算定稿；定稿的部分满一行（或停顿够久）就交出一行；
 * - 识别器给出 final 时把剩下的全部交出（太长再切）。
 * 浏览器的识别结果没有时间戳，所以时间是估算的（误差约 1 秒）。
 */
export class LiveTranscript {
  private text = '';
  /** 每个字估算的说出时刻（视频时间） */
  private appeared: number[] = [];
  /** 每个字送到时的视频时间（判断"停顿多久"用，不减识别延迟） */
  private arrived: number[] = [];
  /** 每个字最后一次变化的墙钟时间（判断"稳定多久"用） */
  private changedAt: number[] = [];
  private committed = 0;

  constructor(private readonly o: LiveOptions = DEFAULT_LIVE) {}

  /** 还没定稿的尾巴（屏幕上滚动显示用） */
  get tail(): string {
    return this.text.slice(this.committed).trim();
  }

  /**
   * 识别器送来当前这段的最新文字。videoTime 是收到时的视频进度，rate 是倍速，nowMs 是墙钟。
   * 返回这次定稿的行。
   */
  update(rawText: string, isFinal: boolean, videoTime: number, rate: number, nowMs: number): LiveLine[] {
    const text = rawText.replace(/\s+/g, ' ').replace(/^ /, '');
    let lcp = 0;
    while (lcp < text.length && lcp < this.text.length && text[lcp] === this.text[lcp]) lcp++;
    const spokenAt = Math.max(0, videoTime - this.o.latencySec * (rate || 1));
    this.appeared = [...this.appeared.slice(0, lcp), ...Array.from({ length: text.length - lcp }, () => spokenAt)];
    this.arrived = [...this.arrived.slice(0, lcp), ...Array.from({ length: text.length - lcp }, () => videoTime)];
    this.changedAt = [...this.changedAt.slice(0, lcp), ...Array.from({ length: text.length - lcp }, () => nowMs)];
    this.text = text;
    if (this.committed > text.length) this.committed = text.length; // 识别器把已定稿的部分改短了：以后的从这里接着算
    if (isFinal) {
      const out = this.cutAll(text.length, videoTime);
      this.reset();
      return out;
    }
    return this.commitStable(videoTime, nowMs);
  }

  /** 没有新结果时也定期检查：停顿够久的文字先交出（由内容脚本每轮调用） */
  poll(videoTime: number, nowMs: number): LiveLine[] {
    return this.commitStable(videoTime, nowMs);
  }

  /** 暂停、拖动、换视频、识别会话结束时：把还没交出的文字全部交出 */
  flush(videoTime: number): LiveLine[] {
    const out = this.cutAll(this.text.length, videoTime);
    this.reset();
    return out;
  }

  /** 丢掉还没交出的文字（例如拖动后，识别器手里的声音属于拖动前的位置） */
  reset(): void {
    this.text = '';
    this.appeared = [];
    this.arrived = [];
    this.changedAt = [];
    this.committed = 0;
  }

  private commitStable(videoTime: number, nowMs: number): LiveLine[] {
    const out: LiveLine[] = [];
    let stableEnd = this.committed;
    while (stableEnd < this.text.length && this.changedAt[stableEnd]! <= nowMs - this.o.stableMs) stableEnd++;
    const cjk = isCjkText(this.text);
    const line = cjk ? this.o.lineChars.cjk : this.o.lineChars.latin;
    while (stableEnd - this.committed >= line) {
      const cut = this.chooseCut(this.committed, this.committed + line, stableEnd, cjk);
      out.push(...this.emit(this.committed, cut, videoTime));
    }
    // 停顿够久：不满一行也先交出
    if (stableEnd > this.committed && stableEnd === this.text.length && videoTime - this.arrived[stableEnd - 1]! >= this.o.idleCommitSec) {
      out.push(...this.emit(this.committed, stableEnd, videoTime));
    }
    return out;
  }

  private cutAll(end: number, videoTime: number): LiveLine[] {
    const out: LiveLine[] = [];
    const cjk = isCjkText(this.text);
    const max = cjk ? this.o.maxChars.cjk : this.o.maxChars.latin;
    const line = cjk ? this.o.lineChars.cjk : this.o.lineChars.latin;
    while (end - this.committed > max) {
      const cut = this.chooseCut(this.committed, this.committed + line, end, cjk);
      out.push(...this.emit(this.committed, cut, videoTime));
    }
    if (end > this.committed) out.push(...this.emit(this.committed, end, videoTime));
    return out;
  }

  /** 在 ideal 附近找个好断点：英文等按空格，中文优先断在语气词后面 */
  private chooseCut(from: number, ideal: number, limit: number, cjk: boolean): number {
    const target = Math.min(ideal, limit);
    if (cjk) {
      for (let i = target; i > Math.max(from + 4, target - 4); i--) if (CJK_BREAK_AFTER.has(this.text[i - 1]!)) return i;
      return target;
    }
    const space = this.text.lastIndexOf(' ', target);
    return space > from + 8 ? space + 1 : target;
  }

  private emit(from: number, to: number, videoTime: number): LiveLine[] {
    this.committed = to;
    const text = this.text.slice(from, to).trim();
    if (!text) return [];
    const start = this.appeared[from] ?? videoTime;
    const last = this.appeared[to - 1] ?? start;
    return [{ start, end: Math.max(last + 0.4, start + 0.8), text }];
  }
}

/**
 * 浏览器识别时屏幕上显示什么：上一行是最近定稿的那行 + 还在识别的新字（只留最后一段，像滚动字幕），
 * 下一行是最近定稿那行的译文。
 */
export function liveView(
  cues: readonly SubtitleCue[],
  tail: string,
  t: number,
  o: { recentSec: number; tailChars: { cjk: number; latin: number } } = { recentSec: SUBTITLES.liveRecentSec, tailChars: SUBTITLES.liveTailChars },
): { source: string; translation: string } | undefined {
  let recent: SubtitleCue | undefined;
  for (const c of cues) if (c.text && c.start <= t + 1 && c.end >= t - o.recentSec && (!recent || c.start >= recent.start)) recent = c;
  const joined = [recent?.text ?? '', tail].filter(Boolean).join(isCjkText(tail || recent?.text || '') ? '' : ' ');
  if (!joined && !recent) return undefined;
  const cjk = isCjkText(joined);
  const max = cjk ? o.tailChars.cjk : o.tailChars.latin;
  let source = joined;
  if (source.length > max) {
    source = source.slice(source.length - max);
    if (!cjk) source = source.slice(source.indexOf(' ') + 1);
    source = '…' + source;
  }
  return { source, translation: recent?.translation ?? '' };
}

/** 浏览器识别出错时怎么说、要不要停下 */
export function speechErrorInfo(code: string, mode: 'local' | 'cloud', lang: string): { message: string; hint?: string; fatal: boolean; retryCloud?: boolean } | undefined {
  const switchHint = '可以在设置页「12. 自动字幕」把转写方式改成 OpenAI';
  switch (code) {
    case 'no-speech':
    case 'aborted':
      return undefined;
  }
  // 本地语音包（实验特性）出任何问题都改用云端，并说明
  if (mode === 'local') return { message: `本地语音包识别失败（${code}），改用 Chrome 云端识别（声音发往 Google）`, fatal: false, retryCloud: true };
  switch (code) {
    case 'network':
      return { message: '连不上 Chrome 的语音识别服务', hint: `这项服务只有 Google Chrome 能用（Comet 等浏览器不行），也需要能访问 Google；${switchHint}`, fatal: true };
    case 'language-not-supported':
      return { message: `浏览器的语音识别不支持「${speechLangName(lang)}」`, hint: '在侧边栏"字幕"页给这个视频换一种识别语言', fatal: true };
    case 'not-allowed':
    case 'service-not-allowed':
      return { message: '浏览器不允许在这个页面使用语音识别', hint: switchHint, fatal: true };
    case 'audio-capture':
      return { message: '读不到这个视频的声音', hint: '刷新页面再试', fatal: true };
    default:
      return { message: `语音识别出错（${code}），稍后自动重试`, fatal: false };
  }
}
