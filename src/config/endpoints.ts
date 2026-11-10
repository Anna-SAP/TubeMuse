// 网络出口白名单的唯一来源。manifest 的 host_permissions 与 CSP connect-src 由构建脚本从这里生成。
// e2e 构建会用 endpoints.e2e.ts 整体替换本文件（指向本机 mock 服务），正式构建不含任何测试地址。

export const ENDPOINTS = {
  youtubeApi: 'https://www.googleapis.com/youtube/v3',
  /** Google 令牌端点：用授权码换令牌、用刷新令牌续期（Client Secret 与刷新令牌只发往这里，放在请求体里） */
  googleOAuthToken: 'https://oauth2.googleapis.com/token',
  googleOAuthRevoke: 'https://oauth2.googleapis.com/revoke',
  anthropic: 'https://api.anthropic.com',
  /** X 官方 API v2（Phase 3：热点） */
  x: 'https://api.x.com/2',
  openai: 'https://api.openai.com/v1',
  /** 豆瓣：只读条目评论的公开 RSS（/feed/subject/<ID>/reviews），不带 Cookie、不带 Referer */
  douban: 'https://www.douban.com',
} as const;

export type Endpoints = { [K in keyof typeof ENDPOINTS]: string };

/**
 * Google 授权页：由 chrome.identity.launchWebAuthFlow 在浏览器的授权窗口里打开，扩展自身不对它发请求，
 * 所以不在 ENDPOINTS（connect-src / host_permissions）里。
 */
export const GOOGLE_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * 豆瓣条目海报的图片域名（img1–img9）：只进 CSP img-src，由页面用 <img> 加载，不进 connect-src / host_permissions。
 * 豆瓣对外站加载图片有防盗链；被拒时界面说明原因并改用本地生成的封面，不伪装来源绕过。
 */
export const DOUBAN_IMAGE_ORIGINS: readonly string[] = Array.from({ length: 9 }, (_, i) => `https://img${i + 1}.doubanio.com`);

/** 内容脚本注入、并接受其观看上报的站点（只读本地播放器状态，不抓取页面内容） */
export const TRACKED_SITES = ['https://www.youtube.com'] as const;

/**
 * 小红书网页版（2026-11-03 新增，见 DECISIONS §40）：注入笔记发布时间与收藏按钮的页面。
 * www.rednote.com 是同一个网页版的国际域名（从海外网络打开 xiaohongshu.com 会被转到这里）。
 * 只用于内容脚本的 matches 与核对消息来源：扩展不向这两个站点发任何请求，所以不在 ENDPOINTS（connect-src / host_permissions）里。
 */
export const XHS_PAGES: readonly string[] = ['https://www.xiaohongshu.com/', 'https://www.rednote.com/'];

/**
 * Gmail 网页版（2026-11-04 新增，见 DECISIONS §44）：侧边栏 eMails 页读当前打开的邮件。
 * 只用于内容脚本的 matches：扩展不向这个站点发任何请求，所以不在 ENDPOINTS（connect-src / host_permissions）里；
 * 也不用 Gmail API（OAuth 只申请 youtube.readonly）。
 */
export const EMAIL_PAGES: readonly string[] = ['https://mail.google.com/'];

/**
 * X 网页版（2026-11-06 新增，见 DECISIONS §52）：片段录制脚本注入的页面。twitter.com 已全部跳到 x.com（当天实测），不用单独匹配。
 * 只用于内容脚本的 matches 与核对消息来源：扩展不向这个站点发任何请求，所以不在 ENDPOINTS（connect-src / host_permissions）里；
 * 官方 API 是另一个域名 api.x.com（ENDPOINTS.x）。
 */
export const X_PAGES: readonly string[] = ['https://x.com/'];

/**
 * 酷播网页版（2026-11-10 新增，见 DECISIONS §54）：片段录制脚本注入的页面，只录播放页 /play/<ID>。
 * 酷播是单页应用，从首页点进播放页不重新加载（当天实测），所以注入范围是整个站，脚本自己只认播放页。
 * 只用于内容脚本的 matches 与核对消息来源：扩展不向这个站点发任何请求，所以不在 ENDPOINTS（connect-src / host_permissions）里。
 */
export const KUBB_PAGES: readonly string[] = ['https://www.kubb.tv/'];

/**
 * Instagram 网页版（2026-11-10 新增，见 DECISIONS §56）：片段录制脚本注入的页面，只录首页信息流里正在播放、开着声音的那个视频。
 * Instagram 是单页应用，从别的页面回到首页不重新加载，所以注入范围是整个站，脚本自己只认首页。
 * 只用于内容脚本的 matches 与核对消息来源：扩展不向这个站点发任何请求，所以不在 ENDPOINTS（connect-src / host_permissions）里。
 */
export const IG_PAGES: readonly string[] = ['https://www.instagram.com/'];
