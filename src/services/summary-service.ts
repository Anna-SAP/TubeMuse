// 每日总结、每周自省、以及"到点没开浏览器"的补算。失败会记下来展示给用户，不静默。

import { LEARNING, SUMMARY } from '../config/defaults';
import { buildDailySummaryPrompt, buildWeeklyPrompt, DAILY_SUMMARY_SCHEMA, WEEKLY_SCHEMA } from '../core/prompts';
import { addDays, dueSummaryDays, dueWeeklyReport, zonedTime } from '../core/schedule';
import {
  buildDailySummary,
  buildWeeklyReport,
  isDailyLlmOutput,
  isWeeklyLlmOutput,
  promptItems,
  summarizeAdjustments,
  weeklyCases,
} from '../core/summary';
import { dayKey } from '../core/time';
import type { DailySummary, WeeklyReport } from '../core/types';
import type { AppContext } from './context';
import { AppError, toAppError } from './errors';
import { getLlm } from './llm-factory';
import { checkReminder } from './reminder-service';
import { isLinked } from './auth';
import { currentWeekKey, discoveryDue, runDiscovery } from './discovery-service';
import { stores } from './repo';
import { currentWindowStats, dayEntries, enrichMetadata } from './watch-service';

export async function generateDailySummary(ctx: AppContext, day: string, opts: { manual: boolean }): Promise<DailySummary> {
  // 先尽量补上元数据（没连接 YouTube 也继续，总结里会注明）
  await enrichMetadata(ctx).catch(() => undefined);
  const [settings, entries, summaries, sessions] = await Promise.all([
    stores.settings.read(ctx.kv),
    dayEntries(ctx, day),
    stores.summaries.read(ctx.kv),
    stores.searchSessions.read(ctx.kv),
  ]);
  const { items, refs } = promptItems(entries);
  let llmOut;
  if (items.length) {
    const previous = Array.from({ length: SUMMARY.contextDays }, (_, i) => summaries[addDays(day, -(i + 1))])
      .filter((s): s is DailySummary => !!s)
      .reverse()
      .map((s) => ({ day: s.day, headline: s.headline, learned: s.learned.map((l) => `${l.title}：${l.text}`) }));
    const utterances = sessions.filter((s) => dayKey(s.createdAt, ctx.timeZone) === day).map((s) => s.utterance).slice(0, 10);
    const llm = await getLlm(ctx);
    const prompt = buildDailySummaryPrompt({ day, goals: settings.summary.goals, items, previous, utterances });
    const raw = await llm.generateJson({ ...prompt, schema: DAILY_SUMMARY_SCHEMA, schemaName: 'tubemuse_daily_summary', effort: 'medium' });
    if (!isDailyLlmOutput(raw)) throw new AppError('llm', 'LLM 返回的总结格式不对', '请重试');
    llmOut = raw;
  }
  const summary = buildDailySummary(day, entries, llmOut, refs, { now: ctx.now(), manual: opts.manual, goals: settings.summary.goals });
  await stores.summaries.update(ctx.kv, ctx.locker, (all) => ({ ...all, [day]: summary }));
  await clearFailure(ctx, `daily:${day}`);
  return summary;
}

export async function generateWeeklyReport(ctx: AppContext, weekKey: string): Promise<WeeklyReport> {
  const fromDay = addDays(weekKey, -6);
  const inWeek = (t: number) => {
    const d = dayKey(t, ctx.timeZone);
    return d >= fromDay && d <= weekKey;
  };
  const [ratingsMap, adjustments] = await Promise.all([stores.ratings.read(ctx.kv), stores.adjustments.read(ctx.kv)]);
  const ratings = Object.values(ratingsMap).filter((r) => inWeek(r.at));
  const weekAdjs = adjustments.filter((a) => inWeek(a.at));
  const adjustmentLines = summarizeAdjustments(weekAdjs);
  const stats = await currentWindowStats(ctx, 7, zonedTime(weekKey, '12:00', ctx.timeZone));
  const { cases, refs } = weeklyCases(ratings, LEARNING.lowRatingMax);
  let llmOut;
  if (cases.length) {
    const llm = await getLlm(ctx);
    const prompt = buildWeeklyPrompt(cases, adjustmentLines);
    const raw = await llm.generateJson({ ...prompt, schema: WEEKLY_SCHEMA, schemaName: 'tubemuse_weekly', effort: 'medium' });
    if (!isWeeklyLlmOutput(raw)) throw new AppError('llm', 'LLM 返回的周报格式不对', '请重试');
    llmOut = raw;
  }
  const report = buildWeeklyReport(weekKey, fromDay, stats, ratings.length, refs, adjustmentLines, llmOut, ctx.now());
  await stores.weeklyReports.update(ctx.kv, ctx.locker, (all) => ({ ...all, [weekKey]: report }));
  await clearFailure(ctx, `weekly:${weekKey}`);
  return report;
}

async function recordFailure(ctx: AppContext, key: string, err: unknown): Promise<void> {
  const secrets = await stores.secrets.read(ctx.kv);
  const e = toAppError(err, [secrets.anthropicApiKey, secrets.openaiApiKey, secrets.xBearerToken]);
  await stores.jobState.update(ctx.kv, ctx.locker, (j) => ({
    ...j,
    failures: { ...j.failures, [key]: { at: ctx.now(), message: e.message, ...(e.hint ? { hint: e.hint } : {}) } },
  }));
}

async function clearFailure(ctx: AppContext, key: string): Promise<void> {
  await stores.jobState.update(ctx.kv, ctx.locker, (j) => {
    if (!j.failures[key]) return j;
    const failures = { ...j.failures };
    delete failures[key];
    return { ...j, failures };
  });
}

export interface JobsResult {
  daily: string[];
  weekly?: string;
  discovery?: boolean;
  failed: string[];
  metadata?: string;
}

/**
 * 例行任务（service worker 被闹钟唤醒、浏览器启动、侧边栏打开时都会调用）：
 * 补元数据 → 补算到点但还没有的每日总结（最多 7 天，没有观看的日子跳过）→ 周报 → 评估导师提醒。
 */
export async function runScheduledJobs(ctx: AppContext): Promise<JobsResult> {
  return ctx.locker.withLock('jobs', async () => {
    const result: JobsResult = { daily: [], failed: [] };
    const now = ctx.now();
    const meta = await enrichMetadata(ctx).catch((e) => ({ fetched: 0, skipped: toAppError(e).message }));
    if (meta.skipped) result.metadata = meta.skipped;
    const [settings, summaries, log, weeklies, job] = await Promise.all([
      stores.settings.read(ctx.kv),
      stores.summaries.read(ctx.kv),
      stores.watchLog.read(ctx.kv),
      stores.weeklyReports.read(ctx.kv),
      stores.jobState.read(ctx.kv),
    ]);
    const firstDay = job.firstDay ?? dayKey(now, ctx.timeZone);
    if (!job.firstDay) await stores.jobState.update(ctx.kv, ctx.locker, (j) => ({ ...j, firstDay }));

    let llmBroken = false;
    if (settings.summary.enabled) {
      const jobs = dueSummaryDays(now, settings.summary.time, ctx.timeZone, summaries, SUMMARY.catchUpMaxDays, firstDay);
      for (const j of jobs) {
        if (!Object.keys(log[j.day] ?? {}).length) continue; // 没有观看的日子不生成
        if (llmBroken) {
          result.failed.push(j.day);
          continue;
        }
        try {
          await generateDailySummary(ctx, j.day, { manual: false });
          result.daily.push(j.day);
        } catch (e) {
          await recordFailure(ctx, `daily:${j.day}`, e);
          result.failed.push(j.day);
          const kind = e instanceof AppError ? e.kind : '';
          if (kind === 'llm_key' || kind === 'network' || kind === 'llm') llmBroken = true;
        }
      }
    }
    if (settings.weekly.enabled && !llmBroken) {
      const key = dueWeeklyReport(now, settings.summary.time, settings.weekly.weekday, ctx.timeZone, new Set(Object.keys(weeklies)));
      if (key && key >= firstDay) {
        try {
          await generateWeeklyReport(ctx, key);
          result.weekly = key;
        } catch (e) {
          await recordFailure(ctx, `weekly:${key}`, e);
          result.failed.push(`weekly:${key}`);
        }
      }
    }
    // 新博主发现：每周一次（只花 YouTube 配额，不花钱）；没连接 YouTube 或没有兴趣簇时跳过
    if (settings.discovery.enabled) {
      const [disc, clusters] = await Promise.all([stores.discovery.read(ctx.kv), stores.clusters.read(ctx.kv)]);
      if (clusters.clusters.length && (await discoveryDue(ctx, disc, settings.weekly.weekday)) && isLinked(await ctx.auth.status())) {
        const key = `discovery:${currentWeekKey(ctx, settings.weekly.weekday)}`;
        try {
          await runDiscovery(ctx);
          result.discovery = true;
          await clearFailure(ctx, key);
        } catch (e) {
          await recordFailure(ctx, key, e);
          result.failed.push(key);
        }
      }
    }
    await checkReminder(ctx).catch(() => undefined);
    await stores.jobState.update(ctx.kv, ctx.locker, (j) => ({ ...j, lastRunAt: now }));
    return result;
  });
}
