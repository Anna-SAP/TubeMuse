// 豆瓣评论 RSS：订阅条目、读取并缓存 RSS。
// 只向 www.douban.com 发一个 GET：不带 Cookie（不暴露你的豆瓣账号）、不带 Referer、不跟随跳转、失败不自动重试。

import { DOUBAN } from '../config/defaults';
import { DOUBAN_IMAGE_ORIGINS } from '../config/endpoints';
import { DoubanFeedError, doubanFeedUrl, doubanFresh, parseDoubanFeed, parseSubjectInput } from '../core/douban';
import type { DoubanFeed, DoubanState } from '../core/types';
import type { AppContext } from './context';
import { AppError } from './errors';
import { stores } from './repo';

async function fetchFeedXml(ctx: AppContext, subjectId: string): Promise<string> {
  let res: Response;
  try {
    res = await ctx.http(doubanFeedUrl(ctx.endpoints.douban, subjectId), {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'manual',
      cache: 'no-cache',
      headers: { Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8' },
    });
  } catch {
    throw new AppError('douban', '无法连接豆瓣（网络错误）', '检查网络后再点"刷新"');
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new AppError('douban', '豆瓣把这次请求转去了别的页面（通常是验证页或登录页），没有拿到 RSS', '在浏览器里打开豆瓣确认能正常访问，过一会儿再刷新；扩展不会代你登录');
  }
  if (res.ok) return res.text();
  switch (res.status) {
    case 404:
      throw new AppError('douban', `豆瓣上没有这个条目，或它没有评论 RSS（条目 ${subjectId}，HTTP 404）`, '检查条目链接或 ID；不需要的话可以取消订阅');
    case 403:
    case 418:
    case 429:
      throw new AppError('douban', `豆瓣拒绝了这次请求（HTTP ${res.status}）：豆瓣会限制频繁或被判定为自动化的访问`, '过一会儿再手动刷新；扩展不会自动重试');
    default:
      throw new AppError('douban', `豆瓣出错（HTTP ${res.status}）`, '稍后再刷新');
  }
}

function parseFeed(xml: string, subjectId: string): DoubanFeed {
  try {
    return parseDoubanFeed(xml, subjectId, DOUBAN_IMAGE_ORIGINS);
  } catch (e) {
    if (e instanceof DoubanFeedError) throw new AppError('douban', e.message, '过一会儿再刷新；如果一直这样，在浏览器里直接打开这个 RSS 地址看看');
    throw e;
  }
}

export interface DoubanRefreshOptions {
  /** 忽略缓存（手动刷新） */
  force?: boolean;
}

/**
 * 读取某个条目的评论 RSS 并缓存。同一条目同一时间只读一次：自动刷新与手动刷新撞在一起时，
 * 排队的那一路直接用刚读到的结果，不再请求豆瓣。
 */
export async function refreshDoubanFeed(ctx: AppContext, subjectId: string, opts: DoubanRefreshOptions = {}): Promise<{ cached: boolean }> {
  const requestedAt = ctx.now();
  return ctx.locker.withLock(`run:douban:${subjectId}`, async () => {
    const [settings, state] = await Promise.all([stores.settings.read(ctx.kv), stores.douban.read(ctx.kv)]);
    if (!settings.douban.enabled) throw new AppError('input', '豆瓣评论已在设置中关闭');
    const entry = state.feeds[subjectId];
    if (entry && (entry.fetchedAt > requestedAt || (!opts.force && doubanFresh(entry, settings.douban.cacheMinutes, ctx.now())))) return { cached: true };
    const feed = parseFeed(await fetchFeedXml(ctx, subjectId), subjectId);
    await stores.douban.update(ctx.kv, ctx.locker, (s) => ({
      ...s,
      feeds: { ...s.feeds, [subjectId]: { fetchedAt: ctx.now(), feed } },
      subjects: s.subjects.map((x) => (x.id === subjectId ? { ...x, title: feed.title } : x)),
    }));
    return { cached: false };
  });
}

/** 订阅一个条目（已订阅则直接选中）；返回条目 ID */
export async function addDoubanSubject(ctx: AppContext, input: string): Promise<string> {
  const id = parseSubjectInput(input);
  if (!id) {
    throw new AppError('input', '没认出豆瓣条目', '粘贴条目链接（如 https://movie.douban.com/subject/35299923/）、它的 RSS 地址，或纯数字 ID');
  }
  await stores.douban.update(ctx.kv, ctx.locker, (s) => {
    if (s.subjects.some((x) => x.id === id)) return { ...s, selected: id };
    if (s.subjects.length >= DOUBAN.maxSubjects) throw new AppError('input', `最多订阅 ${DOUBAN.maxSubjects} 个条目`, '先取消订阅不再看的条目');
    return { ...s, subjects: [...s.subjects, { id, addedAt: ctx.now() }], selected: id };
  });
  return id;
}

/** 取消订阅，并删除该条目的缓存 */
export async function removeDoubanSubject(ctx: AppContext, subjectId: string): Promise<void> {
  await stores.douban.update(ctx.kv, ctx.locker, (s): DoubanState => {
    const subjects = s.subjects.filter((x) => x.id !== subjectId);
    const { [subjectId]: _removed, ...feeds } = s.feeds;
    const selected = s.selected === subjectId ? subjects[0]?.id : s.selected;
    return { subjects, feeds, ...(selected ? { selected } : {}) };
  });
}

export async function selectDoubanSubject(ctx: AppContext, subjectId: string): Promise<void> {
  await stores.douban.update(ctx.kv, ctx.locker, (s) => ({ ...s, selected: subjectId }));
}
