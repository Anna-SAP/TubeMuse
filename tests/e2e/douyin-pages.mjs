// @ts-check
// e2e 用的仿抖音网页版页面（由 mock 服务在 /douyin/ 下提供；精选页是 /douyin/jingxuan，带类目是 /douyin/jingxuan/<类目>，
// 搜索结果页是 /douyin/search/<搜索词>）。
// 结构照 2026-11-10 实测的真实精选页（搜索结果页 2026-11-11 实测，点开视频以后的结构相同，只有两处不一样：
// 页面标题一直是"发现更多精彩视频 - 抖音搜索"，点开视频也不变；网址除了 modal_id 还带着 type=general）：
// - 单页应用：在精选页点开一条视频，网址加上 ?modal_id=<视频ID>，不重新加载；划到下一条时 modal_id 跟着换；
// - "当前这一条"是 [data-e2e="feed-active-video"]，它的 data-e2e-vid 就是这个 ID，里面的 <video> 是正在放的那个；
// - 下一条的 <video> 预先加载在旁边的 [data-e2e="feed-item"] 里；划走以后上一条的 <video> 还留在页面上；页面角落另有一个空的 <video>；
// - 作者昵称在 [data-e2e="feed-video-nickname"]（带 @），描述在 [data-e2e="video-desc"]，后面跟着一个"展开"按钮；
// - 页面标题只在点开时写一次，划到下一条时不更新；视频因为浏览器的限制静音播放。
// "视频"是一段有声音的 WAV（同源，与真实页面的 blob: 流一样读得到）。
// 页面记下自己元素上的点击次数，用来确认 TubeMuse 从不替你点赞、关注、点"展开"或点播放器。

/** 点开的第一条视频 */
export const DOUYIN_VIDEO = {
  id: '7704250528896716072',
  docTitle: '为什么要“搞死”黄仁勋？#AI创业 #黄仁勋 - 抖音',
  title: '云汉AI创投 - 第13集：为什么要“搞死”黄仁勋？#AI创业 #黄仁勋',
  seconds: 20,
};
/** 划到的下一条：时长不同，用来分辨侧边栏显示的是哪一条 */
export const DOUYIN_NEXT = { id: '7706025941717672121', title: '旅行的小周 - 冬天去哪里看雪 #旅行', seconds: 30 };

const media = (/** @type {number} */ seconds) => `/douyin/media/${seconds}.wav`;

/** @param {string} nickname @param {string} descHtml */
const info = (nickname, descHtml) =>
  `<div data-e2e="video-info"><div><div><div data-e2e="feed-video-nickname"><span><span><span>@${nickname}</span></span></span></div><div><span>· 1天前</span></div></div>` +
  `<div data-e2e="video-desc"><div><div><span><span>${descHtml}</span></span></div><div><button>展开</button></div></div></div></div></div>`;

/** 信息流里的一条：播放器、弹幕层、作者与描述、点赞按钮 */
const item = (/** @type {string} */ domId, /** @type {string} */ attrs, /** @type {number} */ seconds, /** @type {string} */ infoHtml) =>
  `<div id="${domId}" ${attrs}><div class="playerContainer"><div class="slider-video"><div data-xgplayerid="${domId}" class="basePlayerContainer">` +
  `<xg-video-container class="xg-video-container"><video data-xgplayerid="${domId}" crossorigin="anonymous" playsinline preload="auto" src="${media(seconds)}" style="width: 480px; height: 300px; display: block"></video></xg-video-container>` +
  `</div></div></div><div data-e2e="danmaku-container">弹幕：因为他是黄皮肤</div>${infoHtml}<div data-e2e="video-player-digg" role="button">赞</div></div>`;

function modal() {
  const first = item(
    'dy-first',
    `data-e2e="feed-active-video" data-e2e-vid="${DOUYIN_VIDEO.id}"`,
    DOUYIN_VIDEO.seconds,
    info('云汉AI创投', `<span>第13集：为什么要“搞死”黄仁勋？</span><span>#AI创业</span><span> </span><span>#黄仁勋</span>`),
  );
  const next = item('dy-next', 'data-e2e="feed-item"', DOUYIN_NEXT.seconds, info('旅行的小周', `<span>冬天去哪里看雪 </span><span>#旅行</span>`));
  return `<div data-e2e="modal-video-container"><div data-e2e="slideList">${first}${next}<div data-e2e="feed-item"></div><div data-e2e="feed-item"></div></div></div>`;
}

const SCRIPT =
  `window.__nativeClicks = 0; document.addEventListener('click', () => window.__nativeClicks++, true);` +
  // 在精选页点开一条视频：站内跳转，网址带上 modal_id（外加一个不相干的参数），页面标题写成这条视频的
  `window.__openVideo = () => {` +
  ` if (!location.pathname.includes('/search/')) document.title = ${JSON.stringify(DOUYIN_VIDEO.docTitle)};` +
  ` document.getElementById('modal').innerHTML = ${JSON.stringify(modal())};` +
  ` history.pushState(null, '', location.pathname + '?modal_id=${DOUYIN_VIDEO.id}&' + (location.pathname.includes('/search/') ? 'type=general' : 'from=grid'));` +
  ` const v = document.querySelector('#dy-first video'); v.muted = true; return v.play(); };` +
  // 划到下一条（或"连播"自动跳过去）：modal_id 换了，"当前这一条"换成下一个；页面标题不变，上一条的 <video> 暂停着留在页面上
  `window.__nextVideo = () => {` +
  ` const cur = document.getElementById('dy-first'); const next = document.getElementById('dy-next');` +
  ` cur.querySelector('video').pause(); cur.setAttribute('data-e2e', 'feed-item'); cur.removeAttribute('data-e2e-vid');` +
  ` next.setAttribute('data-e2e', 'feed-active-video'); next.setAttribute('data-e2e-vid', '${DOUYIN_NEXT.id}');` +
  ` history.replaceState(null, '', location.pathname + '?modal_id=${DOUYIN_NEXT.id}');` +
  ` const v = next.querySelector('video'); v.muted = true; return v.play(); };` +
  // 关掉这条视频：回到精选页的格子
  `window.__closeVideo = () => { document.getElementById('modal').innerHTML = ''; history.pushState(null, '', location.pathname); };`;

/** 搜索结果页没点开视频时的页面标题；点开以后也不变 */
export const DOUYIN_SEARCH_TITLE = '发现更多精彩视频 - 抖音搜索';

/** @param {string} title 页面标题：精选页和搜索结果页除此之外用同一个仿页面 */
function feedPage(title = '抖音精选 - 抖音') {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body { margin: 0; font-family: system-ui, sans-serif; }</style></head>` +
    `<body><div id="app"><div id="grid"><a href="/douyin/jingxuan?modal_id=${DOUYIN_VIDEO.id}" onclick="return false">一条视频的封面</a></div><div id="modal"></div>` +
    `<video crossorigin="anonymous" style="width: 0; height: 0"></video></div><script>${SCRIPT}</script></body></html>`
  );
}

/** /douyin/media/<秒数>.wav：这段"视频"有多少秒；不是媒体路径返回 undefined */
export function douyinMediaSeconds(/** @type {string} */ path) {
  const m = /^\/douyin\/media\/(\d+)\.wav$/.exec(path);
  return m ? Number(m[1]) : undefined;
}

/** @param {string} path /douyin/ 开头的路径；认不出的返回 undefined（mock 回 404） */
export function douyinPage(path) {
  if (/^\/douyin\/jingxuan(?:\/[a-z]+)?$/.test(path)) return feedPage();
  return /^\/douyin\/search\/[^/]+$/.test(path) ? feedPage(DOUYIN_SEARCH_TITLE) : undefined;
}
