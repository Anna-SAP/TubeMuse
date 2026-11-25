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
  return path === '/bili/' ? homePage() : biliVideoPage(path);
}

// ───────── 视频页的"接下来播放"列表（发布时间与收藏，DECISIONS §92）─────────
// 结构照 2026-11-25 实测的真实页面：
// - 服务端渲染：#app 带 data-server-rendered="true"，Vue 接管时去掉它（这里 1.2 秒后去掉；之前往里加东西，真实页面会整页重画）；
// - 右侧 .right-container > .rcmd-tab > .recommend-list-v1 > .next-play（"接下来播放"那一条）+ .rec-list（其余）+ .rec-footer（"展开"）；
// - 每条 .video-page-card-small > .card-box > .pic-box（封面链接、.duration、右上角 .watch-later-video、悬停预览的空容器）
//   + .info（a > p.title、.upname > a[href=//space…/<UID>/] > span.name、.playinfo（播放数、弹幕数，inline-flex））；
// - 站内跳到别的视频：网址、标题、meta（og:url、author、video:release_date、video:duration）都换，列表里的卡片元素原样复用、只换内容；
// - "展开"之后多出一批卡片；列表里偶尔有番剧这种没有 BV 号的卡片。
// 推荐列表的发布时间在页面上和页面数据里都没有：TubeMuse 向 mock 的 /biliapi/x/article/cards 查（见 biliCardsReply）。

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * 推荐列表里的视频。age：发布了多久（mock 接口按"现在 − age"回答）；at：固定的发布时间；两者都没有 = 接口里查不到。
 * @typedef {{ bv: string; title: string; up: string; mid: string; duration: string; view: string; dm: string; age?: number; at?: number }} BiliRec
 */

/** @type {BiliRec[]} 打开的这个视频页的列表（第一条是"接下来播放"） */
export const BILI_RECS = [
  { bv: 'BV1Ud436mEjX', title: '科幻小说《三体》三部全集', up: '考拉有声书', mid: '3493282166344163', duration: '77:32:35', view: '6638', dm: '1', age: 3 * HOUR + 5 * 60_000 },
  { bv: 'BV1rny8zjEVu', title: '6小时ai《三体2、3》合集', up: '青年摸鱼高手', mid: '28336952', duration: '5:51:05', view: '5629', dm: '43', age: 10 * DAY + HOUR },
  { bv: 'BV1Yeuj64E5f', title: '假如三体人不吃压力……', up: '铭明mk', mid: '289080082', duration: '01:54', view: '90.4万', dm: '872', at: Date.UTC(2022, 6, 27, 12, 0) },
  {
    bv: 'BV11s41187QY',
    title: '【文曰小强】84分钟速读《三体》大合集，这个标题很长很长，要折成两行才放得下',
    up: '文曰小强',
    mid: '20165629',
    duration: '1:24:50',
    view: '2169.2万',
    dm: '17万',
    at: Date.UTC(2017, 1, 3, 12, 5),
  },
  // 接口里查不到（删了、不公开）
  { bv: 'BV1Gone00000', title: '已经删掉的视频', up: '某人', mid: '1', duration: '03:00', view: '12', dm: '0' },
];
/** 站内跳到的那个视频页的列表：第一条是刚才查过的（不该再查），其余是新的 */
export const BILI_RECS_NEXT = [
  BILI_RECS[1],
  { bv: 'BV1Je4y1P7hM', title: '程心：我 保 留 了 五 公 斤 生 态 球', up: '成长小豆芽mo', mid: '1802011210', duration: '01:38', view: '42.6万', dm: '59', at: Date.UTC(2023, 1, 10, 9, 13) },
  { bv: 'BV1oSg56hErX', title: '假如三体人非得作死挑衅罗辑……', up: '秋名FD3s', mid: '90949884', duration: '00:36', view: '12.2万', dm: '45', age: 40 * 60_000 },
  { bv: 'BV1ZWeE6MEfw', title: '三体人眼中的罗辑', up: '马野好饿', mid: '12345', duration: '00:42', view: '60.4万', dm: '86', at: Date.UTC(2024, 4, 1, 2, 0) },
  { bv: 'BV1T24y1p7Nm', title: '那颗星星，是他送的', up: '想看就看一起看', mid: '67890', duration: '01:28', view: '40.1万', dm: '206', age: 2 * DAY + 3 * HOUR },
];
/** 点"展开"后多出来的 */
export const BILI_RECS_MORE = [
  { bv: 'BV1dJ4m177LG', title: '《三体》中的叶文洁为什么要背叛人类？', up: '我不是小楚南', mid: '24680', duration: '15:24', view: '34.9万', dm: '661', at: Date.UTC(2021, 9, 9, 12, 0) },
  { bv: 'BV1gpHvehEp3', title: '三体：智子来了', up: '某UP', mid: '13579', duration: '08:08', view: '1.2万', dm: '33', age: 25 * DAY },
];
/** 打开的这个视频与跳到的那个视频（各自的 meta） */
export const BILI_PAGE_VIDEO = { bv: 'BV1cv2yYDE4U', title: '一口气看完《三体》全集3部，时长3小时，耗时3个月制作', up: '翁翁讲故事', mid: '519033438', at: Date.UTC(2024, 9, 11, 4, 0), seconds: 11661 };
export const BILI_NEXT_VIDEO = { bv: BILI_RECS[2]?.bv ?? '', title: '假如三体人不吃压力……', up: '铭明mk', mid: '289080082', at: Date.UTC(2022, 6, 27, 4, 0), seconds: 114 };
/**
 * 播放列表页（/list/<ID>?bvid=…，例如"UP主的全部视频"）右侧列表里的视频（2026-11-25 实测：每一项只有标题和"N万播放"，没有 UP 主）。
 * 第一项是正在放的这个
 * @type {BiliRec[]}
 */
export const BILI_LIST = [
  { bv: 'BV1xtxF65Efz', title: '重读人界138：韩立获得珍贵庚精 边界大战参与赌斗', up: '', mid: '', duration: '', view: '1.9万播放', dm: '', age: 25 * DAY + HOUR },
  { bv: 'BV1MfWL6HELv', title: '重读人界141：韩立的温床血罗罩，躲里面看戏、出来就杀人', up: '', mid: '', duration: '', view: '1.2万播放', dm: '', age: 14 * DAY + HOUR },
  { bv: 'BV1jbWu6mEs7', title: '重读人界140', up: '', mid: '', duration: '', view: '1.6万播放', dm: '', age: 15 * DAY + HOUR },
  { bv: 'BV1Sxxf6SE7U', title: '重读人界139：房宗主毒谋，韩老魔破局？', up: '', mid: '', duration: '', view: '1.6万播放', dm: '', at: Date.UTC(2025, 0, 2, 12, 0) },
];
/** 往下滚加载出的下一批 */
export const BILI_LIST_MORE = [
  { bv: 'BV1AaxX6pEzc', title: '重读人界137', up: '', mid: '', duration: '', view: '1.4万播放', dm: '', age: 20 * DAY + HOUR },
  { bv: 'BV112so6eE7G', title: '重读人界136', up: '', mid: '', duration: '', view: '9876播放', dm: '', at: Date.UTC(2024, 11, 24, 12, 0) },
];
export const BILI_LIST_ID = '43764108';
/** 播放列表页右侧、列表下面的推荐（.recommend-video-card：和"接下来播放"的卡片同一种结构，UP 主链接是 a.upname 本身） */
export const BILI_LIST_RECS = [
  { bv: 'BV1sr4c6EESK', title: '“这建模还是太权威了，终于明白宋玉人气有多高了！”', up: '爱睡觉的_Koala', mid: '43887712', duration: '02:03', view: '61.8万', dm: '286', age: 6 * DAY + HOUR },
  { bv: 'BV1Bh411G7Da', title: '凤冰：韩道友要求只要不是太过分，都是可以的！', up: '爱睡觉的_Koala', mid: '43887712', duration: '02:20', view: '40.6万', dm: '151', at: Date.UTC(2023, 5, 6, 12, 0) },
];

/**
 * 视频页右侧的合集列表（.video-pod，2026-11-25 实测）：每一项是一个视频，data-key 是 BV 号；这个页面的视频是其中的第二项
 * @type {BiliRec[]}
 */
export const BILI_POD_SEASON = [
  { bv: 'BV1Sea000001', title: '重读人界1：五里沟二愣子出世', up: '', mid: '', duration: '14:55', view: '', dm: '', at: Date.UTC(2026, 7, 17, 12, 0) },
  { bv: 'BV1Sea000002', title: '重读人界2：七玄门测试', up: '', mid: '', duration: '13:02', view: '', dm: '', age: 12 * DAY + HOUR },
  { bv: 'BV1Sea000003', title: '重读人界3：墨大夫的阴谋，这个标题很长很长很长很长很长', up: '', mid: '', duration: '1:02:03', view: '', dm: '', age: 5 * HOUR + 60_000 },
];
/** 分 P 视频（视频页右侧的分 P 列表，data-key 是每一 P 的 cid）：各 P 的上传时间（ctime）由 mock 的 x/player/pagelist 给 */
export const BILI_POD_PARTS_BV = 'BV1Pod000001';
export const BILI_POD_PARTS = [
  { cid: 282152270, part: '尚硅谷Java基础学习导读', duration: '07:09', at: Date.UTC(2021, 0, 14, 12, 0) },
  { cid: 84319446, part: '001.尚硅谷_编程入门-资料文件结构1', duration: '17:05', at: Date.UTC(2019, 3, 3, 12, 0) },
  { cid: 254424617, part: '002.尚硅谷_编程入门-资料文件结构2', duration: '06:22', at: Date.UTC(2020, 10, 10, 12, 0) },
  // B 站没给上传时间（ctime 是 0）
  { cid: 84321034, part: '003.尚硅谷_编程入门-入门概述', duration: '11:32', at: 0 },
];

/**
 * mock 的 B 站接口 /biliapi/x/player/pagelist?bvid=…：分 P 视频每一 P 的 cid 与上传时间（秒）。认不出的视频回空列表
 * @param {string} bvid
 */
export function biliPagelistReply(bvid) {
  if (bvid !== BILI_POD_PARTS_BV) return { code: 0, message: '0', ttl: 1, data: [] };
  return { code: 0, message: '0', ttl: 1, data: BILI_POD_PARTS.map((p, i) => ({ cid: p.cid, page: i + 1, part: p.part, duration: 60, ctime: Math.floor(p.at / 1000) })) };
}

/** 这一批 ID 一查就被 B 站风控拦下（code -352） */
export const BILI_BLOCKED = 'BV1B1ocked00';

const ALL_RECS = [...BILI_RECS, ...BILI_RECS_NEXT, ...BILI_RECS_MORE, ...BILI_LIST, ...BILI_LIST_MORE, ...BILI_LIST_RECS, ...BILI_POD_SEASON].filter((r) => !!r);

/**
 * mock 的 B 站接口 /biliapi/x/article/cards?ids=…：认得的视频回 pubdate（秒），认不得的不出现在结果里（和真实接口一样）。
 * 问到 BILI_BLOCKED 时回风控的 -352。
 * @param {string} ids @param {number} now
 */
export function biliCardsReply(ids, now) {
  const list = ids.split(',').filter(Boolean);
  if (list.includes(BILI_BLOCKED)) return { code: -352, message: '-352', ttl: 1 };
  /** @type {Record<string, unknown>} */
  const data = {};
  for (const id of list) {
    const rec = ALL_RECS.find((r) => r?.bv === id);
    const at = rec?.at ?? (rec?.age !== undefined ? now - rec.age : undefined);
    if (rec && at !== undefined) data[id] = { bvid: id, aid: 1, title: rec.title, pubdate: Math.floor(at / 1000), ctime: Math.floor(at / 1000), owner: { mid: Number(rec.mid), name: rec.up } };
  }
  return { code: 0, message: 'OK', ttl: 1, data };
}

const esc = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const ICON = '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M3 3h12v12H3z" fill="currentColor"></path></svg>';

/** 一条推荐（番剧卡片没有 BV 号） @param {BiliRec | undefined} r @param {number} i */
function recCard(r, i) {
  if (!r) return '';
  const href = `/bili/zh-Hans/video/${r.bv}/?spm_id_from=333.788.recommend_more_video.${i}&amp;trackid=web_related_0.router-related-1.${i}`;
  return (
    `<div class="video-page-card-small"><div class="card-box">` +
    `<div class="pic-box"><div class="pic"><div class="framepreview-box"><a href="${href}" class="video-awesome-img"><div class="b-img"><img class="b-img__inner" alt="${esc(r.title)}"></div></a></div>` +
    `<span class="mask-video"></span><span class="duration">${r.duration}</span></div><div class="watch-later-video van-watchlater black"><span class="wl-tips" style="display: none;"></span></div><div class="v-recommend-inline-player"></div></div>` +
    `<div class="info"><a href="${href}"><p title="${esc(r.title)}" class="title">${esc(r.title)}</p></a> ` +
    `<div class="upname"><a href="//space.bilibili.com/zh-Hans/${r.mid}/" target="_blank">${ICON} <span class="name">${esc(r.up)}</span></a></div> ` +
    `<div class="playinfo">${ICON}\n        ${r.view}\n\n        ${ICON}\n        ${r.dm}\n      </div></div>` +
    `</div></div>`
  );
}

const BANGUMI_CARD =
  `<div class="video-page-card-small" data-kind="bangumi"><div class="card-box"><div class="pic-box"><div class="pic"><a href="/bili/bangumi/play/ep733317"><div class="b-img"><img alt="番剧"></div></a><span class="duration">24:00</span></div></div>` +
  `<div class="info"><a href="/bili/bangumi/play/ep733317"><p title="凡人修仙传" class="title">凡人修仙传</p></a> <div class="playinfo">${ICON} 2.1亿</div></div></div></div>`;

const VIDEO_CSS = `
body { margin: 0; font: 13px/15px system-ui, "Noto Sans CJK SC", sans-serif; color: #18191c; }
#app { display: flex; gap: 24px; padding: 16px; }
.left-container { width: 420px; flex: none; }
.right-container { width: 350px; flex: none; }
.video-page-card-small { margin-bottom: 12px; }
.card-box { display: flex; height: 80px; }
.pic-box { position: relative; width: 141px; height: 80px; flex: none; border-radius: 6px; background: #c9ccd0; margin-right: 10px; }
.pic, .framepreview-box, .video-awesome-img, .b-img { display: block; width: 100%; height: 100%; }
.duration { position: absolute; right: 4px; bottom: 4px; color: #fff; font-size: 13px; }
.watch-later-video { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; background: rgba(0,0,0,.5); border-radius: 4px; display: none; }
.video-page-card-small:hover .watch-later-video { display: block; }
.info { width: 199px; height: 80px; font-size: 13px; line-height: 15px; }
.info .title { margin: 0 0 2px; max-height: 38px; line-height: 19px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.upname { height: 20px; line-height: 20px; color: #9499a0; }
.upname a { color: inherit; text-decoration: none; display: inline-flex; align-items: center; gap: 2px; }
.playinfo { display: inline-flex; align-items: center; gap: 2px; height: 18px; color: #9499a0; }
.playinfo svg, .upname svg { width: 14px; height: 14px; }
.rec-footer { cursor: pointer; text-align: center; padding: 8px; }
`;

/** @param {typeof BILI_PAGE_VIDEO} v */
function videoMeta(v) {
  return (
    `<meta data-vue-meta="true" name="author" content="${esc(v.up)}">` +
    `<meta data-vue-meta="true" property="og:url" content="__ORIGIN__/bili/video/${v.bv}/">` +
    `<meta data-vue-meta="true" property="video:duration" content="${v.seconds}">` +
    `<meta data-vue-meta="true" property="video:release_date" content="${new Date(v.at).toISOString()}">`
  );
}

const VIDEO_SCRIPT = (/** @type {typeof BILI_NEXT_VIDEO} */ next) =>
  // 点到 B 站自己的元素（冒泡到 document 的点击）：记一次，并拦下跳转。TubeMuse 的按钮和弹窗不让点击往外传，不会记进来
  `window.__nativeClicks = 0; document.addEventListener('click', (e) => { if (e.target.closest('#app')) { window.__nativeClicks++; e.preventDefault(); } });` +
  `document.querySelectorAll('meta[content^="__ORIGIN__"]').forEach((m) => m.setAttribute('content', m.getAttribute('content').replace('__ORIGIN__', location.origin)));` +
  // Vue 接管服务端渲染的页面：去掉 data-server-rendered。之前有没有 TubeMuse 的东西插进来（真实页面上那样会整页重画）
  `window.__oursBeforeHydration = -1;` +
  `window.__hydrate = () => { window.__oursBeforeHydration = document.querySelectorAll('[data-tubemuse]').length; document.getElementById('app').removeAttribute('data-server-rendered'); };` +
  `setTimeout(window.__hydrate, 1200);` +
  // 站内跳到别的视频：网址、标题、meta、h1 都换；卡片元素原样复用、只换内容（和真实页面一样）
  `const NEXT = ${JSON.stringify(BILI_RECS_NEXT)};` +
  `const setCard = (card, r, i) => { const href = '/bili/zh-Hans/video/' + r.bv + '/?spm_id_from=333.788.recommend_more_video.' + i;` +
  ` card.querySelectorAll('a[href*="/video/"]').forEach((a) => a.setAttribute('href', href));` +
  ` const t = card.querySelector('.title'); t.textContent = r.title; t.setAttribute('title', r.title);` +
  ` card.querySelector('.upname a').setAttribute('href', '//space.bilibili.com/zh-Hans/' + r.mid + '/'); card.querySelector('.upname .name').textContent = r.up;` +
  ` card.querySelector('.duration').textContent = r.duration;` +
  ` const p = card.querySelector('.playinfo'); const texts = [...p.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()); texts[0].textContent = ' ' + r.view + ' '; if (texts[1]) texts[1].textContent = ' ' + r.dm + ' '; };` +
  `window.__goto = () => {` +
  ` history.pushState(null, '', '/bili/zh-Hans/video/${next.bv}/?spm_id_from=333.788.recommend_more_video.2'); document.title = ${JSON.stringify(next.title + '_哔哩哔哩_bilibili')};` +
  ` const h1 = document.querySelector('h1.video-title'); h1.textContent = ${JSON.stringify(next.title)}; h1.setAttribute('title', ${JSON.stringify(next.title)});` +
  ` document.querySelector('.up-detail-top .up-name').setAttribute('href', '//space.bilibili.com/zh-Hans/${next.mid}/?spm_id_from=333.788.upinfo.detail.click');` +
  ` document.querySelector('.up-detail-top .up-name').textContent = ${JSON.stringify(next.up)};` +
  // meta 比网址晚一点换（真实页面上也是先换网址）
  ` setTimeout(() => { const m = (s, v) => document.querySelector(s).setAttribute('content', v); m('meta[name="author"]', ${JSON.stringify(next.up)}); m('meta[property="og:url"]', location.origin + '/bili/video/${next.bv}/');` +
  `  m('meta[property="video:duration"]', '${next.seconds}'); m('meta[property="video:release_date"]', '${new Date(next.at).toISOString()}'); }, 300);` +
  ` const cards = [...document.querySelectorAll('.video-page-card-small:not([data-kind])')]; cards.forEach((c, i) => { if (NEXT[i]) setCard(c, NEXT[i], i); else c.remove(); }); };` +
  // "展开"：多出一批卡片
  `window.__expand = () => { document.querySelector('.rec-list').insertAdjacentHTML('beforeend', ${JSON.stringify(BILI_RECS_MORE.map((r, i) => recCard(r, 20 + i)).join(''))}); document.querySelector('.rec-footer').style.display = 'none'; };` +
  // 这一批一查就被风控拦下：把第二条换成 BILI_BLOCKED
  `window.__blocked = () => setCard(document.querySelectorAll('.video-page-card-small:not([data-kind])')[1], { bv: '${BILI_BLOCKED}', title: '被拦下的那一批', up: '某人', mid: '2', duration: '01:00', view: '1', dm: '0' }, 1);`;

/** 视频页 /bili/video/<BV号>/（前面可以带 /zh-Hans/）：服务端渲染、1.2 秒后由"Vue"接管 */
function videoPage() {
  const v = BILI_PAGE_VIDEO;
  const recs = BILI_RECS;
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(v.title)}_哔哩哔哩_bilibili</title>${videoMeta(v)}<style>${VIDEO_CSS}</style></head>` +
    `<body><div id="app" data-server-rendered="true" class="app-v1">` +
    `<div class="left-container"><div class="video-info-title"><h1 data-title="${esc(v.title)}" title="${esc(v.title)}" class="video-title">${esc(v.title)}</h1></div>` +
    `<div class="up-detail-top"><a href="//space.bilibili.com/zh-Hans/${v.mid}/?spm_id_from=333.788.upinfo.detail.click" target="_blank" class="up-name">${esc(v.up)}</a></div>` +
    `<div id="bilibili-player"></div></div>` +
    `<div class="right-container"><div class="rcmd-tab"><div class="recommend-list-v1">` +
    `<div class="next-play"><div class="rec-title"><div class="title-txt">接下来播放</div></div>${recCard(recs[0], -1)}</div>` +
    `<div class="rec-list">${recs.slice(1).map((r, i) => recCard(r, i)).join('')}${BANGUMI_CARD}</div>` +
    `<div class="rec-footer">展开</div>` +
    `</div></div></div>` +
    `</div><script>${VIDEO_SCRIPT(BILI_NEXT_VIDEO)}</script></body></html>`
  );
}

/** 播放列表右侧列表的一项：.action-list-item-wrap[data-key=<BV号>] > … > .main > .cover + .info（.title[title]、.views）；没有链接 @param {BiliRec} r @param {number} i */
function listItem(r, i) {
  return (
    `<div data-key="${r.bv}" data-index="${i}_${1000 + i}" class="action-list-item-wrap"><div class="action-list-item"><div class="singlep-list-item-inner"><div class="main">` +
    `<div class="cover"><!----> <!----></div> <div class="info"><div title="${esc(r.title)}" class="title"><div class="playing-gif b-img sleepy" style="display:none;"></div>\n        ${esc(r.title)}\n      </div> <div class="views">${r.view}</div></div>` +
    `</div></div></div></div>`
  );
}

/** 播放列表页下面的推荐：.recommend-video-card.video-card > .card-box > .pic-box + .info（a > p.title、a.upname > span.name、.playinfo） @param {BiliRec} r @param {number} i */
function listRecCard(r, i) {
  const href = `/bili/zh-Hans/video/${r.bv}?spm_id_from=333.1245.recommend_more_video.${i}`;
  return (
    `<div class="recommend-video-card video-card"><div class="card-box"><div class="pic-box"><a href="${href}" target="_blank" class="rcmd-cover"><div class="rcmd-cover-img b-img"><img alt=""></div></a> <span class="duration">${r.duration}</span> <div class="watch-later-video van-watchlater black"></div><div class="v-recommend-inline-player"></div></div> ` +
    `<div class="info"><a href="${href}" target="_blank"><p title="${esc(r.title)}" class="title">${esc(r.title)}</p></a> <a href="//space.bilibili.com/zh-Hans/${r.mid}?spm_id_from=333.1245" target="_blank" class="upname">${ICON} <span class="name">${esc(r.up)}</span></a> <!----> ` +
    `<div class="playinfo">${ICON}\n        ${r.view}\n        ${ICON}\n        ${r.dm}\n      </div></div></div></div>`
  );
}

/** 分 P 视频那一项：data-key 不是 BV 号（实测见到的是数字），不显示时间、不放按钮 */
const LIST_MULTIP = `<div data-key="26234588020" data-index="9_9" class="action-list-item-wrap"><div class="action-list-item"><div class="multip-list-item"><div class="main"><div class="cover"></div> <div class="info"><div title="分P视频" class="title">分P视频</div> <div class="views">3万播放</div></div></div></div></div></div>`;

const LIST_CSS = `
body { margin: 0; font: 14px/16px system-ui, "Noto Sans CJK SC", sans-serif; color: #18191c; }
.playlist-container { display: flex; gap: 24px; padding: 16px; }
.playlist-container--left { width: 420px; flex: none; }
.playlist-container--right { width: 360px; flex: none; }
.action-list { height: 420px; overflow: auto; }
.action-list-item-wrap { padding: 6px 10px; cursor: pointer; }
.main { display: flex; }
.cover { position: relative; overflow: hidden; width: 106px; height: 60px; flex: none; margin-right: 10px; border-radius: 4px; background: #c9ccd0; }
.info { display: flex; flex-direction: column; justify-content: space-between; height: 60px; width: 202px; }
.info .title { font-size: 14px; line-height: 19px; max-height: 38px; overflow: hidden; }
.views { display: block; font-size: 14px; line-height: 16px; color: #9499a0; }
.recommend-video-card { margin-top: 12px; }
.recommend-video-card .card-box { display: flex; height: 80px; }
.recommend-video-card .pic-box { position: relative; width: 141px; height: 80px; flex: none; margin-right: 10px; background: #c9ccd0; }
.recommend-video-card .info { width: 199px; height: 80px; font-size: 13px; line-height: 15px; }
.recommend-video-card .title { margin: 0 0 2px; max-height: 38px; line-height: 19px; overflow: hidden; }
/* 实测：这里的 UP 主那一行和播放量那一行都是占满一行的 flex（"接下来播放"的 .playinfo 是 inline-flex） */
.recommend-video-card .upname { display: flex; align-items: center; height: 20px; color: #9499a0; text-decoration: none; }
.recommend-video-card .playinfo { display: flex; align-items: center; gap: 2px; height: 18px; color: #9499a0; }
.recommend-video-card svg { width: 14px; height: 14px; }
.duration { position: absolute; right: 4px; bottom: 4px; color: #fff; }
`;

/** 播放列表页 /bili/list/<ID>?bvid=…（前面可以带 /en/、/zh-Hans/）：不是服务端渲染的；点一项在页面里换视频，往下滚加载下一批 */
function listPage() {
  const cur = BILI_LIST[0];
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(cur?.title ?? '')}-赛博天国-赛博天国-哔哩哔哩视频</title>` +
    `<meta data-vue-meta="true" name="author" content="赛博天国"><meta data-vue-meta="true" property="og:url" content="__ORIGIN__/bili/list/${BILI_LIST_ID}?oid=1&amp;bvid=${cur?.bv}">` +
    `<style>${LIST_CSS}</style></head><body><div id="app" class="app-v1"><div class="playlist-container">` +
    `<div class="playlist-container--left"><h1 class="video-title" title="${esc(cur?.title ?? '')}">${esc(cur?.title ?? '')}</h1><div id="bilibili-player"></div></div>` +
    `<div class="playlist-container--right"><div class="action-list-container"><div class="action-list-header">赛博天国 1/272 UP主的全部视频</div>` +
    `<div class="action-list"><div class="action-list-inner"><div class="action-list-content">${BILI_LIST.map(listItem).join('')}${LIST_MULTIP}</div></div></div></div>` +
    `<div class="recommend-list-container">${BILI_LIST_RECS.map(listRecCard).join('')}</div></div>` +
    `</div></div><script>` +
    `window.__nativeClicks = 0; document.addEventListener('click', (e) => { if (e.target.closest('#app')) { window.__nativeClicks++; e.preventDefault(); } });` +
    `document.querySelectorAll('meta[content^="__ORIGIN__"]').forEach((m) => m.setAttribute('content', m.getAttribute('content').replace('__ORIGIN__', location.origin)));` +
    `window.__loadMore = () => document.querySelector('.action-list-content').insertAdjacentHTML('beforeend', ${JSON.stringify(BILI_LIST_MORE.map((r, i) => listItem(r, 10 + i)).join(''))});` +
    `</script></body></html>`
  );
}

const POD_CSS = `
body { margin: 0; font: 14px/16px system-ui, "Noto Sans CJK SC", sans-serif; color: #18191c; }
#app { display: flex; gap: 24px; padding: 16px; }
.left-container { width: 420px; flex: none; }
.video-pod { width: 338px; flex: none; background: #f6f7f8; border-radius: 6px; padding: 8px 0; }
.simple-base-item { display: flex; flex-direction: row; align-items: center; justify-content: space-between; height: 31px; line-height: 12px; padding: 0 12px; box-sizing: border-box; }
.simple-base-item .title { display: flex; flex: 1 1 0%; min-width: 0; font-size: 15px; }
.title-txt { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.simple-base-item .stats { display: block; flex: 0 0 auto; margin-left: 10px; font-size: 14px; color: #9499a0; }
.stat-item { display: block; font-size: 14px; line-height: 14px; }
`;

/** 合集 / 分 P 列表的一行：.simple-base-item > .title[title]（.playing-gif、.title-txt）+ .stats > .stat-item.duration @param {string} cls @param {string} key @param {string} title @param {string} duration */
function podRow(cls, key, title, duration) {
  return (
    `<div class="simple-base-item ${cls}"${key ? ` data-key="${key}"` : ''}><div title="${esc(title)}" class="title"><div class="playing-gif" style="display:none"></div><div class="title-txt">${esc(title)}</div></div>` +
    `<div class="stats"><div class="stat-item duration">${duration}</div></div></div>`
  );
}

/** 视频页（只有合集 / 分 P 列表）：/bili/video/<合集里的视频>/ 或 /bili/video/<分 P 视频>/?p=… @param {'season' | 'parts'} kind */
function podPage(kind) {
  const bv = kind === 'season' ? (BILI_POD_SEASON[1]?.bv ?? '') : BILI_POD_PARTS_BV;
  const title = kind === 'season' ? (BILI_POD_SEASON[1]?.title ?? '') : '尚硅谷Java入门视频教程';
  const items =
    kind === 'season'
      ? BILI_POD_SEASON.map((r) => `<div class="pod-item video-pod__item simple" data-key="${r.bv}"><div class="single-p">${podRow(r.bv === bv ? 'active normal' : 'normal', '', r.title, r.duration)}</div></div>`).join('')
      : BILI_POD_PARTS.map((p, i) => podRow(`video-pod__item ${i === 1 ? 'active ' : ''}normal`, String(p.cid), p.part, p.duration)).join('');
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}_哔哩哔哩_bilibili</title>` +
    `<meta data-vue-meta="true" name="author" content="某UP"><meta data-vue-meta="true" property="og:url" content="__ORIGIN__/bili/video/${bv}/">` +
    `<style>${POD_CSS}</style></head><body><div id="app"><div class="left-container"><h1 class="video-title" title="${esc(title)}">${esc(title)}</h1><div id="bilibili-player"></div></div>` +
    `<div class="right-container"><div class="video-pod"><div class="video-pod__header">${kind === 'season' ? `重读《凡人》人界篇 （2/${BILI_POD_SEASON.length}）` : `视频选集 （2/${BILI_POD_PARTS.length}）`}</div>` +
    `<div class="video-pod__body"><div class="video-pod__list section">${items}</div></div></div></div></div><script>` +
    `window.__nativeClicks = 0; document.addEventListener('click', (e) => { if (e.target.closest('#app')) { window.__nativeClicks++; e.preventDefault(); } });` +
    `document.querySelectorAll('meta[content^="__ORIGIN__"]').forEach((m) => m.setAttribute('content', m.getAttribute('content').replace('__ORIGIN__', location.origin)));` +
    `</script></body></html>`
  );
}

/** @param {string} path /bili/ 开头的路径；认不出的返回 undefined（mock 回 404） */
export function biliVideoPage(path) {
  if (new RegExp(`^/bili/(?:zh-Hans/)?video/${BILI_POD_SEASON[1]?.bv}/?$`).test(path)) return podPage('season');
  if (new RegExp(`^/bili/(?:zh-Hans/)?video/${BILI_POD_PARTS_BV}/?$`).test(path)) return podPage('parts');
  if (new RegExp(`^/bili/(?:zh-Hans/|en/)?list/${BILI_LIST_ID}/?$`).test(path)) return listPage();
  return new RegExp(`^/bili/(?:zh-Hans/)?video/${BILI_PAGE_VIDEO.bv}/?$`).test(path) ? videoPage() : undefined;
}
