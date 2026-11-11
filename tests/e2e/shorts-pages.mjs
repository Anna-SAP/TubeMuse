// @ts-check
// e2e 用的仿 YouTube Shorts 页面（由 mock 服务在 /shorts/<ID> 下提供；mock 服务就是 e2e 里的"YouTube"）。结构照 2026-11-11 核实的真实页面：
// - 页面里的播放器配置写着 Shorts 播放器的根元素是 #shorts-player（WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_SHORTS 的 rootElementId）；
// - ytd-shorts > #shorts-container > #shorts-inner-container 里每条 Short 一格（div#0、div#1…），只有正在看的那一格里有
//   ytd-reel-video-renderer，播放器装在它的 #player-container > ytd-player#player > div#container 里，别的格子只有缩略图；
// - 同一个页面里还有一个藏起来的 ytd-watch-flexy[hidden]，里面是播放页的 #movie_player（直接打开 Shorts 时也有；
//   从播放页站内跳过来时里面还是上一个视频）。这里让它停在一个 20 秒视频的第 9 秒，选错播放器就会对不上；
// - 单页应用：划到下一条 Short 时网址换成 /shorts/<下一个ID>、页面标题跟着换，不重新加载页面；
// - Shorts 放到结尾会自己从头再放：这里用 loop 属性（不报"播完"，进度直接从结尾跳回 0）。
// 真实页面上播放器里的结构（.html5-video-container > video.video-stream.html5-main-video）和播放页是同一个播放器脚本生成的。
// "视频"是一段有声音的 WAV（同源 blob:，和真实页面的 MSE 流一样读得到）。页面记下自己元素上的点击次数，用来确认 TubeMuse 从不点任何东西。

/** 第一条：7 秒，用来测"放完一遍就结束" */
export const SHORT_A = { id: 'clipShorts01', docTitle: '(2) 一分钟看懂 GPU #shorts - YouTube', title: '一分钟看懂 GPU #shorts', seconds: 7 };
/** 划到的下一条：12 秒 */
export const SHORT_B = { id: 'clipShorts02', docTitle: 'AI safety in 60 seconds #shorts - YouTube', title: 'AI safety in 60 seconds #shorts', seconds: 12 };
/** 藏着的播放页播放器里的上一个视频：20 秒，停在第 9 秒 */
export const SHORTS_STALE_WATCH_SECONDS = 20;

const SHORTS = [SHORT_A, SHORT_B];

const player = (/** @type {string} */ id, /** @type {string} */ attrs) =>
  `<div id="${id}" class="html5-video-player ytp-transparent"><div class="html5-video-container"><video class="video-stream html5-main-video" ${attrs}></video></div>` +
  `<div class="ytp-caption-window-container"></div><div class="ytp-chrome-bottom"><button class="ytp-play-button ytp-button">播放</button></div></div>`;

const SHORTS_UI =
  `<ytd-shorts><div id="shorts-container"><div id="shorts-inner-container">` +
  `<div id="0" class="reel-video-in-sequence-new"><div class="reel-video-in-sequence-thumbnail"></div><div id="reel-overlay-container">` +
  `<ytd-reel-video-renderer id="reel-video-renderer"><div id="short-video-container"><div class="player-wrapper"><div id="player-container">` +
  `<ytd-player id="player"><div id="container">${player('shorts-player', 'loop style="display: block; width: 315px; height: 560px"')}</div></ytd-player>` +
  `</div></div></div><div id="experiment-overlay"><button class="like">赞</button><button class="subscribe">订阅</button></div></ytd-reel-video-renderer>` +
  `</div></div>` +
  `<div id="1" class="reel-video-in-sequence-new"><div class="reel-video-in-sequence-thumbnail"></div></div>` +
  `</div></div></ytd-shorts>`;

const WATCH_UI = `<ytd-watch-flexy hidden>${player('movie_player', 'style="width: 640px; height: 360px"')}</ytd-watch-flexy>`;

const SCRIPT =
  `window.__nativeClicks = 0; document.addEventListener('click', () => window.__nativeClicks++, true);` +
  `async function load(v, seconds) {` +
  ` const blob = await (await fetch('/shorts-media/' + seconds + '.wav')).blob();` +
  ` const loaded = new Promise((r) => (v.onloadeddata = r)); v.src = URL.createObjectURL(blob); await loaded; }` +
  // 藏着的播放页播放器：上一个视频停在第 9 秒（YouTube 跳到 Shorts 时把它暂停）
  `const stale = document.querySelector('#movie_player video');` +
  `window.__staleReady = load(stale, ${SHORTS_STALE_WATCH_SECONDS}).then(() => { stale.currentTime = 9; });` +
  `const short = () => document.querySelector('#shorts-player video');` +
  `window.__shortReady = load(short(), Number(document.documentElement.dataset.seconds));` +
  // 划到下一条：先换网址和标题，播放器还是同一个元素，换片源后接着放
  `window.__nextShort = async (id, title, seconds) => {` +
  ` history.pushState(null, '', '/shorts/' + id); document.title = title;` +
  ` await load(short(), seconds); return short().play(); };`;

/** /shorts-media/<秒数>.wav：这段"视频"有多少秒；不是媒体路径返回 undefined */
export function shortsMediaSeconds(/** @type {string} */ path) {
  const m = /^\/shorts-media\/(\d+)\.wav$/.exec(path);
  return m ? Number(m[1]) : undefined;
}

/** @param {string} path /shorts/<ID>；认不出的 ID 返回 undefined（mock 回 404） */
export function shortsPage(path) {
  const id = /^\/shorts\/([\w-]+)$/.exec(path)?.[1];
  const s = SHORTS.find((x) => x.id === id);
  if (!s) return undefined;
  return (
    `<!doctype html><html data-seconds="${s.seconds}"><head><meta charset="utf-8"><title>${s.docTitle}</title><style>body { margin: 0; font-family: system-ui, sans-serif; }</style></head>` +
    `<body><ytd-app id="app"><ytd-page-manager>${SHORTS_UI}${WATCH_UI}</ytd-page-manager></ytd-app><script>${SCRIPT}</script></body></html>`
  );
}
