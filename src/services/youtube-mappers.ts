// YouTube Data API v3 响应 → 领域对象（纯函数，用 fixture 单测）。

import { parseIsoDuration } from '../core/time';
import type { ChannelInfo, LikedVideo, VideoCandidate, VideoMeta } from '../core/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface SearchHit {
  videoId: string;
  rank: number;
}

export function mapSearchResponse(json: Json, rankOffset = 0): { hits: SearchHit[]; nextPageToken?: string } {
  const items: Json[] = Array.isArray(json?.items) ? json.items : [];
  const hits: SearchHit[] = [];
  for (const it of items) {
    const id = it?.id?.videoId;
    if (typeof id === 'string' && !hits.some((h) => h.videoId === id)) hits.push({ videoId: id, rank: rankOffset + hits.length + 1 });
  }
  return json?.nextPageToken ? { hits, nextPageToken: String(json.nextPageToken) } : { hits };
}

function bestThumb(thumbs: Json): string | undefined {
  const t = thumbs?.medium ?? thumbs?.high ?? thumbs?.default;
  return typeof t?.url === 'string' ? t.url : undefined;
}

function toNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** videos.list（part=snippet,contentDetails,statistics）→ 候选（hits 由调用方填） */
export function mapVideoItem(it: Json): Omit<VideoCandidate, 'hits'> | undefined {
  if (typeof it?.id !== 'string') return undefined;
  const sn = it.snippet ?? {};
  const cd = it.contentDetails ?? {};
  const st = it.statistics ?? {};
  const live = sn.liveBroadcastContent;
  const v: Omit<VideoCandidate, 'hits'> = {
    id: it.id,
    title: String(sn.title ?? ''),
    description: String(sn.description ?? '').slice(0, 1000),
    channelId: String(sn.channelId ?? ''),
    channelTitle: String(sn.channelTitle ?? ''),
    publishedAt: String(sn.publishedAt ?? ''),
    durationSec: parseIsoDuration(cd.duration),
    caption: cd.caption === 'true' || cd.caption === true,
    definition: cd.definition === 'hd' ? 'hd' : 'sd',
    tags: Array.isArray(sn.tags) ? sn.tags.slice(0, 20).map(String) : [],
    liveBroadcastContent: live === 'live' || live === 'upcoming' ? live : 'none',
  };
  const views = toNum(st.viewCount);
  const likes = toNum(st.likeCount);
  if (views !== undefined) v.viewCount = views;
  if (likes !== undefined) v.likeCount = likes;
  if (sn.defaultAudioLanguage) v.defaultAudioLanguage = String(sn.defaultAudioLanguage);
  if (sn.defaultLanguage) v.defaultLanguage = String(sn.defaultLanguage);
  const thumb = bestThumb(sn.thumbnails);
  if (thumb) v.thumbnailUrl = thumb;
  return v;
}

export function mapChannelItem(it: Json): ChannelInfo | undefined {
  if (typeof it?.id !== 'string') return undefined;
  const c: ChannelInfo = {
    id: it.id,
    title: String(it.snippet?.title ?? ''),
    description: String(it.snippet?.description ?? '').slice(0, 300),
    topicCategories: Array.isArray(it.topicDetails?.topicCategories) ? it.topicDetails.topicCategories.map(String) : [],
  };
  const subs = it.statistics?.hiddenSubscriberCount ? undefined : toNum(it.statistics?.subscriberCount);
  if (subs !== undefined) c.subscriberCount = subs;
  return c;
}

export function mapSubscriptionItem(it: Json): ChannelInfo | undefined {
  const id = it?.snippet?.resourceId?.channelId;
  if (typeof id !== 'string') return undefined;
  return {
    id,
    title: String(it.snippet?.title ?? ''),
    description: String(it.snippet?.description ?? '').slice(0, 300),
    topicCategories: [],
  };
}

export function mapLikedItem(it: Json): LikedVideo | undefined {
  if (typeof it?.id !== 'string') return undefined;
  const sn = it.snippet ?? {};
  return {
    id: it.id,
    title: String(sn.title ?? ''),
    channelId: String(sn.channelId ?? ''),
    channelTitle: String(sn.channelTitle ?? ''),
    publishedAt: String(sn.publishedAt ?? ''),
    tags: Array.isArray(sn.tags) ? sn.tags.slice(0, 10).map(String) : [],
  };
}

/** 从错误响应里取出 reason（quotaExceeded 等） */
export function errorReason(json: Json): { reason?: string; message?: string } {
  const e = json?.error;
  const reason = e?.errors?.[0]?.reason ?? e?.details?.find?.((d: Json) => d?.reason)?.reason ?? e?.status;
  return { reason: typeof reason === 'string' ? reason : undefined, message: typeof e?.message === 'string' ? e.message : undefined };
}

/** videos.list（part=snippet,contentDetails）→ 观看记录用的元数据 */
export function mapVideoMeta(it: Json, now: number): VideoMeta | undefined {
  if (typeof it?.id !== 'string') return undefined;
  const sn = it.snippet ?? {};
  const meta: VideoMeta = {
    id: it.id,
    title: String(sn.title ?? ''),
    channelId: String(sn.channelId ?? ''),
    channelTitle: String(sn.channelTitle ?? ''),
    durationSec: parseIsoDuration(it.contentDetails?.duration),
    tags: Array.isArray(sn.tags) ? sn.tags.slice(0, 10).map(String) : [],
    fetchedAt: now,
  };
  if (sn.categoryId) meta.categoryId = String(sn.categoryId);
  return meta;
}

export function mapUploadsPlaylist(it: Json): { channelId: string; uploads: string } | undefined {
  const uploads = it?.contentDetails?.relatedPlaylists?.uploads;
  return typeof it?.id === 'string' && typeof uploads === 'string' ? { channelId: it.id, uploads } : undefined;
}

export function mapPlaylistItem(it: Json): { videoId: string; title: string; channelTitle: string; publishedAt: string } | undefined {
  const sn = it?.snippet ?? {};
  const videoId = sn.resourceId?.videoId ?? it?.contentDetails?.videoId;
  if (typeof videoId !== 'string') return undefined;
  return {
    videoId,
    title: String(sn.title ?? ''),
    channelTitle: String(sn.videoOwnerChannelTitle ?? sn.channelTitle ?? ''),
    publishedAt: String(it?.contentDetails?.videoPublishedAt ?? sn.publishedAt ?? ''),
  };
}

/** search.list（part=snippet）→ 视频所属频道（新博主发现用） */
export function mapSearchChannels(json: Json): { videoId: string; channelId: string; channelTitle: string; rank: number }[] {
  const items: Json[] = Array.isArray(json?.items) ? json.items : [];
  const out: { videoId: string; channelId: string; channelTitle: string; rank: number }[] = [];
  for (const it of items) {
    const videoId = it?.id?.videoId;
    const channelId = it?.snippet?.channelId;
    if (typeof videoId === 'string' && typeof channelId === 'string') {
      out.push({ videoId, channelId, channelTitle: String(it.snippet.channelTitle ?? ''), rank: out.length + 1 });
    }
  }
  return out;
}
