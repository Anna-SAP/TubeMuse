// 每日总结与每周自省报告的确定性部分：统计、校验 LLM 引用、渲染 Markdown、拼记忆库。
// LLM 只负责"今日学了什么 / 值得回看 / 与目标的关联 / 低分共性"的文字；"只是路过"与所有数字都由代码给出。

import { YOUTUBE_CATEGORIES } from '../config/defaults';
import { formatSigned } from './format';
import type { DailyPromptItem, WeeklyPromptCase } from './prompts';
import {
  FACTOR_LABELS,
  NATURE_LABELS,
  WATCH_STATUS_LABELS,
  type Adjustment,
  type DailySummary,
  type FactorKey,
  type Nature,
  type RatingRecord,
  type SummaryItem,
  type VideoMeta,
  type WatchRecord,
  type WeeklyReport,
  type WindowStats,
} from './types';

export interface DayEntry {
  record: WatchRecord;
  meta?: VideoMeta;
  nature: Nature;
}

const minutes = (sec: number) => Math.round(sec / 60);

export function dayStats(entries: DayEntry[]): DailySummary['stats'] {
  const sum = (f: (e: DayEntry) => boolean) => entries.filter(f).reduce((s, e) => s + e.record.playSec, 0);
  return {
    videos: entries.length,
    completed: entries.filter((e) => e.record.status === 'completed').length,
    partial: entries.filter((e) => e.record.status === 'partial').length,
    glance: entries.filter((e) => e.record.status === 'glance').length,
    background: entries.filter((e) => e.record.background).length,
    playMinutes: minutes(entries.reduce((s, e) => s + e.record.playSec, 0)),
    learningMinutes: minutes(sum((e) => e.nature === 'learning')),
    entertainmentMinutes: minutes(sum((e) => e.nature === 'entertainment')),
  };
}

function titleOf(e: DayEntry): string {
  return e.meta && !e.meta.missing ? e.meta.title : `（未取到标题：${e.record.videoId}）`;
}

/** 发给 LLM 的条目：瞥一眼的不发（它们直接进"只是路过"），用本地编号引用 */
export function promptItems(entries: DayEntry[]): { items: DailyPromptItem[]; refs: Map<string, DayEntry> } {
  const refs = new Map<string, DayEntry>();
  const items: DailyPromptItem[] = [];
  entries
    .filter((e) => e.record.status !== 'glance')
    .sort((a, b) => b.record.playSec - a.record.playSec)
    .forEach((e, i) => {
      const ref = `v${i + 1}`;
      refs.set(ref, e);
      items.push({
        ref,
        title: titleOf(e),
        channelTitle: e.meta?.channelTitle ?? '',
        category: e.meta?.categoryId ? (YOUTUBE_CATEGORIES[e.meta.categoryId]?.name ?? '') : '',
        nature: NATURE_LABELS[e.nature],
        status: WATCH_STATUS_LABELS[e.record.status],
        completionPct: Math.round(e.record.completion * 100),
        minutes: Math.max(1, minutes(e.record.playSec)),
        background: e.record.background,
      });
    });
  return { items, refs };
}

export interface DailyLlmOutput {
  headline: string;
  learned: { ref: string; takeaway: string }[];
  revisit: { ref: string; reason: string }[];
  goalLink: string;
}

function asItem(e: DayEntry, text: string): SummaryItem {
  return { videoId: e.record.videoId, title: titleOf(e), channelTitle: e.meta?.channelTitle ?? '', text: text.trim().slice(0, 300) };
}

const isStr = (x: unknown): x is string => typeof x === 'string';

export function isDailyLlmOutput(v: unknown): v is DailyLlmOutput {
  const o = v as DailyLlmOutput;
  return (
    !!o &&
    isStr(o.headline) &&
    isStr(o.goalLink) &&
    Array.isArray(o.learned) &&
    Array.isArray(o.revisit) &&
    o.learned.every((i) => isStr(i?.ref) && isStr(i?.takeaway)) &&
    o.revisit.every((i) => isStr(i?.ref) && isStr(i?.reason))
  );
}

export function buildDailySummary(day: string, entries: DayEntry[], llm: DailyLlmOutput | undefined, refs: Map<string, DayEntry>, opts: { now: number; manual: boolean; goals: string }): DailySummary {
  const stats = dayStats(entries);
  const notes: string[] = [];
  const pick = (ref: string) => refs.get(ref.trim());
  const learned: SummaryItem[] = [];
  const revisit: SummaryItem[] = [];
  let dropped = 0;
  for (const l of llm?.learned ?? []) {
    const e = pick(l.ref);
    if (e) learned.push(asItem(e, l.takeaway));
    else dropped++;
  }
  for (const r of llm?.revisit ?? []) {
    const e = pick(r.ref);
    if (e) revisit.push(asItem(e, r.reason));
    else dropped++;
  }
  if (dropped) notes.push(`模型引用了 ${dropped} 个不存在的条目，已忽略`);
  const passingBy = entries
    .filter((e) => e.record.status === 'glance')
    .sort((a, b) => a.record.firstAt - b.record.firstAt)
    .map((e) => asItem(e, `瞥一眼（${Math.round(e.record.playSec)} 秒）`));
  const missingMeta = entries.filter((e) => !e.meta).length;
  if (missingMeta) notes.push(`${missingMeta} 条记录还没取到标题（需要连接 YouTube）`);

  let headline = llm?.headline.trim() ?? '';
  let goalLink = llm?.goalLink.trim() ?? '';
  if (!entries.length) headline = '今天没有观看记录。';
  else if (!llm) headline = headline || `今天只是随手看了 ${stats.glance} 个视频，没有完整观看的内容。`;
  if (!llm) goalLink = opts.goals.trim() ? '今天没有可以和目标关联的完整观看。' : '还没有设置近期目标（可以在设置页填写）。';

  const summary: DailySummary = {
    day,
    generatedAt: opts.now,
    manual: opts.manual,
    headline,
    learned,
    revisit,
    passingBy,
    goalLink,
    stats,
    notes,
    markdown: '',
  };
  summary.markdown = renderDailyMarkdown(summary);
  return summary;
}

function itemLine(i: SummaryItem): string {
  const link = /^（未取到标题/.test(i.title) ? i.title : `[${i.title.replace(/[[\]]/g, '')}](https://www.youtube.com/watch?v=${i.videoId})`;
  return `- ${link}${i.channelTitle ? `（${i.channelTitle}）` : ''}${i.text ? ` — ${i.text}` : ''}`;
}

export function renderDailyMarkdown(s: DailySummary): string {
  const st = s.stats;
  const section = (title: string, items: SummaryItem[], empty: string) => [`## ${title}`, ...(items.length ? items.map(itemLine) : [empty]), ''];
  return [
    `# ${s.day} 学习总结`,
    '',
    `> ${s.headline}`,
    '',
    `**概览**：看了 ${st.videos} 个视频（看完 ${st.completed} · 部分观看 ${st.partial} · 瞥一眼 ${st.glance}${st.background ? ` · 其中后台收听 ${st.background}` : ''}），有效观看 ${st.playMinutes} 分钟（学习 ${st.learningMinutes} · 娱乐 ${st.entertainmentMinutes}）。`,
    '',
    ...section('今日学了什么', s.learned, '（没有）'),
    ...section('值得回看', s.revisit, '（没有）'),
    ...section('只是路过', s.passingBy, '（没有）'),
    '## 与近期目标的关联',
    s.goalLink || '（没有）',
    '',
    ...(s.notes.length ? [`> 说明：${s.notes.join('；')}`, ''] : []),
    `<sub>TubeMuse 根据本机观看记录生成 · ${new Date(s.generatedAt).toLocaleString('zh-CN', { hour12: false })}${s.manual ? ' · 手动生成（到点后会按完整的一天重新生成）' : ''}</sub>`,
    '',
  ].join('\n');
}

// ───────────────────────── 每周自省 ─────────────────────────

const ATTR: Record<string, string> = { understanding: '理解错了', retrieval: '找错/排错', none: '未归因', pending: '待归因' };

export function weeklyCases(ratings: RatingRecord[], lowMax: number): { cases: WeeklyPromptCase[]; refs: Map<string, RatingRecord> } {
  const refs = new Map<string, RatingRecord>();
  const cases = ratings
    .filter((r) => r.rating <= lowMax)
    .sort((a, b) => a.at - b.at)
    .map((r, i) => {
      const ref = `r${i + 1}`;
      refs.set(ref, r);
      return { ref, title: r.video.title, channelTitle: r.video.channelTitle, rating: r.rating, attribution: ATTR[r.attribution] ?? r.attribution, utterance: r.utterance, note: r.note ?? '' };
    });
  return { cases, refs };
}

/** "本周已自动调整了什么"：按净变化汇总未撤销的调整（确定性，不经 LLM） */
export function summarizeAdjustments(adjs: Adjustment[]): string[] {
  const live = adjs.filter((a) => !a.reverted);
  const channel = new Map<string, { title: string; delta: number }>();
  const factor = new Map<FactorKey, { before: number; after: number }>();
  const cluster = new Map<string, { name: string; delta: number }>();
  const corrections: string[] = [];
  for (const a of [...live].sort((x, y) => x.at - y.at)) {
    for (const c of a.changes) {
      if (c.type === 'channelPref') {
        const cur = channel.get(c.channelId) ?? { title: c.channelTitle, delta: 0 };
        cur.delta += c.after - c.before;
        channel.set(c.channelId, cur);
      } else if (c.type === 'factorWeight') {
        const cur = factor.get(c.factor);
        factor.set(c.factor, { before: cur?.before ?? c.before, after: c.after });
      } else if (c.type === 'clusterWeight') {
        const cur = cluster.get(c.clusterId) ?? { name: c.clusterName, delta: 0 };
        cur.delta += c.after - c.before;
        cluster.set(c.clusterId, cur);
      } else if (c.type === 'correction') {
        corrections.push(`《${a.trigger.title}》`);
      }
    }
  }
  const lines: string[] = [];
  const ch = [...channel.values()].filter((c) => Math.abs(c.delta) >= 0.005);
  if (ch.length) lines.push(`频道偏好：${ch.map((c) => `「${c.title}」${formatSigned(c.delta)}`).join('，')}`);
  const fw = [...factor.entries()].filter(([, v]) => Math.abs(v.after - v.before) >= 0.003);
  if (fw.length) lines.push(`排序因子权重：${fw.map(([f, v]) => `${FACTOR_LABELS[f]} ${v.before.toFixed(3)}→${v.after.toFixed(3)}`).join('，')}`);
  const cw = [...cluster.values()].filter((c) => Math.abs(c.delta) >= 0.005);
  if (cw.length) lines.push(`兴趣簇权重：${cw.map((c) => `「${c.name}」${formatSigned(c.delta)}`).join('，')}`);
  if (corrections.length) lines.push(`新增理解纠正 ${corrections.length} 条（来自 ${corrections.slice(0, 3).join('、')}${corrections.length > 3 ? ' 等' : ''}的低分）`);
  const reverted = adjs.length - live.length;
  if (reverted) lines.push(`你撤销了 ${reverted} 次调整`);
  return lines;
}

export interface WeeklyLlmOutput {
  overview: string;
  patterns: { pattern: string; suggestion: string; refs: string[] }[];
}

export function isWeeklyLlmOutput(v: unknown): v is WeeklyLlmOutput {
  const o = v as WeeklyLlmOutput;
  return (
    !!o &&
    isStr(o.overview) &&
    Array.isArray(o.patterns) &&
    o.patterns.every((p) => isStr(p?.pattern) && isStr(p?.suggestion) && Array.isArray(p?.refs) && p.refs.every(isStr))
  );
}

export function buildWeeklyReport(
  weekKey: string,
  fromDay: string,
  stats: WindowStats,
  ratingCount: number,
  refs: Map<string, RatingRecord>,
  adjustmentLines: string[],
  llm: WeeklyLlmOutput | undefined,
  now: number,
): WeeklyReport {
  const notes: string[] = [];
  let dropped = 0;
  const patterns = (llm?.patterns ?? []).map((p) => {
    const examples = p.refs
      .map((r) => refs.get(r.trim()))
      .filter((r): r is RatingRecord => {
        if (!r) dropped++;
        return !!r;
      })
      .map((r) => `《${r.video.title}》${r.rating} 分`);
    return { pattern: p.pattern.trim(), suggestion: p.suggestion.trim(), examples };
  });
  if (dropped) notes.push(`模型引用了 ${dropped} 个不存在的案例，已忽略`);
  const overview = llm?.overview.trim() || (refs.size ? '' : '本周没有低分（≤5 分）的推荐。');
  const report: WeeklyReport = {
    weekKey,
    fromDay,
    toDay: weekKey,
    generatedAt: now,
    lowRatings: refs.size,
    patterns,
    overview,
    adjustments: adjustmentLines,
    stats,
    notes,
    markdown: '',
  };
  const pct = (r: number) => `${Math.round(r * 100)}%`;
  report.markdown = [
    `# ${fromDay} 至 ${weekKey} 每周自省`,
    '',
    '## 本周概览',
    `有效观看 ${(stats.totalSec / 3600).toFixed(1)} 小时（学习 ${pct(stats.learningRatio)} · 娱乐 ${pct(stats.entertainmentRatio)}）；打分 ${ratingCount} 次，其中低分 ${refs.size} 次。`,
    overview ? `\n${overview}` : '',
    '',
    '## 低分案例的共性',
    ...(patterns.length
      ? patterns.map((p) => `- **${p.pattern}**${p.examples.length ? `（例：${p.examples.join('、')}）` : ''}\n  - 建议：${p.suggestion}`)
      : [refs.size ? '（案例太少，看不出共性）' : '（没有低分）']),
    '',
    '## 本周已自动调整了什么',
    ...(adjustmentLines.length ? adjustmentLines.map((l) => `- ${l}`) : ['（没有调整）']),
    '',
    ...(notes.length ? [`> 说明：${notes.join('；')}`, ''] : []),
    `<sub>TubeMuse 生成 · ${new Date(now).toLocaleString('zh-CN', { hour12: false })}</sub>`,
    '',
  ].join('\n');
  return report;
}

/** 记忆库：全部每日总结与周报，按日期倒序拼成一个 Markdown 文件 */
export function renderMemoryLibrary(daily: DailySummary[], weekly: WeeklyReport[], now: number): string {
  const blocks = [
    ...daily.map((d) => ({ key: d.day, md: d.markdown })),
    ...weekly.map((w) => ({ key: `${w.weekKey}~`, md: w.markdown })),
  ].sort((a, b) => (a.key < b.key ? 1 : -1));
  return [`# TubeMuse 记忆库`, '', `导出于 ${new Date(now).toLocaleString('zh-CN', { hour12: false })}，共 ${daily.length} 篇每日总结、${weekly.length} 篇周报。`, '', ...blocks.map((b) => `${b.md}\n---\n`)].join('\n');
}
