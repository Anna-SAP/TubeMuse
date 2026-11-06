// @ts-check
// e2e 用的仿 X 网页版页面（由 mock 服务在 /xpage/ 下提供；mock 的 /x/ 是 X 官方 API，不要混用）。结构照 2026-11-06 实测的真实帖子页：
// - 一页有好几个 <video>：主帖的视频静音自动播放；回复里的视频比主帖的大，排在后面、暂停着、在屏幕外；
// - 全屏视图 /video/1 的视频在 [role="dialog"] 里，弹层底下的帖子页还留着一个被盖住、没加载的 <video>；
// - 动图（GIF）是 video.twimg.com 的跨站视频，不是 blob:（e2e 里由 Playwright 在本地应答）；
// - 从时间线进帖子是站内跳转，不重新加载页面：录制脚本在时间线上就要注入好。
// "视频"是一段有声音的 WAV（同源，与真实页面的 blob: 流一样读得到）。
// 页面记下自己元素上的点击次数，用来确认 TubeMuse 从不替你点赞、关注或点播放器。

export const X_POST = {
  id: '2117650684774580249',
  user: 'ayoships',
  docTitle: 'X 上的 Ayo O：“I reverse engineered tiktok https://t.co/TEV1YKfAZQ” / X',
  title: 'Ayo O - I reverse engineered tiktok',
  seconds: 20,
};
/** 回复里的视频：比主帖的大，时长也不同，用来分辨录的是哪一个 */
const REPLY_SECONDS = 30;
/** 全屏视图底下被盖住的视频：时长不同，用来分辨录的是哪一个 */
const UNDERLAY_SECONDS = 7;
/** 主帖是动图 */
export const X_GIF_POST = { id: '2117728318107619657', user: 'QuinLANjr', src: 'https://video.twimg.com/tweet_video/e2e-loop.mp4' };
/** 没有视频的文字帖子 */
export const X_TEXT_POST = { id: '2117000000000000001', user: 'ayoships' };

const media = (/** @type {number} */ seconds) => `/xpage/media/${seconds}.wav`;

/** @param {string} src @param {string} style @param {string} [attrs] */
const player = (src, style, attrs = '') =>
  `<div data-testid="videoPlayer"><div data-testid="videoComponent"><video preload="auto" playsinline aria-label="嵌入式视频" tabindex="-1" src="${src}" style="${style}" ${attrs}></video></div></div>`;

/** 主帖 + 互动按钮 + 下面很远处的回复（真实页面上回复视频在屏幕外） */
const post = (/** @type {string} */ mainPlayer) =>
  `<article data-testid="tweet" id="main">${mainPlayer}<button data-testid="like">喜欢</button></article>` +
  `<div style="height: 1800px"></div>` +
  `<article data-testid="tweet" id="reply">${player(media(REPLY_SECONDS), 'width: 518px; height: 518px; display: block')}</article>`;

const CLICK_COUNTER = `window.__nativeClicks = 0; document.addEventListener('click', () => window.__nativeClicks++, true);`;

/** @param {string} title @param {string} body @param {string} [script] */
const page = (title, body, script = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body { margin: 0; font-family: system-ui, sans-serif; }</style></head>` +
  `<body><div id="app">${body}</div><script>${CLICK_COUNTER}${script}</script></body></html>`;

/** 时间线：window.__openPost() 模拟点进帖子（站内跳转、分享参数都带着，不重新加载页面） */
function homePage() {
  const html = post(player(media(X_POST.seconds), 'width: 286px; height: 508px; display: block'));
  const open =
    `window.__openPost = () => {` +
    ` document.title = ${JSON.stringify(X_POST.docTitle)};` +
    ` document.getElementById('app').innerHTML = ${JSON.stringify(html)};` +
    ` history.pushState(null, '', '/xpage/${X_POST.user}/status/${X_POST.id}?s=20&t=sharerToken');` +
    ` const v = document.querySelector('#main video'); v.muted = true; return v.play(); };`;
  return page('主页 / X', `<article data-testid="tweet">${player(media(UNDERLAY_SECONDS), 'width: 400px; height: 225px; display: block')}</article>`, open);
}

/** 全屏视图：弹层盖住整页，底下的主帖视频没有加载 */
function videoViewPage() {
  const underlay = post(player(media(UNDERLAY_SECONDS), 'width: 286px; height: 508px; display: block').replace('preload="auto"', 'preload="none"'));
  const dialog = `<div role="dialog" aria-modal="true" style="position: fixed; inset: 0; background: #000">${player(media(X_POST.seconds), 'width: 100%; height: 100%; display: block')}</div>`;
  return page(X_POST.docTitle, underlay + dialog);
}

const gifPage = () => page('X 上的 QuinLAN：“loop https://t.co/abcdefghij” / X', `<article data-testid="tweet" id="main">${player(X_GIF_POST.src, 'width: 346px; height: 252px; display: block', 'loop autoplay muted')}</article>`);

const textPage = () => page('X 上的 Ayo O：“只有文字” / X', `<article data-testid="tweet" id="main"><div data-testid="tweetText">只有文字</div></article>`);

/** /xpage/media/<秒数>.wav：这段"视频"有多少秒；不是媒体路径返回 undefined */
export function xMediaSeconds(/** @type {string} */ path) {
  const m = /^\/xpage\/media\/(\d+)\.wav$/.exec(path);
  return m ? Number(m[1]) : undefined;
}

/** @param {string} path /xpage/ 开头的路径；认不出的返回 undefined（mock 回 404） */
export function xPage(path) {
  if (path === '/xpage/home') return homePage();
  if (path === `/xpage/${X_POST.user}/status/${X_POST.id}/video/1`) return videoViewPage();
  if (path === `/xpage/${X_GIF_POST.user}/status/${X_GIF_POST.id}`) return gifPage();
  if (path === `/xpage/${X_TEXT_POST.user}/status/${X_TEXT_POST.id}`) return textPage();
  return undefined;
}
