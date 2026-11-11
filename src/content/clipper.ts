// 注入 YouTube 播放页的视频片段录制脚本（用户 2026-11-01 批准的红线变更，见 DECISIONS §36）；
// 2026-11-04 起也注入小红书网页版，录笔记详情里的视频（用户要求，见 DECISIONS §43）；
// 2026-11-06 起也注入 X 网页版，录帖子里的视频（用户要求，见 DECISIONS §52）；2026-11-10 起首页信息流（x.com/home）上
// 也能录正在播放、开着声音的那个视频，为此只读它所在那一条帖子的链接、作者名和正文（用户批准的红线变更，见 DECISIONS §55）；
// 2026-11-10 起也注入酷播（www.kubb.tv），录播放页 /play/<ID> 里的视频（用户要求，见 DECISIONS §54）；
// 2026-11-10 起也注入 Instagram 网页版，只录首页信息流里正在播放、开着声音的那个视频，逻辑与 X 首页信息流相同（用户要求，见 DECISIONS §56）；
// 2026-11-10 起也注入抖音网页版，录精选页（/jingxuan 及其类目）里打开的那条视频（网址带 ?modal_id=，用户要求，见 DECISIONS §57）；
// 2026-11-11 起搜索结果页（/search/<搜索词>，或 /jingxuan/search/<搜索词> 这种前面带着发起搜索时所在路径的）里点开的视频也录
// （用户要求，页面结构相同，见 DECISIONS §58、§59）：
// 1. 只在你从侧边栏"片段"页或快捷键开始录制后工作：把正在播放的这个视频逐帧画到一块不放进页面的画布上
//    （开启字幕烧录时再叠加播放器里当时显示的字幕，只限 YouTube），声音经 video.captureStream() 取这个视频的音轨，
//    交给浏览器自带的 MediaRecorder 编码。不是麦克风、不是整个标签页；不抓取、不下载这些网站的音视频流。
// 2. 广告（YouTube 认得出；酷播只认得出"不是正片的流、又很短"的片头广告；X 认不出；Instagram 的广告帖子没有帖子链接，不让录；抖音没有片头广告）、
//    暂停、缓冲、标签页在后台时自动暂停录制；切到别的视频（小红书：关掉这篇笔记；X：离开这条帖子；酷播：换一部或换一集；
//    Instagram：离开首页；抖音：划到下一条或关掉这条视频）时这一段自动结束。
// 3. 录好的片段只在这个页面的内存里；你点"保存"（或开着"停止后直接保存"）时由浏览器存进下载文件夹，
//    之后只把文件名、时间段、大小交给扩展后台记一笔。本脚本不发任何网络请求、不改动页面
//    （画布和下载链接都不放进页面），除了自己的下载链接不点击任何东西，构建时自动检查。
// 4. 读取的页面信息只有：播放器状态、页面标题（只用来显示和起文件名）、开启字幕烧录时播放器里当时显示的字幕文字；
//    X、Instagram 首页信息流上另读锁定的视频所在那一条帖子的链接、作者名和正文（显示、起文件名、记下回到帖子的链接），别的帖子不读；
//    抖音另读当前这条视频上的作者昵称和描述（页面标题在划到下一条时不更新，不能用），别的视频不读。
// 5. Capture 截图（用户 2026-11-06 要求，见 DECISIONS §50、§52）：只在你点按钮时，把这一帧按视频的真实尺寸
//    画到不放进页面的画布上，在本机编成 PNG，由侧边栏取走后交给浏览器保存（这里不保存：从这个页面连续下载，
//    第二次起会被 Chrome 拦下）。不录声音、不带字幕和播放器控件，广告时不截。
// 6. 「问 muse」（用户 2026-11-11 要求，见 DECISIONS §60）：只在你点侧边栏顶部的「问 muse」时，把当前这条视频 / 帖子的
//    链接、标题、作者、正文（或描述）和这一刻的播放位置读一次，交给侧边栏拼成一段文字（咨询包），由你自己粘贴到 Muse。
//    不暂停视频、不改页面、不发网络请求；读的都是当前这一条：第 4 点里已经在读的那些，外加小红书这篇笔记的作者名和正文；
//    X 帖子页的作者和正文来自页面标题。别的帖子、评论、弹幕不读。
// 受版权保护（DRM）的视频浏览器不允许录制或截图，本脚本不绕过。

import { CLIPS, DEFAULT_SETTINGS, MUSE } from '../config/defaults';
import { MULTICC_LINE_COLORS } from '../core/multi-captions';
import { MUSE_MSG, museItem, museUnavailable, type MuseSnapshot } from '../core/muse';
import { parseXhsUrl, xhsPath } from '../core/xhs';
import {
  CLIP_MSG,
  CLIP_STOP_LABELS,
  CLIP_WAIT_LABELS,
  atVideoEnd,
  bytesToBase64,
  checkCapture,
  checkClipStart,
  clipFileName,
  clipUnavailable,
  decideClip,
  formatTimecode,
  feedPostTitle,
  igProfileName,
  isDouyinPage,
  isIgHomeUrl,
  isIgPage,
  isKubbAd,
  isKubbPage,
  isXHomeUrl,
  isXPage,
  layoutBurnIn,
  loopedToStart,
  mp4TrackKinds,
  outputSize,
  parseDouyinUrl,
  parseIgPostUrl,
  parseKubbPlayUrl,
  parseXStatusUrl,
  pickClipFormat,
  pickFeedVideo,
  pickXVideo,
  titleFromDocumentTitle,
  videoBitrate,
  visibleArea,
  xPostParts,
  type BurnBox,
  type BurnLine,
  type ClipCaptureReply,
  type ClipFormat,
  type ClipMode,
  type ClipRecord,
  type ClipSite,
  type ClipStartRequest,
  type ClipStopReason,
  type ClipTabState,
  type ClipWaitReason,
  type ReadyClipInfo,
} from '../core/clips';
import { videoIdFromUrl } from '../core/watch';

type ClipSettings = typeof DEFAULT_SETTINGS.clips;

const FONT = '"YouTube Noto", Roboto, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Noto Sans JP", sans-serif';

/** 这个页面是哪个站：小红书网页版（xiaohongshu.com / rednote.com）、X 网页版、酷播（www.kubb.tv）、Instagram 网页版、抖音网页版或 YouTube */
const SITE: ClipSite = xhsPath(location.href)
  ? 'xhs'
  : isXPage(location.href)
    ? 'x'
    : isKubbPage(location.href)
      ? 'kubb'
      : isIgPage(location.href)
        ? 'ig'
        : isDouyinPage(location.href)
          ? 'douyin'
          : 'youtube';
/** X 和 Instagram：一页有好几个视频，录的是哪个、属于哪条帖子要从页面上认（见 feedSiteNow） */
const FEED_SITE = SITE === 'x' || SITE === 'ig';

let settings: ClipSettings = { ...DEFAULT_SETTINGS.clips };
let fontScale = DEFAULT_SETTINGS.subtitles.fontScale;

interface Recording {
  id: string;
  mode: ClipMode;
  videoId: string;
  /** 开始录制时的网址（小红书、X、酷播：记下原处的链接，离开之后再保存也对得上）；X、Instagram 首页信息流上是这条帖子的链接 */
  pageUrl: string;
  /** 在首页信息流（X、Instagram）里开录的：网址里没有帖子 ID，换没换视频只看这个元素还在不在、人还在不在首页（见 feedRecordingId） */
  feed: boolean;
  title?: string;
  start?: number;
  end?: number;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  width: number;
  height: number;
  burn: boolean;
  format: ClipFormat;
  maxSec: number;
  /** 这个视频的音视频流（只取音轨；YouTube 换片源、插广告时会换新音轨，见 connectAudio） */
  source: MediaStream;
  ac: AudioContext;
  dest: MediaStreamAudioDestinationNode;
  audioNodes: Map<string, MediaStreamAudioSourceNode>;
  canvasTrack: MediaStreamTrack;
  recorder: MediaRecorder;
  /** 录音机等到第一次真正要录时才 start()，见 startRecorder */
  started: boolean;
  /** MP4 文件头已查过（或正在查）有没有声音轨，见 checkMp4Header */
  headerChecked: boolean;
  chunks: Blob[];
  bytes: number;
  recordedSec: number;
  lastTick: number;
  userPaused: boolean;
  waiting?: ClipWaitReason;
  /** 录到的第一刻与最后一刻（视频时间），用来给文件起名 */
  mediaFirst?: number;
  mediaLast?: number;
  /** 上一次看到播放进度变化：进度在播放中久不动算卡住（见 CLIPS.stallMs） */
  seenTime: number;
  seenAt: number;
  lastDrawAt: number;
  frameHandle?: number;
  fallbackTimer?: ReturnType<typeof setInterval>;
  burnLines: BurnLine[];
  burnKey: string;
  burnBoxes: BurnBox[];
  stopping?: ClipStopReason;
  errorText?: string;
  errorHint?: string;
  /** 这一段不产出文件（例如注定没有声音） */
  discard?: boolean;
}

interface ReadyClip extends ReadyClipInfo {
  blob: Blob;
  url?: string;
  videoId: string;
  pageUrl: string;
  title?: string;
  mode: ClipMode;
}

let rec: Recording | undefined;
let ready: ReadyClip | undefined;
/** 截好、等侧边栏取走的一帧 */
let shot: { id: string; bytes: Uint8Array; holdTimer: ReturnType<typeof setTimeout> } | undefined;
let lastError: { message: string; hint?: string } | undefined;
let lastState = '';
let timer: ReturnType<typeof setInterval> | undefined;

function alive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function playerEl(): HTMLElement | null {
  return SITE === 'youtube' ? document.getElementById('movie_player') : null;
}

/** 小红书笔记详情（单独的页面或弹出的浮层）里播放器的视频；找不到播放器时退而求其次，取笔记里的视频 */
const XHS_PLAYER_VIDEO = '#noteContainer .player-container video, #noteContainer .xgplayer video, .note-container .xgplayer video';
const XHS_ANY_VIDEO = '#noteContainer video, .note-container video';

/** X 帖子页上你正在看的视频（判断见 pickXVideo） */
function xStatusVideoEl(): HTMLVideoElement | null {
  const all = [...document.querySelectorAll('video')];
  const pick = pickXVideo(
    all.map((v) => ({
      visibleArea: visibleArea(v.getBoundingClientRect(), innerWidth, innerHeight),
      inDialog: !!v.closest('[role="dialog"]'),
      playing: !v.paused && !v.ended,
      started: v.currentTime > 0,
    })),
  );
  return all[pick] ?? null;
}

/** 首页信息流（X、Instagram）里一条帖子的链接、ID 和"作者 - 正文"；作者、正文另外各留一份（「问 muse」分开用） */
interface FeedPost {
  id: string;
  url: string;
  title?: string;
  author?: string;
  text?: string;
}

/** 帖子的链接、作者、正文 → FeedPost（标题是"作者 - 正文"，见 feedPostTitle） */
function feedPost(page: { id: string; url: string }, author: string, text: string): FeedPost {
  const title = feedPostTitle(author, text);
  const [a, t] = [author.replace(/\s+/g, ' ').trim(), text.trim()];
  return { ...page, ...(title ? { title } : {}), ...(a ? { author: a } : {}), ...(t ? { text: t } : {}) };
}

/** 这个页面上现在该录的视频、帖子 ID、帖子链接和标题（X、Instagram）；feed：现在是不是在首页信息流上 */
interface FeedSiteNow {
  feed: boolean;
  video: HTMLVideoElement | null;
  videoId: string | null;
  url?: string;
  title?: string;
  /** 首页信息流上锁定的视频所在的那条帖子 */
  post?: FeedPost;
}

/** 首页信息流里锁定的视频和它所在的帖子（判断见 pickFeedVideo）；离开首页就清掉 */
let feedLock: { video: HTMLVideoElement; post?: FeedPost } | undefined;

/** 帖子上的一段文字：表情是图片时取它的替代文字，换行照算；t.co 短链（X 把媒体和外链都写成这种）和按钮（抖音描述后面的"展开"）不要 */
function postText(el: Element | null | undefined): string {
  let out = '';
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue ?? '';
    else if (n instanceof HTMLImageElement) out += n.alt;
    else if (n instanceof HTMLBRElement) out += '\n';
    else if (!(n instanceof HTMLButtonElement) && !(n instanceof HTMLAnchorElement && /^https?:\/\/t\.co\//.test(n.href))) n.childNodes.forEach(walk);
  };
  if (el) walk(el);
  return out;
}

/**
 * 这个视频属于哪条帖子（2026-11-10 实测 x.com/home）：信息流里每条帖子是一个 <article>；帖子自己的链接是包着发布时间
 * <time> 的那个 <a href="/用户/status/ID">。引用的帖子嵌在同一个 <article> 里（一个 role="link" 的块），它的时间不带链接，
 * 所以取到的总是外层这条——视频在被引用的帖子里时，记的也是你在信息流里看到的这一条。广告没有带时间的链接，认不出来。
 * 只读这一条帖子的链接、作者名和正文，别的帖子不读；只用来显示、起文件名、记下回到帖子的链接。
 */
function readXFeedPost(video: HTMLVideoElement): FeedPost | undefined {
  const article = video.closest('article');
  const link = article?.querySelector('a[href*="/status/"] time')?.closest('a');
  const page = link ? parseXStatusUrl(link.href) : undefined;
  if (!article || !page) return undefined;
  // 作者名：第一个 User-Name 里的第一个链接（后面是 @用户名 和时间；引用的帖子另有一个 User-Name，排在后面）
  const author = postText(article.querySelector('[data-testid="User-Name"] a'));
  // 正文：不在引用块里的那一段（外层帖子没有文字时，不拿被引用帖子的文字顶替）
  const body = [...article.querySelectorAll('[data-testid="tweetText"]')].find((t) => {
    const quote = t.closest('[role="link"]');
    return !quote || !article.contains(quote);
  });
  return feedPost(page, author, postText(body));
}

/**
 * Instagram 首页信息流里这个视频属于哪条帖子（2026-11-10 实测 www.instagram.com）：每条帖子是一个 <article>；帖子自己的链接是
 * 包着发布时间 <time> 的那个 <a href="/p/短码/">，广告没有 <time>，认不出来。作者取帖子里第一个指向个人主页的链接（/用户名/）里的用户名。
 * 正文在视频下面：一个 span[dir="auto"] 里套着的 span[dir="auto"]，同一个块里有这位作者的链接（所以别人的评论不算）；
 * 折叠起来的部分（"... 更多"）在另一个元素里，不去点它，只取露出来的这一段。
 * 只读这一条帖子的链接、作者用户名和正文，别的帖子不读；只用来显示、起文件名、记下回到帖子的链接。
 */
function readIgFeedPost(video: HTMLVideoElement): FeedPost | undefined {
  const article = video.closest('article');
  const link = article?.querySelector('a[href] time')?.closest('a');
  const page = link ? parseIgPostUrl(link.href) : undefined;
  if (!article || !page) return undefined;
  const profileOf = (box: Element) => [...box.querySelectorAll<HTMLAnchorElement>('a[href]')].map((a) => igProfileName(a.href)).filter(Boolean);
  const author = profileOf(article)[0] ?? '';
  const body = [...article.querySelectorAll('span[dir="auto"] span[dir="auto"]')].find((s) => {
    if (!(video.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    // 链接里的（话题、@提及）和按钮里的（"更多"）不是正文本身
    const wrapper = s.closest('a, [role="button"]');
    if (wrapper && article.contains(wrapper)) return false;
    const box = s.parentElement?.closest('span[dir="auto"]')?.parentElement;
    return !!author && !!box && article.contains(box) && profileOf(box).includes(author);
  });
  return feedPost(page, author, postText(body));
}

/** 首页信息流上现在该录的视频和它的帖子；没有"在播且有声音"的视频（也没有还算数的上一个）时返回 undefined */
function feedTarget(readPost: (video: HTMLVideoElement) => FeedPost | undefined): { video: HTMLVideoElement; post?: FeedPost } | undefined {
  const all = [...document.querySelectorAll('video')];
  const held = feedLock ? all.indexOf(feedLock.video) : -1;
  const video =
    all[
      pickFeedVideo(
        all.map((v, i) => {
          const playing = !v.paused && !v.ended;
          const muted = v.muted || v.volume === 0;
          // 量位置会让页面重新排版：只量用得着的（在播且有声音的、上次锁定的），信息流上平时一个都不用量
          return { playing, muted, visibleArea: (playing && !muted) || i === held ? visibleArea(v.getBoundingClientRect(), innerWidth, innerHeight) : 0 };
        }),
        held,
      )
    ];
  if (!video) {
    feedLock = undefined;
    return undefined;
  }
  if (feedLock?.video !== video) feedLock = { video };
  // 帖子只在锁定时读一次；没读出来（例如帖子还没渲染完）下一轮再读
  if (!feedLock.post) {
    const post = readPost(video);
    if (post) feedLock.post = post;
  }
  return feedLock;
}

/** 首页信息流上：锁定的视频和它所在的帖子 */
function feedNow(readPost: (video: HTMLVideoElement) => FeedPost | undefined): FeedSiteNow {
  const t = feedTarget(readPost);
  return { feed: true, video: t?.video ?? null, videoId: t?.post?.id ?? null, ...(t?.post ? { url: t.post.url, post: t.post } : {}), ...(t?.post?.title ? { title: t.post.title } : {}) };
}

/**
 * X、Instagram 页面上现在该录什么。X：帖子页看网址和页面标题，首页信息流看锁定的视频所在的帖子，别的页面不找；
 * Instagram：只有首页信息流，别的页面不找。别的站返回 undefined。
 */
function feedSiteNow(): FeedSiteNow | undefined {
  if (SITE === 'x') {
    const page = parseXStatusUrl(location.href);
    if (!page && isXHomeUrl(location.href)) return feedNow(readXFeedPost);
    feedLock = undefined;
    return { feed: false, video: page ? xStatusVideoEl() : null, videoId: page?.id ?? null };
  }
  if (SITE === 'ig') {
    if (isIgHomeUrl(location.href)) return feedNow(readIgFeedPost);
    feedLock = undefined;
    return { feed: false, video: null, videoId: null };
  }
  return undefined;
}

/**
 * X、Instagram 录制中：录的这个视频还在页面上、页面还是这条帖子（在信息流里开录的：还在首页）时，是它的帖子 ID；
 * 否则 null，这一段结束
 */
function feedRecordingId(r: Recording): string | null {
  if (!r.video.isConnected) return null;
  if (SITE === 'ig') return isIgHomeUrl(location.href) ? r.videoId : null;
  const page = parseXStatusUrl(location.href);
  if (page) return page.id;
  return r.feed && isXHomeUrl(location.href) ? r.videoId : null;
}

/**
 * 抖音精选页、搜索结果页里打开的这条视频在页面上的那一块（精选页 2026-11-10 实测，搜索页 2026-11-11 实测，结构相同）：网址带 ?modal_id=<视频ID>；页面上"当前这一条"是
 * [data-e2e="feed-active-video"]，它的 data-e2e-vid 就是这个 ID，里面的 <video> 是正在放的那个。
 * 旁边预先加载着上一条、下一条的 <video>（划走以后也还留在页面上），页面角落另有一个空的，都不在"当前这一条"里。
 * 划到下一条的一瞬间网址和页面可能对不上：对不上时当作还没准备好。不是这种网址时不找。
 */
function douyinItem(): Element | null {
  const page = parseDouyinUrl(location.href);
  const item = page ? document.querySelector('[data-e2e="feed-active-video"]') : null;
  const vid = item?.getAttribute('data-e2e-vid');
  return item && (!vid || vid === page!.id) ? item : null;
}

/**
 * 抖音这条视频的标题：作者昵称（去掉开头的 @）和描述拼成"作者 - 描述"。页面标题不能用：划到下一条时它不更新（2026-11-10 实测）。
 * 只读当前这一条的昵称和描述，别的视频不读；只用来显示和起文件名。
 */
function douyinTitle(): string | undefined {
  const post = douyinPost();
  return post ? feedPostTitle(post.author, post.text) || undefined : undefined;
}

/** 抖音当前这一条视频上的作者昵称（去掉开头的 @）和描述；没有点开的视频时 undefined */
function douyinPost(): { author: string; text: string } | undefined {
  const item = douyinItem();
  if (!item) return undefined;
  return { author: postText(item.querySelector('[data-e2e="feed-video-nickname"]')).trim().replace(/^@/, ''), text: postText(item.querySelector('[data-e2e="video-desc"]')) };
}

/**
 * 酷播播放页上播放器的视频（2026-11-10 实测：<vg-player> 的直接子元素，换片、换集都用同一个）。
 * 页面上另有两个不相干的 <video>：投屏按钮里一个空的、页面角落一个 1×1 的，都不是 <vg-player> 的直接子元素。
 * 不是播放页时不找。
 */
function kubbVideoEl(): HTMLVideoElement | null {
  return parseKubbPlayUrl(location.href) ? document.querySelector<HTMLVideoElement>('vg-player > video') : null;
}

function videoEl(): HTMLVideoElement | null {
  if (SITE === 'youtube') return playerEl()?.querySelector('video') ?? null;
  const now = feedSiteNow();
  if (now) return now.video;
  if (SITE === 'kubb') return kubbVideoEl();
  if (SITE === 'douyin') return douyinItem()?.querySelector('video') ?? null;
  let all = document.querySelectorAll<HTMLVideoElement>(XHS_PLAYER_VIDEO);
  if (!all.length) all = document.querySelectorAll<HTMLVideoElement>(XHS_ANY_VIDEO);
  if (all.length <= 1) return all[0] ?? null;
  // 不止一个：取画面最大的那个（藏起来的面积是 0）
  let best = all[0]!;
  let bestArea = -1;
  for (const v of all) {
    const r = v.getBoundingClientRect();
    if (r.width * r.height > bestArea) {
      bestArea = r.width * r.height;
      best = v;
    }
  }
  return best;
}

function adShowing(): boolean {
  if (SITE === 'kubb') {
    // 广告和正片用同一个 <video> 放，看它现在放的是什么（判断见 isKubbAd）
    const v = rec?.video ?? kubbVideoEl();
    return !!v && isKubbAd(v.currentSrc, v.duration);
  }
  const p = playerEl();
  return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
}

/**
 * YouTube 的视频 ID；小红书的笔记 ID（网址是笔记详情时）；X 的帖子 ID（网址是帖子页时；首页信息流上是锁定的视频所在的帖子）；
 * 酷播的影片 ID（网址是播放页时，剧集带分集 ID）；Instagram 的帖子短码（首页信息流上锁定的视频所在的帖子）；
 * 抖音的视频 ID（网址里的 modal_id）
 */
function currentIds(): { videoId: string | null; shorts: boolean } {
  if (SITE === 'youtube') return videoIdFromUrl(location.href);
  const now = feedSiteNow();
  if (now) return { videoId: now.videoId, shorts: false };
  if (SITE === 'kubb') return { videoId: parseKubbPlayUrl(location.href)?.id ?? null, shorts: false };
  if (SITE === 'douyin') return { videoId: parseDouyinUrl(location.href)?.id ?? null, shorts: false };
  const link = parseXhsUrl(location.href);
  return { videoId: link?.kind === 'note' ? link.noteId : null, shorts: false };
}

function pageTitle(): string | undefined {
  // 首页信息流（X、Instagram）：页面标题只是"主页 / X""Instagram"，标题来自锁定的视频所在的帖子
  const now = feedSiteNow();
  if (now?.feed) return now.title;
  if (SITE === 'douyin') return douyinTitle();
  const t = titleFromDocumentTitle(document.title || '', SITE);
  return t && !/^(?:YouTube|小红书|rednote|酷播)$/i.test(t) ? t : undefined;
}

/** 回到原处的链接：首页信息流（X、Instagram）上是这条帖子的链接（网址只是首页），别处就是网址 */
function sourceUrl(): string {
  return feedSiteNow()?.url ?? location.href;
}

/** 现在是不是在 X 或 Instagram 的首页信息流上（不能录时的说法不同，见 clipUnavailable） */
function onFeed(): boolean {
  return (SITE === 'x' && isXHomeUrl(location.href)) || (SITE === 'ig' && isIgHomeUrl(location.href));
}

/** 受版权保护的视频：录制和截图都不做，不绕过 */
function drmProtected(v: HTMLVideoElement): boolean {
  return !!(v as HTMLVideoElement & { mediaKeys?: unknown }).mediaKeys;
}

/**
 * 画面读得到吗：来自别的网站、又没有放行的视频，画到画布上会被浏览器标为"不可读"，录不了。
 * YouTube、小红书、X、酷播的视频现在都是同源的 blob: 流；X 的动图（GIF）例外，直接从 video.twimg.com 加载。
 */
function framesReadable(v: HTMLVideoElement): boolean {
  try {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const g = c.getContext('2d');
    g?.drawImage(v, 0, 0, 1, 1);
    g?.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

const UNREADABLE = '浏览器不允许读取这个视频的画面：视频来自别的网站，没有放行';
const X_GIF_NOTE = 'X 的动图（GIF）是这样，普通视频不受影响';

function fail(message: string, hint?: string): void {
  lastError = { message, ...(hint ? { hint } : {}) };
}

// ── 画面 ──

/** 播放器里当时显示的字幕：YouTube 原生字幕在上，其次 TubeMuse 多语字幕，TubeMuse 自动字幕（原文、译文）在下 */
function readBurnLines(): BurnLine[] {
  const player = playerEl();
  if (!player) return [];
  const out: BurnLine[] = [];
  for (const win of player.querySelectorAll<HTMLElement>('.caption-window')) {
    if (win.offsetParent === null) continue;
    const lines = [...win.querySelectorAll('.caption-visual-line')].map((l) => l.textContent?.trim() ?? '').filter(Boolean);
    if (!lines.length) {
      const t = win.textContent?.trim();
      if (t) lines.push(t);
    }
    for (const text of lines) out.push({ text, tone: 'source' });
  }
  // 多语字幕（同一扩展，shadow root 是 open）：一种语言一行，颜色与播放器里一致；它叠在自动字幕层上面
  const cc = player.querySelector('[data-tubemuse="multicc"]')?.shadowRoot?.querySelector<HTMLElement>('.wrap');
  if (cc && !cc.hidden) {
    for (const l of cc.querySelectorAll<HTMLElement>('.line')) {
      const text = l.hidden ? '' : (l.querySelector('.tx')?.textContent?.trim() ?? '');
      const i = Number(/\bl(\d)\b/.exec(l.className)?.[1] ?? 0);
      if (text) out.push({ text, tone: i ? 'translation' : 'source', color: MULTICC_LINE_COLORS[i] ?? MULTICC_LINE_COLORS[0] });
    }
  }
  const root = player.querySelector('[data-tubemuse="subtitles"]')?.shadowRoot;
  const wrap = root?.querySelector<HTMLElement>('.wrap');
  if (wrap && !wrap.hidden) {
    const src = root!.querySelector('.src')?.textContent?.trim();
    const tr = root!.querySelector('.tr')?.textContent?.trim();
    if (src) out.push({ text: src, tone: 'source' });
    if (tr) out.push({ text: tr, tone: 'translation' });
  }
  return out;
}

function measureWith(g: CanvasRenderingContext2D) {
  return (text: string, fontPx: number) => {
    g.font = `500 ${fontPx}px ${FONT}`;
    return g.measureText(text).width;
  };
}

function updateBurn(r: Recording): void {
  if (!r.burn) return;
  const lines = readBurnLines();
  const key = JSON.stringify(lines);
  if (key === r.burnKey) return;
  r.burnKey = key;
  r.burnLines = lines;
  r.burnBoxes = layoutBurnIn(lines, { width: r.width, height: r.height, fontScale, measure: measureWith(r.g) });
}

function drawCaptions(r: Recording): void {
  const g = r.g;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const b of r.burnBoxes) {
    g.fillStyle = 'rgba(8, 8, 8, 0.72)';
    g.beginPath();
    g.roundRect(b.x, b.y, b.w, b.h, b.fontPx * 0.2);
    g.fill();
    g.font = `500 ${b.fontPx}px ${FONT}`;
    g.fillStyle = b.color ?? (b.tone === 'translation' ? '#ffe7a3' : '#ffffff');
    g.fillText(b.text, b.cx, b.cy);
  }
}

function drawFrame(r: Recording): void {
  const v = r.video;
  const g = r.g;
  // 广告期间录制是暂停的，也不画广告画面：画布停在广告前的最后一帧
  if (adShowing()) return;
  if (v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0) {
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * scale;
    const h = v.videoHeight * scale;
    if (w < r.width - 0.5 || h < r.height - 0.5) {
      g.fillStyle = '#000';
      g.fillRect(0, 0, r.width, r.height);
    }
    g.drawImage(v, (r.width - w) / 2, (r.height - h) / 2, w, h);
  } else {
    g.fillStyle = '#000';
    g.fillRect(0, 0, r.width, r.height);
  }
  if (r.burn) drawCaptions(r);
  r.lastDrawAt = performance.now();
}

/** 跟着视频的每一帧画；浏览器不回调时（例如窗口被遮住但仍算可见）由定时器补画 */
function startFrames(r: Recording): void {
  const interval = 1000 / CLIPS.fps;
  const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
    if (rec !== r || r.stopping) return;
    // 画布按 30fps 输出：60fps 的视频隔一帧画一次就够；留出余量，30fps 的视频每帧都画
    if (performance.now() - r.lastDrawAt >= interval * 0.75) drawFrame(r);
    // 时间段：按帧判断终点，比每 100 毫秒一次的检查更准
    if (r.mode === 'range' && r.end !== undefined && r.recordedSec > 0 && meta.mediaTime >= r.end && !adShowing()) return stopRecording('range-end');
    r.frameHandle = r.video.requestVideoFrameCallback(onFrame);
  };
  r.frameHandle = r.video.requestVideoFrameCallback(onFrame);
  r.fallbackTimer = setInterval(() => {
    if (rec === r && !r.stopping && performance.now() - r.lastDrawAt > interval * 2.5) drawFrame(r);
  }, interval);
}

// ── 声音 ──

/** 把这个视频当前的音轨接进录音；YouTube 换片源（例如广告前后）时音轨会换新的，再接一次 */
function connectAudio(r: Recording): void {
  for (const track of r.source.getAudioTracks()) {
    if (r.audioNodes.has(track.id) || track.readyState === 'ended') continue;
    const node = r.ac.createMediaStreamSource(new MediaStream([track]));
    node.connect(r.dest);
    r.audioNodes.set(track.id, node);
  }
  for (const [id, node] of r.audioNodes) {
    if (r.source.getAudioTracks().some((t) => t.id === id && t.readyState !== 'ended')) continue;
    node.disconnect();
    r.audioNodes.delete(id);
  }
  // 画面另外从画布取：这个流里的画面轨用不到，停掉不占资源
  for (const t of r.source.getVideoTracks()) t.stop();
}

// ── 开始 / 结束 ──

function randomId(): string {
  const a = crypto.getRandomValues(new Uint32Array(2));
  return `clip_${Date.now().toString(36)}${a[0]!.toString(36)}${a[1]!.toString(36)}`.slice(0, 32);
}

async function startRecording(req: ClipStartRequest): Promise<void> {
  lastError = undefined;
  const video = videoEl();
  const { videoId, shorts } = currentIds();
  const maxSec = Math.round(Math.max(1, settings.maxMinutes) * 60);
  const problem = checkClipStart(req, {
    site: SITE,
    feed: onFeed(),
    enabled: settings.enabled,
    videoId,
    shorts,
    hasVideo: !!video,
    busy: !!rec,
    duration: video?.duration ?? 0,
    currentTime: video?.currentTime ?? 0,
    // 停在最后一帧也算播完（小红书的播放器不报"播完"）；循环播放的不算：X 的动图只有一两秒，一多半时间都离结尾很近；
    // Instagram 的视频放到结尾自己跳回开头接着放（没有 loop 属性），也不算
    ended: !!video && !video.loop && SITE !== 'ig' && (video.ended || atVideoEnd(video.currentTime, video.duration)),
    maxSec,
  });
  if (problem || !video || !videoId) return fail(problem ?? '没找到播放器里的视频');
  // 跳到起点会改动广告的播放进度：等广告结束再截取
  if (req.mode === 'range' && adShowing()) return fail('正在播广告：广告结束后再开始截取');
  if (drmProtected(video)) {
    return fail('这个视频受版权保护（DRM），浏览器不允许录制', '付费电影、部分音乐视频等受保护的内容录不了；TubeMuse 不会绕过这项保护');
  }
  if (!framesReadable(video)) {
    return fail(UNREADABLE, `${SITE === 'x' ? `${X_GIF_NOTE}。` : ''}这种视频录不了；TubeMuse 不会绕过这项限制`);
  }
  const format = pickClipFormat((m) => MediaRecorder.isTypeSupported(m));
  if (!format) return fail('这个浏览器不支持录制视频（MediaRecorder 不支持 MP4 或 WebM）', '请用最新版 Google Chrome');

  let source: MediaStream;
  try {
    source = (video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
  } catch {
    return fail('浏览器不允许录制这个视频（可能受版权保护）');
  }
  let ac: AudioContext;
  try {
    // 采样率固定 48 kHz，不跟着输出设备走：蓝牙耳机通话模式的 16 kHz，AAC 编码器不接受（见 CLIPS.audioSampleRate）
    ac = new AudioContext({ sampleRate: CLIPS.audioSampleRate });
  } catch (e) {
    source.getTracks().forEach((t) => t.stop());
    return fail(`浏览器没能准备录音：${e instanceof Error ? e.message : String(e)}`);
  }
  // 页面还没被点过时 resume() 不报错也不返回：等一小会儿就往下走，由下面的判断告诉你怎么办
  if (ac.state === 'suspended') await Promise.race([ac.resume().catch(() => undefined), new Promise((done) => setTimeout(done, CLIPS.audioResumeMs))]);
  if (ac.state === 'suspended') {
    source.getTracks().forEach((t) => t.stop());
    void ac.close();
    return fail('浏览器还没允许这个页面处理声音', '在视频画面上点一下（暂停再播放也行），再开始录制');
  }
  const size = outputSize(video.videoWidth, video.videoHeight);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const g = canvas.getContext('2d', { alpha: false });
  if (!g) {
    source.getTracks().forEach((t) => t.stop());
    void ac.close();
    return fail('浏览器没能创建画布，无法录制');
  }
  const dest = ac.createMediaStreamDestination();
  const canvasTrack = canvas.captureStream(CLIPS.fps).getVideoTracks()[0];
  const audioTrack = dest.stream.getAudioTracks()[0];
  if (!canvasTrack || !audioTrack) {
    source.getTracks().forEach((t) => t.stop());
    void ac.close();
    return fail('浏览器没能准备录制用的画面或声音');
  }
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(new MediaStream([canvasTrack, audioTrack]), {
      mimeType: format.mimeType,
      videoBitsPerSecond: videoBitrate(size.height),
      audioBitsPerSecond: CLIPS.audioBitrate,
    });
  } catch (e) {
    canvasTrack.stop();
    source.getTracks().forEach((t) => t.stop());
    void ac.close();
    return fail(`浏览器没能开始录制：${e instanceof Error ? e.message : String(e)}`);
  }
  const title = pageTitle();
  const r: Recording = {
    id: randomId(),
    mode: req.mode,
    videoId,
    pageUrl: sourceUrl(),
    feed: onFeed(),
    ...(title ? { title } : {}),
    ...(req.mode === 'range' ? { start: req.start!, end: req.end! } : {}),
    video,
    canvas,
    g,
    width: size.width,
    height: size.height,
    // 小红书的视频没有单独的字幕层（字幕若有，是做在画面里的，会原样录下）；X、酷播播放器里的字幕不读
    burn: SITE === 'youtube' && settings.burnSubtitles,
    format,
    maxSec,
    source,
    ac,
    dest,
    audioNodes: new Map(),
    canvasTrack,
    recorder,
    started: false,
    headerChecked: false,
    chunks: [],
    bytes: 0,
    recordedSec: 0,
    lastTick: performance.now(),
    userPaused: false,
    seenTime: video.currentTime,
    seenAt: performance.now(),
    lastDrawAt: 0,
    burnLines: [],
    burnKey: '',
    burnBoxes: [],
  };
  connectAudio(r);
  source.addEventListener('addtrack', () => rec === r && connectAudio(r));
  source.addEventListener('removetrack', () => rec === r && connectAudio(r));
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    r.chunks.push(e.data);
    r.bytes += e.data.size;
    if (r.format.ext === 'mp4' && !r.headerChecked) void checkMp4Header(r);
  };
  recorder.onerror = (e) => {
    const err = (e as Event & { error?: DOMException }).error;
    r.errorText = err?.message || err?.name || '未知错误';
    if (!r.stopping) r.stopping = 'error';
  };
  recorder.onstop = () => finish(r);
  rec = r;
  updateBurn(r);
  drawFrame(r);
  startFrames(r);
  if (req.mode === 'range') {
    video.currentTime = req.start!;
    if (video.paused) void video.play().catch(() => undefined);
  }
  // 录音机先不开始，由下一轮判断该不该录（例如广告中、正在跳到起点），第一次该录时才 start()
  r.waiting = 'seeking';
  tick();
}

/**
 * 第一次真正要录时才开始录音机。不能先 start() 再暂停着等：Chrome 的 MP4 封装按时间戳排队，开头暂停多久，
 * 声音就排在画面后面多久；文件头随第一个分片（约 101 帧）写出，开头的暂停长过一个分片时，那时还没有声音，
 * 文件头里就没有声音轨——声音数据虽在文件里，播放器却读不到（2026-11-02 实测 Chrome 156，见 DECISIONS §39）。
 * 开始之后的暂停（广告、你按暂停）没有这个问题：文件头已经带着两条轨写出了。
 */
function startRecorder(r: Recording): void {
  r.started = true;
  try {
    r.recorder.start(CLIPS.timesliceMs);
  } catch (e) {
    r.errorText = e instanceof Error ? e.message : String(e);
    stopRecording('error');
  }
}

/** MP4 文件头一写出就查有没有声音轨：没有的话这一段注定没声音，立刻停下告诉你，不产出静默的无声文件 */
async function checkMp4Header(r: Recording): Promise<void> {
  r.headerChecked = true;
  let kinds: string[] | undefined;
  try {
    kinds = mp4TrackKinds(new Uint8Array(await new Blob(r.chunks).slice(0, CLIPS.headerScanBytes).arrayBuffer()));
  } catch {
    return;
  }
  // 文件头还没写全：下一块数据到了再查
  if (!kinds) {
    if (r.bytes < CLIPS.headerScanBytes) r.headerChecked = false;
    return;
  }
  if (kinds.includes('soun') || rec !== r || r.stopping) return;
  r.errorText = '浏览器写出的文件里没有声音轨，这一段录下来会没有声音';
  r.errorHint = '已停止，没有保存这一段；重新开始录制一次试试';
  r.discard = true;
  stopRecording('error');
}

function stopRecording(reason: ClipStopReason): void {
  const r = rec;
  if (!r || (r.stopping && reason !== 'error')) return;
  r.stopping ??= reason;
  if (r.recorder.state !== 'inactive') {
    try {
      r.recorder.stop();
    } catch {
      finish(r);
    }
  } else finish(r);
  broadcast();
}

function cleanup(r: Recording): void {
  if (r.frameHandle !== undefined) r.video.cancelVideoFrameCallback(r.frameHandle);
  if (r.fallbackTimer) clearInterval(r.fallbackTimer);
  r.canvasTrack.stop();
  for (const node of r.audioNodes.values()) node.disconnect();
  r.audioNodes.clear();
  r.source.getTracks().forEach((t) => t.stop());
  void r.ac.close().catch(() => undefined);
}

function releaseReady(): void {
  if (ready?.url) URL.revokeObjectURL(ready.url);
  ready = undefined;
}

function finish(r: Recording): void {
  if (rec !== r) return;
  cleanup(r);
  rec = undefined;
  const reason = r.stopping ?? 'user';
  if (reason === 'error') fail(`录制出错：${r.errorText ?? '未知错误'}`, r.errorHint ?? '已录到的部分（如果有）仍可保存');
  if (r.discard || !r.bytes || r.recordedSec < 0.3 || r.mediaFirst === undefined) {
    if (reason !== 'error') fail('这一段没有录到内容，没有生成文件', '例如一直在广告、暂停或缓冲中；视频播放时再录');
    broadcast();
    return;
  }
  releaseReady();
  const start = r.mode === 'range' ? r.start! : r.mediaFirst;
  const end = r.mode === 'free' ? (r.mediaLast ?? r.mediaFirst) : reason === 'range-end' ? r.end! : Math.min(r.end!, Math.max(r.mediaLast ?? r.end!, r.start!));
  ready = {
    id: r.id,
    blob: new Blob(r.chunks, { type: r.format.mimeType.split(';')[0] }),
    fileName: clipFileName(r.title, r.videoId, start, end, r.format.ext, SITE),
    bytes: r.bytes,
    durationSec: Math.round(r.recordedSec * 10) / 10,
    start,
    end,
    format: r.format.label,
    burned: r.burn,
    endedBy: reason,
    videoId: r.videoId,
    pageUrl: r.pageUrl,
    ...(r.title ? { title: r.title } : {}),
    mode: r.mode,
  };
  r.chunks = [];
  if (settings.autoSave) saveReady();
  broadcast();
}

/** 交给浏览器存进下载文件夹（不经过网络；文件地址只在这个页面里有效），再请后台记一笔 */
function saveReady(): void {
  const c = ready;
  if (!c) return;
  c.url ??= URL.createObjectURL(c.blob);
  const a = document.createElement('a');
  a.href = c.url;
  a.download = c.fileName;
  a.rel = 'noopener';
  a.click();
  c.savedAt = Date.now();
  const record: ClipRecord = {
    id: c.id,
    // 小红书、X、酷播：带上原处的链接，"最近录过的片段"里点标题能回去（后台核对链接与 ID）
    ...(SITE !== 'youtube' ? { site: SITE, url: c.pageUrl } : {}),
    videoId: c.videoId,
    ...(c.title ? { title: c.title } : {}),
    mode: c.mode,
    start: c.start,
    end: c.end,
    durationSec: c.durationSec,
    bytes: c.bytes,
    format: c.format,
    fileName: c.fileName,
    burned: c.burned,
    savedAt: c.savedAt,
  };
  try {
    void chrome.runtime.sendMessage({ type: CLIP_MSG.saved, record }).catch(() => undefined);
  } catch {
    // 扩展被重新加载：文件已经交给浏览器保存，只是这次没记上
  }
}

// ── Capture 截图 ──

function releaseShot(): void {
  if (shot) clearTimeout(shot.holdTimer);
  shot = undefined;
}

/** 截下当前这一帧：按视频的真实尺寸（不是播放器在页面上显示的尺寸）画到不放进页面的画布上，编成 PNG 等侧边栏取走 */
async function captureFrame(): Promise<ClipCaptureReply> {
  releaseShot();
  const video = videoEl();
  const { videoId, shorts } = currentIds();
  const problem = checkCapture({
    site: SITE,
    feed: onFeed(),
    enabled: settings.enabled,
    videoId,
    shorts,
    hasVideo: !!video,
    ad: adShowing(),
    drm: !!video && drmProtected(video),
    ready: !!video && video.readyState >= 2 && !video.seeking && video.videoWidth > 0 && video.videoHeight > 0,
  });
  if (problem || !video || !videoId) return { ok: false, message: problem ?? '没找到播放器里的视频' };
  if (!framesReadable(video)) return { ok: false, message: SITE === 'x' ? `${UNREADABLE}（${X_GIF_NOTE}）` : UNREADABLE };
  const width = video.videoWidth;
  const height = video.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d', { alpha: false });
  if (!g) return { ok: false, message: '浏览器没能创建画布，无法截图' };
  // 同一拍里读时间、取画面：文件名里的时间就是这一帧
  const time = video.currentTime;
  const title = pageTitle();
  g.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return { ok: false, message: `浏览器没能把 ${width}×${height} 的画面编成 PNG` };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const id = randomId();
  shot = { id, bytes, holdTimer: setTimeout(() => shot?.id === id && releaseShot(), CLIPS.captureHoldMs) };
  return { ok: true, id, videoId, ...(title ? { title } : {}), time, width, height, bytes: bytes.length, chunks: Math.ceil(bytes.length / CLIPS.captureChunkBytes) };
}

/** 取走截图的一块（base64）；对不上这一帧时返回 undefined。最后一块取走后立即释放 */
function shotChunk(id: unknown, index: unknown): string | undefined {
  if (!shot || shot.id !== id || typeof index !== 'number' || !Number.isInteger(index) || index < 0) return undefined;
  const size = CLIPS.captureChunkBytes;
  const part = bytesToBase64(shot.bytes.subarray(index * size, (index + 1) * size));
  if ((index + 1) * size >= shot.bytes.length) releaseShot();
  return part;
}

// ── 「问 muse」──

/**
 * 小红书笔记详情里这篇笔记的作者名和正文（2026-11-11 新增，见 DECISIONS §60）。
 * 作者栏有两份（视频笔记顶上那份是藏起来的，看得见的在右侧互动区，见 content/xhs.ts 的 detailAuthorRow），名字一样，取第一份有字的；
 * 评论区每条评论也有 .author-wrapper，但里面没有 .info，不会认错。正文是 #detail-desc（标题在它上面的 #detail-title，来自页面标题，不重复取）。
 * 只读这一篇笔记的这两处：评论和别的笔记不读。
 */
function xhsNote(): { author: string; text: string } {
  const box = document.querySelector('#noteContainer, .note-container');
  const names = [...(box?.querySelectorAll('.author-wrapper:has(> .info) a.name, .author-container .info a.name') ?? [])].map((a) => postText(a).replace(/\s+/g, ' ').trim());
  return { author: names.find(Boolean) ?? '', text: postText(box?.querySelector('#detail-desc')) };
}

/** 当前这一条的标题、作者、正文（或描述）。X、Instagram、抖音的帖子 / 视频没有单独的标题，不拿"作者 - 正文"顶替 */
function museTexts(now: FeedSiteNow | undefined): { title?: string; author?: string; body?: string } {
  if (SITE === 'xhs') {
    const note = xhsNote();
    return { title: pageTitle(), author: note.author, body: note.text };
  }
  if (SITE === 'douyin') {
    const post = douyinPost();
    return { author: post?.author, body: post?.text };
  }
  if (now?.feed) return { author: now.post?.author, body: now.post?.text };
  // X 帖子页：作者和正文都在页面标题里
  if (SITE === 'x') {
    const post = xPostParts(document.title || '');
    return { author: post?.author, body: post?.text };
  }
  return { title: pageTitle() };
}

/**
 * 你点「问 muse」的这一刻：当前这条视频 / 帖子是什么、播到哪了。只读一次，不暂停视频、不改页面。
 * 认的是和片段录制同一条（首页信息流上是正在播放、开着声音的那个视频所在的帖子），但不看"片段录制"的开关；
 * 没有视频的笔记、帖子也能问，播放位置不给。广告期间读到的是广告的进度，也不给；Shorts 的播放器不读。
 */
function museSnapshot(): MuseSnapshot {
  const now = feedSiteNow();
  const { videoId, shorts } = currentIds();
  const video = shorts ? null : videoEl();
  const unavailable = museUnavailable(SITE, { videoId, feed: onFeed(), hasVideo: !!video });
  if (unavailable || !videoId) return { site: SITE, unavailable: unavailable ?? '没认出当前这条视频' };
  const item = SITE === 'youtube' ? undefined : museItem(SITE, sourceUrl());
  if (SITE !== 'youtube' && item?.id !== videoId) return { site: SITE, unavailable: '没认出当前这条视频的链接：等页面加载完再点「问 muse」' };
  const ad = adShowing();
  const readable = !!video && !ad && Number.isFinite(video.currentTime);
  const { title, author, body } = museTexts(now);
  const text = body?.trim() ?? '';
  const total = [...text].length;
  return {
    site: SITE,
    videoId,
    ...(item ? { url: item.url } : {}),
    ...(shorts ? { shorts: true } : {}),
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(text ? { body: total > MUSE.bodyReadMaxChars ? [...text].slice(0, MUSE.bodyReadMaxChars).join('') : text } : {}),
    ...(total > MUSE.bodyReadMaxChars ? { bodyTotal: total } : {}),
    ...(readable ? { position: video.currentTime } : {}),
    ...(readable && Number.isFinite(video.duration) && video.duration > 0 ? { duration: video.duration } : {}),
    ...(readable ? {} : { gap: shorts ? ('shorts' as const) : !video ? ('no-video' as const) : ('ad' as const) }),
  };
}

// ── 每一轮 ──

function tick(): void {
  if (!alive()) return teardown();
  const r = rec;
  if (r && !r.stopping) {
    const now = performance.now();
    if (r.recorder.state === 'recording') r.recordedSec += (now - r.lastTick) / 1000;
    r.lastTick = now;
    const v = r.video;
    const { videoId } = currentIds();
    // Instagram：进度从结尾跳回了开头，算放完了一遍（要在记下这一轮的进度之前比）
    const looped = SITE === 'ig' && loopedToStart(r.seenTime, v.currentTime, v.duration);
    if (v.currentTime !== r.seenTime || v.paused || v.seeking) {
      r.seenTime = v.currentTime;
      r.seenAt = now;
    }
    const d = decideClip(
      { mode: r.mode, videoId: r.videoId, ...(r.mode === 'range' ? { start: r.start!, end: r.end! } : {}), recordedSec: r.recordedSec, bytes: r.bytes, maxSec: r.maxSec, maxBytes: CLIPS.maxBytes, userPaused: r.userPaused },
      {
        // 播放器里换了一个视频元素也算换了视频。X 一页有好几个视频，滚动时"最该录的"会变，只看录的这个还在不在页面上：
        // 滚开时 X 自己会暂停它，录制跟着暂停，滚回来接着录（信息流里滚远了，X 把这条帖子从页面上撤掉，这一段就结束）。Instagram 同理
        videoId: FEED_SITE ? feedRecordingId(r) : videoEl() === v ? videoId : null,
        currentTime: v.currentTime,
        paused: v.paused,
        ended: v.ended || looped,
        seeking: v.seeking,
        ready: v.readyState >= 2,
        ad: adShowing(),
        visible: document.visibilityState === 'visible',
        stalled: now - r.seenAt > CLIPS.stallMs,
        duration: v.duration,
      },
    );
    if (d.kind === 'stop') stopRecording(d.reason);
    else if (d.kind === 'record') {
      if (!r.started) startRecorder(r);
      else if (r.recorder.state === 'paused') r.recorder.resume();
      if (!r.stopping) {
        r.waiting = undefined;
        r.mediaFirst ??= v.currentTime;
        r.mediaLast = v.currentTime;
      }
    } else {
      if (r.recorder.state === 'recording') r.recorder.pause();
      r.waiting = d.why;
    }
    updateBurn(r);
  }
  broadcast();
}

// ── 状态 ──

function tabState(precise = false): ClipTabState {
  const now = currentIds();
  const r = rec;
  const { shorts } = now;
  // 录制中报告的是录的这个视频和它的帖子（X 上滚动时"最该录的"会变；信息流里它暂停着滚出屏幕时，已经不算"锁定的"了）
  const videoId = (r && FEED_SITE ? feedRecordingId(r) : null) ?? now.videoId;
  const video = r?.video ?? videoEl();
  const maxSec = Math.round(Math.max(1, settings.maxMinutes) * 60);
  // YouTube 播放页上视频元素几乎立刻就有，沿用原来的判断（不因"还没有视频"挡住）；小红书的图文笔记、X 的文字帖子没有视频
  const unavailable = clipUnavailable(SITE, { feed: onFeed(), enabled: settings.enabled, videoId, shorts, hasVideo: SITE === 'youtube' || !!video });
  const t = video?.currentTime ?? 0;
  let status: string;
  if (r?.stopping) status = '正在收尾…';
  else if (r) status = r.waiting ? CLIP_WAIT_LABELS[r.waiting] : r.mode === 'range' ? `正在截取 ${formatTimecode(r.start!)} – ${formatTimecode(r.end!)}` : '正在录制';
  else if (unavailable) status = unavailable;
  else if (ready) status = ready.savedAt ? `已保存：${ready.fileName}` : `录好了（${CLIP_STOP_LABELS[ready.endedBy]}），还没保存`;
  else status = '可以开始录制';
  const title = r?.title ?? (videoId ? pageTitle() : undefined);
  const { blob: _b, url: _u, videoId: _v, pageUrl: _p, title: _t, mode: _m, ...readyInfo } = ready ?? ({} as ReadyClip);
  return {
    site: SITE,
    videoId,
    ...(title ? { title } : {}),
    ...(unavailable ? { unavailable } : {}),
    position: precise ? Math.round(t * 10) / 10 : Math.floor(t),
    duration: video && Number.isFinite(video.duration) ? Math.floor(video.duration) : 0,
    phase: r ? (r.stopping ? 'finishing' : 'recording') : 'idle',
    ...(r ? { mode: r.mode } : {}),
    ...(r?.mode === 'range' ? { range: { start: r.start!, end: r.end! } } : {}),
    recordedSec: r ? Math.floor(r.recordedSec) : 0,
    // 大小按 0.1 MB 取整：录制中每秒左右才推送一次
    bytes: r ? Math.floor(r.bytes / 100_000) * 100_000 : 0,
    ...(r?.waiting ? { waiting: r.waiting } : {}),
    status,
    burn: r ? r.burn : SITE === 'youtube' && settings.burnSubtitles,
    autoSave: settings.autoSave,
    maxSec,
    ...(r ? { format: r.format.label } : {}),
    ...(ready ? { ready: readyInfo as ReadyClipInfo } : {}),
    ...(lastError ? { error: lastError } : {}),
  };
}

/** 状态有变化时推送；播放位置不算变化（侧边栏打开时自己每秒问一次），免得边看边每秒发消息 */
function broadcast(): void {
  const s = tabState();
  const key = JSON.stringify({ ...s, position: 0 });
  if (key === lastState) return;
  lastState = key;
  try {
    void chrome.runtime.sendMessage({ type: CLIP_MSG.state, state: s }).catch(() => undefined);
  } catch {
    teardown();
  }
}

function teardown(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  releaseShot();
  if (rec) {
    try {
      cleanup(rec);
    } catch {
      // 忽略
    }
    rec = undefined;
  }
}

function applySettings(raw: unknown): void {
  const s = raw as { clips?: Partial<ClipSettings>; subtitles?: { fontScale?: number } } | undefined;
  settings = { ...DEFAULT_SETTINGS.clips, ...(s?.clips ?? {}) };
  fontScale = typeof s?.subtitles?.fontScale === 'number' ? s.subtitles.fontScale : DEFAULT_SETTINGS.subtitles.fontScale;
  // 设置里关掉了录制：正在录的这一段照常结束、可以保存
  if (!settings.enabled && rec) stopRecording('user');
}

void chrome.storage.local
  .get('settings')
  .then((r) => applySettings(r.settings))
  .catch(() => undefined);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) applySettings(changes.settings.newValue);
});

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const msg = raw as { type?: string; mode?: unknown; start?: unknown; end?: unknown; precise?: unknown; id?: unknown; index?: unknown } | undefined;
  const reply = () => sendResponse(tabState(msg?.precise === true));
  switch (msg?.type) {
    case CLIP_MSG.getState:
      reply();
      return false;
    case CLIP_MSG.start: {
      const mode: ClipMode = msg.mode === 'range' ? 'range' : 'free';
      const start = num(msg.start);
      const end = num(msg.end);
      void startRecording({ mode, ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) }).then(reply, (e: unknown) => {
        fail(`没能开始录制：${e instanceof Error ? e.message : String(e)}`);
        reply();
      });
      return true;
    }
    case CLIP_MSG.toggle:
      if (rec) stopRecording('user');
      else void startRecording({ mode: 'free' }).finally(broadcast);
      return false;
    case CLIP_MSG.pause:
      if (rec) rec.userPaused = true;
      tick();
      reply();
      return false;
    case CLIP_MSG.resume:
      if (rec) rec.userPaused = false;
      tick();
      reply();
      return false;
    case CLIP_MSG.stop:
      stopRecording('user');
      reply();
      return false;
    case CLIP_MSG.save:
      lastError = undefined;
      saveReady();
      broadcast();
      reply();
      return false;
    case CLIP_MSG.discard:
      lastError = undefined;
      releaseReady();
      broadcast();
      reply();
      return false;
    case CLIP_MSG.capture:
      void captureFrame().then(sendResponse, (e: unknown) => sendResponse({ ok: false, message: `没能截图：${e instanceof Error ? e.message : String(e)}` } satisfies ClipCaptureReply));
      return true;
    case CLIP_MSG.captureChunk:
      sendResponse(shotChunk(msg.id, msg.index));
      return false;
    case MUSE_MSG.snapshot:
      sendResponse(museSnapshot());
      return false;
    default:
      return false;
  }
});

timer = setInterval(tick, CLIPS.tickMs);
tick();
