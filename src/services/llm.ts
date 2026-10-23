// LLM 客户端：Anthropic（官方 SDK）与 OpenAI（官方 SDK），统一成"按 JSON Schema 返回结构化结果"。
// Key 只放在请求头里发往对应服务；错误信息经过脱敏。

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ANTHROPIC_FALLBACK, LLM_LIMITS } from '../config/defaults';
import type { JsonSchema } from '../core/prompts';
import { redact } from '../core/redact';
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
  fetch?: typeof fetch;
}

const PROVIDER_NAMES: Record<LlmProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

function parseJsonText(text: string, provider: LlmProvider): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('llm', `${PROVIDER_NAMES[provider]} 返回的内容不是合法 JSON`, '请重试；如反复出现，换一个模型');
  }
}

type ApiErrorLike = { status?: number; message?: string };

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
  const raw = redact(String((err as ApiErrorLike)?.message ?? err), [apiKey]).slice(0, 200);
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
      return new AppError('llm', `${name} 拒绝了请求：${raw}`, '如果改过模型名，确认该模型支持结构化输出');
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
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
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
          instructions: req.system,
          input: req.user,
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
