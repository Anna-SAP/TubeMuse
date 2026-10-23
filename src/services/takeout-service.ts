// Google Takeout 观看历史导入：只在本机解析，压缩成按频道的统计后保存（原始明细不保存，不调用任何 API）。

import { aggregateTakeout, parseTakeoutWatchHistory } from '../core/takeout';
import type { TakeoutProfile } from '../core/types';
import type { AppContext } from './context';
import { AppError } from './errors';
import { stores } from './repo';

export async function importTakeout(ctx: AppContext, text: string): Promise<TakeoutProfile> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError('input', '文件不是有效的 JSON', '在 Takeout 里把"历史记录"的格式选为 JSON，再导入 watch-history.json');
  }
  let parsed;
  try {
    parsed = parseTakeoutWatchHistory(json);
  } catch (e) {
    throw new AppError('input', e instanceof Error ? e.message : '无法识别的文件');
  }
  if (!parsed.entries.length) throw new AppError('input', '文件里没有可用的观看记录', '确认选的是 YouTube 的 watch-history.json');
  const profile = aggregateTakeout(parsed.entries, parsed.skipped, ctx.now());
  await stores.takeout.write(ctx.kv, profile);
  return profile;
}

export async function clearTakeout(ctx: AppContext): Promise<void> {
  await ctx.kv.remove(stores.takeout.key);
}
