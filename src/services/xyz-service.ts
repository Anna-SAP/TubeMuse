// 小宇宙（DECISIONS §72）的后台流程：
//   读音频：只读你打开的那一集的公开音频文件（小宇宙 CDN），按时间段分段读，交给页面脚本解码切句——音频不落盘、不进导出；
//   转写：一句一句发往 OpenAI（与自动字幕同一个转写模型、同一份"字幕 $"预算）；
//   校对 / 翻译：每读完一段（约 30 秒），把这一段的转写文字交给大模型校对并译成另一种语言；
//   收听记录、收藏。
// 字幕文字只存本机（每集一个键），回听、下载都不再花钱。

import { HTTP_TIMEOUT_MS, SUBTITLES, XYZ } from '../config/defaults';
import { AudioFormatError, Mp3Scanner, extractWindow, needsScan, openAudio, pageOffset, planWindow, timingExact, type AudioIndex, type Mp3Index, type RangeFetch, type SeekModel } from '../core/podcast-audio';
import { buildXyzPolishPrompt, XYZ_POLISH_SCHEMA } from '../core/prompts';
import { bytesToBase64, base64ToBytes, estimateSegmentUsd, recordAsr, recordTranslation, releaseSubtitleHold, translationCostUsd, wavInfo, type SubtitleLedger } from '../core/subtitles';
import { clip } from '../core/text';
import { dayKey } from '../core/time';
import {
  applyListen,
  cueId,
  emptyTranscript,
  isXyzId,
  mergeDone,
  parsePolish,
  sanitizeEpisodeInfo,
  trimListens,
  upsertXyzCue,
  xyzCovered,
  type XyzCue,
  type XyzEpisodeInfo,
  type XyzTranscript,
} from '../core/xyz';
import type { WatchSession } from '../core/types';
import type { AppContext } from './context';
import { AppError, toAppError } from './errors';
import { createTranscriber } from './llm';
import { stores, xyzTranscriptStore, type Settings } from './repo';
import { clearRatePause, closeFailedHold, holdSpend, missingOpenAiKey, rateLimited, subtitleTranslationModel, throwIfRatePaused, translationClient } from './subtitle-service';

/** 存在字幕里的"转写模型"名：浏览器识别 */
export const XYZ_BROWSER_ASR = 'browser-speech';

// ── 读音频 ──

/** 按块读响应体，超过 cap 就停（服务器不认分段读取、把整个文件发过来时，不把几十 MB 读进内存） */
async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    if (n > cap) {
      await reader.cancel().catch(() => undefined);
      throw new AppError('xyz', '音频服务器没有按要求分段返回（一次给得太多），已停止读取', '稍后再试；如果一直这样，可能是小宇宙的 CDN 改了，请把这条提示告诉开发者');
    }
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function httpProblem(status: number): AppError {
  if (status === 403 || status === 401) return new AppError('xyz', `音频文件拒绝访问（HTTP ${status}）`, '这一集可能是付费或仅会员可听的节目：TubeMuse 只读公开音频，不绕过限制');
  if (status === 404 || status === 410) return new AppError('xyz', `音频文件不存在（HTTP ${status}）`, '这一集的音频可能已被下架；刷新小宇宙页面再试');
  return new AppError('xyz', `读音频失败（HTTP ${status}）`, '稍后再试');
}

/** 读音频文件的 [start, end]：只发往小宇宙的音频 CDN，不带 Cookie、不带 Referer */
export function mediaFetcher(ctx: AppContext, url: string): RangeFetch {
  if (!url.startsWith(ctx.endpoints.xyzMedia + '/')) throw new AppError('xyz', '这一集的音频不在小宇宙的公开 CDN 上，读不了', 'TubeMuse 只读 media.xyzcdn.net 上的公开音频');
  return async (start, end) => {
    const want = end - start + 1;
    if (want > XYZ.maxRangeBytes) throw new AppError('xyz', '一次要读的音频太多了', '请把这条提示告诉开发者');
    let res: Response;
    try {
      res = await ctx.http(url, { headers: { Range: `bytes=${start}-${end}` }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    } catch (e) {
      throw toAppError(e);
    }
    if (res.status === 416) return { bytes: new Uint8Array(0), total: Number(/\/(\d+)/.exec(res.headers.get('content-range') ?? '')?.[1] ?? start) };
    if (res.status !== 206 && res.status !== 200) throw httpProblem(res.status);
    const range = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/.exec(res.headers.get('content-range') ?? '');
    if (res.status === 206 && range) {
      const bytes = await readCapped(res, Math.max(want, 1) + 1024);
      return { bytes, total: range[3] === '*' ? Number(range[2]) + 1 : Number(range[3]) };
    }
    // 200：服务器没理分段读取。文件本身很小才接受
    const all = await readCapped(res, XYZ.maxRangeBytes);
    return { bytes: all.slice(start, end + 1), total: all.length };
  };
}

interface AudioCache {
  indexes: Map<string, Promise<AudioIndex>>;
  scans: Map<string, Promise<void>>;
}
const caches = new WeakMap<AppContext, AudioCache>();
function cache(ctx: AppContext): AudioCache {
  let c = caches.get(ctx);
  if (!c) caches.set(ctx, (c = { indexes: new Map(), scans: new Map() }));
  return c;
}

function formatProblem(e: unknown): unknown {
  return e instanceof AudioFormatError ? new AppError('xyz', `认不出这一集的音频格式：${e.message}`, '目前支持 m4a（AAC）和 mp3') : e;
}

/** 这一集音频的索引（m4a 的帧表；mp3 的格式与已扫描的帧位置）。同一个地址只建一次 */
export function openAudioIndex(ctx: AppContext, url: string): Promise<AudioIndex> {
  const c = cache(ctx);
  let p = c.indexes.get(url);
  if (!p) {
    p = (async () => {
      const index = await openAudio(mediaFetcher(ctx, url)).catch((e: unknown) => {
        throw formatProblem(e);
      });
      if (index.kind === 'mp3' && index.vbr) {
        const saved = (await stores.xyzScans.read(ctx.kv))[url];
        if (saved?.scan.complete) index.scan = saved.scan;
      }
      return index;
    })();
    c.indexes.set(url, p);
    p.catch(() => c.indexes.delete(url));
    // 只留最近几集的索引（m4a 的帧表一集约 2 MB 内存）
    while (c.indexes.size > 4) c.indexes.delete(c.indexes.keys().next().value!);
  }
  return p;
}

/** 可变码率 mp3：把整个文件的帧头扫一遍（流式读，只看帧头、不留音频）。扫描中索引上的 scan 随时可用到已扫过的位置 */
export function scanAudio(ctx: AppContext, url: string, onProgress?: (scannedTo: number, total: number) => void): Promise<void> {
  const c = cache(ctx);
  const running = c.scans.get(url);
  if (running) return running;
  const p = (async () => {
    const index = await openAudioIndex(ctx, url);
    if (!needsScan(index)) return;
    const mp3 = index as Mp3Index;
    if (mp3.total > XYZ.maxScanBytes) throw new AppError('xyz', '这一集的音频文件太大，没法建立时间索引', '可变码率的 mp3 要先把整个文件读一遍；这一集超过了上限');
    const scanner = new Mp3Scanner(mp3);
    mp3.scan = scanner.scan;
    let res: Response;
    try {
      res = await ctx.http(url, { headers: { Range: `bytes=${mp3.audioStart}-` }, credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch (e) {
      throw toAppError(e);
    }
    if (res.status !== 206 && res.status !== 200) throw httpProblem(res.status);
    const reader = res.body?.getReader();
    if (!reader) throw new AppError('xyz', '读不了音频文件', '稍后再试');
    let at = res.status === 206 ? mp3.audioStart : 0;
    let lastReport = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (at < mp3.audioStart) {
        // 200：服务器从头发过来了，跳过开头
        const skip = Math.min(value.length, mp3.audioStart - at);
        at += skip;
        if (skip < value.length) scanner.push(value.subarray(skip), at);
        at += value.length - skip;
      } else {
        scanner.push(value, at);
        at += value.length;
      }
      if (at - lastReport > 2 * 1024 * 1024) {
        lastReport = at;
        onProgress?.(at, mp3.total);
      }
    }
    scanner.finish();
    onProgress?.(mp3.total, mp3.total);
    await stores.xyzScans.update(ctx.kv, ctx.locker, (all) => {
      const next = { ...all, [url]: { scan: mp3.scan!, at: ctx.now() } };
      const keep = Object.entries(next)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, XYZ.maxScans);
      return Object.fromEntries(keep);
    });
  })();
  c.scans.set(url, p);
  p.catch(() => {
    c.scans.delete(url);
    void openAudioIndex(ctx, url).then((i) => {
      if (i.kind === 'mp3' && !i.scan?.complete) delete i.scan;
    });
  });
  return p;
}

/** 音频的概况：页面脚本据此决定要不要等扫描、时间能不能对准 */
export interface XyzAudioInfo {
  kind: 'mp4' | 'mp3';
  duration: number;
  /** 可变码率 mp3：要先扫一遍；scanned 是已扫的比例 */
  needsScan: boolean;
  scanned: number;
  exact: boolean;
  /** 跳转之后页面时间与真实时间不同（有目录的可变码率 mp3）：要按跳转目标换算 */
  vbr: boolean;
}

export function audioInfo(index: AudioIndex): XyzAudioInfo {
  const scanned = index.kind === 'mp3' && index.vbr ? (index.scan?.complete ? 1 : index.scan ? Math.min(0.999, index.scan.scannedTo / index.total) : 0) : 1;
  return { kind: index.kind, duration: index.duration, needsScan: needsScan(index), scanned, exact: timingExact(index), vbr: index.kind === 'mp3' && index.vbr && !!index.xing?.toc };
}

export interface XyzWindowReply {
  /** base64 的音频字节（ADTS 或 mp3 帧） */
  audio: string;
  mime: string;
  firstTime: number;
  skipSec: number;
  endTime: number;
}

/** 读真实时间 [from, to) 的音频。可变码率 mp3 还没扫到这里时抛 xyz_scan（调用方稍后再问） */
export async function readAudioWindow(ctx: AppContext, url: string, from: number, to: number): Promise<XyzWindowReply> {
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from && to - from <= 120)) throw new AppError('xyz', '要读的时间段不对', '请把这条提示告诉开发者');
  const index = await openAudioIndex(ctx, url);
  let plan;
  try {
    plan = planWindow(index, from, to);
  } catch (e) {
    if (e instanceof AudioFormatError && index.kind === 'mp3' && index.vbr) {
      void scanAudio(ctx, url).catch(() => undefined);
      throw new AppError('xyz_scan', '正在建立这一集的时间索引（可变码率 mp3 要先把文件读一遍）', '只读帧头，不保存音频；完成后自动继续');
    }
    throw formatProblem(e);
  }
  const { bytes } = await mediaFetcher(ctx, url)(plan.start, plan.end);
  try {
    const w = extractWindow(index, plan, bytes, to);
    return { audio: bytesToBase64(w.data), mime: w.mime, firstTime: w.firstTime, skipSec: w.skipSec, endTime: w.endTime };
  } catch (e) {
    throw formatProblem(e);
  }
}

/** 页面时间 → 真实时间的差值（可变码率 mp3 跳转后不为 0）；还不知道时 undefined */
export async function audioOffset(ctx: AppContext, url: string, seekTarget: number | undefined, model: SeekModel): Promise<number | undefined> {
  const index = await openAudioIndex(ctx, url);
  const off = pageOffset(index, seekTarget, model);
  if (off === undefined) void scanAudio(ctx, url).catch(() => undefined);
  return off;
}

// ── 字幕存取 ──

async function saveTranscript(ctx: AppContext, eid: string, fn: (t: XyzTranscript | null) => XyzTranscript): Promise<XyzTranscript> {
  const now = ctx.now();
  const next = await xyzTranscriptStore(eid).update(ctx.kv, ctx.locker, (t) => ({ ...fn(t), updatedAt: now }));
  const index = await stores.xyzTranscriptIndex.update(ctx.kv, ctx.locker, (i) => ({ ...i, [eid]: now }));
  const drop = Object.entries(index)
    .sort((a, b) => b[1] - a[1])
    .slice(XYZ.maxTranscripts)
    .map(([id]) => id);
  if (drop.length) {
    for (const id of drop) await ctx.kv.remove(xyzTranscriptStore(id).key);
    await stores.xyzTranscriptIndex.update(ctx.kv, ctx.locker, (i) => Object.fromEntries(Object.entries(i).filter(([id]) => !drop.includes(id))));
  }
  return next!;
}

export async function getTranscript(ctx: AppContext, eid: string): Promise<XyzTranscript | null> {
  return xyzTranscriptStore(eid).read(ctx.kv);
}

function withInfo(t: XyzTranscript | null, info: XyzEpisodeInfo, asrModel: string, now: number): XyzTranscript {
  const base = t ?? emptyTranscript(info, asrModel, now);
  return { ...base, title: info.title || base.title, podcastTitle: info.podcastTitle || base.podcastTitle, ...(info.duration ? { duration: info.duration } : {}) };
}

// ── 转写 ──

export interface XyzSegmentInput {
  eid: string;
  start: number;
  end: number;
  wav: Uint8Array;
}

/** 校验页面脚本送来的一句：只收本扩展自己编码的 16 kHz 单声道 WAV，长度不超过切句上限 */
export function validateXyzSegment(input: XyzSegmentInput): { durationSec: number } {
  const info = wavInfo(input.wav);
  const ok =
    isXyzId(input.eid) &&
    Number.isFinite(input.start) &&
    Number.isFinite(input.end) &&
    input.start >= 0 &&
    input.end > input.start &&
    !!info &&
    info.sampleRate === SUBTITLES.sampleRate &&
    info.durationSec > 0 &&
    info.durationSec <= XYZ.maxSegmentSec + 0.5;
  if (!ok || !info) throw new AppError('subtitles', '收到的音频片段格式不对，已丢弃', '刷新小宇宙页面后再试；如果反复出现，请把这条提示告诉开发者');
  return { durationSec: info.durationSec };
}

/** 转写的提示词：节目名、标题（让人名、术语写对）+ 前文（连贯） */
function asrPrompt(info: XyzEpisodeInfo, before: readonly XyzCue[]): string {
  const head = [info.podcastTitle, info.title].filter(Boolean).join('：');
  const prev = before
    .slice(-4)
    .map((c) => (c.polished && c.zh && c.lang?.startsWith('zh') ? c.zh : c.raw))
    .join(' ');
  const room = Math.max(0, XYZ.asrPromptChars - head.length - 1);
  return [head, prev.slice(-room)].filter(Boolean).join('\n').slice(0, XYZ.asrPromptChars);
}

/** 转写一句。这段已有字幕时返回 undefined（不花钱） */
export async function transcribeXyzSegment(ctx: AppContext, info: XyzEpisodeInfo, input: XyzSegmentInput): Promise<XyzCue | undefined> {
  const [settings, secrets] = await Promise.all([stores.settings.read(ctx.kv), stores.secrets.read(ctx.kv)]);
  if (!settings.xyz.enabled) throw new AppError('subtitles', '小宇宙功能已在设置中关闭');
  const { durationSec } = validateXyzSegment(input);
  if (!secrets.openaiApiKey) throw missingOpenAiKey();
  const t = await getTranscript(ctx, input.eid);
  if (t && xyzCovered(t.cues, input.start, input.end)) return undefined;
  throwIfRatePaused(ctx);
  const asrModel = settings.subtitles.asrModel.trim() || 'gpt-transcribe';
  const holdId = await holdSpend(ctx, estimateSegmentUsd(asrModel, durationSec, undefined), '小宇宙转写');
  let result: Awaited<ReturnType<ReturnType<typeof createTranscriber>['transcribe']>>;
  try {
    const before = (t?.cues ?? []).filter((c) => c.start < input.start);
    const prompt = asrPrompt(info, before);
    result = await createTranscriber({ model: asrModel, apiKey: secrets.openaiApiKey, baseURL: ctx.endpoints.openai, fetch: ctx.http }).transcribe({ wav: input.wav, ...(prompt ? { prompt } : {}) });
  } catch (e) {
    await closeFailedHold(ctx, holdId, e);
    throw rateLimited(ctx, e);
  }
  clearRatePause(ctx);
  const now = ctx.now();
  await stores.subtitleLedger.update(ctx.kv, ctx.locker, (l) => recordAsr(releaseSubtitleHold(l, holdId), dayKey(now, ctx.timeZone), asrModel, result.billedSeconds ?? durationSec));
  const cue: XyzCue = {
    id: cueId(input.eid, input.start),
    start: input.start,
    end: input.end,
    raw: clip(result.text, XYZ.cueMaxChars),
    ...(result.language ? { lang: result.language } : {}),
    createdAt: now,
  };
  await saveTranscript(ctx, input.eid, (tr) => {
    const base = withInfo(tr, info, asrModel, now);
    return { ...base, asrModel, cues: upsertXyzCue(base.cues, cue) };
  });
  return cue;
}

/** 浏览器识别出的一行：存成字幕（不花转写费）；这段已有字幕时返回 undefined */
export async function saveXyzTextCue(ctx: AppContext, info: XyzEpisodeInfo, input: { start: number; end: number; text: string; lang?: string }): Promise<XyzCue | undefined> {
  const text = typeof input.text === 'string' ? clip(input.text.trim(), XYZ.cueMaxChars) : '';
  const ok = Number.isFinite(input.start) && Number.isFinite(input.end) && input.start >= 0 && input.end > input.start && input.end - input.start <= 120 && !!text;
  if (!ok) throw new AppError('subtitles', '收到的字幕格式不对，已丢弃', '刷新小宇宙页面后再试');
  const t = await getTranscript(ctx, info.eid);
  if (t && xyzCovered(t.cues, input.start, input.end)) return undefined;
  const now = ctx.now();
  const cue: XyzCue = {
    id: cueId(info.eid, input.start),
    start: input.start,
    end: input.end,
    raw: text,
    ...(typeof input.lang === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.lang) ? { lang: input.lang } : {}),
    createdAt: now,
  };
  await saveTranscript(ctx, info.eid, (tr) => {
    const base = withInfo(tr, info, XYZ_BROWSER_ASR, now);
    return { ...base, cues: upsertXyzCue(base.cues, cue) };
  });
  return cue;
}

/** 记下这段时间已经处理过（含没有人声的部分）：以后不再读音频、不再花钱 */
export async function markXyzDone(ctx: AppContext, info: XyzEpisodeInfo, from: number, to: number, asrModel: string): Promise<void> {
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) return;
  await saveTranscript(ctx, info.eid, (tr) => {
    const base = withInfo(tr, info, asrModel, ctx.now());
    return { ...base, done: mergeDone(base.done, [Math.max(0, from), to]) };
  });
}

// ── 校对 / 翻译 ──

/** 校对 / 翻译用哪个模型：与自动字幕的"字幕翻译模型"相同（默认 claude-haiku-5-5） */
export function xyzPolishModel(settings: Settings): string | undefined {
  return settings.xyz.polish ? subtitleTranslationModel(settings).model : undefined;
}

/**
 * 校对并翻译 [from, to) 里还没处理过的句子（一次最多 polishMaxCues 句）。没打开校对、没有句子时返回空。
 * 失败时把原因写进每句的 polishError（原文照常显示），再抛出错误交给调用方说明。
 */
export async function polishXyzRange(ctx: AppContext, info: XyzEpisodeInfo, from: number, to: number): Promise<XyzCue[]> {
  const [settings, secrets] = await Promise.all([stores.settings.read(ctx.kv), stores.secrets.read(ctx.kv)]);
  if (!settings.xyz.polish) return [];
  const t = await getTranscript(ctx, info.eid);
  if (!t) return [];
  const todo = t.cues.filter((c) => !c.polished && c.raw && c.start >= from - 0.05 && c.start < to).slice(0, XYZ.polishMaxCues);
  if (!todo.length) return [];
  const llm = translationClient(ctx, settings, secrets);
  const previous = t.cues
    .filter((c) => c.polished && c.zh && c.start < todo[0]!.start)
    .slice(-XYZ.polishContextCues)
    .map((c) => c.zh!);
  const prompt = buildXyzPolishPrompt(
    { podcastTitle: info.podcastTitle, episodeTitle: info.title, notes: (info.showNotes ?? '').slice(0, XYZ.promptNotesChars), previous, segments: todo.map((c) => ({ text: c.raw })) },
    todo.map((c) => c.id),
  );
  const holdId = await holdSpend(ctx, translationCostUsd(llm.model, XYZ.polishEstimate.inputTokens, XYZ.polishMaxOutputTokens), '小宇宙校对 / 翻译');
  const record = (l: SubtitleLedger, usage: { inputTokens: number; outputTokens: number }) => recordTranslation(l, dayKey(ctx.now(), ctx.timeZone), llm.model, usage.inputTokens, usage.outputTokens, todo.length);
  let value: unknown;
  try {
    const r = await llm.generateJsonWithUsage({ system: prompt.system, user: prompt.user, schema: XYZ_POLISH_SCHEMA, schemaName: 'tubemuse_xyz_polish', effort: 'low', maxOutputTokens: XYZ.polishMaxOutputTokens });
    value = r.value;
    await stores.subtitleLedger.update(ctx.kv, ctx.locker, (l) => record(releaseSubtitleHold(l, holdId), r.usage));
  } catch (err) {
    await closeFailedHold(ctx, holdId, err, record);
    const e = toAppError(err, [secrets.anthropicApiKey, secrets.openaiApiKey]);
    await saveTranscript(ctx, info.eid, (tr) => {
      const base = withInfo(tr, info, t.asrModel, ctx.now());
      return { ...base, cues: base.cues.map((c) => (todo.some((x) => x.id === c.id) ? { ...c, polishError: e.message } : c)) };
    });
    throw e;
  }
  const parsed = parsePolish(value, prompt.refs);
  const updated: XyzCue[] = [];
  await saveTranscript(ctx, info.eid, (tr) => {
    const base = withInfo(tr, info, t.asrModel, ctx.now());
    const cues = base.cues.map((c) => {
      if (!todo.some((x) => x.id === c.id)) return c;
      const p = parsed.get(c.id);
      const next: XyzCue = p ? { ...c, zh: p.zh, en: p.en, polished: true } : { ...c, polishError: '大模型这次漏掉了这一句' };
      if (p) delete next.polishError;
      updated.push(next);
      return next;
    });
    return { ...base, cues };
  });
  return updated;
}

// ── 与页面脚本的会话（后台用 chrome.runtime.Port 接上；单测直接调用） ──

export type XyzUp =
  | { type: 'hello'; info: unknown }
  | { type: 'window'; reqId: number; from: number; to: number }
  | { type: 'offset'; reqId: number; seekTarget?: number; model: SeekModel }
  | { type: 'scan' }
  | { type: 'segment'; seq: number; start: number; end: number; audio: string }
  | { type: 'text'; seq: number; start: number; end: number; text: string; lang?: string }
  | { type: 'processed'; from: number; to: number };

export type XyzDown =
  | { type: 'track'; eid: string; cues: XyzCue[]; done: [number, number][]; audio?: XyzAudioInfo; audioError?: { message: string; hint?: string } }
  | ({ type: 'window'; reqId: number } & XyzWindowReply)
  | { type: 'offset'; reqId: number; offset?: number; scanned: number }
  | { type: 'scan'; scanned: number; complete: boolean }
  | { type: 'cue'; seq: number; cue: XyzCue }
  | { type: 'cues'; cues: XyzCue[] }
  | { type: 'error'; reqId?: number; seq?: number; message: string; hint?: string; fatal: boolean; wait?: boolean; retryAfterMs?: number }
  | { type: 'done'; seq: number };

function isFatal(e: AppError): boolean {
  return e.kind === 'subtitles_budget' || e.kind === 'llm_key' || e.kind === 'llm_quota' || /已在设置中关闭|模型「/.test(e.message) || (e.kind === 'xyz' && /拒绝访问|不存在|认不出|太大|不在小宇宙/.test(e.message));
}

export function xyzSession(ctx: AppContext, send: (m: XyzDown) => void): (msg: unknown) => Promise<void> {
  let info: XyzEpisodeInfo | undefined;
  let inFlight = 0;
  const fail = (err: unknown, extra: { reqId?: number; seq?: number }, secrets: readonly (string | undefined)[] = []) => {
    const e = toAppError(err, secrets);
    send({ type: 'error', ...extra, message: e.message, ...(e.hint ? { hint: e.hint } : {}), fatal: isFatal(e), ...(e.kind === 'xyz_scan' ? { wait: true } : {}), ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) });
  };
  return async (raw) => {
    const msg = raw as Partial<XyzUp> & Record<string, unknown>;
    if (msg?.type === 'hello') {
      info = sanitizeEpisodeInfo(msg.info, ctx.endpoints.xyzMedia);
      if (!info) return;
      const t = await getTranscript(ctx, info.eid);
      let audio: XyzAudioInfo | undefined;
      let audioError: { message: string; hint?: string } | undefined;
      if (!info.audioUrl) {
        audioError = { message: '页面上没找到这一集的公开音频地址', hint: '付费或私密的节目不在公开 CDN 上；刷新页面再试' };
      } else {
        try {
          audio = audioInfo(await openAudioIndex(ctx, info.audioUrl));
        } catch (err) {
          const e = toAppError(err);
          audioError = { message: e.message, ...(e.hint ? { hint: e.hint } : {}) };
        }
      }
      send({ type: 'track', eid: info.eid, cues: t?.cues ?? [], done: t?.done ?? [], ...(audio ? { audio } : {}), ...(audioError ? { audioError } : {}) });
      return;
    }
    if (!info?.audioUrl) return;
    const url = info.audioUrl;
    if (msg.type === 'window') {
      const reqId = Number(msg.reqId) || 0;
      try {
        send({ type: 'window', reqId, ...(await readAudioWindow(ctx, url, Number(msg.from), Number(msg.to))) });
      } catch (err) {
        fail(err, { reqId });
      }
      return;
    }
    if (msg.type === 'offset') {
      const reqId = Number(msg.reqId) || 0;
      try {
        const seek = typeof msg.seekTarget === 'number' && Number.isFinite(msg.seekTarget) ? msg.seekTarget : undefined;
        const offset = await audioOffset(ctx, url, seek, msg.model === 'firefox' ? 'firefox' : 'chrome');
        const index = await openAudioIndex(ctx, url);
        send({ type: 'offset', reqId, ...(offset !== undefined ? { offset } : {}), scanned: audioInfo(index).scanned });
      } catch (err) {
        fail(err, { reqId });
      }
      return;
    }
    if (msg.type === 'scan') {
      let last = 0;
      try {
        await scanAudio(ctx, url, (at, total) => {
          const r = Math.min(0.999, at / Math.max(1, total));
          if (r - last >= 0.02) {
            last = r;
            send({ type: 'scan', scanned: r, complete: false });
          }
        });
        send({ type: 'scan', scanned: 1, complete: true });
      } catch (err) {
        fail(err, {});
      }
      return;
    }
    const secrets = await stores.secrets.read(ctx.kv);
    const keys = [secrets.openaiApiKey, secrets.anthropicApiKey];
    if (msg.type === 'segment' && typeof msg.audio === 'string') {
      const seq = Number(msg.seq) || 0;
      if (inFlight >= XYZ.maxInFlight) {
        send({ type: 'error', seq, message: '转写跟不上（网络慢），跳过了一句', fatal: false });
        send({ type: 'done', seq });
        return;
      }
      inFlight++;
      try {
        const cue = await transcribeXyzSegment(ctx, info, { eid: info.eid, start: Number(msg.start), end: Number(msg.end), wav: base64ToBytes(msg.audio) });
        if (cue) send({ type: 'cue', seq, cue });
      } catch (err) {
        fail(err, { seq }, keys);
      } finally {
        inFlight--;
        send({ type: 'done', seq });
      }
      return;
    }
    if (msg.type === 'text') {
      const seq = Number(msg.seq) || 0;
      try {
        const cue = await saveXyzTextCue(ctx, info, { start: Number(msg.start), end: Number(msg.end), text: String(msg.text ?? ''), ...(typeof msg.lang === 'string' ? { lang: msg.lang } : {}) });
        if (cue) send({ type: 'cue', seq, cue });
      } catch (err) {
        fail(err, { seq }, keys);
      } finally {
        send({ type: 'done', seq });
      }
      return;
    }
    if (msg.type === 'processed') {
      const from = Number(msg.from);
      const to = Number(msg.to);
      const settings = await stores.settings.read(ctx.kv);
      await markXyzDone(ctx, info, from, to, settings.xyz.asrEngine === 'browser' ? XYZ_BROWSER_ASR : settings.subtitles.asrModel.trim() || 'gpt-transcribe');
      try {
        // 一次最多 polishMaxCues 句：这一段的句子更多时分几次
        for (let i = 0; i < 4; i++) {
          const cues = await polishXyzRange(ctx, info, from, to);
          if (!cues.length) break;
          send({ type: 'cues', cues });
        }
      } catch (err) {
        fail(err, {}, keys);
        const t = await getTranscript(ctx, info.eid);
        if (t) send({ type: 'cues', cues: t.cues.filter((c) => c.start >= from - 0.05 && c.start < to) });
      }
    }
  };
}

// ── 收听记录 ──

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** 页面脚本上报的收听会话（不完全可信：只留需要的字段并校验） */
export function sanitizeListenSession(raw: unknown): WatchSession | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !isXyzId(r.videoId)) return undefined;
  const intervals = Array.isArray(r.intervals)
    ? (r.intervals as unknown[]).filter((iv): iv is [number, number] => Array.isArray(iv) && iv.length === 2 && iv.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)).slice(0, 2000)
    : [];
  return {
    id: r.id.slice(0, 64),
    videoId: r.videoId,
    startedAt: num(r.startedAt),
    updatedAt: num(r.updatedAt),
    durationSec: num(r.durationSec),
    intervals,
    playSec: num(r.playSec),
    fgSec: num(r.fgSec),
    bgSec: num(r.bgSec),
    adSec: 0,
    shorts: false,
  };
}

export async function ingestXyzListen(ctx: AppContext, raw: unknown): Promise<void> {
  const settings = await stores.settings.read(ctx.kv);
  if (!settings.xyz.enabled || !settings.xyz.tracking) return;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const session = sanitizeListenSession(r.session);
  const info = sanitizeEpisodeInfo(r.info, ctx.endpoints.xyzMedia);
  if (!session || !info || info.eid !== session.videoId || session.playSec <= 0) return;
  const lastPos = num(r.lastPos);
  const day = dayKey(session.startedAt || ctx.now(), ctx.timeZone);
  await stores.xyzListens.update(ctx.kv, ctx.locker, (log) => trimListens({ ...log, [info.eid]: applyListen(log[info.eid], session, info, day, lastPos) }));
}
