// 统一的"人话"错误。界面只展示 AppError.message（已脱敏）；任何失败都不静默降级。

import { redact } from '../core/redact';
import { BudgetExceededError } from '../core/quota';
import { IntentParseError } from '../core/intent';

export type ErrorKind =
  | 'auth' // YouTube 授权问题
  | 'oauth_config' // OAuth 客户端未配置
  | 'quota' // YouTube 配额
  | 'budget' // 单次预算
  | 'youtube'
  | 'llm_key'
  | 'llm'
  | 'x_key' // X Bearer Token 缺失/无效
  | 'x_budget' // 达到 X 每日预算或 X 账户余额/花费上限
  | 'x'
  | 'douban' // 豆瓣 RSS 读取失败
  | 'network'
  | 'input'
  | 'internal';

export class AppError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    /** 给用户的下一步建议 */
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 把任意异常转成可展示的 AppError（消息经过脱敏）。 */
export function toAppError(err: unknown, secrets: readonly (string | undefined)[] = []): AppError {
  if (err instanceof AppError) return new AppError(err.kind, redact(err.message, secrets), err.hint && redact(err.hint, secrets));
  if (err instanceof BudgetExceededError) {
    return new AppError('budget', err.message, '可以在设置页调高单次预算，或把口令拆成更具体的一句');
  }
  if (err instanceof IntentParseError) return new AppError('llm', `理解口令失败：${err.message}`, '请重试，或换个说法');
  if (err instanceof TypeError && /fetch|network|Failed to fetch/i.test(err.message)) {
    return new AppError('network', '网络请求失败，可能是断网或目标服务不可达', '检查网络后重试');
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new AppError('internal', `出现了意外错误：${redact(msg, secrets).slice(0, 300)}`);
}
