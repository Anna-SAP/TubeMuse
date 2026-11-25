// B站（DECISIONS §92）："接下来播放"列表的发布时间（显示格式、本机缓存、向 B 站接口查的那一层）与收藏 / 标签。
import { afterEach, describe, expect, it } from 'vitest';
import { BILI, DEFAULT_SETTINGS } from '../../src/config/defaults';
import { ENDPOINTS } from '../../src/config/endpoints';
import {
  BiliApiError,
  applyBiliOp,
  biliPubdateHint,
  biliTagCounts,
  biliVideoFromUrl,
  emptyBiliState,
  filterBili,
  formatBiliPubdate,
  isBvid,
  mergePubdateCache,
  parseBiliDuration,
  parseBiliOp,
  parseCardsResponse,
  pubdatesFromCache,
  sanitizeBiliState,
  sanitizeBvids,
  sanitizePubdateCache,
  suggestBiliTags,
  type BiliOp,
  type BiliState,
} from '../../src/core/bili';
import { applyBili, applyBiliFromPage, lookupBiliPubdates, resetBiliPubdateState } from '../../src/services/bili-service';
import type { AppContext } from '../../src/services/context';
import { stores } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';

const NOW = Date.parse('2026-11-25T08:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-11-25 在 B 站视频页上实测的推荐视频
const BV1 = 'BV1Ud436mEjX';
const BV2 = 'BV1rny8zjEVu';
const BV3 = 'BV1Yeuj64E5f';
const PAGE = `https://www.bilibili.com/zh-Hans/video/${BV3}/?spm_id_from=333.788.recommend_more_video.0&trackid=web_related_0.router-related-2479604-tdxs9.1795610565536.123`;

function op(raw: unknown, fromPage = true): BiliOp {
  const o = parseBiliOp(raw, NOW, fromPage);
  if (!o) throw new Error(`操作没通过校验：${JSON.stringify(raw)}`);
  return o;
}

function apply(state: BiliState, raw: unknown, fromPage = true): BiliState {
  const r = applyBiliOp(state, op(raw, fromPage), NOW);
  if (r.error) throw new Error(r.error);
  return r.state;
}

describe('B站：视频链接', () => {
  it('推荐卡片上的链接 → BV 号与规范链接（去掉语言、来源统计参数；分 P 的留 ?p=）', () => {
    expect(biliVideoFromUrl(PAGE)).toEqual({ bvid: BV3, url: `https://www.bilibili.com/video/${BV3}/` });
    expect(biliVideoFromUrl(`https://www.bilibili.com/video/${BV1}/?p=3&spm_id_from=333.788.videopod.episodes`)).toEqual({ bvid: BV1, url: `https://www.bilibili.com/video/${BV1}/?p=3` });
    expect(biliVideoFromUrl(`https://www.bilibili.com/list/watchlater?bvid=${BV2}&oid=1`)?.bvid).toBe(BV2);
  });

  it('番剧、av 号、直播、空间、别的网站都不认', () => {
    for (const bad of [
      'https://www.bilibili.com/bangumi/play/ep733317',
      'https://www.bilibili.com/video/av170001',
      'https://live.bilibili.com/123',
      'https://space.bilibili.com/519033438/',
      `https://www.bilibili.com.evil.example/video/${BV1}/`,
      `http://www.bilibili.com/video/${BV1}/`,
      'not a url',
    ])
      expect(biliVideoFromUrl(bad), bad).toBeUndefined();
    expect(isBvid(BV1)).toBe(true);
    expect(isBvid('BV1Ud436mEj')).toBe(false);
    expect(isBvid('bv1Ud436mEjX')).toBe(false);
  });
});

describe('B站：发布时间的显示', () => {
  const tz = 'Asia/Shanghai';
  it('30 天之内写"多久以前"，再早的写日期；放不下时去掉年份的前两位', () => {
    expect(formatBiliPubdate(NOW - 20_000, NOW, tz)).toBe('1分钟前');
    expect(formatBiliPubdate(NOW - 40 * 60_000, NOW, tz)).toBe('40分钟前');
    expect(formatBiliPubdate(NOW - 3 * HOUR - 5 * 60_000, NOW, tz)).toBe('3小时前');
    expect(formatBiliPubdate(NOW - 2 * DAY - 3 * HOUR, NOW, tz)).toBe('2天前');
    expect(formatBiliPubdate(NOW - 29 * DAY, NOW, tz)).toBe('29天前');
    expect(formatBiliPubdate(Date.parse('2022-07-27T04:00:00Z'), NOW, tz)).toBe('2022-07-27');
    expect(formatBiliPubdate(Date.parse('2022-07-27T04:00:00Z'), NOW, tz, true)).toBe('22-07-27');
    // 按你所在的时区：北京时间 7 月 27 日凌晨发布的，在洛杉矶还是 26 日
    expect(formatBiliPubdate(Date.parse('2022-07-26T17:00:00Z'), NOW, tz)).toBe('2022-07-27');
    expect(formatBiliPubdate(Date.parse('2022-07-26T17:00:00Z'), NOW, 'America/Los_Angeles')).toBe('2022-07-26');
    // 时钟有偏差、发布时间比"现在"还晚一点：不写负数
    expect(formatBiliPubdate(NOW + 60_000, NOW, tz)).toBe('1分钟前');
  });

  it('悬停提示：精确到分钟的时间与"多久以前"', () => {
    expect(biliPubdateHint(Date.parse('2024-10-11T04:00:00Z'), NOW, 'Asia/Shanghai')).toBe('发布于 2024/10/11 12:00（2 年前）· TubeMuse');
  });
});

describe('B站：发布时间的接口回答与本机缓存', () => {
  const reply = (data: Record<string, unknown>, code = 0) => ({ code, message: code ? String(code) : 'OK', ttl: 1, data });

  it('只取问到的那些的 pubdate（秒 → 毫秒）；没出现的、时间不合理的、BV 号对不上的都算"接口里没有"', () => {
    const r = parseCardsResponse(
      reply({
        [BV1]: { bvid: BV1, pubdate: 1728619200 },
        [BV2]: { bvid: BV2, pubdate: 0 },
        [BV3]: { bvid: BV2, pubdate: 1728619200 },
        BV1xxxxxxxxx: { bvid: 'BV1xxxxxxxxx', pubdate: 1728619200 },
      }),
      [BV1, BV2, BV3, 'BV1Gone00000'],
      NOW,
    );
    expect(r).toEqual({ times: { [BV1]: 1728619200_000 }, absent: [BV2, BV3, 'BV1Gone00000'] });
  });

  it('B 站拒绝 / 风控：-412、-352 要退避，别的错误码不退避；格式不对也报错', () => {
    for (const code of [-412, -352, -509, -799]) {
      const e = (() => {
        try {
          parseCardsResponse(reply({}, code), [BV1], NOW);
        } catch (err) {
          return err;
        }
      })();
      expect(e).toBeInstanceOf(BiliApiError);
      expect((e as BiliApiError).blocked).toBe(true);
      expect((e as BiliApiError).message).toContain('拦下');
    }
    expect(() => parseCardsResponse(reply({}, -404), [BV1], NOW)).toThrow(/B 站接口出错/);
    expect(() => parseCardsResponse('<html>', [BV1], NOW)).toThrow(/看不懂/);
  });

  it('本机缓存：查到过的直接用；接口里没有的过一天再查；没查过的要查', () => {
    const cache = { [BV1]: { t: 1, at: NOW - 10 * DAY }, [BV2]: { t: 0, at: NOW - HOUR }, [BV3]: { t: 0, at: NOW - BILI.absentRetryMs - 1 } };
    expect(pubdatesFromCache(cache, [BV1, BV2, BV3, 'BV1Gone00000'], NOW)).toEqual({ known: { [BV1]: 1 }, absent: [BV2], missing: [BV3, 'BV1Gone00000'] });
  });

  it('记进本机：满了先丢最早查的；读出来时坏的丢掉', () => {
    const cache = mergePubdateCache({ [BV1]: { t: 1, at: NOW - 3 } }, { [BV2]: 2_000_000_000_000 }, [BV3], NOW - 1, 2);
    expect(Object.keys(cache).sort()).toEqual([BV2, BV3].sort());
    expect(cache[BV3]).toEqual({ t: 0, at: NOW - 1 });
    expect(sanitizePubdateCache({ [BV1]: { t: 1728619200_000, at: NOW }, [BV2]: { t: 5, at: NOW }, 'not-a-bv': { t: 1728619200_000, at: NOW }, [BV3]: { t: 0, at: 'x' } }, NOW)).toEqual({
      [BV1]: { t: 1728619200_000, at: NOW },
    });
  });

  it('页面问的 ID 当不可信输入：只留 BV 号、去重、限量', () => {
    expect(sanitizeBvids([BV1, BV1, 'x', 3, BV2])).toEqual([BV1, BV2]);
    expect(sanitizeBvids('BV1Ud436mEjX')).toEqual([]);
    expect(sanitizeBvids(Array.from({ length: 200 }, (_, i) => `BV1${String(i).padStart(9, '0')}`))).toHaveLength(BILI.maxIdsPerAsk);
  });
});

describe('B站：向 B 站接口查发布时间（mock fetch）', () => {
  afterEach(() => resetBiliPubdateState());

  function setup(respond: (ids: string[]) => Response, showPubdate = true) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    let now = NOW;
    const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return respond(new URL(String(input)).searchParams.get('ids')!.split(','));
    }) as typeof fetch;
    const ctx = { kv: memoryKV(), locker: memoryLocker(), http, now: () => now, endpoints: ENDPOINTS, timeZone: 'Asia/Shanghai' } as unknown as AppContext;
    const ready = stores.settings.write(ctx.kv, { ...DEFAULT_SETTINGS, bili: { ...DEFAULT_SETTINGS.bili, showPubdate } } as never);
    return { ctx, calls, ready, tick: (ms: number) => (now += ms) };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const known: Record<string, number> = { [BV1]: 1728619200, [BV2]: 1658894400 };
  const ok = (ids: string[]) => json({ code: 0, message: 'OK', data: Object.fromEntries(ids.filter((id) => known[id]).map((id) => [id, { bvid: id, pubdate: known[id] }])) });

  it('没勾选"显示发布时间"：不查，照实说', async () => {
    const { ctx, calls, ready } = setup(ok, false);
    await ready;
    expect(await lookupBiliPubdates(ctx, [BV1])).toEqual({ ok: false, times: {}, error: '"显示发布时间"没有勾选', off: true });
    expect(calls).toHaveLength(0);
  });

  it('一次查完；只发 BV 号，不带 Cookie、不带 Referer；查过的（包括"接口里没有"的）记在本机，不再查', async () => {
    const { ctx, calls, ready } = setup(ok);
    await ready;
    const r = await lookupBiliPubdates(ctx, [BV1, BV2, 'BV1Gone00000', 'javascript:alert(1)']);
    expect(r).toEqual({ ok: true, times: { [BV1]: known[BV1]! * 1000, [BV2]: known[BV2]! * 1000 }, absent: ['BV1Gone00000'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${ENDPOINTS.biliApi}/x/article/cards?ids=${BV1},${BV2},BV1Gone00000`);
    expect(calls[0]!.init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(Object.keys((calls[0]!.init?.headers ?? {}) as object).map((k) => k.toLowerCase())).not.toContain('cookie');
    const again = await lookupBiliPubdates(ctx, [BV1, 'BV1Gone00000']);
    expect(again).toEqual({ ok: true, times: { [BV1]: known[BV1]! * 1000 }, absent: ['BV1Gone00000'] });
    expect(calls).toHaveLength(1);
    expect((await stores.biliPubdates.read(ctx.kv))['BV1Gone00000']).toEqual({ t: 0, at: NOW });
  });

  it('多于一批时分几次查（每次最多 BILI.cardsBatch 个）', async () => {
    const { ctx, calls, ready } = setup(ok);
    await ready;
    const ids = Array.from({ length: BILI.cardsBatch + 5 }, (_, i) => `BV1${String(i).padStart(9, '0')}`);
    const r = await lookupBiliPubdates(ctx, ids);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => new URL(c.url).searchParams.get('ids')!.split(',').length)).toEqual([BILI.cardsBatch, 5]);
  }, 10_000);

  it('被 B 站拦了（-352 / HTTP 412 / 网页）：照实说明，退避期间不再发请求，过了再查', async () => {
    for (const blocked of [json({ code: -352, message: '-352' }), json({}, 412), new Response('<!DOCTYPE html><title>出错啦! - bilibili.com</title>', { status: 200 })]) {
      resetBiliPubdateState();
      const { ctx, calls, ready, tick } = setup(() => blocked.clone());
      await ready;
      const r = await lookupBiliPubdates(ctx, [BV1]);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toMatch(/拦下|网页/);
      expect(r.ok === false && r.error).toContain('分钟后再查');
      expect(await lookupBiliPubdates(ctx, [BV1])).toMatchObject({ ok: false, times: {} });
      expect(calls).toHaveLength(1);
      tick(BILI.backoffMs + 1);
      await lookupBiliPubdates(ctx, [BV1]);
      expect(calls).toHaveLength(2);
    }
  });

  it('网络断了：说明连不上，同样退避；已经知道的照样给', async () => {
    const { ctx, ready } = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    await ready;
    await stores.biliPubdates.write(ctx.kv, { [BV1]: { t: 1728619200_000, at: NOW }, BV1Gone00000: { t: 0, at: NOW } });
    const r = await lookupBiliPubdates(ctx, [BV1, BV2, 'BV1Gone00000']);
    // 已经知道"接口里查不到"的那个也照样给：页面上它仍写"时间未知"，不被当成没查成
    expect(r).toMatchObject({ ok: false, times: { [BV1]: 1728619200_000 }, absent: ['BV1Gone00000'] });
    expect(r.ok === false && r.error).toContain('连不上 B 站的接口');
  });
});

describe('B站：收藏与标签', () => {
  const video = { bvid: BV3, title: '假如三体人不吃压力……', url: PAGE, upName: '铭明mk', upMid: '289080082', publishedAt: Date.parse('2026-08-09T02:58:42Z'), duration: '01:54' };

  it('加标签即收藏：链接规范化、时长从"01:54"换成秒；再收藏一次保留收藏时间与标签、没读到的项不丢', () => {
    let s = apply(emptyBiliState(), { op: 'save', video, tags: ['#三体', '科幻', '科幻'] });
    expect(s.videos[BV3]).toEqual({ ...video, url: `https://www.bilibili.com/video/${BV3}/`, duration: 114, savedAt: NOW, tags: ['三体', '科幻'] });
    s = applyBiliOp(s, op({ op: 'save', video: { bvid: BV3, title: '新标题', url: PAGE }, tags: [] }), NOW + 1000).state;
    expect(s.videos[BV3]).toMatchObject({ title: '新标题', upName: '铭明mk', upMid: '289080082', duration: 114, savedAt: NOW, tags: ['三体', '科幻'] });
  });

  it('页面发来的内容当不可信输入：BV 号要和链接对得上、链接要是 B 站视频页；页面只能收藏 / 移出 / 加减标签', () => {
    expect(parseBiliOp({ op: 'save', video: { ...video, bvid: BV1 } }, NOW, true)).toBeUndefined();
    expect(parseBiliOp({ op: 'save', video: { ...video, url: `https://evil.example/video/${BV3}/` } }, NOW, true)).toBeUndefined();
    expect(parseBiliOp({ op: 'save', video: { ...video, url: 'https://www.bilibili.com/bangumi/play/ep1' } }, NOW, true)).toBeUndefined();
    for (const o of ['renameTag', 'deleteTag', 'restore']) expect(parseBiliOp({ op: o, from: 'a', to: 'b', tag: 'a', item: {} }, NOW, true)).toBeUndefined();
    const s = op({ op: 'save', video: { ...video, title: 'x'.repeat(500), upName: '\u0000UP\n主', upMid: '12ab', publishedAt: NOW + 10 * DAY, duration: '99:99' }, tags: [] }) as Extract<BiliOp, { op: 'save' }>;
    expect(s.video.title).toHaveLength(BILI.titleMaxChars);
    expect(s.video.upName).toBe('UP 主');
    expect(s.video).not.toHaveProperty('upMid');
    expect(s.video).not.toHaveProperty('publishedAt');
    expect(s.video).not.toHaveProperty('duration');
  });

  it('时长：页面上的写法与秒数', () => {
    expect(parseBiliDuration('77:32:35')).toBe(279155);
    expect(parseBiliDuration('5:51:05')).toBe(21065);
    expect(parseBiliDuration('01:54')).toBe(114);
    expect(parseBiliDuration(' 00:36 ')).toBe(36);
    expect(parseBiliDuration(11661)).toBe(11661);
    for (const bad of ['', '1:2', '01:60', 'abc', 0, -5, 1.5, BILI.maxDurationSec + 1]) expect(parseBiliDuration(bad), String(bad)).toBeUndefined();
  });

  it('加减标签、上限、移出与撤销、改名合并与删除', () => {
    let s = apply(emptyBiliState(), { op: 'save', video, tags: ['三体'] });
    s = apply(s, { op: 'save', video: { bvid: BV1, title: '科幻小说《三体》三部全集', url: `https://www.bilibili.com/video/${BV1}/` }, tags: ['有声书', '三体'] });
    s = apply(s, { op: 'tags', bvid: BV3, add: ['AI'], remove: ['三体'] });
    expect(s.videos[BV3]!.tags).toEqual(['AI']);
    expect(applyBiliOp(s, op({ op: 'tags', bvid: BV3, add: Array.from({ length: 25 }, (_, i) => `t${i}`), remove: [] }), NOW).error).toContain('最多');
    expect(applyBiliOp(s, op({ op: 'tags', bvid: BV2, add: ['x'], remove: [] }), NOW).error).toContain('不在收藏里');
    s = apply(s, { op: 'renameTag', from: '有声书', to: 'ai' }, false);
    expect(s.videos[BV1]!.tags).toEqual(['ai', '三体']);
    s = apply(s, { op: 'deleteTag', tag: '三体' }, false);
    expect(s.videos[BV1]!.tags).toEqual(['ai']);
    const item = s.videos[BV1]!;
    s = apply(s, { op: 'remove', bvid: BV1 });
    expect(s.videos[BV1]).toBeUndefined();
    s = apply(s, { op: 'restore', item }, false);
    expect(s.videos[BV1]).toEqual(item);
  });

  it('筛选、常用标签、读出存储时丢掉坏数据', () => {
    let s = apply(emptyBiliState(), { op: 'save', video, tags: ['三体', '科幻'] });
    s = applyBiliOp(s, op({ op: 'save', video: { bvid: BV1, title: '有声书', url: `https://www.bilibili.com/video/${BV1}/`, upName: '考拉有声书' }, tags: ['三体'] }), NOW + 1).state;
    expect(filterBili(s, {}).map((v) => v.bvid)).toEqual([BV1, BV3]);
    expect(filterBili(s, { tag: '科幻' }).map((v) => v.bvid)).toEqual([BV3]);
    expect(filterBili(s, { q: '考拉' }).map((v) => v.bvid)).toEqual([BV1]);
    expect(filterBili(s, { q: BV3.toLowerCase() }).map((v) => v.bvid)).toEqual([BV3]);
    expect(biliTagCounts(s)).toEqual([
      { tag: '三体', count: 2 },
      { tag: '科幻', count: 1 },
    ]);
    expect(suggestBiliTags(s, ['三体'])).toEqual(['科幻']);
    const raw = { videos: { ...s.videos, bad: { bvid: 'nope', url: 'x', savedAt: 1, tags: [] }, [BV2]: { bvid: BV2, url: `https://www.bilibili.com/video/${BV2}/`, title: 't', tags: [] } } };
    expect(Object.keys(sanitizeBiliState(raw, NOW).videos).sort()).toEqual([BV1, BV3].sort());
    expect(sanitizeBiliState('garbage', NOW)).toEqual({ videos: {} });
  });

  it('写入经服务层：页面发来的不合格就不写，并说明原因；上限', async () => {
    const ctx = { kv: memoryKV(), locker: memoryLocker(), now: () => NOW } as unknown as AppContext;
    expect(await applyBiliFromPage(ctx, { op: 'renameTag', from: 'a', to: 'b' })).toEqual({ ok: false, error: expect.stringContaining('没有保存') });
    expect(await applyBiliFromPage(ctx, { op: 'save', video, tags: ['三体'] })).toEqual({ ok: true });
    expect((await stores.bili.read(ctx.kv)).videos[BV3]?.tags).toEqual(['三体']);
    const full: BiliState = { videos: {} };
    for (let i = 0; i < BILI.maxItems; i++) {
      const bv = `BV1${String(i).padStart(9, '0')}`;
      full.videos[bv] = { bvid: bv, title: '', url: `https://www.bilibili.com/video/${bv}/`, savedAt: 1, tags: [] };
    }
    await stores.bili.write(ctx.kv, full);
    expect(await applyBili(ctx, op({ op: 'save', video, tags: [] }))).toEqual({ ok: false, error: expect.stringContaining(`已满 ${BILI.maxItems}`) });
  });
});
