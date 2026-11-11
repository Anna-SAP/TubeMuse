// @ts-check
// e2e 用的仿 B 站（www.bilibili.com）页面（由 mock 服务在 /bili/ 下提供）。结构照 2026-11-11 实测的真实页面：
// - 单页应用：从首页点进播放页、换集、换分 P、连播都不重新加载页面，主播放器的 <video> 一直是同一个，只换片源；
// - 主播放器装在 #bilibili-player 里（普通视频、番剧影视、播放列表、活动页都是；课程是 #edu-player，结构一样）：
//   #bilibili-player > .bpx-docker > .bpx-player-container > .bpx-player-primary-area > .bpx-player-video-area
//   > .bpx-player-video-perch > .bpx-player-video-wrap > video（crossorigin="anonymous"，正片是同源的 blob: 流）；
// - 播放器里有弹幕层（.bpx-player-row-dm-wrap）和字幕层（.bpx-player-subtitle-wrap），都是盖在视频上的页面元素；
// - 鼠标停在首页或推荐列表的封面上时，封面里多出一个同样结构的小播放器（静音的预览）：首页是 .v-inline-player，
//   推荐列表是 .v-recommend-inline-player，都不在 #bilibili-player 里；
// - 海外网络下网址开头多一段语言（/zh-Hans/…），换集后网址带着来源参数（?from_spmid=…、?spm_id_from=…）；
// - 页面标题：番剧"片名-国创-高清独家在线观看-bilibili-哔哩哔哩"（整季的链接不带集数，一集的链接带"第N集"），
//   普通视频"标题_哔哩哔哩_bilibili"（分 P 的是这一 P 的名字），活动页是活动名。
// "视频"是一段有声音的 WAV。页面记下自己元素上的点击次数，用来确认 TubeMuse 从不点播放器或别的按钮。

/** 首页：没有主播放器，只有封面上的悬停预览 */
export const BILI_HOME_TITLE = '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili';
/** 用户举的例子：从整季的链接进来（网址是 ss 号，放的是第 1 集） */
export const BILI_SEASON = { id: 'ss28747', docTitle: '凡人修仙传-国创-高清独家在线观看-bilibili-哔哩哔哩', title: '凡人修仙传', seconds: 20 };
/** 换到的那一集：网址换成 ep 号 */
export const BILI_EPISODE = { id: 'ep733317', docTitle: '凡人修仙传第2集-国创-高清独家在线观看-bilibili-哔哩哔哩', title: '凡人修仙传第2集', seconds: 25 };
/** 普通视频的第 3 P */
export const BILI_VIDEO = { bv: 'BV1Kb411W75N', part: 3, docTitle: '002.尚硅谷_编程入门-资料文件结构2_哔哩哔哩_bilibili', title: '002.尚硅谷_编程入门-资料文件结构2', seconds: 30 };
/** 活动页：网址里认不出是哪个视频 */
export const BILI_FESTIVAL = { name: '2022bnj', docTitle: '2022拜年纪', seconds: 15 };
/** 封面上的悬停预览：时长和哪个正片都不一样，用来分辨选中的是哪一个 */
export const BILI_PREVIEW_SECONDS = 7;

const player = (/** @type {string} */ attrs) =>
  `<div class="bpx-docker"><div class="bpx-player-container" data-screen="normal"><div class="bpx-player-primary-area"><div class="bpx-player-video-area">` +
  `<div class="bpx-player-video-perch"><div class="bpx-player-video-wrap"><video crossorigin="anonymous" ${attrs}></video></div></div>` +
  `<div class="bpx-player-row-dm-wrap">弹幕弹幕</div><div class="bpx-player-subtitle-wrap"></div>` +
  `<div class="bpx-player-control-wrap"><button class="bpx-player-ctrl-btn">三连</button></div>` +
  `</div></div></div></div>`;

const MAIN = `<div class="left-container"><div id="playerWrap" class="player-wrap"><div id="bilibili-player">${player('style="width: 938px; height: 528px; display: block"')}</div></div></div>`;
const RECOMMEND = `<div class="right-container"><div class="recommend-list-v1"><div class="video-page-card-small"><div class="card-box"><div class="pic-box" id="rec-card"><span>推荐视频的封面</span></div></div></div></div></div>`;
const HOME = `<main class="bili-feed4-layout"><div class="bili-video-card"><a class="bili-video-card__image--link" href="/bili/video/${BILI_VIDEO.bv}/"><div class="bili-video-card__image--wrap" id="home-card"><span>首页视频的封面</span></div></a></div></main>`;

const SCRIPT =
  `window.__nativeClicks = 0; document.addEventListener('click', () => window.__nativeClicks++, true);` +
  `const app = () => document.getElementById('app');` +
  `const main = () => document.querySelector('#bilibili-player video');` +
  `async function play(v, seconds) {` +
  ` const blob = await (await fetch('/bili/media/' + seconds + '.wav')).blob();` +
  ` const loaded = new Promise((r) => (v.onloadeddata = r)); v.src = URL.createObjectURL(blob); await loaded; return v.play(); }` +
  // 站内跳转：先换网址和标题；主播放器只建一次，之后一直用同一个 <video>
  `async function open(path, title, seconds, layout) {` +
  ` history.pushState(null, '', path); document.title = title;` +
  ` if (!main()) app().innerHTML = layout;` +
  ` return play(main(), seconds); }` +
  `window.__openSeason = () => open('/bili/zh-Hans/bangumi/play/${BILI_SEASON.id}?spm_id_from=333.1391.0.0', ${JSON.stringify(BILI_SEASON.docTitle)}, ${BILI_SEASON.seconds}, ${JSON.stringify(MAIN + RECOMMEND)});` +
  `window.__nextEpisode = () => open('/bili/zh-Hans/bangumi/play/${BILI_EPISODE.id}?from_spmid=666.25.episode.0', ${JSON.stringify(BILI_EPISODE.docTitle)}, ${BILI_EPISODE.seconds}, ${JSON.stringify(MAIN + RECOMMEND)});` +
  `window.__openVideo = () => open('/bili/zh-Hans/video/${BILI_VIDEO.bv}/?p=${BILI_VIDEO.part}&spm_id_from=333.788.videopod.episodes', ${JSON.stringify(BILI_VIDEO.docTitle)}, ${BILI_VIDEO.seconds}, ${JSON.stringify(MAIN + RECOMMEND)});` +
  `window.__openFestival = () => open('/bili/festival/${BILI_FESTIVAL.name}', ${JSON.stringify(BILI_FESTIVAL.docTitle)}, ${BILI_FESTIVAL.seconds}, ${JSON.stringify(MAIN + RECOMMEND)});` +
  // 鼠标停在封面上：封面里多出一个静音的小播放器（首页 .v-inline-player，推荐列表 .v-recommend-inline-player）
  `window.__hoverCard = (id, cls) => { const box = document.getElementById(id); const wrap = document.createElement('div'); wrap.className = cls;` +
  ` wrap.innerHTML = ${JSON.stringify(player('muted style="width: 142px; height: 80px; display: block"'))}; box.appendChild(wrap);` +
  ` return play(wrap.querySelector('video'), ${BILI_PREVIEW_SECONDS}); };` +
  `window.__hoverHome = () => window.__hoverCard('home-card', 'v-inline-player');` +
  `window.__hoverRecommend = () => window.__hoverCard('rec-card', 'v-recommend-inline-player');`;

/** 首页：window.__openSeason() 等模拟点进播放页（站内跳转，不重新加载页面） */
function homePage() {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${BILI_HOME_TITLE}</title><style>body { margin: 0; font-family: system-ui, sans-serif; }</style></head>` +
    `<body><div id="app">${HOME}</div><script>${SCRIPT}</script></body></html>`
  );
}

/** /bili/media/<秒数>.wav：这段"视频"有多少秒；不是媒体路径返回 undefined */
export function biliMediaSeconds(/** @type {string} */ path) {
  const m = /^\/bili\/media\/(\d+)\.wav$/.exec(path);
  return m ? Number(m[1]) : undefined;
}

/** @param {string} path /bili/ 开头的路径；认不出的返回 undefined（mock 回 404） */
export function biliPage(path) {
  return path === '/bili/' ? homePage() : undefined;
}
