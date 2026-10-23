// 仅用于 e2e 构建：自动化浏览器里没有登录 Chrome，getAuthToken 无法使用，改为本地假令牌。
// 正式构建（dist/）不包含本文件。
import { AppError } from './errors';
import type { AuthProvider, AuthStatus } from './auth';

export type { AuthProvider, AuthStatus };

const KEY = 'e2eAuthConnected';

export function oauthClientId(): string | undefined {
  return 'e2e-test-client.apps.googleusercontent.com';
}

export function chromeAuth(): AuthProvider {
  return {
    configured: () => true,
    async getToken(interactive) {
      const r = await chrome.storage.local.get(KEY);
      if (r[KEY]) return 'e2e-fake-token';
      if (!interactive) throw new AppError('auth', '尚未连接 YouTube 账号，或授权已失效', '在设置页点"连接 YouTube"');
      await chrome.storage.local.set({ [KEY]: true });
      return 'e2e-fake-token';
    },
    async invalidate() {},
    async status() {
      const r = await chrome.storage.local.get(KEY);
      return r[KEY] ? 'connected' : 'disconnected';
    },
    async disconnect() {
      await chrome.storage.local.remove(KEY);
    },
  };
}
