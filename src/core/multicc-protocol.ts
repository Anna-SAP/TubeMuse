// 多语字幕：内容脚本与页面内助手（跑在 YouTube 页面环境里）之间的协议。
// 页面内助手只依赖这个文件：不带入任何设置、默认值或别的扩展代码。

/** window.postMessage 的标记 */
export const BRIDGE_TAG = 'tubemuse-multicc';
export const BRIDGE_OPS = ['state', 'prime', 'hide-native', 'restore-native', 'forget-native'] as const;
export type BridgeOp = (typeof BRIDGE_OPS)[number];

/**
 * 正在看的视频所在的播放器（根元素 ID）：Shorts（/shorts/<ID>）是 #shorts-player，别的页面是 #movie_player
 * （2026-11-11 核实页面里的播放器配置，DECISIONS §66、§67）。Shorts 页面上还藏着一个 #movie_player，不用它。
 */
export function playerRootId(pathname: string): 'shorts-player' | 'movie_player' {
  return pathname.startsWith('/shorts/') ? 'shorts-player' : 'movie_player';
}

const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;

/** 字幕接口用的语言代码（BCP-47 的常见写法，例如 zh-Hans、en、pt-BR） */
export function isLangCode(x: unknown): x is string {
  return typeof x === 'string' && LANG_RE.test(x);
}
