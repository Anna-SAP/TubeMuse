// 定时任务的时间计算（纯函数）：下一次触发时间、错过的总结/周报需要补算哪些。
// MV3 的 service worker 会休眠、浏览器可能在到点时没开——所以每次醒来都按"应该已经生成但还没有"来补算。

import { dayKey, DAY_MS } from './time';

/** 解析 "HH:MM"，无效时返回 23:00 */
export function parseHHMM(s: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  const h = m ? Number(m[1]) : 23;
  const min = m ? Number(m[2]) : 0;
  return h >= 0 && h < 24 && min >= 0 && min < 60 ? { h, m: min } : { h: 23, m: 0 };
}

function partsIn(timeZone: string, at: number) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(at))) p[part.type] = part.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute) };
}

/** 某时刻在该时区相对 UTC 的偏移（毫秒） */
function offsetAt(t: number, timeZone: string): number {
  const p = partsIn(timeZone, t);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(t / 60_000) * 60_000;
}

/** 指定时区里某一天 HH:MM 对应的 UTC 毫秒（自动处理夏令时；被夏令时跳过的时刻取其后的时刻） */
export function zonedTime(day: string, hhmm: string, timeZone: string): number {
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  const { h, m } = parseHHMM(hhmm);
  const asUtc = Date.UTC(y, mo - 1, d, h, m);
  const t1 = asUtc - offsetAt(asUtc, timeZone);
  const t2 = asUtc - offsetAt(t1, timeZone);
  return Math.max(t1, t2);
}

/** 下一次每日总结的触发时刻 */
export function nextDailyRun(now: number, hhmm: string, timeZone: string): number {
  const today = dayKey(now, timeZone);
  const t = zonedTime(today, hhmm, timeZone);
  if (t > now) return t;
  return zonedTime(dayKey(now + DAY_MS, timeZone), hhmm, timeZone);
}

/** 本地日期加减天数 */
export function addDays(day: string, n: number): string {
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, mo - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export interface SummaryJob {
  day: string;
  /** 已有手动生成的版本，需要按完整的一天重新生成 */
  regenerate: boolean;
}

/**
 * 哪些天的每日总结"应该已经生成但还没有"：
 *  - 该天的总结时刻已过；
 *  - 没有总结，或只有在总结时刻之前手动生成的版本；
 *  - 最多回看 maxDays 天；没有任何观看记录的日子也会生成一份"今天没有观看"的总结（不调用 LLM）。
 */
export function dueSummaryDays(
  now: number,
  hhmm: string,
  timeZone: string,
  existing: Record<string, { generatedAt: number; manual: boolean }>,
  maxDays: number,
  earliestDay: string | undefined,
): SummaryJob[] {
  const jobs: SummaryJob[] = [];
  const today = dayKey(now, timeZone);
  for (let i = maxDays - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    if (earliestDay && day < earliestDay) continue;
    const due = zonedTime(day, hhmm, timeZone);
    if (due > now) continue;
    const s = existing[day];
    if (!s) jobs.push({ day, regenerate: false });
    else if (s.manual && s.generatedAt < due) jobs.push({ day, regenerate: true });
  }
  return jobs;
}

/** 周报的周键：该周结束日（weekday 那天）的日期 */
export function weekEndingOn(day: string, weekday: number): string {
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return addDays(day, (weekday - wd + 7) % 7);
}

/** 应该已经生成的最近一份周报（若到点了） */
export function dueWeeklyReport(now: number, hhmm: string, weekday: number, timeZone: string, existing: Set<string>): string | undefined {
  const today = dayKey(now, timeZone);
  // 最近一个已经过去或就是今天的 weekday
  let end = weekEndingOn(today, weekday);
  if (end > today) end = addDays(end, -7);
  const due = zonedTime(end, hhmm, timeZone);
  if (due > now) end = addDays(end, -7);
  return existing.has(end) ? undefined : end;
}
