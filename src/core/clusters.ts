// 兴趣簇：视频匹配、LLM 聚类结果合并、用户编辑。

import { matchedTerms, uniqueStrings } from './text';
import type { ChannelInfo, InterestCluster, VideoCandidate } from './types';

export interface ClusterMatch {
  cluster: InterestCluster;
  /** 0–1：频道在簇内 = 1；关键词命中按个数递增 */
  strength: number;
  viaChannel: boolean;
  keywords: string[];
}

export function matchClusters(v: Pick<VideoCandidate, 'channelId' | 'title' | 'tags'>, clusters: InterestCluster[]): ClusterMatch[] {
  const text = `${v.title}\n${v.tags.join(' ')}`;
  const out: ClusterMatch[] = [];
  for (const cluster of clusters) {
    const viaChannel = cluster.channelIds.includes(v.channelId);
    const keywords = matchedTerms(text, cluster.keywords.filter((k) => k.trim().length >= 2));
    const strength = viaChannel ? 1 : Math.min(0.9, keywords.length * 0.35);
    if (strength > 0) out.push({ cluster, strength, viaChannel, keywords });
  }
  return out.sort((a, b) => b.strength * b.cluster.weight - a.strength * a.cluster.weight);
}

/** LLM 聚类的输出结构（频道用本地短编号 c1、c2… 引用，不发送真实频道 ID）。 */
export interface RawClusterOutput {
  clusters: { name: string; description: string; keywords: string[]; channelRefs: string[]; nature?: string }[];
}

/**
 * 合并 LLM 聚类结果：
 *  - 用户锁定（编辑过）的簇原样保留，LLM 只能往里补新频道；
 *  - 每个频道只归入一个簇（先到先得，锁定簇优先）；
 *  - 未知编号直接忽略。
 */
export function mergeClusterOutput(
  raw: RawClusterOutput,
  refToChannelId: ReadonlyMap<string, string>,
  existing: InterestCluster[],
  now: number,
  newId: () => string,
): InterestCluster[] {
  const locked = existing.filter((c) => c.locked).map((c) => ({ ...c, channelIds: [...c.channelIds] }));
  const assigned = new Set(locked.flatMap((c) => c.channelIds));
  const result: InterestCluster[] = [...locked];
  for (const item of raw.clusters ?? []) {
    const name = (item.name ?? '').trim().slice(0, 40);
    if (!name) continue;
    const ids = uniqueStrings((item.channelRefs ?? []).map((r) => refToChannelId.get(r.trim()) ?? '')).filter(
      (id) => id && !assigned.has(id),
    );
    ids.forEach((id) => assigned.add(id));
    const target = locked.find((c) => c.name === name);
    if (target) {
      target.channelIds.push(...ids);
      continue;
    }
    const nature = item.nature === 'learning' || item.nature === 'entertainment' || item.nature === 'other' ? item.nature : undefined;
    result.push({
      id: newId(),
      name,
      description: (item.description ?? '').trim().slice(0, 200),
      keywords: uniqueStrings(item.keywords ?? []).slice(0, 15),
      channelIds: ids,
      weight: 1,
      locked: false,
      source: 'llm',
      updatedAt: now,
      ...(nature ? { nature } : {}),
    });
  }
  return result;
}

export function unassignedChannels(channels: ChannelInfo[], clusters: InterestCluster[]): ChannelInfo[] {
  const assigned = new Set(clusters.flatMap((c) => c.channelIds));
  return channels.filter((c) => !assigned.has(c.id));
}

/** 用户编辑某个簇：自动加锁，重新生成时不会被覆盖。 */
export function editCluster(clusters: InterestCluster[], id: string, patch: Partial<Omit<InterestCluster, 'id'>>, now: number): InterestCluster[] {
  return clusters.map((c) => (c.id === id ? { ...c, ...patch, locked: patch.locked ?? true, updatedAt: now } : c));
}

/** 把频道移到另一个簇（或移出所有簇：targetId 为空）。 */
export function moveChannel(clusters: InterestCluster[], channelId: string, targetId: string | undefined, now: number): InterestCluster[] {
  return clusters.map((c) => {
    const has = c.channelIds.includes(channelId);
    if (c.id === targetId && !has) return { ...c, channelIds: [...c.channelIds, channelId], locked: true, updatedAt: now };
    if (c.id !== targetId && has) return { ...c, channelIds: c.channelIds.filter((x) => x !== channelId), locked: true, updatedAt: now };
    return c;
  });
}
