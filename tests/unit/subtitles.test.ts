// 自动字幕：人声切段、WAV、原生字幕判定、翻译目标、显示时机、回看去重、花费记账，以及后台转写 → 翻译 → 记账的完整流程（mock OpenAI / Anthropic）。

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SUBTITLES } from '../../src/config/defaults';
import { ENDPOINTS } from '../../src/config/endpoints';
import {
  DEFAULT_SEGMENTER,
  LiveTranscript,
  Segmenter,
  liveView,
  recognitionLangFor,
  speechErrorInfo,
  base64ToBytes,
  bytesToBase64,
  encodeWav,
  formatAudioDuration,
  formatUsd,
  hourlyEstimateUsd,
  isCovered,
  nativeCaptionsState,
  pickCue,
  putCue,
  tracksToDrop,
  recordAsr,
  recordTranslation,
  subtitleSnapshot,
  translationTarget,
  wavInfo,
  type AudioSegment,
  type SubtitleDown,
} from '../../src/core/subtitles';
import type { SubtitleCue } from '../../src/core/types';
import type { AuthProvider } from '../../src/services/auth';
import type { AppContext } from '../../src/services/context';
import { AppError } from '../../src/services/errors';
import { createLlmClient, retryAfterMs } from '../../src/services/llm';
import { mergeSettings, stores, subtitleTrackStore } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';
import { recognitionPlan, saveTextCue, subtitleSession, subtitleSpend, subtitleTranslationModel, transcribeSegment, translateCue, validateSegment } from '../../src/services/subtitle-service';
import { mapVideoMeta } from '../../src/services/youtube-mappers';

const RATE = SUBTITLES.sampleRate;
const NOW = Date.parse('2026-11-01T04:00:00Z'); // 北京时间 12:00
const OPENAI_KEY = 'sk-proj-subtitleTestKey0123456789abcdefghijklmnop';
const ANTHROPIC_KEY = 'sk-ant-subtitle-test-0123456789abcdefghijklmn';

/** 一段"人声"（带谐波的正弦，能量明显高于阈值）或静音 */
function tone(sec: number, amp = 0.25): Float32Array {
  const n = Math.round(sec * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * (Math.sin((2 * Math.PI * 220 * i) / RATE) * 0.7 + Math.sin((2 * Math.PI * 660 * i) / RATE) * 0.3);
  return out;
}
const silence = (sec: number) => new Float32Array(Math.round(sec * RATE));

/** 像 ScriptProcessor 一样按 4096 个样本一块喂进去；videoStart 是第一块开始时的视频时间 */
function feed(seg: Segmenter, parts: Float32Array[], videoStart = 0, rate = 1, block = 4096): AudioSegment[] {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const out: AudioSegment[] = [];
  for (let i = 0; i < all.length; i += block) {
    const chunk = all.slice(i, i + block);
    out.push(...seg.push({ samples: chunk, videoTime: videoStart + ((i + chunk.length) / RATE) * rate, rate }));
  }
  return out;
}

describe('人声切段', () => {
  it('说完一句（停顿）就交出去：时间是视频时间，带一小段前导，末尾只留一小段静音', () => {
    const segs = feed(new Segmenter(), [silence(1), tone(2), silence(1)]);
    expect(segs).toHaveLength(1);
    const s = segs[0]!;
    expect(s.start).toBeGreaterThan(0.7);
    expect(s.start).toBeLessThan(1.01);
    expect(s.end).toBeGreaterThan(2.95);
    expect(s.end).toBeLessThan(3.35);
    expect(s.speechSec).toBeGreaterThan(1.9);
    expect(s.samples.length / RATE).toBeCloseTo(s.end - s.start, 1);
  });

  it('咳嗽一样的短声音不上传（不花钱）', () => {
    expect(feed(new Segmenter(), [silence(0.5), tone(0.12), silence(1.5)])).toHaveLength(0);
  });

  it('两小句之间停顿很短时合并成一段，减少碎片', () => {
    const segs = feed(new Segmenter(), [silence(0.3), tone(0.6), silence(0.5), tone(0.8), silence(1.2)]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.end - segs[0]!.start).toBeGreaterThan(1.8);
  });

  it('一直不停顿：每段不超过上限，在最安静处切开，几乎不丢音频', () => {
    // 20 秒连续说话，中间音量有起伏
    const parts: Float32Array[] = [];
    for (let i = 0; i < 20; i++) parts.push(tone(1, i % 3 === 2 ? 0.05 : 0.3));
    const segs = feed(new Segmenter(), [...parts, silence(1)]);
    expect(segs.length).toBeGreaterThanOrEqual(3);
    for (const s of segs) expect(s.samples.length / RATE).toBeLessThanOrEqual(SUBTITLES.maxSegmentSec + 0.05);
    const covered = segs.reduce((n, s) => n + (s.end - s.start), 0);
    expect(covered).toBeGreaterThan(19.5);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.start).toBeGreaterThanOrEqual(segs[i - 1]!.end - 0.05);
  });

  it('2 倍速播放：1 秒音频对应 2 秒视频', () => {
    const segs = feed(new Segmenter(), [silence(1), tone(2), silence(1)], 10, 2);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.start).toBeGreaterThan(11.5);
    expect(segs[0]!.end).toBeGreaterThan(15.9);
    expect(segs[0]!.end).toBeLessThan(16.7);
  });

  it('拖动进度条：先交出跳转前说的那部分，再从新位置重新开始', () => {
    const seg = new Segmenter();
    const before = feed(seg, [silence(0.5), tone(1.5)], 0);
    expect(before).toHaveLength(0);
    // 跳到 100 秒处继续说话
    const after = feed(seg, [tone(2), silence(1)], 100);
    expect(after).toHaveLength(2);
    expect(after[0]!.end).toBeLessThan(2.1);
    expect(after[1]!.start).toBeGreaterThanOrEqual(99.9);
  });

  it('暂停、换视频时 flush 交出没说完的一句', () => {
    const seg = new Segmenter();
    expect(feed(seg, [tone(1.2)])).toHaveLength(0);
    const out = seg.flush();
    expect(out).toHaveLength(1);
    expect(seg.flush()).toHaveLength(0);
  });

  it('默认参数来自配置', () => {
    expect(DEFAULT_SEGMENTER.maxSegmentSec).toBe(SUBTITLES.maxSegmentSec);
    expect(DEFAULT_SEGMENTER.sampleRate).toBe(16_000);
  });
});

describe('WAV 与传输', () => {
  it('编码出 16 kHz 单声道 16-bit WAV，能读回时长；base64 往返无损', () => {
    const wav = encodeWav(tone(1.5), RATE);
    expect(wavInfo(wav)).toEqual({ sampleRate: RATE, durationSec: 1.5 });
    const back = base64ToBytes(bytesToBase64(wav));
    expect(back).toEqual(wav);
  });

  it('拒收不是本扩展编码的数据', () => {
    expect(wavInfo(new Uint8Array(10))).toBeUndefined();
    const wav = encodeWav(tone(0.5), RATE);
    expect(wavInfo(wav.slice(0, wav.length - 2))).toBeUndefined();
    const fake = new TextEncoder().encode('RIFF....WAVEfmt ' + 'x'.repeat(40));
    expect(wavInfo(fake)).toBeUndefined();
  });
});

describe('原生字幕判定（2026-11 实测的按钮属性，与界面语言无关）', () => {
  it('没有字幕：提示文字与按钮名完全相同', () => {
    expect(nativeCaptionsState({ tooltip: 'Subtitles/closed captions unavailable', title: 'Subtitles/closed captions unavailable', pressed: 'false' })).toBe('unavailable');
    expect(nativeCaptionsState({ tooltip: '字幕不可用', title: '字幕不可用', pressed: 'false' })).toBe('unavailable');
  });
  it('有字幕：提示文字带快捷键后缀，或正在显示字幕', () => {
    expect(nativeCaptionsState({ tooltip: 'Subtitles/closed captions (c)', title: 'Subtitles/closed captions', pressed: 'false' })).toBe('available');
    expect(nativeCaptionsState({ tooltip: '字幕 (c)', title: '字幕', pressed: 'false' })).toBe('available');
    // 实测：有字幕的视频上 aria-label 可能残留 "unavailable"，以提示文字与 aria-pressed 为准
    expect(nativeCaptionsState({ tooltip: 'Subtitles/closed captions (c)', title: 'Subtitles/closed captions', pressed: 'true' })).toBe('available');
  });
  it('判断不了就不自动开启', () => {
    expect(nativeCaptionsState(null)).toBe('unknown');
    expect(nativeCaptionsState({ tooltip: null, title: 'x' })).toBe('unknown');
    expect(nativeCaptionsState({ tooltip: 'A', title: 'B' })).toBe('unknown');
  });
});

describe('双语组合：中文视频配英文，其他配简体中文', () => {
  const { targetLang, altTargetLang } = DEFAULT_SETTINGS.subtitles;
  it('按转写模型给的语言判断', () => {
    expect(translationTarget('zh', '大家好', targetLang, altTargetLang)).toBe('en');
    expect(translationTarget('zh-TW', '大家好', targetLang, altTargetLang)).toBe('en');
    expect(translationTarget('yue', '大家好', targetLang, altTargetLang)).toBe('en');
    expect(translationTarget('en', 'hello', targetLang, altTargetLang)).toBe('zh-CN');
    expect(translationTarget('ja', 'こんにちは', targetLang, altTargetLang)).toBe('zh-CN');
  });
  it('没给语言时按文字推断', () => {
    expect(translationTarget(undefined, '我说到哪里了', targetLang, altTargetLang)).toBe('en');
    expect(translationTarget(undefined, 'where was I', targetLang, altTargetLang)).toBe('zh-CN');
  });
  it('两种目标语言都和原文一样：不翻译', () => {
    expect(translationTarget('zh', '你好', 'zh-CN', 'zh-TW')).toBeUndefined();
  });
});

const cue = (id: string, start: number, end: number, text = `句子${id}`): SubtitleCue => ({ id, start, end, text, createdAt: NOW });

describe('显示时机', () => {
  const cues = [cue('a', 1, 3), cue('b', 4, 6), cue('c', 6.2, 8, ''), cue('d', 9, 11)];
  it('回看：按时间轴精确显示，句尾停留一小会儿但不压住下一句', () => {
    expect(pickCue(cues, 2, undefined)?.cue.id).toBe('a');
    expect(pickCue(cues, 3.5, undefined)?.cue.id).toBe('a');
    expect(pickCue(cues, 4.1, undefined)?.cue.id).toBe('b');
    expect(pickCue(cues, 0.5, undefined)).toBeUndefined();
  });
  it('没有人声的段（空文字）不显示', () => {
    expect(pickCue(cues, 7.5, undefined)).toBeUndefined();
  });
  it('第一次观看：字幕晚到也会立刻显示一会儿，并标为"晚到"', () => {
    const live = { id: 'b', arrivedAt: 9.5 };
    const v = pickCue([cue('b', 4, 6)], 10, live);
    expect(v).toEqual({ cue: expect.objectContaining({ id: 'b' }), late: true });
    expect(pickCue([cue('b', 4, 6)], 9.5 + SUBTITLES.liveMinShowSec + 0.1, live)).toBeUndefined();
  });
  it('晚太多（例如后台标签页积压）就不即时显示了', () => {
    expect(pickCue([cue('b', 4, 6)], 40, { id: 'b', arrivedAt: 39.5 })).toBeUndefined();
  });
});

describe('回看不重复花钱', () => {
  it('新片段与已有字幕重叠过半就跳过', () => {
    const cues = [cue('a', 10, 15), cue('b', 15.2, 20)];
    expect(isCovered(cues, 11, 14)).toBe(true);
    expect(isCovered(cues, 14, 19)).toBe(true);
    expect(isCovered(cues, 19, 26)).toBe(false);
    expect(isCovered([], 1, 2)).toBe(false);
  });
  it('字幕按开始时间有序存放；最多保留 N 个视频', () => {
    let t = putCue(null, 'vidA00000001', cue('2', 5, 6), 'gpt-transcribe', NOW);
    t = putCue(t, 'vidA00000001', cue('1', 1, 2), 'gpt-transcribe', NOW + 1);
    t = putCue(t, 'vidA00000001', { ...cue('2', 5, 6), translation: 'two' }, 'gpt-transcribe', NOW + 2);
    expect(t.cues.map((c) => c.id)).toEqual(['1', '2']);
    expect(t.cues[1]!.translation).toBe('two');
    expect(t.updatedAt).toBe(NOW + 2);
    expect(tracksToDrop({ a: 3, b: 1, c: 2 }, 2)).toEqual(['b']);
    expect(tracksToDrop({ a: 3 }, 2)).toEqual([]);
  });
});

describe('花费记账', () => {
  it('转写按分钟计价，翻译按 token 计价；预留的花费也算进剩余预算', () => {
    let l = recordAsr({ days: {} }, '2026-11-01', 'gpt-transcribe', 60);
    l = recordTranslation(l, '2026-11-01', 'claude-haiku-5-5', 1_000_000, 0);
    const snap = subtitleSnapshot(l, 1, 0.8, '2026-11-01', NOW, 0.5);
    expect(snap.spentUsd).toBeCloseTo(0.0045 + 0.1, 6);
    expect(snap.remainingUsd).toBeCloseTo(1 - 0.1045 - 0.5, 6);
    expect(snap.asrSeconds).toBe(60);
    expect(snap.translations).toBe(1);
    expect(snap.estimatedPrice).toBe(false);
  });
  it('不在价目表里的模型按最贵一档保守估算，并注明', () => {
    const l = recordTranslation({ days: {} }, '2026-11-01', 'some-new-model', 1_000_000, 0);
    const snap = subtitleSnapshot(l, 100, 0.8, '2026-11-01', NOW);
    expect(snap.spentUsd).toBe(10);
    expect(snap.estimatedPrice).toBe(true);
  });
  it('只保留最近 7 天', () => {
    let l = { days: {} };
    for (let d = 1; d <= 9; d++) l = recordAsr(l, `2026-11-0${d}`, 'gpt-transcribe', 1);
    expect(Object.keys(l.days)).toHaveLength(7);
  });
  it('一小时估算：快模型远比默认主模型便宜', () => {
    expect(hourlyEstimateUsd('gpt-transcribe', 'claude-opus-5-5')).toBeGreaterThan(hourlyEstimateUsd('gpt-transcribe', 'claude-haiku-5-5') * 5);
    expect(hourlyEstimateUsd('gpt-transcribe', undefined)).toBeCloseTo(0.27, 6);
  });
  it('小额花费与时长的显示', () => {
    expect(formatUsd(0.00016)).toBe('$0.0002');
    expect(formatUsd(0)).toBe('$0.000');
    expect(formatUsd(0.25)).toBe('$0.250');
    expect(formatAudioDuration(8)).toBe('8 秒');
    expect(formatAudioDuration(90)).toBe('1.5 分钟');
  });
});

// ── 后台流程 ──

interface Recorded {
  url: string;
  headers: Record<string, string>;
  form?: Record<string, string>;
  file?: { name: string; type: string; size: number };
  body?: string;
}

function makeCtx(opts: {
  transcribe?: (form: Record<string, string>) => { status?: number; body: unknown; headers?: Record<string, string> };
  translate?: (system: string, user: string) => { status?: number; body?: unknown };
  secrets?: Record<string, string>;
  settings?: (s: ReturnType<typeof mergeSettings>) => ReturnType<typeof mergeSettings>;
  /** videos.list 返回的条目 */
  youtube?: (url: URL) => unknown;
  authStatus?: string;
}) {
  const requests: Recorded[] = [];
  const http: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const reply = (status: number, data: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...extra } });
    if (req.url === `${ENDPOINTS.openai}/audio/transcriptions`) {
      const fd = await req.formData();
      const form: Record<string, string> = {};
      let file: Recorded['file'];
      fd.forEach((v, k) => {
        if (typeof v === 'string') form[k] = v;
        else file = { name: v.name, type: v.type, size: v.size };
      });
      requests.push({ url: req.url, headers, form, ...(file ? { file } : {}) });
      const r = opts.transcribe?.(form) ?? { body: { text: '我说到哪里了', languages: [{ code: 'zh' }], usage: { type: 'duration', seconds: 4 } } };
      return reply(r.status ?? 200, r.body, r.headers);
    }
    const body = await req.text();
    requests.push({ url: req.url, headers, body });
    if (req.url.startsWith(ENDPOINTS.youtubeApi) && opts.youtube) return reply(200, opts.youtube(new URL(req.url)));
    if (req.url.startsWith(ENDPOINTS.anthropic)) {
      const b = JSON.parse(body);
      const r = opts.translate?.(String(b.system), String(b.messages?.[0]?.content)) ?? { body: { translation: 'Where was I?' } };
      if ((r.status ?? 200) !== 200) return reply(r.status!, { type: 'error', error: { type: 'api_error', message: 'overloaded' } });
      return reply(200, {
        id: 'msg_sub',
        type: 'message',
        role: 'assistant',
        model: b.model,
        content: [{ type: 'text', text: JSON.stringify(r.body) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 300, output_tokens: 40 },
      });
    }
    throw new Error(`未预期的请求 ${req.url}`);
  };
  const kv = memoryKV();
  const auth = { status: async () => opts.authStatus ?? 'connected', getToken: async () => 'tok', invalidate: async () => undefined, disconnect: async () => undefined } as unknown as AuthProvider;
  const ctx: AppContext = { kv, locker: memoryLocker(), http, now: () => NOW, auth, endpoints: ENDPOINTS, timeZone: 'Asia/Shanghai' };
  const init = async () => {
    await stores.secrets.write(kv, { openaiApiKey: OPENAI_KEY, anthropicApiKey: ANTHROPIC_KEY, ...(opts.secrets ?? {}) });
    const s = mergeSettings(undefined);
    await stores.settings.write(kv, opts.settings ? opts.settings(s) : s);
  };
  return { ctx, requests, init };
}

const VID = '3wP2VCoz3KM';
const segment = (start = 12, sec = 3) => ({ videoId: VID, start, end: start + sec, wav: encodeWav(tone(sec), RATE) });

describe('后台：转写 → 存字幕 → 翻译 → 记账', () => {
  it('音频只发往 OpenAI 转写接口：带模型名与前文，Key 只在请求头里', async () => {
    const t = makeCtx({});
    await t.init();
    const first = await transcribeSegment(t.ctx, segment(12));
    expect(first).toMatchObject({ id: `${VID}:12000`, start: 12, end: 15, text: '我说到哪里了', lang: 'zh' });
    await transcribeSegment(t.ctx, segment(16));
    expect(t.requests).toHaveLength(2);
    const [r1, r2] = t.requests;
    expect(r1!.form).toEqual({ model: 'gpt-transcribe', response_format: 'json' });
    expect(r1!.file).toMatchObject({ name: 'segment.wav', type: 'audio/wav' });
    expect(r1!.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    // 第二段带上前文（提高连贯性），不带视频 ID
    expect(r2!.form!.prompt).toBe('我说到哪里了');
    expect(JSON.stringify(t.requests)).not.toContain(VID);
    const track = (await subtitleTrackStore(VID).read(t.ctx.kv))!;
    expect(track.cues.map((c) => c.start)).toEqual([12, 16]);
    // 按服务方报告的计费时长记账：两段各 4 秒
    const spend = await subtitleSpend(t.ctx);
    expect(spend.asrSeconds).toBe(8);
    expect(spend.spentUsd).toBeCloseTo((8 / 60) * 0.0045, 6);
  });

  it('中文视频译成英文：只发这句与前几句的文字，默认用 claude-haiku-5-5，按返回用量记账', async () => {
    const seen: { system: string; user: string }[] = [];
    const t = makeCtx({
      translate: (system, user) => {
        seen.push({ system, user });
        return { body: { translation: 'Where was I?' } };
      },
    });
    await t.init();
    const prev = await transcribeSegment(t.ctx, segment(2));
    await translateCue(t.ctx, VID, prev!);
    const c = await transcribeSegment(t.ctx, segment(12));
    const out = await translateCue(t.ctx, VID, c!);
    expect(out).toMatchObject({ translation: 'Where was I?', translationLang: 'en' });
    expect(seen[1]!.system).toContain('English');
    expect(seen[1]!.user).toContain('前文：\n- 我说到哪里了');
    expect(seen[1]!.user).toContain('当前字幕：\n我说到哪里了');
    const llmReq = t.requests.filter((r) => r.url.startsWith(ENDPOINTS.anthropic));
    expect(JSON.parse(llmReq[0]!.body!).model).toBe('claude-haiku-5-5');
    expect(llmReq[0]!.body).not.toContain(VID);
    expect(llmReq[0]!.headers['x-api-key'] ?? llmReq[0]!.headers.authorization).toContain(ANTHROPIC_KEY);
    const stored = (await subtitleTrackStore(VID).read(t.ctx.kv))!.cues.find((x) => x.id === c!.id)!;
    expect(await stores.subtitleIndex.read(t.ctx.kv)).toEqual({ [VID]: NOW });
    expect(stored.translation).toBe('Where was I?');
    const ledger = await stores.subtitleLedger.read(t.ctx.kv);
    const day = Object.values(ledger.days)[0]!;
    expect(day.translations).toBe(2);
    expect(day.inputTokens).toBe(600);
    expect(day.translateUsd).toBeCloseTo(2 * ((300 * 0.1 + 40 * 0.5) / 1e6), 9);
  });

  it('没有填 OpenAI Key：说清楚为什么、怎么办，且不发任何请求', async () => {
    const t = makeCtx({ secrets: { openaiApiKey: '' } });
    await t.init();
    await stores.secrets.write(t.ctx.kv, { anthropicApiKey: ANTHROPIC_KEY });
    const err = await transcribeSegment(t.ctx, segment()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).kind).toBe('llm_key');
    expect((err as AppError).message).toContain('Anthropic 没有语音转文字接口');
    expect(t.requests).toHaveLength(0);
  });

  it('到每日预算立即停止：不发请求，告诉你已用多少、怎么恢复', async () => {
    const t = makeCtx({ settings: (s) => ({ ...s, subtitles: { ...s.subtitles, dailyBudgetUsd: 0.05 } }) });
    await t.init();
    await stores.subtitleLedger.write(t.ctx.kv, recordAsr({ days: {} }, '2026-11-01', 'gpt-transcribe', 667)); // $0.0500，已到上限
    const err = (await transcribeSegment(t.ctx, segment()).catch((e) => e)) as AppError;
    expect(err.kind).toBe('subtitles_budget');
    expect(err.message).toContain('$0.050');
    expect(err.hint).toContain('0 点自动恢复');
    expect(t.requests).toHaveLength(0);
  });

  it('并发时也守住预算：在途请求先预留', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = makeCtx({ settings: (s) => ({ ...s, subtitles: { ...s.subtitles, dailyBudgetUsd: 0.06, translate: false } }) });
    await t.init();
    // 第一段卡在转写途中时，第二段看到的剩余预算已扣掉第一段的预留
    const slowHttp = t.ctx.http;
    t.ctx.http = async (input, init) => {
      await gate;
      return slowHttp(input, init);
    };
    await stores.subtitleLedger.write(t.ctx.kv, recordAsr({ days: {} }, '2026-11-01', 'gpt-transcribe', 60 * 13)); // $0.0585，剩 $0.0015
    const a = transcribeSegment(t.ctx, segment(1, 7)); // 预留约 $0.000525
    await new Promise((r) => setTimeout(r, 0));
    const snap = await subtitleSpend(t.ctx);
    expect(snap.remainingUsd).toBeLessThan(0.0015);
    release();
    await a;
  });

  it('翻译失败不影响原文：原文照常保存，第二行写明原因（不含 Key）', async () => {
    const t = makeCtx({ translate: () => ({ status: 401 }) });
    await t.init();
    const c = await transcribeSegment(t.ctx, segment());
    const out = await translateCue(t.ctx, VID, c!);
    expect(out.text).toBe('我说到哪里了');
    expect(out.translation).toBeUndefined();
    expect(out.translationError).toContain('Anthropic API Key 无效');
    expect(out.translationError).not.toContain(ANTHROPIC_KEY);
  });

  it('这段已有字幕（回看）：不再识别、不花钱', async () => {
    const t = makeCtx({});
    await t.init();
    await transcribeSegment(t.ctx, segment(12, 4));
    expect(await transcribeSegment(t.ctx, segment(12.5, 3))).toBeUndefined();
    expect(t.requests).toHaveLength(1);
  });

  it('只有音乐/杂音（转写为空）：记成空字幕，不翻译、不显示，回看时也不再花钱', async () => {
    const t = makeCtx({ transcribe: () => ({ body: { text: '', languages: [] } }) });
    await t.init();
    const c = await transcribeSegment(t.ctx, segment(30));
    expect(c!.text).toBe('');
    expect(await translateCue(t.ctx, VID, c!)).toBe(c);
    expect(t.requests.filter((r) => r.url.startsWith(ENDPOINTS.anthropic))).toHaveLength(0);
    expect(await transcribeSegment(t.ctx, segment(30))).toBeUndefined();
  });

  it('拒收格式不对或过长的音频', () => {
    expect(() => validateSegment({ videoId: VID, start: 0, end: 1, wav: new Uint8Array(50) })).toThrow(AppError);
    expect(() => validateSegment({ videoId: 'bad id!', start: 0, end: 1, wav: encodeWav(tone(1), RATE) })).toThrow(AppError);
    expect(() => validateSegment({ videoId: VID, start: 0, end: 30, wav: encodeWav(tone(SUBTITLES.maxSegmentSec + 2), RATE) })).toThrow(AppError);
    expect(() => validateSegment({ videoId: VID, start: 0, end: 30, wav: encodeWav(tone(1), 44_100) })).toThrow(AppError);
    expect(validateSegment({ videoId: VID, start: 0, end: 1, wav: encodeWav(tone(1), RATE) }).durationSec).toBe(1);
  });
});

describe('字幕翻译模型', () => {
  it('默认用更快更省的小模型，随"1. 大模型"的提供商切换', () => {
    const s = mergeSettings(undefined);
    expect(subtitleTranslationModel(s)).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect(subtitleTranslationModel({ ...s, llm: { ...s.llm, provider: 'openai' } })).toEqual({ provider: 'openai', model: 'gpt-6-luna' });
  });
  it('清空 = 跟随主模型；填了别的就用它', () => {
    const s = mergeSettings({ subtitles: { translationModels: { anthropic: '' } } });
    expect(subtitleTranslationModel(s).model).toBe(s.llm.models.anthropic);
    expect(s.subtitles.translationModels.openai).toBe('gpt-6-luna');
    const t = mergeSettings({ subtitles: { translationModels: { anthropic: 'claude-sonnet-5-5' } } });
    expect(subtitleTranslationModel(t).model).toBe('claude-sonnet-5-5');
  });
});

const up = (start: number) => ({ type: 'segment', videoId: VID, seq: Math.round(start), start, end: start + 2, audio: bytesToBase64(encodeWav(tone(2), RATE)) });
type ErrorDown = Extract<SubtitleDown, { type: 'error' }>;
const errorsOf = (sent: SubtitleDown[]) => sent.filter((m): m is ErrorDown => m.type === 'error');

describe('OpenAI 返回 429：分清"额度 / 账单"与"限流"（官方：两类都是 HTTP 429，按 error.code 区分）', () => {
  const billing = (code: string) => ({
    status: 429,
    body: { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code, param: null } },
  });

  it.each([
    ['credit_balance_exhausted', '预付额度已用完', 'Billing'],
    ['organization_spend_limit_exceeded', '花费上限', 'Limits'],
    ['project_spend_limit_exceeded', '项目', 'Limits'],
    ['organization_usage_limit_exceeded', '用量上限', 'Limits'],
    ['insufficient_quota', '额度不足', 'Billing'],
  ])('%s：说清是哪一种、去哪里处理；属于"致命"错误——重试也不会恢复，停下不再发', async (code, words, where) => {
    const t = makeCtx({ transcribe: () => billing(code) });
    await t.init();
    const sent: SubtitleDown[] = [];
    await subtitleSession(t.ctx, (m) => sent.push(m))(up(5));
    const [err] = errorsOf(sent);
    expect(err!.fatal).toBe(true);
    expect(err!.message).toContain(code);
    expect(err!.message).toContain(words);
    expect(err!.hint).toContain(where);
    expect(err!.message).not.toContain('请求过于频繁');
    expect(JSON.stringify(sent)).not.toContain(OPENAI_KEY);
  });

  it('限流（slow_down）：按 Retry-After 暂停；暂停期间的片段不发请求（被拒的请求也算进每分钟上限），到点后自动继续', async () => {
    let now = NOW;
    let n = 0;
    const t = makeCtx({
      transcribe: () =>
        ++n === 1
          ? { status: 429, headers: { 'retry-after': '20' }, body: { error: { message: 'Your request rate increased too quickly.', type: 'rate_limit_error', code: 'slow_down', param: null } } }
          : { body: { text: '继续', languages: [{ code: 'zh' }] } },
    });
    await t.init();
    t.ctx.now = () => now;
    const sent: SubtitleDown[] = [];
    const handle = subtitleSession(t.ctx, (m) => sent.push(m));
    await handle(up(5));
    let [err] = errorsOf(sent);
    expect(err!.fatal).toBe(false);
    expect(err!.message).toContain('slow_down');
    expect(err!.message).not.toContain('请求过于频繁或额度不足');
    expect(err!.hint).toContain('20 秒');
    expect(err!.hint).toContain('Your request rate increased too quickly');
    expect(err!.retryAfterMs).toBe(20_000);
    const calls = () => t.requests.filter((r) => r.url.endsWith('/audio/transcriptions')).length;
    expect(calls()).toBe(1);

    now += 5_000;
    sent.length = 0;
    await handle(up(9));
    [err] = errorsOf(sent);
    expect(calls()).toBe(1);
    expect(err!.retryAfterMs).toBe(15_000);
    expect(err!.fatal).toBe(false);

    now += 16_000;
    sent.length = 0;
    await handle(up(13));
    expect(calls()).toBe(2);
    expect(sent.some((m) => m.type === 'cue' && m.cue.text === '继续')).toBe(true);
  });

  it('限流但没给 Retry-After：按 x-ratelimit-reset-requests；都没有时指数退避（5 秒起，最多 60 秒）', async () => {
    let now = NOW;
    const t = makeCtx({
      transcribe: () => ({ status: 429, headers: { 'x-ratelimit-reset-requests': '1m30s', 'x-ratelimit-remaining-requests': '0' }, body: { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded', param: null } } }),
    });
    await t.init();
    t.ctx.now = () => now;
    const sent: SubtitleDown[] = [];
    await subtitleSession(t.ctx, (m) => sent.push(m))(up(5));
    expect(errorsOf(sent)[0]!.retryAfterMs).toBe(90_000);

    const u = makeCtx({ transcribe: () => ({ status: 429, body: { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } } }) });
    await u.init();
    u.ctx.now = () => now;
    const got: number[] = [];
    const handle = subtitleSession(u.ctx, (m) => m.type === 'error' && m.retryAfterMs !== undefined && got.push(m.retryAfterMs));
    for (let i = 0; i < 6; i++) {
      await handle(up(5 + i * 4));
      now += got.at(-1)! + 1; // 等暂停结束再发下一段
    }
    expect(got).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });
});

describe('限流等待时间的读取', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it('Retry-After（秒 / HTTP 日期）与 retry-after-ms', () => {
    expect(retryAfterMs(h({ 'retry-after': '56' }), NOW)).toBe(56_000);
    expect(retryAfterMs(h({ 'retry-after': new Date(NOW + 30_000).toUTCString() }), NOW)).toBe(30_000);
    expect(retryAfterMs(h({ 'retry-after-ms': '1500', 'retry-after': '9' }), NOW)).toBe(1_500);
  });
  it('x-ratelimit-reset-*：只看已经用尽的那一项（"1s"、"6m0s"、"20ms" 都认）', () => {
    expect(retryAfterMs(h({ 'x-ratelimit-reset-requests': '6m0s', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-tokens': '1s', 'x-ratelimit-remaining-tokens': '900' }), NOW)).toBe(360_000);
    expect(retryAfterMs(h({ 'x-ratelimit-reset-tokens': '2.5s', 'x-ratelimit-remaining-tokens': '0' }), NOW)).toBe(2_500);
    expect(retryAfterMs(h({ 'x-ratelimit-reset-project-tokens': '3s' }), NOW)).toBe(3_000);
  });
  it('太短按 1 秒、太长按 10 分钟；没有信息返回 undefined', () => {
    expect(retryAfterMs(h({ 'x-ratelimit-reset-requests': '20ms' }), NOW)).toBe(1_000);
    expect(retryAfterMs(h({ 'retry-after': '86400' }), NOW)).toBe(600_000);
    expect(retryAfterMs(h({ 'x-ratelimit-reset-requests': 'soon' }), NOW)).toBeUndefined();
    expect(retryAfterMs(h({}), NOW)).toBeUndefined();
    expect(retryAfterMs(undefined, NOW)).toBeUndefined();
  });
});

describe('其他功能的 429 也分清楚', () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const req = { system: 's', user: 'u', schema: { type: 'object' }, schemaName: 'x', effort: 'low' as const };

  it('OpenAI 找片 / 翻译遇到额度用完：llm_quota，指明去 Billing', async () => {
    const llm = createLlmClient({ provider: 'openai', model: 'gpt-6-luna', apiKey: OPENAI_KEY, baseURL: ENDPOINTS.openai, fetch: async () => json(429, { error: { message: 'no credits', type: 'insufficient_quota', code: 'credit_balance_exhausted' } }) });
    const err = (await llm.generateJson(req).catch((e) => e)) as AppError;
    expect(err.kind).toBe('llm_quota');
    expect(err.message).toBe('OpenAI 账户预付额度已用完（credit_balance_exhausted）');
  });

  it('Anthropic 的 429 是限流（它的余额不足不走 429）：llm_rate，带上等待时间与原话', async () => {
    const llm = createLlmClient({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      apiKey: ANTHROPIC_KEY,
      baseURL: ENDPOINTS.anthropic,
      fetch: async () => json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your per-minute rate limit' } }, { 'retry-after': '12', 'x-should-retry': 'false' }),
    });
    const err = (await llm.generateJson(req).catch((e) => e)) as AppError;
    expect(err.kind).toBe('llm_rate');
    expect(err.message).toBe('Anthropic 限流：请求太快（rate_limit_error）');
    expect(err.hint).toContain('per-minute rate limit');
    expect(err.retryAfterMs).toBe(12_000);
  });
});

// ── 浏览器识别 ──

/** 模拟浏览器边听边出字：每 tickMs 多出 per 个字（interim），视频时间同步前进 */
function speak(t: LiveTranscript, text: string, o: { videoStart?: number; tickMs?: number; per?: number; finalAtEnd?: boolean } = {}) {
  const tickMs = o.tickMs ?? 250;
  const per = o.per ?? 1;
  let video = o.videoStart ?? 0;
  let now = 1_000_000;
  const out: ReturnType<LiveTranscript['update']> = [];
  for (let n = per; n <= text.length + per; n += per) {
    const shown = text.slice(0, Math.min(n, text.length));
    const final = !!o.finalAtEnd && n >= text.length;
    out.push(...t.update(shown, final, video, 1, now));
    if (final) break;
    video += tickMs / 1000;
    now += tickMs;
  }
  return { lines: out, video, now };
}

describe('浏览器识别：把边听边改的文字整理成一行一行（带估算的视频时间）', () => {
  it('连续说话不停顿（实测 Chrome 会把 25 秒当成一句）：文字稳定后每 16 个字交出一行，时间按出字时刻减去识别延迟', () => {
    const t = new LiveTranscript();
    const text = '这是我的吓到耶就是他们说他们的长辈会非常凶的说不要再聊了这个事情没有没有没有得了那就停止这个话';
    const { lines } = speak(t, text, { videoStart: 300 });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(16);
    expect(lines[0]!.start).toBeCloseTo(300 - SUBTITLES.liveLatencySec, 1);
    expect(lines[1]!.start).toBeGreaterThan(lines[0]!.start);
    expect(lines.map((l) => l.text).join('')).toBe(text.slice(0, lines.map((l) => l.text).join('').length));
  });

  it('final 时把剩下的全部交出；太长的再按一行切开，优先断在语气词后面', () => {
    const t = new LiveTranscript();
    const sentence = '這是我的嚇到耶就是他們說他們的長輩會非常兇的說不要再聊了這個事情沒有沒有沒有得了那就停止這個話我不知道你遇過嗎';
    const lines = t.update(sentence, true, 338, 1, 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.map((l) => l.text).join('')).toBe(sentence);
    for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(SUBTITLES.liveMaxChars.cjk);
    expect(lines.some((l) => /[了的嗎耶]$/.test(l.text))).toBe(true);
    expect(t.tail).toBe('');
  });

  it('说一小句就停：没满一行，停顿够久（poll）也交出', () => {
    const t = new LiveTranscript();
    const { video, now } = speak(t, '你好吗', { videoStart: 10 });
    expect(t.tail).toBe('你好吗');
    expect(t.poll(video + 0.5, now + 2_000)).toEqual([]);
    const lines = t.poll(video + SUBTITLES.liveIdleCommitSec + 0.5, now + 3_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('你好吗');
    expect(t.tail).toBe('');
  });

  it('识别器改了还没定稿的字：按改后的文字算，改动的字重新计时', () => {
    const t = new LiveTranscript();
    t.update('今天天器', false, 5, 1, 0);
    t.update('今天天气很好', false, 6, 1, 500);
    expect(t.tail).toBe('今天天气很好');
    const [line] = t.update('今天天气很好', true, 6.5, 1, 900);
    expect(line!.text).toBe('今天天气很好');
    expect(line!.start).toBeCloseTo(5 - SUBTITLES.liveLatencySec, 5);
  });

  it('英文按单词断行，不切半个词；2 倍速时延迟按视频时间放大', () => {
    const t = new LiveTranscript();
    const text = 'so the thing about large language models is that they predict the next token and nothing more than that really';
    const { lines } = speak(t, text, { videoStart: 0, per: 3, tickMs: 150, finalAtEnd: true });
    expect(lines.map((l) => l.text).join(' ')).toBe(text);
    for (const l of lines) expect(text.split(' ')).toEqual(expect.arrayContaining(l.text.split(' ')));
    const fast = new LiveTranscript();
    const [l2] = fast.update('hello there', true, 20, 2, 0);
    expect(l2!.start).toBeCloseTo(20 - SUBTITLES.liveLatencySec * 2, 5);
  });

  it('flush 交出全部；reset 丢掉（拖动后识别器手里的声音属于之前的位置）', () => {
    const t = new LiveTranscript();
    t.update('还没说完的一句', false, 3, 1, 0);
    expect(t.flush(4).map((l) => l.text)).toEqual(['还没说完的一句']);
    t.update('拖动前的话', false, 3, 1, 0);
    t.reset();
    expect(t.tail).toBe('');
    expect(t.flush(4)).toEqual([]);
  });
});

describe('浏览器识别：屏幕上的两行', () => {
  const c = (start: number, end: number, text: string, translation?: string): SubtitleCue => ({ id: `v:${start}`, start, end, text, ...(translation ? { translation } : {}), createdAt: NOW });
  it('上一行：最近定稿的那行 + 刚听到的新字；下一行：那行的译文', () => {
    const v = liveView([c(1, 3, '第一句', 'First'), c(4, 6, '第二句', 'Second')], '正在说', 7);
    expect(v).toEqual({ source: '第二句正在说', translation: 'Second' });
  });
  it('太长只留最后一段，前面加省略号；英文不切半个词', () => {
    const v = liveView([], '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三', 1);
    expect(v!.source.startsWith('…')).toBe(true);
    expect(v!.source.length).toBe(SUBTITLES.liveTailChars.cjk + 1);
    const en = liveView([], 'word '.repeat(30).trim(), 1)!;
    expect(en.source).toMatch(/^…word( word)*$/);
  });
  it('很久以前的行不再显示；什么都没有时不显示', () => {
    expect(liveView([c(1, 3, '老的', 'old')], '', 30)).toBeUndefined();
    expect(liveView([], '', 1)).toBeUndefined();
  });
});

describe('浏览器识别：用哪种语言', () => {
  it('设置里指定了就用它', () => {
    expect(recognitionLangFor('en-US', { language: 'zh' })).toEqual({ lang: 'en-US', source: 'setting' });
  });
  it('自动：按视频的语言；中文一律按简体识别，粤语单独', () => {
    expect(recognitionLangFor('auto', { language: 'zh-Hant' })).toEqual({ lang: 'zh-CN', source: 'video' });
    expect(recognitionLangFor('auto', { language: 'zh-TW' }).lang).toBe('zh-CN');
    expect(recognitionLangFor('auto', { language: 'yue-HK' }).lang).toBe('yue-Hant-HK');
    expect(recognitionLangFor('auto', { language: 'en' }).lang).toBe('en-US');
    expect(recognitionLangFor('auto', { language: 'ja' }).lang).toBe('ja-JP');
    expect(recognitionLangFor('auto', { language: 'fr' }).lang).toBe('fr');
  });
  it('没有语言信息：按标题文字推断；再不行用简体中文并说明', () => {
    expect(recognitionLangFor('auto', { title: '【康永你OK嗎？】專訪 蔡康永' })).toEqual({ lang: 'zh-CN', source: 'title' });
    expect(recognitionLangFor('auto', { title: 'こんにちは、世界' }).lang).toBe('ja-JP');
    const d = recognitionLangFor('auto', { title: 'Hello world' });
    expect(d.source).toBe('default');
    expect(d.note).toContain('侧边栏');
    expect(recognitionLangFor('auto', undefined, '没有连接 YouTube').note).toBe('没有连接 YouTube');
  });
  it('YouTube 元数据带上视频的音频语言', () => {
    expect(mapVideoMeta({ id: 'abc123def45', snippet: { title: 't', defaultAudioLanguage: 'zh-Hant', defaultLanguage: 'en' } }, NOW)!.language).toBe('zh-Hant');
    expect(mapVideoMeta({ id: 'abc123def45', snippet: { title: 't', defaultLanguage: 'en' } }, NOW)!.language).toBe('en');
    expect(mapVideoMeta({ id: 'abc123def45', snippet: { title: 't' } }, NOW)!.language).toBeUndefined();
  });
});

describe('浏览器识别：出错时怎么说', () => {
  it('云端连不上：停下，说明只有 Chrome 能用、可以改用 OpenAI', () => {
    const e = speechErrorInfo('network', 'cloud', 'zh-CN')!;
    expect(e.fatal).toBe(true);
    expect(e.hint).toContain('Google Chrome');
    expect(e.hint).toContain('OpenAI');
  });
  it('本地语音包出任何问题：改用云端并说明声音去向', () => {
    for (const code of ['network', 'language-not-supported', 'service-not-allowed']) {
      const e = speechErrorInfo(code, 'local', 'zh-CN')!;
      expect(e.retryCloud).toBe(true);
      expect(e.fatal).toBe(false);
      expect(e.message).toContain('发往 Google');
    }
  });
  it('没听到声音、主动中止：不提示；语言不支持：停下并指明在哪换', () => {
    expect(speechErrorInfo('no-speech', 'cloud', 'zh-CN')).toBeUndefined();
    expect(speechErrorInfo('aborted', 'cloud', 'zh-CN')).toBeUndefined();
    const e = speechErrorInfo('language-not-supported', 'cloud', 'yue-Hant-HK')!;
    expect(e.message).toContain('粤语');
    expect(e.hint).toContain('侧边栏');
  });
});

describe('后台：浏览器识别出的字幕', () => {
  it('只收文字：存成字幕、翻译（Claude），不发任何转写请求、不花转写费', async () => {
    const t = makeCtx({});
    await t.init();
    const sent: SubtitleDown[] = [];
    await subtitleSession(t.ctx, (m) => sent.push(m))({ type: 'text', videoId: VID, seq: 1, start: 12, end: 14.5, text: '我说到哪里了', lang: 'zh-CN' });
    expect(sent.map((m) => (m.type === 'cue' ? `cue:${m.stage}` : m.type))).toEqual(['cue:source', 'cue:translated', 'done']);
    const cue = (sent[1] as Extract<SubtitleDown, { type: 'cue' }>).cue;
    expect(cue).toMatchObject({ id: `${VID}:12000`, text: '我说到哪里了', lang: 'zh-CN', translation: 'Where was I?', translationLang: 'en' });
    expect(t.requests.filter((r) => r.url.includes('/audio/transcriptions'))).toHaveLength(0);
    const day = Object.values((await stores.subtitleLedger.read(t.ctx.kv)).days)[0]!;
    expect(day.asrSeconds).toBe(0);
    expect(day.translations).toBe(1);
    expect((await subtitleTrackStore(VID).read(t.ctx.kv))!.asrModel).toBe('browser-speech');
  });

  it('不需要 OpenAI Key', async () => {
    const t = makeCtx({});
    await t.init();
    await stores.secrets.write(t.ctx.kv, { anthropicApiKey: ANTHROPIC_KEY });
    const cue = await saveTextCue(t.ctx, { videoId: VID, start: 1, end: 2, text: '好' });
    expect(cue!.text).toBe('好');
  });

  it('已有字幕的时间段（回看）不再存；格式不对的拒收', async () => {
    const t = makeCtx({});
    await t.init();
    await saveTextCue(t.ctx, { videoId: VID, start: 10, end: 14, text: '一' });
    expect(await saveTextCue(t.ctx, { videoId: VID, start: 10.5, end: 13, text: '一' })).toBeUndefined();
    for (const bad of [{ text: '' }, { start: -1 }, { end: 5, start: 6 }, { end: 500 }, { videoId: 'x y' }]) {
      await expect(saveTextCue(t.ctx, { videoId: VID, start: 20, end: 22, text: '好', ...bad })).rejects.toThrow(AppError);
    }
  });

  it('hello：浏览器识别时一并告诉内容脚本用哪种语言', async () => {
    const t = makeCtx({ youtube: () => ({ items: [{ id: VID, snippet: { title: '【康永你OK嗎？】', defaultAudioLanguage: 'zh-TW' }, contentDetails: { duration: 'PT55M' } }] }) });
    await t.init();
    const sent: SubtitleDown[] = [];
    await subtitleSession(t.ctx, (m) => sent.push(m))({ type: 'hello', videoId: VID });
    expect((sent[0] as Extract<SubtitleDown, { type: 'track' }>).recognition).toEqual({ lang: 'zh-CN', source: 'video' });
  });

  it('自动选语言：先用缓存；没有就用官方 API 查一次（1 unit，记进配额并缓存）', async () => {
    let calls = 0;
    const t = makeCtx({
      youtube: (u) => {
        calls++;
        expect(u.pathname.endsWith('/videos')).toBe(true);
        expect(u.searchParams.get('id')).toBe(VID);
        return { items: [{ id: VID, snippet: { title: 'Talk', defaultAudioLanguage: 'en' }, contentDetails: { duration: 'PT5M' } }] };
      },
    });
    await t.init();
    expect(await recognitionPlan(t.ctx, VID)).toEqual({ lang: 'en-US', source: 'video' });
    expect(await recognitionPlan(t.ctx, VID)).toEqual({ lang: 'en-US', source: 'video' });
    expect(calls).toBe(1);
    expect((await stores.videoMeta.read(t.ctx.kv))[VID]!.language).toBe('en');
    const usage = Object.values((await stores.quotaLedger.read(t.ctx.kv)).days)[0]!;
    expect(usage.generalUnits).toBe(1);
    expect(usage.byMethod['videos.list']).toBe(1);
  });

  it('没连接 YouTube：不发请求，用简体中文并说明原因；设置里指定了语言就不查', async () => {
    const t = makeCtx({ authStatus: 'disconnected' });
    await t.init();
    const plan = await recognitionPlan(t.ctx, VID);
    expect(plan).toMatchObject({ lang: 'zh-CN', source: 'default' });
    expect(plan.note).toContain('没有连接 YouTube');
    const u = makeCtx({ settings: (s) => ({ ...s, subtitles: { ...s.subtitles, browserLang: 'ja-JP' } }) });
    await u.init();
    expect(await recognitionPlan(u.ctx, VID)).toEqual({ lang: 'ja-JP', source: 'setting' });
    expect(t.requests.length + u.requests.length).toBe(0);
  });
});

describe('与内容脚本的会话', () => {

  it('先回原文、再回译文，最后告知这一段处理完了', async () => {
    const t = makeCtx({});
    await t.init();
    const sent: SubtitleDown[] = [];
    const handle = subtitleSession(t.ctx, (m) => sent.push(m));
    await handle(up(5));
    expect(sent.map((m) => (m.type === 'cue' ? `cue:${m.stage}` : m.type))).toEqual(['cue:source', 'cue:translated', 'done']);
    await handle({ type: 'hello', videoId: VID });
    const track = sent.at(-1) as Extract<SubtitleDown, { type: 'track' }>;
    expect(track.type).toBe('track');
    expect(track.cues[0]!.translation).toBe('Where was I?');
  });

  it('没有 Key、预算用完是"致命"错误：内容脚本应停下；错误文字不含 Key', async () => {
    const t = makeCtx({ transcribe: () => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${OPENAI_KEY}`, type: 'invalid_request_error' } } }) });
    await t.init();
    const sent: SubtitleDown[] = [];
    await subtitleSession(t.ctx, (m) => sent.push(m))(up(5));
    const err = sent.find((m) => m.type === 'error') as Extract<SubtitleDown, { type: 'error' }>;
    expect(err.fatal).toBe(true);
    expect(err.message).toContain('OpenAI API Key 无效');
    expect(JSON.stringify(sent)).not.toContain(OPENAI_KEY);
  });

  it('服务暂时不可用不是致命错误：跳过这一段，下一段照常', async () => {
    let n = 0;
    const t = makeCtx({ transcribe: () => (++n === 1 ? { status: 503, body: { error: { message: 'busy' } } } : { body: { text: '好', languages: [{ code: 'zh' }] } }) });
    await t.init();
    const sent: SubtitleDown[] = [];
    const handle = subtitleSession(t.ctx, (m) => sent.push(m));
    await handle(up(5));
    await handle(up(9));
    const err = sent.find((m) => m.type === 'error') as Extract<SubtitleDown, { type: 'error' }>;
    expect(err.fatal).toBe(false);
    expect(sent.some((m) => m.type === 'cue' && m.cue.text === '好')).toBe(true);
  });

  it('忽略来路不明的消息', async () => {
    const t = makeCtx({});
    await t.init();
    const sent: SubtitleDown[] = [];
    const handle = subtitleSession(t.ctx, (m) => sent.push(m));
    await handle({ type: 'segment', videoId: '<script>', audio: '' });
    await handle(null);
    await handle({ type: 'hello', videoId: 42 });
    expect(sent).toHaveLength(0);
    expect(t.requests).toHaveLength(0);
  });
});
