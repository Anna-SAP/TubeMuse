// 自动字幕的后台流程：内容脚本切好一段音频 → 预算护栏 → OpenAI 转写 → 存字幕、回传原文 → 翻译 → 回传译文 → 记账。
// 音频只在内存里经过一次：发给 OpenAI 后即丢弃，不落盘、不进导出。字幕文字存本机，回看时直接用，不再花钱。

import { SUBTITLE_LANGS, SUBTITLES } from '../config/defaults';
import { buildSubtitleTranslationPrompt, SUBTITLE_TRANSLATION_SCHEMA } from '../core/prompts';
import {
  backoffMs,
  base64ToBytes,
  estimateSegmentUsd,
  isCovered,
  putCue,
  recognitionLangFor,
  tracksToDrop,
  recordAsr,
  recordTranslation,
  subtitleSnapshot,
  translationCostUsd,
  translationTarget,
  wavInfo,
  type RecognitionPlan,
  type SubtitleDown,
  type SubtitleSnapshot,
  type SubtitleUp,
} from '../core/subtitles';
import { OperationBudget } from '../core/quota';
import { clip } from '../core/text';
import { dayKey, nextMidnight } from '../core/time';
import type { SubtitleCue, SubtitleTrack } from '../core/types';
import type { AppContext } from './context';
import { AppError, toAppError } from './errors';
import { makeCharger, makeExhaustedMarker } from './quota-service';
import { createYouTube } from './youtube';
import { createLlmClient, createTranscriber, type LlmProvider } from './llm';
import { stores, subtitleTrackStore, type Secrets, type Settings } from './repo';

const PROVIDER_NAMES: Record<LlmProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

/** 进行中的请求预留的花费：多个标签页同时出字幕时也守住每日预算（只在后台这一个 service worker 里计数） */
let reservedUsd = 0;

/**
 * 被 OpenAI 限流后的暂停：所有标签页共用（限额按组织 / 项目算，不按标签页）。
 * 官方：被拒的请求也计入每分钟上限，所以暂停期间一个请求都不发，否则会一直被拒。
 */
const rateLimitPauses = new WeakMap<AppContext, { until: number; failures: number; reason: string; hint?: string }>();

export async function subtitleSpend(ctx: AppContext): Promise<SubtitleSnapshot> {
  const [settings, ledger] = await Promise.all([stores.settings.read(ctx.kv), stores.subtitleLedger.read(ctx.kv)]);
  const now = ctx.now();
  return subtitleSnapshot(ledger, settings.subtitles.dailyBudgetUsd, settings.quota.warnRatio, dayKey(now, ctx.timeZone), nextMidnight(now, ctx.timeZone), reservedUsd);
}

/** 字幕翻译用哪个模型：设置里单独填了就用它，否则跟随"1. 大模型"当前提供商的模型 */
export function subtitleTranslationModel(settings: Settings): { provider: LlmProvider; model: string } {
  const provider = settings.llm.provider;
  const model = settings.subtitles.translationModels[provider].trim() || settings.llm.models[provider].trim();
  return { provider, model };
}

export async function getSubtitleTrack(ctx: AppContext, videoId: string): Promise<SubtitleTrack | undefined> {
  return (await subtitleTrackStore(videoId).read(ctx.kv)) ?? undefined;
}

/** 存一句字幕；有字幕的视频超过上限时删掉最久没更新的那些 */
async function saveCue(ctx: AppContext, videoId: string, cue: SubtitleCue, asrModel: string | undefined): Promise<void> {
  const now = ctx.now();
  await subtitleTrackStore(videoId).update(ctx.kv, ctx.locker, (t) => putCue(t, videoId, cue, asrModel ?? t?.asrModel ?? '', now));
  const index = await stores.subtitleIndex.update(ctx.kv, ctx.locker, (i) => ({ ...i, [videoId]: now }));
  const drop = tracksToDrop(index);
  if (!drop.length) return;
  for (const id of drop) await ctx.kv.remove(subtitleTrackStore(id).key);
  await stores.subtitleIndex.update(ctx.kv, ctx.locker, (i) => Object.fromEntries(Object.entries(i).filter(([id]) => !drop.includes(id))));
}

function budgetError(snap: SubtitleSnapshot): AppError {
  return new AppError(
    'subtitles_budget',
    `今天的字幕花费已到上限（已用 $${snap.spentUsd.toFixed(3)} / $${snap.budgetUsd.toFixed(2)}），已停止识别`,
    '可以在设置页「12. 自动字幕」调高每日预算；本地时间 0 点自动恢复',
  );
}

function missingOpenAiKey(): AppError {
  return new AppError(
    'llm_key',
    '自动字幕需要 OpenAI API Key：语音转写只能用 OpenAI（Anthropic 没有语音转文字接口）',
    '在设置页「1. 大模型」填写 OpenAI API Key；找片等其他功能可以继续用 Anthropic',
  );
}

async function reserve<T>(ctx: AppContext, usd: number, fn: () => Promise<T>): Promise<T> {
  const snap = await subtitleSpend(ctx);
  if (snap.remainingUsd < usd) throw budgetError(snap);
  reservedUsd += usd;
  try {
    return await fn();
  } finally {
    reservedUsd = Math.max(0, reservedUsd - usd);
  }
}

/**
 * 浏览器识别用哪种语言。设置为"自动"时：先看缓存的视频元数据；没有就用官方 API 查一次（videos.list，1 unit，
 * 结果和观看记录共用一份缓存）；没连接 YouTube 或查不到时按标题推断或用默认值，并说明原因。
 */
export async function recognitionPlan(ctx: AppContext, videoId: string): Promise<RecognitionPlan> {
  const settings = await stores.settings.read(ctx.kv);
  const setting = settings.subtitles.browserLang;
  if (setting !== 'auto') return recognitionLangFor(setting, undefined);
  let meta = (await stores.videoMeta.read(ctx.kv))[videoId];
  let note: string | undefined;
  if (!meta) {
    if ((await ctx.auth.status()) !== 'connected') {
      note = '没有连接 YouTube（或授权已过期），读不到视频的语言，先按简体中文识别；不对的话在侧边栏"字幕"页换一种';
    } else {
      try {
        const yt = createYouTube({
          http: ctx.http,
          auth: ctx.auth,
          baseUrl: ctx.endpoints.youtubeApi,
          charge: makeCharger(ctx, new OperationBudget({ searchCalls: 0, generalUnits: 1 }, '读取视频语言（自动字幕）'), settings.quota),
          onQuotaExhausted: makeExhaustedMarker(ctx),
        });
        const [found] = await yt.videoMetas([videoId], ctx.now());
        if (found) {
          meta = found;
          await stores.videoMeta.update(ctx.kv, ctx.locker, (m) => ({ ...m, [videoId]: found }));
        }
      } catch (e) {
        note = `读不到视频的语言（${toAppError(e).message}），先按简体中文识别；不对的话在侧边栏"字幕"页换一种`;
      }
    }
  }
  return recognitionLangFor('auto', meta && !meta.missing ? meta : undefined, note);
}

export interface TextCueInput {
  videoId: string;
  start: number;
  end: number;
  text: string;
  lang?: string;
}

/** 浏览器识别出的一行：存成字幕（不花转写费）；这段已有字幕时返回 undefined */
export async function saveTextCue(ctx: AppContext, input: TextCueInput): Promise<SubtitleCue | undefined> {
  const settings = await stores.settings.read(ctx.kv);
  if (!settings.subtitles.enabled) throw new AppError('subtitles', '自动字幕已在设置中关闭');
  const text = typeof input.text === 'string' ? clip(input.text.trim(), SUBTITLES.cueMaxChars) : '';
  const ok =
    VIDEO_ID.test(input.videoId) && Number.isFinite(input.start) && Number.isFinite(input.end) && input.start >= 0 && input.end > input.start && input.end - input.start <= 120 && !!text;
  if (!ok) throw new AppError('subtitles', '收到的字幕格式不对，已丢弃', '刷新 YouTube 页面后再试；如果反复出现，请把这条提示告诉开发者');
  const track = await getSubtitleTrack(ctx, input.videoId);
  if (track && isCovered(track.cues, input.start, input.end)) return undefined;
  const cue: SubtitleCue = {
    id: `${input.videoId}:${Math.round(input.start * 1000)}`,
    start: input.start,
    end: input.end,
    text,
    ...(typeof input.lang === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.lang) ? { lang: input.lang } : {}),
    createdAt: ctx.now(),
  };
  await saveCue(ctx, input.videoId, cue, BROWSER_ASR_MODEL);
  return cue;
}

/** 存在字幕里的"转写模型"名：浏览器识别 */
export const BROWSER_ASR_MODEL = 'browser-speech';

export interface SegmentInput {
  videoId: string;
  start: number;
  end: number;
  wav: Uint8Array;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

/** 校验内容脚本送来的片段：只接受本扩展自己编码的 16 kHz 单声道 WAV，且长度不超过切段上限 */
export function validateSegment(input: SegmentInput): { durationSec: number } {
  const info = wavInfo(input.wav);
  const ok =
    VIDEO_ID.test(input.videoId) &&
    Number.isFinite(input.start) &&
    Number.isFinite(input.end) &&
    input.start >= 0 &&
    input.end > input.start &&
    !!info &&
    info.sampleRate === SUBTITLES.sampleRate &&
    info.durationSec > 0 &&
    info.durationSec <= SUBTITLES.maxSegmentSec + 1;
  if (!ok || !info) throw new AppError('subtitles', '收到的音频片段格式不对，已丢弃', '刷新 YouTube 页面后再试；如果反复出现，请把这条提示告诉开发者');
  return { durationSec: info.durationSec };
}

/** 识别一段：返回存好的字幕（原文）；这段已有字幕时返回 undefined（不花钱） */
export async function transcribeSegment(ctx: AppContext, input: SegmentInput): Promise<SubtitleCue | undefined> {
  const [settings, secrets] = await Promise.all([stores.settings.read(ctx.kv), stores.secrets.read(ctx.kv)]);
  if (!settings.subtitles.enabled) throw new AppError('subtitles', '自动字幕已在设置中关闭');
  const { durationSec } = validateSegment(input);
  if (!secrets.openaiApiKey) throw missingOpenAiKey();
  const track = await getSubtitleTrack(ctx, input.videoId);
  if (track && isCovered(track.cues, input.start, input.end)) return undefined;

  const asrModel = settings.subtitles.asrModel.trim() || 'gpt-transcribe';
  const translateModel = settings.subtitles.translate ? subtitleTranslationModel(settings).model : undefined;
  const before = (track?.cues ?? []).filter((c) => c.text && c.start < input.start);
  const prompt = before
    .slice(-SUBTITLES.translationContextCues)
    .map((c) => c.text)
    .join(' ')
    .slice(-SUBTITLES.asrPromptChars);

  const pause = rateLimitPauses.get(ctx);
  if (pause && ctx.now() < pause.until) {
    const left = pause.until - ctx.now();
    throw new AppError('llm_rate', pause.reason, `暂停期间不发请求（被拒的请求也计入每分钟上限），还要等 ${Math.ceil(left / 1000)} 秒；这期间的句子先跳过，拖回去重看时会补上`, left);
  }

  let result: Awaited<ReturnType<ReturnType<typeof createTranscriber>['transcribe']>>;
  try {
    result = await reserve(ctx, estimateSegmentUsd(asrModel, durationSec, translateModel), () =>
      createTranscriber({ model: asrModel, apiKey: secrets.openaiApiKey!, baseURL: ctx.endpoints.openai, fetch: ctx.http }).transcribe({
        wav: input.wav,
        ...(prompt ? { prompt } : {}),
      }),
    );
  } catch (e) {
    if (e instanceof AppError && e.kind === 'llm_rate') {
      const failures = (rateLimitPauses.get(ctx)?.failures ?? 0) + 1;
      const wait = backoffMs(failures, e.retryAfterMs);
      rateLimitPauses.set(ctx, { until: ctx.now() + wait, failures, reason: e.message });
      throw new AppError('llm_rate', e.message, `暂停 ${Math.ceil(wait / 1000)} 秒再继续（被拒的请求也计入每分钟上限，连续重发只会一直被拒）。${e.hint ?? ''}`, wait);
    }
    throw e;
  }
  rateLimitPauses.delete(ctx);
  const now = ctx.now();
  await stores.subtitleLedger.update(ctx.kv, ctx.locker, (l) => recordAsr(l, dayKey(now, ctx.timeZone), asrModel, result.billedSeconds ?? durationSec));

  const cue: SubtitleCue = {
    id: `${input.videoId}:${Math.round(input.start * 1000)}`,
    start: input.start,
    end: input.end,
    text: clip(result.text, SUBTITLES.cueMaxChars),
    ...(result.language ? { lang: result.language } : {}),
    createdAt: now,
  };
  await saveCue(ctx, input.videoId, cue, asrModel);
  return cue;
}

function translationClient(ctx: AppContext, settings: Settings, secrets: Secrets) {
  const { provider, model } = subtitleTranslationModel(settings);
  const apiKey = provider === 'anthropic' ? secrets.anthropicApiKey : secrets.openaiApiKey;
  if (!apiKey) throw new AppError('llm_key', `没有填写 ${PROVIDER_NAMES[provider]} API Key，第二行不翻译`, '在设置页「1. 大模型」填写');
  return createLlmClient({
    provider,
    model,
    apiKey,
    ...(provider === 'anthropic' && secrets.anthropicWorkspaceId ? { workspaceId: secrets.anthropicWorkspaceId } : {}),
    baseURL: provider === 'anthropic' ? ctx.endpoints.anthropic : ctx.endpoints.openai,
    fetch: ctx.http,
  });
}

/**
 * 给一句字幕补上第二行。翻译失败不影响原文：失败原因写进 translationError，界面照常显示原文并说明原因。
 * 不需要翻译（关掉了翻译、原文已是两种目标语言、这段没有人声）时原样返回。
 */
export async function translateCue(ctx: AppContext, videoId: string, cue: SubtitleCue): Promise<SubtitleCue> {
  const [settings, secrets] = await Promise.all([stores.settings.read(ctx.kv), stores.secrets.read(ctx.kv)]);
  if (!settings.subtitles.translate || !cue.text) return cue;
  const target = translationTarget(cue.lang, cue.text, settings.subtitles.targetLang, settings.subtitles.altTargetLang);
  if (!target) return cue;
  let next: SubtitleCue;
  try {
    const llm = translationClient(ctx, settings, secrets);
    const track = await getSubtitleTrack(ctx, videoId);
    const previous = (track?.cues ?? [])
      .filter((c) => c.text && c.start < cue.start)
      .slice(-SUBTITLES.translationContextCues)
      .map((c) => c.text);
    const prompt = buildSubtitleTranslationPrompt({ text: cue.text, previous, targetName: SUBTITLE_LANGS[target] });
    const e = SUBTITLES.translationEstimate;
    const { value, usage } = await reserve(ctx, translationCostUsd(llm.model, e.inputTokens, e.outputTokens), () =>
      llm.generateJsonWithUsage({ ...prompt, schema: SUBTITLE_TRANSLATION_SCHEMA, schemaName: 'tubemuse_subtitle', effort: 'low' }),
    );
    const now = ctx.now();
    await stores.subtitleLedger.update(ctx.kv, ctx.locker, (l) => recordTranslation(l, dayKey(now, ctx.timeZone), llm.model, usage.inputTokens, usage.outputTokens));
    const text = typeof (value as { translation?: unknown })?.translation === 'string' ? (value as { translation: string }).translation.trim() : '';
    if (!text) throw new AppError('llm', '模型没有给出译文');
    next = { ...cue, translation: clip(text, SUBTITLES.cueMaxChars), translationLang: target };
    delete next.translationError;
  } catch (err) {
    const e = toAppError(err, [secrets.anthropicApiKey, secrets.openaiApiKey]);
    next = { ...cue, translationError: e.message };
  }
  await saveCue(ctx, videoId, next, undefined);
  return next;
}

// ── 与内容脚本的会话（后台用 chrome.runtime.Port 接上；单测直接调用） ──

/** 这些错误不是这一段的问题：再识别下一段也会失败，内容脚本应停下并提示，等你改了设置再继续 */
function isFatal(e: AppError): boolean {
  return e.kind === 'subtitles_budget' || e.kind === 'llm_key' || e.kind === 'llm_quota' || /已在设置中关闭|模型「/.test(e.message);
}

export { SUBTITLE_PORT } from '../core/subtitles';

export function subtitleSession(ctx: AppContext, send: (m: SubtitleDown) => void): (msg: unknown) => Promise<void> {
  let inFlight = 0;
  return async (raw) => {
    const msg = raw as Partial<SubtitleUp> | undefined;
    const videoId = typeof msg?.videoId === 'string' ? msg.videoId : '';
    if (!VIDEO_ID.test(videoId)) return;
    if (msg?.type === 'hello') {
      const [track, settings] = await Promise.all([getSubtitleTrack(ctx, videoId), stores.settings.read(ctx.kv)]);
      const recognition = settings.subtitles.asrEngine === 'browser' ? await recognitionPlan(ctx, videoId) : undefined;
      send({ type: 'track', videoId, cues: track?.cues ?? [], ...(recognition ? { recognition } : {}) });
      return;
    }
    if (msg?.type === 'text') {
      const seq = Number(msg.seq) || 0;
      const secrets = await stores.secrets.read(ctx.kv);
      try {
        const cue = await saveTextCue(ctx, { videoId, start: Number(msg.start), end: Number(msg.end), text: String(msg.text ?? ''), ...(typeof msg.lang === 'string' ? { lang: msg.lang } : {}) });
        if (!cue) return;
        send({ type: 'cue', videoId, seq, cue, stage: 'source' });
        const translated = await translateCue(ctx, videoId, cue);
        if (translated !== cue) send({ type: 'cue', videoId, seq, cue: translated, stage: 'translated' });
      } catch (err) {
        const e = toAppError(err, [secrets.openaiApiKey, secrets.anthropicApiKey]);
        send({ type: 'error', videoId, seq, message: e.message, ...(e.hint ? { hint: e.hint } : {}), fatal: isFatal(e) });
      } finally {
        send({ type: 'done', videoId, seq });
      }
      return;
    }
    if (msg?.type !== 'segment' || typeof msg.audio !== 'string') return;
    const seq = Number(msg.seq) || 0;
    if (inFlight >= SUBTITLES.maxInFlight) {
      send({ type: 'error', videoId, seq, message: '识别跟不上播放（网络慢或倍速太高），跳过了一段', fatal: false });
      send({ type: 'done', videoId, seq });
      return;
    }
    inFlight++;
    const secrets = await stores.secrets.read(ctx.kv);
    try {
      const cue = await transcribeSegment(ctx, { videoId, start: Number(msg.start), end: Number(msg.end), wav: base64ToBytes(msg.audio) });
      if (!cue) return;
      send({ type: 'cue', videoId, seq, cue, stage: 'source' });
      const translated = await translateCue(ctx, videoId, cue);
      if (translated !== cue) send({ type: 'cue', videoId, seq, cue: translated, stage: 'translated' });
    } catch (err) {
      const e = toAppError(err, [secrets.openaiApiKey, secrets.anthropicApiKey]);
      send({ type: 'error', videoId, seq, message: e.message, ...(e.hint ? { hint: e.hint } : {}), fatal: isFatal(e), ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) });
    } finally {
      inFlight--;
      send({ type: 'done', videoId, seq });
    }
  };
}
