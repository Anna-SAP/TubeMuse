// 所有大模型调用的唯一入口：按任务选模型、调用前预扣每日预算、调用后按实际用量结算。
// 字幕翻译有自己的预算和账本（subtitle-service.ts），不走这里。

import { LLM_LIMITS, LLM_TASKS, STORY, type LlmTask } from '../config/defaults';
import { abandonLlmHold, estimateInputTokens, llmCostUsd, llmHoldFits, llmSnapshot, openLlmHold, releaseLlmHold, settleLlmHold, webSearchUsd, worstCaseLlmUsd, type LlmSnapshot } from '../core/spend';
import type { ResearchRaw } from '../core/story';
import { dayKey, nextMidnight } from '../core/time';
import type { AppContext } from './context';
import { AppError } from './errors';
import { createLlmClient, type JsonRequest, type LlmClient, type LlmProvider, type LlmUsage, type ResearchRequest } from './llm';
import { newId, stores, type Settings } from './repo';

const NAMES = { anthropic: 'Anthropic', openai: 'OpenAI' } as const;

export async function llmSpend(ctx: AppContext): Promise<LlmSnapshot> {
  const [ledger, settings] = await Promise.all([stores.llmLedger.read(ctx.kv), stores.settings.read(ctx.kv)]);
  const now = ctx.now();
  return llmSnapshot(ledger, settings.llm.dailyBudgetUsd, settings.quota.warnRatio, dayKey(now, ctx.timeZone), nextMidnight(now, ctx.timeZone));
}

/** 这个任务现在用哪个模型：设置里的档位优先，省钱模型留空时跟随主模型 */
export function taskModel(settings: Settings, task: LlmTask): { provider: LlmProvider; model: string } {
  const provider = settings.llm.provider;
  const tier = settings.llm.taskTiers[task] ?? LLM_TASKS[task].tier;
  const main = settings.llm.models[provider].trim();
  const economy = settings.llm.economyModels[provider].trim();
  return { provider, model: tier === 'economy' && economy ? economy : main };
}

function budgetError(snap: LlmSnapshot, needUsd: number): AppError {
  return new AppError(
    'llm_budget',
    `今天的大模型预算不够这次调用：最多可能花 $${needUsd.toFixed(3)}，还剩 $${snap.remainingUsd.toFixed(3)}（上限 $${snap.budgetUsd.toFixed(2)}），已停止调用`,
    '可以在设置页「1. 大模型」调高每日上限，或把这一步改用省钱模型；本地时间 0 点自动恢复',
  );
}

/** 按典型用量估算这个任务一次花多少：token 加上典型的联网搜索次数（只有"故事调研"有） */
export function taskTypicalUsd(settings: Settings, task: LlmTask): number {
  const t: { inputTokens: number; outputTokens: number; searches?: number } = LLM_TASKS[task].typical;
  const { provider, model } = taskModel(settings, task);
  return llmCostUsd(model, t.inputTokens, t.outputTokens) + webSearchUsd(provider, t.searches ?? 0);
}

/** 按典型用量估算这个任务每月花多少（设置页显示）：是估算，不是账单 */
export function taskMonthlyUsd(settings: Settings, task: LlmTask): number {
  return taskTypicalUsd(settings, task) * LLM_TASKS[task].typical.perDay * 30;
}

export type TaskRequest = Omit<JsonRequest, 'maxOutputTokens'>;
export type TaskResearchRequest = Omit<ResearchRequest, 'maxOutputTokens'>;

export interface TaskLlm {
  provider: LlmProvider;
  model: string;
  generateJson(req: TaskRequest): Promise<unknown>;
  generateJsonWithUsage(req: TaskRequest): Promise<{ value: unknown; usage: LlmUsage }>;
  /** 不发请求，只确认预算够不够这么大的一次调用：下一步要先花别的钱时用，免得花完才发现这一步走不通 */
  assertAffordable(inputChars: number): Promise<void>;
  /**
   * 联网调研（故事）：预扣时按"每次搜索带回 STORY.searchInputTokens 个 token 的网页内容、搜满 maxSearches 次、输出写满"估最坏情况，
   * 结算按服务方报告的 token 用量加上实际搜索次数 × 单价
   */
  research(req: TaskResearchRequest): Promise<{ raw: ResearchRaw; usage: LlmUsage }>;
}

function worstCase(client: LlmClient, task: LlmTask, inputTokens: number): number {
  return worstCaseLlmUsd(client.model, inputTokens, LLM_TASKS[task].maxOutputTokens);
}

async function metered(ctx: AppContext, task: LlmTask, client: LlmClient, budgetUsd: number, req: TaskRequest): Promise<{ value: unknown; usage: LlmUsage }> {
  const maxOutputTokens = LLM_TASKS[task].maxOutputTokens;
  const usd = worstCase(client, task, estimateInputTokens(req.system, req.user, JSON.stringify(req.schema)));
  return meteredCall(ctx, task, client, budgetUsd, usd, () => client.generateJsonWithUsage({ ...req, maxOutputTokens }));
}

/** 联网调研最多花多少：输入按提示词加上每次搜索带回的网页内容估，输出按上限，再加上搜满次数的搜索费 */
export function worstCaseResearchUsd(provider: LlmProvider, model: string, task: LlmTask, system: string, user: string, maxSearches: number): number {
  const input = estimateInputTokens(system, user) + maxSearches * STORY.searchInputTokens;
  return worstCaseLlmUsd(model, input, LLM_TASKS[task].maxOutputTokens) + webSearchUsd(provider, maxSearches);
}

/**
 * 所有大模型调用的记账：发请求之前把最坏情况写进账本（预扣），回来后按实际用量结算（联网搜索的次数另算钱）；
 * 服务方明确拒绝（没有计费）退回；不知道有没有计费（超时、断网）按预扣额记成"未确认"。
 */
async function meteredCall<T extends { usage: LlmUsage }>(ctx: AppContext, task: LlmTask, client: LlmClient, budgetUsd: number, usd: number, call: () => Promise<T>): Promise<T> {
  const holdId = newId('l');
  const now = ctx.now();
  const day = dayKey(now, ctx.timeZone);
  // 请求发出去之前先把最坏情况写进账本：之后不管是页面被关还是响应丢了，这笔钱都算着
  await stores.llmLedger.update(ctx.kv, ctx.locker, (l) => {
    if (!llmHoldFits(l, day, budgetUsd, usd)) throw budgetError(llmSnapshot(l, budgetUsd, 1, day, nextMidnight(now, ctx.timeZone)), usd);
    return openLlmHold(l, day, { id: holdId, usd, at: now, what: LLM_TASKS[task].label });
  });
  const settle = (usage: LlmUsage) => stores.llmLedger.update(ctx.kv, ctx.locker, (l) => settleLlmHold(l, holdId, task, client.model, usage, webSearchUsd(client.provider, usage.webSearches ?? 0)));
  try {
    const out = await call();
    // 服务方总会报告用量；万一没报，不能当 $0，按最坏情况留在账上
    if (out.usage.inputTokens + out.usage.outputTokens > 0) await settle(out.usage);
    else await stores.llmLedger.update(ctx.kv, ctx.locker, (l) => abandonLlmHold(l, holdId));
    return out;
  } catch (e) {
    const billing = e instanceof AppError ? e.billing : { state: 'unknown' as const };
    if (billing?.state === 'billed' && billing.usage) await settle(billing.usage);
    else if (billing) await stores.llmLedger.update(ctx.kv, ctx.locker, (l) => abandonLlmHold(l, holdId));
    else await stores.llmLedger.update(ctx.kv, ctx.locker, (l) => releaseLlmHold(l, holdId));
    throw e;
  }
}

/** 按设置创建这个任务要用的大模型客户端；没填 Key 时直接告诉用户，不会退回到别的提供商。 */
export async function getLlm(ctx: AppContext, task: LlmTask): Promise<TaskLlm> {
  const [settings, secrets] = await Promise.all([stores.settings.read(ctx.kv), stores.secrets.read(ctx.kv)]);
  const { provider, model } = taskModel(settings, task);
  const apiKey = provider === 'anthropic' ? secrets.anthropicApiKey : secrets.openaiApiKey;
  if (!apiKey) throw new AppError('llm_key', `还没有填写 ${NAMES[provider]} API Key`, '打开设置页填写；Key 只保存在本机');
  if (!model) throw new AppError('llm', '模型名为空', '在设置页填写模型名');
  const client = createLlmClient({
    provider,
    model,
    apiKey,
    ...(provider === 'anthropic' && secrets.anthropicWorkspaceId ? { workspaceId: secrets.anthropicWorkspaceId } : {}),
    baseURL: provider === 'anthropic' ? ctx.endpoints.anthropic : ctx.endpoints.openai,
    fetch: ctx.http,
  });
  const budgetUsd = settings.llm.dailyBudgetUsd;
  const run = (req: TaskRequest) => metered(ctx, task, client, budgetUsd, req);
  return {
    provider,
    model,
    generateJson: (req) => run(req).then((r) => r.value),
    generateJsonWithUsage: run,
    research: (req) =>
      meteredCall(ctx, task, client, budgetUsd, worstCaseResearchUsd(provider, model, task, req.system, req.user, req.maxSearches), () =>
        client.research({ ...req, maxOutputTokens: LLM_TASKS[task].maxOutputTokens }),
      ),
    async assertAffordable(inputChars) {
      const usd = worstCase(client, task, Math.ceil(inputChars * LLM_LIMITS.tokensPerChar));
      const now = ctx.now();
      const day = dayKey(now, ctx.timeZone);
      const ledger = await stores.llmLedger.read(ctx.kv);
      if (!llmHoldFits(ledger, day, budgetUsd, usd)) throw budgetError(llmSnapshot(ledger, budgetUsd, 1, day, nextMidnight(now, ctx.timeZone)), usd);
    },
  };
}

/** 设置页的"测试连接"：发一个极小的结构化请求（会产生少量真实费用，只在用户点击时调用）。 */
export async function pingLlm(ctx: AppContext): Promise<string> {
  const llm = await getLlm(ctx, 'ping');
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
