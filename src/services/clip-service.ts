// 视频片段录制：记下存好的片段（只有元数据）。录制与保存都在 YouTube 页面里的录制脚本完成，视频文件不经过这里。

import { addClipRecord, sanitizeClipRecord, type ClipRecord } from '../core/clips';
import type { AppContext } from './context';
import { stores } from './repo';

/** 录制脚本报告"存好了一个片段"：校验后记一笔；不合格的直接丢弃 */
export async function recordSavedClip(ctx: AppContext, raw: unknown): Promise<ClipRecord | null> {
  const rec = sanitizeClipRecord(raw);
  if (!rec) return null;
  await stores.clipLog.update(ctx.kv, ctx.locker, (log) => addClipRecord(log, rec));
  return rec;
}

export async function clearClipLog(ctx: AppContext): Promise<void> {
  await stores.clipLog.write(ctx.kv, []);
}
