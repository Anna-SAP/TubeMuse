// 导师提醒：评估 → （触发时）找一个具体的小台阶 → 侧边栏顶部横幅。

import { DAY_MS } from '../core/time';
import { disableReminder, dismissReminder, enableReminder, evaluateReminder, muteReminder, triggerReminder } from '../core/reminder';
import { OperationBudget } from '../core/quota';
import type { ReminderState, ReminderStep } from '../core/types';
import type { AppContext } from './context';
import { makeCharger, makeExhaustedMarker } from './quota-service';
import { newId, stores } from './repo';
import { currentWindowStats } from './watch-service';
import { createYouTube } from './youtube';

/** 台阶：优先"学习"兴趣簇里权重最高的订阅频道的最新上传（channels.list + playlistItems.list，约 2 units）；
 *  拿不到时退一步给一句找片口令（不耗配额）。 */
export async function findReminderStep(ctx: AppContext): Promise<ReminderStep | undefined> {
  const [clusterState, profile, rules, log, settings] = await Promise.all([
    stores.clusters.read(ctx.kv),
    stores.profile.read(ctx.kv),
    stores.natureRules.read(ctx.kv),
    stores.watchLog.read(ctx.kv),
    stores.settings.read(ctx.kv),
  ]);
  const learningClusters = clusterState.clusters.filter((c) => c.nature === 'learning').sort((a, b) => b.weight - a.weight);
  const subs = new Map(profile.subscriptions.map((s) => [s.id, s.title]));
  const userLearning = Object.entries(rules.channels).filter(([, r]) => r.nature === 'learning');
  const candidates: { channelId: string; title: string; why: string }[] = [
    ...userLearning.map(([id, r]) => ({ channelId: id, title: r.title, why: `你标记为"学习"的频道「${r.title}」` })),
    ...learningClusters.flatMap((c) =>
      c.channelIds.filter((id) => subs.has(id)).map((id) => ({ channelId: id, title: subs.get(id)!, why: `你的"学习"兴趣簇「${c.name}」里的频道「${subs.get(id)}」` })),
    ),
  ];
  const watched = new Set(Object.values(log).flatMap((d) => Object.keys(d)));
  if (candidates.length && (await ctx.auth.status()) === 'connected') {
    try {
      const budget = new OperationBudget({ searchCalls: 0, generalUnits: 4 }, '寻找提醒里的推荐视频');
      const yt = createYouTube({
        http: ctx.http,
        auth: ctx.auth,
        baseUrl: ctx.endpoints.youtubeApi,
        charge: makeCharger(ctx, budget, settings.quota),
        onQuotaExhausted: makeExhaustedMarker(ctx),
      });
      const top = candidates[0]!;
      const [pl] = await yt.uploadsPlaylists([top.channelId]);
      if (pl) {
        const items = await yt.playlistItems(pl.uploads, 10);
        const pick = items.find((i) => !watched.has(i.videoId) && !/#shorts/i.test(i.title));
        if (pick) return { kind: 'video', title: pick.title, videoId: pick.videoId, channelTitle: pick.channelTitle || top.title, why: `${top.why}最近的更新` };
      }
    } catch {
      // 取不到就退回到找片口令
    }
  }
  const c = learningClusters[0];
  if (c) return { kind: 'search', title: `找一个 20 分钟以内的${c.name}讲解`, utterance: `找一个 20 分钟以内的${c.name}入门讲解`, why: `来自你的"学习"兴趣簇「${c.name}」` };
  return undefined;
}

/** 评估是否该提醒；触发时记录并生成横幅。返回最新状态。 */
export async function checkReminder(ctx: AppContext): Promise<ReminderState> {
  const settings = await stores.settings.read(ctx.kv);
  const state = await stores.reminderState.read(ctx.kv);
  const stats = await currentWindowStats(ctx, settings.reminder.windowDays);
  const decision = evaluateReminder(state, stats, settings.reminder, ctx.now());
  if (!decision.trigger) return state;
  const step = await findReminderStep(ctx);
  return stores.reminderState.update(ctx.kv, ctx.locker, (cur) => {
    // 并发保护：锁内再确认一次（防止两个上下文同时触发两次）
    if (!evaluateReminder(cur, stats, settings.reminder, ctx.now()).trigger) return cur;
    return triggerReminder(cur, stats, settings.reminder.windowDays, step, ctx.now(), newId('m'));
  });
}

export const reminderActions = {
  dismiss: (ctx: AppContext) => stores.reminderState.update(ctx.kv, ctx.locker, dismissReminder),
  mute7: (ctx: AppContext) => stores.reminderState.update(ctx.kv, ctx.locker, (s) => muteReminder(s, 7, ctx.now())),
  disable: (ctx: AppContext) => stores.reminderState.update(ctx.kv, ctx.locker, disableReminder),
  enable: (ctx: AppContext) => stores.reminderState.update(ctx.kv, ctx.locker, enableReminder),
};

export function mutedDaysLeft(state: ReminderState, now: number): number {
  return state.mutedUntil && state.mutedUntil > now ? Math.ceil((state.mutedUntil - now) / DAY_MS) : 0;
}
