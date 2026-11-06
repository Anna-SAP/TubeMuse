// 口令 → Intent：LLM 结构化解析 + 本地覆盖守卫。同一句话在缓存时间内再提交，直接用上次的理解，不再花钱。

import { LEARNING, LLM_LIMITS, STORAGE_LIMITS } from '../config/defaults';
import { assembleIntent } from '../core/intent';
import { buildIntentPrompt, INTENT_SCHEMA } from '../core/prompts';
import { canonicalJson, hashString } from '../core/text';
import type { Intent } from '../core/types';
import { localIso, type AppContext } from './context';
import { AppError } from './errors';
import { getLlm, taskModel } from './llm-factory';
import { stores } from './repo';

export interface ParseOptions {
  /** 你点了"重新理解"：不用缓存 */
  fresh?: boolean;
}

export async function parseUtterance(ctx: AppContext, utterance: string, opts: ParseOptions = {}): Promise<Intent> {
  const text = utterance.trim();
  if (!text) throw new AppError('input', '先说一句想看什么');
  if (text.length > LLM_LIMITS.utteranceMaxChars) throw new AppError('input', `口令太长了（上限 ${LLM_LIMITS.utteranceMaxChars} 字）`);
  const [settings, clusterState, allCorrections] = await Promise.all([
    stores.settings.read(ctx.kv),
    stores.clusters.read(ctx.kv),
    stores.corrections.read(ctx.kv),
  ]);
  const corrections = settings.learning.useUnderstandingCorrections
    ? allCorrections.filter((c) => c.active).slice(0, LEARNING.maxCorrectionsInPrompt)
    : [];
  const now = ctx.now();
  const clusters = clusterState.clusters.map((c) => ({ name: c.name, keywords: c.keywords }));
  // 影响理解结果的都进键：兴趣簇变了、多了一条纠正、换了模型，都重新理解
  const key = hashString(canonicalJson({ text, clusters, corrections: corrections.map((c) => c.id), model: taskModel(settings, 'intent').model }));
  const ttl = settings.search.cacheTtlMinutes * 60_000;
  if (!opts.fresh) {
    const hit = (await stores.intentCache.read(ctx.kv)).find((e) => e.key === key && now - e.at < ttl);
    if (hit) return { ...hit.intent, cachedAt: hit.at };
  }
  const llm = await getLlm(ctx, 'intent');
  const prompt = buildIntentPrompt({ utterance: text, nowIso: localIso(now), timeZone: ctx.timeZone, clusters, corrections });
  const raw = await llm.generateJson({ ...prompt, schema: INTENT_SCHEMA, schemaName: 'tubemuse_intent', effort: 'low' });
  const intent = assembleIntent(text, raw, now, corrections.length);
  await stores.intentCache.update(ctx.kv, ctx.locker, (list) => [{ key, at: now, intent }, ...list.filter((e) => e.key !== key && now - e.at < ttl)].slice(0, STORAGE_LIMITS.intentCacheKept));
  return intent;
}
