// 小红书收藏与标签：所有写入都经这里（加锁读改写）。页面脚本发来的操作先当不可信输入校验，且只允许收藏 / 移出 / 加减标签。

import { applyXhsOp, parseXhsOp, type XhsOp } from '../core/xhs';
import type { AppContext } from './context';
import { stores } from './repo';

export type XhsReply = { ok: true } | { ok: false; error: string };

export async function applyXhs(ctx: AppContext, op: XhsOp): Promise<XhsReply> {
  let error: string | undefined;
  await stores.xhs.update(ctx.kv, ctx.locker, (state) => {
    const r = applyXhsOp(state, op, ctx.now());
    error = r.error;
    return r.state;
  });
  return error ? { ok: false, error } : { ok: true };
}

/** 小红书页面里的脚本发来的操作：校验不过的不写入，并说明原因 */
export async function applyXhsFromPage(ctx: AppContext, raw: unknown): Promise<XhsReply> {
  const op = parseXhsOp(raw, ctx.now(), true);
  if (!op) return { ok: false, error: '没有保存：这条内容不完整或链接不是小红书的（刷新页面后再试）' };
  return applyXhs(ctx, op);
}
