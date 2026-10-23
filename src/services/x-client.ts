// X 官方 API v2 客户端：只读（recent search），App-only Bearer Token 只放在请求头里发往 api.x.com。
// 永远不发帖、点赞、关注。

import { X_API } from '../config/defaults';
import { redact } from '../core/redact';
import type { XPost } from '../core/types';
import { AppError } from './errors';

export interface XClientDeps {
  http: typeof fetch;
  baseUrl: string;
  token: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

function toPost(it: Json, topic: string): XPost | undefined {
  if (typeof it?.id !== 'string' || typeof it?.text !== 'string') return undefined;
  const m = it.public_metrics ?? {};
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const p: XPost = {
    id: it.id,
    text: it.text,
    createdAt: typeof it.created_at === 'string' ? it.created_at : new Date(0).toISOString(),
    likes: n(m.like_count),
    reposts: n(m.repost_count ?? m.retweet_count),
    replies: n(m.reply_count),
    quotes: n(m.quote_count),
    topic,
  };
  if (typeof it.lang === 'string') p.lang = it.lang;
  return p;
}

export function createXClient(deps: XClientDeps) {
  return {
    /** 最近帖子检索。不展开作者（用户对象按 $0.01/个另计费）。 */
    async searchRecent(query: string, maxResults: number, startTime: string, topic: string): Promise<XPost[]> {
      const params = new URLSearchParams({
        query,
        max_results: String(Math.min(X_API.maxResults, Math.max(X_API.minResults, maxResults))),
        sort_order: 'relevancy',
        start_time: startTime,
        'post.fields': 'created_at,public_metrics,lang',
      });
      let res: Response;
      try {
        res = await deps.http(`${deps.baseUrl}/tweets/search/recent?${params.toString()}`, {
          headers: { Authorization: `Bearer ${deps.token}`, Accept: 'application/json' },
        });
      } catch {
        throw new AppError('network', '无法连接 X API（网络错误）', '检查网络后重试');
      }
      const body = (await res.json().catch(() => ({}))) as Json;
      if (res.ok) {
        const data: Json[] = Array.isArray(body?.data) ? body.data : [];
        return data.map((d) => toPost(d, topic)).filter((p): p is XPost => !!p);
      }
      const detail = redact(String(body?.detail ?? body?.title ?? body?.errors?.[0]?.message ?? ''), [deps.token]).slice(0, 200);
      switch (res.status) {
        case 401:
          throw new AppError('x_key', 'X Bearer Token 无效或已被撤销', '在 X 开发者后台重新生成 Bearer Token，填到设置页');
        case 402:
          throw new AppError('x_budget', 'X 拒绝了请求：账户余额不足，或达到了你在 X 开发者后台设置的花费上限', '到 X 开发者后台查看余额与花费上限');
        case 403:
          throw new AppError('x', `X 拒绝访问：${detail || '应用没有 recent search 权限，或账户未开通按量付费'}`, '确认应用属于已开通按量付费的项目');
        case 429:
          throw new AppError('x', 'X 请求过于频繁', '稍后再试');
        case 400:
          throw new AppError('x', `X 拒绝了检索式：${detail || '参数无效'}`, '可能是兴趣簇关键词里有特殊字符，改一下关键词再试');
        default:
          throw new AppError('x', `X API 出错（HTTP ${res.status}）${detail ? `：${detail}` : ''}`, '稍后重试');
      }
    },
  };
}
