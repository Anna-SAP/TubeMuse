// 画像同步（订阅 + 喜欢的视频）与兴趣簇生成。

import { YOUTUBE_LIMITS } from '../config/defaults';
import { mergeClusterOutput, type RawClusterOutput } from '../core/clusters';
import { buildClusterPrompt, CLUSTER_SCHEMA } from '../core/prompts';
import { OperationBudget } from '../core/quota';
import type { ChannelInfo, InterestCluster, LikedVideo, Profile } from '../core/types';
import type { AppContext } from './context';
import { AppError } from './errors';
import { getLlm } from './llm-factory';
import { makeCharger, makeExhaustedMarker } from './quota-service';
import { newId, stores } from './repo';
import { createYouTube } from './youtube';

/** 一次同步最多花多少通用 units（2000 个订阅约 80 units，留足余量；超出会明确报错而不是悄悄截断） */
export const SYNC_UNIT_BUDGET = 200;
/** 喜欢的视频里出现、但未订阅的频道，最多补查多少个 */
const LIKED_CHANNEL_DETAILS_MAX = 100;

export interface SyncProgress {
  stage: 'subscriptions' | 'liked' | 'channels' | 'done';
  detail: string;
}

export async function syncProfile(ctx: AppContext, onProgress: (p: SyncProgress) => void = () => {}): Promise<{ profile: Profile; unitsSpent: number }> {
  const settings = await stores.settings.read(ctx.kv);
  const budget = new OperationBudget({ searchCalls: 0, generalUnits: SYNC_UNIT_BUDGET }, '本次画像同步');
  const yt = createYouTube({
    http: ctx.http,
    auth: ctx.auth,
    baseUrl: ctx.endpoints.youtubeApi,
    charge: makeCharger(ctx, budget, settings.quota),
    onQuotaExhausted: makeExhaustedMarker(ctx),
  });

  // 1) 订阅
  const subscriptions: ChannelInfo[] = [];
  let token: string | undefined;
  do {
    const page = await yt.subscriptionsPage(token);
    subscriptions.push(...page.channels);
    token = page.nextPageToken;
    onProgress({ stage: 'subscriptions', detail: `已读取 ${subscriptions.length}${page.total ? ` / ${page.total}` : ''} 个订阅` });
  } while (token);

  // 2) 喜欢的视频（官方最多只能翻到最近 1000 条）
  const likedMax = Math.min(settings.profile.likedVideosMax, YOUTUBE_LIMITS.likedVideosHardMax);
  const likedVideos: LikedVideo[] = [];
  token = undefined;
  while (likedVideos.length < likedMax) {
    const page = await yt.likedPage(token);
    likedVideos.push(...page.videos);
    token = page.nextPageToken;
    onProgress({ stage: 'liked', detail: `已读取 ${likedVideos.length} 个喜欢的视频` });
    if (!token) break;
  }
  likedVideos.splice(likedMax);

  // 3) 频道详情：订阅频道（主题分类、订阅数）+ 喜欢的视频里常出现的未订阅频道
  const subIds = new Set(subscriptions.map((s) => s.id));
  const likedCount = new Map<string, number>();
  for (const v of likedVideos) if (!subIds.has(v.channelId)) likedCount.set(v.channelId, (likedCount.get(v.channelId) ?? 0) + 1);
  const likedChannelIds = [...likedCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, LIKED_CHANNEL_DETAILS_MAX).map(([id]) => id);
  onProgress({ stage: 'channels', detail: `正在读取 ${subscriptions.length + likedChannelIds.length} 个频道的详情` });
  const details = await yt.channels([...subIds, ...likedChannelIds]);
  const detailMap = new Map(details.map((d) => [d.id, d]));
  const enrichedSubs = subscriptions.map((s) => {
    const d = detailMap.get(s.id);
    return d ? { ...s, topicCategories: d.topicCategories, ...(d.subscriberCount !== undefined ? { subscriberCount: d.subscriberCount } : {}) } : s;
  });
  const likedChannels = likedChannelIds.map((id) => detailMap.get(id)).filter((c): c is ChannelInfo => !!c);

  const profile: Profile = { syncedAt: ctx.now(), subscriptions: enrichedSubs, likedVideos, likedChannels };
  await stores.profile.write(ctx.kv, profile);
  onProgress({ stage: 'done', detail: `同步完成：${enrichedSubs.length} 个订阅、${likedVideos.length} 个喜欢的视频，消耗 ${budget.generalUnits} units` });
  return { profile, unitsSpent: budget.generalUnits };
}

function isRawClusterOutput(v: unknown): v is RawClusterOutput {
  return !!v && typeof v === 'object' && Array.isArray((v as RawClusterOutput).clusters);
}

/** 调用 LLM 生成兴趣簇；用户编辑过（已锁定）的簇会原样保留。 */
export async function generateClusters(ctx: AppContext): Promise<InterestCluster[]> {
  const [profile, state, takeout] = await Promise.all([stores.profile.read(ctx.kv), stores.clusters.read(ctx.kv), stores.takeout.read(ctx.kv)]);
  if (!profile.syncedAt) throw new AppError('input', '还没有同步订阅与喜欢的视频', '先点"同步"');
  const channels = [...profile.subscriptions, ...profile.likedChannels];
  if (!channels.length && !profile.likedVideos.length) throw new AppError('input', '订阅和喜欢的视频都是空的，没有可归纳的内容');
  const llm = await getLlm(ctx);
  const locked = state.clusters.filter((c) => c.locked);
  const watchedChannels = (takeout?.channels ?? []).map((c) => ({ id: c.channelId, title: c.title, count: c.count }));
  const prompt = buildClusterPrompt({ channels, likedVideos: profile.likedVideos, locked, watchedChannels });
  const raw = await llm.generateJson({ system: prompt.system, user: prompt.user, schema: CLUSTER_SCHEMA, schemaName: 'tubemuse_clusters', effort: 'medium' });
  if (!isRawClusterOutput(raw)) throw new AppError('llm', 'LLM 返回的兴趣簇格式不对', '请重试');
  const clusters = mergeClusterOutput(raw, prompt.refs, state.clusters, ctx.now(), () => newId('k'));
  await stores.clusters.write(ctx.kv, { clusters, generatedAt: ctx.now() });
  return clusters;
}

export async function saveClusters(ctx: AppContext, clusters: InterestCluster[]): Promise<void> {
  await stores.clusters.update(ctx.kv, ctx.locker, (s) => ({ ...s, clusters }));
}
