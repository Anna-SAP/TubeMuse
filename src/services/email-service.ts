// eMails：给文章评分（按文章缓存，同一篇隔天再出现时不再花钱）、写总体结论、收藏与标签（所有写入都经这里，加锁读改写）。
// 评分和总体结论只在你点按钮时运行，在侧边栏里直接调大模型；发送的内容见 core/prompts.ts 的 buildEmailScorePrompt、buildEmailVerdictPrompt。

import { EMAIL } from '../config/defaults';
import { applyEmailOp, digestStats, keepLatest, parseScores, parseVerdict, rankArticles, verdictKey, type EmailArticle, type EmailOp } from '../core/email';
import { EMAIL_SCORE_SCHEMA, EMAIL_VERDICT_SCHEMA, buildEmailScorePrompt, buildEmailVerdictPrompt } from '../core/prompts';
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
  /** 总体结论：这次没写（一篇都没评到）/ 写好了 / 没写成（分数已经存好，可以单独再写一次） */
  verdict: 'skipped' | 'written' | 'failed';
  /** 没写成的原因，由界面转成人话 */
  verdictError?: unknown;
}

export interface EmailScoreOptions {
  /** 忽略已有评分，全部重评（"重新评估"） */
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
}

/** 按这封邮件现在的分数写总体结论（调用方持有 run:email）。花费记进 result，大模型的回答可用才存 */
async function writeVerdict(ctx: AppContext, llm: Awaited<ReturnType<typeof getLlm>>, articles: readonly EmailArticle[], result: EmailScoreResult): Promise<void> {
  const rows = rankArticles(articles, await stores.emailScores.read(ctx.kv));
  const stats = digestStats(rows);
  const { system, user } = buildEmailVerdictPrompt(rows, stats);
  const { value, usage } = await llm.generateJsonWithUsage({ system, user, schema: EMAIL_VERDICT_SCHEMA, schemaName: 'email_verdict', effort: 'low' });
  result.usd += translationCostUsd(llm.model, usage.inputTokens, usage.outputTokens);
  const verdict = parseVerdict(value, stats.counts.read === 0);
  if (!verdict) throw new AppError('llm', '大模型没有写出可用的总体结论', '再点一次"生成总体结论"；分数已经存好，不用重评');
  const at = ctx.now();
  await stores.emailVerdicts.update(ctx.kv, ctx.locker, (v) => keepLatest({ ...v, [verdictKey(rows)]: { ...verdict, at, model: llm.model } }, EMAIL.maxVerdicts));
  result.verdict = 'written';
}

/**
 * 评估一批文章。分批发送，每批的结果立刻存下：中途失败时已经评好的不丢，再点一次只评剩下的。
 * 全部评完后写这封邮件的总体结论（覆盖这封里所有评过的文章，包括之前评过的）；结论没写成不影响分数，原因放在 verdictError。
 */
export async function scoreArticles(ctx: AppContext, articles: readonly EmailArticle[], opts: EmailScoreOptions = {}): Promise<EmailScoreResult> {
  return ctx.locker.withLock('run:email', async () => {
    const settings = await stores.settings.read(ctx.kv);
    if (!settings.email.enabled) throw new AppError('input', 'eMails 已在设置中关闭', '在设置页"16. eMails"打开');
    const existing = await stores.emailScores.read(ctx.kv);
    const todo = opts.force ? [...articles] : articles.filter((a) => !existing[a.id]);
    const result: EmailScoreResult = { asked: todo.length, scored: 0, missing: 0, cached: articles.length - todo.length, usd: 0, estimatedPrice: false, model: '', verdict: 'skipped' };
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
        return keepLatest(next, EMAIL.maxScores);
      });
      result.scored += got.size;
      result.missing += batch.length - got.size;
      result.usd += translationCostUsd(llm.model, usage.inputTokens, usage.outputTokens);
      opts.onProgress?.(Math.min(i + batch.length, todo.length), todo.length);
    }
    if (result.scored + result.cached > 0) {
      try {
        await writeVerdict(ctx, llm, articles, result);
      } catch (e) {
        result.verdict = 'failed';
        result.verdictError = e;
      }
    }
    return result;
  });
}

/** 只写总体结论，不动分数：这封邮件都评过了、还没有结论时用（比如文章是之前评的），比重新评估便宜得多 */
export async function concludeArticles(ctx: AppContext, articles: readonly EmailArticle[]): Promise<EmailScoreResult> {
  return ctx.locker.withLock('run:email', async () => {
    const settings = await stores.settings.read(ctx.kv);
    if (!settings.email.enabled) throw new AppError('input', 'eMails 已在设置中关闭', '在设置页"16. eMails"打开');
    const scores = await stores.emailScores.read(ctx.kv);
    const cached = articles.filter((a) => scores[a.id]).length;
    if (!cached) throw new AppError('input', '这封邮件还没有评过分', '先点"评估"');
    const llm = await getLlm(ctx);
    const result: EmailScoreResult = { asked: 0, scored: 0, missing: 0, cached, usd: 0, estimatedPrice: !llmPrice(llm.model).known, model: llm.model, verdict: 'skipped' };
    await writeVerdict(ctx, llm, articles, result);
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
