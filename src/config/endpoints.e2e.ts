// 仅用于 e2e 构建（dist-e2e）：所有外部服务指向本机 mock，测试不发出真实网络请求。
import type { Endpoints } from './endpoints';

const MOCK = 'http://127.0.0.1:47321';

export const ENDPOINTS: Endpoints = {
  youtubeApi: `${MOCK}/youtube/v3`,
  googleOAuthRevoke: `${MOCK}/oauth/revoke`,
  anthropic: `${MOCK}/anthropic`,
  x: `${MOCK}/x/2`,
  openai: `${MOCK}/openai/v1`,
};

export type { Endpoints };

/** e2e：在本机 mock 的"播放页"上注入观看追踪脚本 */
export const TRACKED_SITES = ['https://www.youtube.com', MOCK] as const;
