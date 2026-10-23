// 单测用的假外部服务：拦截 fetch，按 URL 路由到 YouTube / Anthropic / OpenAI 的假实现，并记录每个请求。
// 所有测试都通过注入这个 fetch 运行，不会发出真实网络请求。

import { ENDPOINTS } from '../../src/config/endpoints';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FakeVideo {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  duration: string;
  views: number;
  likes: number;
  caption?: boolean;
  lang?: string;
  tags?: string[];
  description?: string;
  categoryId?: string;
}

export interface FakeApiOptions {
  /** 返回 LLM 的 JSON（按请求的 system/user 决定） */
  llm: (req: { system: string; user: string; provider: 'anthropic' | 'openai' }) => unknown;
  videos: FakeVideo[];
  /** search.list：给定参数返回 videoId 列表 */
  search: (params: URLSearchParams) => string[];
  subscriptions?: { id: string; title: string }[];
  liked?: FakeVideo[];
  /** 强制某个 YouTube 接口返回错误 */
  failWith?: { path: string; status: number; reason: string };
  /** X recent search：按检索式返回帖子；status 用于模拟 402 等错误 */
  xSearch?: (query: string, maxResults: number) => { status?: number; posts?: { id: string; text: string; likes: number; reposts: number; hoursAgo: number }[] };
  now?: number;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
}

function videoResource(v: FakeVideo) {
  return {
    kind: 'youtube#video',
    id: v.id,
    snippet: {
      publishedAt: v.publishedAt,
      channelId: v.channelId,
      title: v.title,
      description: v.description ?? '',
      channelTitle: v.channelTitle,
      tags: v.tags ?? [],
      defaultAudioLanguage: v.lang,
      categoryId: v.categoryId,
      liveBroadcastContent: 'none',
      thumbnails: { medium: { url: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg` } },
    },
    contentDetails: { duration: v.duration, caption: v.caption ? 'true' : 'false', definition: 'hd' },
    statistics: { viewCount: String(v.views), likeCount: String(v.likes) },
  };
}

export function createFakeApi(opts: FakeApiOptions) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = req.url;
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const body = req.method === 'GET' ? undefined : await req.clone().text();
    requests.push({ url, method: req.method, headers, ...(body ? { body } : {}) });
    const u = new URL(url);

    if (url.startsWith(ENDPOINTS.youtubeApi)) {
      const path = u.pathname.split('/').pop() ?? '';
      if (opts.failWith && opts.failWith.path === path) {
        return json({ error: { code: opts.failWith.status, message: 'fail', errors: [{ reason: opts.failWith.reason }] } }, opts.failWith.status);
      }
      if (path === 'search') {
        const ids = opts.search(u.searchParams);
        return json({
          items: ids.map((id) => {
            const v = opts.videos.find((x) => x.id === id);
            return { id: { kind: 'youtube#video', videoId: id }, snippet: v ? { channelId: v.channelId, channelTitle: v.channelTitle, title: v.title } : {} };
          }),
          ...(u.searchParams.get('pageToken') ? {} : { nextPageToken: 'p2' }),
        });
      }
      if (path === 'videos') {
        if (u.searchParams.get('myRating') === 'like') return json({ items: (opts.liked ?? []).map(videoResource) });
        const ids = (u.searchParams.get('id') ?? '').split(',');
        return json({ items: opts.videos.filter((v) => ids.includes(v.id)).map(videoResource) });
      }
      if (path === 'channels') {
        const ids = (u.searchParams.get('id') ?? '').split(',');
        return json({
          items: ids.map((id) => ({
            id,
            snippet: { title: id, description: '' },
            statistics: { subscriberCount: '120000' },
            topicDetails: { topicCategories: ['https://en.wikipedia.org/wiki/Technology'] },
            contentDetails: { relatedPlaylists: { uploads: `UU${id.slice(2)}` } },
          })),
        });
      }
      if (path === 'playlistItems') {
        const pl = u.searchParams.get('playlistId') ?? '';
        const ch = `UC${pl.slice(2)}`;
        return json({ items: opts.videos.filter((v) => v.channelId === ch).map((v) => ({ snippet: { title: v.title, videoOwnerChannelTitle: v.channelTitle, resourceId: { videoId: v.id } }, contentDetails: { videoId: v.id, videoPublishedAt: v.publishedAt } })) });
      }
      if (path === 'subscriptions') {
        return json({
          pageInfo: { totalResults: opts.subscriptions?.length ?? 0 },
          items: (opts.subscriptions ?? []).map((s) => ({ snippet: { title: s.title, description: '', resourceId: { channelId: s.id } } })),
        });
      }
      return json({ error: { code: 404, message: 'not found' } }, 404);
    }

    if (url.startsWith(ENDPOINTS.anthropic)) {
      const b = JSON.parse(body ?? '{}');
      const out = opts.llm({ system: String(b.system ?? ''), user: String(b.messages?.[0]?.content ?? ''), provider: 'anthropic' });
      return json({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: b.model,
        content: [{ type: 'text', text: JSON.stringify(out) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    }

    if (url.startsWith(ENDPOINTS.x)) {
      const r = opts.xSearch?.(u.searchParams.get('query') ?? '', Number(u.searchParams.get('max_results'))) ?? {};
      if (r.status && r.status !== 200) return json({ title: 'Payment Required', detail: 'CreditsDepleted' }, r.status);
      const max = Number(u.searchParams.get('max_results'));
      const now = opts.now ?? Date.now();
      const posts = (r.posts ?? []).slice(0, max);
      return json({
        data: posts.map((p) => ({ id: p.id, text: p.text, created_at: new Date(now - p.hoursAgo * 3_600_000).toISOString(), lang: 'en', public_metrics: { like_count: p.likes, repost_count: p.reposts, reply_count: 0, quote_count: 0 } })),
        meta: { result_count: posts.length },
      });
    }

    if (url.startsWith(ENDPOINTS.openai)) {
      const b = JSON.parse(body ?? '{}');
      const out = opts.llm({ system: String(b.instructions ?? ''), user: String(b.input ?? ''), provider: 'openai' });
      return json({
        id: 'resp_test',
        object: 'response',
        created_at: 0,
        status: 'completed',
        model: b.model,
        output: [{ type: 'message', id: 'm1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(out), annotations: [] }] }],
      });
    }
    throw new Error(`fake-api：未预期的请求 ${url}`);
  };
  return { fetch: fetchImpl, requests };
}
