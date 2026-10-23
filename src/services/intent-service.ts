// 口令 → Intent：LLM 结构化解析 + 本地覆盖守卫。

import { LEARNING, LLM_LIMITS } from '../config/defaults';
import { assembleIntent } from '../core/intent';
import { buildIntentPrompt, INTENT_SCHEMA } from '../core/prompts';
import type { Intent } from '../core/types';
import { localIso, type AppContext } from './context';
import { AppError } from './errors';
import { getLlm } from './llm-factory';
import { stores } from './repo';

export async function parseUtterance(ctx: AppContext, utterance: string): Promise<Intent> {
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
  const llm = await getLlm(ctx);
  const now = ctx.now();
  const prompt = buildIntentPrompt({
    utterance: text,
    nowIso: localIso(now),
    timeZone: ctx.timeZone,
    clusters: clusterState.clusters.map((c) => ({ name: c.name, keywords: c.keywords })),
    corrections,
  });
  const raw = await llm.generateJson({ ...prompt, schema: INTENT_SCHEMA, schemaName: 'tubemuse_intent', effort: 'low' });
  return assembleIntent(text, raw, now, corrections.length);
}
