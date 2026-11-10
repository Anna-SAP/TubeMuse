// @ts-check
// e2e 用的仿 Instagram 网页版页面（由 mock 服务在 /igpage/ 下提供，首页信息流就是 /igpage/ 本身）。结构照 2026-11-10 实测的真实首页：
// - 每条帖子是一个 <article>；帖子自己的链接是包着 <time> 的 <a href="/p/短码/">；广告帖子没有 <time>；
// - 帖子里第一个指向个人主页的链接（/用户名/）是作者；视频包在一个 /reels/短码/ 的链接里；
// - 正文在视频下面：span[dir="auto"] 里套着 span[dir="auto"]，同一个块里有作者的链接；折叠的"... 更多"在旁边另一个元素里；
// - 没播过的视频和自动播放的视频都是静音的（X 上没播过的反而没静音）；打开声音是 muted=false、音量大于 0；
// - 视频放到结尾自己跳回开头接着放：没有 loop 属性，也不报"播完"。
// "视频"是一段有声音的 WAV（同源，与真实页面的 blob: 流一样读得到）。
// 页面记下自己元素上的点击次数，用来确认 TubeMuse 从不替你点赞、关注、点"更多"或点播放器。

/** 带正文的普通帖子：正文里有两个话题、表情和换行，后面折叠着"... 更多" */
export const IG_FEED_POST = {
  code: 'DfZNnxxxjB1',
  user: 'feed_user',
  title: 'feed_user - 《#地球娛樂室》 #兔瓏 來台灣啦🐰🍡',
  seconds: 6,
};
/** 没有正文的帖子，下面露着一条别人的评论（不能被当成正文） */
export const IG_PLAIN_POST = { code: 'Dfch523M0ca', user: 'plain.user', seconds: 30 };
const AD_SECONDS = 7;

const media = (/** @type {number} */ seconds) => `/igpage/media/${seconds}.wav`;

/** 帖子头：作者（个人主页链接）、发布时间（包着帖子链接；广告没有）、音频页链接 */
const header = (/** @type {string} */ user, /** @type {string} */ code) =>
  `<div><span dir="auto"><span><a href="/igpage/${user}/" role="link"><div><div><span dir="auto">${user}</span></div></div></a></span></span>` +
  (code ? `<span dir="auto"><span>•</span></span><a href="/igpage/p/${code}/" role="link"><span dir="auto"><time datetime="2026-11-07T04:05:00.000Z">3天</time></span></a>` : '') +
  `<span dir="auto"><div><a href="/igpage/reels/audio/970549657221125/" role="link">原创音频</a></div></span></div>`;

/** 播放器：视频包在 /reels/短码/ 的链接里，旁边是音量条和喇叭 */
const player = (/** @type {string} */ code, /** @type {number} */ seconds, attrs = 'muted') =>
  `<div aria-label="Video player" role="group"><a href="/igpage/reels/${code}/" role="link"><video playsinline preload="auto" src="${media(seconds)}" style="width: 468px; height: 300px; display: block" ${attrs}></video></a>` +
  `<div role="slider" aria-label="调整音量" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div><div role="button"><svg aria-label="已静音" role="img" width="16" height="16"></svg></div></div>`;

const actions = `<section><div role="button" data-testid="like"><svg aria-label="赞" role="img" width="16" height="16"></svg></div><span role="button">114</span></section>`;

/** 视频下面的一块文字：谁（个人主页链接）说了什么；折叠的部分在旁边另一个元素里 */
const textBox = (/** @type {string} */ user, /** @type {string} */ html, more = '') =>
  `<div><div><span><span><div><a href="/igpage/${user}/" role="link"><div><span dir="auto">${user}</span></div></a></div></span></span></div>` +
  `<span dir="auto"><div><span dir="auto">${html}</span></div>${more}</span></div>`;

function feed() {
  const ad = `<article id="ig-ad">${header('aiapply.co', '')}${player('adadadadad1', AD_SECONDS, 'muted autoplay')}<a href="/igpage/ads_redirect/" role="link">查看详情</a>${actions}${textBox('aiapply.co', '广告的正文')}</article>`;
  const caption =
    `《<a href="/igpage/explore/tags/%E5%9C%B0%E7%90%83%E5%A8%9B%E6%A8%82%E5%AE%A4/" role="link">#地球娛樂室</a>》 ` +
    `<a href="/igpage/explore/tags/%E5%85%94%E7%93%8F/" role="link">#兔瓏</a> 來台灣啦🐰🍡<br><br>`;
  const post =
    `<article id="ig-post">${header(IG_FEED_POST.user, IG_FEED_POST.code)}${player(IG_FEED_POST.code, IG_FEED_POST.seconds)}${actions}` +
    `${textBox(IG_FEED_POST.user, caption, '<span>... <div role="button"><span dir="auto">更多</span></div></span>')}</article>`;
  const plain =
    `<article id="ig-plain">${header(IG_PLAIN_POST.user, IG_PLAIN_POST.code)}${player(IG_PLAIN_POST.code, IG_PLAIN_POST.seconds)}${actions}` +
    `${textBox('someone_else', '别人的评论，不是这条帖子的正文')}</article>`;
  return ad + post + plain + `<div style="height: 2400px"></div>`;
}

// Instagram 自己的行为：快放到结尾时跳回开头接着放（不让视频走到"播完"）
const LOOP =
  `setInterval(() => { for (const v of document.querySelectorAll('article video')) {` +
  ` if (!v.paused && Number.isFinite(v.duration) && v.duration - v.currentTime < 0.15) v.currentTime = 0; } }, 30);`;
const CLICK_COUNTER = `window.__nativeClicks = 0; document.addEventListener('click', () => window.__nativeClicks++, true);`;

function homePage() {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Instagram</title><style>body { margin: 0; font-family: system-ui, sans-serif; } article { margin-bottom: 24px; }</style></head>` +
    `<body><div id="app"><main>${feed()}</main></div><script>${CLICK_COUNTER}${LOOP}</script></body></html>`
  );
}

/** /igpage/media/<秒数>.wav：这段"视频"有多少秒；不是媒体路径返回 undefined */
export function igMediaSeconds(/** @type {string} */ path) {
  const m = /^\/igpage\/media\/(\d+)\.wav$/.exec(path);
  return m ? Number(m[1]) : undefined;
}

/** @param {string} path /igpage/ 开头的路径；认不出的返回 undefined（mock 回 404） */
export function igPage(path) {
  return path === '/igpage/' ? homePage() : undefined;
}
