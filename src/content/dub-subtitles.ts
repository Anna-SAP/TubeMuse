// 配音字幕（用户 2026-11-18 要求，见 DECISIONS §86）：配音开着、这个配音有字幕、你在侧边栏「配音」页勾着"显示配音字幕"时，
// 在 YouTube 播放器里（画面底部）叠一层只读字幕，显示配音此刻说到的那一句。
// 1. 字幕是配音的字幕：按配音实际放到的位置找句子（配音脚本经同一个隔离环境交来 <audio> 的 currentTime），不按视频时间——
//    中文停下等画面、还没开始、已经放完、广告、跳转途中都不显示。
// 2. 字幕文字是你自己给的（字幕文件，或小宇宙里已经生成的那一集），存在本机；这个脚本只读扩展存储，
//    不发任何网络请求、不转写、不翻译、不读页面文字。
// 3. 字幕层和另两层字幕（自动字幕、多语字幕）同样的约束：Shadow DOM、只用文字写入、不改动 YouTube 原有元素、不挡点击，关掉就移除。
//    为了不和别的字幕叠在一起，只读它们的位置（TubeMuse 的另两层，和 YouTube 原生字幕窗口的位置，不读文字）。
// 4. 样式（字体、字号、文字颜色、背景色与不透明度、粗体、描边、抬高多少）在侧边栏调，改了立刻生效。

import { DEFAULT_SETTINGS, DUB } from '../config/defaults';
import { sanitizeDubIndex, type DubIndex } from '../core/dub';
import { dubCueAt, dubPlayback, dubSubCss, dubSubFontPx, dubSubVisible, dubSubsKey, sanitizeDubSubStyle, sanitizeDubSubsDoc, type DubSubStyle } from '../core/dub-subs';
import { playerRootId } from '../core/multicc-protocol';
import type { SubCue } from '../core/subtitle-track';
import { videoIdFromUrl } from '../core/watch';

let enabled: boolean = DEFAULT_SETTINGS.dub.enabled;
let style: DubSubStyle = sanitizeDubSubStyle(undefined);
let index: DubIndex = {};
let ready = false;
/** 已读进内存的字幕：哪个视频的、哪一份（按存下的时刻认：换了一份就重读） */
let cues: { videoId: string; addedAt: number; list: SubCue[] } | undefined;
/** 正在读哪一份 */
let loadingKey: string | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

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

// ── 字幕层 ──

const CSS = `
:host { all: initial; position: absolute; inset: 0; pointer-events: none; z-index: 40; }
.wrap { position: absolute; left: 0; right: 0; bottom: var(--bottom, 48px); display: flex; flex-direction: column; align-items: center; padding: 0 ${((1 - DUB.subs.lineMaxWidthRatio) * 50).toFixed(2)}%; transition: bottom 0.2s ease; font-size: var(--fs, 20px); }
.wrap[hidden] { display: none; }
.line { max-width: 100%; box-sizing: border-box; text-align: center; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.35; padding: 0.08em 0.45em; border-radius: 0.2em; }
`;

let overlay: { host: HTMLElement; wrap: HTMLElement; line: HTMLElement; text: string; css: string } | undefined;

function ensureOverlay(player: HTMLElement): NonNullable<typeof overlay> {
  if (overlay && overlay.host.parentElement === player) return overlay;
  overlay?.host.remove();
  const host = document.createElement('div');
  host.setAttribute('data-tubemuse', 'dubsubs');
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = document.createElement('style');
  sheet.textContent = CSS;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.hidden = true;
  const line = document.createElement('div');
  line.className = 'line';
  wrap.append(line);
  shadow.append(sheet, wrap);
  player.append(host);
  overlay = { host, wrap, line, text: '', css: '' };
  return overlay;
}

function removeOverlay(): void {
  overlay?.host.remove();
  overlay = undefined;
}

/** 别的字幕（TubeMuse 的自动字幕、多语字幕，YouTube 原生字幕窗口）此刻占到多高：只读位置，配音字幕叠在它们上面 */
function othersTop(player: HTMLElement, playerBox: DOMRect): number {
  let top = playerBox.bottom;
  const consider = (el: Element | null | undefined) => {
    if (!(el instanceof HTMLElement) || el.hidden || el.offsetHeight <= 0) return;
    const r = el.getBoundingClientRect();
    // 只管画面下半部分的（原生字幕也可能在顶上）
    if (r.height > 0 && r.top > playerBox.top + playerBox.height / 2) top = Math.min(top, r.top);
  };
  for (const name of ['subtitles', 'multicc']) consider(player.querySelector(`[data-tubemuse="${name}"]`)?.shadowRoot?.querySelector('.wrap'));
  for (const win of player.querySelectorAll('.caption-window')) consider(win);
  return top;
}

/** 样式与位置：字号随播放器高度变；控制栏出现时上移；别的字幕在时叠在它们上面；再加上你设的抬高 */
function layout(o: NonNullable<typeof overlay>, player: HTMLElement): void {
  const h = player.clientHeight || 360;
  const w = player.clientWidth || 640;
  const shorts = player.id === 'shorts-player';
  const c = dubSubCss(style);
  const css = JSON.stringify(c);
  if (css !== o.css) {
    o.css = css;
    o.line.style.fontFamily = c.fontFamily;
    o.line.style.color = c.color;
    o.line.style.background = c.background;
    o.line.style.fontWeight = c.fontWeight;
    o.line.style.textShadow = c.textShadow;
  }
  const controls = shorts || player.classList.contains('ytp-autohide') ? 0 : ((player.querySelector('.ytp-chrome-bottom') as HTMLElement | null)?.offsetHeight ?? 48);
  let bottom = shorts ? Math.max(12, h * DUB.subs.shortsBottomRatio) : controls ? controls + 12 : Math.max(12, h * 0.05);
  const box = player.getBoundingClientRect();
  const top = othersTop(player, box);
  if (top < box.bottom) bottom = Math.max(bottom, box.bottom - top + 6);
  bottom += (h * style.raisePct) / 100;
  o.host.style.setProperty('--fs', `${dubSubFontPx(style, w, h, shorts)}px`);
  o.host.style.setProperty('--bottom', `${Math.round(Math.min(bottom, h * 0.9))}px`);
}

/** 只更新文字（每帧调用）：配音此刻放到哪，就显示哪一句 */
function renderText(): boolean {
  const o = overlay;
  if (!o || !cues) return false;
  const p = dubPlayback();
  const text = p && p.videoId === cues.videoId && dubSubVisible(p) ? (dubCueAt(cues.list, p.time)?.text ?? '') : '';
  if (text !== o.text) {
    o.text = text;
    o.line.textContent = text;
    o.wrap.hidden = !text;
  }
  return !!p?.running;
}

let raf = 0;
function frame(): void {
  raf = 0;
  if (!overlay) return;
  if (renderText() && !document.hidden) raf = requestAnimationFrame(frame);
}

// ── 字幕 ──

function loadCues(videoId: string, addedAt: number): void {
  const key = `${videoId}:${addedAt}`;
  if (loadingKey === key) return;
  loadingKey = key;
  const storageKey = dubSubsKey(videoId);
  chrome.storage.local
    .get(storageKey)
    .then((r) => {
      if (loadingKey !== key) return;
      const doc = sanitizeDubSubsDoc(r[storageKey], videoId);
      // 说明还在、字幕却没了（存储被手改）：当作空的，不反复重读；侧边栏会说"字幕不见了"
      cues = { videoId, addedAt, list: doc?.cues ?? [] };
    })
    .catch(() => undefined)
    .finally(() => {
      if (loadingKey === key) loadingKey = undefined;
      tick();
    });
}

// ── 主循环 ──

function tick(): void {
  if (!alive()) return shutdown();
  if (!ready) return;
  const vid = videoIdFromUrl(location.href).videoId;
  const meta = vid && enabled && style.show ? index[vid]?.subs : undefined;
  if (!vid || !meta) {
    cues = undefined;
    return removeOverlay();
  }
  if (cues?.videoId !== vid || cues.addedAt !== meta.addedAt) {
    cues = undefined;
    loadCues(vid, meta.addedAt);
    return removeOverlay();
  }
  const p = dubPlayback();
  const player = playerEl();
  if (!p || p.videoId !== vid || !player || !cues.list.length) return removeOverlay();
  const o = ensureOverlay(player);
  layout(o, player);
  const running = renderText();
  if (!raf && running && !document.hidden) raf = requestAnimationFrame(frame);
}

/** 扩展被重新加载（这个脚本失效）：把字幕层拿掉 */
function shutdown(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  ready = false;
  removeOverlay();
}

function applySettings(raw: unknown): void {
  const d = (raw as { dub?: { enabled?: unknown; subtitles?: unknown } } | undefined)?.dub;
  enabled = typeof d?.enabled === 'boolean' ? d.enabled : DEFAULT_SETTINGS.dub.enabled;
  style = sanitizeDubSubStyle(d?.subtitles);
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
  if (area !== 'local') return;
  if (changes.settings) applySettings(changes.settings.newValue);
  if (changes.dubs) index = sanitizeDubIndex(changes.dubs.newValue);
  if (ready && (changes.settings || changes.dubs)) tick();
});

window.addEventListener('pagehide', () => removeOverlay());
window.addEventListener('pageshow', () => ready && tick());
document.addEventListener('visibilitychange', () => ready && !document.hidden && tick());
