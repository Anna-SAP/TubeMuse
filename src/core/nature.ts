// 学习 / 娱乐判定：可解释的打分（每条信号写清"为什么"），用户纠正永远优先。
//   用户对这条视频的纠正 > 用户对该频道的纠正 > 信号打分（兴趣簇倾向、YouTube 分类、标题关键词、Shorts）

import { NATURE, YOUTUBE_CATEGORIES } from '../config/defaults';
import { matchClusters } from './clusters';
import { matchedTerms } from './text';
import { dayKey, DAY_MS } from './time';
import type { InterestCluster, Nature, NatureRules, NatureVerdict, VideoMeta, WatchRecord, WindowStats } from './types';
import { NATURE_LABELS } from './types';

export const EMPTY_RULES: NatureRules = { channels: {}, videos: {} };

const fmt = (n: number) => (n > 0 ? `+${n}` : String(n));

export function classifyNature(
  videoId: string,
  meta: VideoMeta | undefined,
  shorts: boolean,
  clusters: InterestCluster[],
  rules: NatureRules,
): NatureVerdict {
  const userVideo = rules.videos[videoId];
  if (userVideo) return { nature: userVideo, score: 0, reasons: [`你把这条视频标为"${NATURE_LABELS[userVideo]}"`], source: 'user_video' };
  const userChannel = meta ? rules.channels[meta.channelId] : undefined;
  if (userChannel) {
    return { nature: userChannel.nature, score: 0, reasons: [`你把频道「${userChannel.title}」标为"${NATURE_LABELS[userChannel.nature]}"`], source: 'user_channel' };
  }
  if (!meta || meta.missing) {
    return { nature: 'other', score: 0, reasons: [meta?.missing ? '视频已不可见，无法判断' : '还没取到这条视频的元数据（需要连接 YouTube）'], source: 'signals' };
  }

  let score = 0;
  const reasons: string[] = [];
  const signed = (lean: Nature) => (lean === 'learning' ? 1 : lean === 'entertainment' ? -1 : 0);

  const cm = matchClusters({ channelId: meta.channelId, title: meta.title, tags: meta.tags }, clusters).find(
    (m) => m.cluster.nature && m.cluster.nature !== 'other' && m.strength >= 0.35,
  );
  if (cm && cm.cluster.nature) {
    const s = signed(cm.cluster.nature) * NATURE.cluster * (cm.viaChannel ? 1 : 0.5);
    score += s;
    reasons.push(`属于兴趣簇「${cm.cluster.name}」（${NATURE_LABELS[cm.cluster.nature]}，${fmt(s)}）`);
  }
  const cat = meta.categoryId ? YOUTUBE_CATEGORIES[meta.categoryId] : undefined;
  if (cat && cat.lean !== 'neutral') {
    const s = (cat.lean === 'learning' ? 1 : -1) * NATURE.category;
    score += s;
    reasons.push(`YouTube 分类：${cat.name}（${fmt(s)}）`);
  } else if (cat) {
    reasons.push(`YouTube 分类：${cat.name}（中性）`);
  }
  const text = `${meta.title}\n${meta.tags.join(' ')}`;
  const learnHits = matchedTerms(text, NATURE.learningKeywords);
  const funHits = matchedTerms(text, NATURE.entertainmentKeywords);
  if (learnHits.length) {
    score += NATURE.keyword;
    reasons.push(`标题/标签含「${learnHits.slice(0, 2).join('、')}」（${fmt(NATURE.keyword)}）`);
  }
  if (funHits.length) {
    score -= NATURE.keyword;
    reasons.push(`标题/标签含「${funHits.slice(0, 2).join('、')}」（${fmt(-NATURE.keyword)}）`);
  }
  if (shorts) {
    score += NATURE.shorts;
    reasons.push(`Shorts 短视频（${fmt(NATURE.shorts)}）`);
  }
  const nature: Nature = score >= NATURE.threshold ? 'learning' : score <= -NATURE.threshold ? 'entertainment' : 'other';
  if (!reasons.length) reasons.push('没有明显的学习或娱乐信号');
  return { nature, score, reasons, source: 'signals' };
}

/** 最近 windowDays 天（含今天）的有效观看时长构成。 */
export function windowStats(
  log: Record<string, Record<string, WatchRecord>>,
  natureOf: (r: WatchRecord) => Nature,
  now: number,
  windowDays: number,
  timeZone: string,
): WindowStats {
  const days = new Set<string>();
  for (let i = 0; i < windowDays; i++) days.add(dayKey(now - i * DAY_MS, timeZone));
  let totalSec = 0;
  let learningSec = 0;
  let entertainmentSec = 0;
  for (const day of days) {
    for (const r of Object.values(log[day] ?? {})) {
      totalSec += r.playSec;
      const n = natureOf(r);
      if (n === 'learning') learningSec += r.playSec;
      else if (n === 'entertainment') entertainmentSec += r.playSec;
    }
  }
  const sorted = [...days].sort();
  return {
    fromDay: sorted[0]!,
    toDay: sorted[sorted.length - 1]!,
    totalSec: Math.round(totalSec),
    learningSec: Math.round(learningSec),
    entertainmentSec: Math.round(entertainmentSec),
    otherSec: Math.round(totalSec - learningSec - entertainmentSec),
    learningRatio: totalSec > 0 ? learningSec / totalSec : 0,
    entertainmentRatio: totalSec > 0 ? entertainmentSec / totalSec : 0,
  };
}

/** 用户纠正：只改这条，或改整个频道（频道规则对之后的视频也生效）。 */
export function applyCorrection(rules: NatureRules, videoId: string, nature: Nature | null, channel?: { id: string; title: string }): NatureRules {
  const next: NatureRules = { channels: { ...rules.channels }, videos: { ...rules.videos } };
  if (channel) {
    if (nature) next.channels[channel.id] = { nature, title: channel.title };
    else delete next.channels[channel.id];
    delete next.videos[videoId];
  } else if (nature) next.videos[videoId] = nature;
  else delete next.videos[videoId];
  return next;
}
