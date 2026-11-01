// 注入 YouTube 播放页的视频片段录制脚本（用户 2026-11-01 批准的红线变更，见 DECISIONS §36）：
// 1. 只在你从侧边栏"片段"页或快捷键开始录制后工作：把正在播放的这个视频逐帧画到一块不放进页面的画布上
//    （开启字幕烧录时再叠加播放器里当时显示的字幕），声音经 video.captureStream() 取这个视频的音轨，
//    交给浏览器自带的 MediaRecorder 编码。不是麦克风、不是整个标签页；不抓取、不下载 YouTube 的音视频流。
// 2. 广告、暂停、缓冲、标签页在后台时自动暂停录制；切到别的视频时这一段自动结束。
// 3. 录好的片段只在这个页面的内存里；你点"保存"（或开着"停止后直接保存"）时由浏览器存进下载文件夹，
//    之后只把文件名、时间段、大小交给扩展后台记一笔。本脚本不发任何网络请求、不改动页面
//    （画布和下载链接都不放进页面），构建时自动检查。
// 4. 读取的页面信息只有：播放器状态、页面标题（只用来显示和起文件名）、开启字幕烧录时播放器里当时显示的字幕文字。
// 受版权保护（DRM）的视频浏览器不允许录制，本脚本不绕过。

import { CLIPS, DEFAULT_SETTINGS } from '../config/defaults';
import {
  CLIP_MSG,
  CLIP_STOP_LABELS,
  CLIP_WAIT_LABELS,
  checkClipStart,
  clipFileName,
  decideClip,
  formatTimecode,
  layoutBurnIn,
  outputSize,
  pickClipFormat,
  titleFromDocumentTitle,
  videoBitrate,
  type BurnBox,
  type BurnLine,
  type ClipFormat,
  type ClipMode,
  type ClipRecord,
  type ClipStartRequest,
  type ClipStopReason,
  type ClipTabState,
  type ClipWaitReason,
  type ReadyClipInfo,
} from '../core/clips';
import { videoIdFromUrl } from '../core/watch';

type ClipSettings = typeof DEFAULT_SETTINGS.clips;

const FONT = '"YouTube Noto", Roboto, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Noto Sans JP", sans-serif';

let settings: ClipSettings = { ...DEFAULT_SETTINGS.clips };
let fontScale = DEFAULT_SETTINGS.subtitles.fontScale;

interface Recording {
  id: string;
  mode: ClipMode;
  videoId: string;
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
  chunks: Blob[];
  bytes: number;
  recordedSec: number;
  lastTick: number;
  userPaused: boolean;
  waiting?: ClipWaitReason;
  /** 录到的第一刻与最后一刻（视频时间），用来给文件起名 */
  mediaFirst?: number;
  mediaLast?: number;
  lastDrawAt: number;
  frameHandle?: number;
  fallbackTimer?: ReturnType<typeof setInterval>;
  burnLines: BurnLine[];
  burnKey: string;
  burnBoxes: BurnBox[];
  stopping?: ClipStopReason;
  errorText?: string;
}

interface ReadyClip extends ReadyClipInfo {
  blob: Blob;
  url?: string;
  videoId: string;
  title?: string;
  mode: ClipMode;
}

let rec: Recording | undefined;
let ready: ReadyClip | undefined;
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
  return document.getElementById('movie_player');
}

function videoEl(): HTMLVideoElement | null {
  return playerEl()?.querySelector('video') ?? null;
}

function adShowing(): boolean {
  const p = playerEl();
  return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
}

function currentIds(): { videoId: string | null; shorts: boolean } {
  return videoIdFromUrl(location.href);
}

function pageTitle(): string | undefined {
  const t = titleFromDocumentTitle(document.title || '');
  return t && t !== 'YouTube' ? t : undefined;
}

function fail(message: string, hint?: string): void {
  lastError = { message, ...(hint ? { hint } : {}) };
}

// ── 画面 ──

/** 播放器里当时显示的字幕：YouTube 原生字幕在上，TubeMuse 自动字幕（原文、译文）在下 */
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
    g.fillStyle = b.tone === 'translation' ? '#ffe7a3' : '#ffffff';
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
    enabled: settings.enabled,
    videoId,
    shorts,
    hasVideo: !!video,
    busy: !!rec,
    duration: video?.duration ?? 0,
    currentTime: video?.currentTime ?? 0,
    ended: !!video?.ended,
    maxSec,
  });
  if (problem || !video || !videoId) return fail(problem ?? '没找到播放器里的视频');
  // 跳到起点会改动广告的播放进度：等广告结束再截取
  if (req.mode === 'range' && adShowing()) return fail('正在播广告：广告结束后再开始截取');
  if ((video as HTMLVideoElement & { mediaKeys?: unknown }).mediaKeys) {
    return fail('这个视频受版权保护（DRM），浏览器不允许录制', '付费电影、部分音乐视频等受保护的内容录不了；TubeMuse 不会绕过这项保护');
  }
  const format = pickClipFormat((m) => MediaRecorder.isTypeSupported(m));
  if (!format) return fail('这个浏览器不支持录制视频（MediaRecorder 不支持 MP4 或 WebM）', '请用最新版 Google Chrome');

  let source: MediaStream;
  try {
    source = (video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
  } catch {
    return fail('浏览器不允许录制这个视频（可能受版权保护）');
  }
  const ac = new AudioContext();
  if (ac.state === 'suspended') await ac.resume().catch(() => undefined);
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
    ...(title ? { title } : {}),
    ...(req.mode === 'range' ? { start: req.start!, end: req.end! } : {}),
    video,
    canvas,
    g,
    width: size.width,
    height: size.height,
    burn: settings.burnSubtitles,
    format,
    maxSec,
    source,
    ac,
    dest,
    audioNodes: new Map(),
    canvasTrack,
    recorder,
    chunks: [],
    bytes: 0,
    recordedSec: 0,
    lastTick: performance.now(),
    userPaused: false,
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
  recorder.start(CLIPS.timesliceMs);
  // 先停在暂停状态，由下一轮判断该不该录（例如广告中、正在跳到起点）
  recorder.pause();
  r.waiting = 'seeking';
  tick();
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
  if (reason === 'error') fail(`录制出错：${r.errorText ?? '未知错误'}`, '已录到的部分（如果有）仍可保存');
  if (!r.bytes || r.recordedSec < 0.3 || r.mediaFirst === undefined) {
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
    fileName: clipFileName(r.title, r.videoId, start, end, r.format.ext),
    bytes: r.bytes,
    durationSec: Math.round(r.recordedSec * 10) / 10,
    start,
    end,
    format: r.format.label,
    burned: r.burn,
    endedBy: reason,
    videoId: r.videoId,
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
    const d = decideClip(
      { mode: r.mode, videoId: r.videoId, ...(r.mode === 'range' ? { start: r.start!, end: r.end! } : {}), recordedSec: r.recordedSec, bytes: r.bytes, maxSec: r.maxSec, maxBytes: CLIPS.maxBytes, userPaused: r.userPaused },
      {
        // 播放器里换了一个视频元素也算换了视频
        videoId: videoEl() === v ? videoId : null,
        currentTime: v.currentTime,
        paused: v.paused,
        ended: v.ended,
        seeking: v.seeking,
        ready: v.readyState >= 2,
        ad: adShowing(),
        visible: document.visibilityState === 'visible',
      },
    );
    if (d.kind === 'stop') stopRecording(d.reason);
    else if (d.kind === 'record') {
      if (r.recorder.state === 'paused') r.recorder.resume();
      r.waiting = undefined;
      r.mediaFirst ??= v.currentTime;
      r.mediaLast = v.currentTime;
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
  const { videoId, shorts } = currentIds();
  const video = videoEl();
  const r = rec;
  const maxSec = Math.round(Math.max(1, settings.maxMinutes) * 60);
  const unavailable = !settings.enabled ? '片段录制已在设置中关闭' : shorts ? 'Shorts 暂不支持录制' : !videoId ? '这个页面不是视频播放页' : undefined;
  const t = video?.currentTime ?? 0;
  let status: string;
  if (r?.stopping) status = '正在收尾…';
  else if (r) status = r.waiting ? CLIP_WAIT_LABELS[r.waiting] : r.mode === 'range' ? `正在截取 ${formatTimecode(r.start!)} – ${formatTimecode(r.end!)}` : '正在录制';
  else if (unavailable) status = unavailable;
  else if (ready) status = ready.savedAt ? `已保存：${ready.fileName}` : `录好了（${CLIP_STOP_LABELS[ready.endedBy]}），还没保存`;
  else status = '可以开始录制';
  const title = r?.title ?? (videoId ? pageTitle() : undefined);
  const { blob: _b, url: _u, videoId: _v, title: _t, mode: _m, ...readyInfo } = ready ?? ({} as ReadyClip);
  return {
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
    burn: r ? r.burn : settings.burnSubtitles,
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
  const msg = raw as { type?: string; mode?: unknown; start?: unknown; end?: unknown; precise?: unknown } | undefined;
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
    default:
      return false;
  }
});

timer = setInterval(tick, CLIPS.tickMs);
tick();
