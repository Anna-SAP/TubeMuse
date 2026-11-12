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

/**
 * Firefox 内置的数据收集声明（manifest 的 browser_specific_settings.gecko.data_collection_permissions，DECISIONS §71）。
 * 2025-11-03 起新提交到 addons.mozilla.org 签名的扩展必须声明，不声明签名会被拒；Firefox 140+ 在安装确认框里列给你看。
 * Mozilla 的定义：扩展把数据发到扩展以外的任何地方都算。下面四项都是"必需"（安装时同意一次），对应的功能：
 * - searchTerms：找片口令发给你选的大模型，搜索词发给 YouTube Data API（核心功能）
 * - browsingActivity：每日总结、兴趣簇——看过 / 喜欢的视频标题、频道、看了多少发给大模型
 * - websiteContent：eMails 把邮件里的文章标题和摘要发给大模型；自动字幕选 OpenAI 转写时把视频声音发给 OpenAI
 * - personalCommunications：eMails 读的是你的邮件（只发文章标题和摘要，不发主题、发件人），保守起见声明
 * 没有声明的：authenticationInfo（Key 和令牌只发往各自的服务登录它自己）、locationInfo（只发时区换算"两天内"）、
 * technicalAndInteraction（没有任何遥测）、personallyIdentifyingInfo（不发姓名、联系方式）。
 * 新增会把数据发出去的功能时，要回来对一遍这张表（README「隐私与数据」列着每一类发了什么）。
 */
export const FIREFOX_DATA_COLLECTION = Object.freeze({ required: Object.freeze(['searchTerms', 'browsingActivity', 'websiteContent', 'personalCommunications']) });
