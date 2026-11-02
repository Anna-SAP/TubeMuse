// 多语字幕（用户 2026-11-02 批准的红线变更，见 DECISIONS §37）：在播放器里同时叠加几种 YouTube 字幕（CC），一种语言一行。
// 1. 字幕轨列表与原生字幕开关来自页面内助手（multi-captions-bridge.ts，跑在页面环境里），经 window.postMessage 通话。
// 2. 字幕文字：复用播放器自己的字幕请求（带 YouTube 的 pot 令牌；地址经 PerformanceObserver 看到），只换语言参数，
//    向同源的 /api/timedtext 取——与你在字幕菜单里换语言时播放器发的请求相同。只存在这个标签页的内存里，换视频即丢。
//    播放器还没取过字幕时，请助手让播放器选一条轨，它就会自己发出这个请求。
// 3. 显示期间关掉 YouTube 原生字幕（避免两层），关闭多语字幕时恢复；你自己按 C 打开原生字幕时，多语字幕先让开。
// 4. 在播放器里叠加一层只读字幕（Shadow DOM，只用 textContent 写字），不改动 YouTube 自己的元素；
//    TubeMuse 自动字幕层也在时，叠在它上面。
// 本脚本唯一的网络请求是第 2 点（构建时检查只有一处 fetch；地址先经 trackUrl 校验：同源、/api/timedtext、当前视频）。

import { DEFAULT_SETTINGS, MULTI_CC } from '../config/defaults';
import {
  AutoCaptionWindow,
  BRIDGE_TAG,
  MULTICC_LINE_COLORS,
  MULTICC_MSG,
  ORIGINAL,
  ccOptions,
  parseJson3,
  primeTrack,
  resolveSources,
  sanitizeCcLangs,
  sanitizeTrackList,
  textAt,
  timedtextVideoId,
  trackKey,
  trackUrl,
  type BridgeOp,
  type CcCue,
  type CcResolution,
  type CcSource,
  type CcTrackList,
  type MultiCcPhase,
  type MultiCcTabState,
} from '../core/multi-captions';
import { videoIdFromUrl } from '../core/watch';

type CcSettings = typeof DEFAULT_SETTINGS.multiCaptions;

const TICK_MS = 250;
const NOTICE_MS = 6_000;

let settings: CcSettings = { ...DEFAULT_SETTINGS.multiCaptions };
let settingsLoaded = false;
let videoId: string | null = null;
/** 你对每个视频的手动开关与语言选择（只在这个标签页里记住） */
const manual = new Map<string, 'on' | 'off'>();
const override = new Map<string, string[]>();

// ── 当前视频 ──
let list: CcTrackList | undefined;
let listAt = 0;
let listBusy = false;
/** 每次我们改动原生字幕就加一：改动之前发出的"读状态"请求作废（那时的原生字幕状态已经过时） */
let nativeEpoch = 0;
/** list 是在第几次改动之后读到的：与 nativeEpoch 相等时，list.native 才反映我们最近一次改动后的样子 */
let listEpoch = -1;
let videoLang: { lang?: string; note?: string } | undefined;
let videoLangAsked = false;
/** 播放器自己的字幕请求地址（带 pot 令牌），只认当前视频的 */
let template: string | undefined;
/** 取回空字幕的令牌（失效了）：再看到带它的地址也不用 */
const staleTokens = new Set<string>();
/** 至少成功取到过一次字幕的令牌：用它取回空字幕说明是那条轨本身是空的 */
const goodTokens = new Set<string>();
const primed = new Set<string>();
let primeAttempts = 0;
let nextPrimeAt = 0;
/** 正在等播放器（被我们要求选了一条轨后）发出字幕请求：这期间原生字幕是我们打开的 */
let primeOwnedSince = 0;
type Loaded = { state: 'loading' } | { state: 'ok'; cues: CcCue[] } | { state: 'error'; message: string };
const loaded = new Map<string, Loaded>();
let fetching = 0;

// ── 开关 ──
let active = false;
/** 这次开启后是否已经处理过原生字幕（关掉你原来开着的） */
let nativeChecked = false;
/** 我们关掉了你的原生字幕并记住了原来的选择：不再显示多语字幕时恢复 */
let nativeHidden = false;
/** 你在多语字幕显示期间自己打开了原生字幕：多语字幕先让开 */
let yielded = false;
let fatal: { message: string; hint?: string } | undefined;
let notice: { text: string; until: number } | undefined;
let lastState = '';
/** 正片刚开始的那一下，播放器会按你保存的偏好自动打开原生字幕：这期间的打开不算你按了 C */
const autoWindow = new AutoCaptionWindow(Date.now());

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

const tokenOf = (url: string | undefined): string => (url ? (new URL(url).searchParams.get('pot') ?? '') : '');

// ── 页面内助手 ──

let reqId = 0;
const waiting = new Map<number, (r: { ok: boolean; data?: unknown } | undefined) => void>();

function call(op: BridgeOp, args?: unknown): Promise<{ ok: boolean; data?: unknown } | undefined> {
  const id = ++reqId;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    setTimeout(() => {
      if (waiting.delete(id)) resolve(undefined); // 助手还没加载或页面没有播放器
    }, MULTI_CC.bridgeTimeoutMs);
    window.postMessage({ tag: BRIDGE_TAG, dir: 'req', id, op, ...(args === undefined ? {} : { args }) }, location.origin);
  });
}

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const m = e.data as { tag?: unknown; dir?: unknown; id?: unknown; ok?: unknown; data?: unknown } | null;
  if (!m || m.tag !== BRIDGE_TAG || m.dir !== 'res' || typeof m.id !== 'number') return;
  const resolve = waiting.get(m.id);
  if (!resolve) return;
  waiting.delete(m.id);
  resolve({ ok: m.ok === true, data: m.data });
});

/** 改动原生字幕（关、恢复、让播放器选轨）：之后立刻重读一次状态 */
async function nativeOp(op: BridgeOp, args?: unknown): Promise<{ ok: boolean; data?: unknown } | undefined> {
  nativeEpoch++;
  const r = await call(op, args);
  nativeEpoch++;
  listAt = 0;
  return r;
}

async function refreshList(): Promise<void> {
  if (listBusy) return;
  listBusy = true;
  listAt = Date.now();
  const epoch = nativeEpoch;
  const vid = videoId;
  try {
    const r = await call('state');
    if (epoch !== nativeEpoch || vid !== videoId) {
      listAt = 0;
      return;
    }
    const l = r?.ok ? sanitizeTrackList(r.data) : undefined;
    // 站内跳转时播放器可能还是上一个视频：等它换过来
    if (l && l.videoId === videoId) {
      list = l;
      listEpoch = epoch;
    }
  } finally {
    listBusy = false;
  }
}

// ── 播放器自己的字幕请求 ──

function noteUrl(url: string): void {
  if (!videoId || timedtextVideoId(url, location.origin) !== videoId) return;
  if (staleTokens.has(tokenOf(url))) return;
  template = url;
}

function scanResources(): void {
  try {
    for (const e of performance.getEntriesByType('resource')) noteUrl(e.name);
  } catch {
    // 忽略
  }
}

let observer: PerformanceObserver | undefined;
try {
  observer = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) noteUrl(e.name);
  });
  observer.observe({ type: 'resource', buffered: true });
} catch {
  observer = undefined;
}

// ── 选轨与读取 ──

function effectiveLangs(): string[] {
  return (videoId ? override.get(videoId) : undefined) ?? settings.langs;
}

function resolution(): CcResolution | undefined {
  if (!list || list.videoId !== videoId) return undefined;
  return resolveSources(list, effectiveLangs(), { autoTranslate: settings.autoTranslate, ...(videoLang?.lang ? { videoLang: videoLang.lang } : {}) });
}

/** 偏好里有"原声语言"、而字幕轨里看不出来（没有自动生成的字幕）：问后台（官方 videos.list，与自动字幕共用缓存） */
function askVideoLang(): void {
  if (videoLangAsked || !videoId) return;
  videoLangAsked = true;
  const vid = videoId;
  const done = (r: unknown) => {
    if (vid !== videoId) return;
    const x = r as { lang?: unknown; note?: unknown } | undefined;
    videoLang = { ...(typeof x?.lang === 'string' ? { lang: x.lang } : {}), ...(typeof x?.note === 'string' ? { note: x.note } : {}) };
  };
  try {
    chrome.runtime.sendMessage({ type: MULTICC_MSG.videoLang, videoId: vid }).then(done, () => done(undefined));
  } catch {
    done(undefined);
  }
}

async function load(s: CcSource): Promise<void> {
  const vid = videoId;
  const tpl = template;
  const url = vid && tpl ? trackUrl(tpl, location.origin, vid, s) : undefined;
  if (!url || !tpl) return;
  const token = tokenOf(tpl);
  loaded.set(s.key, { state: 'loading' });
  fetching++;
  let result: Loaded | undefined;
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    const body = res.ok ? await res.text() : '';
    if (!res.ok) result = { state: 'error', message: `YouTube 的字幕接口返回 HTTP ${res.status}` };
    else if (body.length > MULTI_CC.maxResponseBytes) result = { state: 'error', message: '字幕文件太大，没有读取' };
    else if (!body.trim()) {
      if (goodTokens.has(token)) result = { state: 'error', message: 'YouTube 返回了空字幕' };
      else {
        // 这个令牌一句都没取到过：多半失效了，换一个（让播放器再取一次）
        staleTokens.add(token);
        if (template === tpl) template = undefined;
      }
    } else {
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
      const cues = json === undefined ? [] : parseJson3(json, { asr: s.track.kind === 'asr' });
      if (json === undefined) result = { state: 'error', message: '字幕文件的格式看不懂' };
      else {
        goodTokens.add(token);
        result = cues.length ? { state: 'ok', cues } : { state: 'error', message: '这条字幕是空的' };
      }
    }
  } catch {
    result = { state: 'error', message: '连不上 YouTube 的字幕接口' };
  } finally {
    fetching--;
  }
  if (vid !== videoId) return;
  if (result) loaded.set(s.key, result);
  else loaded.delete(s.key);
  tick();
}

// ── 开启后的每一步 ──

/** 让播放器取字幕没有结果（等不到它的请求）：把我们打开的原生字幕关掉，过一会儿换一条轨再试 */
function primeFailed(): void {
  primeOwnedSince = 0;
  void nativeOp('hide-native', { save: false });
  nextPrimeAt = Date.now() + MULTI_CC.primeRetryMs;
}

/** 试了几次（或每条轨都试过）仍拿不到能用的字幕请求：停下并说明，不无限重试 */
function giveUp(): void {
  fatal = { message: 'YouTube 播放器没有给出字幕（它的字幕令牌可能已失效）', hint: '刷新这个页面后再试；仍不行时用 YouTube 自己的字幕菜单' };
}

function step(res: CcResolution): void {
  // 刚改动过原生字幕：等读到改动后的状态再判断（否则会把我们自己的改动当成你按了 C）
  if (!list || adShowing() || fatal || listEpoch !== nativeEpoch) return;
  // 1. 你原来开着原生字幕：关掉并记住，不再显示多语字幕时恢复
  if (!nativeChecked) {
    nativeChecked = true;
    if (list.native) {
      const save = !nativeHidden;
      nativeHidden = true;
      void nativeOp('hide-native', { save });
    }
    return;
  }
  const ours = primeOwnedSince > 0;
  if (list.native && !ours && !yielded) {
    // 正片刚开始：这是播放器按你保存的偏好自动打开的（不是你按了 C）——照常关掉并记住，关闭多语字幕时恢复
    if (autoWindow.absorb(Date.now())) {
      const save = !nativeHidden;
      nativeHidden = true;
      void nativeOp('hide-native', { save });
      return;
    }
  }
  // 你自己又打开了原生字幕：先让开，不和你抢；也不再替你恢复
  if (list.native && !ours) {
    if (!yielded) {
      yielded = true;
      notice = { text: '你打开了 YouTube 原生字幕，多语字幕先让开（按 C 关掉原生字幕即恢复）', until: Date.now() + NOTICE_MS };
      if (nativeHidden) {
        nativeHidden = false;
        void call('forget-native');
      }
    }
    return;
  }
  if (yielded) yielded = false;
  // 没有字幕轨、或你选的语言这个视频都给不出：没什么可取的（状态里已说明）
  if (!list.tracks.length || !res.sources.length) return;
  // 2. 还没有带令牌的字幕请求：让播放器自己取一次
  if (!template) {
    if (ours) {
      if (Date.now() - primeOwnedSince > MULTI_CC.primeTimeoutMs) primeFailed();
      return;
    }
    if (primeAttempts >= MULTI_CC.primeMaxAttempts) return giveUp();
    // 正片刚开始：播放器可能马上按你的偏好自动打开字幕（顺带发出带令牌的请求）。先等这一下，
    // 免得我们让它选的轨盖掉你的偏好、又把它随后的自动打开当成你按了 C
    if (autoWindow.isOpen(Date.now())) return;
    if (Date.now() < nextPrimeAt) return;
    const track = primeTrack(list, res.sources, primed);
    if (!track) return giveUp();
    primed.add(trackKey(track));
    primeAttempts++;
    primeOwnedSince = Date.now();
    void nativeOp('prime', { lang: track.lang, kind: track.kind });
    return;
  }
  // 3. 拿到了：把我们为此打开的原生字幕关掉
  if (ours) {
    primeOwnedSince = 0;
    void nativeOp('hide-native', { save: false });
  }
  // 4. 取每种语言（各取一次，存在内存里）
  for (const s of res.sources) {
    if (fetching >= MULTI_CC.fetchConcurrency) break;
    if (!loaded.has(s.key)) void load(s);
  }
}

// ── 字幕层 ──

const CSS = `
:host { all: initial; position: absolute; inset: 0; pointer-events: none; z-index: 39; }
.wrap { position: absolute; left: 0; right: 0; bottom: var(--bottom, 48px); display: flex; flex-direction: column; align-items: center; gap: 0.16em; padding: 0 4%; transition: bottom 0.2s ease; font-size: var(--fs, 20px); }
.wrap[hidden], .line[hidden] { display: none; }
.line { max-width: 92%; box-sizing: border-box; text-align: center; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.32; padding: 0.06em 0.45em; border-radius: 0.2em; background: rgba(8, 8, 8, 0.72); color: #fff; font-family: "YouTube Noto", Roboto, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Noto Sans JP", "Noto Sans KR", "Malgun Gothic", sans-serif; text-shadow: 0 0 2px rgba(0, 0, 0, 0.6); }
${MULTICC_LINE_COLORS.map((c, i) => `.l${i} { color: ${c};${i ? ' font-size: 0.92em;' : ''} }`).join('\n')}
.mt { display: inline-block; font-size: 0.6em; line-height: 1.3; vertical-align: 0.3em; margin-right: 0.45em; padding: 0 0.32em; border: 1px solid currentColor; border-radius: 0.25em; opacity: 0.75; }
.mt[hidden] { display: none; }
.status { position: absolute; top: 10px; right: 10px; max-width: min(60%, 420px); font: 12px/1.45 Roboto, "Noto Sans SC", "Microsoft YaHei", sans-serif; color: #fff; background: rgba(0, 0, 0, 0.66); padding: 4px 8px; border-radius: 4px; }
.status[hidden] { display: none; }
.status .hint { opacity: 0.8; }
`;

interface Line {
  key: string;
  el: HTMLElement;
  mt: HTMLElement;
  tx: HTMLElement;
  text: string;
}

let overlay: { host: HTMLElement; wrap: HTMLElement; lines: Line[]; status: HTMLElement; statusMain: HTMLElement; statusHint: HTMLElement } | undefined;
let shown: CcSource[] = [];

function ensureOverlay(player: HTMLElement): NonNullable<typeof overlay> {
  if (overlay && overlay.host.parentElement === player) return overlay;
  overlay?.host.remove();
  const host = document.createElement('div');
  host.setAttribute('data-tubemuse', 'multicc');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  const status = document.createElement('div');
  status.className = 'status';
  const statusMain = document.createElement('div');
  const statusHint = document.createElement('div');
  statusHint.className = 'hint';
  status.append(statusMain, statusHint);
  shadow.append(style, wrap, status);
  player.append(host);
  overlay = { host, wrap, lines: [], status, statusMain, statusHint };
  return overlay;
}

function removeOverlay(): void {
  overlay?.host.remove();
  overlay = undefined;
}

/** 行与要显示的语言一一对应（语言或顺序变了才重建） */
function syncLines(o: NonNullable<typeof overlay>, sources: CcSource[]): void {
  if (o.lines.length === sources.length && o.lines.every((l, i) => l.key === sources[i]!.key)) return;
  o.wrap.replaceChildren();
  o.lines = sources.map((s, i) => {
    const el = document.createElement('div');
    el.className = `line l${i}`;
    el.setAttribute('data-lang', s.want);
    const mt = document.createElement('span');
    mt.className = 'mt';
    mt.textContent = '机翻';
    mt.hidden = !s.autoTranslated;
    const tx = document.createElement('span');
    tx.className = 'tx';
    el.append(mt, tx);
    el.hidden = true;
    o.wrap.append(el);
    return { key: s.key, el, mt, tx, text: '' };
  });
}

/** 只更新文字（每帧调用）：按当前播放进度在每种语言自己的时间轴上找这一句 */
function renderText(): void {
  const o = overlay;
  const v = videoEl();
  if (!o || !v) return;
  const t = v.currentTime;
  let any = false;
  for (const l of o.lines) {
    const ld = loaded.get(l.key);
    const text = ld?.state === 'ok' ? textAt(ld.cues, t) : '';
    if (text !== l.text) {
      l.tx.textContent = text;
      l.text = text;
      l.el.hidden = !text;
    }
    any ||= !!text;
  }
  o.wrap.hidden = !any;
}

/** 字号随播放器高度变（全屏、剧场模式自动变大）；控制栏出现时上移；自动字幕层也在时叠在它上面 */
function layout(o: NonNullable<typeof overlay>, player: HTMLElement): void {
  const h = player.clientHeight || 360;
  const fs = Math.min(38, Math.max(13, h * 0.042)) * (settings.fontScale || 1);
  const controls = player.classList.contains('ytp-autohide') ? 0 : ((player.querySelector('.ytp-chrome-bottom') as HTMLElement | null)?.offsetHeight ?? 48);
  let bottom = controls ? controls + 12 : Math.max(12, h * 0.05);
  const asr = player.querySelector('[data-tubemuse="subtitles"]')?.shadowRoot?.querySelector<HTMLElement>('.wrap');
  if (asr && !asr.hidden && asr.offsetHeight > 0) bottom = Math.max(bottom, player.getBoundingClientRect().bottom - asr.getBoundingClientRect().top + 6);
  o.host.style.setProperty('--fs', `${fs.toFixed(1)}px`);
  o.host.style.setProperty('--bottom', `${Math.round(bottom)}px`);
}

let raf = 0;
function frame(): void {
  raf = 0;
  if (!overlay) return;
  renderText();
  const v = videoEl();
  if (v && !v.paused && !document.hidden) raf = requestAnimationFrame(frame);
}

function statusLine(res: CcResolution | undefined): { text: string; hint?: string } | undefined {
  if (!active) return undefined;
  if (fatal) return { text: `TubeMuse 多语字幕已停止：${fatal.message}`, ...(fatal.hint ? { hint: fatal.hint } : {}) };
  if (notice && Date.now() < notice.until) return { text: `TubeMuse 多语字幕：${notice.text}` };
  if (yielded || adShowing() || !res) return undefined;
  if (!list?.tracks.length) return { text: 'TubeMuse 多语字幕：这个视频没有 YouTube 字幕', hint: '可以在侧边栏"字幕"页用自动字幕（语音识别）' };
  if (!res.sources.length) return { text: 'TubeMuse 多语字幕：你选的语言这个视频都没有', hint: res.missing.map((m) => m.reason).join('；') };
  const states = res.sources.map((s) => loaded.get(s.key));
  if (states.every((x) => x?.state === 'error')) return { text: `TubeMuse 多语字幕：没能读到字幕（${(states[0] as { message: string }).message}）` };
  if (!states.some((x) => x?.state === 'ok')) return { text: 'TubeMuse 多语字幕：正在读取字幕…' };
  return undefined;
}

function render(): void {
  const player = playerEl();
  const video = videoEl();
  const res = active ? resolution() : undefined;
  const status = statusLine(res);
  const showing = active && !yielded && !fatal && !adShowing() && !!res;
  shown = showing ? res.sources : [];
  if (!player || !video || (!shown.length && !status)) return removeOverlay();
  const o = ensureOverlay(player);
  syncLines(o, shown);
  renderText();
  layout(o, player);
  o.status.hidden = !status;
  o.statusMain.textContent = status?.text ?? '';
  o.statusHint.textContent = status?.hint ?? '';
  if (!raf && shown.length && !video.paused && !document.hidden) raf = requestAnimationFrame(frame);
}

// ── 状态 ──

function phaseAndStatus(res: CcResolution | undefined): { phase: MultiCcPhase; status: string } {
  const m = videoId ? manual.get(videoId) : undefined;
  if (!videoId) return { phase: 'off', status: '这个页面不是视频播放页' };
  if (!settings.enabled) return { phase: 'off', status: '多语字幕已在设置中关闭' };
  const noTracks = list?.videoId === videoId && !list.tracks.length;
  if (!active) {
    if (m === 'off') return { phase: 'off', status: '你已关闭这个视频的多语字幕' };
    if (noTracks) return { phase: 'no-tracks', status: '这个视频没有 YouTube 字幕' };
    return { phase: 'off', status: '未开启：点"显示多语字幕"或按 Alt+Shift+C' };
  }
  if (fatal) return { phase: 'error', status: `已停止：${fatal.message}` };
  if (adShowing()) return { phase: 'waiting', status: '正在播广告，广告结束后显示' };
  if (!res) return { phase: 'waiting', status: '正在读取播放器的字幕列表…' };
  if (noTracks) return { phase: 'no-tracks', status: '这个视频没有 YouTube 字幕' };
  if (yielded) return { phase: 'yielded', status: '你打开了 YouTube 原生字幕，多语字幕先让开；按 C 关掉原生字幕即恢复' };
  if (!res.sources.length) return { phase: 'error', status: '你选的语言这个视频都没有' };
  const states = res.sources.map((s) => loaded.get(s.key));
  if (!template && !states.some((x) => x?.state === 'ok')) return { phase: 'loading', status: '正在等播放器准备字幕…' };
  if (states.every((x) => x?.state === 'error')) return { phase: 'error', status: '没能读到字幕' };
  if (states.some((x) => !x || x.state === 'loading')) return { phase: 'loading', status: '正在读取字幕…' };
  const ok = states.filter((x) => x?.state === 'ok').length;
  return { phase: 'showing', status: `正在显示 ${ok} 种语言` };
}

function tabState(): MultiCcTabState {
  const res = active || (list && list.videoId === videoId) ? resolution() : undefined;
  const { phase, status } = phaseAndStatus(active ? res : undefined);
  const m = videoId ? manual.get(videoId) : undefined;
  const options = (list && res ? ccOptions(list, res, effectiveLangs()) : []).map((o) => {
    const s = o.checked ? res?.sources.find((x) => x.pref === o.code) : undefined;
    const ld = s ? loaded.get(s.key) : undefined;
    return { ...o, ...(ld?.state === 'ok' ? { cues: ld.cues.length } : {}), ...(ld?.state === 'error' ? { error: ld.message } : {}) };
  });
  return {
    videoId,
    enabled: settings.enabled,
    active,
    ...(m ? { manual: m } : {}),
    phase,
    status,
    options,
    lines: (res?.sources ?? []).map((s) => {
      const ld = loaded.get(s.key);
      return { key: s.key, label: s.label, autoTranslated: s.autoTranslated, ...(ld?.state === 'ok' ? { cues: ld.cues.length } : {}), ...(ld?.state === 'error' ? { error: ld.message } : {}) };
    }),
    overridden: !!videoId && override.has(videoId),
    nativeHidden,
    ...(fatal ? { error: fatal } : {}),
  };
}

function broadcast(): void {
  const s = tabState();
  const key = JSON.stringify(s);
  if (key === lastState) return;
  lastState = key;
  try {
    void chrome.runtime.sendMessage({ type: MULTICC_MSG.state, state: s }).catch(() => undefined);
  } catch {
    teardown();
  }
}

// ── 主循环 ──

function want(): boolean {
  if (!settingsLoaded || !settings.enabled || !videoId) return false;
  const m = manual.get(videoId);
  if (m) return m === 'on';
  return settings.autoOn && list?.videoId === videoId && list.tracks.length > 0;
}

/** 关掉多语字幕（不恢复原生字幕：由主循环在知道新状态后决定） */
function deactivate(): void {
  active = false;
  nativeChecked = false;
  yielded = false;
  notice = undefined;
  if (primeOwnedSince) {
    primeOwnedSince = 0;
    void nativeOp('hide-native', { save: false });
  }
  removeOverlay();
}

function switchVideo(next: string | null): void {
  if (active) deactivate();
  videoId = next;
  list = undefined;
  listAt = 0;
  listEpoch = -1;
  videoLang = undefined;
  videoLangAsked = false;
  template = undefined;
  primed.clear();
  primeAttempts = 0;
  nextPrimeAt = 0;
  loaded.clear();
  fatal = undefined;
  autoWindow.restart(Date.now());
  scanResources();
}

function tick(): void {
  if (!alive()) return teardown();
  const { videoId: vid, shorts } = videoIdFromUrl(location.href);
  const next = shorts ? null : vid;
  if (next !== videoId) switchVideo(next);
  const v = videoEl();
  autoWindow.sample({ now: Date.now(), ad: adShowing(), playing: !!v && !v.paused && !v.seeking && v.readyState >= 3 });
  const listed = list?.videoId === videoId;
  const wanted = want();
  if (active && !wanted) deactivate();
  if (wanted) active = true;
  // 自动开启要先知道有没有字幕轨；关掉后要知道原生字幕的现状才能恢复。
  // 正片刚开始时每轮都读：播放器按你的偏好自动打开字幕要尽快看到，才能在那段时间内认出它
  const refreshEvery = active && autoWindow.isOpen(Date.now()) ? TICK_MS : MULTI_CC.stateRefreshMs;
  if (videoId && settings.enabled && (active || settings.autoOn || nativeHidden || !listed) && Date.now() - listAt >= refreshEvery) void refreshList();
  // 不再显示多语字幕：把我们关掉的原生字幕恢复（你在这期间自己动过原生字幕时不恢复）
  if (!active && nativeHidden && listed && listEpoch === nativeEpoch && !primeOwnedSince) {
    nativeHidden = false;
    if (!list!.native) void nativeOp('restore-native');
    else void call('forget-native');
  }
  if (active) {
    const res = resolution();
    if (res && effectiveLangs().includes(ORIGINAL) && !res.originalLang) askVideoLang();
    if (res) step(res);
  }
  render();
  broadcast();
}

let timer: ReturnType<typeof setInterval> | undefined;

function teardown(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  observer?.disconnect();
  removeOverlay();
}

function applySettings(raw: unknown): void {
  const s = (raw as { multiCaptions?: Partial<CcSettings> } | undefined)?.multiCaptions;
  settings = { ...DEFAULT_SETTINGS.multiCaptions, ...(s ?? {}), langs: sanitizeCcLangs(s?.langs) ?? [...DEFAULT_SETTINGS.multiCaptions.langs] };
  fatal = undefined;
  primeAttempts = 0;
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
  if (area === 'local' && changes.settings) applySettings(changes.settings.newValue);
});

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const msg = raw as { type?: string; on?: unknown; langs?: unknown } | undefined;
  if (msg?.type === MULTICC_MSG.getState) {
    sendResponse(tabState());
    return false;
  }
  if (msg?.type === MULTICC_MSG.toggle && videoId) {
    const on = typeof msg.on === 'boolean' ? msg.on : !active;
    manual.set(videoId, on ? 'on' : 'off');
    fatal = undefined;
    primeAttempts = 0;
    nextPrimeAt = 0;
    tick();
    sendResponse(tabState());
    return false;
  }
  if (msg?.type === MULTICC_MSG.setLangs && videoId) {
    const langs = msg.langs === null ? undefined : sanitizeCcLangs(msg.langs);
    if (langs) override.set(videoId, langs);
    else override.delete(videoId);
    tick();
    sendResponse(tabState());
    return false;
  }
  return false;
});

timer = setInterval(tick, TICK_MS);
tick();
