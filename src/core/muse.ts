// 「问 muse」的纯逻辑（2026-11-11 新增，见 DECISIONS §60）：把正在看的这条视频 / 帖子整理成一段"咨询包"文字，
// 由你自己复制、粘贴到 Muse 聊天里提问。这里只拼文字：不联网、不调大模型、不向 Muse 发任何东西。
// 页面上的信息由录制脚本（content/clipper.ts）在你点「问 muse」的那一刻读一次；YouTube 已经读到的字幕来自多语字幕脚本
// （content/multi-captions.ts）和本机存的自动字幕。页面来的数据不可信：进咨询包前逐项校验、截断，
// 链接只留认得出这条视频 / 帖子的那部分，看起来像 Key / 令牌的内容一律换掉。

import { MUSE } from '../config/defaults';
import { parseDouyinUrl, parseIgPostUrl, parseKubbPlayUrl, parseXStatusUrl, type ClipSite } from './clips';
import { REDACTED } from './redact';
import { parseXhsPath, xhsPath } from './xhs';

/** 侧边栏 → 内容脚本的消息类型 */
export const MUSE_MSG = {
  /** → 录制脚本：现在这条视频 / 帖子是什么、播到哪了（回复 MuseSnapshot） */
  snapshot: 'tubemuse:muse:snapshot',
  /** → 多语字幕脚本：已经读到的字幕里，位置 t 前后的那几句（回复 MuseCaptionReply；没有读到的字幕时不回） */
  captions: 'tubemuse:muse:captions',
} as const;

export const MUSE_SITE_LABELS: Record<ClipSite, string> = { youtube: 'YouTube', xhs: '小红书', x: 'X', kubb: '酷播', ig: 'Instagram', douyin: '抖音' };

/** 没有的项一律写这个，不编造 */
export const MUSE_NONE = '无';
export const MUSE_UNKNOWN = '未知';

/** 播放位置为什么没读到：正在播广告（读到的会是广告的进度）、这一条里没有视频、Shorts（它的播放器不读） */
export type MusePositionGap = 'ad' | 'no-video' | 'shorts';

/** 你点「问 muse」那一刻，页面上这条视频 / 帖子的样子（录制脚本交回，侧边栏校验后使用） */
export interface MuseSnapshot {
  site: ClipSite;
  /** 认不出当前这条视频 / 帖子的原因；有它时别的都没有 */
  unavailable?: string;
  /** YouTube 的视频 ID、小红书的笔记 ID、X 的帖子 ID、酷播的影片 ID、Instagram 的帖子短码、抖音的视频 ID */
  videoId?: string;
  /** 这条视频 / 帖子的链接（见 museItem：不带时间、令牌和分享来源）；YouTube 不给，由 videoId 拼 */
  url?: string;
  shorts?: boolean;
  title?: string;
  author?: string;
  /** 这条帖子 / 笔记的正文，或这条视频的描述 */
  body?: string;
  /** 正文太长、交回来时已经截过：原文一共多少个字 */
  bodyTotal?: number;
  /** 冻结那一刻的播放位置与总时长（秒）；读不到时不给 */
  position?: number;
  duration?: number;
  gap?: MusePositionGap;
}

const UNAVAILABLE: Record<ClipSite, string> = {
  youtube: '这个页面不是 YouTube 视频播放页：打开一个视频再点「问 muse」',
  xhs: '这个页面不是笔记详情：打开一篇笔记再点「问 muse」',
  x: '这个页面不是帖子详情，也不是首页信息流：点开一条帖子再点「问 muse」',
  kubb: '这个页面不是播放页：点开一部影片再点「问 muse」',
  ig: '这个页面不是 Instagram 的首页信息流：回到首页（www.instagram.com）再点「问 muse」',
  douyin: '这个页面上没有点开的抖音视频：在精选页（www.douyin.com/jingxuan）或搜索结果里点开一条视频再点「问 muse」',
};

/**
 * 这个页面上现在为什么认不出"当前这条视频 / 帖子"；认得出返回 undefined。
 * 和片段录制认的是同一条（见 core/clips.ts 的 clipUnavailable），但不看"片段录制"的开关，也不要求一定有视频：
 * 没有视频的笔记、帖子照样能问，只是播放位置写「未知」。
 */
export function museUnavailable(site: ClipSite, c: { videoId: string | null; feed: boolean; hasVideo: boolean }): string | undefined {
  if ((site === 'x' || site === 'ig') && c.feed) {
    if (!c.hasVideo) return '信息流里没有正在播放、开着声音的视频：把想问的那个视频的声音打开，再点「问 muse」（静音自动播放的不算）';
    return c.videoId ? undefined : '认不出这个视频属于哪条帖子（广告没有帖子链接），没法生成咨询包';
  }
  return c.videoId ? undefined : UNAVAILABLE[site];
}

/**
 * 这条视频 / 帖子的 ID 与规范链接：只留认得出它的那部分。查询参数里的令牌、分享来源一律不带——
 * 小红书的 xsec_token 也不带（它是令牌；不带它，从外面打开这个链接时小红书可能要求登录或提示"暂时无法浏览"）。
 * 不是这个站的视频 / 帖子页返回 undefined。YouTube 的链接由视频 ID 拼（见 museLink）。
 */
export function museItem(site: Exclude<ClipSite, 'youtube'>, url: string): { id: string; url: string } | undefined {
  if (site === 'xhs') {
    const p = xhsPath(url);
    const link = p ? parseXhsPath(p.path) : undefined;
    return p && link?.kind === 'note' ? { id: link.noteId, url: `${p.prefix}explore/${link.noteId}` } : undefined;
  }
  return { x: parseXStatusUrl, kubb: parseKubbPlayUrl, ig: parseIgPostUrl, douyin: parseDouyinUrl }[site](url);
}

// ── 校验页面交回来的数据 ──

const SITES: readonly ClipSite[] = ['youtube', 'xhs', 'x', 'kubb', 'ig', 'douyin'];
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;
/** 控制字符与零宽字符（保留制表符和换行） */
const CONTROL = new RegExp(`[\x00-\x08\x0B-\x1F\x7F${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200d, 0x2028, 0x2029, 0xfeff)}]`, 'g');

const chars = (s: string): number => [...s].length;
const head = (s: string, max: number): string => (chars(s) > max ? [...s].slice(0, max).join('') : s);

/** 一行文字：去掉控制字符，空白（含换行）压成一个空格，最多 max 个字；空的返回 undefined */
function oneLine(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = head(v.replace(CONTROL, '').replace(/\s+/g, ' ').trim(), max).trim();
  return s || undefined;
}

/** 一段文字：统一换行、去掉控制字符，每行压缩空白，连续的空行只留一行，最多 max 个字；空的返回 undefined */
function block(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .split('\n')
    .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return head(s, max).trim() || undefined;
}

/** 校验录制脚本交回来的快照（来自网页环境，字段逐一检查、截断）。认不出、ID 与链接对不上时返回 null */
export function sanitizeMuseSnapshot(raw: unknown): MuseSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const site = SITES.find((s) => s === r.site);
  if (!site) return null;
  const unavailable = oneLine(r.unavailable, 200);
  if (unavailable) return { site, unavailable };
  let videoId: string;
  let url: string | undefined;
  if (site === 'youtube') {
    if (typeof r.videoId !== 'string' || !YOUTUBE_ID.test(r.videoId)) return null;
    videoId = r.videoId;
  } else {
    const item = typeof r.url === 'string' ? museItem(site, r.url) : undefined;
    if (!item || item.id !== r.videoId) return null;
    videoId = item.id;
    url = item.url;
  }
  const seconds = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e6 ? v : undefined);
  const position = seconds(r.position);
  const duration = seconds(r.duration);
  const title = oneLine(r.title, MUSE.titleMaxChars);
  const author = oneLine(r.author, MUSE.authorMaxChars);
  const body = block(r.body, MUSE.bodyReadMaxChars);
  const bodyTotal = typeof r.bodyTotal === 'number' && Number.isSafeInteger(r.bodyTotal) && r.bodyTotal > 0 ? r.bodyTotal : undefined;
  const gap = r.gap === 'ad' || r.gap === 'no-video' || r.gap === 'shorts' ? r.gap : undefined;
  return {
    site,
    videoId,
    ...(url ? { url } : {}),
    ...(site === 'youtube' && r.shorts === true ? { shorts: true } : {}),
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(body ? { body } : {}),
    ...(body && bodyTotal && bodyTotal > chars(body) ? { bodyTotal } : {}),
    ...(position !== undefined ? { position } : {}),
    ...(position !== undefined && duration ? { duration } : {}),
    ...(position === undefined && gap ? { gap } : {}),
  };
}

// ── 字幕 / 转写 ──

/** 一句字幕或转写：开始时间（视频秒）和文字 */
export interface MuseCue {
  start: number;
  text: string;
}

export interface MuseCaptions {
  /** YouTube 字幕（多语字幕已经读到的那条轨），或 TubeMuse 自动字幕的转写（语音识别） */
  source: 'youtube-cc' | 'auto';
  /** 哪种语言，如"English"、"简体中文（YouTube 自动翻译）" */
  label?: string;
  /** 按开始时间排 */
  cues: MuseCue[];
}

/** 多语字幕脚本对 MUSE_MSG.captions 的回复 */
export interface MuseCaptionReply {
  videoId: string;
  label: string;
  autoTranslated: boolean;
  cues: MuseCue[];
}

/** 位置 t 前后 windowSec 秒内的句子（和这段时间有交叠就算），按开始时间排 */
export function cuesAround<T extends { start: number; end: number; text: string }>(cues: readonly T[], t: number, windowSec: number = MUSE.windowSec): T[] {
  return cues.filter((c) => c.text.trim() && c.end > t - windowSec && c.start < t + windowSec).sort((a, b) => a.start - b.start);
}

function sanitizeCues(raw: unknown): MuseCue[] {
  if (!Array.isArray(raw)) return [];
  const out: MuseCue[] = [];
  for (const c of raw.slice(0, MUSE.maxCues) as { start?: unknown; text?: unknown }[]) {
    const text = oneLine(c?.text, 500);
    if (text && typeof c.start === 'number' && Number.isFinite(c.start) && c.start >= 0 && c.start <= 1e6) out.push({ start: c.start, text });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 校验多语字幕脚本交回来的字幕：必须是这个视频的，至少有一句；否则 undefined */
export function sanitizeMuseCaptionReply(raw: unknown, videoId: string): MuseCaptions | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.videoId !== videoId) return undefined;
  const cues = sanitizeCues(r.cues);
  if (!cues.length) return undefined;
  const lang = oneLine(r.label, 60);
  const label = lang ? `${lang}${r.autoTranslated === true ? '（YouTube 自动翻译）' : ''}` : undefined;
  return { source: 'youtube-cc', ...(label ? { label } : {}), cues };
}

/** 本机存的自动字幕（语音识别的转写）里，位置 t 前后的那几句；一句都没有时 undefined */
export function autoTranscriptAround(cues: readonly { start: number; end: number; text: string }[] | undefined, t: number): MuseCaptions | undefined {
  const near = sanitizeCues(cuesAround(cues ?? [], t));
  return near.length ? { source: 'auto', cues: near } : undefined;
}

// ── 咨询包 ──

/** 咨询包里的时间：mm:ss；满一小时写成 h:mm:ss */
export function museClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** 播放位置一项：mm:ss / 总时长；位置读不到写「未知」，只有总时长读不到时总时长写「未知」 */
export function musePosition(position: number | undefined, duration: number | undefined): string {
  if (position === undefined) return MUSE_UNKNOWN;
  return `${museClock(position)} / ${duration !== undefined ? museClock(duration) : MUSE_UNKNOWN}`;
}

/**
 * 页面链接。只有 YouTube 在链接上拼时间（&t=秒数s；位置读不到时不拼，Shorts 不拼）；
 * 别的站没有按时间打开的地址，只给这条视频 / 帖子的链接，不自创时间参数。
 */
export function museLink(s: Pick<MuseSnapshot, 'site' | 'videoId' | 'url' | 'shorts' | 'position'>): string | undefined {
  if (s.site !== 'youtube') return s.url;
  if (!s.videoId) return undefined;
  if (s.shorts) return `https://www.youtube.com/shorts/${encodeURIComponent(s.videoId)}`;
  return `https://www.youtube.com/watch?v=${encodeURIComponent(s.videoId)}${s.position !== undefined ? `&t=${Math.floor(s.position)}s` : ''}`;
}

/** 上下文用的是哪一种：字幕 / 转写、正文 / 描述、只有标题，或什么都没有 */
export type MuseContextKind = 'captions' | 'body' | 'title' | 'none';

const BODY_NAMES: Record<ClipSite, string> = {
  youtube: '这个视频的描述',
  xhs: '这篇笔记的正文',
  x: '这条帖子的正文',
  kubb: '这部影片的简介',
  ig: '这条帖子的正文',
  douyin: '这条视频的描述',
};

interface MuseContext {
  kind: MuseContextKind;
  /** "上下文（…）"括号里的说明 */
  label?: string;
  text?: string;
  /** 截断说明；没截断时没有 */
  cut?: string;
}

/**
 * 字幕 / 转写做上下文：一句一行，行首是这一句的开始时间。放不下时从离冻结位置最远的句子丢起，并注明保留了哪一段；
 * 连离得最近的那一句都放不下时，只留它的开头。
 */
function captionContext(c: MuseCaptions, position: number, max: number): MuseContext {
  const what = c.source === 'youtube-cc' ? `字幕 · YouTube 字幕${c.label ? `（${c.label}）` : ''}` : '转写 · TubeMuse 自动字幕（语音识别）';
  const label = `当前位置前后 ${MUSE.windowSec} 秒的${what}`;
  const lines = c.cues.map((q) => `[${museClock(q.start)}] ${q.text}`);
  const total = lines.reduce((n, l) => n + chars(l) + 1, 0);
  if (total <= max) return { kind: 'captions', label, text: lines.join('\n') };
  const byDistance = c.cues.map((q, i) => i).sort((a, b) => Math.abs(c.cues[a]!.start - position) - Math.abs(c.cues[b]!.start - position));
  const keep = new Set<number>();
  let used = 0;
  for (const i of byDistance) {
    const cost = chars(lines[i]!) + 1;
    if (used + cost > max) break;
    keep.add(i);
    used += cost;
  }
  if (!keep.size) {
    const i = byDistance[0]!;
    return { kind: 'captions', label, text: `${head(lines[i]!, max)}…`, cut: `已截断：前后 ${MUSE.windowSec} 秒共 ${lines.length} 句，只保留了离当前位置最近的一句的开头` };
  }
  const kept = [...keep].sort((a, b) => a - b);
  const range = `${museClock(c.cues[kept[0]!]!.start)}–${museClock(c.cues[kept[kept.length - 1]!]!.start)}`;
  return { kind: 'captions', label, text: kept.map((i) => lines[i]!).join('\n'), cut: `已截断：前后 ${MUSE.windowSec} 秒共 ${lines.length} 句，只保留了离当前位置最近的 ${kept.length} 句（${range}）` };
}

function bodyContext(s: MuseSnapshot, max: number): MuseContext {
  const body = s.body!;
  const label = BODY_NAMES[s.site];
  const total = s.bodyTotal ?? chars(body);
  if (chars(body) <= max && !s.bodyTotal) return { kind: 'body', label, text: body };
  const text = head(body, max).trimEnd();
  return { kind: 'body', label, text: `${text}…`, cut: `已截断：原文约 ${total} 字，这里是开头的 ${chars(text)} 字` };
}

/** 上下文按优先级只取一种：冻结位置前后的字幕 / 转写 → 这条帖子 / 笔记的正文或描述 → 只有标题 → 无 */
function pickContext(s: MuseSnapshot, captions: MuseCaptions | undefined, max: number): MuseContext {
  if (captions?.cues.length && s.position !== undefined) return captionContext(captions, s.position, max);
  if (s.body) return bodyContext(s, max);
  if (s.title) return { kind: 'title', label: '只有标题：没有字幕 / 转写，也没有正文 / 描述', text: s.title };
  return { kind: 'none' };
}

/**
 * 看起来像 Key / 令牌的内容。前面要求是词的开头：标题、正文里常见的"task-…""risk-…"之类的词不能被误伤，
 * 所以这里不直接用 core/redact.ts 的规则（那是给报错信息用的，宁可多遮）。
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9]{32,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bya29\.[0-9A-Za-z._-]{20,}/g,
  /\bGOCSPX-[0-9A-Za-z_-]{20,}/g,
  /\b1\/\/0[0-9A-Za-z_-]{30,}/g,
  /AAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%_-]{30,}/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g,
  /([?&](?:key|api_key|access_token|refresh_token|id_token|token|xsec_token|client_secret|pot)=)[^&\s#]+/gi,
];

/** 把你存在本机的 Key / 令牌（原样出现时）和看起来像 Key / 令牌的内容换成"[已隐藏]"；changed：有没有换掉东西 */
export function redactMuse(text: string, secrets: readonly (string | undefined)[] = []): { text: string; changed: boolean } {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, prefix: unknown) => (typeof prefix === 'string' && match.startsWith(prefix) ? prefix + REDACTED : REDACTED));
  }
  return { text: out, changed: out !== text };
}

export interface MusePackageInput {
  /** 校验过的快照（sanitizeMuseSnapshot 的结果，且不是 unavailable） */
  snapshot: MuseSnapshot;
  /** 冻结位置前后的字幕 / 转写（已有的才给） */
  captions?: MuseCaptions;
  /** 你的问题，原话 */
  question: string;
  /** 你存在本机的 Key / 令牌：万一原样出现在文字里，换掉 */
  secrets?: readonly (string | undefined)[];
}

export interface MusePackage {
  text: string;
  context: MuseContextKind;
  /** 上下文被截断了（咨询包里已注明） */
  truncated: boolean;
  /** 有内容看起来像 Key / 令牌，被换成了"[已隐藏]" */
  redacted: boolean;
}

/**
 * 拼咨询包。所有平台用同一组字段，有就填，没有写「无」（播放位置写「未知」），不编造；
 * 末尾附给 Muse 的回答要求。整段文字最后过一遍 redactMuse：咨询包里不出现任何 Key / 令牌。
 */
export function buildMusePackage(input: MusePackageInput): MusePackage {
  const s = input.snapshot;
  const ctx = pickContext(s, input.captions, MUSE.contextMaxChars);
  const context =
    ctx.kind === 'none'
      ? [`上下文：${MUSE_NONE}`]
      : ctx.kind === 'title'
        ? [`上下文（${ctx.label}）：${ctx.text}`]
        : [`上下文（${ctx.label}）：`, ctx.text!, ...(ctx.cut ? [`（${ctx.cut}）`] : [])];
  const lines = [
    `平台：${MUSE_SITE_LABELS[s.site]}`,
    `页面链接：${museLink(s) ?? MUSE_NONE}`,
    `标题：${s.title ?? MUSE_NONE}`,
    `作者：${s.author ?? MUSE_NONE}`,
    `播放位置：${musePosition(s.position, s.duration)}`,
    ...context,
    `我的问题：${input.question.replace(CONTROL, '').trim() || MUSE_NONE}`,
    '',
    MUSE.answerRule,
  ];
  const { text, changed } = redactMuse(lines.join('\n'), input.secrets);
  return { text, context: ctx.kind, truncated: !!ctx.cut, redacted: changed };
}
