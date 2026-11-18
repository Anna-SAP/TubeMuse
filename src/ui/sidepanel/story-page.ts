// 故事：读当前标签页（DECISIONS §88）。只在你点「读这个页面」、在页面上右键「TubeMuse：讲讲这个故事」、按快捷键时调用：
// 用 chrome.scripting.executeScript 把 content/story-reader.ts 的读取函数放进那个标签页跑一次，拿回结果、校验，什么都不留在页面里。
//
// 权限：浏览器在扩展有权访问那个网站时才让脚本进去。三种来源——
// 1. manifest 里已有的站（X 等）；
// 2. 你右键「TubeMuse：讲讲这个故事」或按快捷键（Chrome 叫 activeTab：只对这一次、这一个标签页有效，换页面就没了）；
// 3. 你点「以后在 xxx 上直接读」时浏览器弹窗问你、你同意了的那个网站（可选权限，随时在设置页或浏览器的扩展管理里收回）。
// 都没有时浏览器拒绝，这里说明怎么办。

import { STORY } from '../../config/defaults';
import { STORY_SKIP_PAGES, X_PAGES } from '../../config/endpoints';
import { readStoryPage, type StoryReaderConfig } from '../../content/story-reader';
import { sanitizeStoryRead, type StoryReadResult } from '../../core/story';

/** 右键菜单 / 快捷键交给侧边栏的话：读哪个标签页（后台写进 chrome.storage.session，侧边栏读了就删） */
export const STORY_REQUEST_KEY = 'storyRequest';
export interface StoryRequest {
  tabId: number;
  at: number;
}
/** 超过这么久的留话不算（侧边栏很久以后才打开时，那一刻的页面早就不是你要的了） */
export const STORY_REQUEST_FRESH_MS = 60_000;

export type StoryTabRead = StoryReadResult | { ok: false; reason: 'no-access'; detail: string } | { ok: false; reason: 'no-tab' };

const READER_CONFIG: StoryReaderConfig = {
  skip: [...STORY_SKIP_PAGES],
  xPages: [...X_PAGES],
  maxTextChars: STORY.maxTextChars,
  maxPostChars: STORY.maxPostChars,
  maxSelectionChars: STORY.maxSelectionChars,
};

async function activeTabId(): Promise<number | undefined> {
  const w = await chrome.windows.getCurrent();
  const [tab] = await chrome.tabs.query({ active: true, windowId: w.id });
  return tab?.id;
}

/** 读这个标签页（不给就读当前窗口里正在看的那个） */
export async function readStoryTab(tabId?: number): Promise<StoryTabRead> {
  const id = tabId ?? (await activeTabId());
  if (id === undefined) return { ok: false, reason: 'no-tab' };
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: id }, func: readStoryPage, args: [READER_CONFIG] });
    return sanitizeStoryRead(res?.result, Date.now());
  } catch (e) {
    return { ok: false, reason: 'no-access', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** 一个网站的权限写法：https://example.com/*（不带端口；Firefox 的匹配规则不认端口） */
export function sitePattern(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? `${u.protocol}//${u.hostname}/*` : undefined;
  } catch {
    return undefined;
  }
}

export async function hasSiteAccess(url: string): Promise<boolean> {
  const pattern = sitePattern(url);
  return pattern ? chrome.permissions.contains({ origins: [pattern] }).catch(() => false) : false;
}

/** 浏览器弹窗问你要不要让 TubeMuse 以后直接读这个网站。必须在点击的这一刻调用（之前不能 await 别的东西） */
export function requestSiteAccess(pattern: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [pattern] }).catch(() => false);
}
