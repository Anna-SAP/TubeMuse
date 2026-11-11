// @ts-check
// e2e 用的仿小红书网页版页面（由 mock 服务在 /xhs/ 下提供）。结构照 2026-11-03 实测的真实页面：
// - 笔记卡片 section.note-item[data-index] > div > 隐藏链接 + a.cover + .footer(a.title, .author-wrapper(a.author, .like-wrapper))；
// - 瀑布流：页面自己的脚本按当时量到的卡片高度算好位置（transform），之后卡片变高不会重排——卡片变高就会压住下面那张；
// - 页面数据 window.__INITIAL_STATE__：个人主页的笔记列表是 Vue ref（_rawValue），列表项带 noteCard.time；首页卡片流不带时间；
// - 未登录时卡片链接里没有笔记 ID（/user/profile/<用户>/），页面数据里 noteId 也是空的；
// - 笔记详情（2026-11-04 实测）：#noteContainer 下有两份作者栏，顶上的 .author 是藏起来的，看得见的在右侧互动区
//   .interaction-container .author-container 里；视频笔记的播放器是 .media-container .player-container .player-el.xgplayer > video。
// - 笔记正文在标题下面的 #detail-desc 里：文字和 #话题 链接都包在 .note-text 里（「问 muse」读它；评论在另一块 .comments-el 里）。
// 页面记下小红书自己元素上的点击次数，用来确认 TubeMuse 从不替你点"关注"、点赞或打开笔记。

export const XHS_UID = '67398f95000000001d02d725';
/** 页面数据里的发布时间比 ID 推算的晚约 2 小时（实测的定时 / 审核后发布笔记） */
export const XHS_N1 = { id: '691d6e07000000001d03be5e', time: Date.parse('2025-11-19T09:10:02Z'), title: '毛不易 田曦薇 李诞都在看的书', token: 'ABtoken1=', desc: '这本书我读了三遍。\n推荐给想静下来的人 #读书' };
/** 未登录样式：卡片上没有笔记 ID，只能按位置 + 标题对上页面数据 */
export const XHS_N2 = { time: Date.parse('2026-10-25T12:00:00Z'), title: '再也不用代购了，真的太好吃！' };
/** 页面数据里没有：由笔记 ID 推算 */
export const XHS_N3 = { id: '6ae12de4000000003401f5b2', idTime: Date.parse('2026-10-27T23:04:04Z'), title: '上海富民路咖啡 巨好喝！', token: 'ABtoken3=' };
/** 虚拟列表把一张卡片换成这一篇 */
export const XHS_N4 = { id: '6a6a0e23000000001b01db99', idTime: Date.parse('2026-07-29T14:28:51Z'), title: '换上来的新卡片' };
/** 视频笔记：片段录制（视频是 /xhs/media/ 下的一段有声音的 WAV） */
export const XHS_V1 = {
  id: '6ae9a4e000000000140281c6',
  time: Date.parse('2026-11-03T09:09:00Z'),
  title: '视频日记Day255｜一人公司怎么做?',
  token: 'ABvideo1=',
  seconds: 12,
  desc: '一人公司的第一步：先把一件小事做到有人愿意付钱。\n今天聊聊我踩过的坑 #一人公司 #创业',
};

const CSS = `
body { margin: 0; font-family: system-ui, sans-serif; color: #333; }
.user-nickname { display: flex; align-items: center; font-size: 24px; font-weight: 600; padding: 16px; }
#userPostedFeeds { position: relative; width: 520px; visibility: hidden; }
section.note-item { position: absolute; left: 0; top: 0; width: 240px; }
.cover { display: block; height: 300px; border-radius: 16px; background: #ddd; position: relative; }
.footer { padding: 12px; }
.title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 14px; line-height: 19.6px; margin: 0 0 8px; color: #333; text-decoration: none; }
.author-wrapper { display: flex; align-items: center; justify-content: space-between; height: 20px; font-size: 12px; line-height: 13.8px; color: rgba(51, 51, 51, .8); }
.author { display: flex; align-items: center; overflow: hidden; margin-right: 12px; color: inherit; text-decoration: none; height: 20px; }
.avatar-container { width: 20px; height: 20px; border-radius: 50%; background: #ccc; flex: none; margin-right: 6px; }
.name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.like-wrapper { display: flex; align-items: center; position: relative; gap: 2px; }
.like-icon { width: 16px; height: 16px; border-radius: 50%; border: 1px solid #999; box-sizing: border-box; }
#noteContainer { display: flex; flex-direction: column; gap: 12px; padding: 16px; width: 380px; }
#noteContainer > .author { display: none; }
#noteContainer .author-wrapper { height: auto; }
.player-el video { width: 320px; height: 180px; background: #000; }
#noteContainer .info { display: flex; align-items: center; }
.follow-button { border-radius: 999px; background: #ff2442; color: #fff; border: 0; padding: 8px 16px; }
.bottom-container { font-size: 14px; color: rgba(51, 51, 51, .6); }
`;

/** 页面自己的点击计数：TubeMuse 的按钮把事件拦在自己身上，小红书的元素一次都不该被点到 */
const CLICK_COUNTER = `window.__nativeClicks = 0; document.addEventListener('click', (e) => { if (e.target.closest('section.note-item, .follow-button, .like-wrapper')) { window.__nativeClicks++; e.preventDefault(); } });`;

/** @param {{ index: number; title: string; noteId?: string; token?: string; likes: number }} c */
function card(c) {
  const note = c.noteId ? `/xhs/user/profile/${XHS_UID}/${c.noteId}` : `/xhs/user/profile/${XHS_UID}/`;
  const q = `?xsec_token=${encodeURIComponent(c.token ?? 'ABanon=')}&xsec_source=pc_user`;
  return (
    `<section class="note-item" data-index="${c.index}" data-width="1440" data-height="1920"><div>` +
    `<a href="${note}" style="display: none;"></a>` +
    `<a class="cover mask ld" target="_self" href="${note}${q}"><span class="play-icon"></span></a>` +
    `<div class="footer"><a href="${note}${q}" target="_self" class="title"><span>${c.title}</span></a>` +
    `<div class="author-wrapper"><a href="/xhs/user/profile/${XHS_UID}?channel_type=web_user_page&parent_page_channel_type=web_user_board&xsec_token=&xsec_source=pc_note" class="author" target="_blank">` +
    `<div class="avatar-container"></div><span class="name">李诞小卖部</span></a>` +
    `<span class="like-wrapper like-active"><span class="like-icon"></span><span class="count">${c.likes}</span></span></div></div>` +
    `</div></section>`
  );
}

/** 小红书自己的瀑布流：按当时量到的卡片高度一次排好（与真实页面的首屏脚本相同），之后不再重排 */
const LAYOUT = `
(function () {
  const feed = document.querySelector('#userPostedFeeds');
  const cols = [0, 0];
  window.__layout = [];
  for (const note of feed.querySelectorAll('section.note-item')) {
    const col = cols[0] <= cols[1] ? 0 : 1;
    const top = cols[col];
    note.style.transform = 'translate(' + col * 260 + 'px,' + top + 'px)';
    window.__layout.push({ index: note.dataset.index, col, top, height: note.clientHeight });
    cols[col] = top + note.clientHeight + 6;
  }
  feed.style.height = Math.max(cols[0], cols[1]) + 'px';
  feed.style.visibility = 'visible';
})();
/** 模拟虚拟列表回收：同一个卡片元素换成另一篇笔记 */
window.__recycle = function (index, noteId, title) {
  const s = document.querySelector('section.note-item[data-index="' + index + '"]');
  s.dataset.index = String(index + 10);
  for (const a of s.querySelectorAll('a.cover, a.title')) a.setAttribute('href', '/xhs/user/profile/${XHS_UID}/' + noteId + '?xsec_token=ABrecycled%3D&xsec_source=pc_user');
  s.querySelector('a[style]').setAttribute('href', '/xhs/user/profile/${XHS_UID}/' + noteId);
  s.querySelector('.title span').textContent = title;
};
`;

function profilePage() {
  const ref = (/** @type {unknown} */ v) => ({ __v_isRef: true, _rawValue: v, _value: v, dep: { circular: null } });
  const notes = [
    { id: XHS_N1.id, index: 0, noteCard: { noteId: XHS_N1.id, displayTitle: XHS_N1.title, time: XHS_N1.time, type: 'video', user: { userId: XHS_UID, nickname: '李诞小卖部' }, interactInfo: { likedCount: '2387' } } },
    { id: '', index: 1, noteCard: { noteId: '', displayTitle: XHS_N2.title, time: XHS_N2.time, type: 'normal', user: { userId: XHS_UID, nickname: '李诞小卖部' }, interactInfo: { likedCount: '3' } } },
  ];
  const state = { user: { loggedIn: ref(true), userPageData: ref({ basicInfo: { nickname: '李诞小卖部' } }), notes: ref([notes, [], [], [], []]) } };
  /** 页面数据里有循环引用（Vue 的依赖表、父子对象互指）：页面内助手不能因此卡住 */
  const circular = `window.__INITIAL_STATE__ = ${JSON.stringify(state)}; window.__INITIAL_STATE__.user.notes.dep.circular = window.__INITIAL_STATE__; window.__INITIAL_STATE__.user.userPageData._rawValue.back = window.__INITIAL_STATE__.user;`;
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>李诞小卖部 - 小红书</title><style>${CSS}</style><script>${circular}</script></head><body>` +
    `<div class="user-info"><div class="info-part"><div class="info"><div class="basic-info"><div class="user-basic"><div class="user-nickname"><div class="user-name">李诞小卖部</div></div>` +
    `<div class="user-content"><span class="user-redId">小红书号：11549589919</span></div></div></div></div></div></div>` +
    `<div class="feeds-tab-container"><div id="userPostedFeeds" class="feeds-container">` +
    card({ index: 0, title: XHS_N1.title, noteId: XHS_N1.id, token: XHS_N1.token, likes: 2387 }) +
    card({ index: 1, title: XHS_N2.title, likes: 3 }) +
    card({ index: 2, title: XHS_N3.title, noteId: XHS_N3.id, token: XHS_N3.token, likes: 1 }) +
    `</div></div><script>${LAYOUT}${CLICK_COUNTER}</script></body></html>`
  );
}

/** 作者栏：头像、名字、"关注"（详情页里有两份，见文件开头） */
const authorRow = () =>
  `<div class="author-wrapper"><div class="info">` +
  `<a href="/xhs/user/profile/${XHS_UID}?channel_type=web_note_detail_r10&xsec_token=ABuser%3D&xsec_source=pc_note" class="name" target="_blank"><span class="username">李诞小卖部</span></a></div>` +
  `<div class="note-detail-follow-btn"><button class="reds-button-new follow-button">关注</button></div></div>`;

/** 评论区每条评论也有 .author-wrapper（里面没有 .info）：收藏按钮不该放到这里 */
const comment = `<div class="comments-el"><div class="comment-item"><div class="right"><div class="author-wrapper"><div class="author"><a class="name" href="/xhs/user/profile/5c8347c70000000012001dde">自如签</a></div><div class="comment-menu"></div></div><div class="content">听了半天</div></div></div></div>`;

/** 笔记正文（2026-11-11 实测 rednote.com）：换行就是文字里的换行符（white-space: pre-wrap），#话题 是指向搜索页的链接 */
const noteDesc = (/** @type {string} */ desc) =>
  `<div id="detail-desc" class="desc"><span class="note-text" style="white-space: pre-wrap"><span>${desc.replace(/#(\S+)/g, '</span><a class="tag" href="/xhs/search_result?keyword=$1">#$1</a><span>')}</span></span></div>`;

/** @param {{ id: string; title: string; time: number; desc: string; video?: boolean }} n */
function notePage(n) {
  const state = { note: { firstNoteId: { __v_isRef: true, _rawValue: n.id }, noteDetailMap: { [n.id]: { note: { noteId: n.id, title: n.title, time: n.time, lastUpdateTime: n.time - 3600_000, type: n.video ? 'video' : 'normal' } } } } };
  const media = n.video ? `<div class="media-container video-player-media"><div class="player-container"><div class="player-el xgplayer xgplayer-pc"><video preload="auto" src="/xhs/media/${n.id}.wav"></video><xg-controls class="xgplayer-controls"></xg-controls></div></div></div>` : '';
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${n.title} - 小红书</title><style>${CSS}</style><script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};</script></head><body>` +
    `<div class="note-detail-mask"><div id="noteContainer" class="note-container"><div class="author">${authorRow()}</div>${media}` +
    `<div class="interaction-container"><div class="author-container">${authorRow()}</div>` +
    `<div class="note-scroller"><div class="note-content"><div id="detail-title" class="title">${n.title}</div>${noteDesc(n.desc)}<div class="bottom-container"><span class="date">2025-11-19</span></div></div>${comment}</div></div></div></div>` +
    `<script>${CLICK_COUNTER}</script></body></html>`
  );
}

/** /xhs/media/<笔记 ID>.wav：视频笔记的"视频"有多少秒；不是视频笔记返回 undefined */
export function xhsMediaSeconds(/** @type {string} */ path) {
  return path === `/xhs/media/${XHS_V1.id}.wav` ? XHS_V1.seconds : undefined;
}

/** @param {string} path /xhs/ 之后的路径；认不出的返回 undefined（mock 回 404） */
export function xhsPage(path) {
  if (path.startsWith(`/xhs/user/profile/${XHS_UID}`)) return profilePage();
  if (path === `/xhs/explore/${XHS_N1.id}`) return notePage(XHS_N1);
  if (path === `/xhs/explore/${XHS_V1.id}`) return notePage({ ...XHS_V1, video: true });
  return undefined;
}
