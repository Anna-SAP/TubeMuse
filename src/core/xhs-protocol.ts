// 小红书：页面脚本与页面内助手（跑在小红书页面环境里）之间的协议。
// 页面内助手只依赖这个文件：不带入任何设置、默认值或别的扩展代码。

/** window.postMessage 的标记 */
export const XHS_BRIDGE_TAG = 'tubemuse-xhs';
/** 唯一的请求：读页面数据里各笔记的发布时间 */
export const XHS_BRIDGE_OP = 'times';
/** 页面数据很大时也不卡：最多走这么多个对象、这么深，交回这么多条（内容脚本按 maxEntries 截断助手的回答） */
export const XHS_BRIDGE_LIMITS = { maxNodes: 60_000, maxEntries: 3000, maxDepth: 10 } as const;
