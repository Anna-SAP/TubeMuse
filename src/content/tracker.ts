// 注入 YouTube 页面的观看追踪脚本。红线：只读取本地播放器状态（播放进度、时长、暂停、倍速、是否广告、标签页是否可见）
// 与地址栏里的视频 ID；不读取页面文字内容、不改动页面、不发任何网络请求——只把累计数据交给扩展后台。
// 视频标题、频道等元数据由后台经官方 YouTube Data API 获取。

import { WATCH } from '../config/defaults';
import { stepTracker, videoIdFromUrl, type PlaybackSample, type TrackerState } from '../core/watch';
import type { WatchSession } from '../core/types';

let enabled = true;
let state: TrackerState = {};
let lastFlush = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function alive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function send(session: WatchSession | undefined) {
  if (!session || session.playSec <= 0 || !alive()) return;
  try {
    void chrome.runtime.sendMessage({ type: 'tubemuse:watch', session }).catch(() => undefined);
  } catch {
    stop(); // 扩展被重新加载，旧脚本失效
  }
}

function pickVideo(): HTMLVideoElement | null {
  const videos = [...document.querySelectorAll('video')];
  return (
    videos.find((v) => !v.paused && v.readyState >= 2) ??
    (document.querySelector('#movie_player video') as HTMLVideoElement | null) ??
    videos.find((v) => v.readyState >= 1) ??
    null
  );
}

function readSample(): PlaybackSample {
  const { videoId, shorts } = videoIdFromUrl(location.href);
  const video = pickVideo();
  const player = document.getElementById('movie_player');
  const isAd = !!player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'));
  return {
    t: Date.now(),
    videoId: video ? videoId : null,
    currentTime: video?.currentTime ?? 0,
    duration: video?.duration ?? 0,
    paused: !video || video.paused || video.readyState < 2,
    ended: !!video?.ended,
    rate: video?.playbackRate ?? 1,
    isAd,
    visible: document.visibilityState === 'visible',
    shorts,
  };
}

function tick() {
  if (!alive()) return stop();
  if (!enabled) return;
  const r = stepTracker(state, readSample(), () => crypto.randomUUID());
  state = r.state;
  if (r.finished) send(r.finished);
  if (state.session && Date.now() - lastFlush >= WATCH.flushEveryMs) {
    send(state.session);
    lastFlush = Date.now();
  }
}

function flush() {
  send(state.session);
  lastFlush = Date.now();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

function applySettings(settings: unknown) {
  const tracking = (settings as { tracking?: { enabled?: boolean } } | undefined)?.tracking;
  const next = tracking?.enabled !== false;
  if (enabled && !next) {
    flush();
    state = {};
  }
  enabled = next;
}

void chrome.storage.local.get('settings').then((r) => applySettings(r.settings)).catch(() => undefined);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) applySettings(changes.settings.newValue);
});
timer = setInterval(tick, WATCH.tickMs);
document.addEventListener('visibilitychange', () => {
  tick();
  if (document.visibilityState === 'hidden') flush();
});
window.addEventListener('pagehide', flush);
