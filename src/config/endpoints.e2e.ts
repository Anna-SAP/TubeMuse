// 仅用于 e2e 构建（dist-e2e）：所有外部服务指向本机 mock，测试不发出真实网络请求。
import type { Endpoints } from './endpoints';

const MOCK = 'http://127.0.0.1:47321';

export const ENDPOINTS: Endpoints = {
  youtubeApi: `${MOCK}/youtube/v3`,
  googleOAuthRevoke: `${MOCK}/oauth/revoke`,
  anthropic: `${MOCK}/anthropic`,
  x: `${MOCK}/x/2`,
  openai: `${MOCK}/openai/v1`,
  douban: `${MOCK}/douban`,
};

export type { Endpoints };

/**
 * e2e：mock RSS 里的海报仍是豆瓣图片地址，由 Playwright 在本地应答 418（模拟防盗链），不出网。
 * 不能从 ./endpoints 再导出：e2e 构建会把对 ./endpoints 的导入换成本文件自己。
 */
export const DOUBAN_IMAGE_ORIGINS: readonly string[] = Array.from({ length: 9 }, (_, i) => `https://img${i + 1}.doubanio.com`);

/** e2e：mock 授权页直接 302 回跳 https://<扩展ID>.chromiumapp.org/#access_token=… */
export const GOOGLE_OAUTH_AUTHORIZE_URL = `${MOCK}/oauth/authorize`;

/** e2e：在本机 mock 的"播放页"上注入观看追踪脚本 */
export const TRACKED_SITES = ['https://www.youtube.com', MOCK] as const;
