// 这一份构建是给哪个浏览器的（2026-11-12 起同一份源码另出一个 Firefox 版，见 DECISIONS §69）。
// 由构建脚本注入 __BROWSER__：npm run build → 'chrome'，npm run build:firefox → 'firefox'；单元测试里没有注入，按 Chrome。
// 只放两边确实不同、又没法靠"有没有这个接口"判断的地方（界面上的说法、Firefox 会拒绝的参数、各自的侧边栏）；
// 能按接口判断的（captureStream、本地翻译、语音识别）仍按接口判断。

declare const __BROWSER__: string | undefined;

export type BrowserKind = 'chrome' | 'firefox';

export const BROWSER: BrowserKind = typeof __BROWSER__ === 'string' && __BROWSER__ === 'firefox' ? 'firefox' : 'chrome';

export const IS_FIREFOX = BROWSER === 'firefox';

/** 界面上称呼这个浏览器 */
export const BROWSER_NAME = IS_FIREFOX ? 'Firefox' : 'Chrome';

/** 改快捷键的地方 */
export const SHORTCUTS_PAGE = IS_FIREFOX ? 'about:addons → 齿轮 → 管理扩展快捷键' : 'chrome://extensions/shortcuts';

/**
 * 浏览器自带的语音识别有没有云端服务：Chrome 没装本地语音包时把声音发往 Google；
 * Firefox（161 实测）只在本机用 Mozilla 的模型识别，没有云端，没装模型就识别不了。
 */
export interface SpeechPlatform {
  /** 没装本地语音包时能不能交给浏览器的云端服务 */
  hasCloud: boolean;
  /** 本地语音包 / 模型由谁下载 */
  packSource: string;
}

export const SPEECH_PLATFORM: SpeechPlatform = IS_FIREFOX ? { hasCloud: false, packSource: 'Mozilla' } : { hasCloud: true, packSource: 'Google' };
