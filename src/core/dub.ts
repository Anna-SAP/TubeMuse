// 中文配音（用户 2026-11-13 要求，见 DECISIONS §74、§75）的纯逻辑：配音记录、对齐点与分段、跟随判定、原声降音量、偏移与时长的说法、m4a 的检查。
// 配音是重新录制的克隆音频，时长和原视频不完全一致：同步只做"跟随播放状态 + 你手动设的偏移 / 对齐点"，不做、也不假装做逐句 / 逐词对齐。
// 对齐点（§75，手测后用户要求）：你在几处标"视频这一刻 ↔ 中文这一刻"，把全程分成几段，每段有自己的偏移；
// 一段里中文按正常速度放，中文先说完就停下等画面，中文说得慢就在下一个对齐点跳过去。
// 播放与降音量在 content/dub.ts（YouTube 播放页）；音频文件在扩展自己的 IndexedDB（services/dub-store.ts），由后台分块交给页面里的脚本。

import { DUB } from '../config/defaults';

/** 侧边栏 / 后台 ↔ 配音脚本的消息类型 */
export const DUB_MSG = {
  getState: 'tubemuse:dub:get-state',
  /** 配音脚本主动推送的状态变化 */
  state: 'tubemuse:dub:state',
  /** 侧边栏 → 配音脚本：开 / 关这个视频的配音（{ on?: boolean }） */
  toggle: 'tubemuse:dub:toggle',
  /**
   * 侧边栏 → 配音脚本：拖动"中文位置"时的实时偏移（不存；松手后侧边栏存进本机，脚本从存储里读到）。
   * { videoId, segment, offset } 或 { videoId, segment, dubAt }（让此刻放中文的 dubAt 秒处，由脚本按此刻的视频位置算出偏移）
   */
  setDelay: 'tubemuse:dub:set-delay',
  /** 侧边栏 → 配音脚本：此刻的视频位置与中文位置（加对齐点用），回复 DubMark */
  mark: 'tubemuse:dub:mark',
  /** 配音脚本 → 后台：工具栏图标上的"中" */
  badge: 'tubemuse:dub:badge',
} as const;

/** 配音脚本 → 后台：要这个视频的配音音频（长连接，后台分块回传） */
export const DUB_PORT = 'tubemuse:dub-audio';

/** 一个视频关联的中文配音（只有元数据；音频本身在 IndexedDB，按 fileId 存） */
export interface DubRecord {
  videoId: string;
  /** IndexedDB 里音频的键 */
  fileId: string;
  fileName: string;
  /** 字节数 */
  size: number;
  mime: string;
  /** 文件里写的时长（秒）；读不出来时为空 */
  durationSec?: number;
  /** 关联时原视频的时长（秒），用来对比两者的长度 */
  videoDurationSec?: number;
  /** 关联时的视频标题（页面标题），列表里显示 */
  title?: string;
  /** 开头那一段（第一个对齐点之前）的偏移：中文推后多少秒（负数 = 提前），配音位置 = 视频位置 − delaySec */
  delaySec: number;
  /** 对齐点（按视频时间排好；§75）：从每个对齐点起，配音位置 = 视频位置 − (video − dub) */
  anchors?: DubAnchor[];
  addedAt: number;
}

/** 对齐点：视频的这一刻对应中文的这一刻（秒） */
export interface DubAnchor {
  video: number;
  dub: number;
}

/** 跟随用的对齐信息：开头的偏移 + 对齐点 */
export interface DubMap {
  delaySec: number;
  anchors: readonly DubAnchor[];
}

/** 视频 ID → 配音 */
export type DubIndex = Record<string, DubRecord>;

const VIDEO_ID_RE = /^[\w-]{6,20}$/;
const FILE_ID_RE = /^dub_[\w]{4,40}$/;

export const isDubVideoId = (x: unknown): x is string => typeof x === 'string' && VIDEO_ID_RE.test(x);
export const isDubFileId = (x: unknown): x is string => typeof x === 'string' && FILE_ID_RE.test(x);

const finitePos = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined);
const text = (x: unknown, max: number): string => (typeof x === 'string' ? x.trim().slice(0, max) : '');

/** 偏移：限制在范围内，按 0.1 秒取整 */
export function clampDelay(x: unknown): number {
  const n = typeof x === 'number' && Number.isFinite(x) ? x : 0;
  const c = Math.max(-DUB.maxDelaySec, Math.min(DUB.maxDelaySec, n));
  const r = Math.round(c / DUB.delayStepSec) * DUB.delayStepSec;
  // 去掉 -0 与浮点尾巴（0.30000000000000004）
  return Number(r.toFixed(1)) || 0;
}

/** 读存储时校验每一条：坏掉的丢弃（存储被手改、旧版本格式） */
export function sanitizeDubIndex(v: unknown): DubIndex {
  const out: DubIndex = {};
  if (!v || typeof v !== 'object') return out;
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    const r = raw as Partial<DubRecord> | undefined;
    if (!r || typeof r !== 'object' || !isDubVideoId(key) || r.videoId !== key || !isDubFileId(r.fileId)) continue;
    const size = finitePos(r.size);
    if (!size) continue;
    const rec: DubRecord = {
      videoId: key,
      fileId: r.fileId,
      fileName: text(r.fileName, DUB.fileNameMaxChars) || '配音.m4a',
      size,
      mime: text(r.mime, 60) || 'audio/mp4',
      delaySec: clampDelay(r.delaySec),
      addedAt: typeof r.addedAt === 'number' && Number.isFinite(r.addedAt) ? r.addedAt : 0,
    };
    const d = finitePos(r.durationSec);
    if (d) rec.durationSec = d;
    const vd = finitePos(r.videoDurationSec);
    if (vd) rec.videoDurationSec = vd;
    const title = text(r.title, DUB.titleMaxChars);
    if (title) rec.title = title;
    const anchors = sanitizeAnchors(r.anchors);
    if (anchors.length) rec.anchors = anchors;
    out[key] = rec;
  }
  return out;
}

// ── 对齐点 ──

const roundAnchor = (x: number) => Math.round(x / DUB.anchorPrecisionSec) * DUB.anchorPrecisionSec;
const tidy = (x: number) => Number(roundAnchor(x).toFixed(2)) || 0;

/** 读存储时：只留数字对的、按视频时间排好、太近的合并（留后面那个），最多 maxAnchors 个 */
export function sanitizeAnchors(v: unknown): DubAnchor[] {
  if (!Array.isArray(v)) return [];
  let out: DubAnchor[] = [];
  for (const a of v) {
    const x = a as Partial<DubAnchor> | undefined;
    if (!x || typeof x.video !== 'number' || typeof x.dub !== 'number' || !Number.isFinite(x.video) || !Number.isFinite(x.dub)) continue;
    if (x.video <= 0 || x.video > DUB.maxDelaySec * 4 || x.dub < 0 || x.dub > DUB.maxDelaySec * 4) continue;
    out = withAnchor(out, { video: x.video, dub: x.dub });
  }
  return out.slice(0, DUB.maxAnchors);
}

/** 加一个对齐点：离已有的不到 anchorMergeSec 时替换它；保持按视频时间排好 */
export function withAnchor(anchors: readonly DubAnchor[], a: DubAnchor): DubAnchor[] {
  const next = { video: tidy(a.video), dub: Math.max(0, tidy(a.dub)) };
  return [...anchors.filter((x) => Math.abs(x.video - next.video) >= DUB.anchorMergeSec), next].sort((x, y) => x.video - y.video);
}

export function dubMapOf(rec: Pick<DubRecord, 'delaySec' | 'anchors'>): DubMap {
  return { delaySec: rec.delaySec, anchors: rec.anchors ?? [] };
}

/** 一段：从 fromVideo 起，中文位置 = 视频位置 − offset；到 nextVideo 换下一段。这一段的中文到 dubEnd 为止（下一个对齐点的中文位置） */
export interface DubSegment {
  /** −1 = 开头那一段（第一个对齐点之前，偏移就是 delaySec）；k = 第 k 个对齐点（从 0 数）之后那一段 */
  index: number;
  fromVideo: number;
  /** 正 = 中文推后（比画面晚），负 = 中文提前 */
  offset: number;
  nextVideo?: number;
  dubEnd?: number;
}

/** 视频的 t 秒落在哪一段 */
export function dubSegmentAt(map: DubMap, t: number): DubSegment {
  let i = -1;
  for (let k = 0; k < map.anchors.length; k++) {
    if (map.anchors[k]!.video <= t) i = k;
    else break;
  }
  const a = i >= 0 ? map.anchors[i]! : undefined;
  const next = map.anchors[i + 1];
  return {
    index: i,
    fromVideo: a ? a.video : 0,
    offset: a ? Number((a.video - a.dub).toFixed(2)) : map.delaySec,
    ...(next ? { nextVideo: next.video, dubEnd: next.dub } : {}),
  };
}

/** 改某一段的偏移：开头那段改 delaySec；第 k 段改第 k 个对齐点的中文位置（视频位置不动） */
export function withSegmentOffset(map: DubMap, index: number, offset: number): DubMap {
  if (index < 0 || index >= map.anchors.length) return { delaySec: clampDelay(offset), anchors: [...map.anchors] };
  const anchors = map.anchors.map((a, k) => (k === index ? { video: a.video, dub: Math.max(0, tidy(a.video - clampDelay(offset))) } : a));
  return { delaySec: map.delaySec, anchors };
}

/** 前后颠倒的对齐点（中文位置不比前一个靠后）：这几个之前那一段的中文会被整段跳过或重放，界面上标出来 */
export function misorderedAnchors(map: DubMap): number[] {
  const bad: number[] = [];
  let prev = Math.max(0, -map.delaySec);
  map.anchors.forEach((a, k) => {
    if (a.dub <= prev) bad.push(k);
    prev = a.dub;
  });
  return bad;
}

// ── 选文件 ──

export class DubFileError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'DubFileError';
  }
}

/** 只收 .m4a（MP4 容器里的音频）：看扩展名或浏览器给的类型，内容另由 probeM4a 检查 */
export function checkDubFile(name: string, type: string, size: number): void {
  const okName = /\.m4a$/i.test(name);
  const okType = /^audio\/(mp4|x-m4a|m4a|aac)$/i.test(type);
  if (!okName && !okType) throw new DubFileError(`"${name}" 不是 .m4a 文件`, '中文配音只收 .m4a 音频文件。');
  if (size <= 0) throw new DubFileError(`"${name}" 是空文件`);
  if (size > DUB.maxFileBytes) {
    throw new DubFileError(`"${name}" 太大（${formatBytes(size)}）`, `最大 ${formatBytes(DUB.maxFileBytes)}：开启配音时整份文件要载入那个标签页的内存。`);
  }
}

/** 读文件的 [start, end)；越界部分截掉 */
export type BlobRead = (start: number, end: number) => Promise<Uint8Array>;

export interface M4aProbe {
  /** 文件里写的时长（秒）；分片格式可能写 0，这时为空 */
  durationSec?: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

interface Box {
  type: string;
  body: number;
  end: number;
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    const type = tag(b, o + 4);
    let body = o + 8;
    if (size === 1) {
      if (o + 16 > end) return;
      size = u64(b, o + 8);
      body = o + 16;
    } else if (size === 0) size = end - o;
    if (size < body - o || o + size > end) return;
    yield { type, body, end: o + size };
    o += size;
  }
}

const child = (b: Uint8Array, parent: Box, type: string) => {
  for (const x of boxes(b, parent.body, parent.end)) if (x.type === type) return x;
  return undefined;
};

/**
 * 认出 m4a 并读出时长：开头要有 ftyp；找到 moov（可能在文件末尾，只读盒子头和 moov 本身），
 * 读 mvhd 的时长（分片格式写 0 时看 mehd），再看有没有声音轨。不是 m4a、没有声音轨时抛 DubFileError。
 */
export async function probeM4a(read: BlobRead, total: number): Promise<M4aProbe> {
  const notM4a = new DubFileError('这个文件不是 m4a 音频', '文件开头没有 MP4 的标记（ftyp）。中文配音只收 .m4a 文件，改了扩展名的别的格式也不行。');
  const head = await read(0, Math.min(total, 64 * 1024));
  if (head.length < 16 || tag(head, 4) !== 'ftyp') throw notM4a;
  let o = 0;
  for (let guard = 0; guard < 256 && o + 8 <= total; guard++) {
    const h = o + 16 <= head.length ? head.subarray(o, o + 16) : await read(o, Math.min(total, o + 16));
    if (h.length < 8) break;
    let size = u32(h, 0);
    const type = tag(h, 4);
    if (size === 1) size = h.length >= 16 ? u64(h, 8) : 0;
    else if (size === 0) size = total - o;
    if (size < 8) throw new DubFileError('m4a 的结构不对，读不出来', '文件可能没写完或已损坏：重新导出一份再试。');
    if (type === 'moov') {
      if (size > DUB.maxMoovBytes) throw new DubFileError('m4a 的索引太大，读不出来');
      const moov = await read(o, o + size);
      if (moov.length < size) throw new DubFileError('m4a 的索引没读全', '文件可能没写完：重新导出一份再试。');
      return probeMoov(moov);
    }
    o += size;
  }
  throw new DubFileError('m4a 文件里没找到索引（moov）', '文件可能没写完或已损坏：重新导出一份再试。');
}

function probeMoov(moov: Uint8Array): M4aProbe {
  const root: Box = { type: 'root', body: 0, end: moov.length };
  const mv = child(moov, root, 'moov');
  if (!mv) throw new DubFileError('m4a 文件里没找到索引（moov）');
  let durationSec: number | undefined;
  const mvhd = child(moov, mv, 'mvhd');
  if (mvhd) {
    const v = moov[mvhd.body]!;
    const timescale = v === 1 ? u32(moov, mvhd.body + 20) : u32(moov, mvhd.body + 12);
    const duration = v === 1 ? u64(moov, mvhd.body + 24) : u32(moov, mvhd.body + 16);
    if (timescale > 0 && duration > 0 && duration !== 0xffffffff) durationSec = duration / timescale;
    // 分片 MP4：mvhd 写 0，总时长在 mvex/mehd
    const mehd = durationSec === undefined ? (() => { const mvex = child(moov, mv, 'mvex'); return mvex ? child(moov, mvex, 'mehd') : undefined; })() : undefined;
    if (mehd && timescale > 0) {
      const ev = moov[mehd.body]!;
      const d = ev === 1 ? u64(moov, mehd.body + 4) : u32(moov, mehd.body + 4);
      if (d > 0) durationSec = d / timescale;
    }
  }
  let hasAudio = false;
  let hasVideo = false;
  for (const trak of boxes(moov, mv.body, mv.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    const kind = hdlr && hdlr.body + 12 <= hdlr.end ? tag(moov, hdlr.body + 8) : '';
    if (kind === 'soun') hasAudio = true;
    if (kind === 'vide') hasVideo = true;
  }
  if (!hasAudio) throw new DubFileError('这个 m4a 里没有声音', '文件里没有音轨。');
  return { ...(durationSec !== undefined ? { durationSec: Math.round(durationSec * 1000) / 1000 } : {}), hasAudio, hasVideo };
}

// ── 跟随 ──

/** 视频此刻的样子（YouTube 播放器里的 <video>） */
export interface DubVideoSample {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  /** readyState ≥ HAVE_FUTURE_DATA：不在缓冲 */
  canPlay: boolean;
  rate: number;
  /** 正在放广告（广告和正片在同一个播放器里） */
  ad: boolean;
}

/** 配音此刻的样子（配音脚本自己的 <audio>，不放进页面） */
export interface DubAudioSample {
  currentTime: number;
  paused: boolean;
  /** 读不出时长时为 NaN */
  duration: number;
  rate: number;
}

export type DubReason = 'playing' | 'paused' | 'seeking' | 'buffering' | 'ad' | 'ended' | 'before-start' | 'after-end' | 'segment-end';

export interface DubStep {
  play: boolean;
  /** 要把配音跳到这里（秒） */
  seekTo?: number;
  /** 要把配音的倍速改成这个 */
  rate?: number;
  reason: DubReason;
  /** 配音此刻应在的位置（视频位置 − 这一段的偏移） */
  target: number;
  segment: DubSegment;
  /** 视频再放这么多秒，跟随要换个做法（这一段中文说完、到下一个对齐点）：到时候立刻再检查一次，不等下一次例行检查 */
  wakeIn?: number;
}

/**
 * 跟随：找出视频此刻落在哪一段，配音位置 = 视频位置 − 这一段的偏移。视频在放（不在缓冲、不在跳转、不是广告）且这个位置落在配音里时放，否则停；
 * 两边差过 resyncSec 就把配音拉回来；倍速跟着视频。
 * 有对齐点时：这一段的中文到下一个对齐点的中文位置为止——中文先说完就停在那里等画面，视频到了下一个对齐点再接着放；
 * 中文说得慢、视频先到了下一个对齐点，就跳到下一段的位置（两边差过 resyncSec 的那一下）。
 * 不做逐句对齐：两段录音的语速、停顿本来就不一样，对齐点之间中文始终按正常速度放。
 */
export function dubStep(v: DubVideoSample, a: DubAudioSample, map: DubMap, resyncSec: number = DUB.resyncSec): DubStep {
  const segment = dubSegmentAt(map, v.currentTime);
  const target = v.currentTime - segment.offset;
  const stop = (reason: DubReason, seekTo?: number, wakeIn?: number): DubStep => ({
    play: false,
    reason,
    target,
    segment,
    ...(seekTo !== undefined ? { seekTo } : {}),
    ...(wakeIn !== undefined ? { wakeIn } : {}),
  });
  if (v.ad) return stop('ad');
  if (v.seeking) return stop('seeking');
  if (v.ended) return stop('ended');
  if (target < 0) return stop('before-start', a.currentTime > 0.05 ? 0 : undefined, v.paused ? undefined : -target);
  const toNext = segment.nextVideo !== undefined ? segment.nextVideo - v.currentTime : undefined;
  if (segment.dubEnd !== undefined && target >= segment.dubEnd) {
    // 这一段中文已经说完：停在这一段的末尾等画面（视频到下一个对齐点时正好从这里接着放）
    const end = Number.isFinite(a.duration) ? Math.min(segment.dubEnd, a.duration) : segment.dubEnd;
    return stop('segment-end', Math.abs(a.currentTime - end) > resyncSec ? end : undefined, v.paused ? undefined : toNext);
  }
  if (Number.isFinite(a.duration) && target >= a.duration) return stop('after-end');
  const off = Math.abs(a.currentTime - target);
  // 停着的时候也把位置对好：一放就是对的
  if (v.paused) return stop('paused', off > resyncSec ? target : undefined);
  if (!v.canPlay) return stop('buffering', off > resyncSec ? target : undefined);
  const step: DubStep = { play: true, reason: 'playing', target, segment };
  if (off > (a.paused ? DUB.startAlignSec : resyncSec)) step.seekTo = target;
  if (Math.abs(a.rate - v.rate) > 1e-3) step.rate = v.rate;
  const toEnd = segment.dubEnd !== undefined ? segment.dubEnd - target : undefined;
  const wake = [toEnd, toNext].filter((x): x is number => x !== undefined && x > 0);
  if (wake.length) step.wakeIn = Math.min(...wake);
  return step;
}

/** 跟随状态的说法（segment：视频此刻所在的那一段） */
export function dubReasonText(reason: DubReason, segment: Pick<DubSegment, 'offset' | 'nextVideo'>): string {
  switch (reason) {
    case 'playing':
      return '配音播放中，跟着视频走';
    case 'paused':
      return '视频暂停，配音跟着暂停';
    case 'seeking':
      return '正在跳转，配音等视频';
    case 'buffering':
      return '视频在缓冲，配音等它';
    case 'ad':
      return '正在放广告：配音暂停，原声恢复原来的音量';
    case 'ended':
      return '视频放完了';
    case 'before-start':
      return `中文还没开始：按偏移，视频放到 ${formatClockSec(segment.offset)} 时中文才开始`;
    case 'after-end':
      return '中文已经放完了（原视频比中文长）';
    case 'segment-end':
      return segment.nextVideo !== undefined
        ? `中文这一段已经说完，等画面到 ${formatClockSec(segment.nextVideo)} 的对齐点再接着放（这时听到的是原声）`
        : '中文这一段已经说完';
  }
}

// ── 原声降音量 ──

/**
 * 配音开启时把原声降到你的音量的 80%，关闭时恢复。不经过 YouTube 的音量设置：直接改 <video> 的音量，
 * 所以要分清"我们改的"和"你（或 YouTube）改的"——后者记成你的新音量，再按它降。
 * YouTube 一再把音量改回原值时（来回抢），停手并说明，不跟它抢。
 */
export class VolumeDuck {
  /** 你的音量（不是我们写进去的那个） */
  private base: number | undefined;
  /** 我们最近一次写进去的降低后的音量；没在降时为空 */
  private written: number | undefined;
  private reverts: number[] = [];
  private blockedFlag = false;

  constructor(
    readonly ratio: number = DUB.originalVolume,
    private readonly eps: number = DUB.volumeEps,
  ) {}

  /** 看一眼视频现在的音量：不是我们写的，就是你（或 YouTube）改的，记成你的新音量 */
  sync(volume: number, now: number): void {
    if (this.written !== undefined) {
      if (Math.abs(volume - this.written) <= this.eps) return;
      // 降着的时候被改回了原值：多半是 YouTube 自己恢复它记着的音量
      if (this.base !== undefined && Math.abs(volume - this.base) <= this.eps) {
        this.reverts = [...this.reverts.filter((t) => now - t < DUB.revertWindowMs), now];
        if (this.reverts.length >= DUB.maxVolumeReverts) this.blockedFlag = true;
      }
      this.written = undefined;
    }
    this.base = volume;
  }

  /**
   * 此刻要把视频音量设成多少（undefined = 不动）。duck：配音在开着且不是广告。
   * 返回值写进视频后要调 wrote()。
   */
  target(duck: boolean): number | undefined {
    if (this.base === undefined) return undefined;
    if (duck && !this.blockedFlag) {
      const t = Math.round(this.base * this.ratio * 1000) / 1000;
      return this.written !== undefined && Math.abs(this.written - t) <= this.eps ? undefined : t;
    }
    // 不降（或被挡住）：之前降过就恢复
    return this.written !== undefined ? this.base : undefined;
  }

  /** 已把音量设成了 value */
  wrote(value: number): void {
    this.written = this.base !== undefined && Math.abs(value - this.base) <= this.eps ? undefined : value;
  }

  /** 现在是不是降着 */
  get ducked(): boolean {
    return this.written !== undefined;
  }

  get blocked(): boolean {
    return this.blockedFlag;
  }

  /** 你的音量 */
  get userVolume(): number | undefined {
    return this.base;
  }

  /** 换视频、重新开启：重新开始（之前被挡住的也再试一次） */
  reset(): void {
    this.base = undefined;
    this.written = undefined;
    this.reverts = [];
    this.blockedFlag = false;
  }
}

// ── 说法 ──

/** 1:04:02、3:05、0:42 */
export function formatClockSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** 1.5 秒、13 秒、2 分 05 秒 */
export function formatSeconds(sec: number): string {
  const s = Math.abs(sec);
  if (s < 60) return `${Number(s.toFixed(1))} 秒`;
  const r = Math.round(s);
  return `${Math.floor(r / 60)} 分 ${String(r % 60).padStart(2, '0')} 秒`;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** 开头那一段偏移的说法 */
export function delayText(delaySec: number): string {
  const d = clampDelay(delaySec);
  if (d === 0) return '不偏移：中文从视频开头一起开始';
  return d > 0 ? `中文推后 ${formatSeconds(d)}：视频放到 ${formatClockSec(d)} 时中文才开始` : `中文提前 ${formatSeconds(d)}：跳过中文开头的 ${formatSeconds(d)}`;
}

/** 某一段偏移的说法：开头那段沿用 delayText；对齐点之后的说"中文比画面晚 / 早多少" */
export function segmentOffsetText(segment: Pick<DubSegment, 'index' | 'offset'>): string {
  if (segment.index < 0) return delayText(segment.offset);
  const d = Number(segment.offset.toFixed(1)) || 0;
  if (d === 0) return '这一段中文和画面同步（偏移 0）';
  return d > 0 ? `这一段中文比画面晚 ${formatSeconds(d)}` : `这一段中文比画面早 ${formatSeconds(d)}`;
}

/**
 * 两者长度的对比。差得不多时如实说"对齐开头后越往后可能差得越多"，不承诺逐句对齐。
 * 例：中文 1:04:02、原视频 1:03:49 → 中文长 13 秒。
 */
export function durationNote(dubSec: number | undefined, videoSec: number | undefined): string | undefined {
  if (!dubSec || !videoSec) return undefined;
  const diff = Math.round(dubSec - videoSec);
  const both = `中文 ${formatClockSec(dubSec)} · 原视频 ${formatClockSec(videoSec)}`;
  if (Math.abs(diff) < 1) return `${both}：长度一样。`;
  const longer = diff > 0 ? `中文长 ${formatSeconds(diff)}` : `中文短 ${formatSeconds(diff)}`;
  return `${both}，${longer}。两段是分别录的，语速和停顿不一样（中文还可能删掉了一些段落）：对齐开头后越往后差得越多——在对不上的地方加对齐点，从那里起单独调。`;
}

// ── 配音脚本的状态（交给侧边栏）──

export type DubPhase = 'disabled' | 'none' | 'off' | 'loading' | 'ready' | 'error';

export interface DubTabState {
  videoId: string | null;
  /** 设置里有没有启用中文配音 */
  enabled: boolean;
  /** 这个视频有没有关联配音 */
  available: boolean;
  fileName?: string;
  /** 你在这个标签页里开启了这个视频的配音 */
  active: boolean;
  phase: DubPhase;
  status: string;
  /** 载入进度（0–1） */
  progress?: number;
  /** 配音此刻在不在出声 */
  playing: boolean;
  /** 页面标题（关联时记下，列表里显示） */
  title?: string;
  videoTime?: number;
  videoDuration?: number;
  dubTime?: number;
  dubDuration?: number;
  /** 视频此刻所在那一段的偏移（拖动"中文位置"时是实时值） */
  delaySec?: number;
  /** 视频此刻所在的那一段（拖动"中文位置"时已算上实时值）；count：一共几个对齐点 */
  segment?: DubSegment & { count: number };
  /** 此刻中文应在的位置（视频位置 − 这一段的偏移） */
  target?: number;
  /** 原声：你的音量、现在的音量、是不是降着、YouTube 是否把它改回去了 */
  volume?: { user: number; now: number; ducked: boolean; blocked: boolean; muted: boolean };
  error?: { message: string; hint?: string };
}

/** 配音脚本 → 侧边栏：此刻的视频位置与中文位置（加对齐点用） */
export interface DubMark {
  video: number;
  dub: number;
}

/** 后台 → 配音脚本：音频分块 */
export type DubPortReply =
  | { type: 'meta'; size: number; mime: string }
  | { type: 'chunk'; data: string }
  | { type: 'done' }
  | { type: 'error'; message: string; hint?: string };

/** 配音脚本 → 后台：要哪个视频的哪个文件 */
export interface DubPortRequest {
  type: 'open';
  videoId: string;
  fileId: string;
}

export function isDubPortRequest(x: unknown): x is DubPortRequest {
  const m = x as Partial<DubPortRequest> | undefined;
  return !!m && m.type === 'open' && isDubVideoId(m.videoId) && isDubFileId(m.fileId);
}

/** 页面标题去掉" - YouTube"和前面的未读数"(3) " */
export function cleanVideoTitle(title: string): string {
  return title
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s*-\s*YouTube\s*$/i, '')
    .trim()
    .slice(0, DUB.titleMaxChars);
}
