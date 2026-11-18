// LLM 客户端：Anthropic（官方 SDK）与 OpenAI（官方 SDK），统一成"按 JSON Schema 返回结构化结果"。
// Key 只放在请求头里发往对应服务；错误信息经过脱敏。

import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';
import { ANTHROPIC_FALLBACK, LLM_LIMITS, STORY } from '../config/defaults';
import type { JsonSchema } from '../core/prompts';
import { redact } from '../core/redact';
import type { ResearchRaw } from '../core/story';
import { wellFormed } from '../core/text';
import { AppError, type Billing } from './errors';

export type LlmProvider = 'anthropic' | 'openai';

export interface JsonRequest {
  system: string;
  user: string;
  schema: JsonSchema;
  schemaName: string;
  /** 解析口令用 low，聚类用 medium */
  effort: 'low' | 'medium';
  /** 输出上限：一次调用花费的硬边界 */
  maxOutputTokens: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** 服务方自带的联网搜索做了几次（每次另收费；只有"故事调研"会用到） */
  webSearches?: number;
}

/**
 * 带联网搜索的调研（故事，DECISIONS §88）：让大模型用服务方自带的搜索工具查资料、写带引用的笔记。
 * 不要求结构化输出（各家的搜索引用和 JSON 结构化输出不能同时用），整理成结构化结果是下一步的事。
 */
export interface ResearchRequest {
  system: string;
  user: string;
  /** 最多搜几次 */
  maxSearches: number;
  maxOutputTokens: number;
  effort: 'low' | 'medium';
}

export interface LlmClient {
  provider: LlmProvider;
  model: string;
  generateJson(req: JsonRequest): Promise<unknown>;
  /** 同 generateJson，并返回服务方报告的 token 用量（自动字幕按此记账） */
  generateJsonWithUsage(req: JsonRequest): Promise<{ value: unknown; usage: LlmUsage }>;
  /** 联网调研：回答的文字、引用的网页、搜索结果、搜了什么；用量里带着搜索次数 */
  research(req: ResearchRequest): Promise<{ raw: ResearchRaw; usage: LlmUsage }>;
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

/** 响应已经回来才失败的（被截断、不是 JSON、模型拒绝）：钱花了，把用量带上，由调用方记账 */
function billedError(err: AppError, usage: LlmUsage | undefined): AppError {
  return usage ? new AppError(err.kind, err.message, err.hint, err.retryAfterMs, { state: 'billed', usage }) : err;
}

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

/**
 * 服务方明确拒绝（408/409/429/5xx，没有计费）时等多久再试一次；其他情况返回 undefined。
 * 超时和断线不重试：请求可能已经在服务方跑完并计费了，重发可能付两次钱。要等太久的也不等，直接告诉你。
 */
export function refusedRetryWait(err: unknown, now: number): number | undefined {
  const status = (err as ApiErrorLike)?.status;
  if (typeof status !== 'number' || !(status === 408 || status === 409 || status === 429 || status >= 500)) return undefined;
  const wait = retryAfterMs((err as { headers?: Headers }).headers, now) ?? LLM_LIMITS.retryDelayMs;
  return wait <= LLM_LIMITS.maxRetryWaitMs ? wait : undefined;
}

async function withOneRetry<T>(attempt: () => Promise<T>, retryable: (e: unknown) => boolean): Promise<T> {
  try {
    return await attempt();
  } catch (e) {
    const wait = refusedRetryWait(e, Date.now());
    if (wait === undefined || !retryable(e)) throw e;
    await new Promise((r) => setTimeout(r, wait));
    return attempt();
  }
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
  // 请求可能已经发出去并跑完了：账上按花了算
  const unknown: Billing = { state: 'unknown' };
  if (isTimeout) return new AppError('network', `${name} 请求超时`, '稍后重试', undefined, unknown);
  if (isConn) return new AppError('network', `无法连接到 ${name} API（网络错误）`, '检查网络后重试', undefined, unknown);
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
    let usage: LlmUsage | undefined;
    try {
      return await withOneRetry(async () => {
        const res = await client.beta.messages.create({
          model: cfg.model,
          max_tokens: req.maxOutputTokens,
          system: wellFormed(req.system),
          messages: [{ role: 'user', content: wellFormed(req.user) }],
          output_config: { effort: req.effort, format: { type: 'json_schema', schema: req.schema } },
          // 服务端拒答回退："default" 在不支持的模型上等同于不回退
          betas: [ANTHROPIC_FALLBACK.beta],
          fallbacks: ANTHROPIC_FALLBACK.fallbacks,
        });
        usage = { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 };
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
        return { value: parseJsonText(text, 'anthropic'), usage };
      }, () => true);
    } catch (e) {
      throw billedError(mapLlmError(e, 'anthropic', cfg.model, cfg.apiKey), usage);
    }
  };
  const research = async (req: ResearchRequest): Promise<{ raw: ResearchRaw; usage: LlmUsage }> => {
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, webSearches: 0 };
    const add = (u: Anthropic.Beta.Messages.BetaUsage | undefined) => {
      usage.inputTokens += (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);
      usage.outputTokens += u?.output_tokens ?? 0;
      usage.webSearches = (usage.webSearches ?? 0) + (u?.server_tool_use?.web_search_requests ?? 0);
    };
    const billed = () => usage.inputTokens + usage.outputTokens + (usage.webSearches ?? 0) > 0;
    try {
      const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: 'user', content: wellFormed(req.user) }];
      const blocks: Anthropic.Beta.Messages.BetaContentBlock[] = [];
      let container: string | undefined;
      let paused = false;
      for (let turn = 0; ; turn++) {
        const res = await withOneRetry(
          () =>
            client.beta.messages.create(
              {
                model: cfg.model,
                max_tokens: req.maxOutputTokens,
                system: wellFormed(req.system),
                messages,
                tools: [anthropicWebSearchTool(cfg.model, req.maxSearches)],
                output_config: { effort: req.effort },
                ...(container ? { container } : {}),
                betas: [ANTHROPIC_FALLBACK.beta],
                fallbacks: ANTHROPIC_FALLBACK.fallbacks,
              },
              { timeout: STORY.researchTimeoutMs },
            ),
          // 服务方明确拒绝（没有计费）时重试这一次请求；接着做的那几次也一样，只重试被拒的那一次，不重复前面的
          () => true,
        );
        add(res.usage);
        blocks.push(...res.content);
        container = res.container?.id ?? container;
        if (res.stop_reason === 'refusal') throw new AppError('llm', '模型拒绝调研这个页面', '换一个页面，或者把要查的部分选中后再试');
        if (res.stop_reason === 'max_tokens') throw new AppError('llm', '调研笔记写到一半被截断了', '再试一次；或者在设置页把"故事调研"换成主模型');
        if (res.stop_reason !== 'pause_turn') break;
        // 服务方说这一轮还没做完（搜索循环到了上限）：把这一段原样交回去，让它接着做；最多接几次
        if (turn >= STORY.maxContinuations) {
          paused = true;
          break;
        }
        messages.push({ role: 'assistant', content: res.content as Anthropic.Beta.Messages.BetaContentBlockParam[] });
      }
      const raw = anthropicResearchRaw(blocks);
      if (paused) raw.errors.push('paused');
      return { raw, usage };
    } catch (e) {
      throw billedError(mapLlmError(e, 'anthropic', cfg.model, cfg.apiKey), billed() ? usage : undefined);
    }
  };
  return {
    provider: 'anthropic',
    model: cfg.model,
    generateJson: (req) => run(req).then((r) => r.value),
    generateJsonWithUsage: run,
    research,
  };
}

/**
 * Anthropic 的联网搜索工具。Claude 4.6 及以后的模型用 web_search_20260209：大模型先写代码筛一遍搜索结果、只把有用的放进上下文，
 * 省 token（"dynamic filtering"，代码执行不另收费）；更早的模型只有基础版 web_search_20250305（2026-11-18 核实官方文档）。
 */
export function anthropicWebSearchTool(model: string, maxUses: number): Anthropic.Beta.Messages.BetaWebSearchTool20260209 | Anthropic.Beta.Messages.BetaWebSearchTool20250305 {
  const legacy = /^claude-(?:3|(?:haiku|sonnet|opus)-4(?:-[0-5])?(?:-\d{8})?$|(?:haiku|sonnet|opus)-4-[0-5]-)/.test(model.trim());
  return legacy ? { type: 'web_search_20250305', name: 'web_search', max_uses: maxUses } : { type: 'web_search_20260209', name: 'web_search', max_uses: maxUses };
}

/** 从 Anthropic 的回答里取出：文字段落和各自的引用、搜索结果、搜索词、搜索出错的错误码（不认识的块一律跳过） */
export function anthropicResearchRaw(blocks: readonly unknown[]): ResearchRaw {
  const raw: ResearchRaw = { segments: [], results: [], queries: [], errors: [] };
  for (const b of blocks) {
    const block = b as { type?: string; text?: unknown; citations?: unknown; name?: unknown; input?: { query?: unknown }; content?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') {
      const cites = (Array.isArray(block.citations) ? block.citations : [])
        .filter((c: { type?: string; url?: unknown }) => c?.type === 'web_search_result_location' && typeof c.url === 'string')
        .map((c: { url: string; title?: unknown; cited_text?: unknown }) => ({
          url: c.url,
          ...(typeof c.title === 'string' ? { title: c.title } : {}),
          ...(typeof c.cited_text === 'string' ? { quote: c.cited_text } : {}),
        }));
      raw.segments.push({ text: block.text, cites });
    } else if (block.type === 'server_tool_use' && block.name === 'web_search' && typeof block.input?.query === 'string') {
      raw.queries.push(block.input.query);
    } else if (block.type === 'web_search_tool_result') {
      if (Array.isArray(block.content)) {
        for (const r of block.content as { type?: string; url?: unknown; title?: unknown; page_age?: unknown }[]) {
          if (r?.type === 'web_search_result' && typeof r.url === 'string') {
            raw.results.push({ url: r.url, ...(typeof r.title === 'string' ? { title: r.title } : {}), ...(typeof r.page_age === 'string' ? { date: r.page_age } : {}) });
          }
        }
      } else {
        const code = (block.content as { error_code?: unknown } | undefined)?.error_code;
        raw.errors.push(typeof code === 'string' ? code : 'unknown');
      }
    }
  }
  return raw;
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
    let usage: LlmUsage | undefined;
    try {
      return await withOneRetry(async () => {
        const res = await client.responses.create({
          model: cfg.model,
          instructions: wellFormed(req.system),
          input: wellFormed(req.user),
          max_output_tokens: req.maxOutputTokens,
          text: { format: { type: 'json_schema', name: req.schemaName, schema: req.schema, strict: true } },
          ...(supportsReasoningEffort(cfg.model) ? { reasoning: { effort: req.effort } } : {}),
          store: false,
        });
        usage = { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 };
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
        return { value: parseJsonText(text, 'openai'), usage };
      }, (e) => mapLlmError(e, 'openai', cfg.model, cfg.apiKey).kind !== 'llm_quota');
    } catch (e) {
      throw billedError(mapLlmError(e, 'openai', cfg.model, cfg.apiKey), usage);
    }
  };
  const research = async (req: ResearchRequest): Promise<{ raw: ResearchRaw; usage: LlmUsage }> => {
    let usage: LlmUsage | undefined;
    try {
      return await withOneRetry(async () => {
        const res = await client.responses.create(
          {
            model: cfg.model,
            instructions: wellFormed(req.system),
            input: wellFormed(req.user),
            max_output_tokens: req.maxOutputTokens,
            tools: [{ type: 'web_search' }],
            // 搜索用过的全部网页（不只是回答里引用的）：来源清单要用
            include: ['web_search_call.action.sources'],
            // OpenAI 的 Responses 接口（这一版 SDK）没有"最多搜几次"的参数：次数只在提示词里限定，实际按服务方报告的次数结算
            ...(supportsReasoningEffort(cfg.model) ? { reasoning: { effort: req.effort } } : {}),
            store: false,
          },
          { timeout: STORY.researchTimeoutMs },
        );
        const raw = openaiResearchRaw(res.output ?? []);
        usage = { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0, webSearches: raw.searches };
        if (raw.refused) throw new AppError('llm', '模型拒绝调研这个页面', '换一个页面，或者把要查的部分选中后再试');
        if (res.status === 'incomplete') throw new AppError('llm', `OpenAI 的调研没有做完（${res.incomplete_details?.reason ?? '未知原因'}）`, '再试一次；或者在设置页把"故事调研"换成主模型');
        return { raw: raw.raw, usage };
      }, (e) => mapLlmError(e, 'openai', cfg.model, cfg.apiKey).kind !== 'llm_quota');
    } catch (e) {
      throw billedError(mapLlmError(e, 'openai', cfg.model, cfg.apiKey), usage);
    }
  };
  return {
    provider: 'openai',
    model: cfg.model,
    generateJson: (req) => run(req).then((r) => r.value),
    generateJsonWithUsage: run,
    research,
  };
}

/**
 * 从 OpenAI Responses 的输出里取出：文字段落（按 url_citation 的位置切开，引用挂在它结束的那一段上）、搜索结果、搜索词。
 * 只有 search 动作收费（打开网页、页内查找不收，OpenAI 定价页 2026-11-18 核实），searches 只数它。
 */
export function openaiResearchRaw(output: readonly unknown[]): { raw: ResearchRaw; searches: number; refused: boolean } {
  const raw: ResearchRaw = { segments: [], results: [], queries: [], errors: [] };
  let searches = 0;
  let refused = false;
  for (const o of output) {
    const item = o as { type?: string; status?: string; action?: { type?: string; query?: unknown; queries?: unknown; sources?: unknown; url?: unknown }; content?: unknown };
    if (item.type === 'web_search_call') {
      const a = item.action;
      if (item.status === 'failed') raw.errors.push('failed');
      if (a?.type === 'search' || a === undefined) {
        searches++;
        const qs = Array.isArray(a?.queries) ? a.queries : typeof a?.query === 'string' ? [a.query] : [];
        for (const q of qs) if (typeof q === 'string') raw.queries.push(q);
        for (const src of Array.isArray(a?.sources) ? (a.sources as { url?: unknown }[]) : []) if (typeof src?.url === 'string') raw.results.push({ url: src.url });
      } else if (a?.type === 'open_page' && typeof a.url === 'string') {
        raw.results.push({ url: a.url });
      }
    } else if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content as { type?: string; text?: unknown; annotations?: unknown }[]) {
        if (part?.type === 'refusal') refused = true;
        if (part?.type !== 'output_text' || typeof part.text !== 'string') continue;
        const text = part.text;
        const notes = (Array.isArray(part.annotations) ? part.annotations : [])
          .filter((n: { type?: string; url?: unknown; end_index?: unknown }) => n?.type === 'url_citation' && typeof n.url === 'string')
          .map((n: { url: string; title?: unknown; end_index?: unknown }) => ({ url: n.url, title: typeof n.title === 'string' ? n.title : undefined, end: Math.min(text.length, Math.max(0, Number(n.end_index) || text.length)) }))
          .sort((x: { end: number }, y: { end: number }) => x.end - y.end);
        let at = 0;
        for (let i = 0; i < notes.length; ) {
          const end = notes[i]!.end;
          const cites: { url: string; title?: string }[] = [];
          while (i < notes.length && notes[i]!.end === end) {
            const n = notes[i++]!;
            cites.push({ url: n.url, ...(n.title ? { title: n.title } : {}) });
          }
          raw.segments.push({ text: text.slice(at, end), cites });
          at = end;
        }
        if (at < text.length) raw.segments.push({ text: text.slice(at), cites: [] });
      }
    }
  }
  return { raw, searches, refused };
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
