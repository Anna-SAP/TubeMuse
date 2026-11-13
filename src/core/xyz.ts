// 小宇宙（xiaoyuzhoufm.com，2026-11-13 新增，见 DECISIONS §72）的纯逻辑：页面识别、单集信息校验、字幕（转写 + 校对 / 翻译）的存取与导出、
// 收藏与标签、收听记录、片段快照。页面脚本、后台、侧边栏共用，单测直接覆盖。

import { XYZ } from '../config/defaults';
import { XYZ_IMAGE_ORIGINS, XYZ_PAGES } from '../config/endpoints';
import { safeFileTitle } from './clips';
import { cleanText, countTags, mergeTags, normalizeTag, retag, tagKey, tagList, withTags, type TagCount } from './collection';
import { asrCostUsd, langFamily } from './subtitles';
import { llmCostUsd } from './spend';
import { dominantScript } from './text';
import { classifyWatch, coveredSeconds, mergeIntervals, type WatchThresholds } from './watch';
import type { WatchSession, WatchStatus } from './types';

export const XYZ_MSG = {
  /** 侧边栏 → 页面脚本：要当前页的状态 */
  getState: 'tubemuse:xyz:get-state',
  /** 页面脚本 → 侧边栏：状态变了 */
  state: 'tubemuse:xyz:state',
  /** 侧边栏 → 页面脚本：开 / 关这一集的字幕（快捷键 Alt+Shift+S 发的是自动字幕的同一条消息） */
  toggle: 'tubemuse:xyz:toggle',
  /** 侧边栏 → 页面脚本：从头生成整集字幕 / 停下 */
  whole: 'tubemuse:xyz:whole',
  /** 侧边栏 → 页面脚本：跳到某个位置（真实时间）；带 to 时放到 to 自动暂停（试听快照片段） */
  seek: 'tubemuse:xyz:seek',
  /** 侧边栏 → 页面脚本：在播放器进度条上标出快照片段的起止（null = 去掉） */
  mark: 'tubemuse:xyz:mark',
  /** 页面脚本 → 后台：收听会话（累计值） */
  listen: 'tubemuse:xyz:listen',
  /** 侧边栏 → 后台：读一段音频（快照的波形与音频片段） */
  window: 'tubemuse:xyz:window',
} as const;

/** 页面脚本与后台之间的长连接名（字幕） */
export const XYZ_PORT = 'tubemuse:xyz';

// ── 页面与链接 ──

const HEX24 = /^[0-9a-f]{24}$/;

export function isXyzId(x: unknown): x is string {
  return typeof x === 'string' && HEX24.test(x);
}

/** 网址属于小宇宙网页版（或 e2e 的 mock）时，返回站内路径 */
export function xyzPath(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const full = u.origin + u.pathname;
  const prefix = XYZ_PAGES.find((p) => full.startsWith(p));
  return prefix ? '/' + full.slice(prefix.length) : undefined;
}

/** 单集页 /episode/<24 位十六进制> 的单集 ID */
export function xyzEpisodeId(url: string): string | undefined {
  const p = xyzPath(url);
  const m = p ? /^\/episode\/([0-9a-f]{24})\/?$/.exec(p) : null;
  return m ? m[1] : undefined;
}

/** 节目页 /podcast/<24 位十六进制> 的节目 ID（从页面上"所属节目"的链接读） */
export function xyzPodcastIdFromHref(href: string): string | undefined {
  const m = /\/podcast\/([0-9a-f]{24})\/?(?:[?#]|$)/.exec(href);
  return m ? m[1] : undefined;
}

export const episodeUrl = (eid: string): string => `https://www.xiaoyuzhoufm.com/episode/${eid}`;
export const podcastUrl = (pid: string): string => `https://www.xiaoyuzhoufm.com/podcast/${pid}`;

/** 音频地址只认小宇宙的 CDN（扩展只能、也只会读这一个域名）；mediaOrigin 由调用方传入（e2e 指向本机 mock） */
export function isXyzMediaUrl(url: unknown, mediaOrigin: string): url is string {
  if (typeof url !== 'string' || url.length > 600) return false;
  try {
    const u = new URL(url);
    const base = new URL(mediaOrigin);
    return u.origin === base.origin && u.pathname.startsWith(base.pathname.replace(/\/?$/, '/')) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** 封面只认小宇宙的图片 CDN（CSP 的 img-src 只放了它）；去掉 @small 之类的尺寸后缀以外的东西 */
export function isXyzImageUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 400) return false;
  try {
    const u = new URL(url);
    return XYZ_IMAGE_ORIGINS.includes(u.origin) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** 封面的小图（@small，约 200×200，卡片上够用） */
export function smallCover(url: string): string {
  return url.replace(/@(?:thumbnail|small|middle|large)$/, '') + '@small';
}

// ── 单集信息 ──

/** 页面脚本读到的单集信息（页面内容不可信：后台和侧边栏都再校验一遍） */
export interface XyzEpisodeInfo {
  eid: string;
  title: string;
  podcastTitle: string;
  pid?: string;
  /** 封面（image.xyzcdn.net） */
  cover?: string;
  /** 音频（小宇宙 CDN）；没有时不能出字幕 */
  audioUrl?: string;
  /** 页面上写的时长（秒） */
  duration?: number;
  /** 发布时间（ISO） */
  pubDate?: string;
  /** 节目简介（show notes）的文字：只用来让大模型校对人名和术语 */
  showNotes?: string;
  /** 节目的主题色（#rrggbb），快照卡片用 */
  color?: string;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

export function sanitizeEpisodeInfo(raw: unknown, mediaOrigin: string): XyzEpisodeInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (!isXyzId(r.eid)) return undefined;
  const info: XyzEpisodeInfo = {
    eid: r.eid,
    title: cleanText(r.title, XYZ.titleMaxChars),
    podcastTitle: cleanText(r.podcastTitle, XYZ.nameMaxChars),
  };
  if (isXyzId(r.pid)) info.pid = r.pid;
  if (isXyzImageUrl(r.cover)) info.cover = r.cover;
  if (isXyzMediaUrl(r.audioUrl, mediaOrigin)) info.audioUrl = r.audioUrl;
  const d = num(r.duration);
  if (d !== undefined && d > 0 && d < 48 * 3600) info.duration = Math.round(d * 1000) / 1000;
  if (typeof r.pubDate === 'string' && !Number.isNaN(Date.parse(r.pubDate))) info.pubDate = new Date(Date.parse(r.pubDate)).toISOString();
  if (typeof r.showNotes === 'string') {
    const notes = r.showNotes
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (notes) info.showNotes = [...notes].slice(0, XYZ.showNotesMaxChars).join('');
  }
  if (typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color)) info.color = r.color.toLowerCase();
  return info;
}

// ── 时间显示 ──

/** 04:52、1:02:03（与小宇宙播放器的写法一致：不到一小时 mm:ss） */
export function formatXyzTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec + 1e-6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

/** "04:52 – 05:18 (26s)" */
export function formatRangeLabel(start: number, end: number): string {
  return `${formatXyzTime(start)} – ${formatXyzTime(end)} (${Math.max(0, Math.round(end - start))}s)`;
}

// ── 字幕 ──

/** 一句字幕：raw 是语音转写的原文；zh / en 是大模型校对或翻译后的中文、英文（还没处理时为空，显示 raw） */
export interface XyzCue {
  id: string;
  /** 真实时间（从文件开头逐帧数出来的，与怎么跳转无关） */
  start: number;
  end: number;
  raw: string;
  /** 转写给出的语言（可能为空） */
  lang?: string;
  zh?: string;
  en?: string;
  /** 已经过大模型校对 / 翻译 */
  polished?: boolean;
  /** 校对 / 翻译失败的原因（原文照常显示） */
  polishError?: string;
  createdAt: number;
}

export interface XyzTranscript {
  eid: string;
  title: string;
  podcastTitle: string;
  /** 转写方式：OpenAI 的模型名，或 browser-speech */
  asrModel: string;
  cues: XyzCue[];
  /** 已经处理过的时间段（真实时间，含没有人声的部分）：这些地方不再读音频、不再花钱 */
  done: [number, number][];
  duration?: number;
  updatedAt: number;
}

export function emptyTranscript(info: Pick<XyzEpisodeInfo, 'eid' | 'title' | 'podcastTitle' | 'duration'>, asrModel: string, now: number): XyzTranscript {
  return { eid: info.eid, title: info.title, podcastTitle: info.podcastTitle, asrModel, cues: [], done: [], ...(info.duration ? { duration: info.duration } : {}), updatedAt: now };
}

/** 按 id 更新或按开始时间插入 */
export function upsertXyzCue(cues: readonly XyzCue[], cue: XyzCue): XyzCue[] {
  const rest = cues.filter((c) => c.id !== cue.id);
  const at = rest.findIndex((c) => c.start > cue.start);
  return at < 0 ? [...rest, cue] : [...rest.slice(0, at), cue, ...rest.slice(at)];
}

export function cueId(eid: string, start: number): string {
  return `${eid}:${Math.round(start * 1000)}`;
}

/** 这段音频是否已经有字幕（与已有句子重叠过半）：重叠的不再转写、不再花钱 */
export function xyzCovered(cues: readonly XyzCue[], start: number, end: number, ratio = 0.5): boolean {
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

/** 已处理的时间段合并（相隔不到 0.3 秒的连起来） */
export function mergeDone(done: readonly [number, number][], add: [number, number]): [number, number][] {
  const list = [...done.map(([a, b]) => [a, b] as [number, number]), add].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of list) {
    const prev = out[out.length - 1];
    if (prev && a <= prev[1] + 0.3) prev[1] = Math.max(prev[1], b);
    else out.push([a, b]);
  }
  return out.slice(0, 2000);
}

/** t 之后第一个还没处理的位置；到 limit 都处理过了返回 undefined */
export function nextGap(done: readonly [number, number][], t: number, limit: number): number | undefined {
  let at = Math.max(0, t);
  for (const [a, b] of done) {
    if (b <= at) continue;
    if (a > at) break;
    at = b;
  }
  return at < limit - 0.05 ? at : undefined;
}

/** 已处理的总秒数 */
export function doneSeconds(done: readonly [number, number][]): number {
  return done.reduce((s, [a, b]) => s + Math.max(0, b - a), 0);
}

/** 这段音频是什么语言：转写给的语言优先，没有就看文字 */
export function cueFamily(cue: Pick<XyzCue, 'lang' | 'raw'>): string | undefined {
  const f = langFamily(cue.lang);
  if (f) return f;
  const sc = dominantScript(cue.raw);
  if (sc === 'han') return 'zh';
  if (sc === 'kana') return 'ja';
  if (sc === 'hangul') return 'ko';
  return /[a-z]/i.test(cue.raw) ? 'en' : undefined;
}

/** 屏幕上的中文、英文两行：校对 / 翻译好了用它；还没好时原文放在它自己语言的那一行，另一行空着 */
export function cueLines(cue: XyzCue): { zh: string; en: string; pending: boolean } {
  if (cue.polished) return { zh: cue.zh ?? '', en: cue.en ?? '', pending: false };
  const fam = cueFamily(cue);
  return { zh: fam === 'zh' ? cue.raw : '', en: fam === 'en' ? cue.raw : '', pending: true };
}

/** 当前该显示哪句（真实时间 t）：开始了、还没结束（结束后再留 lingerSec） */
export function pickXyzCue(cues: readonly XyzCue[], t: number, lingerSec: number = XYZ.lingerSec): XyzCue | undefined {
  let best: XyzCue | undefined;
  for (const c of cues) {
    if (c.start > t + 0.05) break;
    if (t < c.end + lingerSec && (c.raw || c.zh || c.en)) best = c;
  }
  return best;
}

/** 一段时间里的字幕（与 [from, to) 有重叠的） */
export function cuesInRange(cues: readonly XyzCue[], from: number, to: number): XyzCue[] {
  return cues.filter((c) => c.end > from + 0.05 && c.start < to - 0.05 && (c.raw || c.zh || c.en));
}

// ── 导出 ──

export type XyzExportFormat = 'srt-bilingual' | 'srt-zh' | 'srt-en' | 'vtt-bilingual' | 'txt' | 'md';

export const XYZ_EXPORT_LABELS: Record<XyzExportFormat, string> = {
  'srt-bilingual': 'SRT 中英双语',
  'srt-zh': 'SRT 中文',
  'srt-en': 'SRT English',
  'vtt-bilingual': 'WebVTT 中英双语',
  txt: '纯文本（带时间）',
  md: 'Markdown 文稿',
};

function srtTime(sec: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1000))}${sep}${pad(ms % 1000, 3)}`;
}

function exportLines(c: XyzCue, mode: 'bilingual' | 'zh' | 'en'): string[] {
  const l = cueLines(c);
  const zh = l.zh || (mode === 'zh' && !l.en ? c.raw : '');
  const en = l.en || (mode === 'en' && !l.zh ? c.raw : '');
  if (mode === 'zh') return zh ? [zh] : [];
  if (mode === 'en') return en ? [en] : [];
  const both = [zh, en].filter(Boolean);
  return both.length ? both : c.raw ? [c.raw] : [];
}

/** 下载的字幕文件。字幕还没生成完时，文件开头（Markdown / 纯文本）或第一条注释（WebVTT）写明覆盖到哪里；SRT 没有注释语法，不写 */
export function exportTranscript(t: XyzTranscript, info: Pick<XyzEpisodeInfo, 'title' | 'podcastTitle' | 'eid' | 'duration'>, format: XyzExportFormat): { text: string; mime: string; ext: string } {
  const cues = t.cues.filter((c) => c.raw || c.zh || c.en);
  const duration = info.duration ?? t.duration;
  const covered = doneSeconds(t.done);
  const coverage =
    duration && covered < duration - 5
      ? `已生成 ${formatXyzTime(covered)} / ${formatXyzTime(duration)}（${t.done.map(([a, b]) => `${formatXyzTime(a)}–${formatXyzTime(b)}`).slice(0, 12).join('、')}${t.done.length > 12 ? '…' : ''}）`
      : '';
  if (format.startsWith('srt')) {
    const mode = format === 'srt-zh' ? 'zh' : format === 'srt-en' ? 'en' : 'bilingual';
    const blocks: string[] = [];
    for (const c of cues) {
      const lines = exportLines(c, mode);
      if (!lines.length) continue;
      blocks.push(`${blocks.length + 1}\n${srtTime(c.start, ',')} --> ${srtTime(c.end, ',')}\n${lines.join('\n')}`);
    }
    return { text: blocks.join('\n\n') + '\n', mime: 'application/x-subrip;charset=utf-8', ext: 'srt' };
  }
  if (format === 'vtt-bilingual') {
    const head = ['WEBVTT', '', `NOTE ${info.title} · ${info.podcastTitle}${coverage ? `\n${coverage}` : ''}`];
    const blocks = cues
      .map((c) => ({ c, lines: exportLines(c, 'bilingual') }))
      .filter((x) => x.lines.length)
      .map(({ c, lines }) => `${srtTime(c.start, '.')} --> ${srtTime(c.end, '.')}\n${lines.join('\n')}`);
    return { text: [...head, '', blocks.join('\n\n')].join('\n') + '\n', mime: 'text/vtt;charset=utf-8', ext: 'vtt' };
  }
  const url = episodeUrl(info.eid);
  if (format === 'txt') {
    const lines = [`${info.title} · ${info.podcastTitle}`, url, ...(coverage ? [coverage] : []), ''];
    for (const c of cues) lines.push(`[${formatXyzTime(c.start)}] ${exportLines(c, 'bilingual').join(' / ')}`);
    return { text: lines.join('\n') + '\n', mime: 'text/plain;charset=utf-8', ext: 'txt' };
  }
  const md = [`# ${info.title}`, '', `- 节目：${info.podcastTitle}`, `- 链接：${url}`, ...(coverage ? [`- ${coverage}`] : []), `- 字幕：TubeMuse 语音转写${t.cues.some((c) => c.polished) ? ' + 大模型校对 / 翻译' : ''}（机器生成，可能有错）`, ''];
  for (const c of cues) {
    const l = exportLines(c, 'bilingual');
    if (!l.length) continue;
    md.push(`**${formatXyzTime(c.start)}** ${l[0]}`);
    if (l[1]) md.push(`> ${l[1]}`);
    md.push('');
  }
  return { text: md.join('\n'), mime: 'text/markdown;charset=utf-8', ext: 'md' };
}

export function xyzFileBase(title: string, eid: string): string {
  return safeFileTitle(title) || `xiaoyuzhou-${eid}`;
}

// ── 花费估算 ──

/** 生成 seconds 秒的字幕大约花多少：转写 + 每 windowSec 秒一次的校对 / 翻译 */
export function estimateXyzUsd(seconds: number, asrModel: string | undefined, polishModel: string | undefined): number {
  const asr = asrModel ? asrCostUsd(asrModel, seconds) : 0;
  const calls = Math.ceil(seconds / XYZ.windowSec);
  const polish = polishModel ? calls * llmCostUsd(polishModel, XYZ.polishTypical.inputTokens, XYZ.polishTypical.outputTokens) : 0;
  return Math.round((asr + polish) * 1e6) / 1e6;
}

// ── 校对 / 翻译结果 ──

/** 大模型返回的结果是不可信输入：只认对得上编号的，文字截断 */
export function parsePolish(raw: unknown, refs: ReadonlyMap<string, string>): Map<string, { zh: string; en: string }> {
  const out = new Map<string, { zh: string; en: string }>();
  const items = (raw as { items?: unknown })?.items;
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const r = it as Record<string, unknown>;
    const id = typeof r.id === 'string' ? refs.get(r.id) : undefined;
    if (!id || out.has(id)) continue;
    out.set(id, { zh: cleanText(r.zh, XYZ.cueMaxChars), en: cleanText(r.en, XYZ.cueMaxChars) });
  }
  return out;
}

// ── 收藏 ──

export interface XyzSavedEpisode {
  id: string;
  title: string;
  podcastTitle: string;
  pid?: string;
  cover?: string;
  duration?: number;
  pubDate?: string;
  tags: string[];
  savedAt: number;
}

export interface XyzSavedPodcast {
  id: string;
  title: string;
  cover?: string;
  tags: string[];
  savedAt: number;
}

export interface XyzSaved {
  episodes: Record<string, XyzSavedEpisode>;
  podcasts: Record<string, XyzSavedPodcast>;
}

export type XyzKind = 'episode' | 'podcast';

export const emptyXyzSaved = (): XyzSaved => ({ episodes: {}, podcasts: {} });

function sanitizeSavedEpisode(raw: unknown, now: number): XyzSavedEpisode | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (!isXyzId(r.id)) return undefined;
  const ep: XyzSavedEpisode = {
    id: r.id,
    title: cleanText(r.title, XYZ.titleMaxChars),
    podcastTitle: cleanText(r.podcastTitle, XYZ.nameMaxChars),
    tags: tagList(r.tags).slice(0, XYZ.maxTags),
    savedAt: num(r.savedAt) ?? now,
  };
  if (isXyzId(r.pid)) ep.pid = r.pid;
  if (isXyzImageUrl(r.cover)) ep.cover = r.cover;
  const d = num(r.duration);
  if (d) ep.duration = d;
  if (typeof r.pubDate === 'string' && !Number.isNaN(Date.parse(r.pubDate))) ep.pubDate = r.pubDate;
  return ep;
}

function sanitizeSavedPodcast(raw: unknown, now: number): XyzSavedPodcast | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (!isXyzId(r.id)) return undefined;
  const p: XyzSavedPodcast = { id: r.id, title: cleanText(r.title, XYZ.nameMaxChars), tags: tagList(r.tags).slice(0, XYZ.maxTags), savedAt: num(r.savedAt) ?? now };
  if (isXyzImageUrl(r.cover)) p.cover = r.cover;
  return p;
}

export function sanitizeXyzSaved(raw: unknown, now: number = Date.now()): XyzSaved {
  const out = emptyXyzSaved();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  for (const v of Object.values((r.episodes as object) ?? {}).slice(0, XYZ.maxSaved)) {
    const e = sanitizeSavedEpisode(v, now);
    if (e) out.episodes[e.id] = e;
  }
  for (const v of Object.values((r.podcasts as object) ?? {}).slice(0, XYZ.maxSaved)) {
    const p = sanitizeSavedPodcast(v, now);
    if (p) out.podcasts[p.id] = p;
  }
  return out;
}

export type XyzOp =
  | { op: 'save'; kind: 'episode'; item: XyzSavedEpisode }
  | { op: 'save'; kind: 'podcast'; item: XyzSavedPodcast }
  | { op: 'remove'; kind: XyzKind; id: string }
  | { op: 'tags'; kind: XyzKind; id: string; add: string[]; remove: string[] }
  | { op: 'renameTag'; from: string; to: string }
  | { op: 'deleteTag'; tag: string };

export function applyXyzOp(state: XyzSaved, op: XyzOp): { state: XyzSaved; error?: string } {
  const next: XyzSaved = { episodes: { ...state.episodes }, podcasts: { ...state.podcasts } };
  switch (op.op) {
    case 'save': {
      if (op.kind === 'episode') {
        if (!next.episodes[op.item.id] && Object.keys(next.episodes).length >= XYZ.maxSaved) return { state, error: `单集收藏已满 ${XYZ.maxSaved} 条` };
        const prev = next.episodes[op.item.id];
        next.episodes[op.item.id] = { ...op.item, tags: mergeTags(prev?.tags ?? [], op.item.tags), savedAt: prev?.savedAt ?? op.item.savedAt };
      } else {
        if (!next.podcasts[op.item.id] && Object.keys(next.podcasts).length >= XYZ.maxSaved) return { state, error: `节目收藏已满 ${XYZ.maxSaved} 个` };
        const prev = next.podcasts[op.item.id];
        next.podcasts[op.item.id] = { ...op.item, tags: mergeTags(prev?.tags ?? [], op.item.tags), savedAt: prev?.savedAt ?? op.item.savedAt };
      }
      return { state: next };
    }
    case 'remove':
      if (op.kind === 'episode') delete next.episodes[op.id];
      else delete next.podcasts[op.id];
      return { state: next };
    case 'tags': {
      const bucket = (op.kind === 'episode' ? next.episodes : next.podcasts) as Record<string, XyzSavedEpisode | XyzSavedPodcast>;
      const item = bucket[op.id];
      if (!item) return { state, error: '这条收藏已经不在了' };
      const r = withTags(item, op.add, op.remove);
      if (r.error) return { state, error: r.error };
      bucket[op.id] = r.item;
      return { state: next };
    }
    case 'renameTag': {
      const to = normalizeTag(op.to);
      if (!to) return { state, error: '新标签名不能为空' };
      return { state: { episodes: retag(next.episodes, op.from, [to]), podcasts: retag(next.podcasts, op.from, [to]) } };
    }
    case 'deleteTag':
      return { state: { episodes: retag(next.episodes, op.tag, []), podcasts: retag(next.podcasts, op.tag, []) } };
  }
}

export function xyzTagCounts(state: XyzSaved): TagCount[] {
  return countTags([...Object.values(state.episodes), ...Object.values(state.podcasts)]);
}

export type XyzListItem = { kind: 'episode'; item: XyzSavedEpisode } | { kind: 'podcast'; item: XyzSavedPodcast };

export function filterXyzSaved(state: XyzSaved, f: { kind: 'all' | XyzKind; tag?: string; q?: string }): XyzListItem[] {
  const q = (f.q ?? '').trim().toLocaleLowerCase();
  const items: XyzListItem[] = [
    ...(f.kind === 'podcast' ? [] : Object.values(state.episodes).map((item) => ({ kind: 'episode' as const, item }))),
    ...(f.kind === 'episode' ? [] : Object.values(state.podcasts).map((item) => ({ kind: 'podcast' as const, item }))),
  ];
  return items
    .filter((x) => !f.tag || x.item.tags.some((t) => tagKey(t) === tagKey(f.tag!)))
    .filter((x) => {
      if (!q) return true;
      const hay = [x.item.title, x.kind === 'episode' ? x.item.podcastTitle : '', ...x.item.tags].join(' ').toLocaleLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => b.item.savedAt - a.item.savedAt);
}

// ── 收听记录 ──

/** 一集的收听记录：跨天累计（每天听了多久另记），区间是听过的内容（拖动跳过的不算） */
export interface XyzListen {
  eid: string;
  title: string;
  podcastTitle: string;
  pid?: string;
  cover?: string;
  duration: number;
  /** 听过的内容区间（页面时间，秒，已合并） */
  intervals: [number, number][];
  /** 有效收听（墙钟秒，暂停不计） */
  playSec: number;
  /** 本地日期 → 当天有效收听秒数 */
  days: Record<string, number>;
  /** 每段会话已经计入的量：同一段会话的累计上报重复到来时只记增量 */
  sessions: Record<string, { playSec: number; day: string; at: number }>;
  firstAt: number;
  lastAt: number;
  /** 最后听到的位置（页面时间） */
  lastPos: number;
}

export function listenCompletion(r: Pick<XyzListen, 'intervals' | 'duration'>): number {
  return r.duration > 0 ? Math.min(1, coveredSeconds(r.intervals) / r.duration) : 0;
}

export function listenStatus(r: Pick<XyzListen, 'intervals' | 'duration' | 'playSec'>, t: WatchThresholds): WatchStatus {
  return classifyWatch(listenCompletion(r), r.playSec, t);
}

export const LISTEN_STATUS_LABELS: Record<WatchStatus, string> = { glance: '只听了一点', partial: '听了一部分', completed: '听完' };

/** 收到一次收听会话（累计值，可重复上报）：并进这一集的记录 */
export function applyListen(prev: XyzListen | undefined, session: WatchSession, info: Pick<XyzEpisodeInfo, 'eid' | 'title' | 'podcastTitle' | 'pid' | 'cover'>, day: string, lastPos: number): XyzListen {
  const base: XyzListen = prev ?? {
    eid: info.eid,
    title: info.title,
    podcastTitle: info.podcastTitle,
    duration: 0,
    intervals: [],
    playSec: 0,
    days: {},
    sessions: {},
    firstAt: session.startedAt,
    lastAt: session.updatedAt,
    lastPos: 0,
  };
  const seen = base.sessions[session.id];
  const delta = Math.max(0, session.playSec - (seen?.playSec ?? 0));
  const sessions = { ...base.sessions, [session.id]: { playSec: Math.max(seen?.playSec ?? 0, session.playSec), day, at: session.updatedAt } };
  // 只留最近的会话（再早的不会再上报了）
  const keep = Object.entries(sessions)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, XYZ.listenSessionsKept);
  const r: XyzListen = {
    ...base,
    title: info.title || base.title,
    podcastTitle: info.podcastTitle || base.podcastTitle,
    ...(info.pid ? { pid: info.pid } : {}),
    ...(info.cover ? { cover: info.cover } : {}),
    duration: Math.max(base.duration, session.durationSec),
    intervals: mergeIntervals([...base.intervals, ...session.intervals]).slice(0, 500),
    playSec: Math.round((base.playSec + delta) * 100) / 100,
    days: { ...base.days, [day]: Math.round(((base.days[day] ?? 0) + delta) * 100) / 100 },
    sessions: Object.fromEntries(keep),
    firstAt: Math.min(base.firstAt, session.startedAt),
    lastAt: Math.max(base.lastAt, session.updatedAt),
    lastPos: session.updatedAt >= base.lastAt ? lastPos : base.lastPos,
  };
  return r;
}

/** 收听记录太多时删掉最久没听的 */
export function trimListens(log: Record<string, XyzListen>, max: number = XYZ.maxListens): Record<string, XyzListen> {
  const entries = Object.entries(log);
  if (entries.length <= max) return log;
  return Object.fromEntries(entries.sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, max));
}

/** 按最后收听的日期分组（新的在前） */
export function listensByDay(log: Record<string, XyzListen>, dayOf: (at: number) => string): { day: string; items: XyzListen[] }[] {
  const groups = new Map<string, XyzListen[]>();
  for (const r of Object.values(log).sort((a, b) => b.lastAt - a.lastAt)) {
    const d = dayOf(r.lastAt);
    groups.set(d, [...(groups.get(d) ?? []), r]);
  }
  return [...groups.entries()].map(([day, items]) => ({ day, items }));
}

// ── 片段快照 ──

/** 快照片段的起止：至少 minSnapSec，最多 maxSnapSec，不超出这一集。不合适时返回人话 */
export function checkSnapRange(start: number | null, end: number | null, duration: number | undefined): string | undefined {
  if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end)) return '起点、终点要写成 4:52 或 1:02:03 这样的时间';
  if (start < 0) return '起点不能早于 00:00';
  if (end - start < XYZ.minSnapSec) return `片段至少 ${XYZ.minSnapSec} 秒`;
  if (end - start > XYZ.maxSnapSec) return `片段最长 ${XYZ.maxSnapSec} 秒（分享卡片放不下更长的字幕）`;
  if (duration && end > duration + 0.5) return `终点超出了这一集的长度（${formatXyzTime(duration)}）`;
  return undefined;
}

/** 默认的快照片段：当前这句字幕（不够 minDefaultSec 就连上后面几句）；没有字幕时取当前位置往后 20 秒 */
export function defaultSnapRange(cues: readonly XyzCue[], t: number, duration?: number): { start: number; end: number } {
  const cur = pickXyzCue(cues, t, 0) ?? cues.find((c) => c.start >= t);
  if (cur) {
    let end = cur.end;
    for (const c of cues) if (c.start >= cur.start && c.start < cur.start + XYZ.defaultSnapSec && c.end - cur.start <= XYZ.maxSnapSec) end = Math.max(end, c.end);
    return { start: Math.floor(cur.start * 10) / 10, end: Math.ceil(Math.min(end, duration ?? end) * 10) / 10 };
  }
  const start = Math.max(0, Math.floor(t));
  return { start, end: Math.min(duration ?? start + XYZ.defaultSnapSec, start + XYZ.defaultSnapSec) };
}

/** 快照里的两段文字：这段时间里所有字幕的中文、英文各接成一段 */
export function snapTexts(cues: readonly XyzCue[], start: number, end: number): { zh: string; en: string; raw: string; complete: boolean } {
  const list = cuesInRange(cues, start, end);
  const zh: string[] = [];
  const en: string[] = [];
  for (const c of list) {
    const l = cueLines(c);
    if (l.zh) zh.push(l.zh);
    if (l.en) en.push(l.en);
  }
  const joinZh = zh.join('');
  return { zh: joinZh, en: en.join(' '), raw: list.map((c) => c.raw).join(' '), complete: list.length > 0 && list.every((c) => c.polished) };
}

/** "复制链接"放进剪贴板的文字：小宇宙的单集链接不认时间参数，这里不自创，只把片段时间写在旁边 */
export function snapShareText(info: Pick<XyzEpisodeInfo, 'eid' | 'title' | 'podcastTitle'>, start: number, end: number): string {
  return `《${info.title}》· ${info.podcastTitle}\n片段 ${formatXyzTime(start)}–${formatXyzTime(end)}\n${episodeUrl(info.eid)}`;
}

/** 快照记录（"我的快照"）：只有元数据，图片与音频在下载文件夹 */
export interface XyzSnapshotRecord {
  id: string;
  eid: string;
  title: string;
  podcastTitle: string;
  cover?: string;
  color?: string;
  audioUrl?: string;
  start: number;
  end: number;
  zh: string;
  en: string;
  createdAt: number;
}

export function addSnapshot(log: readonly XyzSnapshotRecord[], rec: XyzSnapshotRecord, max: number = XYZ.snapshotLogMax): XyzSnapshotRecord[] {
  const same = (x: XyzSnapshotRecord) => x.eid === rec.eid && Math.abs(x.start - rec.start) < 0.05 && Math.abs(x.end - rec.end) < 0.05;
  return [rec, ...log.filter((x) => !same(x))].slice(0, max);
}

// ── 页面脚本报给侧边栏的状态 ──

export interface XyzTabState {
  /** episode：单集页；other：小宇宙的别的页面 */
  page: 'episode' | 'other';
  enabled: boolean;
  info?: XyzEpisodeInfo;
  /** 播放器的状态（页面时间） */
  pos: number;
  /** 真实时间（可变码率 mp3 跳转后两者不同；还不知道时与 pos 相同） */
  truePos: number;
  duration: number;
  playing: boolean;
  /** 字幕开着 */
  active: boolean;
  /** 正在生成整集字幕 */
  whole: boolean;
  engine: 'openai' | 'browser';
  display: XyzDisplay;
  status: string;
  error?: { message: string; hint?: string };
  /** 读索引（可变码率 mp3 要扫一遍整个文件）的进度：0–1 */
  scan?: number;
  /** 时间对不准的原因（没有目录的可变码率 mp3） */
  timingNote?: string;
  pending: number;
  /** 已处理到的秒数（整集里） */
  doneSec: number;
}

export type XyzDisplay = 'bilingual' | 'zh' | 'en' | 'off';

export const XYZ_DISPLAY_LABELS: Record<XyzDisplay, string> = { bilingual: '中英双语', zh: '只看中文', en: '只看英文', off: '不在页面上显示' };

export function isXyzDisplay(x: unknown): x is XyzDisplay {
  return x === 'bilingual' || x === 'zh' || x === 'en' || x === 'off';
}

export { tagKey, normalizeTag } from './collection';
