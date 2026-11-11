// 视频片段录制的纯逻辑：时间码、文件名、编码格式与尺寸、录 / 等 / 停的判定、开录前检查、字幕烧录排版、录制记录，
// 以及 Capture 截图的文件名、截图前检查和跨进程传输时的编解码。
// 录制本身（画布、MediaRecorder、保存）在 content/clipper.ts；侧边栏"片段"页只经消息控制它。

import { CLIPS } from '../config/defaults';
import { DOUYIN_PAGES, IG_PAGES, KUBB_PAGES, XHS_PAGES, X_PAGES } from '../config/endpoints';
import { canonicalXhsUrl, isXhsId } from './xhs';

export type ClipMode = 'free' | 'range';

/**
 * 录的是哪个站的视频：YouTube 播放页、小红书网页版的视频笔记（2026-11-04 新增，见 DECISIONS §43）、
 * X 网页版的帖子（2026-11-06 新增，见 DECISIONS §52）、酷播（kubb.tv）的播放页（2026-11-10 新增，见 DECISIONS §54）、
 * Instagram 网页版的首页信息流（2026-11-10 新增，见 DECISIONS §56）、抖音网页版精选页里打开的视频（2026-11-10 新增，见 DECISIONS §57）
 */
export type ClipSite = 'youtube' | 'xhs' | 'x' | 'kubb' | 'ig' | 'douyin';

/** 侧边栏 → 内容脚本、内容脚本 → 侧边栏 / 后台 的消息类型 */
export const CLIP_MSG = {
  getState: 'tubemuse:clips:get-state',
  start: 'tubemuse:clips:start',
  pause: 'tubemuse:clips:pause',
  resume: 'tubemuse:clips:resume',
  stop: 'tubemuse:clips:stop',
  save: 'tubemuse:clips:save',
  discard: 'tubemuse:clips:discard',
  /** 快捷键：没在录就开始自由录制，在录就停止 */
  toggle: 'tubemuse:clips:toggle',
  /** 内容脚本主动推送的状态变化 */
  state: 'tubemuse:clips:state',
  /** 内容脚本 → 后台：存好了一个片段，记一笔 */
  saved: 'tubemuse:clips:saved',
  /** 侧边栏 → 内容脚本：截下当前这一帧，回复 ClipCaptureReply */
  capture: 'tubemuse:clips:capture',
  /** 侧边栏 → 内容脚本：取截好的 PNG 的第 index 块（base64） */
  captureChunk: 'tubemuse:clips:capture-chunk',
} as const;

// ── 时间码 ──

/** 解析你输入的时间："1:02:03"、"12:03"、"75"、"12:03.5"、"1h2m3s"、"2m"；全角冒号也行。认不出返回 null */
export function parseTimecode(input: string): number | null {
  const s = input.trim().replace(/：/g, ':').toLowerCase();
  if (!s) return null;
  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(s);
  if (units && (units[1] || units[2] || units[3])) return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  const parts = s.split(':');
  if (parts.length > 3 || parts.some((p) => p === '')) return null;
  const last = parts.pop()!;
  if (!/^\d+(?:\.\d+)?$/.test(last) || parts.some((p) => !/^\d+$/.test(p))) return null;
  const sec = Number(last);
  const nums = parts.map(Number);
  // 有更高一级时，分、秒不能超过 59
  if (nums.length && sec >= 60) return null;
  if (nums.length === 2 && nums[1]! >= 60) return null;
  return nums.reduce((acc, n) => acc * 60 + n, 0) * 60 ** (nums.length ? 1 : 0) + sec;
}

/** 显示用时间码："m:ss" 或 "h:mm:ss"；有小数时保留一位（"0:12.3"） */
export function formatTimecode(sec: number): string {
  const t = Math.max(0, Math.round(sec * 10) / 10);
  const whole = Math.floor(t);
  const tenth = Math.round((t - whole) * 10);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = `${String(whole % 60).padStart(2, '0')}${tenth ? `.${tenth}` : ''}`;
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** 文件名里的时间（不能用冒号）："12m03s"、"1h02m03s" */
function fileStamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}h${String(m).padStart(2, '0')}m${ss}s` : `${String(m).padStart(2, '0')}m${ss}s`;
}

/** 大小显示：12.3 MB */
export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// ── 文件名 ──

/** 帖子正文里的 t.co 短链：X 把媒体也写成一条短链，留在标题里只是噪音 */
const TCO_LINK = /\s*https?:\/\/t\.co\/\S+/g;

/**
 * X 帖子页的标题："X 上的 作者：“正文 https://t.co/…” / X"（英文界面：作者 on X: "正文" / X）→"作者 - 正文"，
 * 帖子只有视频、没有文字时只留作者。还在加载或不是帖子时（"帖子 / X"、"X"）返回空。
 */
function xPostTitle(title: string): string {
  const body = title.replace(/\s*\/\s*X\s*$/, '').trim();
  if (/^(?:X|Post|帖子)$/.test(body)) return '';
  const post = /^(?:X 上的\s*(.+?)|(.+?) on X)\s*[：:]\s*[“"]([\s\S]*)[”"]$/.exec(body);
  if (!post) return body.replace(TCO_LINK, '').trim();
  const author = (post[1] ?? post[2])!.trim();
  const text = post[3]!.replace(TCO_LINK, '').trim();
  return text ? `${author} - ${text}` : author;
}

/**
 * 首页信息流（X、Instagram）里的帖子没有自己的页面标题：用帖子上的作者名和正文拼成"作者 - 正文"，和 X 帖子页的写法一样
 * （去掉 t.co 短链，换行压成空格）；只有视频没有文字时只留作者，两样都没有返回空。
 */
export function feedPostTitle(author: string, text: string): string {
  const clean = (s: string) => s.replace(TCO_LINK, '').replace(/\s+/g, ' ').trim();
  const [a, t] = [clean(author), clean(text)];
  return a && t ? `${a} - ${t}` : a || t;
}

/**
 * 酷播播放页的标题："片名-免费在线观看-酷播"，剧集是"剧名-集数-免费在线观看-酷播"（2026-11-10 实测）→"片名"或"剧名-集数"。
 * 首页等别的页面（"酷播-海量高清视频免费在线观看"）返回空；认不出的写法原样用。
 */
function kubbTitle(title: string): string {
  const play = /^(.*?)\s*-\s*免费在线观看\s*-\s*酷播\s*$/.exec(title);
  if (play) return play[1]!.trim();
  return /^酷播\s*(?:-|$)/.test(title.trim()) ? '' : title.trim();
}

/**
 * 页面标题 → 视频标题：去掉开头的通知数"(12) "与结尾的" - YouTube"（小红书：" - 小红书" / " - rednote"；X 见 xPostTitle；酷播见 kubbTitle）。
 * Instagram 首页的页面标题只是"Instagram"，说明不了是哪条帖子：不用（标题来自帖子本身，见 feedPostTitle）。
 * 抖音的页面标题在划到下一条视频时不更新（2026-11-10 实测），会张冠李戴：也不用，标题来自当前这条视频上的作者和描述。
 */
export function titleFromDocumentTitle(docTitle: string, site: ClipSite = 'youtube'): string {
  const title = docTitle.replace(/^\(\d+\+?\)\s*/, '');
  if (site === 'ig' || site === 'douyin') return '';
  if (site === 'x') return xPostTitle(title);
  if (site === 'kubb') return kubbTitle(title);
  return title.replace(site === 'xhs' ? /\s*[-–—]\s*(?:小红书|rednote)\s*$/i : /\s*[-–—]\s*YouTube\s*$/i, '').trim();
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** 能放进文件名的标题：去掉 Windows / macOS 不允许的字符，压缩空白，最多 80 个字 */
export function safeFileTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = [...cleaned].slice(0, 80).join('').replace(/[\s.]+$/, '').replace(/^[\s.]+/, '');
  return WINDOWS_RESERVED.test(cut) ? `_${cut}` : cut;
}

/** 文件名开头：清洗过的标题；没有标题时用视频（笔记、帖子）ID */
function fileBase(title: string | undefined, videoId: string, site: ClipSite): string {
  return safeFileTitle(title ?? '') || `${site}-${videoId}`;
}

/** 片段文件名：标题_起点-终点.扩展名；没有标题时用视频（笔记、帖子）ID */
export function clipFileName(title: string | undefined, videoId: string, start: number, end: number, ext: string, site: ClipSite = 'youtube'): string {
  return `${fileBase(title, videoId, site)}_${fileStamp(start)}-${fileStamp(end)}.${ext}`;
}

/** 文件名里的播放位置，精确到毫秒："00-00-30-804"（时-分-秒-毫秒） */
export function frameTimestamp(sec: number): string {
  const ms = Number.isFinite(sec) ? Math.max(0, Math.round(sec * 1000)) : 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  const totalSec = Math.floor(ms / 1000);
  return `${pad(Math.floor(totalSec / 3600))}-${pad(Math.floor((totalSec % 3600) / 60))}-${pad(totalSec % 60)}-${String(ms % 1000).padStart(3, '0')}`;
}

/** Capture 截图文件名：标题_时-分-秒-毫秒_original_序号.png（序号 5 位补零，全局递增）；没有标题时用视频（帖子）ID */
export function captureFileName(title: string | undefined, videoId: string, time: number, seq: number, site: ClipSite = 'youtube'): string {
  return `${fileBase(title, videoId, site)}_${frameTimestamp(time)}_original_${String(seq).padStart(5, '0')}.png`;
}

// ── 编码格式与尺寸 ──

export type ClipFormat = (typeof CLIPS.formats)[number];

/** 按优先级选第一个浏览器支持的格式；一个都不支持返回 undefined */
export function pickClipFormat(isSupported: (mimeType: string) => boolean): ClipFormat | undefined {
  return CLIPS.formats.find((f) => {
    try {
      return isSupported(f.mimeType);
    } catch {
      return false;
    }
  });
}

/** 输出画面尺寸：按视频原尺寸，短边高于上限时等比缩小（横屏的短边就是高度）；宽高取偶数（H.264 要求）。读不到尺寸时用默认尺寸 */
export function outputSize(videoWidth: number, videoHeight: number, maxShortSide: number = CLIPS.maxShortSide, fallback: { width: number; height: number } = CLIPS.fallbackSize): { width: number; height: number } {
  if (!(videoWidth > 0) || !(videoHeight > 0)) return { ...fallback };
  const scale = Math.min(1, maxShortSide / Math.min(videoWidth, videoHeight));
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(videoWidth * scale), height: even(videoHeight * scale) };
}

export function videoBitrate(height: number): number {
  return (CLIPS.videoBitrates.find((b) => height >= b.minHeight) ?? CLIPS.videoBitrates[CLIPS.videoBitrates.length - 1]!).bps;
}

// ── MP4 文件头 ──

interface Mp4Box {
  type: string;
  body: number;
  /** 盒子在声明里的结尾；可能超出手里这段字节（还没写完） */
  end: number;
}

function readMp4Boxes(b: Uint8Array, start: number, end: number): Mp4Box[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Mp4Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    const size32 = v.getUint32(p);
    const header = size32 === 1 ? 16 : 8;
    if (p + header > end) break;
    const size = size32 === 1 ? Number(v.getBigUint64(p + 8)) : size32 === 0 ? Infinity : size32;
    if (size < header) break;
    out.push({ type: String.fromCharCode(b[p + 4]!, b[p + 5]!, b[p + 6]!, b[p + 7]!), body: p + header, end: p + size });
    p += size;
  }
  return out;
}

/**
 * MP4 文件头（moov）里声明了哪些轨：'vide' 画面、'soun' 声音。bytes 是文件开头的一段。
 * 文件头还没完整出现在这段里时返回 undefined（多给些字节再查）；文件头之前就出现了分片或数据，返回 []。
 * 录制用的是分片 MP4，文件头写出后不再改：里面没有 'soun' 的话，后面录到的声音播放器一概读不到。
 */
export function mp4TrackKinds(bytes: Uint8Array): string[] | undefined {
  for (const box of readMp4Boxes(bytes, 0, bytes.length)) {
    if (box.end > bytes.length) return undefined;
    if (box.type === 'moof' || box.type === 'mdat') return [];
    if (box.type !== 'moov') continue;
    return readMp4Boxes(bytes, box.body, box.end)
      .filter((t) => t.type === 'trak')
      .map((trak) => {
        const mdia = readMp4Boxes(bytes, trak.body, trak.end).find((m) => m.type === 'mdia');
        const hdlr = mdia && readMp4Boxes(bytes, mdia.body, mdia.end).find((h) => h.type === 'hdlr');
        // hdlr：版本与标志 4 字节、pre_defined 4 字节，之后是轨的类型
        return hdlr && hdlr.body + 12 <= hdlr.end ? String.fromCharCode(...bytes.subarray(hdlr.body + 8, hdlr.body + 12)) : '';
      });
  }
  return undefined;
}

// ── X 的帖子页 ──

/** /用户名/status/ID（可带 /video/1、/photo/1 等），或没有用户名的 /i/status/ID、/i/web/status/ID */
const X_STATUS_PATH = /^\/(?:i(?:\/web)?|([A-Za-z0-9_]{1,15}))\/status\/(\d{1,25})(?:\/|$)/;

/** 这个网址是不是 X 网页版（录制脚本靠它判断自己在哪个站） */
export function isXPage(url: string): boolean {
  return X_PAGES.some((p) => url.startsWith(p));
}

/**
 * X 帖子页的网址 → 帖子 ID 与规范链接。链接去掉 /video/1 和查询参数（分享链接里的 ?s=…&t=… 会标记分享人）。
 * 不是帖子页返回 undefined。
 */
export function parseXStatusUrl(url: string): { id: string; url: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const full = u.origin + u.pathname;
  const prefix = X_PAGES.find((p) => full.startsWith(p));
  const m = prefix ? X_STATUS_PATH.exec(`/${full.slice(prefix.length)}`) : null;
  return m ? { id: m[2]!, url: `${prefix}${m[1] ?? 'i'}/status/${m[2]}` } : undefined;
}

/**
 * 这个网址是不是 X 的首页信息流（x.com/home：为你推荐 / 正在关注 / 置顶的列表都在这个网址下）。
 * 2026-11-10 起这里也能录（用户要求，见 DECISIONS §55）；个人主页、搜索、书签等别的信息流不算。
 */
export function isXHomeUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const full = u.origin + u.pathname;
  const prefix = X_PAGES.find((p) => full.startsWith(p));
  return !!prefix && /^home\/?$/.test(full.slice(prefix.length));
}

/** 一个视频现在的样子：录制脚本从页面量出来，判断逻辑是纯函数 */
export interface XVideoView {
  /** 正在屏幕里的面积（平方像素），滚到屏幕外是 0 */
  visibleArea: number;
  /** 在全屏视图（/video/1）的弹层里：弹层底下的帖子页还留着一个被盖住的 <video> */
  inDialog: boolean;
  /** 正在播放 */
  playing: boolean;
  /** 播过（位置不在开头） */
  started: boolean;
}

/** 元素的矩形落在视口里的面积 */
export function visibleArea(r: { left: number; top: number; right: number; bottom: number }, viewWidth: number, viewHeight: number): number {
  const w = Math.min(r.right, viewWidth) - Math.max(r.left, 0);
  const h = Math.min(r.bottom, viewHeight) - Math.max(r.top, 0);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * X 一页有好几个 <video>：回复里的视频常常比主帖的还大（2026-11-06 实测 518×518 对 286×508），所以不能只比大小。
 * 依次看：在屏幕上、在全屏弹层里、正在播、播过、屏幕里的面积；都一样时取页面上靠前的（主帖在前）。
 * 返回下标，一个视频都没有时返回 -1。
 */
export function pickXVideo(videos: readonly XVideoView[]): number {
  const flags = (v: XVideoView) => [v.visibleArea > 0, v.inDialog, v.playing, v.started];
  const better = (a: XVideoView, b: XVideoView) => {
    const [fa, fb] = [flags(a), flags(b)];
    const i = fa.findIndex((f, n) => f !== fb[n]);
    return i >= 0 ? fa[i]! : a.visibleArea > b.visibleArea;
  };
  let best = -1;
  videos.forEach((v, i) => {
    if (best < 0 || better(v, videos[best]!)) best = i;
  });
  return best;
}

/** 首页信息流（X、Instagram）里一个视频现在的样子 */
export interface FeedVideoView {
  /** 正在播放 */
  playing: boolean;
  /** 没有声音：静音，或音量拉到了 0 */
  muted: boolean;
  /** 正在屏幕里的面积（平方像素）。录制脚本只给"在播且有声音"的和上次锁定的那个量，别的给 0 */
  visibleArea: number;
}

/**
 * 首页信息流里录哪个视频（2026-11-10 实测 X 与 Instagram）：信息流里的视频滚到眼前时静音自动播放（muted=true）。
 * X 上还没播过的那些反而是 muted=false、暂停着，所以"没静音"单独说明不了什么；你打开声音的那个才是"在播且有声音"。
 * Instagram 上没播过的也是静音的；打开声音是 muted=false、音量大于 0，静音时音量是 0。
 * 只认正在播放且有声音的（不止一个时取屏幕里更大的，再一样取靠前的）。
 * 一个都没有时，上次锁定的那个（held 是它的下标，没有给 -1）只要还有声音、还在屏幕里就继续算数：
 * 你把它暂停下来截图、或它播完了要按时间段重截时不丢目标；滚出屏幕（X、Instagram 都会暂停它）或被静音就放开。
 * 返回下标，没有可录的返回 -1。
 */
export function pickFeedVideo(videos: readonly FeedVideoView[], held = -1): number {
  let best = -1;
  videos.forEach((v, i) => {
    if (v.playing && !v.muted && (best < 0 || v.visibleArea > videos[best]!.visibleArea)) best = i;
  });
  if (best >= 0) return best;
  const h = videos[held];
  return h && !h.muted && h.visibleArea > 0 ? held : -1;
}

// ── Instagram 的首页信息流 ──

/** 帖子短码：/p/<短码>/ 里的那一段（2026-11-10 实测 11 位，字母、数字、- 和 _） */
const IG_POST_PATH = /^(?:[A-Za-z0-9._]{1,30}\/)?(?:p|reels?|tv)\/([A-Za-z0-9_-]{5,40})\/?$/;
/** 只有一段的路径里不是用户名的那些（站内的功能页） */
const IG_RESERVED = /^(?:p|reels?|tv|explore|stories|direct|accounts|about|legal|developer|web|challenge|emails?)$/i;

/** 这个网址是不是 Instagram 网页版（录制脚本靠它判断自己在哪个站） */
export function isIgPage(url: string): boolean {
  return IG_PAGES.some((p) => url.startsWith(p));
}

/** 网址去掉查询参数后，在 Instagram 站内的路径（不带开头的斜杠）；不是 Instagram 返回 undefined */
function igPath(url: string): { prefix: string; path: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const full = u.origin + u.pathname;
  const prefix = IG_PAGES.find((p) => full.startsWith(p));
  return prefix ? { prefix, path: full.slice(prefix.length) } : undefined;
}

/**
 * 这个网址是不是 Instagram 的首页信息流（www.instagram.com/，带不带 ?variant=following 都算）。
 * 只有这里能录（用户 2026-11-10 要求，见 DECISIONS §56）；帖子页、Reels、探索、个人主页都不算。
 */
export function isIgHomeUrl(url: string): boolean {
  return igPath(url)?.path === '';
}

/**
 * Instagram 帖子的链接 → 短码与规范链接。信息流里包着发布时间的链接是 /p/<短码>/（视频帖子也是），
 * 另有 /reel/<短码>/、/reels/<短码>/ 和带用户名的写法；规范链接一律写成 /p/<短码>/，查询参数（分享来源等）去掉。
 * 不是帖子链接返回 undefined。
 */
export function parseIgPostUrl(url: string): { id: string; url: string } | undefined {
  const at = igPath(url);
  const code = at ? IG_POST_PATH.exec(at.path)?.[1] : undefined;
  return at && code ? { id: code, url: `${at.prefix}p/${code}/` } : undefined;
}

/** Instagram 个人主页的链接（/用户名/）→ 用户名；帖子、Reels、探索等功能页和别的网站返回 undefined */
export function igProfileName(url: string): string | undefined {
  const name = /^([A-Za-z0-9._]{1,30})\/?$/.exec(igPath(url)?.path ?? '')?.[1];
  return name && !IG_RESERVED.test(name) ? name : undefined;
}

/**
 * Instagram 的视频放到结尾会自己跳回开头接着放（2026-11-10 实测：没有 loop 属性，也看不到"播完"，只看到进度从结尾跳回 0）。
 * 上一轮还在结尾附近、这一轮回到了开头，就算放完了一遍：这一段在这里结束，不把第二遍接着录进去。
 */
export function loopedToStart(previousTime: number, currentTime: number, duration: number): boolean {
  return atVideoEnd(previousTime, duration) && currentTime < CLIPS.endSlackSec && currentTime < previousTime;
}

// ── 抖音：精选页、搜索结果页里点开的视频 ──

/** 精选页的路径：jingxuan，或 jingxuan/<类目>（如 travel、beauty） */
const DOUYIN_FEED_PATH = /^jingxuan(?:\/(?!search$)[A-Za-z0-9_-]{1,40})?$/;
/**
 * 搜索结果页的路径：search/<搜索词>，前面可以带着发起搜索时所在页面的路径（2026-11-11 实测：在站内的搜索框里搜，网址是
 * /jingxuan/search/<词>、/follow/search/<词>、/jingxuan/travel/search/<词>、/user/self/search/<词>；直接输网址才是 /search/<词>）。
 * 搜索词在网址里是转了码的一段，不含斜杠；综合、视频等标签只差 type 参数。
 */
const DOUYIN_SEARCH_PATH = /^(?:[^/]+\/){0,3}search\/[^/]{1,600}$/;
/** 视频 ID：一串数字（2026-11-10 实测 19 位） */
const DOUYIN_VIDEO_ID = /^\d{6,25}$/;

/** 这个网址是不是抖音网页版（录制脚本靠它判断自己在哪个站） */
export function isDouyinPage(url: string): boolean {
  return DOUYIN_PAGES.some((p) => url.startsWith(p));
}

/**
 * 抖音精选页里打开了一条视频时的网址 → 视频 ID 与规范链接（2026-11-10 实测）：/jingxuan?modal_id=<视频ID>，
 * 带类目时是 /jingxuan/<类目>?modal_id=<视频ID>。划到下一条视频时 modal_id 跟着变，所以换一条就算换了视频。
 * 链接只留路径和 modal_id，别的查询参数去掉。
 * 搜索结果页里点开的视频（2026-11-11 实测）：/search/<搜索词>?modal_id=<视频ID>&type=general，在站内搜索框里搜出来的前面还带着
 * 当时所在页面的路径（如 /jingxuan/search/<搜索词>?aid=…&modal_id=…，见 DOUYIN_SEARCH_PATH）；页面结构和精选页里点开的一样。
 * 但这种网址从外面直接打开时抖音会把 modal_id 丢掉、只剩搜索结果，回不到这条视频；/jingxuan?modal_id=<同一个ID> 打得开。
 * 所以搜索页上的规范链接写成精选页的那种，搜索词不进链接（也就不进记录）。
 * 没打开视频的页面、/video/<ID>、推荐、个人主页等别的页面返回 undefined。
 */
export function parseDouyinUrl(url: string): { id: string; url: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const full = u.origin + u.pathname;
  const prefix = DOUYIN_PAGES.find((p) => full.startsWith(p));
  if (!prefix) return undefined;
  const path = full.slice(prefix.length).replace(/\/$/, '');
  const id = u.searchParams.get('modal_id');
  if (!id || !DOUYIN_VIDEO_ID.test(id)) return undefined;
  if (DOUYIN_FEED_PATH.test(path)) return { id, url: `${prefix}${path}?modal_id=${id}` };
  return DOUYIN_SEARCH_PATH.test(path) ? { id, url: `${prefix}jingxuan?modal_id=${id}` } : undefined;
}

// ── 酷播的播放页 ──

const KUBB_ID = /^[A-Za-z0-9_-]{6,24}$/;
const KUBB_PLAY_PATH = /^play\/([A-Za-z0-9_-]{6,24})\/?$/;

/** 这个网址是不是酷播网页版（录制脚本靠它判断自己在哪个站） */
export function isKubbPage(url: string): boolean {
  return KUBB_PAGES.some((p) => url.startsWith(p));
}

/**
 * 酷播播放页的网址 → 这一条的 ID 与规范链接（2026-11-10 实测）：/play/<影片ID>；剧集换集（你点的或自动播下一集）时网址带上
 * ?id=<分集ID>，不带时是站点替你接着看的那一集。ID 是"影片ID"或"影片ID.分集ID"，所以换一集就算换了视频。
 * 链接只留这两项，别的查询参数去掉。不是播放页返回 undefined。
 */
export function parseKubbPlayUrl(url: string): { id: string; url: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const full = u.origin + u.pathname;
  const prefix = KUBB_PAGES.find((p) => full.startsWith(p));
  const show = prefix ? KUBB_PLAY_PATH.exec(full.slice(prefix.length))?.[1] : undefined;
  if (!prefix || !show) return undefined;
  const raw = u.searchParams.get('id');
  const episode = raw && KUBB_ID.test(raw) ? raw : undefined;
  return { id: episode ? `${show}.${episode}` : show, url: `${prefix}play/${show}${episode ? `?id=${episode}` : ''}` };
}

/**
 * 酷播的片头广告和正片用同一个 <video> 放（2026-11-10 实测）：正片是 blob: 流，广告是直接给地址的短片（实测 20 秒）。
 * 地址不是 blob:、时长又不超过 CLIPS.kubbAdMaxSec 的算广告。时长还不知道时不算：宁可漏判，也不把正片当成广告一直不录。
 */
export function isKubbAd(currentSrc: string, duration: number): boolean {
  return !!currentSrc && !currentSrc.startsWith('blob:') && Number.isFinite(duration) && duration > 0 && duration <= CLIPS.kubbAdMaxSec;
}

// ── 开录前检查 ──

export interface ClipStartRequest {
  mode: ClipMode;
  start?: number;
  end?: number;
}

export interface ClipStartContext {
  /** 不给时是 YouTube */
  site?: ClipSite;
  /** X 的首页信息流（不是帖子页）：视频和帖子都是从信息流里认出来的，不能录时的说法不同 */
  feed?: boolean;
  enabled: boolean;
  videoId: string | null;
  shorts: boolean;
  hasVideo: boolean;
  /** 已经在录（同一时间只录一段） */
  busy: boolean;
  duration: number;
  currentTime: number;
  ended: boolean;
  maxSec: number;
}

/** 时间段是否可录：返回问题说明，没问题返回 undefined */
export function checkRange(start: number | null | undefined, end: number | null | undefined, duration: number, maxSec: number): string | undefined {
  if (start == null || !Number.isFinite(start)) return '起点格式不对：写成 12:03、1:02:03 或秒数';
  if (end == null || !Number.isFinite(end)) return '终点格式不对：写成 12:03、1:02:03 或秒数';
  if (start < 0) return '起点不能早于 0:00';
  if (end <= start) return '终点要晚于起点';
  if (end - start < CLIPS.minRangeSec) return `片段至少 ${CLIPS.minRangeSec} 秒`;
  if (Number.isFinite(duration) && duration > 0 && start >= duration) return `起点超出了视频时长（${formatTimecode(duration)}）`;
  if (end - start > maxSec) return `片段超过了单段时长上限（${formatTimecode(maxSec)}，设置页可改）`;
  return undefined;
}

const CLIP_UNAVAILABLE_TEXT: Record<ClipSite, { noPage: string; noVideo: string }> = {
  youtube: { noPage: '这个页面不是视频播放页', noVideo: '没找到播放器里的视频，等视频开始播放后再试' },
  xhs: { noPage: '这个页面不是笔记详情：打开一篇视频笔记再录', noVideo: '这篇笔记里没有视频（图文笔记录不了）；视频笔记等画面出来后再试' },
  x: { noPage: '这个页面不是帖子详情，也不是首页信息流：点开一条带视频的帖子再录', noVideo: '这条帖子里没有视频；有视频的话等画面出来后再试' },
  kubb: { noPage: '这个页面不是播放页：点开一部影片再录', noVideo: '没找到播放器里的视频，等画面出来后再试' },
  // Instagram 只在首页信息流上录，"没有视频"的说法在 FEED_TEXT 里；这里的 noVideo 用不到，留着是为了每个站都有一句
  ig: { noPage: '这个页面不是 Instagram 的首页信息流：回到首页（www.instagram.com）再录', noVideo: '没找到正在播放的视频，等画面出来后再试' },
  douyin: { noPage: '这个页面上没有点开的抖音视频：在精选页（www.douyin.com/jingxuan）或搜索结果里点开一条视频再录', noVideo: '没找到这条视频的画面，等它开始播放后再试' },
};

/** 首页信息流（X、Instagram）上不能录的原因：没有锁定的视频；锁定了视频但认不出它属于哪条帖子（广告没有帖子链接） */
const FEED_TEXT = {
  noVideo: '信息流里没有正在播放、开着声音的视频：把想录的那个视频的声音打开再录（静音自动播放的不算）',
  // X 上还能点开帖子去帖子页录；Instagram 只有首页能录
  noPost: { x: '认不出这个视频属于哪条帖子（广告没有帖子链接）：点开帖子再录', ig: '认不出这个视频属于哪条帖子（广告没有帖子链接）：这个视频录不了' },
};

/** 这个页面现在为什么录不了（侧边栏显示、开录前检查共用）；能录返回 undefined */
export function clipUnavailable(site: ClipSite, c: Pick<ClipStartContext, 'enabled' | 'videoId' | 'shorts' | 'hasVideo' | 'feed'>): string | undefined {
  if (!c.enabled) return '片段录制已在设置中关闭';
  if (c.shorts) return 'Shorts 暂不支持录制';
  if ((site === 'x' || site === 'ig') && c.feed) return !c.hasVideo ? FEED_TEXT.noVideo : !c.videoId ? FEED_TEXT.noPost[site] : undefined;
  if (!c.videoId) return CLIP_UNAVAILABLE_TEXT[site].noPage;
  if (!c.hasVideo) return CLIP_UNAVAILABLE_TEXT[site].noVideo;
  return undefined;
}

/** 播放位置已到视频结尾（离结尾不到 CLIPS.endSlackSec）；时长未知时不算 */
export function atVideoEnd(currentTime: number, duration: number): boolean {
  return Number.isFinite(duration) && duration > 0 && currentTime >= duration - CLIPS.endSlackSec;
}

/** 开始录制前的检查：返回问题说明（用人话），没问题返回 undefined */
export function checkClipStart(req: ClipStartRequest, c: ClipStartContext): string | undefined {
  const unavailable = clipUnavailable(c.site ?? 'youtube', c);
  if (unavailable) return unavailable;
  if (c.busy) return '已经在录一段了：先停止这一段';
  if (req.mode === 'range') {
    // 时长未知（直播等）时不限制起点
    const duration = Number.isFinite(c.duration) ? c.duration : 0;
    return checkRange(req.start, req.end, duration, c.maxSec);
  }
  if (c.ended) return '视频已经播完了：拖回想录的位置再开始';
  return undefined;
}

// ── Capture 截图 ──

export interface ClipCaptureContext extends Pick<ClipStartContext, 'site' | 'feed' | 'enabled' | 'videoId' | 'shorts' | 'hasVideo'> {
  ad: boolean;
  /** 受版权保护：画上去是黑的，不绕过 */
  drm: boolean;
  /** 有可显示的画面、不在跳转中（跳转时画面还是旧的，时间却是新的，文件名会对不上） */
  ready: boolean;
}

/** 截图前的检查：返回问题说明（用人话），没问题返回 undefined。录制中也能截，所以这里不看 busy */
export function checkCapture(c: ClipCaptureContext): string | undefined {
  const unavailable = clipUnavailable(c.site ?? 'youtube', c);
  if (unavailable) return unavailable;
  if (c.ad) return '正在播广告：广告结束后再截图';
  if (c.drm) return '这个视频受版权保护（DRM），浏览器不允许截图';
  if (!c.ready) return '画面还没准备好（缓冲或跳转中）：等画面出来再截图';
  return undefined;
}

/** 内容脚本对 CLIP_MSG.capture 的回复。PNG 本身之后分块取走（runtime 消息只能传 JSON，单条上限 64 MB） */
export type ClipCaptureReply =
  | {
      ok: true;
      id: string;
      videoId: string;
      title?: string;
      /** 这一帧的播放位置（秒） */
      time: number;
      width: number;
      height: number;
      bytes: number;
      chunks: number;
    }
  | { ok: false; message: string };

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  // String.fromCharCode 的参数个数有上限：分段转
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── 录 / 等 / 停 ──

export interface ClipControl {
  mode: ClipMode;
  videoId: string;
  start?: number;
  end?: number;
  /** 已录时长（秒，不含暂停） */
  recordedSec: number;
  bytes: number;
  maxSec: number;
  maxBytes: number;
  /** 你按了"暂停" */
  userPaused: boolean;
}

export interface ClipSample {
  videoId: string | null;
  currentTime: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  /** 有可显示的画面（readyState ≥ 2） */
  ready: boolean;
  ad: boolean;
  /** 标签页在前台（后台时浏览器不再刷新画面） */
  visible: boolean;
  /** 在播放（没暂停、没在跳转）但进度超过 CLIPS.stallMs 没动：卡住了 */
  stalled?: boolean;
  /** 视频总时长（秒）；未知时不给 */
  duration?: number;
}

export type ClipStopReason = 'user' | 'video-changed' | 'max-duration' | 'max-bytes' | 'range-end' | 'ended' | 'error';
export type ClipWaitReason = 'user' | 'ad' | 'hidden' | 'seeking' | 'paused' | 'before-range' | 'outside-range';
export type ClipDecision = { kind: 'record' } | { kind: 'wait'; why: ClipWaitReason } | { kind: 'stop'; reason: ClipStopReason };

export const CLIP_WAIT_LABELS: Record<ClipWaitReason, string> = {
  user: '已暂停：点"继续"接着录',
  ad: '广告中，已自动暂停；广告结束后接着录',
  hidden: '标签页在后台，已自动暂停；切回这个标签页后接着录',
  seeking: '缓冲中…',
  paused: '视频已暂停；继续播放时接着录',
  'before-range': '等视频播到起点…',
  'outside-range': '当前位置不在截取范围内：拖回范围里接着录',
};

export const CLIP_STOP_LABELS: Record<ClipStopReason, string> = {
  user: '你停止了录制',
  'video-changed': '切到了别的视频（或关掉了这篇笔记、离开了这条帖子），这一段已结束',
  'max-duration': '到了单段时长上限（设置页可改）',
  'max-bytes': '片段太大了，已自动结束（保存前都在内存里）',
  'range-end': '已录到终点',
  ended: '视频播完了',
  error: '录制出错，已结束',
};

/** 每一轮（约 100 毫秒）决定：继续录、暂停等待（并说明为什么），还是结束这一段 */
export function decideClip(c: ClipControl, s: ClipSample, tolerance: number = CLIPS.rangeToleranceSec): ClipDecision {
  if (s.videoId !== c.videoId) return { kind: 'stop', reason: 'video-changed' };
  if (c.recordedSec >= c.maxSec) return { kind: 'stop', reason: 'max-duration' };
  if (c.bytes >= c.maxBytes) return { kind: 'stop', reason: 'max-bytes' };
  const range = c.mode === 'range' && c.start !== undefined && c.end !== undefined;
  // 卡在结尾也算播完：小红书的播放器放到最后一帧就停在那里，既不暂停也不报"播完"（2026-11-04 实测）
  // 广告放完不算视频播完：酷播的片头广告和正片用同一个播放器放，广告放到头时也报"播完"，接着才换成正片（2026-11-10）
  const finished = !s.ad && (s.ended || (!!s.stalled && atVideoEnd(s.currentTime, s.duration ?? 0)));
  // 时间段：已经录到东西、又到了终点（含拖过终点、播完）就结束
  if (range && c.recordedSec > 0 && (s.currentTime >= c.end! || finished)) return { kind: 'stop', reason: 'range-end' };
  if (!range && finished) return { kind: 'stop', reason: 'ended' };
  if (c.userPaused) return { kind: 'wait', why: 'user' };
  if (s.ad) return { kind: 'wait', why: 'ad' };
  if (!s.visible) return { kind: 'wait', why: 'hidden' };
  // 卡住（缓冲）时画面停在一帧上：不录这段静止画面
  if (s.seeking || !s.ready || s.stalled) return { kind: 'wait', why: 'seeking' };
  if (s.paused) return { kind: 'wait', why: 'paused' };
  if (range) {
    if (s.currentTime < c.start! - tolerance) return { kind: 'wait', why: c.recordedSec > 0 ? 'outside-range' : 'before-range' };
    if (s.currentTime >= c.end!) return { kind: 'wait', why: 'outside-range' };
  }
  return { kind: 'record' };
}

// ── 字幕烧录排版 ──

export interface BurnLine {
  text: string;
  /** 原文（白色）或译文（浅黄、略小），与播放器里的字幕层一致 */
  tone: 'source' | 'translation';
  /** 文字颜色（多语字幕每种语言一种颜色）；不给时按 tone */
  color?: string;
}

export interface BurnBox {
  text: string;
  tone: BurnLine['tone'];
  color?: string;
  fontPx: number;
  /** 底框左上角与宽高 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 文字中心 */
  cx: number;
  cy: number;
}

/** 量文字宽度（像素）：内容脚本里用画布的 measureText，单测里用假的 */
export type MeasureText = (text: string, fontPx: number) => number;

/** 中日韩文字与全角标点：逐字可断行 */
const CJK_RANGES = '\\u2e80-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef\\u3000-\\u303f';
/** 一个中日韩字、一个词（连同后面的空白）或一段空白 */
const WRAP_TOKEN = new RegExp(`[${CJK_RANGES}]|[^\\s${CJK_RANGES}]+\\s*|\\s+`, 'g');

/** 按宽度折行：中日韩文字逐字可断，其他语言按词断；超长的词硬切 */
export function wrapText(text: string, maxWidth: number, fontPx: number, measure: MeasureText): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const tokens = para.match(WRAP_TOKEN) ?? [];
    let line = '';
    const push = () => {
      const t = line.trim();
      if (t) out.push(t);
      line = '';
    };
    for (const tok of tokens) {
      if (measure((line + tok).trimEnd(), fontPx) <= maxWidth) {
        line += tok;
        continue;
      }
      push();
      if (measure(tok.trimEnd(), fontPx) <= maxWidth) {
        line = tok.trimStart();
        continue;
      }
      // 一个词就比整行还宽：逐字切开
      for (const ch of tok.trimEnd()) {
        if (measure(line + ch, fontPx) > maxWidth && line) push();
        line += ch;
      }
    }
    push();
  }
  return out;
}

/** 把要烧录的字幕排在画面底部居中：每行一个半透明底框，从下往上堆，最下面是最后一行 */
export function layoutBurnIn(lines: BurnLine[], opts: { width: number; height: number; fontScale?: number; measure: MeasureText }): BurnBox[] {
  const { width, height, measure } = opts;
  const base = Math.min(48, Math.max(14, height * 0.045)) * (opts.fontScale || 1);
  const padX = base * 0.45;
  const maxText = width * 0.9 - padX * 2;
  const rows: { text: string; tone: BurnLine['tone']; color?: string; fontPx: number }[] = [];
  for (const l of lines) {
    const fontPx = l.tone === 'translation' ? base * 0.88 : base;
    for (const t of wrapText(l.text, maxText, fontPx, measure)) rows.push({ text: t, tone: l.tone, ...(l.color ? { color: l.color } : {}), fontPx });
  }
  const boxes: BurnBox[] = [];
  let bottom = height - Math.max(12, height * 0.06);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    const h = r.fontPx * 1.4;
    const w = Math.min(width * 0.94, measure(r.text, r.fontPx) + padX * 2);
    const y = bottom - h;
    if (y < 0) break; // 画面放不下的更早的行不画
    boxes.unshift({ text: r.text, tone: r.tone, ...(r.color ? { color: r.color } : {}), fontPx: r.fontPx, x: (width - w) / 2, y, w, h, cx: width / 2, cy: y + h / 2 });
    bottom = y - base * 0.18;
  }
  return boxes;
}

// ── 状态（内容脚本 → 侧边栏）──

export interface ReadyClipInfo {
  id: string;
  fileName: string;
  bytes: number;
  durationSec: number;
  start: number;
  end: number;
  format: string;
  burned: boolean;
  /** 这一段为什么结束 */
  endedBy: ClipStopReason;
  savedAt?: number;
}

export interface ClipTabState {
  site: ClipSite;
  /** YouTube 的视频 ID、小红书的笔记 ID、X 的帖子 ID、酷播的影片 ID（剧集带分集 ID），或 Instagram 的帖子短码 */
  videoId: string | null;
  /** 视频标题（来自页面标题；X、Instagram 首页信息流上来自这条帖子的作者名和正文），只用来显示和起文件名 */
  title?: string;
  /** 不能录的原因（不是视频页、Shorts、设置里关了、图文笔记、帖子里没有视频） */
  unavailable?: string;
  /** 当前播放位置与总时长（秒） */
  position: number;
  duration: number;
  phase: 'idle' | 'recording' | 'finishing';
  mode?: ClipMode;
  range?: { start: number; end: number };
  recordedSec: number;
  bytes: number;
  /** 正在录但暂停着：为什么 */
  waiting?: ClipWaitReason;
  /** 一句话说明现在的状态 */
  status: string;
  burn: boolean;
  autoSave: boolean;
  maxSec: number;
  format?: string;
  ready?: ReadyClipInfo;
  error?: { message: string; hint?: string };
}

// ── 录制记录（后台存，侧边栏显示；只有元数据，没有视频本身）──

export interface ClipRecord {
  id: string;
  /** 小红书的记录带 'xhs'，X 的带 'x'，酷播的带 'kubb'，Instagram 的带 'ig'，抖音的带 'douyin'；没有这一项的是 YouTube（2026-11-04 之前的记录都是） */
  site?: ClipSite;
  /** YouTube 的视频 ID、小红书的笔记 ID、X 的帖子 ID、酷播的影片 ID（剧集是"影片ID.分集ID"），或 Instagram 的帖子短码 */
  videoId: string;
  /**
   * 小红书：笔记链接（只留站点、路径与 xsec_token / xsec_source，从外面打开笔记要带 xsec_token）；
   * X：帖子链接（parseXStatusUrl 的规范链接）；酷播：播放页链接（parseKubbPlayUrl 的规范链接）；
   * Instagram：帖子链接（parseIgPostUrl 的规范链接）；抖音：精选页里这条视频的链接（parseDouyinUrl 的规范链接；在搜索结果里录的也记成精选页的链接）
   */
  url?: string;
  title?: string;
  mode: ClipMode;
  start: number;
  end: number;
  durationSec: number;
  bytes: number;
  format: string;
  fileName: string;
  burned: boolean;
  savedAt: number;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

/** 小红书、X、酷播的记录要带回到原处的链接：规范化后的链接；与这条记录的 ID 对不上时 null。YouTube 不带（undefined） */
function clipSourceUrl(site: ClipSite, raw: unknown, id: string | null): string | null | undefined {
  if (site === 'youtube') return undefined;
  if (typeof raw !== 'string') return null;
  if (site !== 'xhs') {
    const page = { x: parseXStatusUrl, kubb: parseKubbPlayUrl, ig: parseIgPostUrl, douyin: parseDouyinUrl }[site](raw);
    return page?.id === id ? page.url : null;
  }
  const note = canonicalXhsUrl(raw);
  return note?.link.kind === 'note' && note.link.noteId === id ? note.url : null;
}

/**
 * 校验内容脚本送来的记录（来自网页环境，字段逐一检查、截断）。
 * site 由后台按发消息的页面决定（不信记录里自己写的）：小红书、X、酷播的 ID 与链接必须对得上。
 */
export function sanitizeClipRecord(raw: unknown, site: ClipSite = 'youtube'): ClipRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
  const id = str(r.id, 64);
  // X 的帖子 ID、酷播的影片 ID、Instagram 的帖子短码、抖音的视频 ID 由下面的链接核对（只能是从链接里解析出来的那个）
  const idFromUrl = site !== 'youtube' && site !== 'xhs';
  const videoId = typeof r.videoId === 'string' && (site === 'xhs' ? isXhsId(r.videoId) : idFromUrl || VIDEO_ID.test(r.videoId)) ? r.videoId : null;
  const sourceUrl = clipSourceUrl(site, r.url, videoId);
  if (sourceUrl === null) return null;
  const mode = r.mode === 'free' || r.mode === 'range' ? r.mode : null;
  const start = num(r.start, 1e6);
  const end = num(r.end, 1e6);
  const durationSec = num(r.durationSec, 1e5);
  const bytes = num(r.bytes, 1e11);
  const savedAt = num(r.savedAt, 1e14);
  const fileName = str(r.fileName, 200);
  const format = str(r.format, 60);
  if (!id || !videoId || !mode || start === null || end === null || durationSec === null || bytes === null || savedAt === null || !fileName || !format) return null;
  const title = str(r.title, 200);
  return { id, ...(sourceUrl ? { site, url: sourceUrl } : {}), videoId, ...(title ? { title } : {}), mode, start, end, durationSec, bytes, format, fileName, burned: r.burned === true, savedAt };
}

/** 新记录放最前；同一个片段再存一次只更新时间；最多保留 max 条 */
export function addClipRecord(log: ClipRecord[], rec: ClipRecord, max: number = CLIPS.logMax): ClipRecord[] {
  return [rec, ...log.filter((r) => r.id !== rec.id)].slice(0, max);
}

/** 回到视频里这一段的地址；小红书、X、酷播没有按时间打开的地址，回到这篇笔记、这条帖子或这部影片（这一集） */
export function clipWatchUrl(r: Pick<ClipRecord, 'videoId' | 'start' | 'site' | 'url'>): string {
  if (r.site === 'xhs') return r.url ?? `${XHS_PAGES[0]}explore/${encodeURIComponent(r.videoId)}`;
  if (r.site === 'x') return r.url ?? `${X_PAGES[0]}i/status/${encodeURIComponent(r.videoId)}`;
  if (r.site === 'ig') return r.url ?? `${IG_PAGES[0]}p/${encodeURIComponent(r.videoId)}/`;
  if (r.site === 'douyin') return r.url ?? `${DOUYIN_PAGES[0]}jingxuan?modal_id=${encodeURIComponent(r.videoId)}`;
  if (r.site === 'kubb') {
    const [show = '', episode] = r.videoId.split('.');
    return r.url ?? `${KUBB_PAGES[0]}play/${encodeURIComponent(show)}${episode ? `?id=${encodeURIComponent(episode)}` : ''}`;
  }
  return `https://www.youtube.com/watch?v=${encodeURIComponent(r.videoId)}&t=${Math.floor(r.start)}s`;
}
