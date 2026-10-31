// @ts-check
// e2e 用的本机 mock 服务：模拟 Google 授权页、YouTube Data API v3、Anthropic、OpenAI（含语音转写）、X、豆瓣评论 RSS，以及 YouTube 播放页。
// 只监听 127.0.0.1，记录每个请求供断言（例如 Key 只发往 LLM、令牌只发往 YouTube）。
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

export const PORT = 47321;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOUR = 3_600_000;

/** 豆瓣评论 RSS：35299923 用单测同一份夹具；1084336 是没有评论的图书；37322586 用于"跟随当前标签页"；其他 ID 返回 404 */
const DOUBAN_FEEDS = {
  35299923: readFileSync(new URL('../fixtures/douban-reviews.xml', import.meta.url), 'utf8'),
  1084336: '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>关于某书的最新评论</title><link>https://book.douban.com/subject/1084336/reviews</link></channel></rss>',
  37322586:
    '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>关于生日快乐的最新评论</title><link>https://movie.douban.com/subject/37322586/reviews</link>' +
    '<item><title>一场生日派对 (评论: 生日快乐)</title><link>https://movie.douban.com/review/17573365/</link><description><![CDATA[测试用户己评论: 生日快乐 (https://movie.douban.com/subject/37322586/)\n评价: 推荐\n\n撕开整座城市的缝隙...]]></description><dc:creator>测试用户己</dc:creator><pubDate>Mon, 27 Apr 2026 14:24:35 GMT</pubDate></item>' +
    '</channel></rss>',
};

/** @param {number} hoursAgo */
const ago = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

/**
 * @typedef {{ id: string; title: string; channelId: string; channelTitle: string; hoursAgo: number; duration: string; views: number; likes: number; lang?: string; caption?: boolean; description?: string; tags?: string[] }} MockVideo
 */

/** @type {MockVideo[]} */
const AI_VIDEOS = [
  { id: 'ai01', title: 'AI 技术科普：大模型到底是怎么"思考"的', channelId: 'UCsciA', channelTitle: '科普星球', hoursAgo: 5, duration: 'PT18M20S', views: 386000, likes: 21000, lang: 'zh', description: '用 15 分钟讲清楚大模型的原理，适合入门。' },
  { id: 'ai02', title: 'AI explained: how transformers actually work', channelId: 'UCexplain', channelTitle: 'Explain Lab', hoursAgo: 20, duration: 'PT14M02S', views: 120000, likes: 7400, lang: 'en', description: 'A visual explainer of attention and transformers.' },
  { id: 'ai03', title: '【震惊】AI 一夜之间改变世界？？', channelId: 'UCclick', channelTitle: '流量快报', hoursAgo: 3, duration: 'PT6M10S', views: 2400000, likes: 9000, lang: 'zh', description: '点赞关注' },
  { id: 'ai04', title: 'AI 技术周报：本周最值得关注的 5 个进展', channelId: 'UCweekly', channelTitle: 'AI 周报台', hoursAgo: 30, duration: 'PT22M', views: 18000, likes: 1300, lang: 'zh' },
  { id: 'ai05', title: 'AI #shorts 一分钟看懂 GPU', channelId: 'UCshort', channelTitle: '短知识', hoursAgo: 8, duration: 'PT45S', views: 90000, likes: 5000, lang: 'zh' },
  { id: 'ai06', title: '图解 AI：从神经网络到大模型（科普讲解）', channelId: 'UCsciA', channelTitle: '科普星球', hoursAgo: 40, duration: 'PT25M', views: 210000, likes: 15000, lang: 'zh' },
  { id: 'ai07', title: 'Large language models explained for beginners', channelId: 'UCedu', channelTitle: 'EduMinute', hoursAgo: 12, duration: 'PT11M', views: 56000, likes: 3100, lang: 'en' },
  { id: 'ai08', title: 'AI 芯片科普：为什么 GPU 这么重要', channelId: 'UChw', channelTitle: '硬件研究所', hoursAgo: 26, duration: 'PT16M', views: 74000, likes: 4200, lang: 'zh' },
  { id: 'ai09', title: '一周前的 AI 新闻回顾', channelId: 'UCnews', channelTitle: '科技新闻', hoursAgo: 150, duration: 'PT9M', views: 30000, likes: 900, lang: 'zh' },
  { id: 'ai10', title: 'What is AI alignment? (explained)', channelId: 'UCexplain', channelTitle: 'Explain Lab', hoursAgo: 44, duration: 'PT19M', views: 98000, likes: 6100, lang: 'en' },
  { id: 'ai11', title: 'AI 技术入门：机器学习的三种范式', channelId: 'UCedu2', channelTitle: '学点技术', hoursAgo: 16, duration: 'PT13M', views: 22000, likes: 1900, lang: 'zh' },
  { id: 'ai12', title: 'AI 视频生成技术科普', channelId: 'UCvideo', channelTitle: '影像实验室', hoursAgo: 35, duration: 'PT10M30S', views: 47000, likes: 2600, lang: 'zh' },
];

/** @type {MockVideo[]} */
const SAFETY_VIDEOS = [
  { id: 'sf01', title: 'AI safety interview: a conversation with an alignment researcher', channelId: 'UCpod', channelTitle: 'Frontier Pod', hoursAgo: 60, duration: 'PT1H32M', views: 150000, likes: 8800, lang: 'en', caption: true },
  { id: 'sf02', title: 'Interview: how labs think about AI risk', channelId: 'UCtalk', channelTitle: 'Deep Talks', hoursAgo: 100, duration: 'PT1H05M', views: 64000, likes: 3900, lang: 'en', caption: true },
  { id: 'sf03', title: 'AI safety in 60 seconds #shorts', channelId: 'UCquick', channelTitle: 'Quick Takes', hoursAgo: 30, duration: 'PT50S', views: 12000, likes: 400, lang: 'en', caption: true },
  { id: 'sf04', title: 'AI safety interview (no subtitles)', channelId: 'UCraw', channelTitle: 'Raw Audio', hoursAgo: 70, duration: 'PT1H10M', views: 8000, likes: 300, lang: 'en', caption: false },
  { id: 'sf05', title: 'AI 安全访谈（中文）', channelId: 'UCzh', channelTitle: '中文播客', hoursAgo: 50, duration: 'PT1H20M', views: 30000, likes: 2000, lang: 'zh', caption: true },
  { id: 'sf06', title: 'Short AI safety interview', channelId: 'UCshort2', channelTitle: 'Brief', hoursAgo: 40, duration: 'PT25M', views: 20000, likes: 900, lang: 'en', caption: true },
];

/** Phase 2：在 mock 播放页上真正"看"的视频（时长单位：秒） */
export const WATCH_VIDEOS = [
  { id: 'p2Complete01', seconds: 720, title: '机器学习入门：梯度下降讲解', channelId: 'UCp2learn', channelTitle: '机器学习课堂', categoryId: '27' },
  { id: 'p2Glance0002', seconds: 900, title: '搞笑合集 第 8 期', channelId: 'UCp2fun', channelTitle: '快乐每一天', categoryId: '24' },
  { id: 'p2Half000003', seconds: 1200, title: '神经网络课程 第 2 讲', channelId: 'UCp2learn', channelTitle: '机器学习课堂', categoryId: '27' },
];
/**
 * 自动字幕用的播放页：captions 决定播放器字幕按钮的样子（属性取自 2026-11 实测的 YouTube 播放器）。
 * 音频是"说话"的模拟：一段一段带谐波的声音，中间有停顿。
 */
export const SUBTITLE_VIDEOS = [
  { id: 'subNoCC00001', seconds: 14, captions: 'none' },
  { id: 'subHasCC0002', seconds: 10, captions: 'yes' },
  { id: 'subNoCC00003', seconds: 10, captions: 'none' },
  { id: 'subNoCC00004', seconds: 10, captions: 'none' },
  { id: 'subNoCC00005', seconds: 14, captions: 'none' },
  // 浏览器识别（e2e 里是按脚本出字的假识别器）；speech: 'network' 时它模拟"连不上语音服务"
  { id: 'subBrowse001', seconds: 14, captions: 'none' },
  { id: 'subBrowseNet', seconds: 10, captions: 'none', speech: 'network' },
];

const WATCH_AS_MOCK = WATCH_VIDEOS.map((w) => ({ id: w.id, title: w.title, channelId: w.channelId, channelTitle: w.channelTitle, hoursAgo: 200, duration: `PT${w.seconds}S`, views: 1000, likes: 10, lang: 'zh', categoryId: w.categoryId }));

/** Phase 3：新博主发现的候选（都未订阅；UCold 不活跃，不应被推荐） */
const NEW_CREATOR_VIDEOS = ['UCnewA', 'UCnewB', 'UCnewC', 'UCnewD', 'UCnewE', 'UCnewF', 'UCnewG'].flatMap((ch, i) =>
  [0, 1, 2, 3].map((j) => ({ id: `${ch.slice(2)}v${j}xxxxx`, title: `${ch.slice(-1)} 频道：AI 进阶第 ${j + 1} 课`, channelId: ch, channelTitle: `新锐频道 ${ch.slice(-1)}`, hoursAgo: 24 * (i + j + 1), duration: 'PT15M', views: 20000, likes: 900, lang: 'zh' })),
).concat([{ id: 'oldv0xxxxxxx', title: '很久以前的视频', channelId: 'UCold', channelTitle: '停更频道', hoursAgo: 24 * 300, duration: 'PT15M', views: 1, likes: 1, lang: 'zh' }]);

const ALL = [...AI_VIDEOS, ...SAFETY_VIDEOS, ...WATCH_AS_MOCK, ...NEW_CREATOR_VIDEOS];
const SUBSCRIPTIONS = [
  { id: 'UCsciA', title: '科普星球', description: '用动画讲科学与技术' },
  { id: 'UCexplain', title: 'Explain Lab', description: 'Visual explainers about AI and computing' },
  { id: 'UCcook', title: '深夜食堂', description: '家常菜教程' },
];
const LIKED = [AI_VIDEOS[0], AI_VIDEOS[1], AI_VIDEOS[5]];

/** @param {MockVideo} v */
function videoResource(v) {
  return {
    kind: 'youtube#video',
    id: v.id,
    snippet: {
      publishedAt: ago(v.hoursAgo),
      channelId: v.channelId,
      title: v.title,
      description: v.description ?? '',
      channelTitle: v.channelTitle,
      tags: v.tags ?? [],
      defaultAudioLanguage: v.lang,
      categoryId: /** @type {any} */ (v).categoryId,
      liveBroadcastContent: 'none',
      thumbnails: { medium: { url: `${ORIGIN}/thumb/${v.id}.png` } },
    },
    contentDetails: { duration: v.duration, caption: v.caption ? 'true' : 'false', definition: 'hd' },
    statistics: { viewCount: String(v.views), likeCount: String(v.likes) },
  };
}

const empty = (/** @type {Partial<Record<string, unknown>>} */ c) => ({
  label: '', importance: 'hard', terms: [], language: '', withinHours: 0, minMinutes: 0, maxMinutes: 0, format: 'none', aspect: 'none',
  channelNames: [], mode: 'none', minViews: 0, count: 0, sortBy: 'none', eventType: 'none', regionCode: '', description: '', ...c,
});

/** 假 LLM：按任务与口令返回固定的结构化结果（真实 LLM 的解析质量需手测） */
function llmAnswer(/** @type {string} */ system, /** @type {string} */ user) {
  if (system.includes('兴趣画像')) {
    return {
      clusters: [
        { name: 'AI 与计算科普', description: '人工智能原理与技术讲解', keywords: ['AI', '大模型', 'transformer', '机器学习', 'GPU'], channelRefs: ['c1', 'c2'], nature: 'learning' },
        { name: '做饭', description: '家常菜', keywords: ['菜谱', '做饭'], channelRefs: ['c3'], nature: 'other' },
      ],
    };
  }
  if (system.includes('只回复')) return { ok: true };
  if (system.includes('视频字幕翻译')) {
    // 当前这句形如"第 N 句：……"：译文带上同一个编号，便于断言哪句对哪句
    const n = /当前字幕：\n第 (\d+) 句/.exec(user)?.[1] ?? '?';
    return { translation: `Where was I? (${n})` };
  }
  if (system.includes('学习记录助手')) {
    // 像真 LLM 一样按观看程度挑：看完的进"学了什么"，部分观看的进"值得回看"
    const lines = user.split('\n');
    const refOf = (/** @type {string} */ status) => lines.find((l) => /^v\d+ \|/.test(l) && l.includes(`| ${status}`))?.split(' |')[0];
    const done = refOf('看完');
    const half = refOf('部分观看');
    return {
      headline: '今天主要在补机器学习基础',
      learned: done ? [{ ref: done, takeaway: '弄清了梯度下降的直觉' }] : [],
      revisit: half ? [{ ref: half, reason: '只看了一半，后半段是重点' }] : [],
      goalLink: '和"把大模型原理补上"的目标一致：今天打了基础。',
    };
  }
  if (system.includes('热点编辑')) {
    const refs = [...user.matchAll(/^(p\d+) \|/gm)].map((m) => m[1]);
    const names = ['智能体框架发布', '开源模型更新', '推理加速新方法', '多模态评测', '编程助手对比', '本地部署实践'];
    return {
      hotspots: refs.slice(0, 6).map((r, i) => ({ title: names[i % names.length], summary: '多位开发者在讨论这次发布的实测表现。', refs: [r], utterance: `找最近两天讲解${names[i % names.length]}的视频` })),
    };
  }
  if (system.includes('自省助手')) {
    const refs = [...user.matchAll(/^(r\d+) \|/gm)].map((m) => m[1]);
    return { overview: '低分主要来自英文速览和标题党。', patterns: [{ pattern: '标题党视频排得太靠前', suggestion: '继续给这类视频打低分，或在回显里加"排除词"', refs }] };
  }
  if (/Shorts/i.test(user)) {
    return {
      interpretation: '找近一周发布、一小时以上、带字幕的英文 AI 安全访谈，排除 Shorts',
      topic: 'AI 安全',
      queries: [{ q: 'AI safety interview', language: 'en' }],
      constraints: [
        empty({ kind: 'language', span: '英文', language: 'en' }),
        empty({ kind: 'duration', span: '一小时以上', minMinutes: 60 }),
        empty({ kind: 'recency', span: '近一周', withinHours: 168 }),
        empty({ kind: 'caption', span: '带字幕' }),
        empty({ kind: 'exclude_shorts', span: '不要 Shorts' }),
        empty({ kind: 'topic', span: 'AI 安全', terms: ['AI safety', 'AI 安全', 'alignment'] }),
        empty({ kind: 'format', span: '访谈', format: 'interview', terms: ['interview', '访谈', 'conversation'] }),
      ],
    };
  }
  return {
    interpretation: '找两天内发布的、讲解 AI 技术的科普视频，越新越好',
    topic: 'AI 技术',
    queries: [
      { q: 'AI 技术 科普', language: 'zh' },
      { q: 'AI explained', language: 'en' },
    ],
    constraints: [
      empty({ kind: 'recency', span: '两天内', withinHours: 48 }),
      empty({ kind: 'sort', span: '最新', sortBy: 'recency' }),
      empty({ kind: 'topic', span: 'AI 技术', terms: ['AI 技术', 'AI', '人工智能'] }),
      empty({ kind: 'format', span: '科普', format: 'explainer', terms: ['科普', '讲解', 'explained', 'explainer'] }),
    ],
  };
}

/** 8kHz、8 位单声道的静音 WAV（真实可播放，让内容脚本读到真实的播放器状态） */
const wavCache = new Map();
/** @param {number} seconds */
function silentWav(seconds) {
  if (wavCache.has(seconds)) return wavCache.get(seconds);
  const rate = 8000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n, 128);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n, 40);
  wavCache.set(seconds, buf);
  return buf;
}

/** 16kHz、16 位单声道的"说话"WAV：0.5 秒静音后，1.6 秒声音 + 0.8 秒停顿反复 */
const speechCache = new Map();
/** @param {number} seconds */
function speechWav(seconds) {
  if (speechCache.has(seconds)) return speechCache.get(seconds);
  const rate = 16000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const inBurst = t >= 0.5 && (t - 0.5) % 2.4 < 1.6;
    const v = inBurst ? 0.3 * (0.7 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 660 * t)) : 0;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  speechCache.set(seconds, buf);
  return buf;
}

let transcribeCounter = 0;
/**
 * 语音转写的模拟故障（只有测试脚本经 /e2e/transcribe-mode 设置，浏览器不会访问）：
 * ok = 正常；quota = 一直 429 credit_balance_exhausted；slowdown = 接下来 N 次 429 slow_down（带 Retry-After），之后正常
 */
/** @type {{ mode: 'ok' | 'quota' | 'slowdown'; remaining: number; retryAfter: number }} */
const transcribeFault = { mode: 'ok', remaining: 0, retryAfter: 0 };

// 1×1 PNG（缩略图占位）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8+P9/PQAJ1wN/0KxJWAAAAABJRU5ErkJggg==', 'base64');

/**
 * @typedef {{ method: string; path: string; query: Record<string, string>; headers: Record<string, string | string[] | undefined>; body: string }} Recorded
 */

let xCounter = 0;

export function startMockServer() {
  /** @type {Recorded[]} */
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', ORIGIN);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      };
      const send = (/** @type {number} */ status, /** @type {unknown} */ data) => {
        res.writeHead(status, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      const p = url.pathname;
      if (p === '/watch') {
        const id = url.searchParams.get('v') ?? '';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        const sv = SUBTITLE_VIDEOS.find((x) => x.id === id);
        if (sv) {
          const label = sv.captions === 'yes' ? 'Subtitles/closed captions' : 'Subtitles/closed captions unavailable';
          const tooltip = sv.captions === 'yes' ? 'Subtitles/closed captions (c)' : label;
          return res.end(
            `<!doctype html><html${/** @type {any} */ (sv).speech ? ` data-fake-speech="${/** @type {any} */ (sv).speech}"` : ''}><head><meta charset="utf-8"><title>mock watch</title><style>#movie_player{position:relative;width:640px;height:360px;background:#000}#player{width:100%;height:100%}.ytp-chrome-bottom{position:absolute;left:12px;right:12px;bottom:0;height:48px}</style></head>` +
              `<body><div id="movie_player" class="html5-video-player ytp-autohide"><video id="player" preload="auto" src="/media/${id}.wav"></video>` +
              `<div class="ytp-chrome-bottom"><button class="ytp-subtitles-button ytp-button" aria-keyshortcuts="c" data-tooltip-title="${tooltip}" data-title-no-tooltip="${label}" aria-pressed="false" aria-label="${label}">CC</button></div></div></body></html>`,
          );
        }
        return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>mock watch</title></head><body><div id="movie_player"><video id="player" preload="auto" src="/media/${id}.wav"></video></div></body></html>`);
      }
      if (p.startsWith('/media/')) {
        const id = p.slice('/media/'.length).replace(/.wav$/, '');
        const w = WATCH_VIDEOS.find((x) => x.id === id) ?? SUBTITLE_VIDEOS.find((x) => x.id === id);
        if (!w) return send(404, {});
        const wav = SUBTITLE_VIDEOS.includes(/** @type {any} */ (w)) ? speechWav(w.seconds) : silentWav(w.seconds);
        const range = /bytes=(d+)-(d*)/.exec(String(req.headers.range ?? ''));
        if (range) {
          const start = Number(range[1]);
          const end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
          res.writeHead(206, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${wav.length}`, 'content-length': end - start + 1 });
          return res.end(wav.subarray(start, end + 1));
        }
        res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': wav.length });
        return res.end(wav);
      }
      if (p === '/youtube/v3/playlistItems') {
        const ch = 'UC' + (url.searchParams.get('playlistId') ?? '').slice(2);
        return send(200, {
          items: ALL.filter((v) => v.channelId === ch).map((v) => ({ snippet: { title: v.title, videoOwnerChannelTitle: v.channelTitle, resourceId: { videoId: v.id } }, contentDetails: { videoId: v.id, videoPublishedAt: ago(v.hoursAgo) } })),
        });
      }
      if (p.startsWith('/thumb/')) {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(PNG);
      }
      if (p === '/youtube/v3/search') {
        const q = url.searchParams.get('q') ?? '';
        // 新博主发现用"|"连接关键词
        const pool = q.includes('|') ? [...NEW_CREATOR_VIDEOS, ...AI_VIDEOS.slice(0, 3)] : /safety/i.test(q) ? SAFETY_VIDEOS : AI_VIDEOS;
        const after = url.searchParams.get('publishedAfter');
        const items = pool.filter((v) => !after || Date.now() - v.hoursAgo * HOUR >= Date.parse(after));
        const page = url.searchParams.get('pageToken') ? [] : items;
        return send(200, {
          items: page.map((v) => ({ id: { kind: 'youtube#video', videoId: v.id }, snippet: { channelId: v.channelId, channelTitle: v.channelTitle, title: v.title } })),
          ...(url.searchParams.get('pageToken') ? {} : { nextPageToken: 'P2' }),
        });
      }
      if (p === '/youtube/v3/videos') {
        if (url.searchParams.get('myRating') === 'like') return send(200, { items: LIKED.map(videoResource) });
        const ids = (url.searchParams.get('id') ?? '').split(',');
        return send(200, { items: ALL.filter((v) => ids.includes(v.id)).map(videoResource) });
      }
      if (p === '/youtube/v3/channels') {
        const ids = (url.searchParams.get('id') ?? '').split(',');
        return send(200, {
          items: ids.map((id) => ({
            id,
            snippet: { title: SUBSCRIPTIONS.find((s) => s.id === id)?.title ?? ALL.find((v) => v.channelId === id)?.channelTitle ?? id, description: '' },
            statistics: { subscriberCount: String(10000 + id.length * 37000) },
            topicDetails: { topicCategories: ['https://en.wikipedia.org/wiki/Technology', 'https://en.wikipedia.org/wiki/Knowledge'] },
            contentDetails: { relatedPlaylists: { uploads: 'UU' + id.slice(2) } },
          })),
        });
      }
      if (p === '/youtube/v3/subscriptions') {
        return send(200, {
          pageInfo: { totalResults: SUBSCRIPTIONS.length },
          items: SUBSCRIPTIONS.map((s) => ({ snippet: { title: s.title, description: s.description, resourceId: { kind: 'youtube#channel', channelId: s.id } } })),
        });
      }
      if (p === '/anthropic/v1/messages' && req.method === 'POST') {
        const b = JSON.parse(body || '{}');
        const out = llmAnswer(String(b.system ?? ''), String(b.messages?.[0]?.content ?? ''));
        return send(200, {
          id: 'msg_e2e',
          type: 'message',
          role: 'assistant',
          model: b.model,
          content: [{ type: 'text', text: JSON.stringify(out) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 100 },
        });
      }
      if (p === '/e2e/transcribe-mode') {
        transcribeFault.mode = /** @type {any} */ (url.searchParams.get('mode') ?? 'ok');
        transcribeFault.remaining = Number(url.searchParams.get('times') ?? 1);
        transcribeFault.retryAfter = Number(url.searchParams.get('retryAfter') ?? 0);
        return send(200, { ok: true });
      }
      if (p === '/openai/v1/audio/transcriptions' && req.method === 'POST') {
        // 错误体与官方 error-codes 页一致：额度 / 账单类也是 429，靠 error.code 区分
        if (transcribeFault.mode === 'quota') {
          return send(429, { error: { message: 'Your organization has no prepaid credits remaining.', type: 'insufficient_quota', code: 'credit_balance_exhausted', param: null } });
        }
        if (transcribeFault.mode === 'slowdown' && transcribeFault.remaining > 0) {
          transcribeFault.remaining--;
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(transcribeFault.retryAfter), ...cors });
          return res.end(JSON.stringify({ error: { message: 'Your request rate increased too quickly.', type: 'rate_limit_error', code: 'slow_down', param: null } }));
        }
        transcribeCounter++;
        return send(200, { text: `第 ${transcribeCounter} 句：我说到哪里了`, languages: [{ code: 'zh' }], usage: { type: 'duration', seconds: 2 } });
      }
      if (p === '/openai/v1/responses' && req.method === 'POST') {
        const b = JSON.parse(body || '{}');
        const out = llmAnswer(String(b.instructions ?? ''), String(b.input ?? ''));
        return send(200, {
          id: 'resp_e2e',
          object: 'response',
          created_at: 0,
          status: 'completed',
          model: b.model,
          output: [{ type: 'message', id: 'm', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(out), annotations: [] }] }],
        });
      }
      if (p === '/x/2/tweets/search/recent') {
        const max = Number(url.searchParams.get('max_results') ?? 10);
        const query = url.searchParams.get('query') ?? '';
        xCounter++;
        // 每次请求返回新的帖子 ID（模拟不断出现的新帖子，不触发当天去重）
        const data = Array.from({ length: max }, (_, i) => ({
          id: String(1_900_000_000_000_000_000n + BigInt(xCounter * 1000 + i)),
          text: `关于 ${query.replace(/[()]/g, '').split(' OR ')[0]} 的讨论 #${i + 1}：最新的智能体框架发布了，大家都在测评`,
          created_at: ago(1 + (i % 5)),
          lang: 'zh',
          public_metrics: { like_count: 500 - i * 10, repost_count: 80 - i, reply_count: 12, quote_count: 3 },
        }));
        return send(200, { data, meta: { result_count: data.length } });
      }
      const douban = /^\/douban\/feed\/subject\/(\d+)\/reviews$/.exec(p);
      if (douban) {
        const xml = /** @type {Record<string, string>} */ (DOUBAN_FEEDS)[douban[1] ?? ''];
        // 真实的豆瓣 RSS 不带 CORS 头：扩展靠 host_permissions 读取，这里也不给
        res.writeHead(xml ? 200 : 404, { 'content-type': 'text/xml; charset=utf-8' });
        return res.end(xml ?? '');
      }
      if (p === '/oauth/revoke') return send(200, {});
      // 模拟 Google 授权页：校验后直接 302 回跳 https://<扩展ID>.chromiumapp.org/#access_token=…（隐式授权）
      if (p === '/oauth/authorize') {
        const q = url.searchParams;
        const redirect = q.get('redirect_uri') ?? '';
        if (!/^https:\/\/[a-p]{32}\.chromiumapp\.org\/$/.test(redirect) || q.get('response_type') !== 'token') return send(400, { error: 'invalid_request' });
        const frag = new URLSearchParams({ access_token: 'e2e-fake-token', token_type: 'Bearer', expires_in: '3599', scope: q.get('scope') ?? '', state: q.get('state') ?? '' });
        res.writeHead(302, { location: `${redirect}#${frag.toString()}` });
        return res.end();
      }
      send(404, { error: { code: 404, message: `mock: no route ${p}` } });
    });
  });
  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => resolve({ server, requests }));
  });
}
