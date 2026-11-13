// 中文配音（用户 2026-11-13 要求，见 DECISIONS §74）：在 YouTube 播放页叠加播放你为这个视频选的本地中文配音（.m4a）。
// 1. 只在你从侧边栏开启后工作（每个视频单独开，只在这个标签页里记住）。打开有配音的视频时只做提示：
//    告诉后台在工具栏图标上标"中"，侧边栏顶部显示一行；配音本身仍要你点"开启"。
// 2. 音频由后台从扩展自己的 IndexedDB 读出来、分块交过来（扩展内部的长连接），在这个标签页的内存里拼成一个文件，
//    交给一个不放进页面的 <audio>。脚本自己不发网络请求、不往页面插入任何元素、不读页面文字（只读页面标题，侧边栏列表里显示）。
// 3. 跟随：视频播放、暂停、拖动进度、改倍速时配音跟着走，再加上你手动设的偏移；不做逐句对齐（两段录音的语速、停顿本来就不一样）。
//    广告期间配音暂停、原声恢复。有对齐点时（DECISIONS §75）按段换算：每段有自己的偏移，中文先说完就停下等画面，
//    说得慢就在下一个对齐点跳过去；"加对齐点"时报出此刻的视频位置与中文位置，由侧边栏存下。
// 4. 配音开启时原声降到你的音量的 80%（直接改 <video> 的音量，不碰 YouTube 的设置）；配音保持正常音量。
//    关闭、换视频、离开页面、扩展被重新加载时把原声恢复成你的音量。
// 5. 片段录制（DECISIONS §76）：配音开着时，把配音的 <audio> 交给同一个隔离环境里的录制脚本，录下的片段是双语混音。

import { DEFAULT_SETTINGS, DUB } from '../config/defaults';
import { base64ToBytes } from '../core/clips';
import {
  DUB_MSG,
  DUB_PORT,
  VolumeDuck,
  clampDelay,
  cleanVideoTitle,
  dubMapOf,
  dubReasonText,
  dubSegmentAt,
  dubStep,
  sanitizeDubIndex,
  withSegmentOffset,
  type DubIndex,
  type DubMap,
  type DubMark,
  type DubPhase,
  type DubPortReply,
  type DubReason,
  type DubRecord,
  type DubTabState,
} from '../core/dub';
import { publishDubMix } from '../core/dub-mix';
import { playerRootId } from '../core/multicc-protocol';
import { videoIdFromUrl } from '../core/watch';

type DubSettings = typeof DEFAULT_SETTINGS.dub;

let settings: DubSettings = { ...DEFAULT_SETTINGS.dub };
let index: DubIndex = {};
let ready = false;
let videoId: string | null = null;
/** 你在这个标签页里开启了配音的视频（刷新页面即忘：下次打开同一视频时只提示，不自动出声） */
const wantOn = new Set<string>();
/** 拖动"中文位置"时某一段的实时偏移（松手后侧边栏存进本机，这里随存储变化清掉） */
let liveOffset: { videoId: string; index: number; offset: number } | undefined;
/** 这一段中文快说完、或快到下一个对齐点时，到点立刻再检查一次 */
let wakeTimer: ReturnType<typeof setTimeout> | undefined;

interface Loaded {
  fileId: string;
  url: string;
  audio: HTMLAudioElement;
  ready: boolean;
}
interface Loading {
  fileId: string;
  port: chrome.runtime.Port;
  parts: Uint8Array[];
  received: number;
  size: number;
}
let loaded: Loaded | undefined;
let loading: Loading | undefined;
let error: { message: string; hint?: string } | undefined;
/** 出错的是哪个文件：换了文件就作废 */
let errorFor: string | undefined;
let reason: DubReason | undefined;
/** 浏览器拦下了配音出声（页面还没被点过） */
let autoplayBlocked = false;
let lastPlayTry = 0;
let playPending = false;

const duck = new VolumeDuck(DUB.originalVolume);
/** 我们在管它音量的那个 <video> */
let duckVideo: HTMLVideoElement | null = null;
/** 我们在听它事件的那个 <video> */
let listenVideo: HTMLVideoElement | null = null;

let timer: ReturnType<typeof setInterval> | undefined;
let scheduled = false;
let lastState = '';
let lastBadge = '';

function alive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/** 正在看的视频所在的播放器：播放页是 #movie_player，Shorts 是 #shorts-player */
function playerEl(): HTMLElement | null {
  return document.getElementById(playerRootId(location.pathname));
}

function videoEl(): HTMLVideoElement | null {
  return playerEl()?.querySelector('video') ?? null;
}

function adShowing(): boolean {
  const p = playerEl();
  return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
}

function record(): DubRecord | undefined {
  return settings.enabled && videoId ? index[videoId] : undefined;
}

/** 跟随用的对齐信息：存下的开头偏移与对齐点，拖动中的那一段换成实时值 */
function mapOf(rec: DubRecord): DubMap {
  const map = dubMapOf(rec);
  return liveOffset?.videoId === rec.videoId ? withSegmentOffset(map, liveOffset.index, liveOffset.offset) : map;
}

// ── 音频 ──

function unload(): void {
  if (loading) {
    try {
      loading.port.disconnect();
    } catch {
      // 已断开
    }
    loading = undefined;
  }
  if (loaded) {
    loaded.audio.pause();
    loaded.audio.removeAttribute('src');
    loaded.audio.load();
    URL.revokeObjectURL(loaded.url);
    loaded = undefined;
  }
  playPending = false;
}

function mediaErrorHint(e: MediaError | null): string {
  const code = e?.code;
  if (code === 4) return '浏览器不支持这个文件的编码（m4a 里通常是 AAC，那种能放；ALAC 等无损编码浏览器放不了）。换成 AAC 编码的 m4a 再试。';
  if (code === 3) return '文件解码到一半出错，可能已损坏：重新导出一份再试。';
  return '在侧边栏「配音」页关掉再开启一次重试；还不行就换一个文件。';
}

function startLoad(rec: DubRecord): void {
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: DUB_PORT });
  } catch {
    return shutdown();
  }
  const l: Loading = { fileId: rec.fileId, port, parts: [], received: 0, size: rec.size };
  loading = l;
  port.onMessage.addListener((raw: unknown) => {
    if (loading !== l) return;
    const m = raw as DubPortReply;
    if (m.type === 'meta') l.size = m.size;
    else if (m.type === 'chunk') {
      const bytes = base64ToBytes(m.data);
      l.parts.push(bytes);
      l.received += bytes.length;
      broadcast();
    } else if (m.type === 'done') finishLoad(l);
    else if (m.type === 'error') {
      loading = undefined;
      error = { message: m.message, ...(m.hint ? { hint: m.hint } : {}) };
      errorFor = l.fileId;
      port.disconnect();
      schedule();
    }
  });
  port.onDisconnect.addListener(() => {
    if (loading !== l) return;
    loading = undefined;
    error = { message: '读配音文件时断开了', hint: '在侧边栏「配音」页关掉再开启一次重试。' };
    errorFor = l.fileId;
    schedule();
  });
  port.postMessage({ type: 'open', videoId: rec.videoId, fileId: rec.fileId });
}

function finishLoad(l: Loading): void {
  loading = undefined;
  try {
    l.port.disconnect();
  } catch {
    // 已断开
  }
  if (l.received !== l.size) {
    error = { message: '配音文件没读全', hint: '在侧边栏「配音」页关掉再开启一次重试。' };
    errorFor = l.fileId;
    return schedule();
  }
  // 文件在关联时已检查过是 MP4 容器里的音频
  const url = URL.createObjectURL(new Blob(l.parts as BlobPart[], { type: 'audio/mp4' }));
  l.parts = [];
  const audio = new Audio();
  audio.preload = 'auto';
  audio.volume = 1;
  const ld: Loaded = { fileId: l.fileId, url, audio, ready: false };
  audio.addEventListener('loadedmetadata', () => {
    if (loaded !== ld) return;
    ld.ready = true;
    schedule();
  });
  audio.addEventListener('error', () => {
    if (loaded !== ld) return;
    error = { message: '浏览器放不了这个配音文件', hint: mediaErrorHint(audio.error) };
    errorFor = ld.fileId;
    unload();
    schedule();
  });
  audio.src = url;
  loaded = ld;
  schedule();
}

function playDub(audio: HTMLAudioElement): void {
  playPending = true;
  lastPlayTry = Date.now();
  audio.play().then(
    () => {
      playPending = false;
      autoplayBlocked = false;
      broadcast();
    },
    (e: unknown) => {
      playPending = false;
      // 页面还没被点过：浏览器不让出声。你在页面上点一下之后，下一次重试就会成功
      if ((e as { name?: string } | undefined)?.name === 'NotAllowedError') autoplayBlocked = true;
      broadcast();
    },
  );
}

function follow(v: HTMLVideoElement, audio: HTMLAudioElement, map: DubMap): void {
  const step = dubStep(
    { currentTime: v.currentTime, paused: v.paused, ended: v.ended, seeking: v.seeking, canPlay: v.readyState >= 3, rate: v.playbackRate, ad: adShowing() },
    { currentTime: audio.currentTime, paused: audio.paused, duration: audio.duration, rate: audio.playbackRate },
    map,
  );
  reason = step.reason;
  // 这一段中文快说完、或快到下一个对齐点：不等下一次例行检查，到点就停 / 接着放
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = undefined;
  if (step.wakeIn !== undefined && step.wakeIn * 1000 < DUB.tickMs * 1.5) {
    wakeTimer = setTimeout(schedule, Math.max(0, (step.wakeIn / Math.max(0.1, v.playbackRate)) * 1000) + 5);
  }
  if (step.rate !== undefined) audio.playbackRate = step.rate;
  if (step.seekTo !== undefined) audio.currentTime = step.seekTo;
  if (step.play) {
    if (audio.paused && !playPending && (!autoplayBlocked || Date.now() - lastPlayTry >= DUB.playRetryMs)) playDub(audio);
  } else if (!audio.paused) audio.pause();
}

// ── 原声音量 ──

function applyVolume(v: HTMLVideoElement | null, want: boolean): void {
  if (v !== duckVideo) {
    // 播放器换了 <video>：旧的恢复，新的从头认音量
    restoreVolume();
    duck.reset();
    duckVideo = v;
  }
  if (!v) return;
  duck.sync(v.volume, Date.now());
  const t = duck.target(want);
  if (t === undefined) return;
  if (Math.abs(v.volume - t) > DUB.volumeEps) v.volume = t;
  duck.wrote(t);
}

function restoreVolume(): void {
  if (!duckVideo || !duck.ducked) return;
  duck.sync(duckVideo.volume, Date.now());
  const t = duck.target(false);
  if (t !== undefined) {
    duckVideo.volume = t;
    duck.wrote(t);
  }
}

// ── 主循环 ──

function switchVideo(vid: string | null): void {
  videoId = vid;
  liveOffset = undefined;
  error = undefined;
  reason = undefined;
  autoplayBlocked = false;
  unload();
  restoreVolume();
  duck.reset();
  duckVideo = null;
}

function onVideoEvent(): void {
  schedule();
}

const VIDEO_EVENTS = ['play', 'playing', 'pause', 'seeking', 'seeked', 'ratechange', 'waiting', 'ended', 'volumechange', 'loadedmetadata', 'emptied'] as const;

function watchVideo(v: HTMLVideoElement | null): void {
  if (v === listenVideo) return;
  for (const e of VIDEO_EVENTS) listenVideo?.removeEventListener(e, onVideoEvent);
  listenVideo = v;
  for (const e of VIDEO_EVENTS) v?.addEventListener(e, onVideoEvent);
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    tick();
  });
}

function tick(): void {
  if (!alive()) return shutdown();
  if (!ready) return;
  const vid = videoIdFromUrl(location.href).videoId;
  if (vid !== videoId) switchVideo(vid);
  const rec = record();
  // 移除了，或换了文件：放下旧的（旧文件的错误也作废）
  if (!rec || (loaded && loaded.fileId !== rec.fileId) || (loading && loading.fileId !== rec.fileId)) unload();
  if (error && rec && errorFor !== rec.fileId) error = undefined;
  const active = !!rec && wantOn.has(rec.videoId);
  if (!active) {
    if (loaded && !loaded.audio.paused) loaded.audio.pause();
    reason = undefined;
  } else if (rec && !loaded && !loading && !error) startLoad(rec);
  const v = videoEl();
  watchVideo(v);
  const engaged = active && !!rec && !!loaded?.ready && !!v;
  if (engaged) follow(v!, loaded!.audio, mapOf(rec!));
  applyVolume(v, engaged && !adShowing());
  broadcast();
}

function tabState(): DubTabState {
  const rec = record();
  const active = !!rec && wantOn.has(rec.videoId);
  const v = videoEl();
  const map = rec ? mapOf(rec) : undefined;
  const at = v && Number.isFinite(v.currentTime) && !adShowing() ? v.currentTime : 0;
  const segment = map ? dubSegmentAt(map, at) : undefined;
  let phase: DubPhase;
  let status: string;
  if (!settings.enabled) {
    phase = 'disabled';
    status = '中文配音已在设置中关闭';
  } else if (!videoId) {
    phase = 'none';
    status = '这里不是视频播放页';
  } else if (!rec) {
    phase = 'none';
    status = '这个视频还没有关联中文配音';
  } else if (!active) {
    phase = 'off';
    status = '有中文配音，还没开启';
  } else if (error) {
    phase = 'error';
    status = error.message;
  } else if (loading || !loaded?.ready) {
    phase = 'loading';
    status = loading?.size ? `正在载入配音（${Math.floor((loading.received / loading.size) * 100)}%）` : '正在载入配音…';
  } else {
    phase = 'ready';
    status =
      autoplayBlocked && reason === 'playing'
        ? '浏览器拦下了配音的声音：在 YouTube 页面上点一下（例如暂停再播放），配音就会跟上'
        : reason
          ? dubReasonText(reason, segment ?? { offset: 0 })
          : '配音已就绪';
  }
  const audio = loaded?.ready ? loaded.audio : undefined;
  const title = videoId ? cleanVideoTitle(document.title) : '';
  return {
    videoId,
    enabled: settings.enabled,
    available: !!rec,
    ...(rec && map && segment ? { fileName: rec.fileName, delaySec: segment.offset, segment: { ...segment, count: map.anchors.length }, target: at - segment.offset } : {}),
    active,
    phase,
    status,
    ...(loading?.size ? { progress: Math.min(1, loading.received / loading.size) } : {}),
    playing: !!audio && !audio.paused && !playPending,
    ...(title ? { title } : {}),
    ...(v && Number.isFinite(v.duration) && v.duration > 0 && !adShowing()
      ? { videoTime: v.currentTime, videoDuration: v.duration, videoPlaying: !v.paused && !v.seeking && !v.ended, videoRate: v.playbackRate }
      : {}),
    ...(audio ? { dubTime: audio.currentTime, ...(Number.isFinite(audio.duration) ? { dubDuration: audio.duration } : {}) } : {}),
    ...(v && active ? { volume: { user: duck.userVolume ?? v.volume, now: v.volume, ducked: duck.ducked, blocked: duck.blocked, muted: v.muted } } : {}),
    ...(error && active ? { error } : {}),
  };
}

function broadcast(): void {
  if (!alive()) return;
  const s = tabState();
  // 播放位置一直在变：不为它推送（侧边栏每秒问一次）
  const { videoTime: _vt, dubTime: _dt, target: _tg, ...stable } = s;
  const key = JSON.stringify({ ...stable, ...(s.volume ? { volume: { ...s.volume, now: Math.round(s.volume.now * 100) } } : {}) });
  try {
    if (key !== lastState) {
      lastState = key;
      void chrome.runtime.sendMessage({ type: DUB_MSG.state, state: s }).catch(() => undefined);
    }
    const badge = JSON.stringify({ available: s.available && settings.prompt, active: s.active, playing: s.playing });
    if (badge !== lastBadge) {
      lastBadge = badge;
      void chrome.runtime.sendMessage({ type: DUB_MSG.badge, available: s.available && settings.prompt, active: s.active }).catch(() => undefined);
    }
  } catch {
    shutdown();
  }
}

/** 扩展被重新加载（这个脚本失效）：停下配音、恢复原声 */
function shutdown(): void {
  publishDubMix(undefined);
  if (timer) clearInterval(timer);
  timer = undefined;
  ready = false;
  unload();
  restoreVolume();
  watchVideo(null);
}

// ── 设置与对应关系（只读；写入都由侧边栏做）──

function applySettings(raw: unknown): void {
  const s = (raw as { dub?: Partial<DubSettings> } | undefined)?.dub;
  settings = { ...DEFAULT_SETTINGS.dub, ...(s ?? {}) };
}

void chrome.storage.local
  .get(['settings', 'dubs'])
  .then((r) => {
    applySettings(r.settings);
    index = sanitizeDubIndex(r.dubs);
  })
  .catch(() => undefined)
  .finally(() => {
    ready = true;
    timer = setInterval(tick, DUB.tickMs);
    tick();
  });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.settings && !changes.dubs)) return;
  if (changes.settings) applySettings(changes.settings.newValue);
  if (changes.dubs) {
    index = sanitizeDubIndex(changes.dubs.newValue);
    // 侧边栏存下了拖到的偏移（或别处改了对齐点）：以存下的为准
    liveOffset = undefined;
  }
  if (ready) tick();
});

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const msg = raw as { type?: string; on?: unknown; offset?: unknown; dubAt?: unknown; segment?: unknown; videoId?: unknown } | undefined;
  if (msg?.type === DUB_MSG.getState) {
    sendResponse(tabState());
    return false;
  }
  if (msg?.type === DUB_MSG.toggle) {
    const rec = record();
    if (rec) {
      const on = typeof msg.on === 'boolean' ? msg.on : !wantOn.has(rec.videoId);
      if (on) {
        wantOn.add(rec.videoId);
        error = undefined;
        autoplayBlocked = false;
        // 上次被 YouTube 挡住了降音量：重新开启时再试一次
        if (!duck.ducked) duck.reset();
      } else wantOn.delete(rec.videoId);
      tick();
    }
    sendResponse(tabState());
    return false;
  }
  // 拖动"中文位置"：某一段的实时偏移。给 dubAt 时按此刻的视频位置算（"现在应放中文的 dubAt 秒处"）
  if (msg?.type === DUB_MSG.setDelay) {
    const rec = record();
    const index = typeof msg.segment === 'number' && Number.isInteger(msg.segment) ? msg.segment : -1;
    const v = videoEl();
    if (rec && msg.videoId === rec.videoId && index >= -1 && index < (rec.anchors?.length ?? 0)) {
      const offset = typeof msg.dubAt === 'number' && Number.isFinite(msg.dubAt) && v ? v.currentTime - msg.dubAt : typeof msg.offset === 'number' ? msg.offset : undefined;
      if (offset !== undefined && Number.isFinite(offset)) {
        liveOffset = { videoId: rec.videoId, index, offset: clampDelay(offset) };
        tick();
      }
    }
    sendResponse(tabState());
    return false;
  }
  // 加对齐点：此刻的视频位置，和按此刻的偏移算出的中文位置（不跳：加完听到的和加之前一样，之后再单独调这一段）。
  // 正停在"这一段中文说完、等画面"时，中文位置取这一段的末尾，不越过下一个对齐点
  if (msg?.type === DUB_MSG.mark) {
    const rec = record();
    const v = videoEl();
    if (!rec || !v || adShowing() || !Number.isFinite(v.currentTime)) {
      sendResponse(undefined);
      return false;
    }
    const segment = dubSegmentAt(mapOf(rec), v.currentTime);
    let dub = Math.max(0, v.currentTime - segment.offset);
    if (segment.dubEnd !== undefined) dub = Math.min(dub, segment.dubEnd);
    const mark: DubMark = { video: v.currentTime, dub };
    sendResponse(mark);
    return false;
  }
  return false;
});

// 片段录制（DECISIONS §76）：配音开着、已载入时，把这个 <audio> 和原声此刻的倍数交给同一个隔离环境里的录制脚本，
// 录下的片段就是你听到的双语混音。这里不采集任何声音，只是让录制脚本拿得到这个元素
publishDubMix({
  audio: () => {
    const rec = ready ? record() : undefined;
    return rec && wantOn.has(rec.videoId) && loaded?.ready && loaded.fileId === rec.fileId ? loaded.audio : undefined;
  },
  originalGain: () => (duck.ducked ? DUB.originalVolume : 1),
});

// 离开页面（关标签页、刷新、跳到别的站）：先把原声恢复成你的音量；工具栏图标上的"中"也清掉（跳到别的站时它不会自己消失）
window.addEventListener('pagehide', () => {
  if (loaded && !loaded.audio.paused) loaded.audio.pause();
  restoreVolume();
  if (lastBadge && alive()) {
    try {
      void chrome.runtime.sendMessage({ type: DUB_MSG.badge, available: false, active: false }).catch(() => undefined);
    } catch {
      // 扩展已重新加载
    }
  }
  lastBadge = '';
});
// 从往返缓存里回来：重新报一次
window.addEventListener('pageshow', () => schedule());
