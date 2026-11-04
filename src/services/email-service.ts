// eMails：给文章评分（按文章缓存，同一篇隔天再出现时不再花钱）、收藏与标签（所有写入都经这里，加锁读改写）。
// 评分只在你点"评估"时运行，在侧边栏里直接调大模型；发送的内容见 core/prompts.ts 的 buildEmailScorePrompt。

import { EMAIL } from '../config/defaults';
import { applyEmailOp, parseScores, pruneScores, type EmailArticle, type EmailOp } from '../core/email';
import { EMAIL_SCORE_SCHEMA, buildEmailScorePrompt } from '../core/prompts';
import { llmPrice, translationCostUsd } from '../core/subtitles';
import type { AppContext } from './context';
import { AppError } from './errors';
import { getLlm } from './llm-factory';
import { stores } from './repo';

export interface EmailScoreResult {
  /** 这次发给大模型的篇数 */
  asked: number;
  scored: number;
  /** 大模型没给出可用分数的篇数（不补分，界面说明，可以再点一次） */
  missing: number;
  /** 已有评分、没有再花钱的篇数 */
  cached: number;
  /** 按服务方报告的用量估算的花费（美元） */
  usd: number;
  /** 模型不在价格表里：按最贵一档估算 */
  estimatedPrice: boolean;
  model: string;
}

export interface EmailScoreOptions {
  /** 忽略已有评分，全部重评（"重新评估"） */
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
}

/** 评估一批文章。分批发送，每批的结果立刻存下：中途失败时已经评好的不丢，再点一次只评剩下的 */
export async function scoreArticles(ctx: AppContext, articles: readonly EmailArticle[], opts: EmailScoreOptions = {}): Promise<EmailScoreResult> {
  return ctx.locker.withLock('run:email', async () => {
    const settings = await stores.settings.read(ctx.kv);
    if (!settings.email.enabled) throw new AppError('input', 'eMails 已在设置中关闭', '在设置页"16. eMails"打开');
    const existing = await stores.emailScores.read(ctx.kv);
    const todo = opts.force ? [...articles] : articles.filter((a) => !existing[a.id]);
    const result: EmailScoreResult = { asked: todo.length, scored: 0, missing: 0, cached: articles.length - todo.length, usd: 0, estimatedPrice: false, model: '' };
    if (!todo.length) return result;
    const llm = await getLlm(ctx);
    result.model = llm.model;
    result.estimatedPrice = !llmPrice(llm.model).known;
    for (let i = 0; i < todo.length; i += EMAIL.batchSize) {
      const batch = todo.slice(i, i + EMAIL.batchSize);
      const { system, user, refs } = buildEmailScorePrompt(batch);
      const { value, usage } = await llm.generateJsonWithUsage({ system, user, schema: EMAIL_SCORE_SCHEMA, schemaName: 'email_scores', effort: 'low' });
      const got = parseScores(value, refs);
      const at = ctx.now();
      await stores.emailScores.update(ctx.kv, ctx.locker, (s) => {
        const next = { ...s };
        for (const [id, r] of got) next[id] = { ...r, at, model: llm.model };
        return pruneScores(next);
      });
      result.scored += got.size;
      result.missing += batch.length - got.size;
      result.usd += translationCostUsd(llm.model, usage.inputTokens, usage.outputTokens);
      opts.onProgress?.(Math.min(i + batch.length, todo.length), todo.length);
    }
    return result;
  });
}

/** 执行一条收藏操作；不成功时返回人话原因 */
export async function applyEmail(ctx: AppContext, op: EmailOp): Promise<string | undefined> {
  let error: string | undefined;
  await stores.emailSaved.update(ctx.kv, ctx.locker, (state) => {
    const r = applyEmailOp(state, op, ctx.now());
    error = r.error;
    return r.state;
  });
  return error;
}
