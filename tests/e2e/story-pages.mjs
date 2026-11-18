// @ts-check
// e2e 用的「故事」页面（由 mock 服务提供）：
// - 仿新闻页 /news/<slug>：页面自己声明的元数据（og、article:published_time、JSON-LD NewsArticle），正文在 <article> 里；
//   页头导航、侧栏推荐、页脚、隐藏的段落、翻译扩展插进来的译文都不该被读到。
// - 仿 X 帖子页 /xpage/elonmusk/status/<ID>：结构照 2026-11-18 的真实帖子页（用户给的例子：Elon Musk 转引 Eric Daugherty）：
//   主帖 <article data-testid="tweet">，包着发布时间的链接指向这条帖子；引用的帖子是 role="link" 的块，有自己的 User-Name、tweetText、<time>；
//   互动数据在按钮组的 aria-label 里；翻译扩展（沉浸式翻译）在原文后面插了中文译文；下面还有一条回复（不该被读到）。
// 文字和数字照用户的截图；页面记下自己的 DOM 变化和点击次数，用来确认 TubeMuse 只读不写、不点。

export const STORY_X_POST = { user: 'elonmusk', id: '2122810772967575759' };
export const STORY_NEWS_SLUG = 'faa-starlink-duffy';

const WATCH = `window.__mutations = 0; window.__clicks = 0;
document.addEventListener('click', () => window.__clicks++, true);
new MutationObserver((list) => (window.__mutations += list.length)).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });`;

/** @param {string} title @param {string} head @param {string} body */
const page = (title, head, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}<script>${WATCH}</script></body></html>`;

/** 翻译扩展插进原文里的译文（沉浸式翻译的写法） */
const translated = (/** @type {string} */ zh) =>
  `<font class="notranslate immersive-translate-target-wrapper" lang="zh-CN"><font class="notranslate immersive-translate-target-translation-theme-highlight">${zh}</font></font>`;

function newsPage() {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: 'Duffy says FAA wants a ground-based network, not free Starlink',
    datePublished: '2026-11-17T12:00:00Z',
    dateModified: '2026-11-17T15:30:00Z',
    author: [{ '@type': 'Person', name: 'Jane Reporter' }],
    publisher: { '@type': 'Organization', name: 'Example News' },
  };
  const head =
    `<meta property="og:title" content="Duffy: FAA wants a ground-based network, not free Starlink">` +
    `<meta property="og:site_name" content="Example News">` +
    `<meta property="og:description" content="The transportation secretary responded to Elon Musk's claim that he offered free Starlink service.">` +
    `<meta name="author" content="Jane Reporter">` +
    `<meta property="article:published_time" content="2026-11-17T12:00:00Z">` +
    `<link rel="canonical" href="/news/${STORY_NEWS_SLUG}">` +
    `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
  const body =
    `<header><nav><ul><li>Home</li><li>World</li><li>Business — nav junk that is long enough</li></ul></nav></header>` +
    `<main><article><h1>Duffy: FAA wants a ground-based network</h1>` +
    `<p>Transportation Secretary Sean Duffy on Monday responded to Elon Musk, who said he had offered the Trump administration free Starlink service for the Federal Aviation Administration.</p>` +
    `<p>"We thought that the best method is to have a network based on the ground," Duffy told reporters.${translated('我们认为最好的方法是建立一个基于地面的网络。')}</p>` +
    `<p style="display:none">Hidden paragraph that should never be read.</p>` +
    `<h2>Background</h2><p>The FAA is in the middle of a multiyear effort to modernize its air traffic control systems.</p>` +
    `<aside><p>Related: an aside recommendation that should not be read.</p></aside>` +
    `</article></main>` +
    `<footer><p>Copyright Example News. Footer text that should not be read.</p></footer>`;
  return page('Duffy responds to Musk - Example News', head, body);
}

/** 帖子头：作者名、@用户名，以及包着发布时间的帖子链接 */
const userName = (/** @type {string} */ name, /** @type {string} */ user, /** @type {string} */ time) =>
  `<div data-testid="User-Name"><div><a href="/xpage/${user}" role="link"><span>${name}</span></a></div>` +
  `<div><a href="/xpage/${user}" role="link" tabindex="-1"><span>@${user}</span></a>${time}</div></div>`;

function xStoryPage() {
  const { user, id } = STORY_X_POST;
  const quoted =
    `<div role="link" tabindex="0" id="story-quote">` +
    `<div data-testid="User-Name"><span>Eric Daugherty</span><span>@EricLDaugh</span><span>·</span><time datetime="2026-11-17T10:12:00.000Z">12小时</time></div>` +
    `<div data-testid="tweetText"><img alt="🚨" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="16" height="16"><span> JUST IN: Sec. Sean Duffy RESPONDS to Elon Musk saying he offered the Trump admin FREE Starlink for the FAA, but was turned down</span>` +
    translated('最新消息：肖恩·达菲部长回应了埃隆·马斯克的说法') +
    `<span>\n\n"We thought that the best method is to have a network [that's] based on the ground."</span></div>` +
    `<div data-testid="videoPlayer"><video preload="none" src="/xpage/media/11.wav"></video></div></div>`;
  const main =
    `<article data-testid="tweet" id="story-main">` +
    userName('Elon Musk', user, '') +
    `<div data-testid="tweetText"><img alt="🤷‍♂️" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="16" height="16"></div>` +
    quoted +
    `<div><a href="/xpage/${user}/status/${id}" role="link"><time datetime="2026-11-17T21:55:00.000Z">上午5:55 · 2026年11月18日</time></a> · <span>420.4万</span> 查看</div>` +
    `<div role="group" aria-label="2943 回复、3756 次转帖、40041 喜欢次数、2184 书签、4204000 次观看">` +
    `<button data-testid="reply" aria-label="2943 回复。回复">2,943</button><button data-testid="retweet" aria-label="3756 次转帖。转帖">3,756</button>` +
    `<button data-testid="like" aria-label="40041 喜欢次数。喜欢">4万</button><button data-testid="bookmark" aria-label="2184 书签。书签">2,184</button></div>` +
    `</article>`;
  const reply =
    `<article data-testid="tweet" id="story-reply">` +
    userName('Some Replier', 'replier', ` · <a href="/xpage/replier/status/2122899999999999999" role="link"><time datetime="2026-11-17T22:00:00.000Z">1小时</time></a>`) +
    `<div data-testid="tweetText"><span>This reply text must never be read by TubeMuse</span></div></article>`;
  return page('X 上的 Elon Musk：“🤷‍♂️” / X', '', `<div id="app">${main}${reply}</div>`);
}

/** @param {string} path 认不出的返回 undefined */
export function storyPage(path) {
  if (path === `/news/${STORY_NEWS_SLUG}`) return newsPage();
  if (path === `/xpage/${STORY_X_POST.user}/status/${STORY_X_POST.id}`) return xStoryPage();
  return undefined;
}

/** 假的联网调研（照 Anthropic 文档里 web search 的响应结构）：一次搜索、两个结果、一段带引用的笔记，外加一次出错的搜索 */
export function storyResearchContent() {
  return [
    { type: 'text', text: '先查 Duffy 的回应和马斯克的原话。' },
    { type: 'server_tool_use', id: 'srvtoolu_e2e1', name: 'web_search', input: { query: 'Sean Duffy Starlink FAA ground network' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_e2e1',
      content: [
        { type: 'web_search_result', url: 'https://www.reuters.com/world/us/duffy-musk-starlink-faa-2026-11-17/', title: 'Duffy responds to Musk on Starlink offer', encrypted_content: 'enc-1', page_age: 'November 17, 2026' },
        { type: 'web_search_result', url: 'https://apnews.com/article/faa-air-traffic-control-modernization', title: 'FAA air traffic control modernization', encrypted_content: 'enc-2', page_age: 'November 10, 2026' },
      ],
    },
    { type: 'server_tool_use', id: 'srvtoolu_e2e2', name: 'web_search', input: { query: 'Musk offered free Starlink FAA' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_e2e2', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    {
      type: 'text',
      text: 'Duffy 说最好的办法是地面网络。',
      citations: [
        { type: 'web_search_result_location', url: 'https://www.reuters.com/world/us/duffy-musk-starlink-faa-2026-11-17/', title: 'Duffy responds to Musk on Starlink offer', encrypted_index: 'ei-1', cited_text: '"We thought that the best method is to have a network based on the ground," Duffy said.' },
      ],
    },
    {
      type: 'text',
      text: 'FAA 正在推进空管系统现代化。',
      citations: [{ type: 'web_search_result_location', url: 'https://apnews.com/article/faa-air-traffic-control-modernization', title: 'FAA air traffic control modernization', encrypted_index: 'ei-2', cited_text: 'The FAA is modernizing its air traffic control system.' }],
    },
  ];
}

/** 假的整理结果：一条有来源的"已证实"、一条只有页面本身的"已证实"（应被降级）、一个编造的来源编号（应被去掉） */
export function storyBriefAnswer() {
  return {
    headline: 'Duffy 回应马斯克：FAA 要的是地面网络',
    summary: '马斯克说曾向特朗普政府免费提供 Starlink 给 FAA 用、被拒绝；交通部长 Duffy 回应说，他们认为最好的办法是地面网络。',
    claims: [
      { text: 'Duffy 说最好的办法是建立基于地面的网络', speaker: 'Sean Duffy', status: 'confirmed', note: '路透社报道了原话', sources: ['S1'] },
      { text: '马斯克曾免费提供 Starlink 但被拒绝', speaker: 'Elon Musk', status: 'confirmed', note: '目前只有马斯克一方的说法', sources: ['P'] },
    ],
    timeline: [
      { when: '2026-11-10', event: 'FAA 推进空管系统现代化', sources: ['S2'] },
      { when: '2026-11-17', event: 'Duffy 回应马斯克', sources: ['S1', 'S7'] },
    ],
    perspectives: [{ who: '交通部长 Sean Duffy', stance: '倾向地面网络', sources: ['S1'] }],
    context: [{ text: 'FAA 的空管系统正在升级', status: 'confirmed', note: '', sources: ['S2'] }],
    analysis: [{ text: '这显示政府在关键基础设施上不想依赖单一供应商', sources: ['S1'] }],
    openQuestions: ['马斯克的提议具体包括什么？'],
    caveat: '马斯克的说法目前只有他本人一方。',
  };
}
