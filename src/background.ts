// MV3 service worker：点图标开侧边栏；接收观看上报；自动字幕（转写、翻译、记账）；定时任务（每日总结、周报、补元数据、导师提醒）。
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

const ctx = createBrowserContext();
const TICK = 'tubemuse-tick';
const DAILY = 'tubemuse-daily';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

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

async function ensureAlarms(force = false): Promise<void> {
  const settings = await stores.settings.read(ctx.kv);
  if (force || !(await chrome.alarms.get(TICK))) {
    await chrome.alarms.create(TICK, { delayInMinutes: 1, periodInMinutes: SUMMARY.tickMinutes, persistAcrossSessions: true });
  }
  if (force || !(await chrome.alarms.get(DAILY))) {
    // 一次性闹钟，到点后重新计算下一次（这样能正确跨过夏令时切换）
    await chrome.alarms.create(DAILY, { when: nextDailyRun(Date.now(), settings.summary.time, ctx.timeZone), persistAcrossSessions: true });
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

/** 本扩展自己的页面（设置页、侧边栏），不是注入网页的脚本 */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
}

// 连接 / 重新授权：授权窗口由后台打开、令牌由后台保存，发起的页面中途被关掉也不丢结果（见 auth-service.ts）
let connecting: Promise<void> | undefined;

let reminderTimer: ReturnType<typeof setTimeout> | undefined;
chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse: (r: AuthConnectReply) => void) => {
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
  // 片段录制：录制脚本存好了一个片段，记一笔（只有元数据；视频文件由浏览器存进下载文件夹，不经过这里）
  if (m?.type === CLIP_MSG.saved) {
    if (!fromTrackedSite(sender)) return false;
    void recordSavedClip(ctx, (m as { record?: unknown }).record).catch(() => undefined);
    return false;
  }
  // 片段录制状态：在工具栏图标上标出正在录（用快捷键录制时不打开侧边栏也看得见）
  if (m?.type === CLIP_MSG.state) {
    if (!fromTrackedSite(sender) || sender.tab?.id === undefined) return false;
    showClipBadge(sender.tab.id, (m as { state?: ClipTabState }).state);
    return false;
  }
  return false;
});

/** 正在录：红色 REC；自动暂停中：灰色 REC；录制失败（例如快捷键在 Shorts 上按下）：橙色 !；其余不显示 */
function showClipBadge(tabId: number, state: ClipTabState | undefined): void {
  const recording = state?.phase === 'recording';
  const text = recording ? 'REC' : state?.error && state.phase === 'idle' ? '!' : '';
  const color = recording ? (state?.waiting ? '#6d6862' : '#c8364a') : '#c77700';
  void chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
  if (text) void chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => undefined);
  const title = recording ? `TubeMuse · 正在录制片段（${state?.status ?? ''}）` : state?.error && state.phase === 'idle' ? `TubeMuse · ${state.error.message}` : 'TubeMuse';
  void chrome.action.setTitle({ tabId, title }).catch(() => undefined);
}

// 自动字幕：YouTube 播放页里的字幕脚本经长连接送来切好的音频片段，这里转写、翻译后回传
chrome.runtime.onConnect.addListener((port) => {
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

// 快捷键：开关当前标签页这个视频的字幕 / 开始或停止录制片段（只发给本扩展的内容脚本；不是 YouTube 页面时什么也不做）
chrome.commands.onCommand.addListener((command, tab) => {
  if (tab?.id === undefined) return;
  if (command === 'toggle-subtitles') void chrome.tabs.sendMessage(tab.id, { type: 'tubemuse:subtitles:toggle' }).catch(() => undefined);
  else if (command === 'toggle-clip-recording') void chrome.tabs.sendMessage(tab.id, { type: CLIP_MSG.toggle }).catch(() => undefined);
});

void ensureAlarms();
