// 导师提醒的触发规则（纯函数）：滚动窗口内娱乐占比 > 阈值 且 学习占比 < 阈值；
// 两次至少间隔 minGapDays 天；可静音 7 天或永久关闭；触发后只在侧边栏顶部显示一条可关闭横幅。

import { DAY_MS } from './time';
import { formatSpan } from './format';
import type { ReminderState, ReminderStep, WindowStats } from './types';

export interface ReminderSettings {
  enabled: boolean;
  entertainmentRatio: number;
  learningRatio: number;
  windowDays: number;
  minGapDays: number;
  minTotalMinutes: number;
}

export type ReminderDecision = { trigger: true } | { trigger: false; reason: string };

export function evaluateReminder(state: ReminderState, stats: WindowStats, s: ReminderSettings, now: number): ReminderDecision {
  if (!s.enabled) return { trigger: false, reason: '设置中已关闭导师提醒' };
  if (state.disabled) return { trigger: false, reason: '你选择了"不再提醒"' };
  if (state.mutedUntil && now < state.mutedUntil) return { trigger: false, reason: '静音中' };
  if (state.lastTriggeredAt && now - state.lastTriggeredAt < s.minGapDays * DAY_MS) {
    return { trigger: false, reason: `距上次提醒不足 ${s.minGapDays} 天` };
  }
  if (stats.totalSec < s.minTotalMinutes * 60) return { trigger: false, reason: `最近 ${s.windowDays} 天有效观看不足 ${s.minTotalMinutes} 分钟` };
  if (stats.entertainmentRatio <= s.entertainmentRatio) return { trigger: false, reason: '娱乐占比未超过阈值' };
  if (stats.learningRatio >= s.learningRatio) return { trigger: false, reason: '学习占比不低于阈值' };
  return { trigger: true };
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

/** 语气轻：陈述事实 + 一个具体的小台阶，不说教。 */
export function reminderMessage(stats: WindowStats, windowDays: number, step?: ReminderStep): string {
  const base = `最近 ${windowDays} 天你在 YouTube 上看了约 ${formatSpan(stats.totalSec)}，其中娱乐约 ${pct(stats.entertainmentRatio)}，学习约 ${pct(stats.learningRatio)}。放松挺好的——如果想换换口味，`;
  if (step?.kind === 'video') return `${base}这里有一个可能合你胃口的：`;
  if (step?.kind === 'search') return `${base}可以试试这句找片口令：`;
  return `${base}可以在"找片"里说一句想学点什么。`;
}

export function triggerReminder(state: ReminderState, stats: WindowStats, windowDays: number, step: ReminderStep | undefined, now: number, id: string): ReminderState {
  return {
    ...state,
    lastTriggeredAt: now,
    active: { id, createdAt: now, stats, message: reminderMessage(stats, windowDays, step), dismissed: false, ...(step ? { step } : {}) },
  };
}

export function dismissReminder(state: ReminderState): ReminderState {
  return state.active ? { ...state, active: { ...state.active, dismissed: true } } : state;
}

export function muteReminder(state: ReminderState, days: number, now: number): ReminderState {
  return { ...dismissReminder(state), mutedUntil: now + days * DAY_MS };
}

export function disableReminder(state: ReminderState): ReminderState {
  return { ...dismissReminder(state), disabled: true };
}

export function enableReminder(state: ReminderState): ReminderState {
  const next = { ...state };
  delete next.disabled;
  delete next.mutedUntil;
  return next;
}
