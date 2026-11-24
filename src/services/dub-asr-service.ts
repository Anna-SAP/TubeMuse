// 从配音音频识别字幕（用户 2026-11-24 要求，见 DECISIONS §91）：没有字幕文件时，把已关联的中文配音（扩展自己的 IndexedDB 里那份 m4a）
// 识别成带时间轴的字幕，存成这个配音的字幕——之后和你选的 .srt / .vtt 完全一样（同一个存储键、同一套显示）。
//   1. 读音频：从 IndexedDB 一分钟一分钟地读（core/podcast-audio.ts 的帧表 + ADTS，和小宇宙字幕同一套），交给调用方解码成 16 kHz 单声道。
//   2. 切句：按停顿切成一句一句（core/subtitles.ts 的 Segmenter）——每句的起止时间就是字幕的时间轴，按配音文件自己的时间。
//   3. 转写：一句一句发往 OpenAI（与自动字幕、小宇宙字幕同一个转写模型），提示词带配音文件名和前几句。
//   4. 校对：每攒够一批，把转写出的文字交给大模型改错字、补标点（只发文字，不发音频）。
//   5. 花费记进"字幕 $"（subtitleLedger），和自动字幕、小宇宙字幕共用每日预算：每个请求先预扣，不够就停下说明。
// 进度随时存在本机（dubAsr:<视频 ID>）：被打断（关了侧边栏、预算用完、断网、你点了停止）后可以接着识别，付过钱的句子不重来。
// 只在扩展自己的页面（侧边栏）里跑；这里不碰 DOM——解码由调用方注入（单测里换成合成的波形）。

import { DUB, SUBTITLES } from '../config/defaults';
import {
  asrCuesForDub,
  cueText,
  dubAsrPrompt,
  dubReference,
  estimateDubAsrUsd,
  insertCue,
  parseProof,
  proofAcceptable,
  settledCues,
  type DubAsrCue,
  type DubAsrDoc,
  type DubAsrEstimate,
  type DubAsrProgress,
  type DubAsrSummary,
} from '../core/dub-asr';
import type { DubRecord } from '../core/dub';
import { AudioFormatError, extractWindow, openAudio, planWindow, type AudioIndex, type RangeFetch } from '../core/podcast-audio';
import { buildDubProofPrompt, DUB_PROOF_SCHEMA } from '../core/prompts';
import { DEFAULT_SEGMENTER, Segmenter, asrCostUsd, asrPrice, encodeWav, estimateSegmentUsd, recordAsr, recordTranslation, releaseSubtitleHold, translationCostUsd, type AudioSegment, type SubtitleLedger } from '../core/subtitles';
import { clip } from '../core/text';
import { dayKey } from '../core/time';
import type { AppContext } from './context';
import { setDubSubtitles, type DubSubsSaved } from './dub-service';
import { AppError, toAppError } from './errors';
import { createTranscriber, type LlmProvider, type Transcriber } from './llm';
import { dubAsrStore, stores, type Secrets, type Settings } from './repo';
import { clearRatePause, closeFailedHold, holdSpend, rateLimited, subtitleSpend, subtitleTranslationModel, throwIfRatePaused, translationClient } from './subtitle-service';

const PROVIDER_NAMES: Record<LlmProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

/** 你点了停止（不是出错）：已经识别的留着，可以接着识别 */
export class DubAsrStopped extends Error {
  constructor() {
    super('已停止');
    this.name = 'DubAsrStopped';
  }
}

export interface DubAsrDeps {
  /**
   * 把一段音频字节（一帧一个 ADTS 头的 AAC，或 mp3 帧）解码成 16 kHz 单声道。
   * at：这段字节的第一个样本、最后一个样本对应配音的哪一秒（真正的解码器用不着；单测里据此合成波形）
   */
  decode(data: Uint8Array, at: { firstTime: number; endTime: number }): Promise<Float32Array>;
  /** 等一会儿（被限流、网络出错后重试）；signal 触发时立刻结束。不给时用 setTimeout */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface DubAsrOptions {
  signal?: AbortSignal;
  onProgress?: (p: DubAsrProgress) => void;
  /** 不接着上次的进度，从头重新识别 */
  restart?: boolean;
}

export interface DubAsrResult {
  saved: DubSubsSaved;
  summary: DubAsrSummary;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done);
  });
}

const asrModelOf = (settings: Settings): string => settings.subtitles.asrModel.trim() || 'gpt-transcribe';

function missingKey(): AppError {
  return new AppError('llm_key', '从配音音频识别字幕需要 OpenAI API Key：语音转写只能用 OpenAI（Anthropic 没有语音转文字接口）', '在设置页「1. 大模型」填写 OpenAI API Key；有字幕文件的话，直接选字幕文件不需要 Key');
}

/** 校对用哪个模型（与自动字幕的"字幕翻译模型"相同）；用不了时说明原因——这时只转写、不校对，不会悄悄换别的 */
function proofSetup(settings: Settings, secrets: Secrets): { model: string; off?: string } {
  const { provider, model } = subtitleTranslationModel(settings);
  const key = provider === 'anthropic' ? secrets.anthropicApiKey : secrets.openaiApiKey;
  return key ? { model } : { model, off: `没有填写 ${PROVIDER_NAMES[provider]} API Key（校对用的是「12. 自动字幕」里的字幕翻译模型 ${model}）` };
}

const blobRange =
  (blob: Blob): RangeFetch =>
  async (start, end) => ({ bytes: new Uint8Array(await blob.slice(start, Math.min(end + 1, blob.size)).arrayBuffer()), total: blob.size });

async function loadAudio(ctx: AppContext, rec: DubRecord): Promise<{ blob: Blob; index: AudioIndex }> {
  const blob = ctx.dubAudio ? await ctx.dubAudio.get(rec.fileId).catch(() => undefined) : undefined;
  if (!blob) throw new AppError('subtitles', '本机找不到这个配音文件', '浏览器的存储可能被清理过：在「配音」页移除它，再重新选择文件。');
  try {
    return { blob, index: await openAudio(blobRange(blob), DUB.maxMoovBytes) };
  } catch (e) {
    if (e instanceof AudioFormatError) {
      throw new AppError('subtitles', `读不出这个配音文件里的声音：${e.message}`, '识别字幕支持 m4a 里的 AAC 音频（最常见的那种）。别的编码先转一下：ffmpeg -i 原文件 -c:a aac 新文件.m4a，再在「配音」页换成新文件。');
    }
    throw e;
  }
}

// ── 开始之前给你看的：要做什么、发到哪、大约花多少 ──

export interface DubAsrPlan {
  /** 配音多长（秒）；读不出来时没有（这时 problem 里说明） */
  durationSec?: number;
  asrModel: string;
  /** 这个转写模型不在价目表里：按保守单价估算 */
  asrPriceUnknown: boolean;
  proofModel: string;
  /** 不校对的原因（没有那个提供商的 Key）；能校对时没有 */
  proofOff?: string;
  /** 还要识别的那部分（接着识别时不含已经识别的）大约花多少 */
  estimate?: DubAsrEstimate;
  /** 今天"字幕 $"还剩多少、每日预算多少 */
  remainingUsd: number;
  budgetUsd: number;
  /** 预计花费超过了今天剩下的预算：会在预算用完时停下，已识别的留着 */
  overBudget: boolean;
  /** 上次识别到一半的进度（同一份音频） */
  resume?: { doneTo: number; cues: number };
  /** 现在开始不了的原因 */
  problem?: { message: string; hint?: string };
}

export async function planDubAsr(ctx: AppContext, videoId: string): Promise<DubAsrPlan> {
  const [settings, secrets, snap, index] = await Promise.all([stores.settings.read(ctx.kv), stores.secrets.read(ctx.kv), subtitleSpend(ctx), stores.dubs.read(ctx.kv)]);
  const asrModel = asrModelOf(settings);
  const proof = proofSetup(settings, secrets);
  const base: DubAsrPlan = {
    asrModel,
    asrPriceUnknown: !asrPrice(asrModel).known,
    proofModel: proof.model,
    ...(proof.off ? { proofOff: proof.off } : {}),
    remainingUsd: snap.remainingUsd,
    budgetUsd: snap.budgetUsd,
    overBudget: false,
  };
  const rec = index[videoId];
  if (!rec) return { ...base, problem: { message: '这个视频的配音已经移除了' } };
  let durationSec: number;
  try {
    durationSec = (await loadAudio(ctx, rec)).index.duration;
  } catch (err) {
    const e = toAppError(err);
    return { ...base, problem: { message: e.message, ...(e.hint ? { hint: e.hint } : {}) } };
  }
  const doc = await dubAsrStore(videoId).read(ctx.kv);
  const resume = doc && doc.fileId === rec.fileId && doc.doneTo > 0 ? { doneTo: Math.min(doc.doneTo, durationSec), cues: settledCues(doc.cues, doc.doneTo).length } : undefined;
  const estimate = estimateDubAsrUsd(durationSec - (resume?.doneTo ?? 0), asrModel, proof.off ? undefined : proof.model);
  const key = secrets.openaiApiKey ? undefined : missingKey();
  return {
    ...base,
    durationSec,
    estimate,
    overBudget: estimate.totalUsd > snap.remainingUsd,
    ...(resume ? { resume } : {}),
    ...(key ? { problem: { message: key.message, ...(key.hint ? { hint: key.hint } : {}) } } : {}),
  };
}

// ── 识别 ──

/** 这些错重试也没用：停下来说明 */
function fatal(e: AppError): boolean {
  return e.kind === 'subtitles_budget' || e.kind === 'llm_key' || e.kind === 'llm_quota' || e.kind === 'subtitles' || (e.kind === 'llm' && /模型「/.test(e.message));
}

/**
 * 把这个视频的配音识别成字幕并存好。接着上次的进度（同一份音频），除非 restart。
 * 出错、被停止时已识别的部分留在本机（dubAsr:<视频 ID>），抛出原因；下次调用从那里接着来。
 */
export async function runDubAsr(ctx: AppContext, videoId: string, deps: DubAsrDeps, opts: DubAsrOptions = {}): Promise<DubAsrResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const { signal } = opts;
  const [settings, secrets] = await Promise.all([stores.settings.read(ctx.kv), stores.secrets.read(ctx.kv)]);
  const found = (await stores.dubs.read(ctx.kv))[videoId];
  if (!found) throw new AppError('subtitles', '这个视频的配音已经移除了，没有识别');
  const rec: DubRecord = found;
  if (!settings.dub.enabled) throw new AppError('subtitles', '中文配音已在设置中关闭');
  if (!secrets.openaiApiKey) throw missingKey();
  const keys = [secrets.openaiApiKey, secrets.anthropicApiKey];
  const { blob, index } = await loadAudio(ctx, rec);
  const durationSec = index.duration;
  if (!(durationSec > 0)) throw new AppError('subtitles', '读不出这个配音有多长，没法识别', '文件可能没写完或已损坏：重新导出一份，再在「配音」页换成新文件。');
  const asrModel = asrModelOf(settings);
  const transcriber: Transcriber = createTranscriber({ model: asrModel, apiKey: secrets.openaiApiKey, baseURL: ctx.endpoints.openai, fetch: ctx.http });
  const proofCfg = proofSetup(settings, secrets);
  /** 校对停掉的原因（一开始就不能校对，或中途出了重试也没用的错） */
  let proofOff = proofCfg.off;
  const llm = proofOff ? undefined : translationClient(ctx, settings, secrets);
  const reference = dubReference(rec.fileName);

  const store = dubAsrStore(videoId);
  const old = opts.restart ? null : await store.read(ctx.kv);
  const resumed = old && old.fileId === rec.fileId ? old : null;
  /** 已经出来的句子（按开始时间排着） */
  const cues: DubAsrCue[] = resumed ? settledCues(resumed.cues, resumed.doneTo) : [];
  let doneTo = resumed ? Math.min(resumed.doneTo, durationSec) : 0;
  let readTo = doneTo;
  let spentUsd = 0;
  let waiting: string | undefined;
  /** 第一处重试也没用的错；有了它就不再发新的请求 */
  let failure: unknown;
  /** 有过人声的片段（发去转写的句数）：全片一句都没出来时，分得清是"没有人声"还是"转写出来是空的" */
  let segments = 0;

  const report = () => opts.onProgress?.({ durationSec, readTo, doneTo, cues: cues.length, proofed: cues.filter((c) => c.polished).length, spentUsd, ...(waiting ? { waiting } : {}) });
  const doc = (): DubAsrDoc => ({ videoId, fileId: rec.fileId, durationSec, asrModel, doneTo, cues: cues.map((c) => ({ ...c })), updatedAt: ctx.now() });
  /** 存进度。这个视频的配音中途被移除、换了文件时不存（那份进度已经没有主了） */
  const persist = async () => {
    const now = (await stores.dubs.read(ctx.kv))[videoId];
    if (now?.fileId === rec.fileId) await store.update(ctx.kv, ctx.locker, doc);
  };
  const halted = () => failure !== undefined || !!signal?.aborted;
  const day = () => dayKey(ctx.now(), ctx.timeZone);

  /** 发一个请求，被限流就等（服务方说等多久就等多久）、网络出错再试几次；重试也没用的错直接抛 */
  async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
    let rate = 0;
    let net = 0;
    for (;;) {
      if (halted()) throw failure ?? new DubAsrStopped();
      try {
        const r = await fn();
        if (waiting) {
          waiting = undefined;
          report();
        }
        return r;
      } catch (err) {
        const e = toAppError(err, keys);
        if (fatal(e)) throw e;
        let wait: number;
        if (e.kind === 'llm_rate' && rate < DUB.asr.rateRetries) {
          rate++;
          wait = Math.min(DUB.asr.rateWaitMaxMs, Math.max(1000, e.retryAfterMs ?? SUBTITLES.backoffBaseMs));
          waiting = `${what}被限流了，等 ${Math.ceil(wait / 1000)} 秒再继续`;
        } else if (e.kind !== 'llm_rate' && net < DUB.asr.retries) {
          net++;
          wait = DUB.asr.retryBaseMs * net;
          waiting = `${what}出错（${e.message}），${Math.ceil(wait / 1000)} 秒后重试`;
        } else throw e;
        report();
        await sleep(wait, signal);
      }
    }
  }

  // ── 转写一句 ──
  async function transcribe(seg: AudioSegment): Promise<DubAsrCue | undefined> {
    const samples = seg.samples.subarray(0, Math.round(DUB.asr.maxSegmentSec * SUBTITLES.sampleRate));
    const seconds = samples.length / SUBTITLES.sampleRate;
    const wav = encodeWav(samples, SUBTITLES.sampleRate);
    const result = await withRetry('转写', async () => {
      throwIfRatePaused(ctx);
      const prompt = dubAsrPrompt(reference, cues.filter((c) => c.start < seg.start));
      const holdId = await holdSpend(ctx, estimateSegmentUsd(asrModel, seconds, undefined), '配音字幕转写');
      try {
        const r = await transcriber.transcribe({ wav, ...(prompt ? { prompt } : {}) });
        clearRatePause(ctx);
        const billed = r.billedSeconds ?? seconds;
        await stores.subtitleLedger.update(ctx.kv, ctx.locker, (l) => recordAsr(releaseSubtitleHold(l, holdId), day(), asrModel, billed));
        spentUsd += asrCostUsd(asrModel, billed);
        return r;
      } catch (e) {
        await closeFailedHold(ctx, holdId, e);
        throw rateLimited(ctx, e);
      }
    });
    const raw = clip(result.text.replace(/\s*\n\s*/g, ' ').trim(), DUB.subs.maxCueChars);
    return raw ? { start: Number(seg.start.toFixed(3)), end: Number(Math.min(seg.end, seg.start + seconds).toFixed(3)), raw } : undefined;
  }

  // ── 校对一批 ──
  let proofing: Promise<void> | undefined;
  let proofFailNote: string | undefined;
  /** 可以校对的句子：前面的句子都回来了（doneTo 之前）、还没校对过、也没校对失败过 */
  const pendingProof = () => cues.filter((c) => c.end <= doneTo + 0.01 && !c.polished && !c.proofError);
  async function proofBatch(batch: DubAsrCue[]): Promise<void> {
    if (!llm) return;
    const first = batch[0]!.start;
    const previous = cues
      .filter((c) => c.start < first)
      .slice(-DUB.asr.proofContextCues)
      .map(cueText);
    const prompt = buildDubProofPrompt({ reference, videoTitle: rec.title ?? '', previous, segments: batch.map((c) => ({ text: c.raw })) });
    const record = (l: SubtitleLedger, usage: { inputTokens: number; outputTokens: number }) => recordTranslation(l, day(), llm.model, usage.inputTokens, usage.outputTokens, batch.length);
    try {
      const value = await withRetry('校对', async () => {
        const holdId = await holdSpend(ctx, translationCostUsd(llm.model, DUB.asr.proofEstimate.inputTokens, DUB.asr.proofMaxOutputTokens), '配音字幕校对');
        try {
          const r = await llm.generateJsonWithUsage({ system: prompt.system, user: prompt.user, schema: DUB_PROOF_SCHEMA, schemaName: 'tubemuse_dub_proof', effort: 'low', maxOutputTokens: DUB.asr.proofMaxOutputTokens });
          await stores.subtitleLedger.update(ctx.kv, ctx.locker, (l) => record(releaseSubtitleHold(l, holdId), r.usage));
          spentUsd += translationCostUsd(llm.model, r.usage.inputTokens, r.usage.outputTokens);
          return r.value;
        } catch (e) {
          await closeFailedHold(ctx, holdId, e, record);
          throw e;
        }
      });
      const parsed = parseProof(value, prompt.refs);
      batch.forEach((c, i) => {
        const text = parsed.get(i);
        if (text === undefined) c.proofError = '大模型这次漏掉了这一句';
        else if (!proofAcceptable(c.raw, text)) c.proofError = '校对结果和原文差得太多，没有采用';
        else {
          c.text = text;
          c.polished = true;
        }
      });
    } catch (err) {
      if (err instanceof DubAsrStopped) return;
      const e = toAppError(err, keys);
      // 预算用完：转写也发不出去了，整个停下。别的错不影响转写——这一批用原文，说明原因
      if (e.kind === 'subtitles_budget') {
        failure ??= e;
        return;
      }
      for (const c of batch) c.proofError = e.message;
      proofFailNote = e.message;
      // Key 不对、账户没额度、模型名不对：后面每一批都会同样失败，不再一批批去试
      if (fatal(e)) proofOff = e.message;
    }
  }
  /** 攒够一批就校对（一次只校一批，一批接一批）；all：收尾时把剩下不满一批的也校完 */
  async function proofLoop(all: boolean): Promise<void> {
    for (;;) {
      if (halted() || proofOff) return;
      const todo = pendingProof();
      if (!todo.length || (!all && todo.length < DUB.asr.proofBatch)) return;
      await proofBatch(todo.slice(0, DUB.asr.proofBatch));
      await persist();
      report();
    }
  }
  function kickProof(all = false): Promise<void> {
    if (proofing) return proofing;
    const run = proofLoop(all)
      // 校对这一路上存进度出错（本机存储满了之类）：和转写那一路一样，停下来说明
      .catch((e: unknown) => {
        failure ??= e;
      })
      .finally(() => {
        if (proofing === run) proofing = undefined;
      });
    proofing = run;
    return run;
  }

  // ── 读音频、切句、排队转写 ──
  /** 按顺序排着的句子：前面的都回来了，"已识别到"才能往前推 */
  const order: { end: number; settled: boolean }[] = [];
  let settledUpTo = 0;
  const inFlight = new Set<Promise<void>>();
  let sinceSave = 0;
  const advance = () => {
    while (settledUpTo < order.length && order[settledUpTo]!.settled) doneTo = Math.max(doneTo, Math.min(durationSec, order[settledUpTo++]!.end));
  };
  const launch = (seg: AudioSegment) => {
    const entry = { end: seg.end, settled: false };
    order.push(entry);
    segments++;
    const p = (async () => {
      try {
        const cue = await transcribe(seg);
        if (cue) insertCue(cues, cue);
        entry.settled = true;
        advance();
        if (++sinceSave >= DUB.asr.saveEvery) {
          sinceSave = 0;
          await persist();
        }
        void kickProof();
        report();
      } catch (e) {
        if (!(e instanceof DubAsrStopped)) failure ??= e;
      }
    })().finally(() => inFlight.delete(p));
    inFlight.add(p);
  };

  const sr = SUBTITLES.sampleRate;
  const segmenter = new Segmenter({ ...DEFAULT_SEGMENTER, ...DUB.asr.segmenter });
  const queue: AudioSegment[] = [];
  report();
  try {
    for (let t = doneTo; t < durationSec - 1e-6 && !halted(); ) {
      const t1 = Math.min(durationSec, t + DUB.asr.windowSec);
      let pcm: Float32Array;
      /** 解码出来的第 0 个样本对应配音的哪一秒（为了暖解码器多读的那几帧在最前面） */
      let at: number;
      try {
        const plan = planWindow(index, t, t1);
        const bytes = new Uint8Array(await blob.slice(plan.start, plan.end + 1).arrayBuffer());
        const w = extractWindow(index, plan, bytes, t1);
        pcm = await deps.decode(w.data, { firstTime: w.firstTime, endTime: w.endTime });
        at = w.firstTime;
      } catch (e) {
        throw e instanceof AudioFormatError ? new AppError('subtitles', `读配音文件的声音出错（${e.message}）`, '文件可能损坏了：在「配音」页换一个文件再试。') : e instanceof AppError ? e : new AppError('subtitles', `解码配音的声音出错（${e instanceof Error ? e.message : String(e)}）`, '识别字幕支持 m4a 里的 AAC 音频。别的编码先转一下：ffmpeg -i 原文件 -c:a aac 新文件.m4a');
      }
      // 只留 [t, t1) 这一窗：和上一窗、下一窗正好接上，连续喂给同一个切句器（一句话跨着两窗也不会被切开）
      const from = Math.max(0, Math.round((t - at) * sr));
      const samples = pcm.subarray(Math.min(pcm.length, from), Math.min(pcm.length, from + Math.round((t1 - t) * sr)));
      const last = t1 >= durationSec - 1e-6;
      if (samples.length) queue.push(...segmenter.push({ samples, videoTime: t + samples.length / sr, rate: 1 }));
      if (last) queue.push(...segmenter.flush());
      t = t1;
      readTo = t1;
      report();
      // 转写比解码慢得多：在途的满了就等，不把整段音频都解出来堆在内存里
      for (let seg = queue.shift(); seg; seg = queue.shift()) {
        if (seg.end - seg.start < DUB.asr.minSegmentSec) continue;
        while (inFlight.size >= DUB.asr.maxInFlight && !halted()) await Promise.race(inFlight);
        if (halted()) break;
        launch(seg);
      }
    }
    await Promise.all(inFlight);
    if (!halted()) {
      // 全片读完、每一句都回来了
      doneTo = durationSec;
      // 正在校的那一批先等它完，再把剩下的都校完
      await proofing;
      await kickProof(true);
    }
  } catch (e) {
    failure ??= e;
  }
  // 停下之前：在途的请求等它们回来（钱已经花了，结果要留着）
  await Promise.allSettled([...inFlight]);
  await proofing;
  if (failure === undefined && signal?.aborted) failure = new DubAsrStopped();
  if (failure !== undefined) {
    await persist().catch(() => undefined);
    report();
    throw failure instanceof DubAsrStopped ? failure : toAppError(failure, keys);
  }
  report();

  if (!cues.length) {
    await ctx.kv.remove(store.key);
    throw segments
      ? new AppError('subtitles', '转写结果是空的：这段配音里没认出话来', '确认这个文件里是人说话的声音（不是纯音乐）；也可以在设置页「12. 自动字幕」换一个转写模型再试。')
      : new AppError('subtitles', '这段配音里没有找到人声', '声音可能太小或整段是静音：换一个音量正常的文件再试。这一次没有发出转写请求，没有花钱。');
  }
  const saved = await saveAsSubtitles(ctx, rec, cues);
  await ctx.kv.remove(store.key);
  const unproofed = cues.filter((c) => !c.polished).length;
  return {
    saved,
    summary: { count: saved.meta.count, unproofed, ...(unproofed ? { proofNote: proofCfg.off ?? proofFailNote ?? '大模型漏掉了，或校对结果和原文差得太多' } : {}), spentUsd, durationSec },
  };
}

/** 存成这个配音的字幕：和字幕文件同一条路（setDubSubtitles → dubSubs:<视频 ID>）。配音中途换了文件、被移除时不存 */
async function saveAsSubtitles(ctx: AppContext, rec: DubRecord, cues: readonly DubAsrCue[]): Promise<DubSubsSaved> {
  const now = (await stores.dubs.read(ctx.kv))[rec.videoId];
  if (!now || now.fileId !== rec.fileId) throw new AppError('subtitles', '识别的时候这个视频的配音被移除或换了文件，结果没有存', '对着现在的配音文件重新识别。');
  const saved = await setDubSubtitles(ctx, rec.videoId, { name: rec.fileName, cues: asrCuesForDub(cues), source: 'asr' });
  if (!saved) throw new AppError('subtitles', '这个视频的配音已经移除了，字幕没有存');
  return saved;
}

/** 识别到一半的进度（这个视频现在这份音频的）；没有时 null */
export async function readDubAsrProgress(ctx: AppContext, videoId: string): Promise<DubAsrDoc | null> {
  const [doc, index] = await Promise.all([dubAsrStore(videoId).read(ctx.kv), stores.dubs.read(ctx.kv)]);
  return doc && index[videoId]?.fileId === doc.fileId && doc.doneTo > 0 ? doc : null;
}

/**
 * 先用已识别的那部分：把识别到一半的句子存成这个配音的字幕（后面没识别的地方没有字幕）。
 * 进度留着——之后还可以接着识别，识别完会换成完整的
 */
export async function savePartialDubAsr(ctx: AppContext, videoId: string): Promise<DubAsrResult> {
  const rec = (await stores.dubs.read(ctx.kv))[videoId];
  const doc = await dubAsrStore(videoId).read(ctx.kv);
  if (!rec || !doc || doc.fileId !== rec.fileId) throw new AppError('subtitles', '没有识别到一半的字幕可用');
  const cues = settledCues(doc.cues, doc.doneTo);
  if (!cues.length) throw new AppError('subtitles', '已识别的那部分里还没有一句话', '接着识别一会儿再用。');
  const saved = await saveAsSubtitles(ctx, rec, cues);
  const unproofed = cues.filter((c) => !c.polished).length;
  return { saved, summary: { count: saved.meta.count, unproofed, ...(unproofed ? { proofNote: '识别被打断时还没轮到校对' } : {}), spentUsd: 0, partialTo: doc.doneTo, durationSec: doc.durationSec } };
}

/** 丢掉识别到一半的进度（已经存成字幕的不受影响） */
export async function discardDubAsr(ctx: AppContext, videoId: string): Promise<void> {
  await ctx.kv.remove(dubAsrStore(videoId).key);
}
