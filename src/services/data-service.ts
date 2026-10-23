// 一键导出 / 清空。导出不含 API Key（避免密钥随文件扩散），其余本地数据全量导出。

import type { AppContext } from './context';
import { EXPORT_EXCLUDED_KEYS } from './repo';

export interface ExportFile {
  app: 'TubeMuse';
  formatVersion: 1;
  exportedAt: string;
  note: string;
  data: Record<string, unknown>;
}

export async function exportAll(ctx: AppContext): Promise<ExportFile> {
  const all = await ctx.kv.getAll();
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (EXPORT_EXCLUDED_KEYS.has(k) || k.startsWith('e2e')) continue;
    data[k] = v;
  }
  return {
    app: 'TubeMuse',
    formatVersion: 1,
    exportedAt: new Date(ctx.now()).toISOString(),
    note: '本文件包含 TubeMuse 在本机保存的全部数据，但不含 API Key 与 YouTube 授权令牌。',
    data,
  };
}

/** 清空全部本地数据（含 YouTube 访问令牌；令牌仍有效时先向 Google 吊销）。 */
export async function clearAll(ctx: AppContext): Promise<void> {
  await ctx.auth.disconnect().catch(() => undefined);
  await ctx.kv.clear();
}
