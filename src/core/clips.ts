// 视频片段录制的纯逻辑：时间码、文件名、编码格式与尺寸、录 / 等 / 停的判定、开录前检查、字幕烧录排版、录制记录。
// 录制本身（画布、MediaRecorder、保存）在 content/clipper.ts；侧边栏"片段"页只经消息控制它。

import { CLIPS } from '../config/defaults';

export type ClipMode = 'free' | 'range';

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

/** 页面标题 → 视频标题：去掉开头的通知数"(12) "与结尾的" - YouTube" */
export function titleFromDocumentTitle(docTitle: string): string {
  return docTitle
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/\s*[-–—]\s*YouTube\s*$/i, '')
    .trim();
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

/** 片段文件名：标题_起点-终点.扩展名；没有标题时用视频 ID */
export function clipFileName(title: string | undefined, videoId: string, start: number, end: number, ext: string): string {
  const base = safeFileTitle(title ?? '') || `youtube-${videoId}`;
  return `${base}_${fileStamp(start)}-${fileStamp(end)}.${ext}`;
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

/** 输出画面尺寸：按视频原尺寸，高于上限时等比缩小；宽高取偶数（H.264 要求）。读不到尺寸时用默认尺寸 */
export function outputSize(videoWidth: number, videoHeight: number, maxHeight: number = CLIPS.maxHeight, fallback: { width: number; height: number } = CLIPS.fallbackSize): { width: number; height: number } {
  if (!(videoWidth > 0) || !(videoHeight > 0)) return { ...fallback };
  const scale = Math.min(1, maxHeight / videoHeight);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(videoWidth * scale), height: even(videoHeight * scale) };
}

export function videoBitrate(height: number): number {
  return (CLIPS.videoBitrates.find((b) => height >= b.minHeight) ?? CLIPS.videoBitrates[CLIPS.videoBitrates.length - 1]!).bps;
}

// ── 开录前检查 ──

export interface ClipStartRequest {
  mode: ClipMode;
  start?: number;
  end?: number;
}

export interface ClipStartContext {
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

/** 开始录制前的检查：返回问题说明（用人话），没问题返回 undefined */
export function checkClipStart(req: ClipStartRequest, c: ClipStartContext): string | undefined {
  if (!c.enabled) return '片段录制已在设置中关闭';
  if (c.shorts) return 'Shorts 暂不支持录制';
  if (!c.videoId) return '这个页面不是视频播放页';
  if (!c.hasVideo) return '没找到播放器里的视频，等视频开始播放后再试';
  if (c.busy) return '已经在录一段了：先停止这一段';
  if (req.mode === 'range') {
    // 时长未知（直播等）时不限制起点
    const duration = Number.isFinite(c.duration) ? c.duration : 0;
    return checkRange(req.start, req.end, duration, c.maxSec);
  }
  if (c.ended) return '视频已经播完了：拖回想录的位置再开始';
  return undefined;
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
  'video-changed': '切到了别的视频，这一段已结束',
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
  // 时间段：已经录到东西、又到了终点（含拖过终点、播完）就结束
  if (range && c.recordedSec > 0 && (s.currentTime >= c.end! || s.ended)) return { kind: 'stop', reason: 'range-end' };
  if (!range && s.ended) return { kind: 'stop', reason: 'ended' };
  if (c.userPaused) return { kind: 'wait', why: 'user' };
  if (s.ad) return { kind: 'wait', why: 'ad' };
  if (!s.visible) return { kind: 'wait', why: 'hidden' };
  if (s.seeking || !s.ready) return { kind: 'wait', why: 'seeking' };
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
}

export interface BurnBox {
  text: string;
  tone: BurnLine['tone'];
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
  const rows: { text: string; tone: BurnLine['tone']; fontPx: number }[] = [];
  for (const l of lines) {
    const fontPx = l.tone === 'translation' ? base * 0.88 : base;
    for (const t of wrapText(l.text, maxText, fontPx, measure)) rows.push({ text: t, tone: l.tone, fontPx });
  }
  const boxes: BurnBox[] = [];
  let bottom = height - Math.max(12, height * 0.06);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    const h = r.fontPx * 1.4;
    const w = Math.min(width * 0.94, measure(r.text, r.fontPx) + padX * 2);
    const y = bottom - h;
    if (y < 0) break; // 画面放不下的更早的行不画
    boxes.unshift({ text: r.text, tone: r.tone, fontPx: r.fontPx, x: (width - w) / 2, y, w, h, cx: width / 2, cy: y + h / 2 });
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
  videoId: string | null;
  /** 视频标题（页面标题去掉" - YouTube"，只用来显示和起文件名） */
  title?: string;
  /** 不能录的原因（不是视频页、Shorts、设置里关了） */
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
  videoId: string;
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

/** 校验内容脚本送来的记录（来自网页环境，字段逐一检查、截断） */
export function sanitizeClipRecord(raw: unknown): ClipRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
  const id = str(r.id, 64);
  const videoId = typeof r.videoId === 'string' && VIDEO_ID.test(r.videoId) ? r.videoId : null;
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
  return { id, videoId, ...(title ? { title } : {}), mode, start, end, durationSec, bytes, format, fileName, burned: r.burned === true, savedAt };
}

/** 新记录放最前；同一个片段再存一次只更新时间；最多保留 max 条 */
export function addClipRecord(log: ClipRecord[], rec: ClipRecord, max: number = CLIPS.logMax): ClipRecord[] {
  return [rec, ...log.filter((r) => r.id !== rec.id)].slice(0, max);
}

/** 回到视频里这一段的地址 */
export function clipWatchUrl(r: Pick<ClipRecord, 'videoId' | 'start'>): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(r.videoId)}&t=${Math.floor(r.start)}s`;
}
