// YouTube Data API v3 客户端。只走官方 API；每次请求前先记账（含单次预算检查），失败一律转成人话。

import { YOUTUBE_LIMITS, YOUTUBE_METHOD_COSTS, type QuotaBucket, type YtMethod } from '../config/defaults';
import { redact } from '../core/redact';
import type { ChannelInfo, LikedVideo, VideoCandidate, VideoMeta } from '../core/types';
import type { AuthProvider } from './auth';
import { AppError } from './errors';
import {
  errorReason,
  mapChannelItem,
  mapLikedItem,
  mapPlaylistItem,
  mapSearchChannels,
  mapUploadsPlaylist,
  mapVideoMeta,
  mapSearchResponse,
  mapSubscriptionItem,
  mapVideoItem,
  type SearchHit,
} from './youtube-mappers';

export interface YouTubeDeps {
  http: typeof fetch;
  auth: AuthProvider;
  baseUrl: string;
  /** 调用前记账；超出单次预算或今日配额时抛错 */
  charge: (method: YtMethod) => Promise<void>;
  /** 官方返回配额耗尽时回调，用于把本地账本标记为耗尽 */
  onQuotaExhausted: (bucket: QuotaBucket) => Promise<void>;
}

const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED']);

export type YouTubeClient = ReturnType<typeof createYouTube>;

export function createYouTube(deps: YouTubeDeps) {
  async function call(method: YtMethod, path: string, params: Record<string, string>): Promise<unknown> {
    const url = `${deps.baseUrl}/${path}?${new URLSearchParams(params).toString()}`;
    let token = await deps.auth.getToken(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      // 官方：包括无效请求在内的每次请求都计费，所以每次尝试都记账
      await deps.charge(method);
      let res: Response;
      try {
        res = await deps.http(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      } catch {
        throw new AppError('network', '无法连接 YouTube API（网络错误）', '检查网络后重试');
      }
      if (res.ok) return res.json();
      const body = await res.json().catch(() => ({}));
      const { reason, message } = errorReason(body);
      const safeMsg = redact(message ?? '', [token]).slice(0, 200);
      if (res.status === 401 && attempt === 0) {
        await deps.auth.invalidate(token);
        token = await deps.auth.getToken(false);
        continue;
      }
      if (res.status === 401) throw new AppError('auth', 'YouTube 授权已失效', '在设置页重新点"连接 YouTube"');
      if (reason && QUOTA_REASONS.has(reason)) {
        const bucket = YOUTUBE_METHOD_COSTS[method].bucket;
        await deps.onQuotaExhausted(bucket);
        throw new AppError(
          'quota',
          bucket === 'search' ? 'YouTube 官方返回：今天的 search 配额已用完' : 'YouTube 官方返回：今天的接口配额已用完',
          '配额在美国太平洋时间零点重置；本地计数可能与官方不同（同一 GCP 项目的其他调用也会占用配额）',
        );
      }
      if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED') {
        throw new AppError('youtube', '你的 Google Cloud 项目还没有启用 YouTube Data API v3', '按 README 第 2 步在 Google Cloud 控制台启用它');
      }
      if (reason === 'insufficientPermissions' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
        throw new AppError('auth', '授权范围不足', '在设置页断开后重新连接 YouTube');
      }
      if (res.status === 400) throw new AppError('youtube', `YouTube 拒绝了请求参数：${safeMsg || reason || '未知原因'}`);
      if (res.status === 403) throw new AppError('youtube', `YouTube 拒绝访问：${safeMsg || reason || '未知原因'}`);
      if (res.status >= 500) throw new AppError('youtube', `YouTube 服务暂时不可用（HTTP ${res.status}）`, '稍后重试');
      throw new AppError('youtube', `YouTube 请求失败（HTTP ${res.status}）：${safeMsg}`);
    }
    throw new AppError('auth', 'YouTube 授权已失效', '在设置页重新点"连接 YouTube"');
  }

  /** 把 id 按 50 个一组调用 list 接口 */
  async function listByIds<T>(method: YtMethod, path: string, ids: string[], part: string, map: (it: unknown) => T | undefined): Promise<T[]> {
    const out: T[] = [];
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += YOUTUBE_LIMITS.maxResultsPerPage) {
      const chunk = unique.slice(i, i + YOUTUBE_LIMITS.maxResultsPerPage);
      const json = (await call(method, path, { part, id: chunk.join(','), maxResults: String(chunk.length) })) as { items?: unknown[] };
      for (const it of json.items ?? []) {
        const m = map(it);
        if (m) out.push(m);
      }
    }
    return out;
  }

  return {
    async search(params: Record<string, string>, pageToken?: string, rankOffset = 0): Promise<{ hits: SearchHit[]; nextPageToken?: string }> {
      const p = pageToken ? { ...params, pageToken } : params;
      return mapSearchResponse(await call('search.list', 'search', p), rankOffset);
    },
    videos(ids: string[]): Promise<Omit<VideoCandidate, 'hits'>[]> {
      return listByIds('videos.list', 'videos', ids, 'snippet,contentDetails,statistics', mapVideoItem);
    },
    channels(ids: string[], part = 'snippet,statistics,topicDetails'): Promise<ChannelInfo[]> {
      return listByIds('channels.list', 'channels', ids, part, mapChannelItem);
    },
    async subscriptionsPage(pageToken?: string): Promise<{ channels: ChannelInfo[]; nextPageToken?: string; total?: number }> {
      const params: Record<string, string> = { part: 'snippet', mine: 'true', maxResults: '50', order: 'alphabetical' };
      if (pageToken) params.pageToken = pageToken;
      const json = (await call('subscriptions.list', 'subscriptions', params)) as {
        items?: unknown[];
        nextPageToken?: string;
        pageInfo?: { totalResults?: number };
      };
      const channels = (json.items ?? []).map(mapSubscriptionItem).filter((c): c is ChannelInfo => !!c);
      const out: { channels: ChannelInfo[]; nextPageToken?: string; total?: number } = { channels };
      if (json.nextPageToken) out.nextPageToken = json.nextPageToken;
      if (json.pageInfo?.totalResults !== undefined) out.total = json.pageInfo.totalResults;
      return out;
    },
    /** 检索视频并返回所属频道（新博主发现） */
    async searchChannels(params: Record<string, string>) {
      return mapSearchChannels(await call('search.list', 'search', params));
    },
    /** 观看记录的元数据（标题、频道、分类、时长）。查不到的 id（已删除/私有）标为 missing。 */
    async videoMetas(ids: string[], now: number): Promise<VideoMeta[]> {
      const found = await listByIds('videos.list', 'videos', ids, 'snippet,contentDetails', (it) => mapVideoMeta(it, now));
      const got = new Set(found.map((m) => m.id));
      const missing = [...new Set(ids)].filter((id) => !got.has(id));
      return [...found, ...missing.map((id) => ({ id, title: '', channelId: '', channelTitle: '', durationSec: 0, tags: [], fetchedAt: now, missing: true }))];
    },
    /** 频道的上传内容播放列表 id */
    uploadsPlaylists(channelIds: string[]): Promise<{ channelId: string; uploads: string }[]> {
      return listByIds('channels.list', 'channels', channelIds, 'contentDetails', mapUploadsPlaylist);
    },
    /** 播放列表的前若干条（读取频道最新上传用） */
    async playlistItems(playlistId: string, max = 10) {
      const json = (await call('playlistItems.list', 'playlistItems', { part: 'snippet,contentDetails', playlistId, maxResults: String(max) })) as { items?: unknown[] };
      return (json.items ?? []).map(mapPlaylistItem).filter((x): x is NonNullable<ReturnType<typeof mapPlaylistItem>> => !!x);
    },
    async likedPage(pageToken?: string): Promise<{ videos: LikedVideo[]; nextPageToken?: string }> {
      const params: Record<string, string> = { part: 'snippet', myRating: 'like', maxResults: '50' };
      if (pageToken) params.pageToken = pageToken;
      const json = (await call('videos.list', 'videos', params)) as { items?: unknown[]; nextPageToken?: string };
      const videos = (json.items ?? []).map(mapLikedItem).filter((v): v is LikedVideo => !!v);
      return json.nextPageToken ? { videos, nextPageToken: json.nextPageToken } : { videos };
    },
  };
}
