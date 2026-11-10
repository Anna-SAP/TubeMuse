// 仅用于 e2e 构建（dist-e2e）：所有外部服务指向本机 mock，测试不发出真实网络请求。
import type { Endpoints } from './endpoints';

const MOCK = 'http://127.0.0.1:47321';

export const ENDPOINTS: Endpoints = {
  youtubeApi: `${MOCK}/youtube/v3`,
  googleOAuthToken: `${MOCK}/oauth/token`,
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

/** e2e：mock 授权页直接 302 回跳 https://<扩展ID>.chromiumapp.org/?code=…（授权码再到 mock 的 /oauth/token 换令牌） */
export const GOOGLE_OAUTH_AUTHORIZE_URL = `${MOCK}/oauth/authorize`;

/** e2e：在本机 mock 的"播放页"上注入观看追踪脚本 */
export const TRACKED_SITES = ['https://www.youtube.com', MOCK] as const;

/** e2e：本机 mock 的 /xhs/ 下是仿小红书网页版的页面（小红书脚本只注入这里，不碰 mock 的 YouTube 播放页） */
export const XHS_PAGES: readonly string[] = ['https://www.xiaohongshu.com/', 'https://www.rednote.com/', `${MOCK}/xhs/`];

/** e2e：本机 mock 的 /gmail/ 下是仿 Gmail 的页面（邮件脚本只注入这里） */
export const EMAIL_PAGES: readonly string[] = ['https://mail.google.com/', `${MOCK}/gmail/`];

/** e2e：本机 mock 的 /xpage/ 下是仿 X 网页版的页面（mock 的 /x/ 是 X 官方 API，不要混用） */
export const X_PAGES: readonly string[] = ['https://x.com/', `${MOCK}/xpage/`];

/** e2e：本机 mock 的 /kubb/ 下是仿酷播网页版的页面 */
export const KUBB_PAGES: readonly string[] = ['https://www.kubb.tv/', `${MOCK}/kubb/`];
