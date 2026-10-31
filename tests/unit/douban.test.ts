// 豆瓣评论 RSS：解析（截断的 Draft.js 摘要、半个 emoji、链接白名单、排序去重）与服务层（请求形态、缓存、并发、失败不静默）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOUBAN } from '../../src/config/defaults';
import { DOUBAN_IMAGE_ORIGINS, ENDPOINTS } from '../../src/config/endpoints';
import {
  DoubanFeedError,
  hueOf,
  parseDescription,
  parseDoubanFeed,
  parseSubjectInput,
  pruneTransientFeeds,
  ratingStars,
  splitReviewTitle,
  subjectFromTabUrl,
} from '../../src/core/douban';
import type { AuthProvider } from '../../src/services/auth';
import type { AppContext } from '../../src/services/context';
import { exportAll } from '../../src/services/data-service';
import { addDoubanSubject, refreshDoubanFeed, removeDoubanSubject } from '../../src/services/douban-service';
import { stores } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';
import { formatDateTime } from '../../src/core/time';

const FIXTURE = readFileSync(join(__dirname, '..', 'fixtures', 'douban-reviews.xml'), 'utf8');
const NOW = Date.parse('2026-10-31T12:00:00Z');
const ID = '35299923';

describe('评论发布时间：按本地时区显示为 YYYY/MM/DD HH:mm', () => {
  const pub = Date.parse('Wed, 21 Oct 2026 19:04:05 GMT');
  it('RSS 的 GMT 时间换算到本地时区（跨日也对）', () => {
    expect(formatDateTime(pub, 'Asia/Shanghai')).toBe('2026/10/22 03:04');
    expect(formatDateTime(pub, 'America/Los_Angeles')).toBe('2026/10/21 12:04');
    expect(formatDateTime(pub, 'UTC')).toBe('2026/10/21 19:04');
  });
  it('零点显示 00:00（不是 24:00），月日时分补零', () => {
    expect(formatDateTime(Date.parse('2026-10-21T16:00:00Z'), 'Asia/Shanghai')).toBe('2026/10/22 00:00');
    expect(formatDateTime(Date.parse('2026-01-02T03:04:59Z'), 'UTC')).toBe('2026/01/02 03:04');
  });
});

describe('认出条目 ID', () => {
  it.each([
    ['35299923', ID],
    ['  35299923 ', ID],
    ['https://movie.douban.com/subject/35299923/', ID],
    ['https://movie.douban.com/subject/35299923/reviews?sort=time', ID],
    ['movie.douban.com/subject/35299923', ID],
    ['https://www.douban.com/feed/subject/35299923/reviews', ID],
    ['https://m.douban.com/movie/subject/35299923/', ID],
    ['https://book.douban.com/subject/1084336/', '1084336'],
  ])('%s → %s', (input, id) => expect(parseSubjectInput(input)).toBe(id));

  it.each(['', 'abc', '12', 'https://example.com/subject/35299923/', 'https://douban.com.evil.com/subject/35299923/', 'https://www.douban.com/people/123456/'])('认不出：%s', (input) =>
    expect(parseSubjectInput(input)).toBeUndefined(),
  );
});

describe('解析豆瓣评论 RSS', () => {
  const feed = parseDoubanFeed(FIXTURE, ID, DOUBAN_IMAGE_ORIGINS);
  const byId = (id: string) => feed.reviews.find((r) => r.id === id)!;

  it('条目信息：名字、类型、条目页、海报', () => {
    expect(feed.title).toBe('白衣逆行者');
    expect(feed.kind).toBe('电影');
    expect(feed.subjectUrl).toBe('https://movie.douban.com/subject/35299923/');
    expect(feed.posterUrl).toBe('https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2936741903.jpg');
  });

  it('按时间从新到旧，重复的评论只留一条，时间解析不了的排最后', () => {
    expect(feed.reviews.map((r) => r.id)).toEqual(['17866001', '17865935', '17865838', '17860199', 'plain-5']);
    expect(byId('plain-5').publishedAt).toBe(0);
  });

  it('紧凑写法的 Draft.js：取出正文开头，标注被截断；标题去掉"(评论: 条目)"', () => {
    const r = byId('17860199');
    expect(r).toMatchObject({ title: '太感动了，哭了好几次', excerpt: '几乎是哭着看完了全片', truncated: true, author: '测试用户甲' });
    expect(r.url).toBe('https://movie.douban.com/review/17860199/');
    expect(r.authorUrl).toBe('https://www.douban.com/people/1000001/');
    expect(r.rating).toBeUndefined();
  });

  it('\\u 转义断在中间：只保留完整的字', () => {
    const r = byId('17865838');
    expect(r.excerpt).toBe('期待上');
    expect(r.truncated).toBe(true);
    expect(r.rating).toBe('力荐');
    expect(ratingStars(r.rating)).toBe(5);
  });

  it('断在半个 emoji 上：去掉孤立的代理项，不留乱码', () => {
    const r = byId('17865935');
    expect(r.excerpt).toBe('送给你');
    expect(r.excerpt).not.toMatch(/[\ud800-\udfff�]/);
    expect(r.author).toBe('小狗🐶');
  });

  it('完整的多段正文：成对的 emoji 与引号还原，段落换行，不标截断', () => {
    const r = byId('17866001');
    expect(r.excerpt).toBe('第一段 😂\n第二段说得是“我们”');
    expect(r.truncated).toBe(false);
    expect(ratingStars(r.rating)).toBe(3);
  });

  it('非豆瓣 / 非 https 的链接与图片一律不用；作者名退回到描述第一行', () => {
    const r = byId('plain-5');
    expect(r.url).toBeUndefined();
    expect(r.authorUrl).toBeUndefined();
    expect(r.author).toBe('测试用户戊');
    expect(r.excerpt).toBe('节奏&剪辑都不错\n第二行');
    expect(r.truncated).toBe(true);
  });

  it('海报不在图片白名单里就不用', () => {
    expect(parseDoubanFeed(FIXTURE, ID, []).posterUrl).toBeUndefined();
  });

  it('没有评论的条目：返回空列表，条目名取自频道标题', () => {
    const empty = '<?xml version="1.0"?><rss version="2.0"><channel><title>关于某书的最新评论</title><link>https://book.douban.com/subject/1084336/reviews</link></channel></rss>';
    const f = parseDoubanFeed(empty, '1084336', DOUBAN_IMAGE_ORIGINS);
    expect(f).toMatchObject({ title: '某书', kind: '图书', subjectUrl: 'https://book.douban.com/subject/1084336/', reviews: [] });
  });

  it('不是 RSS（验证页、乱码）：报错，不当成"没有评论"', () => {
    expect(() => parseDoubanFeed('<!DOCTYPE html><html><body>请验证</body></html>', ID, [])).toThrow(DoubanFeedError);
    expect(() => parseDoubanFeed('<!DOCTYPE html><html><body>请验证</body></html>', ID, [])).toThrow(/验证页或登录页/);
    expect(() => parseDoubanFeed('garbage', ID, [])).toThrow(/不是 RSS/);
  });

  it('小工具：评价词与星级、全角括号标题、头像色相', () => {
    expect(ratingStars('★★★')).toBe(3);
    expect(ratingStars('很差')).toBe(1);
    expect(ratingStars('随便看看')).toBeUndefined();
    expect(ratingStars(undefined)).toBeUndefined();
    expect(splitReviewTitle('好书（书评：某书）')).toEqual({ title: '好书', subject: '某书' });
    expect(splitReviewTitle('没有后缀')).toEqual({ title: '没有后缀' });
    expect(hueOf('小狗🐶')).toBe(hueOf('小狗🐶'));
    expect(hueOf('小狗🐶')).toBeGreaterThanOrEqual(0);
    expect(hueOf('小狗🐶')).toBeLessThan(360);
    expect(parseDescription('甲评论: 乙\n评价: \n\n{"blocks":[{"key":"k","te...')).toEqual({ excerpt: '', truncated: true });
  });
});

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function setup(respond: (call: Call) => Response | Promise<Response> = () => new Response(FIXTURE, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } })) {
  const calls: Call[] = [];
  let now = NOW;
  const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  const auth: AuthProvider = { configured: () => true, getToken: async () => 'ya29.unused', invalidate: async () => {}, status: async () => 'connected', disconnect: async () => ({ revoked: false }) };
  const ctx: AppContext = { kv: memoryKV(), locker: memoryLocker(), http, now: () => now, auth, endpoints: ENDPOINTS, timeZone: 'Asia/Shanghai' };
  return { ctx, calls, setNow: (t: number) => (now = t) };
}

describe('豆瓣 RSS 服务层（mock fetch）', () => {
  it('首次使用预置示例条目；读取后缓存解析结果并补上条目名', async () => {
    const { ctx } = setup();
    const before = await stores.douban.read(ctx.kv);
    expect(before.subjects.map((s) => s.id)).toEqual(DOUBAN.defaultSubjects.map((s) => s.id));
    expect(await refreshDoubanFeed(ctx, ID)).toEqual({ cached: false });
    const after = await stores.douban.read(ctx.kv);
    expect(after.feeds[ID]!.fetchedAt).toBe(NOW);
    expect(after.feeds[ID]!.feed.reviews).toHaveLength(5);
    expect(after.subjects[0]!.title).toBe('白衣逆行者');
  });

  it('请求形态：只 GET www.douban.com 的 RSS 地址，不带 Cookie / Referer / 任何凭据，不跟随跳转', async () => {
    const { ctx, calls } = setup();
    await refreshDoubanFeed(ctx, ID);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://www.douban.com/feed/subject/35299923/reviews');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.credentials).toBe('omit');
    expect(init?.referrerPolicy).toBe('no-referrer');
    expect(init?.redirect).toBe('manual');
    const headers = new Headers(init?.headers);
    expect([...headers.keys()]).toEqual(['accept']);
  });

  it('缓存期内不再请求；手动刷新忽略缓存；过期后重新读取', async () => {
    const { ctx, calls, setNow } = setup();
    await refreshDoubanFeed(ctx, ID);
    expect(await refreshDoubanFeed(ctx, ID)).toEqual({ cached: true });
    expect(calls).toHaveLength(1);
    await refreshDoubanFeed(ctx, ID, { force: true });
    expect(calls).toHaveLength(2);
    setNow(NOW + 31 * 60_000);
    expect(await refreshDoubanFeed(ctx, ID)).toEqual({ cached: false });
    expect(calls).toHaveLength(3);
  });

  it('自动刷新与手动刷新撞在一起：只请求一次', async () => {
    const { ctx, calls } = setup();
    let t = NOW;
    const ticking: AppContext = { ...ctx, now: () => (t += 1) };
    const [a, b] = await Promise.all([refreshDoubanFeed(ticking, ID), refreshDoubanFeed(ticking, ID, { force: true })]);
    expect(calls).toHaveLength(1);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
  });

  it.each([
    [() => new Response('', { status: 418 }), /拒绝了这次请求（HTTP 418）/],
    [() => new Response('', { status: 429 }), /HTTP 429/],
    [() => new Response('', { status: 404 }), /没有这个条目/],
    [() => new Response('', { status: 500 }), /豆瓣出错（HTTP 500）/],
    [() => new Response(null, { status: 302, headers: { location: 'https://sec.douban.com/' } }), /转去了别的页面/],
    [() => new Response('<!DOCTYPE html><html><body>登录跳转</body></html>', { status: 200 }), /验证页或登录页/],
    [
      () => {
        throw new TypeError('Failed to fetch');
      },
      /无法连接豆瓣/,
    ],
  ])('失败用人话说明，且保留上一次读到的内容（%#）', async (fail, message) => {
    let failing = false;
    const ok = new Response(FIXTURE, { status: 200 });
    const { ctx, setNow } = setup(() => (failing ? fail() : ok.clone()));
    await refreshDoubanFeed(ctx, ID);
    failing = true;
    setNow(NOW + 60 * 60_000);
    await expect(refreshDoubanFeed(ctx, ID)).rejects.toMatchObject({ kind: 'douban', message: expect.stringMatching(message) });
    expect((await stores.douban.read(ctx.kv)).feeds[ID]!.fetchedAt).toBe(NOW);
  });

  it('在设置里关掉后不发请求', async () => {
    const { ctx, calls } = setup();
    await stores.settings.update(ctx.kv, ctx.locker, (s) => ({ ...s, douban: { ...s.douban, enabled: false } }));
    await expect(refreshDoubanFeed(ctx, ID)).rejects.toMatchObject({ kind: 'input' });
    expect(calls).toHaveLength(0);
  });

  it('订阅 / 取消订阅：粘贴链接即可；重复的只选中；认不出的提示怎么填；取消时删除缓存', async () => {
    const { ctx, calls } = setup();
    await refreshDoubanFeed(ctx, ID);
    expect(await addDoubanSubject(ctx, 'https://book.douban.com/subject/1084336/')).toBe('1084336');
    expect(await addDoubanSubject(ctx, '1084336')).toBe('1084336');
    let s = await stores.douban.read(ctx.kv);
    expect(s.subjects.map((x) => x.id)).toEqual([ID, '1084336']);
    expect(s.selected).toBe('1084336');
    await expect(addDoubanSubject(ctx, 'https://example.com/')).rejects.toMatchObject({ kind: 'input', message: '没认出豆瓣条目' });
    await removeDoubanSubject(ctx, '1084336');
    await removeDoubanSubject(ctx, ID);
    s = await stores.douban.read(ctx.kv);
    expect(s).toEqual({ subjects: [], feeds: {} });
    expect(calls).toHaveLength(1);
  });

  it(`最多订阅 ${DOUBAN.maxSubjects} 个`, async () => {
    const { ctx } = setup();
    for (let i = 1; i < DOUBAN.maxSubjects; i++) await addDoubanSubject(ctx, String(1_000_000 + i));
    await expect(addDoubanSubject(ctx, '2000000')).rejects.toMatchObject({ kind: 'input' });
  });

  it('订阅与读到的评论随"导出全部数据"一起导出', async () => {
    const { ctx } = setup();
    await refreshDoubanFeed(ctx, ID);
    const file = await exportAll(ctx);
    expect((file.data.douban as { feeds: Record<string, unknown> }).feeds[ID]).toBeDefined();
  });

  it(`跟随标签页读过的未订阅条目：缓存按条目分开，最多留 ${DOUBAN.transientFeedsKept} 份，订阅的不删`, async () => {
    const { ctx, calls, setNow } = setup();
    await refreshDoubanFeed(ctx, ID);
    const others = Array.from({ length: DOUBAN.transientFeedsKept + 2 }, (_, i) => String(37_322_580 + i));
    for (const [i, id] of others.entries()) {
      setNow(NOW + i * 1000);
      await refreshDoubanFeed(ctx, id);
    }
    expect(calls.map((c) => c.url.split('/')[5])).toEqual([ID, ...others]);
    const s = await stores.douban.read(ctx.kv);
    expect(Object.keys(s.feeds).sort()).toEqual([ID, ...others.slice(-DOUBAN.transientFeedsKept)].sort());
    expect(s.subjects.map((x) => x.id)).toEqual([ID]);
  });

  it('订阅一个已经读过（缓存里有）的条目：直接带上条目名，不再请求', async () => {
    const { ctx, calls } = setup();
    await refreshDoubanFeed(ctx, '37322586');
    await addDoubanSubject(ctx, '37322586');
    const s = await stores.douban.read(ctx.kv);
    expect(s.subjects.find((x) => x.id === '37322586')).toMatchObject({ title: '白衣逆行者' });
    expect(calls).toHaveLength(1);
  });
});

describe('跟随当前标签页：从标签页地址认出条目', () => {
  const BASE = 'https://www.douban.com';
  it.each([
    ['https://www.douban.com/feed/subject/37322586/reviews', '37322586'],
    ['https://www.douban.com/subject/37322586/', '37322586'],
    ['https://movie.douban.com/subject/37322586/reviews?start=20', '37322586'],
    ['http://127.0.0.1:47321/douban/feed/subject/37322586/reviews', undefined],
    ['https://www.douban.com/people/123456/', undefined],
    ['https://www.youtube.com/watch?v=abc', undefined],
    ['chrome://newtab/', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('%s → %s', (url, id) => expect(subjectFromTabUrl(url, BASE)).toBe(id));

  it('e2e：mock 的 RSS 地址也能被跟随', () => {
    expect(subjectFromTabUrl('http://127.0.0.1:47321/douban/feed/subject/37322586/reviews', 'http://127.0.0.1:47321/douban')).toBe('37322586');
    expect(subjectFromTabUrl('http://127.0.0.1:47321/watch?v=x', 'http://127.0.0.1:47321/douban')).toBeUndefined();
  });

  it('清理缓存：保留订阅的全部 + 最近读过的若干个未订阅条目', () => {
    const feeds = { a: { fetchedAt: 1 }, b: { fetchedAt: 5 }, c: { fetchedAt: 3 }, d: { fetchedAt: 4 }, sub: { fetchedAt: 0 } };
    expect(Object.keys(pruneTransientFeeds(feeds, ['sub'], 2)).sort()).toEqual(['b', 'd', 'sub']);
    expect(Object.keys(pruneTransientFeeds(feeds, ['a', 'b', 'c', 'd', 'sub'], 0)).sort()).toEqual(['a', 'b', 'c', 'd', 'sub']);
  });
});
