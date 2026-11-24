// 配音字幕（用户 2026-11-18 要求，见 DECISIONS §86）的纯逻辑：配音开着时，在视频画面底部显示配音此刻说到的那一句。
// 1. 字幕是配音的字幕：按配音实际放到的位置（配音那个 <audio> 的 currentTime）找这一句，不按视频时间——
//    手动对齐时中文会停下等画面、会在对齐点跳过去，快速对齐时中文是变速放的，视频时间和中文位置对不上。
// 2. 字幕的语言跟配音走：这个功能是"中文配音"，中英双语的字幕文件里只留中文那几行；小宇宙的字幕每句取它自己语言的那一行。
// 3. 字幕从三处来：你选的字幕文件（.srt / .vtt）；从这段配音音频识别（用户 2026-11-24 要求，见 DECISIONS §91：
//    core/dub-asr.ts、services/dub-asr-service.ts，发往 OpenAI 转写、花费记在"字幕 $"里）；或小宇宙里已经生成的那一集字幕。
//    三种来源存成同一种东西（一串 SubCue），之后的整理、存储、显示完全一样。这个文件里不转写、不翻译、不联网、不花钱。
// 画字幕层在 content/dub-subtitles.ts；配音的位置由配音脚本（content/dub.ts）经同一个隔离环境交过来。

import { DEFAULT_SETTINGS, DUB, DUB_SUB_FONTS, type DubSubFont } from '../config/defaults';
import type { DubReason, DubSubLang, DubSubsMeta } from './dub';
import { tidyCues, type SubCue } from './subtitle-track';
import { dominantScript } from './text';
import { cueFamily, doneSeconds, type XyzCue, type XyzTranscript } from './xyz';

// ── 配音此刻放到哪了（配音脚本 → 字幕脚本）──

const KEY = Symbol.for('tubemuse.dub.playback');

/** 配音此刻的样子：只在配音开着、已载入时有 */
export interface DubPlayback {
  videoId: string;
  /** 配音实际放到的位置（秒）：<audio> 的 currentTime */
  time: number;
  /** 配音在不在往前走（在出声） */
  running: boolean;
  /** 跟随状态（在放 / 暂停 / 中文停下等画面 / 广告…）；刚开启、还没检查过时为空 */
  reason?: DubReason;
  /** 浏览器拦下了配音出声（页面还没被点过）：配音没在放 */
  blocked: boolean;
}

type Holder = Record<symbol, unknown>;

/** 配音脚本：挂上（或摘掉）"配音此刻放到哪了" */
export function publishDubPlayback(read: (() => DubPlayback | undefined) | undefined): void {
  const g = globalThis as unknown as Holder;
  if (read) g[KEY] = read;
  else delete g[KEY];
}

/** 字幕脚本：配音此刻放到哪了；配音没开、没载入、配音脚本不在这个页面上时 undefined */
export function dubPlayback(): DubPlayback | undefined {
  const read = (globalThis as unknown as Holder)[KEY];
  if (typeof read !== 'function') return undefined;
  const p = (read as () => Partial<DubPlayback> | undefined)();
  if (!p || typeof p.videoId !== 'string' || typeof p.time !== 'number' || !Number.isFinite(p.time)) return undefined;
  return { videoId: p.videoId, time: p.time, running: p.running === true, blocked: p.blocked === true, ...(p.reason ? { reason: p.reason } : {}) };
}

/**
 * 此刻该不该显示字幕：配音在放，或者停在一句话中间（视频暂停、缓冲）时显示；
 * 中文还没开始、这一段说完了在等画面、已经放完、广告、跳转途中、被浏览器拦下没出声时不显示——那时配音没在说这一句
 */
export function dubSubVisible(p: Pick<DubPlayback, 'reason' | 'blocked'>): boolean {
  if (p.reason === 'playing') return !p.blocked;
  return p.reason === 'paused' || p.reason === 'buffering';
}

/** 不显示时的原因（侧边栏照实说） */
export function dubSubHiddenText(p: Pick<DubPlayback, 'reason' | 'blocked'>): string {
  if (p.reason === 'playing' && p.blocked) return '浏览器拦下了配音的声音，配音没在放';
  switch (p.reason) {
    case 'before-start':
      return '中文还没开始';
    case 'segment-end':
      return '中文这一段已经说完，在等画面';
    case 'after-end':
      return '中文已经放完了';
    case 'ad':
      return '正在放广告';
    case 'ended':
      return '视频放完了';
    case 'seeking':
      return '正在跳转';
    default:
      return '配音还没放起来';
  }
}

// ── 找这一句 ──

/**
 * 配音放到 t 秒时显示哪一句（cues 按开始时间排好、互不重叠）：开始了、还没结束的那一句；
 * 结束后再留 lingerSec（下一句开始了就换成下一句）
 */
export function dubCueAt(cues: readonly SubCue[], t: number, lingerSec: number = DUB.subs.lingerSec): SubCue | undefined {
  let lo = 0;
  let hi = cues.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= t) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const c = at >= 0 ? cues[at] : undefined;
  return c && t < c.end + lingerSec ? c : undefined;
}

// ── 字幕的语言跟配音走 ──

export const DUB_SUB_LANG_LABELS: Record<DubSubLang, string> = { zh: '中文', ja: '日文', ko: '韩文', latin: '英文（拉丁字母）', other: '语言认不出' };

/** 一行字是什么语言（按文字认）；全是数字、符号时 undefined */
export function lineLang(line: string): DubSubLang | undefined {
  switch (dominantScript(line)) {
    case 'han':
      return 'zh';
    case 'kana':
      return 'ja';
    case 'hangul':
      return 'ko';
    case 'latin':
      return 'latin';
    default:
      return undefined;
  }
}

export interface PreparedDubSubs {
  cues: SubCue[];
  /** 这份字幕主要是什么语言 */
  lang: DubSubLang;
  /** 是双语字幕，只留了配音语言的那几行 */
  reduced: boolean;
  /** 句数超过上限，后面的截掉了 */
  truncated: boolean;
}

/**
 * 整理成配音字幕：排好、去重叠（tidyCues）；双语字幕（过半的句子里既有配音语言的行、又有别的语言的行）只留配音语言的那几行——
 * 字幕的语言跟配音走。只有别的语言的句子原样留着（那一句配音说的可能就是它）。太长的句子、太多的句子截掉。
 */
export function prepareDubCues(input: readonly SubCue[], dubLang: DubSubLang = DUB.subs.lang): PreparedDubSubs {
  const tidy = tidyCues(input);
  const split = tidy.map((c) => {
    const lines = c.text.split('\n');
    const langs = lines.map(lineLang);
    return { c, lines, langs, own: langs.includes(dubLang), foreign: langs.some((l) => l !== undefined && l !== dubLang) };
  });
  const mixed = split.filter((x) => x.own && x.foreign).length;
  const reduced = split.length > 0 && mixed / split.length >= DUB.subs.bilingualRatio;
  const counts = new Map<DubSubLang, number>();
  const cues: SubCue[] = [];
  for (const x of split) {
    const keep = reduced && x.own ? x.lines.filter((_, i) => x.langs[i] === dubLang) : x.lines;
    const text = keep.join('\n').slice(0, DUB.subs.maxCueChars).trim();
    if (!text) continue;
    for (const line of keep) {
      const l = lineLang(line);
      if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    cues.push({ start: x.c.start, end: x.c.end, text });
  }
  const lang = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
  return { cues: cues.slice(0, DUB.subs.maxCues), lang, reduced, truncated: cues.length > DUB.subs.maxCues };
}

/** 存好之后给你看的一句话：多少句、什么语言；不是配音的语言、只留了一种语言、截掉了的都如实说 */
export function dubSubsNote(p: Pick<PreparedDubSubs, 'lang' | 'reduced' | 'truncated'> & { count: number }, dubLang: DubSubLang = DUB.subs.lang): string {
  const parts = [`${p.count} 句，${DUB_SUB_LANG_LABELS[p.lang]}`];
  if (p.reduced) parts.push(`这份字幕是双语的：只显示${DUB_SUB_LANG_LABELS[dubLang]}那几行（字幕的语言跟配音走）`);
  else if (p.lang !== dubLang) parts.push(`看起来不是配音的语言（${DUB_SUB_LANG_LABELS[dubLang]}）：照样显示，不对就换一份`);
  if (p.truncated) parts.push(`太长了，只留了前 ${DUB.subs.maxCues} 句`);
  return parts.join('；');
}

// ── 小宇宙里已经生成的字幕 ──

/** 小宇宙的一句字幕里，和这一句音频同一种语言的那一行（校对过用校对后的，没有就用转写的原文） */
export function xyzCueOwnLine(cue: XyzCue): string {
  if (cue.polished) {
    const fam = cueFamily(cue);
    if (fam === 'zh' && cue.zh) return cue.zh;
    if (fam === 'en' && cue.en) return cue.en;
  }
  return cue.raw || cue.zh || cue.en || '';
}

/** 小宇宙的字幕 → 配音字幕：每句取它自己语言的那一行（字幕的语言跟音频走） */
export function xyzCuesForDub(cues: readonly XyzCue[]): SubCue[] {
  return cues.map((c) => ({ start: c.start, end: c.end, text: xyzCueOwnLine(c) })).filter((c) => c.text.trim());
}

/** 小宇宙里存着的一集字幕（选用时列出来） */
export interface XyzSubsChoice {
  eid: string;
  title: string;
  podcastTitle: string;
  /** 多少句 */
  count: number;
  /** 已经生成了多少秒、这一集一共多少秒（读不到时长时为空） */
  coveredSec: number;
  durationSec?: number;
  /** 看起来就是这个配音的那一集（标题在配音的文件名里，或两边时长一样） */
  match: boolean;
  updatedAt: number;
}

const squash = (x: string) => x.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/**
 * 小宇宙里存着的字幕里，哪一集看起来是这个配音：标题整个出现在配音的文件名里（下载下来的文件常以页面标题命名），
 * 或者两边时长差不到 2 秒。像的排前面，其余按最近更新排
 */
export function rankXyzForDub(transcripts: readonly XyzTranscript[], dub: { fileName: string; durationSec?: number }): XyzSubsChoice[] {
  const name = squash(dub.fileName);
  return transcripts
    .map((t): XyzSubsChoice => {
      const title = squash(t.title);
      const byTitle = title.length >= 4 && name.includes(title);
      const byDuration = !!t.duration && !!dub.durationSec && Math.abs(t.duration - dub.durationSec) < 2;
      return {
        eid: t.eid,
        title: t.title,
        podcastTitle: t.podcastTitle,
        count: t.cues.filter((c) => c.raw || c.zh || c.en).length,
        coveredSec: doneSeconds(t.done),
        ...(t.duration ? { durationSec: t.duration } : {}),
        match: byTitle || byDuration,
        updatedAt: t.updatedAt,
      };
    })
    .filter((c) => c.count > 0)
    .sort((a, b) => Number(b.match) - Number(a.match) || b.updatedAt - a.updatedAt);
}

// ── 存下的字幕 ──

/** 一个配音的字幕（每个视频一个键：dubSubs:<视频 ID>） */
export interface DubSubsDoc {
  videoId: string;
  cues: SubCue[];
}

/** 读存储时校验：坏掉的句子丢弃，一句都不剩时当作没有 */
export function sanitizeDubSubsDoc(v: unknown, videoId: string): DubSubsDoc | null {
  const d = v as Partial<DubSubsDoc> | undefined;
  if (!d || typeof d !== 'object' || d.videoId !== videoId || !Array.isArray(d.cues)) return null;
  const cues: SubCue[] = [];
  for (const raw of d.cues.slice(0, DUB.subs.maxCues)) {
    const c = raw as Partial<SubCue> | undefined;
    if (!c || typeof c.start !== 'number' || typeof c.end !== 'number' || typeof c.text !== 'string') continue;
    if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < 0 || c.end <= c.start) continue;
    const text = c.text.slice(0, DUB.subs.maxCueChars).trim();
    if (text) cues.push({ start: c.start, end: c.end, text });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues.length ? { videoId, cues } : null;
}

export const dubSubsKey = (videoId: string): string => `dubSubs:${videoId}`;

// ── 样式 ──

export type DubSubStyle = typeof DEFAULT_SETTINGS.dub.subtitles;

const HEX = /^#[0-9a-f]{6}$/i;
const clampNum = (x: unknown, min: number, max: number, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : fallback);

/** 读设置时校验样式：认不出的字体、颜色、超出范围的数都回到默认或夹进范围（内容脚本直接读存储，也走这里） */
export function sanitizeDubSubStyle(v: unknown): DubSubStyle {
  const d = DEFAULT_SETTINGS.dub.subtitles;
  const s = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof DubSubStyle, unknown>>;
  return {
    show: typeof s.show === 'boolean' ? s.show : d.show,
    font: typeof s.font === 'string' && s.font in DUB_SUB_FONTS ? (s.font as DubSubFont) : d.font,
    scale: Number(clampNum(s.scale, DUB.subs.scale.min, DUB.subs.scale.max, d.scale).toFixed(2)),
    color: typeof s.color === 'string' && HEX.test(s.color) ? s.color.toLowerCase() : d.color,
    background: typeof s.background === 'string' && HEX.test(s.background) ? s.background.toLowerCase() : d.background,
    backgroundOpacity: Number(clampNum(s.backgroundOpacity, 0, 1, d.backgroundOpacity).toFixed(2)),
    bold: typeof s.bold === 'boolean' ? s.bold : d.bold,
    outline: typeof s.outline === 'boolean' ? s.outline : d.outline,
    raisePct: Math.round(clampNum(s.raisePct, DUB.subs.raisePct.min, DUB.subs.raisePct.max, d.raisePct)),
  };
}

/** #rrggbb + 不透明度 → rgba(...) */
export function hexToRgba(hex: string, alpha: number): string {
  const n = HEX.test(hex) ? parseInt(hex.slice(1), 16) : 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Number(Math.max(0, Math.min(1, alpha)).toFixed(2))})`;
}

/** 颜色的明暗（0 黑 – 1 白）：描边用和文字相反的颜色 */
function luminance(hex: string): number {
  const n = HEX.test(hex) ? parseInt(hex.slice(1), 16) : 0xffffff;
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** 样式 → 字幕那一行的 CSS（播放器里的字幕层和侧边栏的预览用同一份） */
export function dubSubCss(style: DubSubStyle): { fontFamily: string; color: string; background: string; fontWeight: string; textShadow: string } {
  const edge = luminance(style.color) > 0.5 ? 'rgba(0, 0, 0, 0.9)' : 'rgba(255, 255, 255, 0.9)';
  return {
    fontFamily: DUB_SUB_FONTS[style.font].css,
    color: style.color,
    background: hexToRgba(style.background, style.backgroundOpacity),
    fontWeight: style.bold ? '700' : '500',
    textShadow: style.outline ? `0 0 0.08em ${edge}, 0.04em 0.04em 0.05em ${edge}, -0.04em -0.04em 0.05em ${edge}, 0.04em -0.04em 0.05em ${edge}, -0.04em 0.04em 0.05em ${edge}` : 'none',
  };
}

/** 字号（像素）：随播放器高度变（全屏、剧场模式自动变大），竖屏的 Shorts 按短边算；再乘你设的倍数 */
export function dubSubFontPx(style: Pick<DubSubStyle, 'scale'>, playerW: number, playerH: number, shorts: boolean): number {
  const side = shorts ? Math.min(playerW, playerH) : playerH;
  const base = Math.min(DUB.subs.base.maxPx, Math.max(DUB.subs.base.minPx, side * DUB.subs.base.ratio));
  return Number((base * style.scale).toFixed(1));
}

/** 这个配音的字幕一句话的说明（列表、标题里用） */
export function dubSubsMetaText(m: DubSubsMeta): string {
  const from = m.source === 'xyz' ? ' · 取自小宇宙里已生成的字幕' : m.source === 'asr' ? ' · 由 TubeMuse 从这段配音音频识别（机器识别，可能有错字）' : '';
  return `${m.name} · ${m.count} 句 · ${DUB_SUB_LANG_LABELS[m.lang]}${from}`;
}
