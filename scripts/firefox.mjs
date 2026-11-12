// @ts-check
// Firefox 版的固定参数（DECISIONS §69）：构建脚本与 Firefox e2e 共用。
import { createHash } from 'node:crypto';

/**
 * Firefox 版的扩展 ID（manifest 的 browser_specific_settings.gecko.id）。授权回跳地址由它算出，所以必须固定；
 * 测试版用另一个，免得和正式版同时装时冲突。
 */
export const FIREFOX_ADDON_ID = 'tubemuse@tubemuse.local';
export const FIREFOX_E2E_ADDON_ID = 'tubemuse-e2e@tubemuse.local';

/**
 * Firefox 最低版本：149 起才有标准的 HTMLMediaElement.captureStream()（取视频的声音不影响播放；更早只有会让视频变哑的
 * mozCaptureStream，见 src/content/capture-stream.ts）；内容脚本的 world: MAIN（128）、ClipboardItem（127）都在它之前。
 */
export const FIREFOX_MIN_VERSION = '149.0';

/** Firefox 的 identity.getRedirectURL()：https://<扩展 ID 的 SHA-1 十六进制>.extensions.allizom.org/ */
export function firefoxRedirectUrl(/** @type {string} */ addonId) {
  return `https://${createHash('sha1').update(addonId).digest('hex')}.extensions.allizom.org/`;
}
