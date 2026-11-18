// 故事（2026-11-18 新增，见 DECISIONS §88）：把读到的页面交给大模型联网调研，再整理成"核心说法逐条核对 / 来龙去脉 / 各方立场 / 背景 /
// 深层含义 / 还不清楚的"，存进本机。只在你点"调研"时运行（要花钱），在侧边栏里直接调大模型；发送的内容见 core/prompts.ts 的
// buildStoryResearchPrompt、buildStoryBriefPrompt。
//
// 两步：
// 1. 调研（storyResearch）：带着服务方自带的联网搜索，写一份带引用的笔记。来源清单只取服务方真的搜到、引用过的网页。
// 2. 整理（storyBrief）：把笔记整理成结构化结果（不联网，结构化输出）。来源编号、"已证实"的底线由 core/story.ts 的 parseStoryBrief 再校验。
// 第二步失败时，第一步的笔记在内存里留一会儿：再点一次只重做第二步，不再花搜索的钱。

import { LLM_TASKS, STORY } from '../config/defaults';
import { llmPrice, webSearchUsd, llmCostUsd } from '../core/spend';
import { STORY_BRIEF_SCHEMA, buildStoryBriefPrompt, buildStoryResearchPrompt } from '../core/prompts';
import { assembleResearch, cachedStory, parseStoryBrief, rememberStory, storyKey, forgetStory, type ResearchNotes, type StoryPage, type StoryRecord } from '../core/story';
import { localIso, type AppContext } from './context';
import { AppError } from './errors';
import { getLlm, taskModel, taskTypicalUsd } from './llm-factory';
import { newId, stores, type Settings } from './repo';

/** 调研到了哪一步（界面上显示） */
export type StoryStage = 'search' | 'brief';

export interface StoryRunOptions {
  /** 忽略缓存，重新调研（"重新调研"） */
  force?: boolean;
  onStage?: (stage: StoryStage) => void;
}

export interface StoryRunResult {
  record: StoryRecord;
  /** 直接用了上次的结果，没有花钱 */
  cached: boolean;
  /** 用了内存里留着的调研笔记，只重做了整理这一步 */
  reusedNotes: boolean;
}

/** 第一步的结果：第二步失败时留着，再点一次不用重新搜索 */
interface PendingNotes {
  key: string;
  at: number;
  notes: ResearchNotes;
  usd: number;
  searches: number;
  model: string;
  provider: 'anthropic' | 'openai';
  estimatedPrice: boolean;
}

/** 只留在这个侧边栏页面的内存里（关掉就没了），留多久 */
const NOTES_KEEP_MS = 30 * 60_000;
let pending: PendingNotes | undefined;

/** 测试用：清掉内存里留着的笔记 */
export function resetStoryMemory(): void {
  pending = undefined;
}

/** 调研一次大约花多少（界面在按钮下面说明）：按典型用量估，实际花费调研完显示 */
export function estimateStoryUsd(settings: Settings): { usd: number; model: string; searches: number } {
  const t = LLM_TASKS.storyResearch.typical;
  const searches = Math.min(t.searches, Math.max(1, settings.story.maxSearches));
  const { provider, model } = taskModel(settings, 'storyResearch');
  return { usd: llmCostUsd(model, t.inputTokens, t.outputTokens) + webSearchUsd(provider, searches) + taskTypicalUsd(settings, 'storyBrief'), model, searches };
}

async function research(ctx: AppContext, page: StoryPage, key: string, settings: Settings): Promise<PendingNotes> {
  const llm = await getLlm(ctx, 'storyResearch');
  const brief = await getLlm(ctx, 'storyBrief');
  // 第二步要的钱先确认够不够：免得搜索的钱花了，整理这一步才发现预算不够
  await brief.assertAffordable(STORY.notesMaxChars + 4_000);
  const maxSearches = Math.min(10, Math.max(1, Math.round(settings.story.maxSearches)));
  const { system, user } = buildStoryResearchPrompt(page, localIso(ctx.now()), maxSearches);
  const { raw, usage } = await llm.research({ system, user, maxSearches, effort: 'medium' });
  const notes = assembleResearch(raw);
  const searches = usage.webSearches ?? 0;
  const done: PendingNotes = {
    key,
    at: ctx.now(),
    notes,
    usd: llmCostUsd(llm.model, usage.inputTokens, usage.outputTokens) + webSearchUsd(llm.provider, searches),
    searches,
    model: llm.model,
    provider: llm.provider,
    estimatedPrice: !llmPrice(llm.model).known,
  };
  if (!notes.notes.trim()) throw new AppError('llm', '调研没有写出任何内容', '再点一次"调研"；反复这样时，在设置页把"故事调研"换成主模型');
  return done;
}

/**
 * 调研这个页面。同一个页面 cacheHours 小时内调研过、又没要求重来：直接给上次的结果，不花钱。
 * 整理这一步失败时，调研笔记在内存里留 30 分钟：再点一次只重做整理。
 */
export async function researchStory(ctx: AppContext, page: StoryPage, opts: StoryRunOptions = {}): Promise<StoryRunResult> {
  return ctx.locker.withLock('run:story', async () => {
    const settings = await stores.settings.read(ctx.kv);
    if (!settings.story.enabled) throw new AppError('input', '故事已在设置中关闭', '在设置页"20. 故事"打开');
    const key = storyKey(page);
    if (!opts.force) {
      const hit = cachedStory(await stores.stories.read(ctx.kv), key, ctx.now(), settings.story.cacheHours);
      if (hit) return { record: hit, cached: true, reusedNotes: false };
    }
    const reuse = !opts.force && pending?.key === key && ctx.now() - pending.at < NOTES_KEEP_MS ? pending : undefined;
    let notes: PendingNotes;
    if (reuse) notes = reuse;
    else {
      opts.onStage?.('search');
      notes = await research(ctx, page, key, settings);
      pending = notes;
    }
    opts.onStage?.('brief');
    const llm = await getLlm(ctx, 'storyBrief');
    const { system, user } = buildStoryBriefPrompt(page, notes.notes.notes, notes.notes.sources);
    const { value, usage } = await llm.generateJsonWithUsage({ system, user, schema: STORY_BRIEF_SCHEMA, schemaName: 'story_brief', effort: 'low' });
    const briefUsd = llmCostUsd(llm.model, usage.inputTokens, usage.outputTokens);
    // 整理这一步花的钱记在笔记上：再失败、再重做时累计
    notes = { ...notes, usd: notes.usd + briefUsd, estimatedPrice: notes.estimatedPrice || !llmPrice(llm.model).known };
    if (pending?.key === key) pending = notes;
    const brief = parseStoryBrief(value, notes.notes.sources.map((s) => s.id));
    if (!brief) throw new AppError('llm', '大模型整理出的结果不可用', '再点一次"调研"：调研笔记还在，只重做整理这一步，不再搜索');
    const record: StoryRecord = {
      id: newId('st'),
      key,
      page,
      brief,
      sources: notes.notes.sources,
      queries: notes.notes.queries,
      searchErrors: notes.notes.errors,
      searches: notes.searches,
      usd: Math.round(notes.usd * 1e6) / 1e6,
      estimatedPrice: notes.estimatedPrice,
      provider: notes.provider,
      model: notes.model === llm.model ? notes.model : `${notes.model} + ${llm.model}`,
      at: ctx.now(),
    };
    await stores.stories.update(ctx.kv, ctx.locker, (s) => rememberStory(s, record));
    pending = undefined;
    return { record, cached: false, reusedNotes: !!reuse };
  });
}

/** 这个页面最近调研过的结果（不论多久以前；界面上标明是什么时候的） */
export async function lastStoryFor(ctx: AppContext, page: StoryPage): Promise<StoryRecord | undefined> {
  const key = storyKey(page);
  return (await stores.stories.read(ctx.kv)).items.find((i) => i.key === key);
}

export async function deleteStory(ctx: AppContext, id: string): Promise<void> {
  await stores.stories.update(ctx.kv, ctx.locker, (s) => forgetStory(s, id));
}
