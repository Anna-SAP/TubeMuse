// 注入 YouTube 播放页的自动字幕脚本（用户批准的红线变更，见 DECISIONS §30、§32）：
// 1. 只在视频播放时用 video.captureStream() 拿到这个视频的音轨；不下载视频、不保存音频，本脚本不发任何网络请求
//    （构建时自动检查）；广告、暂停、拖动时不识别。转写方式二选一（设置页可改）：
//    - 浏览器识别（默认）：把音轨交给浏览器自带的语音识别；装了本地语音包时在本机识别，否则由 Chrome 发往 Google；
//      识别出的文字整理成一行一行，交给扩展后台存下、翻译。
//    - OpenAI：按停顿切成一句一句的音频，交给扩展后台发往 OpenAI 转写。
// 2. 在播放器里叠加一层只读字幕（Shadow DOM 里的一个元素），不改动、不隐藏 YouTube 自己的任何元素；
//    侧边栏"字幕"页、快捷键或设置页都能关掉。
// 3. 只读取字幕按钮的提示文字判断有没有原生字幕；不读取页面上的文字内容。

import { DEFAULT_SETTINGS, SUBTITLES } from '../config/defaults';
import {
  LiveTranscript,
  RECOGNITION_MODE_LABELS,
  SUBTITLE_PORT,
  Segmenter,
  bytesToBase64,
  encodeWav,
  isCovered,
  liveView,
  nativeCaptionsState,
  pickCue,
  speechErrorInfo,
  speechLangName,
  upsertCue,
  type AudioSegment,
  type LiveCue,
  type LiveLine,
  type NativeCaptions,
  type RecognitionPlan,
  type SubtitleDown,
  type SubtitleTabState,
} from '../core/subtitles';
import type { SubtitleCue } from '../core/types';
import { videoIdFromUrl } from '../core/watch';
import type { RecognitionLike } from '../services/speech';
import { speechRecognitionCtor } from './speech-engine';

type SubtitleSettings = typeof DEFAULT_SETTINGS.subtitles;

/** 致命错误（没有 Key、预算用完、模型名不对、识别服务连不上）后停下，过这么久或你改了设置再试 */
const FATAL_RETRY_MS = 5 * 60_000;
const NOTICE_MS = 6_000;
const TICK_MS = 250;
/** 要求识别器结束后这么久还没收到 onend，就当它已经结束 */
const STOP_GRACE_MS = 3_000;

let settings: SubtitleSettings = { ...DEFAULT_SETTINGS.subtitles };
/** 读到你保存的设置之前不开始采集（否则可能按默认的转写方式开始） */
let settingsLoaded = false;
let videoId: string | null = null;
let captions: NativeCaptions = 'unknown';
let cues: SubtitleCue[] = [];
/** OpenAI 转写：最新一句是在视频播到哪里时送到的（第一次观看时字幕晚于语音） */
let live: LiveCue | undefined;
const pending = new Set<number>();
let seq = 0;
/** 你对每个视频的手动选择（只在这个标签页里记住） */
const manual = new Map<string, 'on' | 'off'>();
/** 你在侧边栏给每个视频选的识别语言 */
const langOverride = new Map<string, string>();
let fatal: { message: string; hint?: string; at: number } | undefined;
let notice: { text: string; hint?: string; until: number } | undefined;
/** 被限流：到这个时刻之前不再送片段（这期间的句子跳过，拖回去重看时会补上） */
let backoffUntil = 0;
let lastState = '';
/** 设置里换了转写方式或识别语言：下一轮重新开始采集 */
let restartCapture = false;

let port: chrome.runtime.Port | undefined;

interface OpenAiCapture {
  engine: 'openai';
  video: HTMLVideoElement;
  track: MediaStreamTrack;
  startedAt: number;
  ac: AudioContext;
  node: ScriptProcessorNode;
  src: MediaStreamAudioSourceNode;
}

interface BrowserCapture {
  engine: 'browser';
  video: HTMLVideoElement;
  track: MediaStreamTrack;
  startedAt: number;
  /** 识别语言：等后台回话（自动时它会查视频的语言） */
  plan?: RecognitionPlan;
  rec?: RecognitionLike;
  mode?: 'local' | 'cloud';
  starting: boolean;
  stopRequestedAt?: number;
  /** 本地语音包这次用不了：之后改用云端 */
  localFailed: boolean;
  transcript: LiveTranscript;
  resultIndex: number;
  sessionStartedAt: number;
  restartAt: number;
  failures: number;
  wasPlaying: boolean;
  lastTime: number;
  lastWall: number;
}

type Capture = OpenAiCapture | BrowserCapture;

let capture: Capture | undefined;
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

function fatalActive(): boolean {
  return !!fatal && Date.now() - fatal.at < FATAL_RETRY_MS;
}

function wantActive(): boolean {
  if (!settingsLoaded || !settings.enabled || !videoId) return false;
  const m = manual.get(videoId);
  if (m === 'off') return false;
  if (fatalActive()) return false;
  return m === 'on' || (settings.autoStartNoCaptions && captions === 'unavailable');
}

function setNotice(text: string, hint?: string): void {
  notice = { text, ...(hint ? { hint } : {}), until: Date.now() + NOTICE_MS };
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
    case 'track': {
      for (const c of m.cues) cues = upsertCue(cues, c);
      const c = capture;
      if (c?.engine === 'browser' && !c.plan) {
        const override = langOverride.get(m.videoId);
        c.plan = override ? { lang: override, source: 'manual' } : (m.recognition ?? { lang: 'zh-CN', source: 'default' });
      }
      break;
    }
    case 'cue':
      cues = upsertCue(cues, m.cue);
      if (m.stage === 'source' && capture?.engine === 'openai') live = { id: m.cue.id, arrivedAt: capture.video.currentTime };
      break;
    case 'error':
      if (m.fatal) {
        fatal = { message: m.message, ...(m.hint ? { hint: m.hint } : {}), at: Date.now() };
        stopCapture(false);
      } else {
        if (m.retryAfterMs) backoffUntil = Math.max(backoffUntil, Date.now() + m.retryAfterMs);
        notice = { text: m.message, ...(m.hint ? { hint: m.hint } : {}), until: m.retryAfterMs ? backoffUntil : Date.now() + NOTICE_MS }; // 限流提示随暂停结束一起消失
      }
      break;
    case 'done':
      pending.delete(m.seq);
      break;
  }
  tick();
}

// ── 采集 ──

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
  if (settings.asrEngine === 'openai') {
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
    capture = { engine: 'openai', video, track, startedAt: Date.now(), ac, node, src };
    audioIdle = true;
    if (ac.state === 'suspended') void ac.resume().catch(() => undefined);
  } else {
    capture = {
      engine: 'browser',
      video,
      track,
      startedAt: Date.now(),
      starting: false,
      localFailed: false,
      transcript: new LiveTranscript(),
      resultIndex: -1,
      sessionStartedAt: 0,
      restartAt: 0,
      failures: 0,
      wasPlaying: false,
      lastTime: video.currentTime,
      lastWall: Date.now(),
    };
  }
  post({ type: 'hello', videoId });
}

/** sendRest=false：后台已经拒绝（没有 Key、预算用完），手里没说完的那句直接丢掉 */
function stopCapture(sendRest = true): void {
  const c = capture;
  if (!c) return;
  capture = undefined;
  if (c.engine === 'openai') {
    const rest = segmenter.flush();
    if (sendRest) for (const s of rest) sendSegment(s);
    c.node.onaudioprocess = null;
    try {
      c.src.disconnect();
      c.node.disconnect();
    } catch {
      // 已断开
    }
    void c.ac.close().catch(() => undefined);
  } else {
    const rest = c.transcript.flush(c.video.currentTime);
    if (sendRest) sendLines(rest, c);
    const rec = c.rec;
    c.rec = undefined;
    try {
      rec?.abort();
    } catch {
      // 已结束
    }
  }
  c.track.stop(); // 只停掉我们拿到的这条采集音轨，不影响视频播放
}

// ── OpenAI：切段上传 ──

function onAudio(samples: Float32Array): void {
  const c = capture;
  if (c?.engine !== 'openai') return;
  const v = c.video;
  if (v.paused || v.seeking || v.ended || adShowing() || !v.playbackRate || v !== videoEl()) {
    if (!audioIdle) for (const s of segmenter.flush()) sendSegment(s);
    audioIdle = true;
    return;
  }
  audioIdle = false;
  for (const s of segmenter.push({ samples, videoTime: v.currentTime, rate: v.playbackRate })) sendSegment(s);
}

function sendSegment(s: AudioSegment): void {
  if (!videoId || Date.now() < backoffUntil || isCovered(cues, s.start, s.end)) return;
  const n = ++seq;
  pending.add(n);
  post({ type: 'segment', videoId, seq: n, start: s.start, end: s.end, audio: bytesToBase64(encodeWav(s.samples, SUBTITLES.sampleRate)) });
}

// ── 浏览器识别 ──

function restartDelay(failures: number): number {
  return Math.min(SUBTITLES.recognitionRestartMaxMs, SUBTITLES.recognitionRestartBaseMs * 2 ** Math.max(0, failures - 1));
}

/** 识别出的行先放进本地（马上能显示），再交给后台存下、翻译 */
function sendLines(lines: LiveLine[], c: BrowserCapture): void {
  if (!videoId) return;
  for (const l of lines) {
    if (isCovered(cues, l.start, l.end)) continue;
    const lang = c.plan?.lang;
    cues = upsertCue(cues, { id: `${videoId}:${Math.round(l.start * 1000)}`, start: l.start, end: l.end, text: l.text, ...(lang ? { lang } : {}), createdAt: Date.now() });
    const n = ++seq;
    pending.add(n);
    post({ type: 'text', videoId, seq: n, start: l.start, end: l.end, text: l.text, ...(lang ? { lang } : {}) });
  }
}

async function startRecognition(c: BrowserCapture): Promise<void> {
  c.starting = true;
  try {
    const R = speechRecognitionCtor();
    if (!R) {
      fatal = { message: '这个浏览器没有语音识别功能', hint: '可以在设置页「12. 自动字幕」把转写方式改成 OpenAI', at: Date.now() };
      return;
    }
    const lang = c.plan!.lang;
    let mode: 'local' | 'cloud' = 'cloud';
    if (settings.browserPreferLocal && !c.localFailed && typeof R.available === 'function') {
      try {
        if ((await R.available({ langs: [lang], processLocally: true })) === 'available') mode = 'local';
      } catch {
        // 查不到就用云端
      }
    }
    if (capture !== c || c.track.readyState !== 'live') return;
    const rec = new R();
    rec.lang = c.plan!.lang; // 等待期间你可能换了语言
    rec.continuous = true;
    rec.interimResults = true;
    if (mode === 'local') rec.processLocally = true;
    rec.onresult = (e) => onSpeechResult(c, rec, e);
    rec.onerror = (e) => onSpeechError(c, rec, e.error);
    rec.onend = () => onSpeechEnd(c, rec);
    try {
      rec.start(c.track);
    } catch (e) {
      c.failures++;
      c.restartAt = Date.now() + restartDelay(c.failures);
      setNotice(`语音识别没能开始（${e instanceof Error ? e.name : '未知原因'}），稍后自动重试`);
      return;
    }
    c.rec = rec;
    c.mode = mode;
    delete c.stopRequestedAt;
    c.sessionStartedAt = Date.now();
    c.resultIndex = -1;
  } finally {
    c.starting = false;
  }
}

function onSpeechResult(c: BrowserCapture, rec: RecognitionLike, e: Parameters<NonNullable<RecognitionLike['onresult']>>[0]): void {
  if (c.rec !== rec) return;
  const v = c.video;
  for (let i = e.resultIndex; i < e.results.length; i++) {
    const r = e.results[i]!;
    if (i !== c.resultIndex) {
      sendLines(c.transcript.flush(v.currentTime), c);
      c.resultIndex = i;
    }
    sendLines(c.transcript.update(r[0].transcript, r.isFinal, v.currentTime, v.playbackRate, Date.now()), c);
  }
  c.failures = 0;
}

function onSpeechError(c: BrowserCapture, rec: RecognitionLike, code: string): void {
  if (c.rec !== rec) return;
  const info = speechErrorInfo(code, c.mode ?? 'cloud', c.plan?.lang ?? '');
  if (!info) return;
  if (info.retryCloud) {
    c.localFailed = true;
    setNotice(info.message);
    return;
  }
  if (info.fatal) fatal = { message: info.message, ...(info.hint ? { hint: info.hint } : {}), at: Date.now() };
  else setNotice(info.message);
}

function onSpeechEnd(c: BrowserCapture, rec: RecognitionLike): void {
  if (c.rec !== rec) return;
  sendLines(c.transcript.flush(c.video.currentTime), c);
  c.rec = undefined;
  // 很快就结束（连不上、被拒）：等一会儿再试，越来越久；正常说完一段：马上接着识别
  if (Date.now() - c.sessionStartedAt < 3_000 && !c.stopRequestedAt) {
    c.failures++;
    c.restartAt = Date.now() + restartDelay(c.failures);
  } else {
    c.restartAt = Date.now();
  }
  delete c.stopRequestedAt;
}

/** 暂停、广告：让识别器把手里的说完再结束；拖动、换语言：直接丢掉（声音属于之前的位置） */
function stopRecognition(c: BrowserCapture, how: 'stop' | 'abort'): void {
  const rec = c.rec;
  if (!rec || c.stopRequestedAt) return;
  c.stopRequestedAt = Date.now();
  if (how === 'abort') c.transcript.reset();
  try {
    if (how === 'abort') rec.abort();
    else rec.stop();
  } catch {
    c.rec = undefined;
  }
}

function tickBrowser(c: BrowserCapture, video: HTMLVideoElement): void {
  const now = Date.now();
  const playing = !video.paused && !video.ended && !video.seeking && !adShowing() && video.readyState >= 2 && video.playbackRate > 0;
  const expected = c.lastTime + ((now - c.lastWall) / 1000) * video.playbackRate;
  const jumped = c.wasPlaying && playing && Math.abs(video.currentTime - expected) > SUBTITLES.seekToleranceSec;
  c.wasPlaying = playing;
  c.lastTime = video.currentTime;
  c.lastWall = now;
  if (c.rec) {
    if (video.seeking || jumped) stopRecognition(c, 'abort');
    else if (!playing) stopRecognition(c, 'stop');
    else sendLines(c.transcript.poll(video.currentTime, now), c);
    if (c.stopRequestedAt && now - c.stopRequestedAt > STOP_GRACE_MS) {
      c.rec = undefined; // 识别器没回 onend：不等了
      delete c.stopRequestedAt;
    }
  }
  if (playing && !c.rec && !c.starting && c.plan && now >= c.restartAt && !fatalActive()) void startRecognition(c);
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

/** 这次采集开始后才识别出的字幕（浏览器识别时屏幕上的"即时"内容）；在这之前就有的是回看 */
function sessionCues(c: Capture): SubtitleCue[] {
  return cues.filter((x) => x.createdAt >= c.startedAt);
}

function statusLine(active: boolean): { text: string; hint?: string } | undefined {
  if (fatal && videoId && settings.enabled && manual.get(videoId) !== 'off') return { text: `TubeMuse 字幕已停止：${fatal.message}`, ...(fatal.hint ? { hint: fatal.hint } : {}) };
  const c = capture;
  if (!active || !c) return undefined;
  if (Date.now() < backoffUntil && notice) {
    return { text: `TubeMuse 字幕：${notice.text}（${Math.ceil((backoffUntil - Date.now()) / 1000)} 秒后自动继续）`, hint: '暂停期间不发请求；这期间的句子先跳过，拖回去重看时会补上' };
  }
  if (notice && Date.now() < notice.until) return { text: `TubeMuse 字幕：${notice.text}`, ...(notice.hint ? { hint: notice.hint } : {}) };
  if (c.engine === 'openai' && c.ac.state === 'suspended') return { text: 'TubeMuse 字幕：点一下视频即可开始（浏览器要求页面先有一次点击才能处理声音）' };
  const mine = sessionCues(c);
  const latest = mine.reduce<SubtitleCue | undefined>((a, x) => (!a || x.createdAt >= a.createdAt ? x : a), undefined);
  if (latest?.translationError) return { text: `第二行未翻译：${latest.translationError}` };
  if (c.engine === 'browser') {
    if (!c.plan) return { text: 'TubeMuse 字幕：准备中…' };
    if (!mine.some((x) => x.text) && !c.transcript.tail && c.rec) {
      return { text: `TubeMuse 字幕：正在听…（${speechLangName(c.plan.lang)} · ${RECOGNITION_MODE_LABELS[c.mode ?? 'cloud']}）`, ...(c.plan.note ? { hint: c.plan.note } : {}) };
    }
    return undefined;
  }
  if (!cues.some((x) => x.text)) return { text: pending.size ? 'TubeMuse 字幕：识别中…' : 'TubeMuse 字幕：正在听…（字幕会比说话晚几秒出现）' };
  return undefined;
}

/** 当前该显示的两行 */
function currentLines(c: Capture, t: number): { source: string; translation: string; late?: boolean } | undefined {
  if (c.engine === 'openai') {
    const view = pickCue(cues, t, live);
    return view ? { source: view.cue.text, translation: view.cue.translation ?? '', late: view.late } : undefined;
  }
  // 回看：以前生成的字幕按时间轴显示；正在识别的部分滚动显示刚听到的字
  const replay = pickCue(
    cues.filter((x) => x.createdAt < c.startedAt),
    t,
    undefined,
  );
  if (replay) return { source: replay.cue.text, translation: replay.cue.translation ?? '' };
  return liveView(sessionCues(c), c.transcript.tail, t);
}

function render(): void {
  const player = playerEl();
  const video = videoEl();
  const c = capture;
  const active = !!c;
  const status = statusLine(active);
  if (!player || !video || (!active && !status)) return removeOverlay();
  const o = ensureOverlay(player);
  const lines = c && !adShowing() ? currentLines(c, video.currentTime) : undefined;
  const source = lines?.source ?? '';
  const translation = lines?.translation ?? '';
  o.src.textContent = settings.showSource || !translation ? source : '';
  o.tr.textContent = translation;
  o.wrap.hidden = !lines;
  o.wrap.classList.toggle('late', !!lines?.late);
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
  const c = capture;
  const active = !!c;
  const st = statusLine(active);
  const m = videoId ? manual.get(videoId) : undefined;
  let status: string;
  if (!videoId) status = '这个页面不是视频播放页';
  else if (!settings.enabled) status = '自动字幕已在设置中关闭';
  else if (fatalActive() && m !== 'off') status = `已停止：${fatal!.message}`;
  else if (active) status = st?.text.replace(/^TubeMuse 字幕：/, '') ?? '正在出字幕';
  else if (m === 'off') status = '你已关闭这个视频的字幕';
  else if (!settings.autoStartNoCaptions) status = '未开启（字幕默认关闭）：点"为这个视频生成字幕"或按 Alt+Shift+S';
  else if (captions === 'available') status = '这个视频有原生字幕，不自动生成';
  else if (captions === 'unknown') status = '还没判断出有没有原生字幕（广告结束、视频开始播放后再看）；可以手动开启';
  else status = '准备中…';
  const recognition: SubtitleTabState['recognition'] =
    c?.engine === 'browser' && c.plan
      ? { lang: c.plan.lang, source: c.plan.source, ...(c.mode ? { mode: c.mode } : {}), ...(c.plan.note ? { note: c.plan.note } : {}) }
      : c?.engine === 'openai'
        ? { lang: '', source: 'setting', mode: 'openai' }
        : undefined;
  return {
    videoId,
    captions,
    engine: c?.engine ?? settings.asrEngine,
    ...(recognition ? { recognition } : {}),
    active,
    ...(m ? { manual: m } : {}),
    status,
    cues: cues.filter((x) => x.text).length,
    pending: pending.size,
    ...(fatalActive() ? { error: { message: fatal!.message, ...(fatal!.hint ? { hint: fatal!.hint } : {}) } } : {}),
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
  backoffUntil = 0;
  if (fatal && !fatalActive()) fatal = undefined;
}

function tick(): void {
  if (!alive()) return teardown();
  const { videoId: vid, shorts } = videoIdFromUrl(location.href);
  const next = shorts ? null : vid;
  if (next !== videoId) switchVideo(next);
  if (fatal && !fatalActive()) fatal = undefined;
  const video = videoEl();
  if (videoId && video && !adShowing() && video.readyState >= 2) {
    const c = readCaptions();
    if (c !== 'unknown') captions = c;
  }
  const want = wantActive();
  if (capture && (restartCapture || !want || capture.video !== video || capture.track.readyState === 'ended')) stopCapture();
  restartCapture = false;
  if (want && !capture && video && Date.now() >= nextCaptureAttempt) startCapture(video);
  if (capture?.engine === 'browser' && video) tickBrowser(capture, video);
  render();
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
  const next = { ...DEFAULT_SETTINGS.subtitles, ...(s ?? {}) };
  if (next.asrEngine !== settings.asrEngine || next.browserLang !== settings.browserLang || next.browserPreferLocal !== settings.browserPreferLocal) restartCapture = true;
  settings = next;
  fatal = undefined; // 改了设置（例如调高预算、换模型、换转写方式）就重新试
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
  // 填写了 Key：只当作"可以重试"的信号，不读取内容
  if (changes.secrets) fatal = undefined;
});

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const msg = raw as { type?: string; on?: unknown; lang?: unknown } | undefined;
  if (msg?.type === 'tubemuse:subtitles:get-state') {
    sendResponse(tabState());
    return false;
  }
  if (msg?.type === 'tubemuse:subtitles:toggle' && videoId) {
    const on = typeof msg.on === 'boolean' ? msg.on : !capture;
    manual.set(videoId, on ? 'on' : 'off');
    fatal = undefined;
    tick();
    sendResponse(tabState());
    return false;
  }
  if (msg?.type === 'tubemuse:subtitles:set-lang' && videoId && typeof msg.lang === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(msg.lang)) {
    langOverride.set(videoId, msg.lang);
    fatal = undefined;
    const c = capture;
    if (c?.engine === 'browser') {
      c.plan = { lang: msg.lang, source: 'manual' };
      c.localFailed = false;
      c.restartAt = 0;
      stopRecognition(c, 'abort');
    }
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
    if (capture?.engine === 'openai' && capture.ac.state === 'suspended') void capture.ac.resume().catch(() => undefined);
  },
  true,
);

timer = setInterval(tick, TICK_MS);
tick();
