// LLM 客户端：Anthropic（官方 SDK）与 OpenAI（官方 SDK），统一成"按 JSON Schema 返回结构化结果"。
// Key 只放在请求头里发往对应服务；错误信息经过脱敏。

import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';
import { ANTHROPIC_FALLBACK, LLM_LIMITS } from '../config/defaults';
import type { JsonSchema } from '../core/prompts';
import { redact } from '../core/redact';
import { wellFormed } from '../core/text';
import { AppError } from './errors';

export type LlmProvider = 'anthropic' | 'openai';

export interface JsonRequest {
  system: string;
  user: string;
  schema: JsonSchema;
  schemaName: string;
  /** 解析口令用 low，聚类用 medium */
  effort: 'low' | 'medium';
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  provider: LlmProvider;
  model: string;
  generateJson(req: JsonRequest): Promise<unknown>;
  /** 同 generateJson，并返回服务方报告的 token 用量（自动字幕按此记账） */
  generateJsonWithUsage(req: JsonRequest): Promise<{ value: unknown; usage: LlmUsage }>;
}

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseURL: string;
  /** 仅 Anthropic：Key 没有绑定工作区时必须随请求带上工作区 ID（anthropic-workspace-id 请求头） */
  workspaceId?: string;
  fetch?: typeof fetch;
}

/** Anthropic 工作区 ID 形如 wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ */
export function isAnthropicWorkspaceId(v: string): boolean {
  return /^wrkspc_[A-Za-z0-9]{8,}$/.test(v);
}

const PROVIDER_NAMES: Record<LlmProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

function parseJsonText(text: string, provider: LlmProvider): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('llm', `${PROVIDER_NAMES[provider]} 返回的内容不是合法 JSON`, '请重试；如反复出现，换一个模型');
  }
}

type ApiErrorLike = { status?: number; message?: string; error?: unknown };

/** 取服务方返回的原因文本：Anthropic 的错误体是 {error:{message}}，OpenAI SDK 已拆成 {message}。 */
function providerMessage(err: unknown): string {
  const body = (err as ApiErrorLike)?.error;
  if (body && typeof body === 'object') {
    const b = body as { message?: unknown; error?: { message?: unknown } };
    const msg = b.error?.message ?? b.message;
    if (typeof msg === 'string' && msg) return msg;
  }
  return String((err as ApiErrorLike)?.message ?? err);
}

/**
 * OpenAI 的额度 / 账单问题也返回 HTTP 429，只能靠 error.code 区分（developers.openai.com/api/docs/guides/error-codes，2026-11 核实）。
 * 这一类重试不会恢复，要去充值或调上限；和"请求太快"的限流分开处理。
 */
const OPENAI_BILLING_429: Record<string, { what: string; fix: string }> = {
  credit_balance_exhausted: { what: '预付额度已用完', fix: '到 platform.openai.com → Settings → Billing 充值（ChatGPT 会员不含 API 额度）；充值后通常几分钟内生效' },
  organization_spend_limit_exceeded: { what: '组织达到了你设置的花费上限', fix: '到 platform.openai.com → Settings → Limits 调高或取消组织的花费上限' },
  project_spend_limit_exceeded: { what: '这把 Key 所属的项目达到了花费上限', fix: '到 platform.openai.com 打开这把 Key 所属项目的 Settings → Limits，调高花费上限' },
  organization_usage_limit_exceeded: { what: '组织达到了 OpenAI 分配的月度用量上限', fix: '到 platform.openai.com → Settings → Limits 申请提高用量上限' },
  insufficient_quota: { what: '额度不足（余额用完，或达到了花费上限）', fix: '到 platform.openai.com → Settings → Billing 查看余额，Settings → Limits 查看上限' },
};

/** 服务方的 error.code / error.type：OpenAI SDK 直接挂在错误上；Anthropic 的错误体是 {type:'error', error:{type}} */
function providerCode(err: unknown): { code?: string; type?: string } {
  const e = err as { code?: unknown; type?: unknown; error?: { code?: unknown; type?: unknown; error?: { type?: unknown } } };
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const code = str(e?.code) ?? str(e?.error?.code);
  const type = str(e?.type) ?? (e?.error?.type === 'error' ? str(e?.error?.error?.type) : str(e?.error?.type));
  return { ...(code ? { code } : {}), ...(type ? { type } : {}) };
}

/** "1s"、"6m0s"、"20ms"、"1h2m3.5s" → 毫秒 */
function parseResetDuration(v: string | null): number | undefined {
  if (!v) return undefined;
  const text = v.trim();
  let ms = 0;
  let used = '';
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    const n = Number(m[1]);
    ms += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n;
    used += m[0];
  }
  return used && used === text ? ms : undefined;
}

/**
 * 限流时该等多久：retry-after-ms > Retry-After（秒或 HTTP 日期）> 已用尽的那一项 x-ratelimit-reset-*；都没有返回 undefined。
 * 结果限制在 1 秒到 10 分钟之间。
 */
export function retryAfterMs(headers: { get(name: string): string | null } | undefined, now: number): number | undefined {
  if (!headers) return undefined;
  const clamp = (ms: number) => Math.min(600_000, Math.max(1_000, Math.round(ms)));
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.get('retry-after-ms') && Number.isFinite(ms)) return clamp(ms);
  const ra = headers.get('retry-after');
  if (ra) {
    const sec = Number(ra);
    if (Number.isFinite(sec)) return clamp(sec * 1000);
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return clamp(at - now);
  }
  const resets: number[] = [];
  for (const kind of ['requests', 'tokens', 'project-tokens']) {
    const reset = parseResetDuration(headers.get(`x-ratelimit-reset-${kind}`));
    if (reset === undefined) continue;
    const remaining = headers.get(`x-ratelimit-remaining-${kind}`);
    if (remaining === null || Number(remaining) <= 0) resets.push(reset);
  }
  return resets.length ? clamp(Math.max(...resets)) : undefined;
}

function rateOrBillingError(err: unknown, provider: LlmProvider, name: string, full: string, raw: string): AppError {
  const { code, type } = providerCode(err);
  const label = code ?? type ?? 'HTTP 429';
  if (provider === 'openai') {
    const billing = (code && OPENAI_BILLING_429[code]) || (type === 'insufficient_quota' || /quota|billing|credit balance|spend limit/i.test(full) ? OPENAI_BILLING_429.insufficient_quota : undefined);
    if (billing) return new AppError('llm_quota', `${name} 账户${billing.what}（${label}）`, billing.fix);
  }
  const wait = retryAfterMs((err as { headers?: Headers }).headers, Date.now());
  return new AppError('llm_rate', `${name} 限流：请求太快（${label}）`, raw ? `服务方原话：${raw}` : '稍后再试', wait);
}

function mapLlmError(err: unknown, provider: LlmProvider, model: string, apiKey: string): AppError {
  if (err instanceof AppError) return err;
  const name = PROVIDER_NAMES[provider];
  const isConn =
    err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError;
  const isTimeout =
    err instanceof Anthropic.APIConnectionTimeoutError || err instanceof OpenAI.APIConnectionTimeoutError;
  if (isTimeout) return new AppError('network', `${name} 请求超时`, '稍后重试');
  if (isConn) return new AppError('network', `无法连接到 ${name} API（网络错误）`, '检查网络后重试');
  const status = (err as ApiErrorLike)?.status;
  const full = providerMessage(err);
  const raw = redact(full, [apiKey]).slice(0, 300);
  if (provider === 'anthropic') {
    // 见 platform.claude.com/docs/en/manage-claude/authentication#select-a-workspace
    if (status === 400 && /not scoped to a workspace/i.test(full)) {
      return new AppError(
        'llm_key',
        '这把 Anthropic API Key 没有绑定工作区，Anthropic 要求每个请求指明用哪个工作区',
        '二选一：在设置页「1. 大模型」填写工作区 ID（wrkspc_ 开头，在 Anthropic Console → Settings → Workspaces 的 ID 列）；或在 Console 新建一把限定到某个工作区的 Key 替换现在这把',
      );
    }
    if (status === 400 && /anthropic-workspace-id/i.test(full)) {
      return new AppError('llm_key', 'Anthropic 工作区 ID 格式不对', '应以 wrkspc_ 开头，从 Anthropic Console → Settings → Workspaces 的 ID 列整段复制');
    }
    if (status === 404 && /workspace/i.test(full)) {
      return new AppError('llm_key', '找不到设置里填写的 Anthropic 工作区，或这把 Key 无权使用它', '核对设置页「1. 大模型」里的工作区 ID；如果 Key 已限定到某个工作区，可以删掉工作区 ID');
    }
  }
  switch (status) {
    case 401:
      return new AppError('llm_key', `${name} API Key 无效或已被撤销`, '在设置页重新填写 Key');
    case 403:
      return new AppError('llm_key', `${name} 拒绝访问（权限不足或账户受限）`, raw);
    case 404:
      return new AppError('llm', `模型「${model}」不存在或你的账户无权使用`, '在设置页检查模型名');
    case 429:
      return rateOrBillingError(err, provider, name, full, raw);
    case 400:
      return new AppError('llm', `${name} 拒绝了请求：${raw}`, '按上面的原因处理；如果改过模型名，确认该模型支持结构化输出');
    default:
      if (status && status >= 500) return new AppError('llm', `${name} 服务暂时不可用（HTTP ${status}）`, '稍后重试');
      return new AppError('llm', `${name} 调用失败：${raw}`);
  }
}

export function createAnthropicClient(cfg: LlmConfig): LlmClient {
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    dangerouslyAllowBrowser: true,
    maxRetries: LLM_LIMITS.maxRetries,
    timeout: LLM_LIMITS.timeoutMs,
    ...(cfg.workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': cfg.workspaceId } } : {}),
    ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
  });
  const run = async (req: JsonRequest): Promise<{ value: unknown; usage: LlmUsage }> => {
      try {
        const res = await client.beta.messages.create({
          model: cfg.model,
          max_tokens: LLM_LIMITS.maxTokens,
          system: wellFormed(req.system),
          messages: [{ role: 'user', content: wellFormed(req.user) }],
          output_config: { effort: req.effort, format: { type: 'json_schema', schema: req.schema } },
          // 服务端拒答回退："default" 在不支持的模型上等同于不回退
          betas: [ANTHROPIC_FALLBACK.beta],
          fallbacks: ANTHROPIC_FALLBACK.fallbacks,
        });
        if (res.stop_reason === 'refusal') {
          throw new AppError('llm', '模型拒绝处理这条口令', '换个说法再试');
        }
        if (res.stop_reason === 'max_tokens') {
          throw new AppError('llm', '模型输出被截断了', '请重试；口令过长时可以拆短一点');
        }
        const text = res.content
          .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (!text) throw new AppError('llm', 'Anthropic 没有返回内容', '请重试');
        return { value: parseJsonText(text, 'anthropic'), usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 } };
      } catch (e) {
        throw mapLlmError(e, 'anthropic', cfg.model, cfg.apiKey);
      }
  };
  return {
    provider: 'anthropic',
    model: cfg.model,
    generateJson: (req) => run(req).then((r) => r.value),
    generateJsonWithUsage: run,
  };
}

/** 只有推理模型接受 reasoning 参数；其他模型（如 gpt-4o）发送会被拒绝。 */
export function supportsReasoningEffort(model: string): boolean {
  return /^(gpt-[5-9]|o\d)/i.test(model);
}

export function createOpenAIClient(cfg: LlmConfig): LlmClient {
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    dangerouslyAllowBrowser: true,
    maxRetries: LLM_LIMITS.maxRetries,
    timeout: LLM_LIMITS.timeoutMs,
    ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
  });
  const run = async (req: JsonRequest): Promise<{ value: unknown; usage: LlmUsage }> => {
      try {
        const res = await client.responses.create({
          model: cfg.model,
          instructions: wellFormed(req.system),
          input: wellFormed(req.user),
          max_output_tokens: LLM_LIMITS.maxTokens,
          text: { format: { type: 'json_schema', name: req.schemaName, schema: req.schema, strict: true } },
          ...(supportsReasoningEffort(cfg.model) ? { reasoning: { effort: req.effort } } : {}),
          store: false,
        });
        if (res.status === 'incomplete') {
          throw new AppError('llm', `OpenAI 输出不完整（${res.incomplete_details?.reason ?? '未知原因'}）`, '请重试');
        }
        let collected = '';
        for (const item of res.output ?? []) {
          if (item.type === 'message') {
            for (const part of item.content) {
              if (part.type === 'refusal') throw new AppError('llm', '模型拒绝处理这条口令', '换个说法再试');
              if (part.type === 'output_text') collected += part.text;
            }
          }
        }
        const text = res.output_text || collected;
        if (!text) throw new AppError('llm', 'OpenAI 没有返回内容', '请重试');
        return { value: parseJsonText(text, 'openai'), usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 } };
      } catch (e) {
        throw mapLlmError(e, 'openai', cfg.model, cfg.apiKey);
      }
  };
  return {
    provider: 'openai',
    model: cfg.model,
    generateJson: (req) => run(req).then((r) => r.value),
    generateJsonWithUsage: run,
  };
}

export function createLlmClient(cfg: LlmConfig): LlmClient {
  return cfg.provider === 'anthropic' ? createAnthropicClient(cfg) : createOpenAIClient(cfg);
}

// ── 语音转写（自动字幕）：OpenAI /v1/audio/transcriptions，一段一段上传 WAV ──

export interface TranscribeRequest {
  wav: Uint8Array;
  /** 前文（提高断句、人名、术语的连贯性） */
  prompt?: string;
}

export interface TranscribeResult {
  text: string;
  /** 识别出的语言（gpt-transcribe 返回 languages: [{ code }]；可能为空） */
  language?: string;
  /** 服务方报告的计费时长；没报告时为 undefined，由调用方按音频时长记账 */
  billedSeconds?: number;
}

export interface Transcriber {
  model: string;
  transcribe(req: TranscribeRequest): Promise<TranscribeResult>;
}

export function createTranscriber(cfg: { model: string; apiKey: string; baseURL: string; fetch?: typeof fetch }): Transcriber {
  const base = cfg.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  // 带上 Response：SDK 上传文件前会检测 fetch 是否支持 FormData，没有这个属性时会去 fetch('data:,')，被扩展的 CSP 拦下并报错
  const fetchWithResponse = Object.assign((input: RequestInfo | URL, init?: RequestInit) => base(input, init), { Response });
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    timeout: LLM_LIMITS.transcribeTimeoutMs,
    fetch: fetchWithResponse,
  });
  return {
    model: cfg.model,
    async transcribe(req) {
      try {
        const file = await toFile(req.wav, 'segment.wav', { type: 'audio/wav' });
        const res = (await client.audio.transcriptions.create({
          file,
          model: cfg.model,
          response_format: 'json',
          ...(req.prompt ? { prompt: wellFormed(req.prompt) } : {}),
        })) as { text?: unknown; languages?: { code?: unknown }[]; usage?: { type?: string; seconds?: unknown } };
        const language = res.languages?.find((l) => typeof l?.code === 'string')?.code as string | undefined;
        const seconds = res.usage?.type === 'duration' && typeof res.usage.seconds === 'number' ? res.usage.seconds : undefined;
        return {
          text: typeof res.text === 'string' ? res.text.trim() : '',
          ...(language ? { language } : {}),
          ...(seconds !== undefined ? { billedSeconds: seconds } : {}),
        };
      } catch (e) {
        const err = mapLlmError(e, 'openai', cfg.model, cfg.apiKey);
        if (err.kind === 'llm' && /模型「/.test(err.message)) {
          throw new AppError('subtitles', `语音转写模型「${cfg.model}」不存在或你的 OpenAI 账户无权使用`, '在设置页「12. 自动字幕」检查转写模型名（默认 gpt-transcribe）');
        }
        throw err;
      }
    },
  };
}
