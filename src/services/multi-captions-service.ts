// 多语字幕的后台部分：回答"这个视频原声是什么语言"。只在偏好里有"视频原声语言"、
// 而字幕轨里看不出来（没有自动生成的字幕，例如 MV）时由内容脚本来问。
// 走官方 videos.list（1 unit，与自动字幕、观看记录共用本机缓存）；字幕文字本身从不经过后台。

import { isLangCode } from '../core/multi-captions';
import type { AppContext } from './context';
import { stores } from './repo';
import { lookupVideoMeta } from './subtitle-service';

const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

export async function multiCcVideoLanguage(ctx: AppContext, videoId: unknown): Promise<{ lang?: string; note?: string }> {
  if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) return {};
  const settings = await stores.settings.read(ctx.kv);
  if (!settings.multiCaptions.enabled) return {};
  const { meta, problem } = await lookupVideoMeta(ctx, videoId, '读取视频语言（多语字幕）');
  if (meta && !meta.missing && isLangCode(meta.language)) return { lang: meta.language };
  if (problem === 'disconnected') return { note: '没有连接 YouTube（或授权已过期），读不到视频原声的语言' };
  return { note: problem ? `读不到视频原声的语言（${problem}）` : 'YouTube 数据里没写这个视频原声的语言' };
}
