// @ts-check
// e2e 用的仿优酷（v.youku.com）页面（由 mock 服务在 /youku/ 下提供）。结构照 2026-11-18 实测的真实播放页：
// - 播放页 /v_show/id_<视频ID>.html 是直接打开的整页；站内列表里的 /video?vid=…、整部剧的 /video?s=… 打开后跳到它
//   （真实页面是服务器跳转；这里用一个"跳转前"的页面，window.__go() 整页跳过去）；
// - 播放器是 #ykPlayer.youku-player，正片的 <video> 是 .video-layer 的直接子元素，正片是同源的 blob: 流；
//   换集、放完自动播下一集都不重新加载页面（history.pushState），一直用同一个 <video>，只换片源；页面标题晚一点才更新；
// - 贴片广告（免费剧集开头一组）：在 .advertise-layer 里另用 <video> 放（直接给地址的短片），正片停在开头等着；
//   预先加载的下一条藏着（display: none）；放完这些 <video> 从页面上撤掉；
// - 品牌头条（正片开头十来秒处）：做在正片的流里、和正片同一个 <video>，正片照样在走；放的时候
//   dashboard 里的 #youku-advertise（<video-container>）多一块可点的区域 #click-url，放完撤掉；
// - 暂停时弹出图片广告（"广告""了解详情"），不在上面两处；
// - 播放器里有弹幕层和字幕层（#subtitle），都是盖在视频上的页面元素。
// "视频"是一段有声音的 WAV。页面记下自己元素上的点击次数，用来确认 TubeMuse 从不点播放器或别的按钮。

/** 用户举的例子：会员剧集的第 4 集（实测没开会员时可以试看） */
export const YOUKU_EP4 = {
  id: 'XNjU4MjM4NjQxNg==',
  query: '?spm=a2hkn.playlist.myhome.d_3&s=aace2910c3784944a0ad',
  docTitle: '《点燃我，温暖你》命韵峋环CP版 第4集 项目中标张晓蓓抢夺成果-电视剧-高清完整正版视频在线观看-优酷',
  title: '《点燃我，温暖你》命韵峋环CP版 第4集 项目中标张晓蓓抢夺成果',
  seconds: 30,
};
/** 换到的那一集：网址换成第 1 集的（带着节目 ID 和来源标记） */
export const YOUKU_EP1 = {
  id: 'XNjU4MjM4MjEyMA==',
  query: '?s=aace2910c3784944a0ad&scm=20140719.apircmd.298496.video_XNjU4MjM4MjEyMA==&spm=a2hkt.13141534.298496.d_2_1',
  docTitle: '《点燃我，温暖你》命韵峋环CP版 第1集 01-电视剧-高清完整正版视频在线观看-优酷',
  title: '《点燃我，温暖你》命韵峋环CP版 第1集 01',
  seconds: 25,
};
/** 整部剧的链接（打开后跳到第 4 集） */
export const YOUKU_SHOW = 's=aace2910c3784944a0ad';
/** 贴片广告：时长和哪一集正片都不一样 */
export const YOUKU_AD_SECONDS = 6;
/** 首页、频道页的标题（跳转前的页面也用它） */
export const YOUKU_HOME_TITLE = '优酷-热门独播剧集综艺电影在线观看-为好内容全力以赴';

const media = (/** @type {number} */ seconds) => `/youku/media/${seconds}.wav`;

const PLAYER =
  `<div class="content-warp play-fit-width"><div class="center-container"><div class="player-container">` +
  `<div id="ykPlayer" class="youku-player" data-spm="player" tabindex="-1" style="position: relative; width: 922px; height: 519px; background: #000">` +
  `<div class="video-layer" style="position: absolute; inset: 0"><video id="9b9a1451-0c04-4636-b0a9-9005e492fceb" style="width: 100%; height: 100%"></video></div>` +
  `<div class="advertise-layer" data-spm="adfree" style="position: absolute; inset: 0"><iframe frameborder="0" style="position: absolute; left: 0; top: 0; z-index: -1; width: 100%; height: 100%; visibility: hidden"></iframe></div>` +
  `<div class="youku-advertise-layer" style="position: absolute; inset: 0"><div id="youku-scene"></div><div id="youku-scene-player"></div></div>` +
  `<div class="advertise-youku-tips"></div>` +
  `<div id="subtitle" style="position: absolute; bottom: 40px; width: 100%; text-align: center; color: #fff">字幕字幕</div>` +
  `<dashboard id="youku-dashboard" class="kui-dashboard-0" style="position: absolute; inset: 0; display: block">` +
  `<div id="playerMouseWheelArea" class="kui-dashboard-display-panel"></div>` +
  `<video-container com="advideocontainer" id="youku-advertise" class="youku-advertise kui-video-container-0" style="position: absolute; inset: 0; display: block"></video-container>` +
  `<player-container com="adplayercontainer" id="player-advertise" class="player-advertise kui-player-container-0" style="height: 100%; display: block"><div class="barrage-container normal">弹幕弹幕</div></player-container>` +
  `<div class="kui-dashboard-timer-container"><div class="kui-dashboard-timer-panel">00:00:00</div>/<div class="kui-dashboard-timer-panel">00:48:25</div></div>` +
  `<div class="control-left-grid"><button class="kui-play-icon-0" id="yk-play">播放</button><button class="kui-next-icon-0" id="yk-next">下一集</button></div>` +
  `</dashboard>` +
  `<pop-layer class="kui-pop-0" style="position: absolute; inset: 0; pointer-events: none; display: block"></pop-layer>` +
  `</div></div></div></div>` +
  `<div class="anthology"><a class="box-anthology-item" href="/youku/video?vid=${encodeURIComponent('XNjU4MjM4MjEyMA==')}">1</a><a class="box-anthology-item active" href="#">VIP</a></div>`;

const SCRIPT =
  `window.__nativeClicks = 0; document.addEventListener('click', () => window.__nativeClicks++, true);` +
  `const main = () => document.querySelector('#ykPlayer .video-layer > video');` +
  `const layer = () => document.querySelector('#ykPlayer .advertise-layer');` +
  // 正片：和真实页面一样是同源的 blob: 流
  `async function load(seconds) {` +
  ` const blob = await (await fetch('/youku/media/' + seconds + '.wav')).blob();` +
  ` const v = main(); const loaded = new Promise((r) => (v.onloadeddata = r)); v.src = URL.createObjectURL(blob); await loaded; }` +
  // 贴片广告：正片载入后停在开头，广告另用 <video> 放（直接给地址；这里循环放，等测试叫 __endPreroll 才收）；下一条预先加载着、藏着
  `window.__preroll = async () => {` +
  ` const wrap = document.createElement('div'); wrap.className = 'wk3sifufi32b'; wrap.style.cssText = 'position: absolute; inset: 0';` +
  ` const ad = document.createElement('video'); ad.src = '${media(YOUKU_AD_SECONDS)}'; ad.loop = true; ad.style.cssText = 'width: 100%; height: 100%; display: block';` +
  ` const next = document.createElement('video'); next.src = '${media(YOUKU_AD_SECONDS)}'; next.preload = 'auto'; next.style.cssText = 'width: 100%; height: 100%; display: none';` +
  ` wrap.append(ad, next); layer().appendChild(wrap);` +
  ` const loaded = new Promise((r) => (ad.onloadeddata = r)); await loaded; await ad.play(); };` +
  `window.__endPreroll = () => { layer().querySelectorAll('.wk3sifufi32b').forEach((e) => e.remove()); return main().play(); };` +
  // 品牌头条：正片照样在放，#youku-advertise 里多一块可点的区域
  `window.__brandAd = (on) => { const box = document.getElementById('youku-advertise');` +
  ` if (on) box.innerHTML = '<div id="click-url" class="click" style="position: absolute; width: 221px; height: 221px; left: 701px; top: 298px; cursor: pointer"></div>'; else box.innerHTML = ''; };` +
  // 暂停时的图片广告：在别的层里
  `window.__pauseWithAd = () => { main().pause(); document.querySelector('pop-layer').innerHTML = '<div class="kui-pause-ad" style="position: absolute; left: 200px; top: 100px; width: 516px; height: 290px; background: #fff"><span>广告</span><span>了解详情</span></div>'; };` +
  `window.__closePauseAd = () => { document.querySelector('pop-layer').innerHTML = ''; };` +
  // 换集（你点选集或放完自动播下一集）：先换网址，同一个 <video> 换片源，页面标题晚一点才更新
  `window.__nextEpisode = async () => {` +
  ` history.pushState(null, '', '/youku/v_show/id_${YOUKU_EP1.id}.html${YOUKU_EP1.query}');` +
  ` setTimeout(() => (document.title = ${JSON.stringify(YOUKU_EP1.docTitle)}), 300);` +
  ` await load(${YOUKU_EP1.seconds}); return main().play(); };` +
  // 打开播放页：正片载入、停在开头，贴片广告开始放
  `window.__ready = load(${YOUKU_EP4.seconds}).then(() => window.__preroll());`;

/** 播放页：直接打开（整页），一打开就是贴片广告 */
function playPage() {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${YOUKU_EP4.docTitle}</title><style>body { margin: 0; font-family: system-ui, sans-serif; background: #111; color: #eee; }</style></head>` +
    `<body><div id="app">${PLAYER}</div><script>${SCRIPT}</script></body></html>`
  );
}

/** 整部剧的链接：真实页面上是服务器跳转；这里先停在一个没有播放器的页面上，window.__go() 整页跳到第 4 集的播放页 */
function showRedirectPage() {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${YOUKU_HOME_TITLE}</title></head>` +
    `<body><p>跳转中…</p><script>window.__go = () => location.replace('/youku/v_show/id_${YOUKU_EP4.id}.html${YOUKU_EP4.query}');</script></body></html>`
  );
}

/** /youku/media/<秒数>.wav：这段"视频"有多少秒；不是媒体路径返回 undefined */
export function youkuMediaSeconds(/** @type {string} */ path) {
  const m = /^\/youku\/media\/(\d+)\.wav$/.exec(path);
  return m ? Number(m[1]) : undefined;
}

/**
 * @param {string} path /youku/ 开头的路径（不含查询参数）；认不出的返回 undefined（mock 回 404）
 * @param {URLSearchParams} query
 */
export function youkuPage(path, query) {
  if (path === `/youku/v_show/id_${YOUKU_EP4.id}.html`) return playPage();
  if (path === '/youku/video' && query.has('s')) return showRedirectPage();
  return undefined;
}
