import type { AppContext } from './context';
import { AppError } from './errors';
import { createLlmClient, type LlmClient } from './llm';
import { stores } from './repo';

const NAMES = { anthropic: 'Anthropic', openai: 'OpenAI' } as const;

/** 按设置创建当前选中的 LLM 客户端；没填 Key 时直接告诉用户，不会退回到别的提供商。 */
export async function getLlm(ctx: AppContext): Promise<LlmClient> {
  const [settings, secrets] = await Promise.all([stores.settings.read(ctx.kv), stores.secrets.read(ctx.kv)]);
  const provider = settings.llm.provider;
  const apiKey = provider === 'anthropic' ? secrets.anthropicApiKey : secrets.openaiApiKey;
  if (!apiKey) throw new AppError('llm_key', `还没有填写 ${NAMES[provider]} API Key`, '打开设置页填写；Key 只保存在本机');
  const model = settings.llm.models[provider].trim();
  if (!model) throw new AppError('llm', '模型名为空', '在设置页填写模型名');
  return createLlmClient({
    provider,
    model,
    apiKey,
    ...(provider === 'anthropic' && secrets.anthropicWorkspaceId ? { workspaceId: secrets.anthropicWorkspaceId } : {}),
    baseURL: provider === 'anthropic' ? ctx.endpoints.anthropic : ctx.endpoints.openai,
    fetch: ctx.http,
  });
}

/** 设置页的"测试连接"：发一个极小的结构化请求（会产生少量真实费用，只在用户点击时调用）。 */
export async function pingLlm(ctx: AppContext): Promise<string> {
  const llm = await getLlm(ctx);
  const out = (await llm.generateJson({
    system: '只回复 {"ok": true}。',
    user: 'ping',
    schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
    schemaName: 'ping',
    effort: 'low',
  })) as { ok?: boolean };
  if (out?.ok !== true) throw new AppError('llm', '连接成功，但返回内容不符合预期');
  return `${NAMES[llm.provider]} · ${llm.model} 连接正常`;
}
