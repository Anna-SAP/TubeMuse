// Google Takeout 观看历史导入（watch-history.json）。只在本机解析、不调用任何 API。
// 结构（每条）：{ header: "YouTube", title: "Watched …" / "观看了 …", titleUrl: "https://www.youtube.com/watch?v=…",
//               subtitles: [{ name: 频道名, url: "https://www.youtube.com/channel/UC…" }], time: ISO 时间, details?: [{ name: "From Google Ads" }] }

import type { TakeoutProfile } from './types';

const TITLE_PREFIXES = [/^Watched\s+/i, /^观看了\s*/, /^已观看\s*/, /^觀看了\s*/, /^Visto\s+/i, /^Regardé\s+/i, /^Angesehen:\s*/i, /^視聴済み:?\s*/];
const TITLE_SUFFIXES = [/\s*を視聴しました$/];

export interface TakeoutEntry {
  videoId: string;
  title: string;
  channelId?: string;
  channelTitle: string;
  time: string;
}

function cleanTitle(t: string): string {
  let s = t.trim();
  for (const re of TITLE_PREFIXES) s = s.replace(re, '');
  for (const re of TITLE_SUFFIXES) s = s.replace(re, '');
  return s;
}

export function parseTakeoutWatchHistory(json: unknown): { entries: TakeoutEntry[]; skipped: TakeoutProfile['skipped'] } {
  if (!Array.isArray(json)) throw new Error('不是 Takeout 的 watch-history.json（应为 JSON 数组）。导出时请把"历史记录"格式选为 JSON。');
  const entries: TakeoutEntry[] = [];
  const skipped = { ads: 0, noVideo: 0, invalid: 0 };
  for (const raw of json) {
    if (!raw || typeof raw !== 'object') {
      skipped.invalid++;
      continue;
    }
    const r = raw as Record<string, unknown>;
    const details = Array.isArray(r.details) ? (r.details as { name?: string }[]) : [];
    if (details.some((d) => /ads/i.test(String(d?.name ?? '')))) {
      skipped.ads++;
      continue;
    }
    const url = typeof r.titleUrl === 'string' ? r.titleUrl : '';
    const m = /[?&]v=([\w-]{6,20})/.exec(url) ?? /youtu\.be\/([\w-]{6,20})/.exec(url) ?? /\/shorts\/([\w-]{6,20})/.exec(url);
    const time = typeof r.time === 'string' ? r.time : '';
    if (!m || !time || Number.isNaN(Date.parse(time))) {
      if (!m) skipped.noVideo++;
      else skipped.invalid++;
      continue;
    }
    const sub = Array.isArray(r.subtitles) ? (r.subtitles[0] as { name?: string; url?: string } | undefined) : undefined;
    const channelId = /\/channel\/(UC[\w-]{10,})/.exec(String(sub?.url ?? ''))?.[1];
    entries.push({
      videoId: m[1]!,
      title: cleanTitle(String(r.title ?? '')),
      channelTitle: String(sub?.name ?? ''),
      time,
      ...(channelId ? { channelId } : {}),
    });
  }
  return { entries, skipped };
}

/** 压缩成画像可用的统计：按频道计数（前 300 个）+ 最近 300 条。原始明细不保存。 */
export function aggregateTakeout(entries: TakeoutEntry[], skipped: TakeoutProfile['skipped'], now: number): TakeoutProfile {
  const byChannel = new Map<string, { channelId: string; title: string; count: number; lastWatched: string }>();
  for (const e of entries) {
    if (!e.channelId) continue;
    const cur = byChannel.get(e.channelId);
    if (cur) {
      cur.count++;
      if (e.time > cur.lastWatched) cur.lastWatched = e.time;
    } else byChannel.set(e.channelId, { channelId: e.channelId, title: e.channelTitle, count: 1, lastWatched: e.time });
  }
  const sorted = [...entries].sort((a, b) => (a.time < b.time ? 1 : -1));
  const profile: TakeoutProfile = {
    importedAt: now,
    totalEntries: entries.length,
    channels: [...byChannel.values()].sort((a, b) => b.count - a.count).slice(0, 300),
    recent: sorted.slice(0, 300).map((e) => ({ videoId: e.videoId, title: e.title, channelTitle: e.channelTitle, time: e.time })),
    skipped,
  };
  if (sorted.length) {
    profile.lastWatched = sorted[0]!.time;
    profile.firstWatched = sorted[sorted.length - 1]!.time;
  }
  return profile;
}
