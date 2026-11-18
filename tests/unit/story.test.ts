// 故事（DECISIONS §88）的纯逻辑：页面读取结果的校验、来源清单与带引用的笔记、整理结果的校验（来源编号、"已证实"的底线）、
// 本机记录，以及发给大模型的内容（数据最小化）。
import { describe, expect, it } from 'vitest';
import { STORY } from '../../src/config/defaults';
import { readStoryPage, type StoryPageRead, type StoryReaderConfig } from '../../src/content/story-reader';
import { STORY_BRIEF_SCHEMA, buildStoryBriefPrompt, buildStoryResearchPrompt, storyPageForPrompt } from '../../src/core/prompts';
import {
  PAGE_SOURCE_ID,
  assembleResearch,
  cachedStory,
  cleanStoryUrl,
  emptyStoryState,
  forgetStory,
  parseStoryBrief,
  pastedStoryPage,
  referencedSources,
  rememberStory,
  sanitizeStoryRead,
  sanitizeStoryState,
  statusCounts,
  storyKey,
  type StoryPage,
  type StoryRecord,
} from '../../src/core/story';
import { NOW } from './helpers';

/** 示例场景：Elon Musk 转引 Eric Daugherty 的帖子（用户给的例子；数字照截图） */
const X_READ: StoryPageRead = {
  kind: 'x',
  url: 'https://x.com/elonmusk/status/2122810772967575759?s=20&t=sharerToken',
  docTitle: 'X 上的 Elon Musk：“🤷‍♂️” / X',
  statusId: '2122810772967575759',
  user: 'elonmusk',
  post: {
    name: 'Elon Musk',
    handle: '@elonmusk',
    text: '🤷‍♂️',
    time: '2026-11-17T21:55:00.000Z',
    timeLabel: '上午5:55 · 2026年11月18日',
    url: 'https://x.com/elonmusk/status/2122810772967575759?s=20',
    metrics: '2943 回复、3756 次转帖、40000 喜欢次数、2184 书签、4204000 次观看',
    media: ['video', 'bogus-kind'],
  },
  quoted: {
    name: 'Eric Daugherty',
    handle: '@EricLDaugh',
    text: "🚨 JUST IN: Sec. Sean Duffy RESPONDS to Elon Musk saying he offered the Trump admin FREE Starlink for the FAA, but was turned down\n\n\"We thought that the best method is to have a network [that's] based on the ground.\"",
    time: '2026-11-17T10:00:00.000Z',
    media: ['video'],
  },
};

const PAGE_READ: StoryPageRead = {
  kind: 'page',
  url: 'https://news.example.com/2026/11/17/faa-starlink?utm_source=x&fbclid=abc&id=42#comments',
  canonical: 'https://news.example.com/2026/11/17/faa-starlink',
  docTitle: 'FAA rejected free Starlink offer - Example News',
  title: 'Duffy: FAA wants a ground-based network, not free Starlink',
  siteName: 'Example News',
  authors: ['Jane Reporter', 'https://news.example.com/staff/jane', ''],
  published: '2026-11-17T12:00:00Z',
  description: 'The transportation secretary responded to Elon Musk.',
  lang: 'en',
  ldType: 'NewsArticle',
  text: 'Paragraph one.\nParagraph two.',
  truncated: false,
  selection: 'based on the ground',
};

function webPage(over: Partial<StoryPage> = {}): StoryPage {
  const r = sanitizeStoryRead(PAGE_READ, NOW);
  if (!r.ok) throw new Error('fixture');
  return { ...r.page, ...over };
}

describe('页面读取结果的校验', () => {
  it('X 帖子：主帖、被引用的帖子、规范链接（去掉分享参数）、不认识的媒体类型丢掉', () => {
    const r = sanitizeStoryRead(X_READ, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.page;
    expect(p).toMatchObject({ platform: 'x', site: 'X', statusId: '2122810772967575759', url: 'https://x.com/elonmusk/status/2122810772967575759', readAt: NOW });
    expect(p.post).toMatchObject({ author: 'Elon Musk', handle: '@elonmusk', text: '🤷‍♂️', media: ['video'], url: 'https://x.com/elonmusk/status/2122810772967575759' });
    expect(p.post?.metrics).toContain('4204000 次观看');
    expect(p.quoted).toMatchObject({ author: 'Eric Daugherty', handle: '@EricLDaugh' });
    expect(p.quoted?.text).toContain('Sean Duffy');
    expect(p.title).toBe('Elon Musk：🤷‍♂️');
    expect(storyKey(p)).toBe('x:2122810772967575759');
  });

  it('X：页面上没找到这条帖子 → x-not-found；不是帖子页 → x-nopost；ID / 用户名不像 → bad', () => {
    expect(sanitizeStoryRead({ ...X_READ, post: undefined, quoted: undefined }, NOW)).toMatchObject({ ok: false, reason: 'x-not-found' });
    expect(sanitizeStoryRead({ kind: 'x-nopost', url: 'https://x.com/home' }, NOW)).toMatchObject({ ok: false, reason: 'x-nopost' });
    expect(sanitizeStoryRead({ ...X_READ, statusId: '12ab' }, NOW)).toMatchObject({ ok: false, reason: 'bad' });
    expect(sanitizeStoryRead({ ...X_READ, user: 'a b' }, NOW)).toMatchObject({ ok: false, reason: 'bad' });
  });

  it('X：用户名不是 @ 开头的单词就不认；主帖只有引用时标题写"引用：…"', () => {
    const r = sanitizeStoryRead({ ...X_READ, post: { ...X_READ.post!, handle: '<script>', text: '' } }, NOW);
    expect(r.ok && r.page.post?.handle).toBe(undefined);
    expect(r.ok && r.page.title.startsWith('Elon Musk：引用：🚨 JUST IN')).toBe(true);
  });

  it('网页：元数据、去掉跟踪参数保留文章参数、规范链接、作者里的网址丢掉', () => {
    const p = webPage();
    expect(p).toMatchObject({
      platform: 'web',
      url: 'https://news.example.com/2026/11/17/faa-starlink',
      title: 'Duffy: FAA wants a ground-based network, not free Starlink',
      site: 'Example News',
      authors: ['Jane Reporter'],
      published: '2026-11-17T12:00:00.000Z',
      kind: 'NewsArticle',
      selection: 'based on the ground',
    });
    expect(storyKey(p)).toBe('web:https://news.example.com/2026/11/17/faa-starlink');
  });

  it('网页：规范链接指向别的站时不用；没有规范链接时用去掉跟踪参数的当前网址', () => {
    const other = sanitizeStoryRead({ ...PAGE_READ, canonical: 'https://elsewhere.example.org/' }, NOW);
    expect(other.ok && other.page.url).toBe('https://news.example.com/2026/11/17/faa-starlink?id=42');
    const none = sanitizeStoryRead({ ...PAGE_READ, canonical: undefined }, NOW);
    expect(none.ok && none.page.url).toBe('https://news.example.com/2026/11/17/faa-starlink?id=42');
  });

  it('网页：正文、简介、选中都没有 → empty；不是对象 / 不认识的 kind → bad；被跳过的站 → skipped', () => {
    expect(sanitizeStoryRead({ ...PAGE_READ, text: '', description: undefined, selection: undefined }, NOW)).toMatchObject({ ok: false, reason: 'empty' });
    expect(sanitizeStoryRead(null, NOW)).toMatchObject({ ok: false, reason: 'bad' });
    expect(sanitizeStoryRead({ kind: 'weird' }, NOW)).toMatchObject({ ok: false, reason: 'bad' });
    expect(sanitizeStoryRead({ kind: 'skipped', url: 'https://www.youtube.com/watch?v=x' }, NOW)).toMatchObject({ ok: false, reason: 'skipped' });
  });

  it('长度都有上限（页面是不可信输入）', () => {
    const r = sanitizeStoryRead({ ...PAGE_READ, text: 'x'.repeat(STORY.maxTextChars + 500), title: 't'.repeat(1000), selection: 's'.repeat(9999) }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.page.text.length).toBe(STORY.maxTextChars);
    expect(r.page.truncated).toBe(true);
    expect(r.page.title.length).toBe(STORY.titleMaxChars);
    expect(r.page.selection?.length).toBe(STORY.maxSelectionChars);
  });

  it('链接只认 http(s)，去掉 #、账号密码和跟踪参数', () => {
    expect(cleanStoryUrl('javascript:alert(1)')).toBe('');
    expect(cleanStoryUrl('https://u:p@a.example/x?utm_campaign=1&gclid=2&page=3#top')).toBe('https://a.example/x?page=3');
    expect(cleanStoryUrl(42)).toBe('');
  });

  it('粘贴的文字：没有文字不算；同样的文字是同一个故事', () => {
    expect(pastedStoryPage('   ', '', NOW)).toBe(undefined);
    const p = pastedStoryPage('有人说某某发布了新政策', 'not a url', NOW)!;
    expect(p).toMatchObject({ platform: 'paste', url: '', site: '你粘贴的文字' });
    expect(storyKey(p)).toBe(storyKey(pastedStoryPage('有人说某某发布了新政策', '', NOW + 1000)!));
  });
});

describe('页面读取函数自给自足（executeScript 只送函数源码进页面）', () => {
  const cfg: StoryReaderConfig = { skip: ['https://www.youtube.com/'], xPages: ['https://x.com/'], maxTextChars: 100, maxPostChars: 100, maxSelectionChars: 100 };
  /** 只把函数源码拿出来，在一个没有任何模块变量的作用域里跑：用到外面的东西就会报错 */
  const isolated = (href: string): StoryPageRead =>
    new Function('location', 'document', 'window', 'cfg', `return (${readStoryPage.toString()})(cfg);`)({ href }, undefined, undefined, cfg) as StoryPageRead;

  it('各有约定的站：一个字都不读（连 document 都不碰）', () => {
    expect(isolated('https://www.youtube.com/watch?v=abc')).toEqual({ kind: 'skipped', url: 'https://www.youtube.com/watch?v=abc' });
  });

  it('X 的信息流 / 个人主页：不读', () => {
    expect(isolated('https://x.com/home')).toEqual({ kind: 'x-nopost', url: 'https://x.com/home' });
    expect(isolated('https://x.com/elonmusk')).toEqual({ kind: 'x-nopost', url: 'https://x.com/elonmusk' });
  });
});

describe('来源清单与带引用的笔记', () => {
  const raw = {
    segments: [
      { text: '我先搜一下。', cites: [] },
      { text: 'Duffy 说 FAA 想要地面网络。', cites: [{ url: 'https://www.reuters.com/a?utm_source=x', title: 'Reuters: Duffy responds', quote: 'We thought that the best method...' }] },
      { text: 'Musk 说提供过免费 Starlink。', cites: [{ url: 'https://x.com/elonmusk/status/1', title: 'Musk post' }, { url: 'https://reuters.com/a/', title: 'dup' }] },
    ],
    results: [
      { url: 'https://apnews.com/b', title: 'AP: FAA modernization', date: 'November 16, 2026' },
      { url: 'https://www.reuters.com/a', title: 'Reuters again', date: 'November 17, 2026' },
      { url: 'ftp://bad.example/x', title: 'bad' },
    ],
    queries: ['Duffy Starlink FAA', 'Duffy Starlink FAA', ''],
    errors: ['max_uses_exceeded', 'max_uses_exceeded'],
  };

  it('去重（www、末尾斜杠、跟踪参数都不算不同）；回答里引用过的排在前面、按第一次引用编号；非 http 丢掉', () => {
    const r = assembleResearch(raw);
    expect(r.sources.map((s) => [s.id, s.site, s.cited])).toEqual([
      ['S1', 'reuters.com', true],
      ['S2', 'x.com', true],
      ['S3', 'apnews.com', false],
    ]);
    expect(r.sources[0]).toMatchObject({ url: 'https://www.reuters.com/a', title: 'Reuters: Duffy responds', date: 'November 17, 2026', quotes: ['We thought that the best method...'] });
    expect(r.queries).toEqual(['Duffy Starlink FAA']);
    expect(r.errors).toEqual(['max_uses_exceeded']);
  });

  it('笔记里每段话后面带上它引用的编号', () => {
    const r = assembleResearch(raw);
    expect(r.notes).toBe('我先搜一下。Duffy 说 FAA 想要地面网络。 [S1]Musk 说提供过免费 Starlink。 [S2, S1]');
  });

  it('来源数有上限', () => {
    const many = { segments: [], results: Array.from({ length: STORY.maxSources + 10 }, (_, i) => ({ url: `https://s${i}.example/` })), queries: [], errors: [] };
    expect(assembleResearch(many).sources).toHaveLength(STORY.maxSources);
  });
});

describe('整理结果的校验', () => {
  const ids = ['S1', 'S2', 'S3'];
  const good = {
    headline: '交通部长回应马斯克：FAA 要的是地面网络',
    summary: '马斯克说曾免费提供 Starlink 被拒；Duffy 回应称更倾向地面网络。',
    claims: [
      { text: '马斯克曾向特朗普政府免费提供 Starlink', speaker: 'Elon Musk', status: 'claimed', note: '只有马斯克本人的说法', sources: ['S2', 'P'] },
      { text: 'Duffy 说最好的办法是地面网络', speaker: 'Sean Duffy', status: 'confirmed', note: '有视频和路透社报道', sources: ['s1', '[S3]'] },
      { text: 'FAA 已经拒绝了这个提议', speaker: '帖子', status: 'confirmed', note: '', sources: ['P'] },
      { text: '编造的来源', speaker: '', status: 'confirmed', note: '', sources: ['S9', 'https://evil.example'] },
      { text: '', speaker: 'x', status: 'claimed', note: '', sources: [] },
    ],
    timeline: [{ when: '', event: 'FAA 宣布升级空管系统', sources: ['S3'] }],
    perspectives: [{ who: 'Sean Duffy', stance: '倾向地面网络', sources: ['S1'] }, { who: '', stance: 'x', sources: [] }],
    context: [{ text: 'FAA 的空管系统老化', status: 'whatever', note: '', sources: [] }],
    analysis: [{ text: '这反映了政府与 SpaceX 关系的变化', sources: ['S1'] }],
    openQuestions: ['当初提议的细节是什么？', ''],
    caveat: '',
  };

  it('对不上的来源编号去掉并计数；"已证实"没有清单里的来源（只有页面本身也不算）→ 降为"只是说法"', () => {
    const b = parseStoryBrief(good, ids)!;
    expect(b.claims).toHaveLength(4);
    expect(b.claims[0]).toMatchObject({ status: 'claimed', sources: ['S2', PAGE_SOURCE_ID] });
    expect(b.claims[1]).toMatchObject({ status: 'confirmed', sources: ['S1', 'S3'] });
    expect(b.claims[1]!.downgraded).toBe(undefined);
    expect(b.claims[2]).toMatchObject({ status: 'claimed', downgraded: true, sources: [PAGE_SOURCE_ID] });
    expect(b.claims[3]).toMatchObject({ status: 'claimed', downgraded: true, sources: [] });
    expect(b.downgraded).toBe(2);
    expect(b.droppedRefs).toBe(2);
  });

  it('不认识的状态 → 查无实据；没写日期 → 日期不详；空的条目丢掉', () => {
    const b = parseStoryBrief(good, ids)!;
    expect(b.context[0]!.status).toBe('unverified');
    expect(b.timeline[0]!.when).toBe('日期不详');
    expect(b.perspectives).toHaveLength(1);
    expect(b.openQuestions).toEqual(['当初提议的细节是什么？']);
    expect(statusCounts(b)).toEqual({ confirmed: 1, claimed: 3, disputed: 0, unverified: 1 });
    expect([...referencedSources(b)].sort()).toEqual(['P', 'S1', 'S2', 'S3']);
  });

  it('条数和长度有上限；标题和概述都没有时不拿来充数', () => {
    const many = { ...good, claims: Array.from({ length: 30 }, () => ({ text: 'x'.repeat(2000), speaker: 's', status: 'claimed', note: '', sources: [] })) };
    const b = parseStoryBrief(many, ids)!;
    expect(b.claims).toHaveLength(STORY.limits.claims);
    expect(b.claims[0]!.text.length).toBe(STORY.limits.textChars);
    expect(parseStoryBrief({ ...good, headline: '', summary: '' }, ids)).toBe(undefined);
    expect(parseStoryBrief('nope', ids)).toBe(undefined);
  });
});

describe('本机记录', () => {
  const rec = (key: string, at: number, id = `id-${key}-${at}`): StoryRecord => ({
    id,
    key,
    page: webPage(),
    brief: parseStoryBrief({ headline: 'h', summary: 's', claims: [], timeline: [], perspectives: [], context: [], analysis: [], openQuestions: [], caveat: '' }, [])!,
    sources: [],
    queries: [],
    searchErrors: [],
    searches: 0,
    usd: 0,
    estimatedPrice: false,
    provider: 'anthropic',
    model: 'm',
    at,
  });

  it('同一个故事只留最新的一次；总数有上限；缓存按小时算', () => {
    let s = emptyStoryState();
    s = rememberStory(s, rec('a', NOW - 10 * 3_600_000));
    s = rememberStory(s, rec('b', NOW));
    s = rememberStory(s, rec('a', NOW - 3_600_000));
    expect(s.items.map((i) => i.key)).toEqual(['a', 'b']);
    expect(cachedStory(s, 'a', NOW, 12)?.at).toBe(NOW - 3_600_000);
    expect(cachedStory(s, 'a', NOW, 0.5)).toBe(undefined);
    for (let i = 0; i < STORY.maxKept + 5; i++) s = rememberStory(s, rec(`k${i}`, NOW));
    expect(s.items).toHaveLength(STORY.maxKept);
    expect(forgetStory(s, s.items[0]!.id).items).toHaveLength(STORY.maxKept - 1);
  });

  it('存储里的旧数据 / 坏数据读出来不出错', () => {
    expect(sanitizeStoryState(undefined)).toEqual({ items: [] });
    expect(sanitizeStoryState({ items: [null, { id: 1 }, rec('a', NOW)] }).items).toHaveLength(1);
  });
});

describe('发给大模型的内容', () => {
  it('网页：标题、作者、时间、正文前一部分和选中的文字；正文太长时注明只给了一部分', () => {
    const page = webPage({ text: '正'.repeat(STORY.promptTextChars + 100) });
    const p = storyPageForPrompt(page);
    expect(p).toMatchObject({ platform: '网页', url: 'https://news.example.com/2026/11/17/faa-starlink', site: 'Example News', authors: ['Jane Reporter'], userSelected: 'based on the ground', textNote: '正文太长，只给了前面一部分' });
    expect(String(p.text).length).toBe(STORY.promptTextChars + 1);
  });

  it('X：主帖、被引用的帖子（作者、时间、正文、互动数据、媒体），不带分享参数', () => {
    const r = sanitizeStoryRead(X_READ, NOW);
    if (!r.ok) throw new Error('fixture');
    const { system, user } = buildStoryResearchPrompt(r.page, '2026-11-18T10:00:00+08:00', 5);
    expect(system).toContain('最多搜 5 次');
    expect(system).toContain('不可信的数据');
    expect(system).toContain('2026-11-18T10:00:00+08:00');
    const payload = JSON.parse(user.slice(user.indexOf('\n') + 1));
    expect(payload).toMatchObject({ platform: 'X（推特）帖子', url: 'https://x.com/elonmusk/status/2122810772967575759', post: { author: 'Elon Musk', handle: '@elonmusk', text: '🤷‍♂️' }, quotedPost: { author: 'Eric Daugherty' } });
    expect(user).not.toContain('sharerToken');
    expect(user).not.toContain('docTitle');
  });

  it('整理这一步：页面简要信息、来源清单、笔记；不再发正文', () => {
    const page = webPage({ text: '这一段正文不该再发一次' });
    const research = assembleResearch({ segments: [{ text: '笔记。', cites: [{ url: 'https://a.example/1', title: 'A' }] }], results: [], queries: [], errors: [] });
    const { system, user } = buildStoryBriefPrompt(page, research.notes, research.sources);
    expect(system).toContain('confirmed（已证实）');
    expect(user).toContain('"id":"S1"');
    expect(user).toContain('笔记。 [S1]');
    expect(user).not.toContain('这一段正文不该再发一次');
  });

  it('结构化输出的每一层都把全部字段列为必填（OpenAI 的严格模式要求）', () => {
    const check = (schema: Record<string, unknown>) => {
      if (schema.type === 'object') {
        expect(schema.additionalProperties).toBe(false);
        expect([...(schema.required as string[])].sort()).toEqual(Object.keys(schema.properties as object).sort());
        for (const v of Object.values(schema.properties as Record<string, Record<string, unknown>>)) check(v);
      }
      if (schema.type === 'array') check(schema.items as Record<string, unknown>);
    };
    check(STORY_BRIEF_SCHEMA);
  });
});
