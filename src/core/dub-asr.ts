// 从配音音频识别字幕（用户 2026-11-24 要求，见 DECISIONS §91）的纯逻辑：没有字幕文件时，把已经关联的中文配音（m4a）
// 按停顿切成一句一句、转写、校对，存成这个配音的字幕——和你选的 .srt / .vtt 走同一套存储与显示（core/dub-subs.ts）。
// 时间轴来自切句（哪一帧开始有人声、哪一帧停下），按配音文件自己的时间，不靠转写模型报时间。
// 这里只有：识别到一半的进度（能接着识别，付过钱的不重来）、提示词用的参考资料、预计花费、校对结果的校验。
// 读音频、发请求在 services/dub-asr-service.ts；解码在侧边栏（ui/sidepanel/dub-asr-job.ts）。

import { DUB } from '../config/defaults';
import { safeFileTitle } from './clips';
import { formatClockSec } from './dub';
import { asrCostUsd, formatUsd } from './subtitles';
import { llmCostUsd } from './spend';
import type { SubCue } from './subtitle-track';
import { clip } from './text';

// ── 识别到一半的进度 ──

/** 识别出的一句（时间是配音文件自己的时间，秒） */
export interface DubAsrCue {
  start: number;
  end: number;
  /** 转写的原文 */
  raw: string;
  /** 校对后的文字（校对过才有） */
  text?: string;
  polished?: boolean;
  /** 这一句为什么没校对（字幕里用原文） */
  proofError?: string;
}

/** 一个配音识别到哪了（每个视频一个键：dubAsr:<视频 ID>）。识别完、存成字幕后删掉 */
export interface DubAsrDoc {
  videoId: string;
  /** 识别的是哪一份音频（换了配音文件，这份进度就作废） */
  fileId: string;
  /** 配音有多长（秒） */
  durationSec: number;
  asrModel: string;
  /** 从头到这里（秒）都识别完了；接着识别时从这里开始 */
  doneTo: number;
  cues: DubAsrCue[];
  updatedAt: number;
}

export const dubAsrKey = (videoId: string): string => `dubAsr:${videoId}`;

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** 读存储时校验：坏掉的句子丢弃；整份不像样时当作没有 */
export function sanitizeDubAsrDoc(v: unknown, videoId: string): DubAsrDoc | null {
  const d = v as Partial<DubAsrDoc> | undefined;
  if (!d || typeof d !== 'object' || d.videoId !== videoId || typeof d.fileId !== 'string' || !d.fileId) return null;
  if (!finite(d.durationSec) || d.durationSec <= 0 || !finite(d.doneTo) || d.doneTo < 0 || !Array.isArray(d.cues)) return null;
  const cues: DubAsrCue[] = [];
  for (const raw of d.cues.slice(0, DUB.subs.maxCues)) {
    const c = raw as Partial<DubAsrCue> | undefined;
    if (!c || !finite(c.start) || !finite(c.end) || c.start < 0 || c.end <= c.start || typeof c.raw !== 'string') continue;
    const text = c.raw.slice(0, DUB.subs.maxCueChars).trim();
    if (!text) continue;
    const polished = c.polished === true && typeof c.text === 'string' && !!c.text.trim();
    cues.push({
      start: c.start,
      end: c.end,
      raw: text,
      ...(polished ? { text: c.text!.slice(0, DUB.subs.maxCueChars).trim(), polished: true } : {}),
      ...(!polished && typeof c.proofError === 'string' && c.proofError ? { proofError: c.proofError.slice(0, 200) } : {}),
    });
  }
  cues.sort((a, b) => a.start - b.start);
  return {
    videoId,
    fileId: d.fileId,
    durationSec: d.durationSec,
    asrModel: typeof d.asrModel === 'string' ? d.asrModel.slice(0, 80) : '',
    doneTo: Math.min(d.doneTo, d.durationSec),
    cues,
    updatedAt: finite(d.updatedAt) ? d.updatedAt : 0,
  };
}

/** 接着识别时还作数的句子：整句都在"已识别完"的位置之前的（之后那几句当时还没轮到前面的回来，重新识别） */
export function settledCues(cues: readonly DubAsrCue[], doneTo: number): DubAsrCue[] {
  return cues.filter((c) => c.end <= doneTo + 0.01);
}

/** 按开始时间插进去（转写是并发的，回来的顺序不一定） */
export function insertCue(cues: DubAsrCue[], cue: DubAsrCue): void {
  let at = cues.length;
  while (at > 0 && cues[at - 1]!.start > cue.start) at--;
  cues.splice(at, 0, cue);
}

/** 一句最终显示的文字：校对过用校对后的，否则用转写的原文 */
export const cueText = (c: DubAsrCue): string => (c.polished && c.text ? c.text : c.raw);

/** 识别结果 → 配音字幕（之后和字幕文件走同一条路：prepareDubCues → 存 → 显示） */
export function asrCuesForDub(cues: readonly DubAsrCue[]): SubCue[] {
  return cues.map((c) => ({ start: c.start, end: c.end, text: cueText(c) })).filter((c) => c.text.trim());
}

// ── 提示词用的参考资料 ──

/** 小宇宙网页上另存的音频，文件名末尾带着网站的口号；它不是这段话里的词，留在提示词里只会把转写带偏 */
const SITE_TAIL = /\s*[-–—|｜]\s*小宇宙\s*[-–—|｜]\s*听播客[，,]\s*上小宇宙\s*$/u;

/**
 * 配音的文件名 → 给转写和校对看的参考（让人名、节目名、术语写对）：去掉扩展名和网站口号。
 * 例："#838. Shopify创始人Tobi Lütke：… - 跨国串门儿计划 - 小宇宙 - 听播客，上小宇宙.m4a" → "#838. Shopify创始人Tobi Lütke：… - 跨国串门儿计划"
 */
export function dubReference(fileName: string): string {
  return clip(
    fileName
      .replace(/\.(m4a|mp4|aac)$/i, '')
      .replace(SITE_TAIL, '')
      .replace(/\s+/g, ' ')
      .trim(),
    DUB.fileNameMaxChars,
  );
}

/** 转写一句的提示词：参考（文件名）+ 前面几句（连贯、同一个名字前后写法一致）。不带视频 ID、链接 */
export function dubAsrPrompt(reference: string, before: readonly DubAsrCue[]): string {
  const max = DUB.asr.promptChars;
  const head = clip(reference, Math.floor(max * 0.6));
  const prev = before.slice(-DUB.asr.promptCues).map(cueText).join(' ');
  const room = Math.max(0, max - head.length - 1);
  return [head, room ? prev.slice(-room) : ''].filter(Boolean).join('\n').slice(0, max);
}

// ── 另存成 .srt ──

/**
 * 识别出的字幕另存成 .srt 时叫什么（用户 2026-11-24 要求）：和配音文件同名（去掉扩展名和网站口号），换成 .srt——
 * 放在配音文件旁边一眼认得出是它的字幕；名字里有文件系统不允许的字符时去掉，一个能用的字都不剩时用视频 ID
 */
export function asrSrtFileName(rec: { fileName: string; videoId: string }): string {
  return `${safeFileTitle(dubReference(rec.fileName)) || `youtube-${rec.videoId}`}.srt`;
}

// ── 预计花费 ──

export interface DubAsrEstimate {
  asrUsd: number;
  proofUsd: number;
  totalUsd: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** 识别 seconds 秒的配音大约花多少：转写按时长；校对每 proofBatch 句一次，按平均句长估 */
export function estimateDubAsrUsd(seconds: number, asrModel: string, proofModel: string | undefined): DubAsrEstimate {
  const sec = Math.max(0, seconds);
  const asrUsd = asrCostUsd(asrModel, sec);
  const calls = Math.ceil(sec / DUB.asr.typicalCueSec / DUB.asr.proofBatch);
  const proofUsd = proofModel ? round6(calls * llmCostUsd(proofModel, DUB.asr.proofTypical.inputTokens, DUB.asr.proofTypical.outputTokens)) : 0;
  return { asrUsd, proofUsd, totalUsd: round6(asrUsd + proofUsd) };
}

// ── 校对结果 ──

/** 只数实际的字（去掉空白和标点）：校对只该改错字、补标点，字数不该差很多 */
const letters = (x: string): number => x.replace(/[\s\p{P}\p{S}]+/gu, '').length;

/** 校对后的这一句能不能用：不是空的，字数和原文差得不离谱（差太多说明大模型改写、删减或加了内容） */
export function proofAcceptable(raw: string, proofed: string): boolean {
  const a = letters(raw);
  const b = letters(proofed);
  if (!proofed.trim() || !b) return false;
  return b >= Math.floor(a * DUB.asr.proofMinRatio) - 1 && b <= Math.ceil(a * DUB.asr.proofMaxRatio) + 2;
}

/** 大模型返回的校对结果是不可信输入：只认对得上编号的，文字截断；同一个编号只认第一次 */
export function parseProof(raw: unknown, refs: ReadonlyMap<string, number>): Map<number, string> {
  const out = new Map<number, string>();
  const items = (raw as { items?: unknown })?.items;
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const r = it as Record<string, unknown>;
    const at = typeof r.id === 'string' ? refs.get(r.id) : undefined;
    if (at === undefined || out.has(at) || typeof r.text !== 'string') continue;
    out.set(at, r.text.replace(/\s*\n\s*/g, ' ').trim().slice(0, DUB.subs.maxCueChars));
  }
  return out;
}

// ── 侧边栏看到的进度 ──

export interface DubAsrProgress {
  /** 配音一共多长（秒） */
  durationSec: number;
  /** 已经读到（解码、切句到）哪里 */
  readTo: number;
  /** 从头到这里都转写完了 */
  doneTo: number;
  /** 已经出了多少句、其中多少句校对过 */
  cues: number;
  proofed: number;
  /** 这一次（从你点开始到现在）花了多少 */
  spentUsd: number;
  /** 正在等（被限流、网络出错后重试）：说明在等什么 */
  waiting?: string;
}

/** 做完之后的一句话：多少句、校对了没有、花了多少 */
export interface DubAsrSummary {
  count: number;
  /** 没校对的句数，以及原因（不校对、校对失败） */
  unproofed: number;
  proofNote?: string;
  spentUsd: number;
  /** 只识别了前面这么多秒（"先用已识别的部分"）；识别完整时没有 */
  partialTo?: number;
  durationSec: number;
}

/** 识别中的一行：转写到哪了、出了多少句、花了多少；在等的时候说明在等什么 */
export function dubAsrProgressText(p: DubAsrProgress): string {
  const pct = p.durationSec > 0 ? Math.min(100, Math.floor((p.doneTo / p.durationSec) * 100)) : 0;
  const parts = [`已识别到 ${formatClockSec(p.doneTo)} / ${formatClockSec(p.durationSec)}（${pct}%）`, `${p.cues} 句${p.proofed ? `，校对了 ${p.proofed} 句` : ''}`];
  if (p.spentUsd > 0) parts.push(`这次已花 ${formatUsd(p.spentUsd)}`);
  return parts.join(' · ') + (p.waiting ? `。${p.waiting}` : '');
}

/** 做完之后给你看的一句话：照实说——多少句、哪些没校对、花了多少、是不是只有前面一部分 */
export function dubAsrSummaryText(s: DubAsrSummary): string {
  const parts = [
    s.partialTo !== undefined
      ? `已把识别好的前 ${formatClockSec(s.partialTo)}（配音全长 ${formatClockSec(s.durationSec)}）存成这个配音的字幕：${s.count} 句，后面没识别的地方没有字幕`
      : `识别完成：${s.count} 句，已存成这个配音的字幕`,
  ];
  if (s.unproofed) parts.push(s.unproofed >= s.count ? `没有校对，用的是转写原文（${s.proofNote ?? '原因不明'}）` : `其中 ${s.unproofed} 句没有校对、用的是转写原文（${s.proofNote ?? '原因不明'}）`);
  if (s.spentUsd > 0) parts.push(`这次花了 ${formatUsd(s.spentUsd)}，已记在「字幕 $」里`);
  return `${parts.join('；')}。机器识别可能有错字。`;
}
