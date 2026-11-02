// 多语字幕：内容脚本与页面内助手（跑在 YouTube 页面环境里）之间的协议。
// 页面内助手只依赖这个文件：不带入任何设置、默认值或别的扩展代码。

/** window.postMessage 的标记 */
export const BRIDGE_TAG = 'tubemuse-multicc';
export const BRIDGE_OPS = ['state', 'prime', 'hide-native', 'restore-native', 'forget-native'] as const;
export type BridgeOp = (typeof BRIDGE_OPS)[number];

const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;

/** 字幕接口用的语言代码（BCP-47 的常见写法，例如 zh-Hans、en、pt-BR） */
export function isLangCode(x: unknown): x is string {
  return typeof x === 'string' && LANG_RE.test(x);
}
