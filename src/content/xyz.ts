// 注入小宇宙网页版（www.xiaoyuzhoufm.com）的脚本（用户 2026-11-13 要求，见 DECISIONS §72）。只在单集页 /episode/<ID> 上工作：
// 1. 读这一集的信息：标题、节目名、封面、音频地址、时长、发布时间、节目简介（只用来让大模型校对人名和术语）、节目主题色。
//    不读评论、不读别的单集。读的是页面上已有的内容与页面自带的数据（__NEXT_DATA__），不发网络请求（构建时检查）。
// 2. 字幕：你开启后，向扩展后台要这一集音频的一段一段（后台只读小宇宙 CDN 上的公开音频文件），在本机解码、按停顿切句，
//    交给后台转写、校对 / 翻译；在页面底部播放器上方叠加一层只读字幕（Shadow DOM，只用 textContent 写字，可关闭）。
//    页面上的 <audio> 是跨站的，浏览器不让取它的声音（captureStream 报 SecurityError，2026-11-13 实测）——所以不从播放器取声音。
// 3. 快照：侧边栏选好片段时，在播放器进度条上方标出起止（同一层 Shadow DOM 里，不改动小宇宙的元素）；
//    你点"试听"时把播放位置跳到起点并播放，到终点暂停——只在你点的时候。
// 4. 收听记录：只看 <audio> 的播放状态（进度、暂停、倍速），累计成会话交给后台。
// 不点击、不模拟点击小宇宙的任何按钮（不替你订阅、收藏、点赞、评论），不读写 Cookie 和页面的本地存储。

import { DEFAULT_SETTINGS, SUBTITLES, WATCH, XYZ } from '../config/defaults';
import { DEFAULT_SEGMENTER, LiveTranscript, Segmenter, base64ToBytes, bytesToBase64, encodeWav, speechErrorInfo, type AudioSegment, type LiveLine } from '../core/subtitles';
import { stepTracker, type PlaybackSample, type TrackerState } from '../core/watch';
import {
  XYZ_MSG,
  XYZ_PORT,
  cueLines,
  formatXyzTime,
  isXyzDisplay,
  isXyzId,
  mergeDone,
  nextGap,
  pickXyzCue,
  upsertXyzCue,
  xyzEpisodeId,
  xyzPodcastIdFromHref,
  type XyzCue,
  type XyzDisplay,
  type XyzEpisodeInfo,
  type XyzTabState,
} from '../core/xyz';
import type { XyzAudioInfo, XyzDown } from '../services/xyz-service';
import type { WatchSession } from '../core/types';
import type { RecognitionLike } from '../services/speech';
import { speechRecognitionCtor } from './speech-engine';
import { IS_FIREFOX, SPEECH_PLATFORM } from '../platform';

type XyzSettings = typeof DEFAULT_SETTINGS.xyz;

const TICK_MS = 400;
const NOTICE_MS = 6_000;
/** 致命错误（没有 Key、预算用完）后停下，过这么久或你改了设置再试 */
const FATAL_RETRY_MS = 5 * 60_000;
const SEEK_MODEL = IS_FIREFOX ? 'firefox' : 'chrome';

let settings: XyzSettings = { ...DEFAULT_SETTINGS.xyz };
let settingsLoaded = false;
let autoStartedFor: string | undefined;

// ── 读页面 ──

function alive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function audioEl(): HTMLAudioElement | null {
  const inPlayer = document.querySelector('section[aria-label="播放器"] audio');
  return (inPlayer ?? document.querySelector('audio')) as HTMLAudioElement | null;
}

function playerEl(): HTMLElement | null {
  return (document.querySelector('section[aria-label="播放器"]') as HTMLElement | null) ?? (audioEl()?.parentElement as HTMLElement | null) ?? null;
}

function text(sel: string): string {
  return (document.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function meta(prop: string): string {
  return (document.querySelector(`meta[property="${prop}"]`) as HTMLMetaElement | null)?.content ?? '';
}

/** 页面自带的数据（Next.js 的 __NEXT_DATA__）：只认属于这一集的那份（站内跳转后它不更新，那时以页面上显示的为准） */
let nextCache: { eid: string; ep: Record<string, unknown> | null } | undefined;
function nextEpisode(eid: string): Record<string, unknown> | null {
  if (nextCache?.eid === eid) return nextCache.ep;
  let ep: Record<string, unknown> | null = null;
  try {
    const raw = document.getElementById('__NEXT_DATA__')?.textContent;
    const data = raw ? (JSON.parse(raw) as { props?: { pageProps?: { episode?: Record<string, unknown> } }; query?: { id?: unknown } }) : undefined;
    const e = data?.props?.pageProps?.episode;
    if (e && e.eid === eid) ep = e;
  } catch {
    ep = null;
  }
  nextCache = { eid, ep };
  return ep;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function parseClock(s: string): number | undefined {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
}

/** 这一集的信息（页面上显示的优先，页面数据补充）；不是单集页时 undefined */
function readInfo(eid: string): XyzEpisodeInfo {
  const ep = nextEpisode(eid);
  const pod = obj(ep?.podcast);
  const podLink = document.querySelector('.podcast-title a[href*="/podcast/"]') as HTMLAnchorElement | null;
  const audio = audioEl();
  const media = obj(obj(ep?.media).source);
  const audioUrl = (audio?.currentSrc || audio?.getAttribute('src') || '') || meta('og:audio') || str(obj(ep?.enclosure).url) || str(media.url);
  const notesEl = document.querySelector('section[aria-label*="show notes" i] article, section[aria-label*="show notes" i]');
  const domDuration = parseClock(text('section[aria-label="播放器"] .label.right'));
  const coverImg = (document.querySelector('header img.avatar') as HTMLImageElement | null)?.src;
  const image = obj(pod.image);
  return {
    eid,
    title: text('header h1') || str(ep?.title) || meta('og:title'),
    podcastTitle: (podLink?.textContent ?? '').trim() || str(pod.title),
    ...((podLink && xyzPodcastIdFromHref(podLink.getAttribute('href') ?? '')) || isXyzId(pod.pid) ? { pid: (podLink && xyzPodcastIdFromHref(podLink.getAttribute('href') ?? '')) || str(pod.pid) } : {}),
    ...(coverImg || meta('og:image') || str(image.smallPicUrl) ? { cover: coverImg || meta('og:image') || str(image.smallPicUrl) } : {}),
    ...(audioUrl ? { audioUrl } : {}),
    ...((typeof ep?.duration === 'number' && ep.duration > 0) || (audio && Number.isFinite(audio.duration) && audio.duration > 0) || domDuration
      ? { duration: typeof ep?.duration === 'number' && ep.duration > 0 ? ep.duration : audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : domDuration! }
      : {}),
    ...((document.querySelector('header time[datetime]') as HTMLTimeElement | null)?.dateTime || str(ep?.pubDate) ? { pubDate: (document.querySelector('header time[datetime]') as HTMLTimeElement | null)?.dateTime || str(ep?.pubDate) } : {}),
    ...(str(ep?.description) || notesEl?.textContent ? { showNotes: (str(ep?.description) || notesEl?.textContent || '').slice(0, XYZ.showNotesMaxChars) } : {}),
    ...(str(obj(pod.color).original) ? { color: str(obj(pod.color).original) } : {}),
  };
}

// ── 状态 ──

interface WindowJob {
  from: number;
  to: number;
  seqs: Set<number>;
}

interface Feed {
  ac: AudioContext;
  dest: MediaStreamAudioDestinationNode;
  rec?: RecognitionLike;
  transcript: LiveTranscript;
  /** 已经排进播放的声音：在 AudioContext 时间轴上的起点、对应的真实时间与长度 */
  pieces: { acStart: number; trueStart: number; dur: number; from: number; to: number; source: AudioBufferSourceNode }[];
  /** 下一段声音接在 AudioContext 的这个时刻 */
  nextAt: number;
  /** 下一段要读的真实时间 */
  nextTrue: number;
  restartAt: number;
  failures: number;
  sessionStartedAt: number;
  resultIndex: number;
  mode?: 'local' | 'cloud';
  localFailed?: boolean;
}

interface Session {
  eid: string;
  info: XyzEpisodeInfo;
  port?: chrome.runtime.Port;
  cues: XyzCue[];
  done: [number, number][];
  /** 正在处理（音频已读、句子在转写）的时间段：不再重复读 */
  working: Map<number, WindowJob>;
  audio?: XyzAudioInfo;
  audioError?: { message: string; hint?: string };
  connected: boolean;
  /** 等着回复的读音频请求 */
  windowReq?: { reqId: number; from: number; to: number; at: number; gap: number };
  /** 跳转后页面时间 ≠ 真实时间（可变码率 mp3）：最近一次跳转的目标与差值 */
  seekTarget?: number;
  offset?: number;
  offsetFor?: number | 'none';
  offsetAsked?: number | 'none';
  scanned?: number;
  scanAsked?: boolean;
  /** 第一次读、或跳转后第一次读：读短一点，字幕出得快 */
  fresh: boolean;
  pendingSeqs: Set<number>;
  /** 切好、还没送出的句子（同时在途的转写不超过 maxInFlight） */
  queue: { seq: number; start: number; end: number; audio: string }[];
  waitUntil: number;
  feed?: Feed;
}

let eid: string | null = null;
let s: Session | undefined;
/** 你对每一集的选择（只在这个标签页里记住） */
const manual = new Map<string, boolean>();
let whole = false;
let fatal: { message: string; hint?: string; at: number } | undefined;
let notice: { text: string; hint?: string; until: number } | undefined;
let reqSeq = 0;
let segSeq = 0;
let mark: { from: number; to: number } | undefined;
let previewEnd: number | undefined;
let lastPush = 0;
let lastState = '';
let pendingOffsetReq: Map<number, (offset: number | undefined) => void> = new Map();

function active(): boolean {
  if (!eid || !settings.enabled) return false;
  return manual.get(eid) ?? false;
}

function fatalActive(): boolean {
  return !!fatal && Date.now() - fatal.at < FATAL_RETRY_MS;
}

function setNotice(t: string, hint?: string): void {
  notice = { text: t, ...(hint ? { hint } : {}), until: Date.now() + NOTICE_MS };
}

// ── 时间换算 ──

/** 当前的真实时间与页面时间之差；还不知道时 undefined */
function currentOffset(): number | undefined {
  if (!s?.audio) return undefined;
  if (!s.audio.vbr || s.seekTarget === undefined) return 0;
  const key = s.seekTarget ?? 'none';
  if (s.offsetFor === key) return s.offset;
  if (s.offsetAsked !== key && s.port) {
    s.offsetAsked = key;
    const reqId = ++reqSeq;
    pendingOffsetReq.set(reqId, (off) => {
      if (!s || (s.seekTarget ?? 'none') !== key) return;
      if (off === undefined) {
        s.offsetAsked = undefined; // 还在扫描：稍后再问
        return;
      }
      s.offset = off;
      s.offsetFor = key;
    });
    post({ type: 'offset', reqId, ...(s.seekTarget !== undefined ? { seekTarget: s.seekTarget } : {}), model: SEEK_MODEL });
  }
  return undefined;
}

function truePos(audio: HTMLAudioElement): number | undefined {
  const off = currentOffset();
  return off === undefined ? undefined : audio.currentTime + off;
}

// ── 与后台的连接 ──

function post(msg: unknown): void {
  try {
    s?.port?.postMessage(msg);
  } catch {
    if (s) s.port = undefined;
  }
}

function connect(): void {
  if (!s || s.port || !alive()) return;
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: XYZ_PORT });
  } catch {
    return;
  }
  const mine = s;
  mine.port = port;
  port.onMessage.addListener((m) => onDown(mine, m as XyzDown));
  port.onDisconnect.addListener(() => {
    if (mine.port === port) {
      mine.port = undefined;
      mine.connected = false;
      mine.windowReq = undefined;
      mine.working.clear();
      mine.pendingSeqs.clear();
      mine.queue = [];
    }
  });
  port.postMessage({ type: 'hello', info: mine.info });
}

function disconnect(): void {
  if (!s) return;
  stopFeed(s);
  try {
    s.port?.disconnect();
  } catch {
    // 已断开
  }
  s.port = undefined;
  s.connected = false;
  s.windowReq = undefined;
  s.working.clear();
  s.pendingSeqs.clear();
  s.queue = [];
}

function onDown(mine: Session, m: XyzDown): void {
  if (s !== mine) return;
  switch (m.type) {
    case 'track':
      mine.connected = true;
      mine.cues = m.cues;
      mine.done = m.done;
      if (m.audio) mine.audio = m.audio;
      mine.audioError = m.audioError;
      mine.scanned = m.audio?.scanned;
      if (m.audio?.needsScan && !mine.scanAsked) {
        mine.scanAsked = true;
        post({ type: 'scan' });
      }
      break;
    case 'window':
      if (mine.windowReq?.reqId === m.reqId) {
        const req = mine.windowReq;
        mine.windowReq = undefined;
        void onWindow(mine, req, m).catch((e: unknown) => {
          setNotice(`解码这一段音频失败（${e instanceof Error ? e.message : String(e)}），跳过 ${formatXyzTime(req.from)}–${formatXyzTime(req.to)}`);
          finishJob(mine, req.from, req.to);
        });
      }
      break;
    case 'offset':
      pendingOffsetReq.get(m.reqId)?.(m.offset);
      pendingOffsetReq.delete(m.reqId);
      mine.scanned = m.scanned;
      break;
    case 'scan':
      mine.scanned = m.scanned;
      if (m.complete && mine.audio) mine.audio = { ...mine.audio, needsScan: false, scanned: 1 };
      break;
    case 'cue':
      mine.cues = upsertXyzCue(mine.cues, m.cue);
      break;
    case 'cues':
      for (const c of m.cues) mine.cues = upsertXyzCue(mine.cues, c);
      break;
    case 'done':
      mine.pendingSeqs.delete(m.seq);
      drain(mine);
      for (const [id, job] of mine.working) {
        job.seqs.delete(m.seq);
        if (!job.seqs.size && id >= 0) {
          mine.working.delete(id);
          processed(mine, job.from, job.to);
        }
      }
      break;
    case 'error':
      if (m.reqId !== undefined && mine.windowReq?.reqId === m.reqId) mine.windowReq = undefined;
      if (m.wait) {
        mine.waitUntil = Date.now() + 1500;
        break;
      }
      if (m.retryAfterMs !== undefined) mine.waitUntil = Date.now() + m.retryAfterMs;
      if (m.fatal) fatal = { message: m.message, ...(m.hint ? { hint: m.hint } : {}), at: Date.now() };
      else setNotice(m.message, m.hint);
      if (m.reqId !== undefined && !m.fatal && !m.wait) mine.waitUntil = Math.max(mine.waitUntil, Date.now() + 3000);
      break;
  }
  render();
  push();
}

/** 一段处理完了（句子都转写回来了）：告诉后台"这段已处理"，后台随即校对 / 翻译这一段 */
function processed(mine: Session, from: number, to: number): void {
  mine.done = mergeDone(mine.done, [from, to]);
  post({ type: 'processed', from, to });
}

function finishJob(mine: Session, from: number, to: number): void {
  for (const [id, job] of mine.working) if (job.from === from) mine.working.delete(id);
  mine.done = mergeDone(mine.done, [from, to]);
}

// ── 读音频、切句（OpenAI 转写） ──

async function decode(b64: string): Promise<Float32Array> {
  const bytes = base64ToBytes(b64);
  const ctx = new OfflineAudioContext(1, 1, SUBTITLES.sampleRate);
  const buf = await ctx.decodeAudioData(bytes.buffer as ArrayBuffer);
  const n = buf.length;
  const out = new Float32Array(n);
  const tmp = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    buf.copyFromChannel(tmp, c);
    for (let i = 0; i < n; i++) out[i]! += tmp[i]! / buf.numberOfChannels;
  }
  return out;
}

const SEGMENTER = { ...DEFAULT_SEGMENTER, ...XYZ.segmenter };

async function onWindow(mine: Session, req: { reqId: number; from: number; to: number; gap: number }, w: { audio: string; firstTime: number; skipSec: number; endTime: number }): Promise<void> {
  const pcm = await decode(w.audio);
  if (s !== mine) return;
  const skip = Math.round(w.skipSec * SUBTITLES.sampleRate);
  const samples = pcm.subarray(Math.min(pcm.length, skip));
  const start = w.firstTime + w.skipSec;
  if (mine.feed) return feedPiece(mine, mine.feed, samples, start, req);
  const end = Math.min(start + samples.length / SUBTITLES.sampleRate, w.endTime);
  const atEnd = !!duration(mine) && end >= duration(mine) - 0.2;
  const seg = new Segmenter(SEGMENTER);
  let segs: AudioSegment[] = [...seg.push({ samples, videoTime: start + samples.length / SUBTITLES.sampleRate, rate: 1 }), ...seg.flush()];
  let to = Math.min(end, req.to);
  // 末尾那句还没说完（一直说到这段的结尾）：留给下一段从它的开头接着读，不在半句话中间切开
  const last = segs[segs.length - 1];
  if (!atEnd && last && last.end > to - 0.6 && last.start > req.gap + 0.5) {
    to = last.start;
    segs = segs.slice(0, -1);
  }
  // 往前多读的那几秒只是为了找到句首：整句都在要处理的位置之前的不要（那里已经有字幕，或者以后另读）
  segs = segs.filter((x) => x.end > req.gap + 0.1 && x.start < to + 0.05);
  const from = Math.min(req.gap, segs[0]?.start ?? req.gap);
  const job: WindowJob = { from, to, seqs: new Set() };
  const id = req.reqId;
  mine.working.set(id, job);
  for (const x of segs) {
    if (x.end - x.start < 0.3) continue;
    const seq = ++segSeq;
    job.seqs.add(seq);
    mine.queue.push({ seq, start: x.start, end: Math.min(x.end, x.start + XYZ.maxSegmentSec), audio: bytesToBase64(encodeWav(x.samples.subarray(0, XYZ.maxSegmentSec * SUBTITLES.sampleRate), SUBTITLES.sampleRate)) });
  }
  if (!job.seqs.size) {
    mine.working.delete(id);
    processed(mine, job.from, job.to);
  }
  drain(mine);
}

/** 把排队的句子送去转写：同时在途的不超过 maxInFlight */
function drain(mine: Session): void {
  while (mine.queue.length && mine.pendingSeqs.size < XYZ.maxInFlight && mine.port) {
    const q = mine.queue.shift()!;
    mine.pendingSeqs.add(q.seq);
    post({ type: 'segment', ...q });
  }
}

/** 已处理的 + 正在处理的 */
function covered(mine: Session): [number, number][] {
  let all = mine.done;
  for (const job of mine.working.values()) all = mergeDone(all, [job.from, job.to]);
  if (mine.windowReq) all = mergeDone(all, [mine.windowReq.gap, mine.windowReq.to]);
  return all;
}

function duration(mine: Session): number {
  return mine.audio?.duration ?? mine.info.duration ?? 0;
}

function pump(mine: Session, audio: HTMLAudioElement): void {
  if (!mine.connected || !mine.audio || fatalActive() || Date.now() < mine.waitUntil) return;
  if (mine.windowReq && Date.now() - mine.windowReq.at > 60_000) mine.windowReq = undefined; // 没回音：放弃这一次
  drain(mine);
  if (mine.windowReq || mine.queue.length > XYZ.maxInFlight || mine.pendingSeqs.size >= XYZ.maxInFlight) return;
  const dur = duration(mine);
  if (!dur) return;
  const t = truePos(audio);
  if (t === undefined) return;
  if (settings.asrEngine === 'browser') return pumpFeed(mine, audio, t, dur);
  const searchFrom = whole ? 0 : Math.max(0, t - 1);
  const horizon = whole ? dur : Math.min(dur, t + settings.lookaheadSec);
  const gap = nextGap(covered(mine), searchFrom, horizon);
  if (gap === undefined) {
    // 整集都处理完了：退出"生成整集"，说一声
    if (whole && !mine.working.size && !mine.queue.length && !mine.pendingSeqs.size) {
      whole = false;
      setNotice('整集字幕已生成，可以在侧边栏下载');
    }
    return;
  }
  const len = mine.fresh ? XYZ.firstWindowSec : XYZ.windowSec;
  mine.fresh = false;
  const to = Math.min(dur, gap + len);
  if (to - gap < 0.2) return;
  // 从已处理的地方接着读时，那里正好是句与句之间；从任意位置开始（刚开始、刚跳转）时往前多读几秒，好找到这句话的开头
  const atBoundary = gap < 0.05 || covered(mine).some(([, b]) => Math.abs(b - gap) < 0.01);
  const from = atBoundary ? gap : Math.max(0, gap - XYZ.leadSec);
  const reqId = ++reqSeq;
  mine.windowReq = { reqId, from, to, at: Date.now(), gap };
  post({ type: 'window', reqId, from, to });
}

// ── 浏览器识别：把读到的声音按 1 倍速放给浏览器自带的语音识别（不出声） ──

function stopFeed(mine: Session): void {
  const f = mine.feed;
  if (!f) return;
  mine.feed = undefined;
  try {
    f.rec?.abort();
  } catch {
    // 已结束
  }
  for (const p of f.pieces) {
    try {
      p.source.stop();
    } catch {
      // 已结束
    }
  }
  void f.ac.close().catch(() => undefined);
}

function feedTrueNow(f: Feed): number | undefined {
  const now = f.ac.currentTime;
  const p = f.pieces.find((x) => now >= x.acStart && now < x.acStart + x.dur) ?? f.pieces[f.pieces.length - 1];
  if (!p) return undefined;
  return p.trueStart + Math.min(p.dur, Math.max(0, now - p.acStart));
}

function pumpFeed(mine: Session, audio: HTMLAudioElement, t: number, dur: number): void {
  let f = mine.feed;
  // 跳到了别处：从新位置重新开始
  if (f && (t < f.pieces[0]!.trueStart - 2 || t > f.nextTrue + 5)) {
    stopFeed(mine);
    f = undefined;
  }
  if (!f) {
    const ac = new AudioContext({ sampleRate: SUBTITLES.sampleRate });
    f = { ac, dest: ac.createMediaStreamDestination(), transcript: new LiveTranscript(), pieces: [], nextAt: 0, nextTrue: nextGap(covered(mine), t, dur) ?? t, restartAt: 0, failures: 0, sessionStartedAt: 0, resultIndex: -1 };
    mine.feed = f;
    void ac.resume().catch(() => undefined);
  }
  if (f.ac.state === 'suspended') {
    setNotice('浏览器还没允许这个页面处理声音：在小宇宙页面上点一下（例如播放按钮）');
    void f.ac.resume().catch(() => undefined);
    return;
  }
  // 播完的段：交出还没定稿的字，告诉后台这段已处理
  const now = f.ac.currentTime;
  while (f.pieces.length && f.pieces[0]!.acStart + f.pieces[0]!.dur < now - 2) {
    const p = f.pieces.shift()!;
    sendLines(mine, f.transcript.poll(p.trueStart + p.dur, Date.now()));
    processed(mine, p.from, p.to);
  }
  if (!f.rec && Date.now() >= f.restartAt) void startRecognition(mine, f);
  const horizon = Math.min(dur, t + settings.lookaheadSec);
  const buffered = f.nextAt - f.ac.currentTime;
  if (buffered > 20 || f.nextTrue >= horizon - 0.2) return;
  const from = f.nextTrue;
  const to = Math.min(dur, from + XYZ.windowSec);
  const reqId = ++reqSeq;
  mine.windowReq = { reqId, from, to, at: Date.now(), gap: from };
  post({ type: 'window', reqId, from, to });
}

function feedPiece(mine: Session, f: Feed, samples: Float32Array, start: number, req: { from: number; to: number }): void {
  if (!samples.length) return;
  const len = Math.min(samples.length, Math.round((req.to - start) * SUBTITLES.sampleRate));
  const buf = f.ac.createBuffer(1, Math.max(1, len), SUBTITLES.sampleRate);
  const own = new Float32Array(len);
  own.set(samples.subarray(0, len));
  buf.copyToChannel(own, 0);
  const source = f.ac.createBufferSource();
  source.buffer = buf;
  source.connect(f.dest);
  const at = Math.max(f.nextAt, f.ac.currentTime + 0.05);
  source.start(at);
  f.pieces.push({ acStart: at, trueStart: start, dur: buf.duration, from: req.from, to: start + buf.duration, source });
  f.nextAt = at + buf.duration;
  f.nextTrue = start + buf.duration;
}

function sendLines(mine: Session, lines: LiveLine[]): void {
  for (const l of lines) {
    const seq = ++segSeq;
    mine.cues = upsertXyzCue(mine.cues, { id: `${mine.eid}:${Math.round(l.start * 1000)}`, start: l.start, end: l.end, raw: l.text, createdAt: Date.now() });
    post({ type: 'text', seq, start: l.start, end: l.end, text: l.text, lang: recognitionLang(mine) });
  }
}

/** 识别语言：节目标题、简介是中文就按简体中文，否则按英文 */
function recognitionLang(mine: Session): string {
  const sample = `${mine.info.title} ${mine.info.podcastTitle}`;
  return /[一-鿿]/.test(sample) ? 'zh-CN' : 'en-US';
}

async function startRecognition(mine: Session, f: Feed): Promise<void> {
  const R = speechRecognitionCtor();
  if (!R) {
    fatal = { message: '这个浏览器没有语音识别功能', hint: '在设置页「18. 小宇宙」把转写方式改回 OpenAI', at: Date.now() };
    return;
  }
  const track = f.dest.stream.getAudioTracks()[0];
  if (!track) return;
  const lang = recognitionLang(mine);
  let mode: 'local' | 'cloud' = 'cloud';
  if ((!SPEECH_PLATFORM.hasCloud || !f.localFailed) && typeof R.available === 'function') {
    try {
      if ((await R.available({ langs: [lang], processLocally: true })) === 'available') mode = 'local';
    } catch {
      // 查不到就用云端
    }
  }
  if (mine.feed !== f) return;
  if (mode !== 'local' && !SPEECH_PLATFORM.hasCloud) {
    fatal = { message: '这个浏览器只能在本机识别语音，没有可用的本机语音模型', hint: '在设置页「18. 小宇宙」把转写方式改回 OpenAI', at: Date.now() };
    return;
  }
  const rec = new R();
  rec.lang = lang;
  rec.continuous = true;
  rec.interimResults = true;
  if (mode === 'local') rec.processLocally = true;
  rec.onresult = (e) => {
    if (f.rec !== rec) return;
    const t = feedTrueNow(f) ?? 0;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!;
      if (i !== f.resultIndex) {
        sendLines(mine, f.transcript.flush(t));
        f.resultIndex = i;
      }
      sendLines(mine, f.transcript.update(r[0].transcript, r.isFinal, t, 1, Date.now()));
    }
    f.failures = 0;
  };
  rec.onerror = (e) => {
    if (f.rec !== rec) return;
    const info = speechErrorInfo(e.error, mode, lang, SPEECH_PLATFORM.hasCloud);
    if (!info) return;
    if (info.retryCloud) {
      f.localFailed = true;
      setNotice(info.message);
      return;
    }
    if (info.fatal) fatal = { message: info.message, hint: '可以在设置页「18. 小宇宙」把转写方式改回 OpenAI', at: Date.now() };
    else setNotice(info.message);
  };
  rec.onend = () => {
    if (f.rec !== rec) return;
    sendLines(mine, f.transcript.flush(feedTrueNow(f) ?? 0));
    f.rec = undefined;
    if (Date.now() - f.sessionStartedAt < 3_000) {
      f.failures++;
      f.restartAt = Date.now() + Math.min(SUBTITLES.recognitionRestartMaxMs, SUBTITLES.recognitionRestartBaseMs * 2 ** (f.failures - 1));
    } else {
      f.restartAt = Date.now();
    }
  };
  try {
    rec.start(track);
  } catch (e) {
    f.failures++;
    f.restartAt = Date.now() + 2000 * f.failures;
    setNotice(`语音识别没能开始（${e instanceof Error ? e.name : '未知原因'}），稍后自动重试`);
    return;
  }
  f.rec = rec;
  f.mode = mode;
  f.sessionStartedAt = Date.now();
  f.resultIndex = -1;
}

// ── 字幕层与片段标记 ──

const CSS = `
:host { all: initial; }
.cap { position: fixed; left: 50%; transform: translateX(-50%); bottom: var(--bottom, 110px); width: min(760px, 94vw); box-sizing: border-box; display: flex; flex-direction: column; align-items: center; gap: 4px; pointer-events: none; z-index: 2147483000; font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC", system-ui, sans-serif; }
.cap[hidden] { display: none; }
.box { max-width: 100%; box-sizing: border-box; padding: 8px 16px 9px; border-radius: 12px; background: rgba(18, 16, 30, 0.82); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25); display: flex; flex-direction: column; align-items: center; gap: 2px; }
.box[hidden] { display: none; }
.zh { color: #fff; font-size: calc(20px * var(--fs, 1)); line-height: 1.45; font-weight: 500; text-align: center; overflow-wrap: anywhere; }
.en { color: #ffe7a3; font-size: calc(15px * var(--fs, 1)); line-height: 1.4; text-align: center; overflow-wrap: anywhere; }
.zh:empty, .en:empty { display: none; }
.pending .zh, .pending .en { opacity: 0.86; }
.status { font: 12px/1.45 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: #fff; background: rgba(40, 32, 80, 0.86); padding: 4px 10px; border-radius: 6px; max-width: 100%; text-align: center; }
.status[hidden] { display: none; }
.status .hint { opacity: 0.8; }
.marks { position: fixed; pointer-events: none; z-index: 2147483000; }
.marks[hidden] { display: none; }
.band { position: absolute; top: 0; bottom: 0; background: rgba(124, 92, 255, 0.35); border-radius: 3px; }
.pin { position: absolute; bottom: 0; width: 2px; height: 22px; background: #7c5cff; transform: translateX(-1px); }
.pin::after { content: ""; position: absolute; bottom: -4px; left: -4px; width: 10px; height: 10px; border-radius: 50%; background: #fff; border: 2px solid #7c5cff; box-sizing: border-box; }
.tag { position: absolute; bottom: 26px; transform: translateX(-50%); font: 600 11px/1 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: #fff; background: #7c5cff; padding: 4px 6px; border-radius: 6px; white-space: nowrap; }
`;

let overlay:
  | { host: HTMLElement; cap: HTMLElement; box: HTMLElement; zh: HTMLElement; en: HTMLElement; status: HTMLElement; statusMain: HTMLElement; statusHint: HTMLElement; marks: HTMLElement; band: HTMLElement; pinA: HTMLElement; pinB: HTMLElement; tagA: HTMLElement; tagB: HTMLElement }
  | undefined;

function ensureOverlay(): NonNullable<typeof overlay> {
  if (overlay && overlay.host.isConnected) return overlay;
  overlay?.host.remove();
  const host = document.createElement('div');
  host.setAttribute('data-tubemuse', 'xyz');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const el = (cls: string, parent: Node, tag = 'div') => {
    const e = document.createElement(tag);
    e.className = cls;
    parent.appendChild(e);
    return e;
  };
  const cap = el('cap', shadow);
  const status = el('status', cap);
  const statusMain = el('main', status);
  const statusHint = el('hint', status);
  const box = el('box', cap);
  const zh = el('zh', box);
  const en = el('en', box);
  const marks = el('marks', shadow);
  const band = el('band', marks);
  const pinA = el('pin', marks);
  const pinB = el('pin', marks);
  const tagA = el('tag', marks);
  const tagB = el('tag', marks);
  shadow.prepend(style);
  document.documentElement.appendChild(host);
  overlay = { host, cap, box, zh, en, status, statusMain, statusHint, marks, band, pinA, pinB, tagA, tagB };
  return overlay;
}

function removeOverlay(): void {
  overlay?.host.remove();
  overlay = undefined;
}

function statusLine(): { text: string; hint?: string } | undefined {
  if (!s) return undefined;
  if (fatalActive()) return { text: `TubeMuse 字幕：${fatal!.message}`, ...(fatal!.hint ? { hint: fatal!.hint } : {}) };
  if (notice && Date.now() < notice.until) return { text: `TubeMuse 字幕：${notice.text}`, ...(notice.hint ? { hint: notice.hint } : {}) };
  if (s.audioError) return { text: `TubeMuse 字幕：${s.audioError.message}`, ...(s.audioError.hint ? { hint: s.audioError.hint } : {}) };
  if (!s.connected) return { text: 'TubeMuse 字幕：正在读取这一集的音频信息…' };
  if (s.audio?.needsScan && currentOffset() === undefined) return { text: `TubeMuse 字幕：正在建立时间索引 ${Math.round((s.scanned ?? 0) * 100)}%`, hint: '这一集是可变码率 mp3，要先把音频文件读一遍（只读帧头，不保存音频）' };
  return undefined;
}

function render(): void {
  const audio = audioEl();
  if (!s || !audio || !settings.enabled) return removeOverlay();
  const on = active();
  const t = truePos(audio);
  const display: XyzDisplay = settings.display;
  if (!on && !mark) return removeOverlay();
  const o = ensureOverlay();
  // 字幕层：播放器上方
  const player = playerEl();
  const top = player?.getBoundingClientRect().top;
  // 进度条上方标着片段起止时，字幕再往上让出标签的位置
  o.cap.style.setProperty('--bottom', `${(top !== undefined && top > 0 ? Math.max(12, window.innerHeight - top + 14) : 110) + (mark ? 36 : 0)}px`);
  o.cap.style.setProperty('--fs', String(settings.fontScale || 1));
  const st = on ? statusLine() : undefined;
  o.status.hidden = !st;
  o.statusMain.textContent = st?.text ?? '';
  o.statusHint.textContent = st?.hint ?? '';
  const cue = on && t !== undefined && display !== 'off' ? pickXyzCue(s.cues, t) : undefined;
  const lines = cue ? cueLines(cue) : undefined;
  const zh = lines && display !== 'en' ? lines.zh : '';
  const en = lines && display !== 'zh' ? lines.en : '';
  o.zh.textContent = zh;
  o.en.textContent = en;
  o.box.hidden = !zh && !en;
  o.box.classList.toggle('pending', !!lines?.pending);
  o.cap.hidden = !on || (o.box.hidden && o.status.hidden);
  // 片段标记：进度条上方
  const bar = (player?.querySelector('[class*="progress-wrap"]') ?? player?.querySelector('[class*="progress"]')) as HTMLElement | null;
  const dur = audio.duration && Number.isFinite(audio.duration) ? audio.duration : duration(s);
  const off = currentOffset() ?? 0;
  if (mark && bar && dur > 0) {
    const r = bar.getBoundingClientRect();
    const x = (sec: number) => Math.max(0, Math.min(r.width, ((sec - off) / dur) * r.width));
    o.marks.hidden = false;
    o.marks.style.left = `${r.left}px`;
    o.marks.style.top = `${r.top}px`;
    o.marks.style.width = `${r.width}px`;
    o.marks.style.height = `${Math.max(4, r.height)}px`;
    const a = x(mark.from);
    const b = x(mark.to);
    o.band.style.left = `${a}px`;
    o.band.style.width = `${Math.max(2, b - a)}px`;
    o.pinA.style.left = `${a}px`;
    o.pinB.style.left = `${b}px`;
    o.tagA.style.left = `${a}px`;
    o.tagB.style.left = `${b}px`;
    o.tagA.textContent = formatXyzTime(mark.from);
    o.tagB.textContent = formatXyzTime(mark.to);
  } else {
    o.marks.hidden = true;
  }
}

// ── 侧边栏看到的状态 ──

function tabState(): XyzTabState {
  const audio = audioEl();
  const pos = audio?.currentTime ?? 0;
  const t = audio ? truePos(audio) : undefined;
  const info = s?.info ?? (eid ? readInfo(eid) : undefined);
  const st = statusLine();
  const on = active();
  const doneSec = s ? s.done.reduce((n, [a, b]) => n + (b - a), 0) : 0;
  let status: string;
  if (!eid) status = '当前页不是小宇宙的单集页';
  else if (!settings.enabled) status = '小宇宙功能已在设置里关闭';
  else if (!on) status = '未开启（字幕默认关闭）：点"开始字幕"或按 Alt+Shift+S';
  else if (st) status = st.text.replace(/^TubeMuse 字幕：/, '');
  else if (whole) status = `正在生成整集字幕：已处理 ${formatXyzTime(doneSec)} / ${formatXyzTime(info?.duration ?? 0)}`;
  else status = s?.pendingSeqs.size || s?.windowReq ? '正在转写播放位置前后的内容…' : `字幕已准备到播放位置之后（最多提前 ${Math.round(settings.lookaheadSec / 60)} 分钟）`;
  return {
    page: eid ? 'episode' : 'other',
    enabled: settings.enabled,
    ...(info ? { info } : {}),
    pos,
    truePos: t ?? pos,
    duration: (audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0) || info?.duration || 0,
    playing: !!audio && !audio.paused && !audio.ended,
    active: on,
    whole,
    engine: settings.asrEngine,
    display: settings.display,
    status,
    ...(fatalActive() ? { error: { message: fatal!.message, ...(fatal!.hint ? { hint: fatal!.hint } : {}) } } : s?.audioError ? { error: s.audioError } : {}),
    ...(s?.audio?.needsScan ? { scan: s.scanned ?? 0 } : {}),
    ...(s?.audio && !s.audio.exact ? { timingNote: '这一集是没有时间目录的可变码率 mp3：跳转之后字幕可能对不齐' } : {}),
    pending: s?.pendingSeqs.size ?? 0,
    doneSec,
  };
}

function push(): void {
  if (!alive()) return;
  const st = tabState();
  const key = JSON.stringify({ ...st, pos: 0, truePos: 0 });
  if (key === lastState && Date.now() - lastPush < 5000) return;
  lastState = key;
  lastPush = Date.now();
  try {
    void chrome.runtime.sendMessage({ type: XYZ_MSG.state, state: st }).catch(() => undefined);
  } catch {
    // 扩展被重新加载
  }
}

// ── 收听记录 ──

let tracker: TrackerState = {};
let lastFlush = 0;

function sendListen(session: WatchSession | undefined): void {
  if (!session || session.playSec <= 0 || !alive() || !settings.enabled || !settings.tracking) return;
  const id = session.videoId;
  const info = s?.eid === id ? s.info : readInfo(id);
  const audio = audioEl();
  try {
    void chrome.runtime.sendMessage({ type: XYZ_MSG.listen, session, info, lastPos: audio?.currentTime ?? 0 }).catch(() => undefined);
  } catch {
    // 扩展被重新加载
  }
}

function trackListen(audio: HTMLAudioElement | null): void {
  if (!settings.enabled || !settings.tracking) return;
  const sample: PlaybackSample = {
    t: Date.now(),
    videoId: audio && eid ? eid : null,
    currentTime: audio?.currentTime ?? 0,
    duration: audio && Number.isFinite(audio.duration) ? audio.duration : 0,
    paused: !audio || audio.paused || audio.readyState < 2,
    ended: !!audio?.ended,
    rate: audio?.playbackRate ?? 1,
    isAd: false,
    visible: document.visibilityState === 'visible',
    shorts: false,
  };
  const r = stepTracker(tracker, sample, () => crypto.randomUUID());
  tracker = r.state;
  if (r.finished) sendListen(r.finished);
  if (tracker.session && Date.now() - lastFlush >= WATCH.flushEveryMs) {
    sendListen(tracker.session);
    lastFlush = Date.now();
  }
}

function flushListen(): void {
  sendListen(tracker.session);
  lastFlush = Date.now();
}

// ── 主循环 ──

let lastTrackAt = 0;
let watchedAudio: HTMLAudioElement | null = null;

function onSeeking(): void {
  const audio = audioEl();
  if (!s || !audio) return;
  s.seekTarget = audio.currentTime;
  s.offsetFor = undefined;
  s.offsetAsked = undefined;
  s.fresh = true;
}

function lastSeekGuess(audio: HTMLAudioElement): number {
  const t = audio.currentTime;
  for (let i = 0; i < audio.played.length; i++) if (audio.played.start(i) <= t + 0.5 && t <= audio.played.end(i) + 0.5) return audio.played.start(i);
  return t;
}

function switchEpisode(next: string | null): void {
  disconnect();
  removeOverlay();
  eid = next;
  whole = false;
  mark = undefined;
  previewEnd = undefined;
  s = next ? { eid: next, info: readInfo(next), cues: [], done: [], working: new Map(), connected: false, fresh: true, pendingSeqs: new Set(), queue: [], waitUntil: 0 } : undefined;
  push();
}

function tick(): void {
  if (!alive()) return teardown();
  const next = xyzEpisodeId(location.href) ?? null;
  if (next !== eid) switchEpisode(next);
  const audio = audioEl();
  if (audio !== watchedAudio) {
    watchedAudio?.removeEventListener('seeking', onSeeking);
    audio?.addEventListener('seeking', onSeeking);
    watchedAudio = audio;
    // 脚本开始工作之前页面已经跳过（例如小宇宙恢复上次的收听位置）：按当前所在的那段已播放区间的起点算跳转目标
    if (audio && s && s.seekTarget === undefined && audio.currentTime > 0.5) s.seekTarget = lastSeekGuess(audio);
  }
  if (Date.now() - lastTrackAt >= WATCH.tickMs) {
    lastTrackAt = Date.now();
    trackListen(audio);
  }
  if (!settingsLoaded || !s) return;
  if (settings.autoStart && settings.enabled && autoStartedFor !== s.eid && !manual.has(s.eid)) {
    autoStartedFor = s.eid;
    manual.set(s.eid, true);
  }
  // 页面上的信息可能晚一点才出来（站内跳转后）：补齐后重新打招呼
  if (!s.info.audioUrl || !s.info.title) {
    const info = readInfo(s.eid);
    if (info.audioUrl !== s.info.audioUrl || info.title !== s.info.title) {
      s.info = info;
      if (s.port) post({ type: 'hello', info });
    }
  }
  if (active() && audio) {
    connect();
    pump(s, audio);
    if (previewEnd !== undefined) {
      const t = truePos(audio);
      if (t !== undefined && t >= previewEnd) {
        audio.pause();
        previewEnd = undefined;
      }
    }
  } else if (s.port && !whole) {
    disconnect();
  }
  if (!active() && previewEnd !== undefined && audio) {
    const t = truePos(audio) ?? audio.currentTime;
    if (t >= previewEnd) {
      audio.pause();
      previewEnd = undefined;
    }
  }
  render();
  push();
}

let timer: ReturnType<typeof setInterval> | undefined;

function teardown(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  try {
    s?.port?.disconnect();
  } catch {
    // 已断开
  }
  removeOverlay();
}

function applySettings(raw: unknown): void {
  const x = (raw as { xyz?: Partial<XyzSettings> } | undefined)?.xyz;
  const next = { ...DEFAULT_SETTINGS.xyz, ...(x ?? {}) };
  if (!isXyzDisplay(next.display)) next.display = 'bilingual';
  if (next.asrEngine !== settings.asrEngine && s) {
    stopFeed(s);
    s.working.clear();
    s.windowReq = undefined;
  }
  if (settings.tracking && !next.tracking) {
    flushListen();
    tracker = {};
  }
  settings = next;
  fatal = undefined;
}

void chrome.storage.local
  .get('settings')
  .then((r) => applySettings(r.settings))
  .catch(() => undefined)
  .finally(() => {
    settingsLoaded = true;
    tick();
  });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) applySettings(changes.settings.newValue);
  if (changes.secrets) fatal = undefined;
});

/** 把播放位置跳到真实时间 t（可变码率 mp3 跳转后两种时间不同：按后台算出的差值换算，最多试两次） */
async function seekTo(audio: HTMLAudioElement, t: number): Promise<void> {
  if (!s?.audio?.vbr) {
    audio.currentTime = Math.max(0, t);
    return;
  }
  let target = Math.max(0, t - (currentOffset() ?? 0));
  for (let i = 0; i < 2 && s.port; i++) {
    const reqId = ++reqSeq;
    const off = await new Promise<number | undefined>((resolve) => {
      pendingOffsetReq.set(reqId, resolve);
      post({ type: 'offset', reqId, seekTarget: target, model: SEEK_MODEL });
      setTimeout(() => resolve(undefined), 3000);
    });
    if (off === undefined) break;
    const next = Math.max(0, t - off);
    if (Math.abs(next - target) < 0.05) break;
    target = next;
  }
  audio.currentTime = target;
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const msg = raw as { type?: string; on?: unknown; to?: unknown; end?: unknown; from?: unknown; mark?: unknown } | undefined;
  if (msg?.type === XYZ_MSG.getState) {
    sendResponse(tabState());
    return false;
  }
  if ((msg?.type === XYZ_MSG.toggle || msg?.type === 'tubemuse:subtitles:toggle') && eid) {
    const on = typeof msg.on === 'boolean' ? msg.on : !active();
    manual.set(eid, on);
    if (!on) whole = false;
    fatal = undefined;
    tick();
    sendResponse(tabState());
    return false;
  }
  if (msg?.type === XYZ_MSG.whole && eid) {
    whole = msg.on === true;
    if (whole) manual.set(eid, true);
    fatal = undefined;
    tick();
    sendResponse(tabState());
    return false;
  }
  if (msg?.type === XYZ_MSG.mark) {
    const m = msg.mark as { from?: unknown; to?: unknown } | null | undefined;
    mark = m && typeof m.from === 'number' && typeof m.to === 'number' && Number.isFinite(m.from) && Number.isFinite(m.to) && m.to > m.from ? { from: m.from, to: m.to } : undefined;
    render();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === XYZ_MSG.seek && eid) {
    const audio = audioEl();
    const to = Number(msg.to);
    if (!audio || !Number.isFinite(to) || to < 0) {
      sendResponse({ ok: false, message: '页面上没有找到播放器' });
      return false;
    }
    const end = typeof msg.end === 'number' && Number.isFinite(msg.end) && msg.end > to ? msg.end : undefined;
    void seekTo(audio, to)
      .then(async () => {
        previewEnd = end;
        if (end !== undefined) await audio.play();
        sendResponse({ ok: true });
      })
      .catch((e: unknown) => {
        previewEnd = undefined;
        sendResponse({ ok: false, message: e instanceof Error && e.name === 'NotAllowedError' ? '浏览器不让这个页面自动播放：先在小宇宙页面上点一下播放按钮' : '没能跳到这个位置' });
      });
    return true;
  }
  return false;
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushListen();
});
window.addEventListener('pagehide', flushListen);
window.addEventListener('resize', () => render());

timer = setInterval(tick, TICK_MS);
tick();
