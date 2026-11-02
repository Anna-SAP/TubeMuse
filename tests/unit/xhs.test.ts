import { describe, expect, it } from 'vitest';
import { XHS } from '../../src/config/defaults';
import {
  applyXhsOp,
  canonicalXhsUrl,
  cardTime,
  emptyXhsState,
  filterXhs,
  formatXhsTime,
  indexTimes,
  normalizeTag,
  parseXhsOp,
  parseXhsPath,
  parseXhsUrl,
  sanitizeTimeEntries,
  sanitizeXhsState,
  splitTags,
  suggestTags,
  tagCounts,
  timeFromNoteId,
  xhsPageKind,
  type XhsOp,
  type XhsState,
} from '../../src/core/xhs';
import { applyXhs, applyXhsFromPage } from '../../src/services/xhs-service';
import { stores } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';
import type { AppContext } from '../../src/services/context';

const NOW = Date.parse('2026-11-03T08:00:00Z');
const UID = '67398f95000000001d02d725';
// 2026-11-03 在小红书网页版实测的笔记：ID 推算的时间与页面数据里的发布时间（time）
const SAME = { id: '6ae12de4000000003401f5b2', time: Date.parse('2026-10-27T23:04:04Z') };
const LATER = { id: '691d6e07000000001d03be5e', idTime: Date.parse('2025-11-19T07:13:11Z'), time: Date.parse('2025-11-19T09:10:02Z') };
const NOTE_URL = `https://www.xiaohongshu.com/user/profile/${UID}/${SAME.id}?xsec_token=ABhu_Cqz8_LewlXka4tu0sheGu21UZwBNY12wBlokCyfM=&xsec_source=pc_user&channel_type=web_user_page`;

function op(raw: unknown, fromPage = true): XhsOp {
  const o = parseXhsOp(raw, NOW, fromPage);
  if (!o) throw new Error(`操作没通过校验：${JSON.stringify(raw)}`);
  return o;
}

function run(state: XhsState, ...raws: unknown[]): XhsState {
  return raws.reduce<XhsState>((s, raw) => {
    const r = applyXhsOp(s, op(raw, false), NOW);
    if (r.error) throw new Error(r.error);
    return r.state;
  }, state);
}

const saveNote = (id = SAME.id, tags: string[] = [], extra: Record<string, unknown> = {}) => ({
  op: 'saveNote',
  note: { id, title: '毛不易 田曦薇 李诞都在看的书', url: `https://www.xiaohongshu.com/explore/${id}?xsec_token=abc`, authorId: UID, authorName: '李诞小卖部', ...extra },
  tags,
});
const saveUser = (tags: string[] = []) => ({ op: 'saveUser', user: { id: UID, name: '李诞小卖部', url: `https://www.xiaohongshu.com/user/profile/${UID}?channel_type=web_user_page` }, tags });

describe('小红书：发布时间', () => {
  it('笔记 ID 前 8 位是创建时刻（与实测的页面数据一致）', () => {
    expect(timeFromNoteId(SAME.id, NOW)).toBe(SAME.time);
    expect(timeFromNoteId(LATER.id, NOW)).toBe(LATER.idTime);
    // 用户 ID 也是同样的格式（截图里那位博主 2024-11-17 注册）
    expect(new Date(timeFromNoteId(UID, NOW)!).toISOString()).toBe('2024-11-17T06:39:17.000Z');
  });

  it('不是 24 位小写十六进制、或时刻不合理的不认', () => {
    for (const bad of ['', '6ae12de4', '6AE12DE4000000003401F5B2', 'zzz12de4000000003401f5b2', '6ae12de4000000003401f5b2x']) expect(timeFromNoteId(bad, NOW)).toBeUndefined();
    expect(timeFromNoteId('00000001000000003401f5b2', NOW)).toBeUndefined(); // 1970 年
    expect(timeFromNoteId('7fffffff000000003401f5b2', NOW)).toBeUndefined(); // 2038 年，在未来
    expect(timeFromNoteId(XHS.idTimeMin / 1000 === 1356998400 ? '50e22700000000003401f5b2' : '', NOW)).toBe(XHS.idTimeMin);
  });

  it('页面数据的发布时间优先；没有时用 ID 推算并标 ≈；未登录时按位置 + 标题对上', () => {
    const times = indexTimes(
      sanitizeTimeEntries(
        [
          { id: LATER.id, time: LATER.time },
          { index: 3, title: '再也不用代购了，真的太好吃！', time: SAME.time },
        ],
        NOW,
      ),
    );
    expect(cardTime({ noteId: LATER.id, title: 'x' }, times, NOW)).toEqual({ at: LATER.time, source: 'page' });
    expect(cardTime({ noteId: SAME.id, title: 'x' }, times, NOW)).toEqual({ at: SAME.time, source: 'id' });
    // 未登录：卡片上没有笔记 ID，标题里的空白差异不影响
    expect(cardTime({ index: 3, title: ' 再也不用代购了，真的太好吃！ ' }, times, NOW)).toEqual({ at: SAME.time, source: 'page' });
    expect(cardTime({ index: 4, title: '再也不用代购了，真的太好吃！' }, times, NOW)).toBeUndefined();
    expect(cardTime({ index: 3, title: '' }, times, NOW)).toBeUndefined();
  });

  it('同一位置 + 标题对上两个不同时间：宁可不显示也不显示错的', () => {
    const times = indexTimes([
      { index: 0, title: '同名笔记', time: SAME.time },
      { index: 0, title: '同名笔记', time: LATER.time },
      { index: 1, title: '重复但一致', time: SAME.time },
      { index: 1, title: '重复但一致', time: SAME.time },
    ]);
    expect(cardTime({ index: 0, title: '同名笔记' }, times, NOW)).toBeUndefined();
    expect(cardTime({ index: 1, title: '重复但一致' }, times, NOW)).toEqual({ at: SAME.time, source: 'page' });
  });

  it('页面内助手的回答逐项校验（页面能伪造消息）', () => {
    const entries = sanitizeTimeEntries(
      [
        { id: SAME.id, time: SAME.time, index: 2, title: 'ok' },
        { id: 'not-an-id', time: SAME.time },
        { id: SAME.id, time: 'yesterday' },
        { time: NOW + 10 * 24 * 3_600_000 },
        { time: SAME.time, index: -1, title: 'x'.repeat(500) },
        null,
        'x',
      ],
      NOW,
    );
    expect(entries).toEqual([
      { id: SAME.id, time: SAME.time, index: 2, title: 'ok' },
      { time: SAME.time },
      { time: SAME.time, title: 'x'.repeat(XHS.titleMaxChars) },
    ]);
    expect(sanitizeTimeEntries({ length: 3 }, NOW)).toEqual([]);
  });

  it('显示格式：本地时区 YYYY/MM/DD HH:mm，由 ID 推算的加 ≈', () => {
    expect(formatXhsTime(SAME.time, 'page', 'Asia/Shanghai')).toBe('2026/10/28 07:04');
    expect(formatXhsTime(LATER.idTime, 'id', 'Asia/Shanghai')).toBe('≈2025/11/19 15:13');
    expect(formatXhsTime(SAME.time, 'page', 'America/Los_Angeles')).toBe('2026/10/27 16:04');
  });
});

describe('小红书：站内链接', () => {
  it('认出笔记与博主（含国际域名 rednote.com）', () => {
    expect(parseXhsPath(`/explore/${SAME.id}`)).toEqual({ kind: 'note', noteId: SAME.id });
    expect(parseXhsPath(`/discovery/item/${SAME.id}`)).toEqual({ kind: 'note', noteId: SAME.id });
    expect(parseXhsPath(`/search_result/${SAME.id}`)).toEqual({ kind: 'note', noteId: SAME.id });
    expect(parseXhsPath(`/user/profile/${UID}/${SAME.id}`)).toEqual({ kind: 'note', noteId: SAME.id, userId: UID });
    expect(parseXhsPath(`/user/profile/${UID}`)).toEqual({ kind: 'user', userId: UID });
    // 未登录时卡片里的隐藏链接没有笔记 ID：只是博主主页
    expect(parseXhsPath(`/user/profile/${UID}/`)).toEqual({ kind: 'user', userId: UID });
    expect(parseXhsUrl(`https://www.rednote.com/discovery/item/${SAME.id}?xsec_token=x`)).toEqual({ kind: 'note', noteId: SAME.id });
    for (const bad of ['/explore', '/explore/123', `/user/profile/${UID}/board`, `/explore/${SAME.id}/comments`]) expect(parseXhsPath(bad)).toBeUndefined();
    for (const bad of [`https://evil.example/explore/${SAME.id}`, `http://www.xiaohongshu.com/explore/${SAME.id}`, `https://www.xiaohongshu.com.evil.example/explore/${SAME.id}`, 'javascript:alert(1)', 'not a url'])
      expect(parseXhsUrl(bad)).toBeUndefined();
  });

  it('收藏里的链接只留 xsec_token / xsec_source（打开笔记要带 xsec_token），去掉统计参数', () => {
    expect(canonicalXhsUrl(NOTE_URL)).toEqual({
      url: `https://www.xiaohongshu.com/user/profile/${UID}/${SAME.id}?xsec_token=ABhu_Cqz8_LewlXka4tu0sheGu21UZwBNY12wBlokCyfM%3D&xsec_source=pc_user`,
      link: { kind: 'note', noteId: SAME.id, userId: UID },
    });
    // 空的 xsec_token（未登录时博主链接里就是空的）不留
    expect(canonicalXhsUrl(`https://www.rednote.com/user/profile/${UID}?channel_type=web_user_page&xsec_token=&xsec_source=pc_note`)?.url).toBe(
      `https://www.rednote.com/user/profile/${UID}?xsec_source=pc_note`,
    );
    expect(canonicalXhsUrl('https://www.xiaohongshu.com/explore')).toBeUndefined();
  });

  it('页面类型：博主主页、笔记详情、首页 / 搜索、其他', () => {
    expect(xhsPageKind(`https://www.xiaohongshu.com/user/profile/${UID}?xsec_token=x`)).toBe('profile');
    expect(xhsPageKind(`https://www.xiaohongshu.com/explore/${SAME.id}`)).toBe('note');
    expect(xhsPageKind('https://www.xiaohongshu.com/explore?channel_id=homefeed_recommend')).toBe('feed');
    expect(xhsPageKind('https://www.xiaohongshu.com/search_result?keyword=咖啡')).toBe('feed');
    expect(xhsPageKind('https://www.rednote.com/')).toBe('feed');
    expect(xhsPageKind('https://www.xiaohongshu.com/notification')).toBe('other');
    expect(xhsPageKind('https://www.youtube.com/')).toBe('other');
  });
});

describe('小红书：标签', () => {
  it('去掉 #、合并空白、限长；空的不要', () => {
    expect(normalizeTag('  #AI  安全 ')).toBe('AI 安全');
    expect(normalizeTag('＃书单')).toBe('书单');
    expect(normalizeTag('#')).toBeUndefined();
    expect(normalizeTag('   ')).toBeUndefined();
    expect(normalizeTag(42)).toBeUndefined();
    expect(Array.from(normalizeTag('长'.repeat(50))!).length).toBe(XHS.maxTagChars);
    // 限长按字（含 emoji）而不是 UTF-16 码元，不劈开 emoji
    expect(normalizeTag('☕'.repeat(30))).toBe('☕'.repeat(XHS.maxTagChars));
  });

  it('一次写好几个：逗号、顿号、分号、换行分开，空格不分', () => {
    expect(splitTags('学习, 咖啡，书单、AI 安全；#零食\n')).toEqual(['学习', '咖啡', '书单', 'AI 安全', '零食']);
  });
});

describe('小红书：收藏与标签操作', () => {
  it('收藏笔记带标签；再加、去掉；不分大小写去重', () => {
    let s = run(emptyXhsState(), saveNote(SAME.id, ['书单', 'AI']));
    expect(s.notes[SAME.id]).toMatchObject({ title: '毛不易 田曦薇 李诞都在看的书', authorId: UID, authorName: '李诞小卖部', savedAt: NOW, tags: ['书单', 'AI'] });
    expect(s.notes[SAME.id]!.url).toBe(`https://www.xiaohongshu.com/explore/${SAME.id}?xsec_token=abc`);
    s = run(s, { op: 'tags', kind: 'note', id: SAME.id, add: ['ai', '咖啡'], remove: ['书单'] });
    expect(s.notes[SAME.id]!.tags).toEqual(['AI', '咖啡']);
  });

  it('再次收藏同一篇：更新标题，保留收藏时间与标签，时间只升级不降级', () => {
    let s = run(emptyXhsState(), saveNote(SAME.id, ['书单'], { publishedAt: SAME.time, timeSource: 'page' }));
    s = applyXhsOp(s, op(saveNote(SAME.id, ['新'], { title: '改过的标题', publishedAt: SAME.time - 5000, timeSource: 'id' })), NOW + 1000).state;
    expect(s.notes[SAME.id]).toMatchObject({ title: '改过的标题', savedAt: NOW, publishedAt: SAME.time, timeSource: 'page', tags: ['书单', '新'] });
    // 读不到标题（空）时保留原来的
    s = run(s, saveNote(SAME.id, [], { title: '' }));
    expect(s.notes[SAME.id]!.title).toBe('改过的标题');
    // 先是 ID 推算的时间，后来在页面数据里读到了发布时间：升级
    s = run(emptyXhsState(), saveNote(LATER.id, [], { publishedAt: LATER.idTime, timeSource: 'id' }), saveNote(LATER.id, [], { publishedAt: LATER.time, timeSource: 'page' }));
    expect(s.notes[LATER.id]).toMatchObject({ publishedAt: LATER.time, timeSource: 'page' });
  });

  it('博主：收藏、打标签、移出', () => {
    let s = run(emptyXhsState(), saveUser(['零食']));
    expect(s.users[UID]).toEqual({ id: UID, name: '李诞小卖部', url: `https://www.xiaohongshu.com/user/profile/${UID}`, savedAt: NOW, tags: ['零食'] });
    s = run(s, { op: 'remove', kind: 'user', id: UID });
    expect(s.users).toEqual({});
  });

  it('上限：每条最多 maxTagsPerItem 个标签；超出时不改动并说明', () => {
    const many = Array.from({ length: XHS.maxTagsPerItem }, (_, i) => `t${i}`);
    const s = run(emptyXhsState(), saveNote(SAME.id, many));
    const r = applyXhsOp(s, op({ op: 'tags', kind: 'note', id: SAME.id, add: ['one-more'], remove: [] }), NOW);
    expect(r.error).toContain(`${XHS.maxTagsPerItem}`);
    expect(r.state).toBe(s);
    expect(applyXhsOp(s, op({ op: 'tags', kind: 'note', id: LATER.id, add: ['x'], remove: [] }), NOW).error).toContain('不在收藏里');
  });

  it('改名（新名字已有时合并）、删除标签：笔记与博主一起改', () => {
    let s = run(emptyXhsState(), saveNote(SAME.id, ['AI', '书单']), saveNote(LATER.id, ['ai 安全', 'AI']), saveUser(['AI']));
    s = run(s, { op: 'renameTag', from: 'ai', to: '人工智能' });
    expect(s.notes[SAME.id]!.tags).toEqual(['人工智能', '书单']);
    expect(s.notes[LATER.id]!.tags).toEqual(['ai 安全', '人工智能']);
    expect(s.users[UID]!.tags).toEqual(['人工智能']);
    s = run(s, { op: 'renameTag', from: 'ai 安全', to: '人工智能' });
    expect(s.notes[LATER.id]!.tags).toEqual(['人工智能']);
    s = run(s, { op: 'deleteTag', tag: '人工智能' });
    expect(tagCounts(s)).toEqual([{ tag: '书单', count: 1 }]);
  });

  it('撤销移出：原样放回（收藏时间、标签都在）', () => {
    const s = run(emptyXhsState(), saveNote(SAME.id, ['书单']));
    const item = s.notes[SAME.id]!;
    const gone = run(s, { op: 'remove', kind: 'note', id: SAME.id });
    expect(run(gone, { op: 'restore', kind: 'note', item }).notes[SAME.id]).toEqual(item);
  });

  it('页面脚本只能收藏 / 移出 / 加减标签；内容不可信时不通过', () => {
    expect(parseXhsOp({ op: 'renameTag', from: 'a', to: 'b' }, NOW, true)).toBeUndefined();
    expect(parseXhsOp({ op: 'deleteTag', tag: 'a' }, NOW, true)).toBeUndefined();
    expect(parseXhsOp({ op: 'restore', kind: 'note', item: {} }, NOW, true)).toBeUndefined();
    // 链接不是小红书的、或链接里的笔记与 ID 对不上
    expect(parseXhsOp(saveNote(SAME.id, [], { url: `https://evil.example/explore/${SAME.id}` }), NOW, true)).toBeUndefined();
    expect(parseXhsOp(saveNote(SAME.id, [], { url: `https://www.xiaohongshu.com/explore/${LATER.id}` }), NOW, true)).toBeUndefined();
    expect(parseXhsOp({ ...saveUser(), user: { id: UID, name: 'x', url: `https://www.xiaohongshu.com/explore/${SAME.id}` } }, NOW, true)).toBeUndefined();
    expect(parseXhsOp({ op: 'remove', kind: 'video', id: SAME.id }, NOW, true)).toBeUndefined();
    // 文字清理：控制字符、超长；时间不合理的丢掉时间（笔记照收）
    const o = op(saveNote(SAME.id, ['#好'], { title: `a\u0000b\n${'长'.repeat(300)}`, authorName: ' 名字 ', publishedAt: NOW + 30 * 24 * 3_600_000, timeSource: 'page' }));
    expect(o.op === 'saveNote' && o.note.title.startsWith('a b ')).toBe(true);
    expect(o.op === 'saveNote' && o.note.title.length).toBe(XHS.titleMaxChars);
    expect(o.op === 'saveNote' && o.note.authorName).toBe('名字');
    expect(o.op === 'saveNote' && 'publishedAt' in o.note).toBe(false);
    expect(o.op === 'saveNote' && o.tags).toEqual(['好']);
  });

  it('存储里的坏数据读出来时丢掉，好的照常', () => {
    const good = run(emptyXhsState(), saveNote(SAME.id, ['书单']), saveUser());
    const raw = {
      notes: { ...good.notes, bad1: { id: 'x' }, bad2: { ...good.notes[SAME.id], id: LATER.id }, bad3: null },
      users: { ...good.users, bad: { id: UID, name: 'n', url: 'https://evil.example/', savedAt: 1, tags: [] } },
    };
    expect(sanitizeXhsState(raw, NOW)).toEqual(good);
    expect(sanitizeXhsState(undefined, NOW)).toEqual(emptyXhsState());
    expect(sanitizeXhsState('garbage', NOW)).toEqual(emptyXhsState());
  });

  it('侧边栏筛选：类型、标签（不分大小写）、关键词；最近收藏的在前；常用标签', () => {
    let s = run(emptyXhsState(), saveNote(SAME.id, ['书单', 'AI']), saveUser(['AI']));
    s = applyXhsOp(s, op(saveNote(LATER.id, ['咖啡'], { title: '上海富民路咖啡' })), NOW + 1000).state;
    expect(filterXhs(s, { kind: 'all' }).map((x) => x.item.id)).toEqual([LATER.id, SAME.id, UID]);
    expect(filterXhs(s, { kind: 'note' }).map((x) => x.item.id)).toEqual([LATER.id, SAME.id]);
    expect(filterXhs(s, { kind: 'all', tag: 'ai' }).map((x) => x.item.id)).toEqual([SAME.id, UID]);
    expect(filterXhs(s, { kind: 'all', q: '富民路' }).map((x) => x.item.id)).toEqual([LATER.id]);
    expect(filterXhs(s, { kind: 'all', q: '李诞' }).map((x) => x.item.id)).toEqual([LATER.id, SAME.id, UID]);
    expect(tagCounts(s)).toEqual([
      { tag: 'AI', count: 2 },
      { tag: '咖啡', count: 1 },
      { tag: '书单', count: 1 },
    ]);
    expect(suggestTags(s, ['ai'])).toEqual(['咖啡', '书单']);
  });
});

describe('小红书：写入服务', () => {
  const ctx = (): AppContext => ({ kv: memoryKV(), locker: memoryLocker(), now: () => NOW }) as unknown as AppContext;

  it('页面发来的操作校验后写入本机；校验不过的不写并说明', async () => {
    const c = ctx();
    expect(await applyXhsFromPage(c, saveNote(SAME.id, ['书单']))).toEqual({ ok: true });
    expect((await stores.xhs.read(c.kv)).notes[SAME.id]!.tags).toEqual(['书单']);
    const bad = await applyXhsFromPage(c, { op: 'deleteTag', tag: '书单' });
    expect(bad.ok).toBe(false);
    expect((await stores.xhs.read(c.kv)).notes[SAME.id]!.tags).toEqual(['书单']);
  });

  it('并发写入不丢（加锁读改写）', async () => {
    const c = ctx();
    await applyXhs(c, op(saveNote(SAME.id)));
    await Promise.all(['a', 'b', 'c', 'd'].map((t) => applyXhsFromPage(c, { op: 'tags', kind: 'note', id: SAME.id, add: [t], remove: [] })));
    expect((await stores.xhs.read(c.kv)).notes[SAME.id]!.tags.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('收藏随导出、随清空（与其他本地数据同一个存储）', async () => {
    const c = ctx();
    await applyXhs(c, op(saveUser(['x'])));
    expect(Object.keys(await c.kv.getAll())).toContain('xhs');
  });
});
