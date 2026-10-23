// 配额记账服务：把纯函数账本接到存储上，并提供给 YouTube 客户端的 charge 回调。

import { YOUTUBE_METHOD_COSTS, type QuotaBucket, type YtMethod } from '../config/defaults';
import { markExhausted, recordCall, snapshot, type OperationBudget, type QuotaLimits, type QuotaSnapshot } from '../core/quota';
import { formatClock } from '../core/time';
import type { AppContext } from './context';
import { AppError } from './errors';
import { stores, type Settings } from './repo';

export function limitsOf(settings: Settings): QuotaLimits {
  return settings.quota;
}

export async function quotaSnapshot(ctx: AppContext): Promise<QuotaSnapshot> {
  const [ledger, settings] = await Promise.all([stores.quotaLedger.read(ctx.kv), stores.settings.read(ctx.kv)]);
  return snapshot(ledger, limitsOf(settings), ctx.now());
}

/** 生成 charge 回调：先过单次预算，再过今日剩余，最后记账（同一把锁内完成）。 */
export function makeCharger(ctx: AppContext, budget: OperationBudget, limits: QuotaLimits) {
  return async (method: YtMethod) => {
    budget.spend(method);
    await stores.quotaLedger.update(ctx.kv, ctx.locker, (ledger) => {
      const now = ctx.now();
      const snap = snapshot(ledger, limits, now);
      const { bucket, cost } = YOUTUBE_METHOD_COSTS[method];
      const b = bucket === 'search' ? snap.search : snap.general;
      if (b.remaining < cost) {
        throw new AppError(
          'quota',
          bucket === 'search' ? `今天的 search 次数已用完（${b.used}/${b.limit}）` : `今天的接口配额已用完（${b.used}/${b.limit} units）`,
          `配额在太平洋时间零点重置，也就是你本地时间 ${formatClock(snap.resetAt)}`,
        );
      }
      return recordCall(ledger, method, now);
    });
  };
}

export function makeExhaustedMarker(ctx: AppContext) {
  return async (bucket: QuotaBucket) => {
    await stores.quotaLedger.update(ctx.kv, ctx.locker, (l) => markExhausted(l, bucket, ctx.now()));
  };
}
