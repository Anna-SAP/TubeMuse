// 网络出口白名单的唯一来源。manifest 的 host_permissions 与 CSP connect-src 由构建脚本从这里生成。
// e2e 构建会用 endpoints.e2e.ts 整体替换本文件（指向本机 mock 服务），正式构建不含任何测试地址。

export const ENDPOINTS = {
  youtubeApi: 'https://www.googleapis.com/youtube/v3',
  googleOAuthRevoke: 'https://oauth2.googleapis.com/revoke',
  anthropic: 'https://api.anthropic.com',
  /** X 官方 API v2（Phase 3：热点） */
  x: 'https://api.x.com/2',
  openai: 'https://api.openai.com/v1',
} as const;

export type Endpoints = { [K in keyof typeof ENDPOINTS]: string };

/** 内容脚本注入、并接受其观看上报的站点（只读本地播放器状态，不抓取页面内容） */
export const TRACKED_SITES = ['https://www.youtube.com'] as const;
