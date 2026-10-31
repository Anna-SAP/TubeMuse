// 网络出口白名单的唯一来源。manifest 的 host_permissions 与 CSP connect-src 由构建脚本从这里生成。
// e2e 构建会用 endpoints.e2e.ts 整体替换本文件（指向本机 mock 服务），正式构建不含任何测试地址。

export const ENDPOINTS = {
  youtubeApi: 'https://www.googleapis.com/youtube/v3',
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
