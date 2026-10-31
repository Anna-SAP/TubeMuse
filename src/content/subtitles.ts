// 注入 YouTube 播放页的自动字幕脚本（2026-11-01 用户批准的红线变更，见 DECISIONS §30）：
// 1. 只在视频播放时用 video.captureStream() 采集这个视频的音频，按停顿切成一句一句交给扩展后台转写、翻译；
//    不下载视频、不保存音频，本脚本不发任何网络请求（构建时自动检查）；广告、暂停、拖动时不采集。
// 2. 在播放器里叠加一层只读字幕（Shadow DOM 里的一个元素），不改动、不隐藏 YouTube 自己的任何元素；
//    侧边栏"字幕"页、快捷键或设置页都能关掉。
// 3. 只读取字幕按钮的提示文字判断有没有原生字幕；不读取页面上的文字内容。

import { DEFAULT_SETTINGS, SUBTITLES } from '../config/defaults';
import {
  SUBTITLE_PORT,
  Segmenter,
  bytesToBase64,
  encodeWav,
  isCovered,
  nativeCaptionsState,
  pickCue,
  upsertCue,
  type AudioSegment,
  type LiveCue,
  type NativeCaptions,
  type SubtitleDown,
  type SubtitleTabState,
} from '../core/subtitles';
import type { SubtitleCue } from '../core/types';
import { videoIdFromUrl } from '../core/watch';

type SubtitleSettings = typeof DEFAULT_SETTINGS.subtitles;

/** 致命错误（没有 Key、预算用完、模型名不对）后停下，过这么久或你改了设置再试（重试本身不花钱：后台先查再调用） */
const FATAL_RETRY_MS = 5 * 60_000;
const NOTICE_MS = 6_000;
const TICK_MS = 250;

let settings: SubtitleSettings = { ...DEFAULT_SETTINGS.subtitles };
let videoId: string | null = null;
let captions: NativeCaptions = 'unknown';
let cues: SubtitleCue[] = [];
let live: LiveCue | undefined;
const pending = new Set<number>();
let seq = 0;
/** 你对每个视频的手动选择（只在这个标签页里记住） */
const manual = new Map<string, 'on' | 'off'>();
let fatal: { message: string; hint?: string; at: number } | undefined;
let notice: { text: string; until: number } | undefined;
let lastState = '';

let port: chrome.runtime.Port | undefined;
let audio: { ac: AudioContext; node: ScriptProcessorNode; src: MediaStreamAudioSourceNode; track: MediaStreamTrack; video: HTMLVideoElement } | undefined;
let audioIdle = true;
/** 音轨还没就绪时隔一会儿再试，免得每轮都新建一个采集流 */
let nextCaptureAttempt = 0;
const segmenter = new Segmenter();
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

function readCaptions(): NativeCaptions {
  const b = playerEl()?.querySelector('.ytp-subtitles-button');
  if (!b || (b as HTMLElement).offsetParent === null) return 'unknown';
  return nativeCaptionsState({ tooltip: b.getAttribute('data-tooltip-title'), title: b.getAttribute('data-title-no-tooltip'), pressed: b.getAttribute('aria-pressed') });
}

function wantActive(): boolean {
  if (!settings.enabled || !videoId) return false;
  const m = manual.get(videoId);
  if (m === 'off') return false;
  if (fatal && Date.now() - fatal.at < FATAL_RETRY_MS) return false;
  return m === 'on' || (settings.autoStart && captions === 'unavailable');
}

// ── 与后台的连接 ──

function ensurePort(): chrome.runtime.Port | undefined {
  if (port) return port;
  try {
    port = chrome.runtime.connect({ name: SUBTITLE_PORT });
  } catch {
    teardown(); // 扩展被重新加载，旧脚本失效
    return undefined;
  }
  port.onMessage.addListener(onDown);
  port.onDisconnect.addListener(() => {
    port = undefined;
    pending.clear();
  });
  return port;
}

function post(msg: unknown): void {
  const p = ensurePort();
  try {
    p?.postMessage(msg);
  } catch {
    port = undefined;
  }
}

function onDown(raw: unknown): void {
  const m = raw as SubtitleDown;
  if (!m || m.videoId !== videoId) return;
  switch (m.type) {
    case 'track':
      for (const c of m.cues) cues = upsertCue(cues, c);
      break;
    case 'cue':
      cues = upsertCue(cues, m.cue);
      if (m.stage === 'source') live = { id: m.cue.id, arrivedAt: audio?.video.currentTime ?? videoEl()?.currentTime ?? 0 };
      break;
    case 'error':
      if (m.fatal) {
        fatal = { message: m.message, ...(m.hint ? { hint: m.hint } : {}), at: Date.now() };
        stopCapture(false);
      } else {
        notice = { text: m.message, until: Date.now() + NOTICE_MS };
      }
      break;
    case 'done':
      pending.delete(m.seq);
      break;
  }
  tick();
}

// ── 采音频 ──

function startCapture(video: HTMLVideoElement): void {
  let track: MediaStreamTrack | undefined;
  try {
    const stream = (video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
    // 只要声音：画面轨立刻停掉，不占资源
    for (const t of stream.getVideoTracks()) t.stop();
    [track] = stream.getAudioTracks();
  } catch {
    fatal = { message: '读不到这个视频的音频（可能是受版权保护的视频），无法生成字幕', at: Date.now() };
    return;
  }
  if (!track) {
    nextCaptureAttempt = Date.now() + 2_000; // 音轨还没就绪，稍后再试
    return;
  }
  const ac = new AudioContext({ sampleRate: SUBTITLES.sampleRate });
  const src = ac.createMediaStreamSource(new MediaStream([track]));
  // ScriptProcessorNode 已被标为过时，但不需要额外加载脚本文件（AudioWorklet 要从页面加载模块），Chrome 仍完整支持
  const node = ac.createScriptProcessor(4096, 1, 1);
  const mute = ac.createGain();
  mute.gain.value = 0; // 只取样本，不重复播放声音
  node.onaudioprocess = (e) => onAudio(e.inputBuffer.getChannelData(0));
  src.connect(node);
  node.connect(mute);
  mute.connect(ac.destination);
  audio = { ac, node, src, track, video };
  audioIdle = true;
  if (ac.state === 'suspended') void ac.resume().catch(() => undefined);
  post({ type: 'hello', videoId });
}

/** sendRest=false：后台已经拒绝（没有 Key、预算用完），手里没说完的那句直接丢掉 */
function stopCapture(sendRest = true): void {
  if (!audio) return;
  const rest = segmenter.flush();
  if (sendRest) for (const s of rest) sendSegment(s);
  const a = audio;
  audio = undefined;
  a.node.onaudioprocess = null;
  try {
    a.src.disconnect();
    a.node.disconnect();
  } catch {
    // 已断开
  }
  a.track.stop(); // 只停掉我们拿到的这条采集音轨，不影响视频播放
  void a.ac.close().catch(() => undefined);
}

function onAudio(samples: Float32Array): void {
  const a = audio;
  if (!a) return;
  const v = a.video;
  if (v.paused || v.seeking || v.ended || adShowing() || !v.playbackRate || v !== videoEl()) {
    if (!audioIdle) for (const s of segmenter.flush()) sendSegment(s);
    audioIdle = true;
    return;
  }
  audioIdle = false;
  for (const s of segmenter.push({ samples, videoTime: v.currentTime, rate: v.playbackRate })) sendSegment(s);
}

function sendSegment(s: AudioSegment): void {
  if (!videoId || isCovered(cues, s.start, s.end)) return;
  const n = ++seq;
  pending.add(n);
  post({ type: 'segment', videoId, seq: n, start: s.start, end: s.end, audio: bytesToBase64(encodeWav(s.samples, SUBTITLES.sampleRate)) });
}

// ── 字幕层 ──

const CSS = `
:host { all: initial; position: absolute; inset: 0; pointer-events: none; z-index: 38; }
.wrap { position: absolute; left: 0; right: 0; bottom: var(--bottom, 48px); display: flex; flex-direction: column; align-items: center; gap: 0.18em; padding: 0 4%; transition: bottom 0.2s ease; font-size: var(--fs, 20px); }
.wrap[hidden] { display: none; }
.line { max-width: 92%; box-sizing: border-box; text-align: center; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.35; padding: 0.08em 0.45em; border-radius: 0.2em; background: rgba(8, 8, 8, 0.72); color: #fff; font-family: "YouTube Noto", Roboto, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Noto Sans JP", sans-serif; text-shadow: 0 0 2px rgba(0, 0, 0, 0.6); }
.line:empty { display: none; }
.tr { color: #ffe7a3; font-size: 0.88em; }
.late .line { opacity: 0.9; }
.status { position: absolute; top: 10px; left: 10px; max-width: min(60%, 420px); font: 12px/1.45 Roboto, "Noto Sans SC", "Microsoft YaHei", sans-serif; color: #fff; background: rgba(0, 0, 0, 0.66); padding: 4px 8px; border-radius: 4px; }
.status[hidden] { display: none; }
.status .hint { opacity: 0.8; }
`;

let overlay: { host: HTMLElement; wrap: HTMLElement; src: HTMLElement; tr: HTMLElement; status: HTMLElement; statusMain: HTMLElement; statusHint: HTMLElement } | undefined;

function ensureOverlay(player: HTMLElement): NonNullable<typeof overlay> {
  if (overlay && overlay.host.parentElement === player) return overlay;
  overlay?.host.remove();
  const host = document.createElement('div');
  host.setAttribute('data-tubemuse', 'subtitles');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  const src = document.createElement('div');
  src.className = 'line src';
  const tr = document.createElement('div');
  tr.className = 'line tr';
  wrap.append(src, tr);
  const status = document.createElement('div');
  status.className = 'status';
  const statusMain = document.createElement('div');
  const statusHint = document.createElement('div');
  statusHint.className = 'hint';
  status.append(statusMain, statusHint);
  shadow.append(style, wrap, status);
  player.append(host);
  overlay = { host, wrap, src, tr, status, statusMain, statusHint };
  return overlay;
}

function removeOverlay(): void {
  overlay?.host.remove();
  overlay = undefined;
}

function statusLine(active: boolean): { text: string; hint?: string } | undefined {
  if (fatal && videoId && settings.enabled && manual.get(videoId) !== 'off') return { text: `TubeMuse 字幕已停止：${fatal.message}`, ...(fatal.hint ? { hint: fatal.hint } : {}) };
  if (!active) return undefined;
  if (notice && Date.now() < notice.until) return { text: `TubeMuse 字幕：${notice.text}` };
  if (audio?.ac.state === 'suspended') return { text: 'TubeMuse 字幕：点一下视频即可开始（浏览器要求页面先有一次点击才能处理声音）' };
  const latest = cues.find((c) => c.id === live?.id);
  if (latest?.translationError) return { text: `第二行未翻译：${latest.translationError}` };
  if (!cues.some((c) => c.text)) return { text: pending.size ? 'TubeMuse 字幕：识别中…' : 'TubeMuse 字幕：正在听…（字幕会比说话晚几秒出现）' };
  return undefined;
}

function render(active: boolean): void {
  const player = playerEl();
  const video = videoEl();
  const status = statusLine(active);
  if (!player || !video || (!active && !status)) return removeOverlay();
  const o = ensureOverlay(player);
  const view = active && !adShowing() ? pickCue(cues, video.currentTime, live) : undefined;
  const source = view?.cue.text ?? '';
  const translation = view?.cue.translation ?? '';
  o.src.textContent = settings.showSource || !translation ? source : '';
  o.tr.textContent = translation;
  o.wrap.hidden = !view;
  o.wrap.classList.toggle('late', !!view?.late);
  const h = player.clientHeight || 360;
  const fs = Math.min(38, Math.max(13, h * 0.042)) * (settings.fontScale || 1);
  const controls = player.classList.contains('ytp-autohide') ? 0 : (player.querySelector('.ytp-chrome-bottom') as HTMLElement | null)?.offsetHeight ?? 48;
  o.host.style.setProperty('--fs', `${fs.toFixed(1)}px`);
  o.host.style.setProperty('--bottom', `${Math.round(controls ? controls + 12 : Math.max(12, h * 0.05))}px`);
  o.status.hidden = !status;
  o.statusMain.textContent = status?.text ?? '';
  o.statusHint.textContent = status?.hint ?? '';
}

// ── 状态 ──

function tabState(): SubtitleTabState {
  const active = !!audio;
  const st = statusLine(active);
  const m = videoId ? manual.get(videoId) : undefined;
  let status: string;
  if (!videoId) status = '这个页面不是视频播放页';
  else if (!settings.enabled) status = '自动字幕已在设置中关闭';
  else if (fatal && m !== 'off' && Date.now() - fatal.at < FATAL_RETRY_MS) status = `已停止：${fatal.message}`;
  else if (active) status = st?.text.replace(/^TubeMuse 字幕：/, '') ?? '正在出字幕';
  else if (m === 'off') status = '你已关闭这个视频的字幕';
  else if (captions === 'available') status = '这个视频有原生字幕，不自动生成';
  else if (captions === 'unknown') status = '还没判断出有没有原生字幕（广告结束、视频开始播放后再看）；可以手动开启';
  else if (!settings.autoStart) status = '没有原生字幕；"自动开启"已关闭，可以手动开启';
  else status = '准备中…';
  return {
    videoId,
    captions,
    active,
    ...(m ? { manual: m } : {}),
    status,
    cues: cues.filter((c) => c.text).length,
    pending: pending.size,
    ...(fatal && Date.now() - fatal.at < FATAL_RETRY_MS ? { error: { message: fatal.message, ...(fatal.hint ? { hint: fatal.hint } : {}) } } : {}),
  };
}

function broadcast(): void {
  const s = tabState();
  const key = JSON.stringify(s);
  if (key === lastState) return;
  lastState = key;
  try {
    void chrome.runtime.sendMessage({ type: 'tubemuse:subtitles:state', state: s }).catch(() => undefined);
  } catch {
    teardown();
  }
}

function switchVideo(next: string | null): void {
  stopCapture();
  videoId = next;
  captions = 'unknown';
  cues = [];
  live = undefined;
  pending.clear();
  notice = undefined;
  nextCaptureAttempt = 0;
  if (fatal && Date.now() - fatal.at >= FATAL_RETRY_MS) fatal = undefined;
}

function tick(): void {
  if (!alive()) return teardown();
  const { videoId: vid, shorts } = videoIdFromUrl(location.href);
  const next = shorts ? null : vid;
  if (next !== videoId) switchVideo(next);
  if (fatal && Date.now() - fatal.at >= FATAL_RETRY_MS) fatal = undefined;
  const video = videoEl();
  if (videoId && video && !adShowing() && video.readyState >= 2) {
    const c = readCaptions();
    if (c !== 'unknown') captions = c;
  }
  const want = wantActive();
  if (audio && (!want || audio.video !== video || audio.track.readyState === 'ended')) stopCapture();
  if (want && !audio && video && Date.now() >= nextCaptureAttempt) startCapture(video);
  render(!!audio);
  broadcast();
}

function teardown(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  try {
    stopCapture();
  } catch {
    // 忽略
  }
  removeOverlay();
}

function applySettings(raw: unknown): void {
  const s = (raw as { subtitles?: Partial<SubtitleSettings> } | undefined)?.subtitles;
  settings = { ...DEFAULT_SETTINGS.subtitles, ...(s ?? {}) };
  fatal = undefined; // 改了设置（例如调高预算、换模型）就重新试
}

void chrome.storage.local
  .get('settings')
  .then((r) => applySettings(r.settings))
  .catch(() => undefined);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) applySettings(changes.settings.newValue);
  // 填写了 Key：只当作"可以重试"的信号，不读取内容
  if (changes.secrets) fatal = undefined;
});

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const msg = raw as { type?: string; on?: unknown } | undefined;
  if (msg?.type === 'tubemuse:subtitles:get-state') {
    sendResponse(tabState());
    return false;
  }
  if (msg?.type === 'tubemuse:subtitles:toggle' && videoId) {
    const on = typeof msg.on === 'boolean' ? msg.on : !audio;
    manual.set(videoId, on ? 'on' : 'off');
    fatal = undefined;
    tick();
    sendResponse(tabState());
    return false;
  }
  return false;
});

// 页面还没有过点击时浏览器会挂起 AudioContext：借你的下一次点击恢复（只恢复，不拦截这次点击）
document.addEventListener(
  'pointerdown',
  () => {
    if (audio?.ac.state === 'suspended') void audio.ac.resume().catch(() => undefined);
  },
  true,
);

timer = setInterval(tick, TICK_MS);
tick();
