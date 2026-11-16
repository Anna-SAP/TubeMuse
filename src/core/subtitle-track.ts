// "保存完整双语视频"里的原声字幕（用户 2026-11-16 要求，见 DECISIONS §84）的纯逻辑：
// 字幕从三处来——你选的字幕文件（.srt / .vtt）、原视频文件里嵌着的字幕轨、YouTube 上这个视频自带的字幕
// （由多语字幕脚本取，见 content/multi-captions.ts）——都先变成一串"几秒到几秒显示什么"，
// 再排成 MP4 字幕轨（3GPP Timed Text，tx3g：视频文件里一条可以开关的字幕轨）要的一个个样本。
// 这里只有解析与排版；读文件、取字幕、写 MP4 在别处。

import { cleanCueText, langMatchKey, originalLangOf, type CcTrack, type CcTrackList } from './multi-captions';

/** 一句字幕：视频的 start 秒到 end 秒显示 text（可以有换行） */
export interface SubCue {
  start: number;
  end: number;
  text: string;
}

export class SubtitleFileError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'SubtitleFileError';
    if (hint) this.hint = hint;
  }
}

// ── 字幕文件：SRT / WebVTT ──

const TIME = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const TIMING = new RegExp(`^\\s*(${TIME.source})\\s*-->\\s*(${TIME.source})`);

function seconds(t: string): number {
  const m = TIME.exec(t);
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] ?? '0').padEnd(3, '0')) / 1000;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: "'", lrm: '', rlm: '' };

/** 去掉标记：WebVTT 的 <c>、<i>、<00:00:01.000>，SRT 里的 <font>、{\an8}；还原 &amp; 之类 */
function plain(line: string): string {
  return line
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, name: string) => {
      const n = name.toLowerCase();
      if (n.startsWith('#x')) return String.fromCodePoint(parseInt(n.slice(2), 16) || 0x20);
      if (n.startsWith('#')) return String.fromCodePoint(Number(n.slice(1)) || 0x20);
      return ENTITIES[n] ?? all;
    });
}

/**
 * 解析 .srt / .vtt（按内容认，不看扩展名）：每一块"时间行 + 文字"是一句。
 * 去掉样式标记、序号、WebVTT 的 NOTE / STYLE / REGION 块；空的句子丢掉。认不出一句时间行时抛 SubtitleFileError
 */
export function parseSubtitleFile(text: string): SubCue[] {
  const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (/^\s*\{/.test(body) || /^\s*<\?xml|^\s*<tt[\s>]/i.test(body)) {
    throw new SubtitleFileError('这个字幕文件不是 .srt 或 .vtt 格式', '要 SubRip（.srt）或 WebVTT（.vtt）；别的格式先转一下，例如 ffmpeg -i 字幕文件 字幕.srt');
  }
  const cues: SubCue[] = [];
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length) {
    const m = TIMING.exec(lines[i]!);
    if (!m) {
      // WebVTT 的说明块：跳到下一个空行
      if (/^(NOTE|STYLE|REGION)\b/.test(lines[i]!)) while (i < lines.length && lines[i]!.trim()) i++;
      i++;
      continue;
    }
    const start = seconds(m[1]!);
    const end = seconds(m[6]!);
    i++;
    const textLines: string[] = [];
    // 一句到空行为止。只有空格的行不算空行：YouTube 自动字幕导出的 .vtt 里，每句的第一行常常就是一个空格
    while (i < lines.length && lines[i] !== '' && !TIMING.test(lines[i]!)) textLines.push(plain(lines[i++]!));
    // 下一块的序号（SRT）被当成了这一句的最后一行：后面紧跟时间行的纯数字不算
    if (i < lines.length && TIMING.test(lines[i]!) && /^\d+$/.test(textLines[textLines.length - 1]?.trim() ?? '')) textLines.pop();
    const t = cleanCueText(textLines.join('\n'));
    if (t && Number.isFinite(start) && Number.isFinite(end) && end > start) cues.push({ start, end, text: t });
  }
  if (!cues.length) throw new SubtitleFileError('这个字幕文件里一句字幕都没读到', '要 SubRip（.srt）或 WebVTT（.vtt）格式、里面有"00:00:01,000 --> 00:00:03,000"这样的时间行。');
  return cues;
}

// ── 整理 ──

/** 短到这个程度（秒）的句子是滚动字幕两句之间的过渡，不算一句 */
const BLIP_SEC = 0.05;
/** 离上一句结束不到这么多秒才算"紧挨着"（滚动字幕的重复只发生在紧挨着的两句之间） */
const ROLL_GAP_SEC = 0.5;

/**
 * 整理成能写进字幕轨的样子：按时间排好；去掉滚动字幕的重复——YouTube 自动字幕导出的 .vtt 每一句都带着上一句当第一行，
 * 中间还夹着一闪而过的过渡句；一句的开头几行和上一句的末尾几行相同时去掉这几行。
 * 两句时间重叠时前一句让到后一句开始为止（一次只显示一句）；超出全片的截掉。
 */
export function tidyCues(cues: readonly SubCue[], durationSec?: number): SubCue[] {
  const sorted = cues
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.text.trim())
    .map((c) => ({ start: Math.max(0, c.start), end: c.end, text: cleanCueText(c.text) }))
    .filter((c) => c.text)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: SubCue[] = [];
  let shown: string[] = [];
  for (const c of sorted) {
    const mine = c.text.split('\n');
    const last = out[out.length - 1];
    // 只有紧挨着上一句的才可能是滚动字幕的重复；隔了一会儿又说同一句话的，是真的又说了一遍
    const near = !!last && c.start - last.end < ROLL_GAP_SEC;
    // 开头和上一句显示过的末尾重复的行
    let dup = 0;
    for (let k = near ? Math.min(mine.length, shown.length) : 0; k > 0; k--) {
      if (shown.slice(shown.length - k).every((l, j) => l === mine[j])) {
        dup = k;
        break;
      }
    }
    const fresh = mine.slice(dup);
    if (!fresh.length) {
      // 整句都是上一句已经有的（过渡句，或同一句紧接着又来一遍）：把上一句延长到这里，不另起一句
      if (last && c.end > last.end) last.end = c.end;
      continue;
    }
    if (c.end - c.start < BLIP_SEC) continue;
    shown = mine;
    out.push({ start: c.start, end: c.end, text: fresh.join('\n') });
  }
  for (let k = 0; k < out.length - 1; k++) if (out[k]!.end > out[k + 1]!.start) out[k]!.end = out[k + 1]!.start;
  const limit = durationSec !== undefined && durationSec > 0 ? durationSec : Infinity;
  return out.map((c) => ({ start: c.start, end: Math.min(c.end, limit), text: c.text })).filter((c) => c.end - c.start >= BLIP_SEC);
}

// ── MP4 字幕轨的样本 ──

/** 字幕轨的时间单位：毫秒 */
export const SUB_TIMESCALE = 1000;

export interface SubSample {
  /** 这个样本显示多久（毫秒） */
  duration: number;
  /** 空串 = 这段时间不显示字幕 */
  text: string;
}

/**
 * 把一句句字幕排成首尾相接、铺满全片的样本：句子之间的空档是一个空样本（MP4 的字幕轨不能留洞）。
 * cues 要先经过 tidyCues（排好序、不重叠）
 */
export function subtitleSamples(cues: readonly SubCue[], durationSec: number): SubSample[] {
  const total = Math.max(0, Math.round(durationSec * SUB_TIMESCALE));
  const out: SubSample[] = [];
  let at = 0;
  for (const c of cues) {
    const start = Math.min(total, Math.max(at, Math.round(c.start * SUB_TIMESCALE)));
    const end = Math.min(total, Math.round(c.end * SUB_TIMESCALE));
    if (end <= start) continue;
    if (start > at) out.push({ duration: start - at, text: '' });
    out.push({ duration: end - start, text: c.text });
    at = end;
  }
  if (total > at) out.push({ duration: total - at, text: '' });
  return out;
}

/** 一个 tx3g 样本的字节：2 字节长度 + UTF-8 文字 */
export function encodeTextSample(text: string): Uint8Array<ArrayBuffer> {
  const utf8 = new TextEncoder().encode(text).subarray(0, 0xffff);
  const out = new Uint8Array(2 + utf8.length);
  out[0] = utf8.length >>> 8;
  out[1] = utf8.length & 0xff;
  out.set(utf8, 2);
  return out;
}

/** 读一个 tx3g 样本里的文字（后面跟着的样式盒子不要）；UTF-16 的（带 BOM）也认 */
export function decodeTextSample(bytes: Uint8Array): string {
  if (bytes.length < 2) return '';
  const n = Math.min(bytes.length - 2, (bytes[0]! << 8) | bytes[1]!);
  const body = bytes.subarray(2, 2 + n);
  if (n >= 2 && ((body[0] === 0xfe && body[1] === 0xff) || (body[0] === 0xff && body[1] === 0xfe))) return new TextDecoder(body[0] === 0xfe ? 'utf-16be' : 'utf-16le').decode(body.subarray(2));
  return new TextDecoder().decode(body);
}

/** 从样本还原成一句句字幕（读原视频文件里嵌着的字幕轨时用）：空样本是空档 */
export function cuesFromSamples(samples: readonly { start: number; end: number; text: string }[]): SubCue[] {
  return samples.filter((s) => s.text.trim() && s.end > s.start).map((s) => ({ start: s.start, end: s.end, text: cleanCueText(s.text) }));
}

// ── 另存成 .srt ──

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: readonly SubCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

// ── 语言 ──

/** MP4 里的语言是三个小写字母（ISO 639-2）：常见的几种从两个字母的代码换过来，别的写 und（未指明） */
const ISO3: Record<string, string> = {
  en: 'eng', zh: 'zho', ja: 'jpn', ko: 'kor', fr: 'fra', de: 'deu', es: 'spa', pt: 'por', it: 'ita', ru: 'rus', ar: 'ara', hi: 'hin',
  id: 'ind', vi: 'vie', th: 'tha', tr: 'tur', nl: 'nld', pl: 'pol', sv: 'swe', uk: 'ukr', he: 'heb', el: 'ell', cs: 'ces', da: 'dan', fi: 'fin', no: 'nor', hu: 'hun', ro: 'ron', ms: 'msa',
};

export function mp4Language(code: string | undefined): string {
  if (!code) return 'und';
  const c = code.toLowerCase();
  if (/^[a-z]{3}$/.test(c)) return c;
  return ISO3[langMatchKey(c).split('-')[0]!] ?? 'und';
}

// ── YouTube 上取哪一条字幕 ──

/**
 * 这个视频的"原声字幕"是哪一条轨：和原声同一种语言的字幕——作者上传的优先，没有就用 YouTube 自动生成的。
 * 原声是什么语言：有自动生成的字幕时就是它的语言（YouTube 按说话声音识别的），否则用官方数据里的音频语言；
 * 都不知道时，视频只有一种语言的字幕就用它，有英文的用英文（用户的视频多半是英文的）。别的情况返回 undefined，不乱猜
 */
export function pickOriginalTrack(list: CcTrackList, videoLang?: string): CcTrack | undefined {
  const tracks = list.tracks;
  const best = (lang: string) => {
    const same = tracks.filter((t) => langMatchKey(t.lang) === langMatchKey(lang));
    // 作者上传的（不带别名的优先）> 自动生成的
    return same.find((t) => t.kind === '' && !t.name) ?? same.find((t) => t.kind === '') ?? same[0];
  };
  const original = originalLangOf(list, videoLang);
  if (original) return best(original);
  const langs = new Set(tracks.map((t) => langMatchKey(t.lang)));
  if (langs.size === 1) return best(tracks[0]!.lang);
  return langs.has('en') ? best('en') : undefined;
}

/** 多语字幕脚本对"取这个视频的原声字幕"的回复 */
export type ExportCaptionReply =
  | { videoId: string; ok: true; lang: string; label: string; auto: boolean; cues: SubCue[] }
  | { videoId: string; ok: false; problem: string };

/** 字幕是从哪来的（界面上写明） */
export type SubSource = 'file' | 'embedded' | 'youtube';

export const SUB_SOURCE_LABELS: Record<SubSource, string> = { file: '你选的字幕文件', embedded: '原视频文件里嵌着的字幕', youtube: '取自 YouTube 上这个视频的字幕' };
