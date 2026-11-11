import { afterEach, describe, expect, it, vi } from 'vitest';
import { MUSE } from '../../src/config/defaults';
import { ENDPOINTS, MUSE_CHAT_URL } from '../../src/config/endpoints';
import { xPostParts } from '../../src/core/clips';
import {
  MUSE_MSG,
  autoTranscriptAround,
  buildMusePackage,
  chaptersAround,
  cuesAround,
  museCaptionProblem,
  museChapterText,
  museClock,
  museItem,
  museLink,
  musePosition,
  museUnavailable,
  parseChapters,
  redactMuse,
  rememberMuseVideo,
  sanitizeMuseCaptionReply,
  sanitizeMuseSnapshot,
  type MuseCaptions,
  type MuseSnapshot,
  type MuseVideoInfo,
} from '../../src/core/muse';
import type { AppContext } from '../../src/services/context';
import { MUSE_CAPTION_HINT, MUSE_NO_SCRIPT, freezeMuse, museSecrets } from '../../src/services/muse-service';
import { mergeSettings, stores, subtitleTrackStore } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';
import { createFakeApi, type FakeVideo } from './fake-api';
import { NOW } from './helpers';

const VID = 'dQw4w9WgXcQ';
const XHS_ID = '6ae9a4e000000000140281c6';
const RULE = '视频里的说法必须引用位置或原文；通用概念问题可用通用知识回答，但必须标明「这是通用知识，不是视频原话」。';
/** 一段带章节列表的简介 */
const DESCRIPTION = 'A visual explainer of attention.\n\n0:00 Intro\n1:30 Attention\n5:00 Training\n20:00 Outro\n\nSubscribe for more.';

const youtube = (over: Partial<MuseSnapshot> = {}): MuseSnapshot => ({ site: 'youtube', videoId: VID, title: 'How transformers work', author: 'Explain Lab', position: 123.7, duration: 1100, ...over });

/** 每 5 秒一句，共 n 句 */
const cueList = (n: number, text = (i: number) => `第 ${i} 句`) => Array.from({ length: n }, (_, i) => ({ start: i * 5, end: i * 5 + 4, text: text(i) }));

describe('时间与链接', () => {
  it('时间写成 mm:ss，满一小时写成 h:mm:ss', () => {
    expect(museClock(0)).toBe('00:00');
    expect(museClock(123.9)).toBe('02:03');
    expect(museClock(3599)).toBe('59:59');
    expect(museClock(3723)).toBe('1:02:03');
  });

  it('播放位置：mm:ss / 总时长；读不到的写「未知」', () => {
    expect(musePosition(123.7, 1100)).toBe('02:03 / 18:20');
    expect(musePosition(123.7, undefined)).toBe('02:03 / 未知');
    expect(musePosition(undefined, 1100)).toBe('未知');
    expect(musePosition(undefined, undefined)).toBe('未知');
  });

  it('只有 YouTube 在链接上拼 &t=秒数s；位置读不到时不拼，Shorts 不拼', () => {
    expect(museLink(youtube())).toBe(`https://www.youtube.com/watch?v=${VID}&t=123s`);
    expect(museLink(youtube({ position: undefined }))).toBe(`https://www.youtube.com/watch?v=${VID}`);
    expect(museLink({ site: 'youtube', videoId: VID, shorts: true, position: 5 })).toBe(`https://www.youtube.com/shorts/${VID}`);
  });

  it('别的站只给这条视频 / 帖子的链接，不自创时间参数', () => {
    const links: [MuseSnapshot['site'], string][] = [
      ['xhs', `https://www.xiaohongshu.com/explore/${XHS_ID}`],
      ['x', 'https://x.com/ayoships/status/2117650684774580249'],
      ['kubb', 'https://www.kubb.tv/play/e2rCXFzJUz2?id=lIM07A3d3g8'],
      ['ig', 'https://www.instagram.com/p/DfZNnxxxjB1/'],
      ['douyin', 'https://www.douyin.com/jingxuan?modal_id=7704250528896716072'],
      ['bilibili', 'https://www.bilibili.com/bangumi/play/ep733317'],
      ['bilibili', 'https://www.bilibili.com/video/BV1Kb411W75N/?p=5'],
    ];
    for (const [site, url] of links) {
      const link = museLink({ site, videoId: 'x', url, position: 42 });
      expect(link).toBe(url);
      expect(link).not.toMatch(/[?&#]t=|start=|time=/);
    }
  });

  it('打开的是 muse.ai，而它不在网络出口白名单里（扩展自己不向它发请求）', () => {
    expect(MUSE_CHAT_URL).toBe('https://muse.ai/');
    expect(Object.values(ENDPOINTS).some((u) => u.includes('muse.ai'))).toBe(false);
  });
});

describe('这条视频 / 帖子的规范链接', () => {
  it('小红书：只留笔记 ID，xsec_token 不带（它是令牌）', () => {
    expect(museItem('xhs', `https://www.xiaohongshu.com/explore/${XHS_ID}?xsec_token=ABsecret%3D&xsec_source=pc_feed`)).toEqual({ id: XHS_ID, url: `https://www.xiaohongshu.com/explore/${XHS_ID}` });
    expect(museItem('xhs', `https://www.rednote.com/user/profile/67398f95000000001d02d725/${XHS_ID}?xsec_token=AB`)).toEqual({ id: XHS_ID, url: `https://www.rednote.com/explore/${XHS_ID}` });
    expect(museItem('xhs', 'https://www.xiaohongshu.com/user/profile/67398f95000000001d02d725')).toBeUndefined();
    expect(museItem('xhs', 'https://www.xiaohongshu.com/explore')).toBeUndefined();
  });

  it('X、酷播、Instagram、抖音：沿用片段录制的规范链接，分享来源和别的参数去掉', () => {
    expect(museItem('x', 'https://x.com/ayoships/status/2117650684774580249/video/1?s=20&t=sharerToken')).toEqual({ id: '2117650684774580249', url: 'https://x.com/ayoships/status/2117650684774580249' });
    expect(museItem('kubb', 'https://www.kubb.tv/play/e2rCXFzJUz2?id=lIM07A3d3g8&from=list')?.url).toBe('https://www.kubb.tv/play/e2rCXFzJUz2?id=lIM07A3d3g8');
    expect(museItem('ig', 'https://www.instagram.com/reel/DfZNnxxxjB1/?igsh=abc')?.url).toBe('https://www.instagram.com/p/DfZNnxxxjB1/');
    expect(museItem('douyin', 'https://www.douyin.com/jingxuan/search/%E9%BB%84%E4%BB%81%E5%8B%8B?aid=1&modal_id=7704250528896716072&type=general')?.url).toBe('https://www.douyin.com/jingxuan?modal_id=7704250528896716072');
    expect(museItem('x', 'https://x.com/home')).toBeUndefined();
  });

  it('B 站：沿用片段录制的规范链接——语言前缀、来源参数去掉；播放列表的编号不带，写成视频页', () => {
    expect(museItem('bilibili', 'https://www.bilibili.com/zh-Hans/bangumi/play/ep733317?from_spmid=666.25.episode.0')).toMatchObject({ id: 'ep733317', url: 'https://www.bilibili.com/bangumi/play/ep733317' });
    expect(museItem('bilibili', 'https://www.bilibili.com/video/BV1Kb411W75N/?p=5&spm_id_from=333.788.videopod.episodes&vd_source=abc')?.url).toBe('https://www.bilibili.com/video/BV1Kb411W75N/?p=5');
    expect(museItem('bilibili', 'https://www.bilibili.com/list/watchlater?oid=1&bvid=BV1ujNV6qEXg')?.url).toBe('https://www.bilibili.com/video/BV1ujNV6qEXg/');
    expect(museItem('bilibili', 'https://live.bilibili.com/22')).toBeUndefined();
    expect(museItem('douyin', 'https://www.douyin.com/video/7704250528896716072')).toBeUndefined();
  });
});

describe('认不出当前这条视频时说明原因', () => {
  it('不是视频 / 帖子页', () => {
    expect(museUnavailable('youtube', { videoId: null, feed: false, hasVideo: false })).toContain('不是 YouTube 视频播放页');
    expect(museUnavailable('xhs', { videoId: null, feed: false, hasVideo: false })).toContain('不是笔记详情');
    expect(museUnavailable('kubb', { videoId: null, feed: false, hasVideo: false })).toContain('不是播放页');
    expect(museUnavailable('ig', { videoId: null, feed: false, hasVideo: false })).toContain('首页信息流');
    expect(museUnavailable('douyin', { videoId: null, feed: false, hasVideo: false })).toContain('没有点开的抖音视频');
    expect(museUnavailable('bilibili', { videoId: null, feed: false, hasVideo: false })).toContain('没有 B 站的播放器');
    expect(museUnavailable('bilibili', { videoId: 'ss28747', feed: false, hasVideo: false })).toBeUndefined();
  });

  it('首页信息流：没有开着声音在播的视频、或认不出帖子（广告）', () => {
    expect(museUnavailable('x', { videoId: null, feed: true, hasVideo: false })).toContain('没有正在播放、开着声音的视频');
    expect(museUnavailable('ig', { videoId: null, feed: true, hasVideo: true })).toContain('认不出这个视频属于哪条帖子');
    expect(museUnavailable('x', { videoId: '1', feed: true, hasVideo: true })).toBeUndefined();
  });

  it('认得出就能问：没有视频的笔记、帖子也行（播放位置另写「未知」）', () => {
    expect(museUnavailable('xhs', { videoId: XHS_ID, feed: false, hasVideo: false })).toBeUndefined();
    expect(museUnavailable('x', { videoId: '2117000000000000001', feed: false, hasVideo: false })).toBeUndefined();
    expect(museUnavailable('youtube', { videoId: VID, feed: false, hasVideo: false })).toBeUndefined();
  });
});

describe('校验页面交回来的快照', () => {
  it('YouTube：ID 要像视频 ID；标题、作者压成一行并截断', () => {
    const s = sanitizeMuseSnapshot({ site: 'youtube', videoId: VID, title: '  How\n transformers work  ', author: 'x'.repeat(500), position: 12.5, duration: 600, extra: 'ignored' });
    expect(s).toEqual({ site: 'youtube', videoId: VID, title: 'How transformers work', author: 'x'.repeat(MUSE.authorMaxChars), position: 12.5, duration: 600 });
    expect(sanitizeMuseSnapshot({ site: 'youtube', videoId: VID, title: `零宽${String.fromCharCode(0x200b)}字符` })?.title).toBe('零宽字符');
    expect(sanitizeMuseSnapshot({ site: 'youtube', videoId: '../etc' })).toBeNull();
    expect(sanitizeMuseSnapshot({ site: 'vimeo', videoId: VID })).toBeNull();
    expect(sanitizeMuseSnapshot(null)).toBeNull();
    expect(sanitizeMuseSnapshot('x')).toBeNull();
  });

  it('别的站：链接重新按规范写，ID 与链接对不上的不要', () => {
    const s = sanitizeMuseSnapshot({ site: 'xhs', videoId: XHS_ID, url: `https://www.xiaohongshu.com/explore/${XHS_ID}?xsec_token=ABsecret`, title: '视频日记', author: '李诞小卖部', body: '第一段\r\n\r\n\r\n\r\n第二段  有空格' });
    expect(s).toEqual({ site: 'xhs', videoId: XHS_ID, url: `https://www.xiaohongshu.com/explore/${XHS_ID}`, title: '视频日记', author: '李诞小卖部', body: '第一段\n\n第二段 有空格' });
    expect(sanitizeMuseSnapshot({ site: 'xhs', videoId: '691d6e07000000001d03be5e', url: `https://www.xiaohongshu.com/explore/${XHS_ID}` })).toBeNull();
    expect(sanitizeMuseSnapshot({ site: 'x', videoId: '1', url: 'https://evil.example/ayoships/status/1' })).toBeNull();
    expect(sanitizeMuseSnapshot({ site: 'douyin', videoId: '7704250528896716072' })).toBeNull();
  });

  it('播放位置：不是合理的秒数就当没读到；没读到位置时总时长也不留，才留"为什么没读到"', () => {
    expect(sanitizeMuseSnapshot({ site: 'youtube', videoId: VID, position: Number.NaN, duration: 600, gap: 'ad' })).toEqual({ site: 'youtube', videoId: VID, gap: 'ad' });
    expect(sanitizeMuseSnapshot({ site: 'youtube', videoId: VID, position: -3 })).toEqual({ site: 'youtube', videoId: VID });
    expect(sanitizeMuseSnapshot({ site: 'youtube', videoId: VID, position: 5, duration: 0, gap: 'ad' })).toEqual({ site: 'youtube', videoId: VID, position: 5 });
    expect(sanitizeMuseSnapshot({ site: 'youtube', videoId: VID, shorts: true, gap: 'shorts' })).toEqual({ site: 'youtube', videoId: VID, shorts: true, gap: 'shorts' });
    expect(sanitizeMuseSnapshot({ site: 'youtube', videoId: VID, gap: 'whatever' })).toEqual({ site: 'youtube', videoId: VID });
  });

  it('认不出当前视频：只留原因', () => {
    expect(sanitizeMuseSnapshot({ site: 'x', unavailable: '这个页面不是帖子详情', videoId: '1', title: 't' })).toEqual({ site: 'x', unavailable: '这个页面不是帖子详情' });
  });
});

describe('字幕 / 转写', () => {
  it('取位置前后 30 秒里的句子（有交叠就算），按时间排，空的不要', () => {
    const cues = [
      { start: 0, end: 4, text: '太早' },
      { start: 68, end: 71, text: '压着窗口的开头' },
      { start: 100, end: 104, text: '正好在位置上' },
      { start: 90, end: 94, text: '\n ' },
      { start: 129, end: 140, text: '压着窗口的结尾' },
      { start: 130, end: 135, text: '太晚' },
      { start: 80, end: 84, text: '顺序乱的' },
    ];
    expect(cuesAround(cues, 100).map((c) => c.text)).toEqual(['压着窗口的开头', '顺序乱的', '正好在位置上', '压着窗口的结尾']);
    expect(cuesAround(cues, 100, 5).map((c) => c.text)).toEqual(['正好在位置上']);
    expect(MUSE.windowSec).toBe(30);
  });

  it('多语字幕脚本交回的字幕：必须是这个视频的；自动翻译的标出来', () => {
    const reply = { videoId: VID, label: '简体中文', autoTranslated: true, cues: [{ start: 12, text: '你好\n世界' }, { start: 'x', text: '坏的' }, { start: 3, text: '' }] };
    expect(sanitizeMuseCaptionReply(reply, VID)).toEqual({ source: 'youtube-cc', label: '简体中文（YouTube 自动翻译）', cues: [{ start: 12, text: '你好 世界' }] });
    expect(sanitizeMuseCaptionReply(reply, 'otherVideo01')).toBeUndefined();
    expect(sanitizeMuseCaptionReply({ videoId: VID, label: 'English', cues: [] }, VID)).toBeUndefined();
    expect(sanitizeMuseCaptionReply(undefined, VID)).toBeUndefined();
  });

  it('没取到字幕时带回原因（是这个视频的回复才算）', () => {
    expect(museCaptionProblem({ videoId: VID, cues: [], problem: '这个视频没有 YouTube 字幕' }, VID)).toBe('这个视频没有 YouTube 字幕');
    expect(museCaptionProblem({ videoId: 'otherVideo01', cues: [], problem: '别的视频的' }, VID)).toBeUndefined();
    expect(museCaptionProblem({ videoId: VID, cues: [] }, VID)).toBeUndefined();
    expect(museCaptionProblem(undefined, VID)).toBeUndefined();
  });

  it('本机存的自动字幕：只取位置前后的；只有音乐（空文字）的句子不算', () => {
    const track = [
      { start: 10, end: 14, text: '' },
      { start: 20, end: 24, text: 'hello there' },
      { start: 200, end: 204, text: 'far away' },
    ];
    expect(autoTranscriptAround(track, 30)).toEqual({ source: 'auto', cues: [{ start: 20, text: 'hello there' }] });
    expect(autoTranscriptAround(track, 100)).toBeUndefined();
    expect(autoTranscriptAround(undefined, 100)).toBeUndefined();
  });
});

describe('章节（从 YouTube 简介里认）', () => {
  it('一行一个"时间 + 标题"：至少三个、时间递增', () => {
    expect(parseChapters(DESCRIPTION)).toEqual([
      { start: 0, title: 'Intro' },
      { start: 90, title: 'Attention' },
      { start: 300, title: 'Training' },
      { start: 1200, title: 'Outro' },
    ]);
  });

  it('常见写法都认：带连接号、括号、序号、符号开头，时间在行尾，超过一小时', () => {
    const text = ['章节：', '00:00 - 开场', '(01:30) 为什么需要 Memory', '3. 05:00 Memory note 是什么', '⏱️ 12:10 | 怎么用', '总结与问答 —— 59:59', '1:02:03 彩蛋'].join('\n');
    expect(parseChapters(text)).toEqual([
      { start: 0, title: '开场' },
      { start: 90, title: '为什么需要 Memory' },
      { start: 300, title: 'Memory note 是什么' },
      { start: 730, title: '怎么用' },
      { start: 3599, title: '总结与问答' },
      { start: 3723, title: '彩蛋' },
    ]);
  });

  it('真实简介里的写法：带序号和方括号，不从 0:00 写起（用户手测的那个视频就是这样）', () => {
    const real = ['➤ 年终复盘系列第二期。', '', '10 个 Aha Moments：', '', '1. [01:13] RSI：大厂的窘境', '2. [04:28] Computer Use：白干了？', '3. [13:10] 为什么 Scaling Law 值得相信？', '4. [16:18] Continual Learning：Memory Notes 不行 ——被打脸了…', '5. [17:55] 学术会议体系', '10. [36:25] Personal Agent 真的有用！'].join('\n');
    expect(parseChapters(real).map((c) => `${c.start} ${c.title}`)).toEqual([
      '73 RSI：大厂的窘境',
      '268 Computer Use：白干了？',
      '790 为什么 Scaling Law 值得相信？',
      '978 Continual Learning：Memory Notes 不行 ——被打脸了…',
      '1075 学术会议体系',
      '2185 Personal Agent 真的有用！',
    ]);
    // 17:22 正在讲 Memory Notes 那一章
    expect(museChapterText(real, 17 * 60 + 22)).toBe('上一章 [13:10] 为什么 Scaling Law 值得相信？；当前 [16:18] Continual Learning：Memory Notes 不行 ——被打脸了…；下一章 [17:55] 学术会议体系');
    // 还没播到第一章：没有"当前"，不硬凑
    expect(museChapterText(real, 30)).toBe('下一章 [01:13] RSI：大厂的窘境（当前位置在第一章之前）');
    expect(chaptersAround(parseChapters(real), 30)).toEqual({ next: { start: 73, title: 'RSI：大厂的窘境' } });
    // 时间在行尾、前面带序号
    expect(parseChapters('1. 开场 0:00\n2. 正题 3:20\n3. 收尾 9:05').map((c) => c.title)).toEqual(['开场', '正题', '收尾']);
  });

  it('不是章节列表的不认：不到三个、正文里顺带提到的时间', () => {
    expect(parseChapters('0:00 A\n2:00 B')).toEqual([]);
    expect(parseChapters('2026 年 12:30 开播\n欢迎 13:00 来看')).toEqual([]);
    expect(parseChapters('我在 12:30 的时候说过这个，你可以回去看 0:00 那一段\n没有章节')).toEqual([]);
    expect(parseChapters('')).toEqual([]);
    // 列表后面又出现更早的时间：到那里为止；有两段时取长的那一段
    expect(parseChapters('0:00 A\n1:00 B\n2:00 C\n0:30 另一份清单').map((c) => c.title)).toEqual(['A', 'B', 'C']);
    expect(parseChapters('5:00 赞助\n0:00 A\n1:00 B\n2:00 C\n3:00 D').map((c) => c.title)).toEqual(['A', 'B', 'C', 'D']);
    // 时间不合法（秒数 ≥ 60）的行跳过
    expect(parseChapters('0:00 A\n1:75 坏的\n2:00 B\n3:00 C').map((c) => c.title)).toEqual(['A', 'B', 'C']);
  });

  it('只放当前位置所在的那一章和前后各一章', () => {
    const chapters = parseChapters(DESCRIPTION);
    expect(chaptersAround(chapters, 123.7)).toEqual({ prev: { start: 0, title: 'Intro' }, current: { start: 90, title: 'Attention' }, next: { start: 300, title: 'Training' } });
    expect(chaptersAround(chapters, 10)).toEqual({ current: { start: 0, title: 'Intro' }, next: { start: 90, title: 'Attention' } });
    expect(chaptersAround(chapters, 5000)).toEqual({ prev: { start: 300, title: 'Training' }, current: { start: 1200, title: 'Outro' } });
    expect(museChapterText(DESCRIPTION, 123.7)).toBe('上一章 [00:00] Intro；当前 [01:30] Attention；下一章 [05:00] Training');
    expect(museChapterText(DESCRIPTION, 0)).toBe('当前 [00:00] Intro；下一章 [01:30] Attention');
  });

  it('简介里没有章节写「无」；有章节但位置没读到写「未知」并说明', () => {
    expect(museChapterText('只是一段介绍，没有时间。', 30)).toBe('无');
    expect(museChapterText(undefined, 30)).toBe('无');
    expect(museChapterText(DESCRIPTION, undefined)).toBe('未知（播放位置没读到；这个视频分了 4 章）');
  });

  it('本机只记最近问过的几个视频', () => {
    const info = (at: number): MuseVideoInfo => ({ title: 't', channelTitle: 'c', description: 'd', fetchedAt: at });
    const all = rememberMuseVideo({ a: info(1), b: info(3), c: info(2) }, 'd', info(4), 3);
    expect(Object.keys(all).sort()).toEqual(['b', 'c', 'd']);
    expect(Object.keys(rememberMuseVideo({ a: info(1) }, 'a', info(9)))).toEqual(['a']);
    expect(MUSE.videoCacheMax).toBeGreaterThanOrEqual(10);
  });
});

describe('咨询包', () => {
  const captions: MuseCaptions = { source: 'youtube-cc', label: 'English', cues: [{ start: 95, text: 'Attention lets the model look back.' }, { start: 124, text: 'Each token asks a question.' }] };

  it('末尾那句给 Muse 的指令是用户改定的原话', () => {
    expect(MUSE.answerRule).toBe(RULE);
  });

  it('YouTube：统一字段，链接带时间，有章节、简介，上下文是前后 30 秒的字幕，末尾是给 Muse 的指令', () => {
    const p = buildMusePackage({ snapshot: youtube(), captions, description: DESCRIPTION, question: '这里的"注意力"到底在算什么？' });
    expect(p.text).toBe(
      [
        '平台：YouTube',
        `页面链接：https://www.youtube.com/watch?v=${VID}&t=123s`,
        '标题：How transformers work',
        '作者：Explain Lab',
        '播放位置：02:03 / 18:20',
        '章节：上一章 [00:00] Intro；当前 [01:30] Attention；下一章 [05:00] Training',
        '简介：',
        'A visual explainer of attention.',
        '',
        '0:00 Intro',
        '1:30 Attention',
        '5:00 Training',
        '20:00 Outro',
        '',
        'Subscribe for more.',
        '上下文（当前位置前后 30 秒的字幕 · YouTube 字幕（English））：',
        '[01:35] Attention lets the model look back.',
        '[02:04] Each token asks a question.',
        '我的问题：这里的"注意力"到底在算什么？',
        '',
        RULE,
      ].join('\n'),
    );
    expect(p).toMatchObject({ context: 'captions', truncated: false, descriptionTruncated: false, redacted: false });
  });

  it('自动字幕的转写也算字幕', () => {
    const p = buildMusePackage({ snapshot: youtube(), captions: { source: 'auto', cues: [{ start: 120, text: '大家好' }] }, question: '问' });
    expect(p.text).toContain('上下文（当前位置前后 30 秒的转写 · TubeMuse 自动字幕（语音识别））：\n[02:00] 大家好\n');
    expect(p.context).toBe('captions');
  });

  it('YouTube 实在没取到字幕：上下文写「无字幕」，简介和章节照常', () => {
    const p = buildMusePackage({ snapshot: youtube(), description: DESCRIPTION, question: '问' });
    expect(p.context).toBe('no-captions');
    expect(p.text).toContain('\n章节：上一章 [00:00] Intro；当前 [01:30] Attention；下一章 [05:00] Training\n简介：\nA visual explainer of attention.\n');
    expect(p.text).toContain('\nSubscribe for more.\n上下文：无字幕\n我的问题：问\n');
    // 没有简介时：章节、简介都写「无」
    const bare = buildMusePackage({ snapshot: youtube(), question: '问' });
    expect(bare.text).toContain('\n章节：无\n简介：无\n上下文：无字幕\n');
  });

  it('简介太长：留开头，注明原文多长', () => {
    const long = `开头${'介'.repeat(2998)}`;
    const p = buildMusePackage({ snapshot: youtube(), captions, description: long, question: '问' });
    expect(p.descriptionTruncated).toBe(true);
    expect(p.truncated).toBe(false);
    expect(p.text).toContain(`\n简介：\n开头${'介'.repeat(MUSE.descriptionMaxChars - 2)}…\n（已截断：原文约 3000 字，这里是开头的 ${MUSE.descriptionMaxChars} 字）\n上下文（`);
  });

  it('没有字幕的平台：用这条帖子 / 笔记的正文或描述；章节、简介写「无」', () => {
    const xhs = buildMusePackage({
      snapshot: { site: 'xhs', videoId: XHS_ID, url: `https://www.xiaohongshu.com/explore/${XHS_ID}`, title: '视频日记Day255', author: '李诞小卖部', body: '一人公司怎么做？\n#创业', position: 4, duration: 12 },
      question: '他说的第一步是什么',
    });
    expect(xhs.text).toBe(
      [
        '平台：小红书',
        `页面链接：https://www.xiaohongshu.com/explore/${XHS_ID}`,
        '标题：视频日记Day255',
        '作者：李诞小卖部',
        '播放位置：00:04 / 00:12',
        '章节：无',
        '简介：无',
        '上下文（这篇笔记的正文）：',
        '一人公司怎么做？',
        '#创业',
        '我的问题：他说的第一步是什么',
        '',
        RULE,
      ].join('\n'),
    );
    expect(xhs.context).toBe('body');
    const dy = buildMusePackage({ snapshot: { site: 'douyin', videoId: '7704250528896716072', url: 'https://www.douyin.com/jingxuan?modal_id=7704250528896716072', author: '云汉AI创投', body: '第13集', position: 1 }, question: '' });
    expect(dy.text).toContain('平台：抖音\n');
    expect(dy.text).toContain('标题：无\n作者：云汉AI创投\n播放位置：00:01 / 未知\n章节：无\n简介：无\n上下文（这条视频的描述）：\n第13集\n');
    const x = buildMusePackage({ snapshot: { site: 'x', videoId: '1', url: 'https://x.com/a/status/1', author: 'Ayo O', body: 'I reverse engineered tiktok' }, question: '' });
    expect(x.text).toContain('平台：X\n页面链接：https://x.com/a/status/1\n标题：无\n作者：Ayo O\n播放位置：未知\n章节：无\n简介：无\n上下文（这条帖子的正文）：\nI reverse engineered tiktok\n');
  });

  it('上下文只有标题时不把标题再抄一遍：标题在咨询包里只出现一次', () => {
    const kubb = buildMusePackage({ snapshot: { site: 'kubb', videoId: '8aZsQlwuJ1E', url: 'https://www.kubb.tv/play/8aZsQlwuJ1E', title: '八仙！', position: 61, duration: 5400 }, question: '这一段在讲什么' });
    expect(kubb.text).toBe(
      ['平台：酷播', '页面链接：https://www.kubb.tv/play/8aZsQlwuJ1E', '标题：八仙！', '作者：无', '播放位置：01:01 / 1:30:00', '章节：无', '简介：无', '上下文：只有上面的标题（没有字幕 / 转写，也没有正文 / 描述）', '我的问题：这一段在讲什么', '', RULE].join('\n'),
    );
    expect(kubb.context).toBe('title');
    expect(kubb.text.split('八仙！')).toHaveLength(2);
    // B 站和酷播一样只有页面标题：UP 主、简介不读页面，写「无」
    const bili = buildMusePackage({ snapshot: { site: 'bilibili', videoId: 'ep733317', url: 'https://www.bilibili.com/bangumi/play/ep733317', title: '凡人修仙传第2集', position: 118, duration: 1076 }, question: '' });
    expect(bili.text).toContain('平台：B 站\n页面链接：https://www.bilibili.com/bangumi/play/ep733317\n标题：凡人修仙传第2集\n作者：无\n播放位置：01:58 / 17:56\n章节：无\n简介：无\n上下文：只有上面的标题');
    expect(bili.context).toBe('title');
    const none = buildMusePackage({ snapshot: { site: 'ig', videoId: 'Dfch523M0ca', url: 'https://www.instagram.com/p/Dfch523M0ca/', author: 'plain.user', position: 3, duration: 30 }, question: '' });
    expect(none.text).toContain('平台：Instagram\n');
    expect(none.text).toContain('上下文：无\n我的问题：无\n\n');
    expect(none.context).toBe('none');
  });

  it('没有的项写「无」、位置写「未知」，不编造；字幕要有位置才用', () => {
    const p = buildMusePackage({ snapshot: { site: 'youtube', videoId: VID }, captions, question: '   ' });
    expect(p.text).toBe([`平台：YouTube`, `页面链接：https://www.youtube.com/watch?v=${VID}`, '标题：无', '作者：无', '播放位置：未知', '章节：无', '简介：无', '上下文：无字幕', '我的问题：无', '', RULE].join('\n'));
    // 有章节但不知道播到哪：不猜是哪一章
    const q = buildMusePackage({ snapshot: { site: 'youtube', videoId: VID }, description: DESCRIPTION, question: '' });
    expect(q.text).toContain('\n章节：未知（播放位置没读到；这个视频分了 4 章）\n');
  });

  it('问题按原话写进去（多行也保留），只去掉首尾空白', () => {
    const p = buildMusePackage({ snapshot: youtube(), question: '  第一问？\n第二问 "why"？  ' });
    expect(p.text).toContain(`我的问题：第一问？\n第二问 "why"？\n\n${RULE}`);
  });

  it('字幕太长：从离冻结位置最远的丢起，并注明保留了哪一段', () => {
    // 100 到 145 秒每 5 秒一句，每句约 310 字：十句放不进 2000 字
    const long: MuseCaptions = { source: 'youtube-cc', cues: cueList(10, (i) => `${i}${'字'.repeat(300)}`).map((c) => ({ start: c.start + 100, text: c.text })) };
    const p = buildMusePackage({ snapshot: youtube({ position: 122 }), captions: long, question: '问' });
    expect(p.truncated).toBe(true);
    const kept = p.text.split('\n').filter((l) => /^\[\d\d:\d\d\] /.test(l));
    expect(kept.map((l) => l.slice(0, 7))).toEqual(['[01:50]', '[01:55]', '[02:00]', '[02:05]', '[02:10]', '[02:15]']);
    expect(p.text).toContain('（已截断：前后 30 秒共 10 句，只保留了离当前位置最近的 6 句（01:50–02:15））');
    expect([...kept.join('\n')].length).toBeLessThanOrEqual(MUSE.contextMaxChars);
  });

  it('一句就超长：只留它的开头，并注明', () => {
    const p = buildMusePackage({ snapshot: youtube(), captions: { source: 'auto', cues: [{ start: 120, text: '长'.repeat(5000) }] }, question: '问' });
    expect(p.truncated).toBe(true);
    expect(p.text).toContain('只保留了离当前位置最近的一句的开头');
    expect([...p.text].length).toBeLessThan(MUSE.contextMaxChars + 600);
  });

  it('正文太长：留开头，注明原文多长', () => {
    const body = `开头${'文'.repeat(4998)}`;
    const p = buildMusePackage({ snapshot: { site: 'x', videoId: '1', url: 'https://x.com/a/status/1', body }, question: '问' });
    expect(p.truncated).toBe(true);
    expect(p.text).toContain(`（已截断：原文约 5000 字，这里是开头的 ${MUSE.contextMaxChars} 字）`);
    expect(p.text).toContain(`开头${'文'.repeat(MUSE.contextMaxChars - 2)}…\n`);
    // 页面脚本已经先截过一次的：按它报的原文长度写
    const cut = buildMusePackage({ snapshot: { site: 'x', videoId: '1', url: 'https://x.com/a/status/1', body: '文'.repeat(3000), bodyTotal: 45000 }, question: '问' });
    expect(cut.text).toContain('原文约 45000 字');
  });

  it('表情（两个码元的字）不会被截成半个', () => {
    const p = buildMusePackage({ snapshot: { site: 'ig', videoId: 'a', url: 'https://www.instagram.com/p/DfZNnxxxjB1/', body: '🎬'.repeat(MUSE.contextMaxChars + 10) }, question: '问' });
    const half = [...p.text].some((ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff);
    expect(half).toBe(false);
  });
});

describe('咨询包里不出现 Key / 令牌', () => {
  it('你存在本机的 Key 原样出现时换掉（简介里的也算）', () => {
    const key = 'my-private-llm-key-123';
    const p = buildMusePackage({ snapshot: { site: 'x', videoId: '1', url: 'https://x.com/a/status/1', body: `看这个 ${key} 泄露了` }, question: `为什么 ${key} 不能用`, secrets: [key, undefined, 'short'] });
    expect(p.text).not.toContain(key);
    expect(p.text).toContain('看这个 [已隐藏] 泄露了');
    expect(p.redacted).toBe(true);
    const yt = buildMusePackage({ snapshot: youtube(), description: `演示用的 Key：${key}`, question: '问', secrets: [key] });
    expect(yt.text).toContain('演示用的 Key：[已隐藏]');
  });

  it('看起来像 Key / 令牌的内容换掉（页面文字、问题里的都算）', () => {
    const leaks = [
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv',
      'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      'sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'AIzaSyA1234567890abcdefghijklmnopqrstuvw',
      'ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxx',
      'GOCSPX-abcdefghijklmnopqrstuvwx',
      '1//0abcdefghijklmnopqrstuvwxyz0123456789',
    ];
    for (const leak of leaks) {
      const r = redactMuse(`前面 ${leak} 后面`);
      expect(r.text).toBe('前面 [已隐藏] 后面');
      expect(r.changed).toBe(true);
    }
    expect(redactMuse('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345').text).toBe('Authorization: Bearer [已隐藏]');
    expect(redactMuse('https://a.example/v?id=1&access_token=abc123def456&x=2').text).toBe('https://a.example/v?id=1&access_token=[已隐藏]&x=2');
    expect(redactMuse(`https://www.xiaohongshu.com/explore/${XHS_ID}?xsec_token=ABsecret%3D`).text).toBe(`https://www.xiaohongshu.com/explore/${XHS_ID}?xsec_token=[已隐藏]`);
  });

  it('普通文字不误伤：带连字符的词、YouTube 的 &t=、抖音的 modal_id', () => {
    const plain = [
      'the task-management-framework-for-large-teams-2026 talk',
      'risk-assessment-and-mitigation-strategies',
      `https://www.youtube.com/watch?v=${VID}&t=123s`,
      'https://www.douyin.com/jingxuan?modal_id=7704250528896716072',
      'https://www.kubb.tv/play/e2rCXFzJUz2?id=lIM07A3d3g8',
      'https://www.bilibili.com/video/BV1Kb411W75N/?p=5',
      'https://www.bilibili.com/bangumi/play/ep733317',
      '用 sk-learn 做聚类',
    ];
    for (const text of plain) expect(redactMuse(text)).toEqual({ text, changed: false });
  });

  it('本机的 Key 列表：LLM、X、Google 的 Key 和 YouTube 令牌都在里面', async () => {
    const kv = memoryKV();
    await stores.secrets.write(kv, { anthropicApiKey: 'ant-key-000001', openaiApiKey: 'oai-key-000002', xBearerToken: 'x-token-000003', googleClientSecret: 'g-secret-000004' });
    await stores.youtubeAuth.write(kv, { accessToken: 'yt-access-000005', refreshToken: 'yt-refresh-000006', connectedAt: NOW });
    expect(await museSecrets({ kv } as unknown as AppContext)).toEqual(['ant-key-000001', 'oai-key-000002', 'x-token-000003', 'g-secret-000004', 'yt-access-000005', 'yt-refresh-000006']);
  });
});

describe('X 帖子页的页面标题 → 作者和正文', () => {
  it('中文、英文界面；t.co 短链和通知数去掉', () => {
    expect(xPostParts('X 上的 Ayo O：“I reverse engineered tiktok https://t.co/TEV1YKfAZQ” / X')).toEqual({ author: 'Ayo O', text: 'I reverse engineered tiktok' });
    expect(xPostParts('(3) Ayo O on X: "I reverse engineered tiktok" / X')).toEqual({ author: 'Ayo O', text: 'I reverse engineered tiktok' });
    expect(xPostParts('X 上的 QuinLAN：“https://t.co/abcdefghij” / X')).toEqual({ author: 'QuinLAN' });
  });

  it('还在加载或不是帖子：没有；认不出写法：整段当正文', () => {
    expect(xPostParts('帖子 / X')).toBeUndefined();
    expect(xPostParts('X')).toBeUndefined();
    expect(xPostParts('')).toBeUndefined();
    expect(xPostParts('Some other title / X')).toEqual({ text: 'Some other title' });
  });
});

describe('冻结', () => {
  const VIDEO: FakeVideo = { id: VID, title: 'How transformers work', channelId: 'UCexplain', channelTitle: 'Explain Lab', publishedAt: '2026-10-20T00:00:00Z', duration: 'PT18M20S', views: 1, likes: 1, lang: 'en', description: DESCRIPTION };

  function makeCtx(opts: { authStatus?: string; videos?: FakeVideo[]; slowMs?: number } = {}) {
    const api = createFakeApi({ llm: () => ({}), videos: opts.videos ?? [VIDEO], search: () => [] });
    const http: typeof fetch = async (input, init) => {
      if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));
      return api.fetch(input, init);
    };
    const kv = memoryKV();
    const auth = { status: async () => opts.authStatus ?? 'connected', getToken: async () => 'tok', invalidate: async () => undefined, disconnect: async () => undefined } as unknown as AppContext['auth'];
    const ctx: AppContext = { kv, locker: memoryLocker(), http, now: () => NOW, auth, endpoints: ENDPOINTS, timeZone: 'Asia/Shanghai' };
    return { ctx, requests: api.requests, init: () => stores.settings.write(kv, mergeSettings(undefined)) };
  }

  /** 假的标签页：记下收到的消息，按类型回话 */
  function fakeTab(replies: Record<string, unknown>) {
    const sent: Record<string, unknown>[] = [];
    const send = async (msg: Record<string, unknown>) => {
      sent.push(msg);
      const r = replies[String(msg.type)];
      if (r instanceof Error) throw r;
      return r;
    };
    return { send, sent };
  }

  afterEach(() => vi.useRealTimers());

  it('"自动取 YouTube 字幕"默认开着，旧设置没有这一项时也是开', () => {
    expect(mergeSettings(undefined).muse).toEqual({ fetchCaptions: true });
    expect(mergeSettings({ clips: { enabled: false } }).muse.fetchCaptions).toBe(true);
    expect(mergeSettings({ muse: { fetchCaptions: false } }).muse.fetchCaptions).toBe(false);
  });

  it('标签页里没有 TubeMuse 的脚本：说明原因，不生成', async () => {
    const t = makeCtx();
    expect(await freezeMuse(t.ctx, fakeTab({ [MUSE_MSG.snapshot]: new Error('Could not establish connection') }).send)).toEqual({ ok: false, message: MUSE_NO_SCRIPT });
    expect(await freezeMuse(t.ctx, fakeTab({}).send)).toEqual({ ok: false, message: MUSE_NO_SCRIPT });
    expect(t.requests).toHaveLength(0);
  });

  it('认不出当前视频、或页面交回的东西对不上：给出原因', async () => {
    const t = makeCtx();
    const r = await freezeMuse(t.ctx, fakeTab({ [MUSE_MSG.snapshot]: { site: 'youtube', unavailable: '这个页面不是 YouTube 视频播放页：打开一个视频再点「问 muse」' } }).send);
    expect(r).toEqual({ ok: false, message: '这个页面不是 YouTube 视频播放页：打开一个视频再点「问 muse」' });
    const bad = await freezeMuse(t.ctx, fakeTab({ [MUSE_MSG.snapshot]: { site: 'x', videoId: '1', url: 'https://x.com/a/status/2' } }).send);
    expect(bad.ok).toBe(false);
    expect(t.requests).toHaveLength(0);
  });

  it('YouTube 以外的站：只问一次页面，不发任何网络请求、不问字幕', async () => {
    const t = makeCtx();
    const tab = fakeTab({ [MUSE_MSG.snapshot]: { site: 'douyin', videoId: '7704250528896716072', url: 'https://www.douyin.com/jingxuan?modal_id=7704250528896716072&from=grid', author: '云汉AI创投', body: '第13集', position: 3.2, duration: 20 } });
    const r = await freezeMuse(t.ctx, tab.send);
    expect(r).toEqual({ ok: true, freeze: { at: NOW, snapshot: { site: 'douyin', videoId: '7704250528896716072', url: 'https://www.douyin.com/jingxuan?modal_id=7704250528896716072', author: '云汉AI创投', body: '第13集', position: 3.2, duration: 20 }, notes: [] } });
    expect(tab.sent).toEqual([{ type: MUSE_MSG.snapshot }]);
    expect(t.requests).toHaveLength(0);
  });

  it('YouTube：作者和简介走官方 videos.list，查一次（1 unit）并记在本机，再问不再查；字幕让字幕脚本去取', async () => {
    const t = makeCtx();
    await t.init();
    const cc = { videoId: VID, label: 'English', autoTranslated: false, cues: [{ start: 100, text: 'Attention lets the model look back.' }] };
    const tab = fakeTab({ [MUSE_MSG.snapshot]: { site: 'youtube', videoId: VID, title: 'How transformers work', position: 123.7, duration: 1100 }, [MUSE_MSG.captions]: cc });
    const r = await freezeMuse(t.ctx, tab.send);
    expect(r.ok && r.freeze.snapshot).toEqual({ site: 'youtube', videoId: VID, title: 'How transformers work', author: 'Explain Lab', position: 123.7, duration: 1100 });
    expect(r.ok && r.freeze.captions).toEqual({ source: 'youtube-cc', label: 'English', cues: cc.cues });
    expect(r.ok && r.freeze.description).toBe(DESCRIPTION);
    expect(r.ok && r.freeze.notes).toEqual([]);
    expect(tab.sent).toEqual([{ type: MUSE_MSG.snapshot }, { type: MUSE_MSG.captions, t: 123.7, fetch: true }]);
    expect(t.requests).toHaveLength(1);
    const asked = new URL(t.requests[0]!.url);
    expect(asked.pathname.endsWith('/videos')).toBe(true);
    expect(asked.searchParams.get('part')).toBe('snippet');
    expect(asked.searchParams.get('id')).toBe(VID);
    expect((await stores.museVideos.read(t.ctx.kv))[VID]).toMatchObject({ channelTitle: 'Explain Lab', description: DESCRIPTION });
    await freezeMuse(t.ctx, tab.send);
    expect(t.requests).toHaveLength(1);
    // 拼出来的咨询包带着章节
    const p = r.ok ? buildMusePackage({ snapshot: r.freeze.snapshot, ...(r.freeze.description ? { description: r.freeze.description } : {}), question: '问' }) : undefined;
    expect(p?.text).toContain('章节：上一章 [00:00] Intro；当前 [01:30] Attention；下一章 [05:00] Training');
  });

  it('关掉"自动取 YouTube 字幕"：只问已经读到的（fetch: false）', async () => {
    const t = makeCtx();
    await t.init();
    const tab = fakeTab({ [MUSE_MSG.snapshot]: { site: 'youtube', videoId: VID, position: 5 }, [MUSE_MSG.captions]: { videoId: VID, cues: [], problem: '你关掉了"自动取 YouTube 字幕"，这个视频也没有已经读到的字幕' } });
    const r = await freezeMuse(t.ctx, tab.send, { fetchCaptions: false });
    expect(tab.sent[1]).toEqual({ type: MUSE_MSG.captions, t: 5, fetch: false });
    expect(r.ok && r.freeze.captions).toBeUndefined();
    expect(r.ok && r.freeze.notes).toEqual([`没有带上字幕：你关掉了"自动取 YouTube 字幕"，这个视频也没有已经读到的字幕。${MUSE_CAPTION_HINT}`]);
  });

  it('YouTube 字幕没取到：先用本机存的自动字幕；也没有才算没有，并说明原因、保留提示', async () => {
    const t = makeCtx();
    await t.init();
    const replies = { [MUSE_MSG.snapshot]: { site: 'youtube', videoId: VID, position: 120, duration: 600 }, [MUSE_MSG.captions]: { videoId: VID, cues: [], problem: '这个视频没有 YouTube 字幕' } };
    const none = await freezeMuse(t.ctx, fakeTab(replies).send);
    expect(none.ok && none.freeze.captions).toBeUndefined();
    expect(none.ok && none.freeze.notes).toEqual([`没有带上字幕：这个视频没有 YouTube 字幕。${MUSE_CAPTION_HINT}`]);
    await subtitleTrackStore(VID).write(t.ctx.kv, {
      videoId: VID,
      asrModel: 'browser',
      updatedAt: NOW,
      cues: [
        { id: 'a', start: 20, end: 24, text: 'too early', createdAt: NOW },
        { id: 'b', start: 110, end: 114, text: 'right here', createdAt: NOW },
        { id: 'c', start: 125, end: 128, text: '', createdAt: NOW },
      ],
    });
    const r = await freezeMuse(t.ctx, fakeTab(replies).send);
    expect(r.ok && r.freeze.captions).toEqual({ source: 'auto', cues: [{ start: 110, text: 'right here' }] });
    expect(r.ok && r.freeze.notes).toEqual([]);
    // 页面标题没读到时，标题也用官方接口给的
    expect(r.ok && r.freeze.snapshot.title).toBe('How transformers work');
    // 字幕脚本没应答（例如页面是扩展更新前打开的）：同样说明
    const silent = makeCtx();
    await silent.init();
    const r2 = await freezeMuse(silent.ctx, fakeTab({ [MUSE_MSG.snapshot]: replies[MUSE_MSG.snapshot] }).send);
    expect(r2.ok && r2.freeze.notes[0]).toContain('没有带上字幕：那个页面里的字幕脚本没有应答');
  });

  it('YouTube：没连接 / 查不到 / 广告中，都写明哪一项没取到，照样生成', async () => {
    const off = makeCtx({ authStatus: 'disconnected' });
    await off.init();
    const r1 = await freezeMuse(off.ctx, fakeTab({ [MUSE_MSG.snapshot]: { site: 'youtube', videoId: VID, title: 'T', gap: 'ad' } }).send);
    expect(r1.ok && r1.freeze.snapshot).toEqual({ site: 'youtube', videoId: VID, title: 'T', gap: 'ad' });
    expect(r1.ok && r1.freeze.notes.join('\n')).toMatch(/正在播广告[\s\S]*作者、简介和章节没取到：没有连接 YouTube/);
    // 广告中没有位置：不去取字幕，也不提"没有带上字幕"
    expect(r1.ok && r1.freeze.notes).toHaveLength(2);
    expect(off.requests).toHaveLength(0);
    // 没连接，但本机观看记录里有这个视频的资料：作者照用，只是简介和章节没有
    await stores.videoMeta.write(off.ctx.kv, { [VID]: { id: VID, title: 'From cache', channelId: 'UC1', channelTitle: 'Cached Channel', durationSec: 600, tags: [], fetchedAt: NOW } });
    const r3 = await freezeMuse(off.ctx, fakeTab({ [MUSE_MSG.snapshot]: { site: 'youtube', videoId: VID, gap: 'ad' } }).send);
    expect(r3.ok && r3.freeze.snapshot).toMatchObject({ author: 'Cached Channel', title: 'From cache' });
    expect(r3.ok && r3.freeze.notes[1]).toContain('简介和章节没取到：没有连接 YouTube');
    expect(r3.ok && r3.freeze.notes[1]).not.toContain('作者、');
    const gone = makeCtx({ videos: [] });
    await gone.init();
    const r2 = await freezeMuse(gone.ctx, fakeTab({ [MUSE_MSG.snapshot]: { site: 'youtube', videoId: VID, gap: 'shorts', shorts: true } }).send);
    expect(r2.ok && r2.freeze.snapshot.author).toBeUndefined();
    expect(r2.ok && r2.freeze.notes[1]).toContain('查不到这个视频');
  });

  it('YouTube：官方接口迟迟不回，最多等 5 秒就先生成，并说明没查到', async () => {
    vi.useFakeTimers();
    const t = makeCtx({ slowMs: 60_000 });
    await t.init();
    const pending = freezeMuse(t.ctx, fakeTab({ [MUSE_MSG.snapshot]: { site: 'youtube', videoId: VID, title: 'T', gap: 'ad' } }).send);
    await vi.advanceTimersByTimeAsync(MUSE.infoLookupMs + 10);
    const r = await pending;
    expect(r.ok && r.freeze.snapshot.author).toBeUndefined();
    expect(r.ok && r.freeze.notes[1]).toContain('5 秒内没有回应');
  });

  it('字幕脚本一直不回话：不干等，过了时限就说明', async () => {
    vi.useFakeTimers();
    const t = makeCtx({ authStatus: 'disconnected' });
    await t.init();
    const send = async (msg: Record<string, unknown>) => (msg.type === MUSE_MSG.snapshot ? { site: 'youtube', videoId: VID, position: 9 } : new Promise(() => undefined));
    const pending = freezeMuse(t.ctx, send);
    await vi.advanceTimersByTimeAsync(MUSE.captionFetchMs + 2100);
    const r = await pending;
    expect(r.ok && r.freeze.notes.join('\n')).toContain('没有带上字幕：那个页面一直没有回话');
  });

  it('没有视频的笔记：播放位置没读到，说明原因', async () => {
    const t = makeCtx();
    const r = await freezeMuse(t.ctx, fakeTab({ [MUSE_MSG.snapshot]: { site: 'xhs', videoId: XHS_ID, url: `https://www.xiaohongshu.com/explore/${XHS_ID}?xsec_token=AB`, title: '图文笔记', gap: 'no-video' } }).send);
    expect(r.ok && r.freeze.notes).toEqual(['这篇笔记里没找到视频（图文笔记，或视频还没出来），播放位置写的是「未知」']);
    expect(r.ok && r.freeze.snapshot.url).toBe(`https://www.xiaohongshu.com/explore/${XHS_ID}`);
  });
});
