// 从配音音频识别字幕（用户 2026-11-24 要求，见 DECISIONS §91）：没有字幕文件时，把已关联的中文配音（m4a）按停顿切句、
// 发往 OpenAI 转写、由大模型校对，存成这个配音的字幕（和字幕文件同一个键、同一套显示）；花费记进"字幕 $"；被打断后能接着识别。
// 解码换成合成的波形（每 3 秒一段音、每段音高不同，和 e2e 的音频夹具同一个规律）；转写的假服务从收到的 WAV 里认出是第几段。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DUB, SUBTITLES } from '../../src/config/defaults';
import { ENDPOINTS } from '../../src/config/endpoints';
import { asrCuesForDub, dubAsrKey, dubAsrPrompt, dubReference, estimateDubAsrUsd, insertCue, parseProof, proofAcceptable, sanitizeDubAsrDoc, settledCues, type DubAsrCue, type DubAsrProgress } from '../../src/core/dub-asr';
import { dubSubsMetaText } from '../../src/core/dub-subs';
import { buildDubProofPrompt } from '../../src/core/prompts';
import type { AuthProvider } from '../../src/services/auth';
import type { AppContext } from '../../src/services/context';
import { exportAll } from '../../src/services/data-service';
import { DubAsrStopped, discardDubAsr, planDubAsr, readDubAsrProgress, runDubAsr, savePartialDubAsr, type DubAsrDeps } from '../../src/services/dub-asr-service';
import { attachDub, readDubSubtitles, removeDub, setDubSubtitleFile } from '../../src/services/dub-service';
import { memoryDubStore } from '../../src/services/dub-store';
import { AppError } from '../../src/services/errors';
import { dubAsrStore, dubSubsStore, mergeSettings, stores } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';
import { fakeSecret } from './fake-secrets';

const M4A = new Uint8Array(readFileSync(new URL('../fixtures/xyz-tones.m4a', import.meta.url)));
const NOW = Date.parse('2026-11-24T02:00:00Z');
const VID = 'ys6YQ2yfBpM';
const FILE = '#838. Shopify创始人Tobi Lütke：黄仁勋、AI，以及为什么创始人不可替代 - 跨国串门儿计划 - 小宇宙 - 听播客，上小宇宙.m4a';
const TITLE = 'Tobi Lütke: Jensen Huang, AI, and why founders are irreplaceable';
const OPENAI_KEY = fakeSecret('sk-proj-', 'dubAsrKey0123456789abcdefghijklmnopqrstu');
const ANTHROPIC_KEY = fakeSecret('sk-ant-', 'dub-asr-0123456789abcdefghijklmnopqr');
const SR = SUBTITLES.sampleRate;
/** 夹具的规律：每 3 秒一段音，响 1.8 秒，第 k 段的音高是 300 + 20k Hz */
const TONE = { everySec: 3, onSec: 1.8, baseHz: 300, stepHz: 20, count: 31 };

/** 合成 [firstTime, endTime) 的波形（真的解码器解出来的也是从 firstTime 开始） */
function synth(at: { firstTime: number; endTime: number }, amp = 0.25): Float32Array {
  const n = Math.round((at.endTime - at.firstTime) * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = at.firstTime + i / SR;
    if (t < 0) continue;
    const k = Math.floor(t / TONE.everySec);
    if (t - k * TONE.everySec < TONE.onSec) out[i] = amp * Math.sin(2 * Math.PI * (TONE.baseHz + TONE.stepHz * k) * t);
  }
  return out;
}

/** 假转写：从 WAV 里认出是第几段音（Goertzel，取能量最强的那个频率）；太安静时认不出 */
function toneIndex(wav: Uint8Array): number | undefined {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const n = (wav.length - 44) / 2;
  const x = new Float64Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    x[i] = v.getInt16(44 + i * 2, true) / 32768;
    energy += x[i]! * x[i]!;
  }
  if (Math.sqrt(energy / Math.max(1, n)) < 0.02) return undefined;
  let best = -1;
  let bestK = -1;
  for (let k = 0; k < 60; k++) {
    const c = 2 * Math.cos((2 * Math.PI * (TONE.baseHz + TONE.stepHz * k)) / SR);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const s0 = x[i]! + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const p = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (p > best) {
      best = p;
      bestK = k;
    }
  }
  return bestK;
}

interface Rec {
  url: string;
  headers: Record<string, string>;
  form?: Record<string, string>;
  body?: string;
  /** 转写请求：认出的段号、音频多长 */
  k?: number | undefined;
  seconds?: number;
}

interface Opts {
  settings?: Record<string, unknown>;
  anthropicKey?: boolean;
  openaiKey?: boolean;
  /** 第 n 次（从 1 数）转写请求怎么回；不给时照常认段号 */
  transcribe?: (n: number, k: number | undefined) => { status?: number; headers?: Record<string, string>; body: unknown } | undefined;
  proof?: (items: { id: string; text: string }[], user: string) => unknown;
  fileName?: string;
}

async function setup(opts: Opts = {}) {
  const requests: Rec[] = [];
  let clock = NOW;
  let transcribes = 0;
  const reply = (status: number, data: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  const http: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    if (req.url === `${ENDPOINTS.openai}/audio/transcriptions`) {
      const fd = await req.formData();
      const form: Record<string, string> = {};
      fd.forEach((v, k) => typeof v === 'string' && (form[k] = v));
      const wav = new Uint8Array(await (fd.get('file') as File).arrayBuffer());
      const k = toneIndex(wav);
      const seconds = (wav.length - 44) / 2 / SR;
      requests.push({ url: req.url, headers, form, k, seconds });
      const custom = opts.transcribe?.(++transcribes, k);
      if (custom) return reply(custom.status ?? 200, custom.body, custom.headers);
      return reply(200, { text: k === undefined ? '' : `这是第${k}段配音的内容`, languages: [{ code: 'zh' }], usage: { type: 'duration', seconds } });
    }
    const body = await req.text();
    requests.push({ url: req.url, headers, body });
    if (req.url.startsWith(ENDPOINTS.anthropic)) {
      const b = JSON.parse(body);
      const user = String(b.messages?.[0]?.content);
      const items = JSON.parse(user.slice(user.indexOf('待校对（JSON）：\n') + '待校对（JSON）：\n'.length)) as { id: string; text: string }[];
      const out = opts.proof?.(items, user) ?? { items: items.map((i) => ({ id: i.id, text: `${i.text}。` })) };
      return reply(200, { id: 'msg', type: 'message', role: 'assistant', model: b.model, content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 600 } });
    }
    throw new Error(`未预期的请求 ${req.url}`);
  };
  const kv = memoryKV();
  const dubAudio = memoryDubStore();
  const auth = { disconnect: async () => ({ revoked: false }) } as unknown as AuthProvider;
  const ctx: AppContext = { kv, locker: memoryLocker(), http, now: () => clock, auth, endpoints: ENDPOINTS, timeZone: 'Asia/Shanghai', dubAudio };
  await stores.secrets.write(kv, { ...(opts.openaiKey === false ? {} : { openaiApiKey: OPENAI_KEY }), ...(opts.anthropicKey === false ? {} : { anthropicApiKey: ANTHROPIC_KEY }) });
  await stores.settings.write(kv, mergeSettings(opts.settings ?? {}));
  const rec = await attachDub(ctx, { videoId: VID, file: new Blob([M4A as BlobPart], { type: 'audio/x-m4a' }), fileName: opts.fileName ?? FILE, title: TITLE, videoDurationSec: 120 });
  const sleeps: number[] = [];
  const deps: DubAsrDeps = {
    decode: async (_data, at) => synth(at),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  };
  const asrRequests = () => requests.filter((r) => r.url.endsWith('/audio/transcriptions'));
  const llmRequests = () => requests.filter((r) => r.url.startsWith(ENDPOINTS.anthropic));
  const today = async () => Object.values((await stores.subtitleLedger.read(kv)).days)[0];
  return { ctx, kv, dubAudio, rec, deps, requests, asrRequests, llmRequests, sleeps, today, tick: (ms: number) => (clock += ms) };
}

const cue = (start: number, end: number, raw: string, over: Partial<DubAsrCue> = {}): DubAsrCue => ({ start, end, raw, ...over });

describe('纯逻辑', () => {
  it('参考资料：配音文件名去掉扩展名和小宇宙网站的口号（那不是音频里的话，留着只会把转写带偏）', () => {
    expect(dubReference(FILE)).toBe('#838. Shopify创始人Tobi Lütke：黄仁勋、AI，以及为什么创始人不可替代 - 跨国串门儿计划');
    expect(dubReference('我的配音  第二版.M4A')).toBe('我的配音 第二版');
    expect(dubReference('x'.repeat(500) + '.m4a').length).toBeLessThanOrEqual(DUB.fileNameMaxChars);
  });

  it('转写的提示词：文件名在前、前面几句在后，总长有上限；前文用校对过的文字', () => {
    const before = [cue(0, 2, '第一句'), cue(3, 5, '第二句', { text: '第二句。', polished: true }), cue(6, 8, '第三句'), cue(9, 11, '第四句'), cue(12, 14, '第五句')];
    const p = dubAsrPrompt('节目名 - 标题', before);
    expect(p).toBe('节目名 - 标题\n第二句。 第三句 第四句 第五句');
    const long = dubAsrPrompt('长'.repeat(1000), [cue(0, 2, '前文'.repeat(500))]);
    expect(long.length).toBeLessThanOrEqual(DUB.asr.promptChars);
    expect(long).toContain('前文');
    expect(dubAsrPrompt('', [])).toBe('');
  });

  it('预计花费：转写按时长，校对每 24 句一次；截图里那个 59:26 的配音约 $0.29', () => {
    const e = estimateDubAsrUsd(59 * 60 + 26, 'gpt-transcribe', 'claude-haiku-5-5');
    expect(e.asrUsd).toBeCloseTo(0.26745, 4);
    expect(e.proofUsd).toBeGreaterThan(0.01);
    expect(e.proofUsd).toBeLessThan(0.05);
    expect(e.totalUsd).toBeCloseTo(e.asrUsd + e.proofUsd, 6);
    expect(estimateDubAsrUsd(3566, 'gpt-transcribe', undefined).proofUsd).toBe(0);
    expect(estimateDubAsrUsd(-5, 'gpt-transcribe', 'claude-haiku-5-5').totalUsd).toBe(0);
  });

  it('校对结果不可信：只认对得上编号的；改错字、补标点可以，字数差太多（改写、删减、加内容）不采用', () => {
    const refs = new Map([
      ['s1', 0],
      ['s2', 1],
    ]);
    const parsed = parseProof({ items: [{ id: 's2', text: ' 第二句。\n续 ' }, { id: 's9', text: '没有这个编号' }, { id: 's2', text: '重复的编号' }, { id: 's1', text: 7 }, null] }, refs);
    expect([...parsed.entries()]).toEqual([[1, '第二句。 续']]);
    expect(parseProof('不是对象', refs).size).toBe(0);
    expect(proofAcceptable('黄仁训说英伟达的芯片', '黄仁勋说，英伟达的芯片。')).toBe(true);
    expect(proofAcceptable('黄仁训说英伟达的芯片', '')).toBe(false);
    expect(proofAcceptable('黄仁训说英伟达的芯片', '。。。')).toBe(false);
    expect(proofAcceptable('黄仁训说英伟达的芯片很贵但是供不应求', '芯片贵')).toBe(false);
    expect(proofAcceptable('好的', '好的，这里大模型自己加了一大段原文里没有的话，字幕就和配音对不上了')).toBe(false);
    expect(proofAcceptable('嗯', '嗯。')).toBe(true);
  });

  it('进度：读存储时校验；接着识别时只认"已识别完"的位置之前的句子；回来的顺序乱也按时间排', () => {
    const raw = {
      videoId: VID,
      fileId: 'dub_1',
      durationSec: 100,
      asrModel: 'gpt-transcribe',
      doneTo: 500,
      cues: [{ start: 9, end: 11, raw: '后' }, { start: 1, end: 3, raw: '前', text: '前。', polished: true }, { start: 5, end: 4, raw: '倒着的' }, { start: 6, end: 7, raw: '  ' }, { start: 12, end: 13, raw: '没校对成', proofError: '大模型漏了', text: '不算' }, 'x'],
      updatedAt: 1,
    };
    const doc = sanitizeDubAsrDoc(raw, VID)!;
    expect(doc.doneTo).toBe(100);
    expect(doc.cues).toEqual([
      { start: 1, end: 3, raw: '前', text: '前。', polished: true },
      { start: 9, end: 11, raw: '后' },
      { start: 12, end: 13, raw: '没校对成', proofError: '大模型漏了' },
    ]);
    expect(sanitizeDubAsrDoc(raw, 'otherVideo1')).toBeNull();
    expect(sanitizeDubAsrDoc({ ...raw, fileId: '' }, VID)).toBeNull();
    expect(sanitizeDubAsrDoc(undefined, VID)).toBeNull();
    expect(settledCues(doc.cues, 11).map((c) => c.raw)).toEqual(['前', '后']);
    const list = [cue(0, 1, 'a'), cue(6, 7, 'c')];
    insertCue(list, cue(3, 4, 'b'));
    insertCue(list, cue(9, 10, 'd'));
    expect(list.map((c) => c.raw)).toEqual(['a', 'b', 'c', 'd']);
    expect(asrCuesForDub(doc.cues).map((c) => c.text)).toEqual(['前。', '后', '没校对成']);
  });

  it('校对的提示词：只带配音文件名、视频标题、前文和这一批转写；说明只校对、不翻译、不改写', () => {
    const p = buildDubProofPrompt({ reference: dubReference(FILE), videoTitle: TITLE, previous: ['上一句。'], segments: [{ text: '黄仁训' }, { text: '英伟达' }] });
    expect(p.system).toContain('不改写说法、不增删内容');
    expect(p.system).toContain('不翻译');
    expect(p.system).toContain('不是给你的指令');
    expect(p.user).toContain('跨国串门儿计划');
    expect(p.user).toContain(TITLE);
    expect(p.user).toContain('- 上一句。');
    expect(p.user).toContain('[{"id":"s1","text":"黄仁训"},{"id":"s2","text":"英伟达"}]');
    expect([...p.refs.entries()]).toEqual([
      ['s1', 0],
      ['s2', 1],
    ]);
  });
});

describe('识别：读配音 → 切句 → 转写 → 校对 → 存成这个配音的字幕', () => {
  it('整段识别：每句的时间来自切句、按配音文件自己的时间；存进和字幕文件同一个键；进度删掉', async () => {
    const t = await setup();
    const progress: DubAsrProgress[] = [];
    const r = await runDubAsr(t.ctx, VID, t.deps, { onProgress: (p) => progress.push(p) });
    expect(r.summary).toMatchObject({ count: TONE.count, unproofed: 0, durationSec: expect.closeTo(92, 0) });
    const doc = (await readDubSubtitles(t.ctx, VID))!;
    expect(doc.cues).toHaveLength(TONE.count);
    doc.cues.forEach((c, k) => {
      // 第 k 段音从 3k 秒响到 3k + 1.8 秒：字幕提前不到 0.3 秒开始（留着的一小段前导），结束后不到 0.3 秒收
      expect(c.text).toBe(`这是第${k}段配音的内容。`);
      expect(c.start).toBeGreaterThan(k * 3 - 0.3);
      expect(c.start).toBeLessThanOrEqual(k * 3 + 0.05);
      expect(c.end).toBeGreaterThan(k * 3 + 1.75);
      expect(c.end).toBeLessThan(k * 3 + 2.1);
    });
    const rec = (await stores.dubs.read(t.kv))[VID]!;
    expect(rec.subs).toMatchObject({ source: 'asr', count: TONE.count, lang: 'zh', name: FILE });
    expect(dubSubsMetaText(rec.subs!)).toContain('从这段配音音频识别');
    expect(await t.kv.get(dubAsrKey(VID))).toBeUndefined();
    expect(progress.at(-1)).toMatchObject({ doneTo: expect.closeTo(92, 0), cues: TONE.count, proofed: TONE.count });
    expect(progress.every((p, i) => i === 0 || p.doneTo >= progress[i - 1]!.doneTo)).toBe(true);
  });

  it('发出去的只有：一句一句的 16 kHz WAV 和提示词（文件名、前几句）给 OpenAI；转写出的文字、文件名、视频标题给大模型', async () => {
    const t = await setup();
    await runDubAsr(t.ctx, VID, t.deps);
    const asr = t.asrRequests();
    expect(asr).toHaveLength(TONE.count);
    expect(new Set(asr.map((r) => r.k)).size).toBe(TONE.count);
    expect(asr.every((r) => r.headers.authorization === `Bearer ${OPENAI_KEY}` && r.form!.model === 'gpt-transcribe' && r.seconds! <= DUB.asr.maxSegmentSec)).toBe(true);
    expect(asr.every((r) => r.form!.prompt!.startsWith('#838. Shopify创始人Tobi Lütke') && !r.form!.prompt!.includes('听播客') && r.form!.prompt!.length <= DUB.asr.promptChars)).toBe(true);
    const llm = t.llmRequests();
    // 31 句：攒够 24 句校对一次，收尾再校对剩下的
    expect(llm).toHaveLength(2);
    expect(llm.every((r) => r.headers.authorization === `Bearer ${ANTHROPIC_KEY}` && JSON.parse(r.body!).model === 'claude-haiku-5-5')).toBe(true);
    expect(llm[0]!.body).toContain('跨国串门儿计划');
    expect(llm[0]!.body).toContain('Jensen Huang');
    expect(llm[1]!.body).toContain('这是第23段配音的内容。');
    const all = t.requests.map((r) => `${r.form?.prompt ?? ''}${r.body ?? ''}`).join('\n');
    expect(all).not.toContain(VID);
    expect(all).not.toContain(OPENAI_KEY);
    expect(t.requests.every((r) => r.url.startsWith(ENDPOINTS.openai) || r.url.startsWith(ENDPOINTS.anthropic))).toBe(true);
  });

  it('花费记进"字幕 $"：转写按服务方报的时长、校对按用量和句数；预扣都结清', async () => {
    const t = await setup();
    const r = await runDubAsr(t.ctx, VID, t.deps);
    const day = (await t.today())!;
    const seconds = t.asrRequests().reduce((n, x) => n + x.seconds!, 0);
    expect(day.asrSeconds).toBeCloseTo(seconds, 3);
    expect(day.translations).toBe(TONE.count);
    expect(day.translateUsd).toBeGreaterThan(0);
    expect(day.holds ?? []).toEqual([]);
    expect(day.unconfirmedUsd ?? 0).toBe(0);
    expect(r.summary.spentUsd).toBeCloseTo(day.spentUsd, 5);
  });

  it('开始之前给你看：多长、用哪个模型、大约花多少、今天的预算够不够；没有 OpenAI Key 时说明', async () => {
    const t = await setup({ settings: { subtitles: { dailyBudgetUsd: 0.005 } } });
    const plan = await planDubAsr(t.ctx, VID);
    expect(plan).toMatchObject({ asrModel: 'gpt-transcribe', asrPriceUnknown: false, proofModel: 'claude-haiku-5-5', budgetUsd: 0.005, remainingUsd: 0.005, overBudget: true });
    expect(plan.durationSec).toBeCloseTo(92, 0);
    expect(plan.estimate!.asrUsd).toBeCloseTo((92 / 60) * 0.0045, 4);
    expect(plan.problem).toBeUndefined();
    expect(plan.proofOff).toBeUndefined();
    const noKey = await setup({ openaiKey: false });
    const p2 = await planDubAsr(noKey.ctx, VID);
    expect(p2.problem?.message).toContain('需要 OpenAI API Key');
    expect(p2.overBudget).toBe(false);
    await expect(runDubAsr(noKey.ctx, VID, noKey.deps)).rejects.toThrow(/需要 OpenAI API Key/);
    expect(noKey.requests).toHaveLength(0);
    expect((await planDubAsr(t.ctx, 'noSuchVideo')).problem?.message).toContain('已经移除');
  });

  it('校对用的模型没有 Key：照样识别，只是不校对——开始前就说明，不悄悄换别的', async () => {
    const t = await setup({ anthropicKey: false });
    const plan = await planDubAsr(t.ctx, VID);
    expect(plan.proofOff).toContain('没有填写 Anthropic API Key');
    expect(plan.estimate!.proofUsd).toBe(0);
    const r = await runDubAsr(t.ctx, VID, t.deps);
    expect(t.llmRequests()).toHaveLength(0);
    expect(r.summary).toMatchObject({ count: TONE.count, unproofed: TONE.count });
    expect(r.summary.proofNote).toContain('没有填写 Anthropic API Key');
    expect((await readDubSubtitles(t.ctx, VID))!.cues[3]!.text).toBe('这是第3段配音的内容');
  });

  it('大模型漏了一句、把一句改得面目全非：那两句用转写的原文，并说明', async () => {
    const t = await setup({
      proof: (items) => ({ items: items.filter((i) => !i.text.includes('第5段')).map((i) => ({ id: i.id, text: i.text.includes('第7段') ? '改' : `${i.text}。` })) }),
    });
    const r = await runDubAsr(t.ctx, VID, t.deps);
    const cues = (await readDubSubtitles(t.ctx, VID))!.cues;
    expect(cues[5]!.text).toBe('这是第5段配音的内容');
    expect(cues[7]!.text).toBe('这是第7段配音的内容');
    expect(cues[6]!.text).toBe('这是第6段配音的内容。');
    expect(r.summary.unproofed).toBe(2);
    expect(r.summary.proofNote).toBeTruthy();
  });

  it('校对的服务出错（Key 失效）：不再一批批去试，转写照常完成，说明没校对的原因', async () => {
    const t = await setup();
    const http = t.ctx.http;
    let calls = 0;
    t.ctx.http = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(ENDPOINTS.anthropic)) {
        calls++;
        return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
      }
      return http(input, init);
    };
    const r = await runDubAsr(t.ctx, VID, t.deps);
    expect(calls).toBe(1);
    expect(r.summary).toMatchObject({ count: TONE.count, unproofed: TONE.count });
    expect(r.summary.proofNote).toContain('Key');
    expect(r.summary.proofNote).not.toContain(ANTHROPIC_KEY);
  });
});

describe('被打断之后接着识别', () => {
  it('今天的"字幕 $"预算用完：停下并说明，已识别的留着；调高预算后接着识别，付过钱的句子不重来', async () => {
    // 不校对（校对的预扣比转写大得多，会先把这点预算占掉）：每句转写约 $0.00015，$0.002 够十来句
    const t = await setup({ anthropicKey: false, settings: { subtitles: { dailyBudgetUsd: 0.002 } } });
    const err = await runDubAsr(t.ctx, VID, t.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).kind).toBe('subtitles_budget');
    expect((err as AppError).message).toContain('字幕花费已到上限');
    const first = t.asrRequests().length;
    expect(first).toBeGreaterThan(5);
    expect(first).toBeLessThan(TONE.count);
    expect(await readDubSubtitles(t.ctx, VID)).toBeNull();
    const saved = (await readDubAsrProgress(t.ctx, VID))!;
    expect(saved.doneTo).toBeGreaterThan(15);
    expect(saved.doneTo).toBeLessThan(92);
    const kept = settledCues(saved.cues, saved.doneTo).length;
    expect(kept).toBeGreaterThan(5);
    const plan = await planDubAsr(t.ctx, VID);
    expect(plan.resume).toEqual({ doneTo: saved.doneTo, cues: kept });
    expect(plan.estimate!.asrUsd).toBeCloseTo(((92 - saved.doneTo) / 60) * 0.0045, 4);

    // 先用已识别的那部分：存成字幕，进度留着
    const partial = await savePartialDubAsr(t.ctx, VID);
    expect(partial.summary).toMatchObject({ count: kept, partialTo: saved.doneTo });
    expect((await readDubSubtitles(t.ctx, VID))!.cues).toHaveLength(kept);
    expect(await readDubAsrProgress(t.ctx, VID)).not.toBeNull();

    await stores.settings.update(t.kv, t.ctx.locker, (s) => ({ ...s, subtitles: { ...s.subtitles, dailyBudgetUsd: 1 } }));
    const r = await runDubAsr(t.ctx, VID, t.deps);
    expect(r.summary.count).toBe(TONE.count);
    const cues = (await readDubSubtitles(t.ctx, VID))!.cues;
    expect(cues.map((c) => c.text)).toEqual(Array.from({ length: TONE.count }, (_, k) => `这是第${k}段配音的内容`));
    // 已识别完的那几句没有再发一遍：第二次只发了剩下的
    const second = t.asrRequests().slice(first);
    expect(second).toHaveLength(TONE.count - kept);
    expect(Math.min(...second.map((x) => x.k!))).toBe(kept);
    expect(await t.kv.get(dubAsrKey(VID))).toBeUndefined();
  });

  it('你点了停止：在途的请求等它们回来（钱已经花了），进度存好；从头重新识别要明说', async () => {
    const t = await setup({ anthropicKey: false });
    const stop = new AbortController();
    const err = await runDubAsr(t.ctx, VID, t.deps, {
      signal: stop.signal,
      onProgress: (p) => {
        if (p.cues >= 8) stop.abort();
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DubAsrStopped);
    const saved = (await readDubAsrProgress(t.ctx, VID))!;
    const sent = t.asrRequests().length;
    expect(saved.cues).toHaveLength(sent);
    expect(sent).toBeGreaterThanOrEqual(8);
    expect(sent).toBeLessThan(TONE.count);
    // restart：不接着来，从头识别
    const r = await runDubAsr(t.ctx, VID, t.deps, { restart: true });
    expect(r.summary.count).toBe(TONE.count);
    expect(t.asrRequests()).toHaveLength(sent + TONE.count);
    // 丢掉进度
    await dubAsrStore(VID).write(t.kv, saved);
    await discardDubAsr(t.ctx, VID);
    expect(await readDubAsrProgress(t.ctx, VID)).toBeNull();
    expect((await readDubSubtitles(t.ctx, VID))!.cues).toHaveLength(TONE.count);
  });

  it('被限流：按服务方说的时间等，不丢句、不重复发；等的时候进度里写明', async () => {
    const t = await setup({
      anthropicKey: false,
      transcribe: (n) => (n === 3 ? { status: 429, headers: { 'retry-after': '7' }, body: { error: { message: 'Your request rate increased too quickly.', type: 'rate_limit_error', code: 'slow_down', param: null } } } : undefined),
    });
    const waits: string[] = [];
    const r = await runDubAsr(t.ctx, VID, t.deps, { onProgress: (p) => p.waiting && waits.push(p.waiting) });
    expect(r.summary.count).toBe(TONE.count);
    expect(t.sleeps.length).toBeGreaterThan(0);
    expect(Math.max(...t.sleeps)).toBeLessThanOrEqual(DUB.asr.rateWaitMaxMs);
    expect(waits.some((w) => w.includes('限流'))).toBe(true);
    expect((await readDubSubtitles(t.ctx, VID))!.cues.map((c) => c.text)).toEqual(Array.from({ length: TONE.count }, (_, k) => `这是第${k}段配音的内容`));
    // 被拒的那一次没有计费：账上的转写时长只有成功的那 31 次
    expect(t.asrRequests()).toHaveLength(TONE.count + 1);
    const billed = t.asrRequests().filter((_, i) => i !== 2);
    expect((await t.today())!.asrSeconds).toBeCloseTo(billed.reduce((n, x) => n + x.seconds!, 0), 3);
  });

  it('网络出错：一句最多再试两次，还不行就停下说明，已识别的留着', async () => {
    const t = await setup({ anthropicKey: false, transcribe: (n) => (n >= 10 ? { status: 500, body: { error: { message: 'boom', type: 'server_error' } } } : undefined) });
    const err = (await runDubAsr(t.ctx, VID, t.deps).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('OpenAI');
    expect(t.sleeps.filter((ms) => ms === DUB.asr.retryBaseMs).length).toBeGreaterThan(0);
    const saved = (await readDubAsrProgress(t.ctx, VID))!;
    expect(saved.doneTo).toBeGreaterThan(0);
    expect(await readDubSubtitles(t.ctx, VID)).toBeNull();
  });
});

describe('本机存储出错', () => {
  it('存进度失败（存储满了之类）：停下来说明，不会悄悄丢进度、也不留下没人接的异常', async () => {
    const t = await setup();
    const set = t.kv.set.bind(t.kv);
    let writes = 0;
    t.kv.set = async (key, value) => {
      // 校对完一批之后存进度的那一次起开始失败
      if (key === dubAsrKey(VID) && ++writes >= 4) throw new Error('QUOTA_BYTES quota exceeded');
      return set(key, value);
    };
    const err = (await runDubAsr(t.ctx, VID, t.deps).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('QUOTA_BYTES');
    expect(await readDubSubtitles(t.ctx, VID)).toBeNull();
  });
});

describe('识别不出来的情况都说清楚', () => {
  it('整段没有人声：不发请求、不花钱，说明原因；转写回来全是空的：说明，不存空字幕', async () => {
    const silent = await setup();
    silent.deps.decode = async (_d, at) => new Float32Array(Math.round((at.endTime - at.firstTime) * SR));
    await expect(runDubAsr(silent.ctx, VID, silent.deps)).rejects.toThrow(/没有找到人声/);
    expect(silent.requests).toHaveLength(0);
    expect(await silent.today()).toBeUndefined();
    const empty = await setup({ transcribe: () => ({ body: { text: '', usage: { type: 'duration', seconds: 2 } } }) });
    await expect(runDubAsr(empty.ctx, VID, empty.deps)).rejects.toThrow(/转写结果是空的/);
    expect(await readDubSubtitles(empty.ctx, VID)).toBeNull();
    expect(await empty.kv.get(dubAsrKey(VID))).toBeUndefined();
  });

  it('读不出声音的文件、解码失败：说明原因和怎么办', async () => {
    const t = await setup();
    t.dubAudio.data.set(t.rec.fileId, new Blob([new Uint8Array(4096)]));
    await expect(runDubAsr(t.ctx, VID, t.deps)).rejects.toThrow(/读不出这个配音文件里的声音/);
    expect((await planDubAsr(t.ctx, VID)).problem?.hint).toContain('ffmpeg');
    const bad = await setup();
    bad.deps.decode = async () => {
      throw new Error('Unable to decode audio data');
    };
    const err = (await runDubAsr(bad.ctx, VID, bad.deps).catch((e: unknown) => e)) as AppError;
    expect(err.message).toContain('解码配音的声音出错');
    expect(bad.requests).toHaveLength(0);
    const gone = await setup();
    gone.dubAudio.data.clear();
    await expect(runDubAsr(gone.ctx, VID, gone.deps)).rejects.toThrow(/本机找不到这个配音文件/);
  });
});

describe('和现有的配音字幕并存', () => {
  it('手动选字幕文件照旧；识别完才换掉原来的字幕；换配音文件、移除配音时进度一并处理；进度进导出', async () => {
    const t = await setup({ anthropicKey: false, settings: { subtitles: { dailyBudgetUsd: 0.002 } } });
    const srt = '1\n00:00:01,000 --> 00:00:03,000\n手动选的字幕\n';
    await setDubSubtitleFile(t.ctx, VID, new Blob([srt]), '手动.srt');
    await runDubAsr(t.ctx, VID, t.deps).catch(() => undefined);
    // 识别到一半停下：原来那份手动选的字幕还在
    expect((await readDubSubtitles(t.ctx, VID))!.cues.map((c) => c.text)).toEqual(['手动选的字幕']);
    expect((await stores.dubs.read(t.kv))[VID]!.subs).toMatchObject({ source: 'file', name: '手动.srt' });
    const exported = await exportAll(t.ctx);
    expect(Object.keys(exported.data)).toContain(dubAsrKey(VID));
    expect(Object.keys(exported.data)).toContain(dubSubsStore(VID).key);
    // 换一个配音文件：旧文件的进度作废
    await attachDub(t.ctx, { videoId: VID, file: new Blob([M4A as BlobPart], { type: 'audio/x-m4a' }), fileName: '第二版.m4a' });
    expect(await t.kv.get(dubAsrKey(VID))).toBeUndefined();
    expect(await readDubAsrProgress(t.ctx, VID)).toBeNull();
    // 移除配音：进度一并删掉
    await runDubAsr(t.ctx, VID, t.deps).catch(() => undefined);
    await removeDub(t.ctx, VID);
    expect(await t.kv.get(dubAsrKey(VID))).toBeUndefined();
    expect(await t.kv.get(dubSubsStore(VID).key)).toBeUndefined();
  });

  it('识别的时候配音被移除：结果不存，说明', async () => {
    const t = await setup({ anthropicKey: false });
    let removed = false;
    const err = (await runDubAsr(t.ctx, VID, t.deps, {
      onProgress: (p) => {
        if (p.cues >= 20 && !removed) {
          removed = true;
          void removeDub(t.ctx, VID);
        }
      },
    }).catch((e: unknown) => e)) as AppError;
    expect(err.message).toContain('被移除或换了文件');
    expect(await t.kv.get(dubSubsStore(VID).key)).toBeUndefined();
  });
});
