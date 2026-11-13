// MV3 service worker（Firefox 版是事件页，见 DECISIONS §69）：点图标开侧边栏；接收观看上报；自动字幕（转写、翻译、记账）；定时任务（每日总结、周报、补元数据、导师提醒）。
// service worker 会休眠、浏览器可能在到点时没开：闹钟设为跨会话保留，并且每次醒来都检查闹钟是否还在、按"应该已完成但还没有"补算。

import { GOOGLE_OAUTH, SUMMARY } from './config/defaults';
import { TRACKED_SITES } from './config/endpoints';
import { nextDailyRun } from './core/schedule';
import { AUTH_CONNECT_MESSAGE, connectYouTube, toAuthReply, type AuthConnectReply } from './services/auth-service';
import { createBrowserContext } from './services/context';
import { stores } from './services/repo';
import { runScheduledJobs } from './services/summary-service';
import { checkReminder } from './services/reminder-service';
import { ingestSession } from './services/watch-service';
import { SUBTITLE_PORT, subtitleSession } from './services/subtitle-service';
import { CLIP_MSG, type ClipTabState } from './core/clips';
import { recordSavedClip } from './services/clip-service';
import { MULTICC_MSG } from './core/multi-captions';
import { multiCcVideoLanguage } from './services/multi-captions-service';
import { BILI_PAGES, DOUYIN_PAGES, IG_PAGES, KUBB_PAGES, XHS_PAGES, XYZ_PAGES, X_PAGES } from './config/endpoints';
import { XYZ_MSG, XYZ_PORT, isXyzMediaUrl } from './core/xyz';
import { ingestXyzListen, readAudioWindow, xyzSession, type XyzWindowReply } from './services/xyz-service';
import { toAppError } from './services/errors';
import { XHS_MSG } from './core/xhs';
import { applyXhsFromPage, type XhsReply } from './services/xhs-service';
import { IS_FIREFOX } from './platform';

const ctx = createBrowserContext();
const TICK = 'tubemuse-tick';
const DAILY = 'tubemuse-daily';

// 点工具栏图标打开侧边栏：Chrome 是 side_panel；Firefox 是 sidebar_action，点图标时开 / 关它（必须在点击的那一刻调用，DECISIONS §69）
if (IS_FIREFOX) {
  const sidebar = (chrome as unknown as { sidebarAction?: { toggle(): Promise<void> } }).sidebarAction;
  chrome.action.onClicked.addListener(() => void sidebar?.toggle().catch((e: unknown) => console.warn('[TubeMuse] 没能打开侧边栏', e instanceof Error ? e.message : e)));
} else {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
}

/** 长任务期间每 20 秒调一次扩展 API，避免 service worker 在等待 LLM 响应时被回收；给了 maxMs 就最多保活这么久 */
async function keepAlive<T>(fn: () => Promise<T>, maxMs?: number): Promise<T> {
  const t = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  const cap = maxMs === undefined ? undefined : setTimeout(() => clearInterval(t), maxMs);
  try {
    return await fn();
  } finally {
    clearInterval(t);
    if (cap !== undefined) clearTimeout(cap);
  }
}

/**
 * Chrome 的闹钟可以设成跨浏览器会话保留；Firefox 不认这个参数，带上会直接报错、闹钟建不起来（161 实测），
 * 它的闹钟本来也不跨会话——浏览器启动时 onStartup 会重建，"到点时浏览器没开"由补算兜住。
 */
const PERSIST: { persistAcrossSessions?: boolean } = IS_FIREFOX ? {} : { persistAcrossSessions: true };

async function ensureAlarms(force = false): Promise<void> {
  const settings = await stores.settings.read(ctx.kv);
  if (force || !(await chrome.alarms.get(TICK))) {
    await chrome.alarms.create(TICK, { delayInMinutes: 1, periodInMinutes: SUMMARY.tickMinutes, ...PERSIST });
  }
  if (force || !(await chrome.alarms.get(DAILY))) {
    // 一次性闹钟，到点后重新计算下一次（这样能正确跨过夏令时切换）
    await chrome.alarms.create(DAILY, { when: nextDailyRun(Date.now(), settings.summary.time, ctx.timeZone), ...PERSIST });
  }
}

let running: Promise<unknown> | undefined;
function runJobs(): Promise<unknown> {
  running ??= keepAlive(() => runScheduledJobs(ctx))
    .catch((e) => console.warn('[TubeMuse] 例行任务失败', e instanceof Error ? e.message : e))
    .finally(() => (running = undefined));
  return running;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAILY) void chrome.alarms.clear(DAILY).then(() => ensureAlarms()).then(runJobs);
  else if (alarm.name === TICK) void runJobs();
});

chrome.runtime.onStartup.addListener(() => void ensureAlarms().then(runJobs));
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
  void ensureAlarms(true).then(runJobs);
});

// 设置里改了总结时间：重排闹钟
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const before = (changes.settings.oldValue as { summary?: { time?: string } } | undefined)?.summary?.time;
  const after = (changes.settings.newValue as { summary?: { time?: string } } | undefined)?.summary?.time;
  if (before !== after) void chrome.alarms.clear(DAILY).then(() => ensureAlarms());
});

function fromTrackedSite(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.tab || !sender.url) return false;
  try {
    const origin = new URL(sender.url).origin;
    return (TRACKED_SITES as readonly string[]).includes(origin);
  } catch {
    return false;
  }
}

/** 注入小红书网页版的脚本（只认 manifest 里注入它的那些网址） */
function fromXhsPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.tab && !!sender.url && XHS_PAGES.some((p) => sender.url!.startsWith(p));
}

/** 注入 X 网页版的录制脚本（只认 manifest 里注入它的那些网址） */
function fromXPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.tab && !!sender.url && X_PAGES.some((p) => sender.url!.startsWith(p));
}

/** 注入酷播网页版的录制脚本（只认 manifest 里注入它的那些网址） */
function fromKubbPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.tab && !!sender.url && KUBB_PAGES.some((p) => sender.url!.startsWith(p));
}

/** 注入 Instagram 网页版的录制脚本（只认 manifest 里注入它的那些网址） */
function fromIgPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.tab && !!sender.url && IG_PAGES.some((p) => sender.url!.startsWith(p));
}

/** 注入抖音网页版的录制脚本（只认 manifest 里注入它的那些网址） */
function fromDouyinPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.tab && !!sender.url && DOUYIN_PAGES.some((p) => sender.url!.startsWith(p));
}

/** 注入 B 站网页版的录制脚本（只认 manifest 里注入它的那些网址） */
function fromBiliPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.tab && !!sender.url && BILI_PAGES.some((p) => sender.url!.startsWith(p));
}

/** 注入小宇宙网页版的脚本（只认 manifest 里注入它的那些网址） */
function fromXyzPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.tab && !!sender.url && XYZ_PAGES.some((p) => sender.url!.startsWith(p));
}

/** 本扩展自己的页面（设置页、侧边栏），不是注入网页的脚本 */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
}

// 连接 / 重新授权：授权窗口由后台打开、令牌由后台保存，发起的页面中途被关掉也不丢结果（见 auth-service.ts）
let connecting: Promise<void> | undefined;

let reminderTimer: ReturnType<typeof setTimeout> | undefined;
type XyzWindowResponse = ({ ok: true } & XyzWindowReply) | { ok: false; message: string; hint?: string; wait?: boolean };

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse: (r: AuthConnectReply | XhsReply | { lang?: string; note?: string } | XyzWindowResponse) => void) => {
  const m = msg as { type?: string; session?: unknown } | undefined;
  if (m?.type === AUTH_CONNECT_MESSAGE) {
    if (!fromExtensionPage(sender)) return false;
    // 在窗口里登录、选账号可能要几分钟：期间保活，免得 service worker 被回收、结果没人接
    connecting ??= keepAlive(() => connectYouTube(ctx), GOOGLE_OAUTH.interactiveMaxMs).finally(() => (connecting = undefined));
    connecting.then(
      () => sendResponse({ ok: true }),
      (e: unknown) => sendResponse(toAuthReply(e)),
    );
    return true;
  }
  if (m?.type === 'tubemuse:watch') {
    if (!fromTrackedSite(sender)) return false;
    void ingestSession(ctx, m.session).then(() => {
      // 观看数据变化后稍后评估一次提醒（合并频繁上报）
      if (reminderTimer) clearTimeout(reminderTimer);
      reminderTimer = setTimeout(() => void checkReminder(ctx).catch(() => undefined), 5_000);
    });
    return false;
  }
  // 多语字幕：视频原声的语言（官方 videos.list，1 unit，有缓存）；字幕文字本身不经过后台
  if (m?.type === MULTICC_MSG.videoLang) {
    if (!fromTrackedSite(sender)) return false;
    multiCcVideoLanguage(ctx, (m as { videoId?: unknown }).videoId).then(sendResponse, () => sendResponse({}));
    return true;
  }
  // 片段录制：录制脚本存好了一个片段，记一笔（只有元数据；视频文件由浏览器存进下载文件夹，不经过这里）。
  // 是哪个站的片段按发消息的页面定（YouTube 播放页、小红书网页版、X 网页版、酷播、Instagram 网页版、抖音网页版或 B 站网页版），不信记录里自己写的
  if (m?.type === CLIP_MSG.saved) {
    const site = fromXhsPage(sender) ? 'xhs' : fromXPage(sender) ? 'x' : fromKubbPage(sender) ? 'kubb' : fromIgPage(sender) ? 'ig' : fromDouyinPage(sender) ? 'douyin' : fromBiliPage(sender) ? 'bilibili' : fromTrackedSite(sender) ? 'youtube' : undefined;
    if (!site) return false;
    void recordSavedClip(ctx, (m as { record?: unknown }).record, site).catch(() => undefined);
    return false;
  }
  // 小红书：页面上点了收藏 / 移出 / 加减标签。页面内容不可信，校验后写入本机；不向小红书发任何请求
  if (m?.type === XHS_MSG.op) {
    if (!fromXhsPage(sender)) return false;
    applyXhsFromPage(ctx, (m as { op?: unknown }).op).then(sendResponse, () => sendResponse({ ok: false, error: '没有保存：本机存储出错，稍后再试' }));
    return true;
  }
  // 小宇宙：收听记录（累计值，可重复上报）
  if (m?.type === XYZ_MSG.listen) {
    if (!fromXyzPage(sender)) return false;
    void ingestXyzListen(ctx, msg).catch(() => undefined);
    return false;
  }
  // 小宇宙：侧边栏要一段音频（快照的波形、导出音频片段）。只读小宇宙 CDN 上的音频
  if (m?.type === XYZ_MSG.window) {
    if (!fromExtensionPage(sender)) return false;
    const r = msg as { audioUrl?: unknown; from?: unknown; to?: unknown };
    if (!isXyzMediaUrl(r.audioUrl, ctx.endpoints.xyzMedia)) {
      sendResponse({ ok: false, message: '这一集的音频不在小宇宙的公开 CDN 上，读不了' });
      return false;
    }
    keepAlive(() => readAudioWindow(ctx, r.audioUrl as string, Number(r.from), Number(r.to))).then(
      (w) => sendResponse({ ok: true, ...w }),
      (e: unknown) => {
        const err = toAppError(e);
        sendResponse({ ok: false, message: err.message, ...(err.hint ? { hint: err.hint } : {}), ...(err.kind === 'xyz_scan' ? { wait: true } : {}) });
      },
    );
    return true;
  }
  // 片段录制状态：在工具栏图标上标出正在录（用快捷键录制时不打开侧边栏也看得见）
  if (m?.type === CLIP_MSG.state) {
    if (!(fromTrackedSite(sender) || fromXhsPage(sender) || fromXPage(sender) || fromKubbPage(sender) || fromIgPage(sender) || fromDouyinPage(sender) || fromBiliPage(sender)) || sender.tab?.id === undefined) return false;
    showClipBadge(sender.tab.id, (m as { state?: ClipTabState }).state);
    return false;
  }
  return false;
});

/** 正在录：红色 REC；自动暂停中：灰色 REC；录制失败（例如快捷键在不是视频页的页面上按下）：橙色 !；其余不显示 */
function showClipBadge(tabId: number, state: ClipTabState | undefined): void {
  const recording = state?.phase === 'recording';
  const text = recording ? 'REC' : state?.error && state.phase === 'idle' ? '!' : '';
  const color = recording ? (state?.waiting ? '#6d6862' : '#c8364a') : '#c77700';
  void chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
  if (text) void chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => undefined);
  const title = recording ? `TubeMuse · 正在录制片段（${state?.status ?? ''}）` : state?.error && state.phase === 'idle' ? `TubeMuse · ${state.error.message}` : 'TubeMuse';
  void chrome.action.setTitle({ tabId, title }).catch(() => undefined);
}

// 自动字幕：YouTube 播放页里的字幕脚本经长连接送来切好的音频片段，这里转写、翻译后回传。
// 小宇宙：单集页的脚本经另一条长连接要音频、送切好的句子，这里读音频、转写、校对 / 翻译后回传（DECISIONS §72）
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === XYZ_PORT) {
    if (!port.sender || !fromXyzPage(port.sender)) return port.disconnect();
    let alive = true;
    port.onDisconnect.addListener(() => (alive = false));
    const handle = xyzSession(ctx, (m) => {
      if (!alive) return;
      try {
        port.postMessage(m);
      } catch {
        alive = false;
      }
    });
    port.onMessage.addListener((m) => void keepAlive(() => handle(m)).catch((e) => console.warn('[TubeMuse] 小宇宙字幕处理失败', e instanceof Error ? e.message : e)));
    return;
  }
  if (port.name !== SUBTITLE_PORT) return;
  if (!port.sender || !fromTrackedSite(port.sender)) return port.disconnect();
  let open = true;
  port.onDisconnect.addListener(() => (open = false));
  const handle = subtitleSession(ctx, (m) => {
    if (!open) return;
    try {
      port.postMessage(m);
    } catch {
      open = false;
    }
  });
  port.onMessage.addListener((m) => void keepAlive(() => handle(m)).catch((e) => console.warn('[TubeMuse] 字幕处理失败', e instanceof Error ? e.message : e)));
});

// 快捷键：开关当前标签页这个视频的自动字幕 / 多语字幕 / 开始或停止录制片段（只发给本扩展的内容脚本；
// 不是 YouTube 页面时什么也不做；录制也认小红书、X、酷播、Instagram、抖音和 B 站；Alt+Shift+S 在小宇宙单集页上开关这一集的字幕）
chrome.commands.onCommand.addListener((command, tab) => {
  if (tab?.id === undefined) return;
  if (command === 'toggle-subtitles') void chrome.tabs.sendMessage(tab.id, { type: 'tubemuse:subtitles:toggle' }).catch(() => undefined);
  else if (command === 'toggle-multi-captions') void chrome.tabs.sendMessage(tab.id, { type: MULTICC_MSG.toggle }).catch(() => undefined);
  else if (command === 'toggle-clip-recording') void chrome.tabs.sendMessage(tab.id, { type: CLIP_MSG.toggle }).catch(() => undefined);
});

void ensureAlarms();
