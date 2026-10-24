// LLM 客户端：Anthropic（官方 SDK）与 OpenAI（官方 SDK），统一成"按 JSON Schema 返回结构化结果"。
// Key 只放在请求头里发往对应服务；错误信息经过脱敏。

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
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

export interface LlmClient {
  provider: LlmProvider;
  model: string;
  generateJson(req: JsonRequest): Promise<unknown>;
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
      return new AppError('llm', `${name} 请求过于频繁或额度不足`, '稍后重试，或检查账户余额');
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
  return {
    provider: 'anthropic',
    model: cfg.model,
    async generateJson(req) {
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
        return parseJsonText(text, 'anthropic');
      } catch (e) {
        throw mapLlmError(e, 'anthropic', cfg.model, cfg.apiKey);
      }
    },
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
  return {
    provider: 'openai',
    model: cfg.model,
    async generateJson(req) {
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
        return parseJsonText(text, 'openai');
      } catch (e) {
        throw mapLlmError(e, 'openai', cfg.model, cfg.apiKey);
      }
    },
  };
}

export function createLlmClient(cfg: LlmConfig): LlmClient {
  return cfg.provider === 'anthropic' ? createAnthropicClient(cfg) : createOpenAIClient(cfg);
}
