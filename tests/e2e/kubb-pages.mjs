// @ts-check
// e2e 用的仿酷播（www.kubb.tv）页面（由 mock 服务在 /kubb/ 下提供）。结构照 2026-11-10 实测的真实播放页：
// - 单页应用：从首页点进 /play/<影片ID>、换集（网址带上 ?id=<分集ID>）都不重新加载页面，播放器的 <video> 一直是同一个；
// - 播放器是 <vg-player>，视频是它的直接子元素 video#video_player（crossorigin="anonymous"），正片是同源的 blob: 流；
// - 页面上另有两个不相干的 <video>：投屏按钮里一个空的（在播放器里、排在前面）、页面角落一个 1×1 的；
// - 片头广告和正片用同一个 <video> 放：广告是直接给地址的短片（不是 blob:），放完报"播完"，过一会儿才换成正片。
// "视频"是一段有声音的 WAV。页面记下自己元素上的点击次数，用来确认 TubeMuse 从不点播放器或别的按钮。

export const KUBB_MOVIE = { id: '8aZsQlwuJ1E', docTitle: '八仙！-免费在线观看-酷播', title: '八仙！', seconds: 20 };
/** 剧集：不带 ?id= 打开时是站点替你接着看的那一集 */
export const KUBB_SHOW = { id: 'e2rCXFzJUz2', docTitle: '玉簟秋-24-免费在线观看-酷播', title: '玉簟秋-24', seconds: 30 };
/** 换到的那一集：网址带上 ?id=<分集ID> */
export const KUBB_EPISODE = { id: 'lIM07A3d3g8', docTitle: '玉簟秋-02-免费在线观看-酷播', title: '玉簟秋-02', seconds: 25 };
/** 片头广告：时长和哪一段正片都不一样 */
export const KUBB_AD_SECONDS = 6;
/** 页面角落 1×1 的视频：时长不同，用来分辨选中的是哪一个 */
const CORNER_SECONDS = 7;

const media = (/** @type {number} */ seconds) => `/kubb/media/${seconds}.wav`;

const PLAYER =
  `<aa-videoplayer><div class="video-container"><vg-player id="main-player">` +
  `<vg-controls><div class="control-item airplay"><video></video></div><button id="like">点赞</button></vg-controls>` +
  `<div class="caption"></div><vg-overlay-danmu>弹幕弹幕</vg-overlay-danmu>` +
  `<video id="video_player" crossorigin="anonymous" style="width: 840px; height: 473px; display: block"></video>` +
  `</vg-player></div></aa-videoplayer>`;

const SCRIPT =
  `window.__nativeClicks = 0; document.addEventListener('click', () => window.__nativeClicks++, true);` +
  `const main = () => document.querySelector('#video_player');` +
  // 正片：和真实页面一样是同源的 blob: 流
  `async function load(seconds) {` +
  ` const blob = await (await fetch('/kubb/media/' + seconds + '.wav')).blob();` +
  ` const v = main(); const loaded = new Promise((r) => (v.onloadeddata = r)); v.src = URL.createObjectURL(blob); await loaded; return v.play(); }` +
  // 站内跳转：先换网址，播放器只建一次，之后一直用同一个 <video>
  `async function open(path, title, seconds) {` +
  ` history.pushState(null, '', path);` +
  ` if (!main()) document.getElementById('app').innerHTML = ${JSON.stringify(PLAYER)};` +
  ` document.title = title; return load(seconds); }` +
  `window.__openMovie = () => open('/kubb/play/${KUBB_MOVIE.id}', ${JSON.stringify(KUBB_MOVIE.docTitle)}, ${KUBB_MOVIE.seconds});` +
  `window.__openShow = () => open('/kubb/play/${KUBB_SHOW.id}', ${JSON.stringify(KUBB_SHOW.docTitle)}, ${KUBB_SHOW.seconds});` +
  `window.__switchEpisode = () => open('/kubb/play/${KUBB_SHOW.id}?id=${KUBB_EPISODE.id}&from=list', ${JSON.stringify(KUBB_EPISODE.docTitle)}, ${KUBB_EPISODE.seconds});` +
  // 片头广告：同一个 <video>，直接给地址；__endAd 换回正片
  `window.__playAd = () => { const v = main(); const loaded = new Promise((r) => (v.onloadeddata = r)); v.src = '${media(KUBB_AD_SECONDS)}'; return loaded.then(() => v.play()); };` +
  `window.__endAd = () => load(${KUBB_EPISODE.seconds});`;

/** 首页：window.__openMovie() 等模拟点进播放页（站内跳转，不重新加载页面） */
function homePage() {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>酷播-海量高清视频免费在线观看</title><style>body { margin: 0; font-family: system-ui, sans-serif; }</style></head>` +
    `<body><div class="root-container"><div id="app"><a href="/kubb/play/${KUBB_MOVIE.id}">八仙！</a></div>` +
    `<video src="${media(CORNER_SECONDS)}" preload="auto" style="width: 1px; height: 1px"></video></div>` +
    `<script>${SCRIPT}</script></body></html>`
  );
}

/** /kubb/media/<秒数>.wav：这段"视频"有多少秒；不是媒体路径返回 undefined */
export function kubbMediaSeconds(/** @type {string} */ path) {
  const m = /^\/kubb\/media\/(\d+)\.wav$/.exec(path);
  return m ? Number(m[1]) : undefined;
}

/** @param {string} path /kubb/ 开头的路径；认不出的返回 undefined（mock 回 404） */
export function kubbPage(path) {
  return path === '/kubb/home' ? homePage() : undefined;
}
