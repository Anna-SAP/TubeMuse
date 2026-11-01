// 连接 / 重新授权 YouTube：由后台 service worker 打开 Google 授权窗口并保存令牌，设置页和侧边栏只发一条消息。
// 为什么不在发起的页面里做：授权窗口开着时，发起的侧边栏或设置页可能被关掉（或被浏览器收起），
// 那样 Google 回跳的令牌没有人接，被静默丢掉，横幅一直显示"已过期"。放在后台，结果总能存下。
// 每次尝试的开始、结束与失败原因记在本地（stores.authAttempt），界面重新打开后照样看得到。

import { GOOGLE_OAUTH } from '../config/defaults';
import type { AppContext } from './context';
import { AppError, toAppError, type ErrorKind } from './errors';
import { stores, type AuthAttempt } from './repo';

export const AUTH_CONNECT_MESSAGE = 'tubemuse:auth:connect';

/** 后台回给页面的结果（错误已转成人话、可序列化） */
export type AuthConnectReply = { ok: true } | { ok: false; error: { kind: ErrorKind; message: string; hint?: string } };

/** 在后台执行一次交互授权，并把结果记进 authAttempt */
export async function connectYouTube(ctx: AppContext): Promise<void> {
  const startedAt = ctx.now();
  await stores.authAttempt.write(ctx.kv, { startedAt });
  try {
    await ctx.auth.getToken(true);
    await stores.authAttempt.write(ctx.kv, { startedAt, finishedAt: ctx.now() });
  } catch (e) {
    const err = toAppError(e);
    await stores.authAttempt.write(ctx.kv, { startedAt, finishedAt: ctx.now(), error: { message: err.message, ...(err.hint ? { hint: err.hint } : {}) } });
    throw err;
  }
}

export function toAuthReply(e: unknown): AuthConnectReply {
  const err = toAppError(e);
  return { ok: false, error: { kind: err.kind, message: err.message, ...(err.hint ? { hint: err.hint } : {}) } };
}

export function fromAuthReply(reply: AuthConnectReply | undefined): void {
  if (reply?.ok) return;
  if (!reply) throw new AppError('internal', '后台没有响应授权请求', '在扩展管理页重新加载 TubeMuse 后再试');
  throw new AppError(reply.error.kind, reply.error.message, reply.error.hint);
}

export type AttemptView =
  | { state: 'none' }
  | { state: 'pending'; startedAt: number }
  /** 开始了却一直没有结束：后台在等窗口时被回收，或窗口始终没有把结果交回来 */
  | { state: 'lost'; startedAt: number }
  | { state: 'failed'; at: number; message: string; hint?: string };

/** 界面上怎么说最近一次授权尝试（成功的不再提） */
export function attemptView(a: AuthAttempt | null | undefined, now: number): AttemptView {
  if (!a) return { state: 'none' };
  if (a.finishedAt === undefined) {
    return now - a.startedAt < GOOGLE_OAUTH.interactiveMaxMs ? { state: 'pending', startedAt: a.startedAt } : { state: 'lost', startedAt: a.startedAt };
  }
  if (a.error) return { state: 'failed', at: a.finishedAt, message: a.error.message, ...(a.error.hint ? { hint: a.error.hint } : {}) };
  return { state: 'none' };
}
