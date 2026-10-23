// YouTube 授权：chrome.identity.getAuthToken（Chrome 管理令牌缓存与刷新，只申请 youtube.readonly）。
// e2e 构建会把本文件替换为 auth.e2e.ts。

import { GOOGLE_OAUTH_SCOPE } from '../config/defaults';
import { ENDPOINTS } from '../config/endpoints';
import { AppError } from './errors';

export type AuthStatus = 'connected' | 'disconnected' | 'not_configured';

export interface AuthProvider {
  /** interactive=true 时可能弹出 Google 授权窗口 */
  getToken(interactive: boolean): Promise<string>;
  /** 令牌被 API 拒绝（401）后调用，让下次重新获取 */
  invalidate(token: string): Promise<void>;
  status(): Promise<AuthStatus>;
  disconnect(): Promise<void>;
  /** 是否在 manifest 里配置了 OAuth Client ID */
  configured(): boolean;
}

export function oauthClientId(): string | undefined {
  const id = chrome.runtime.getManifest().oauth2?.client_id;
  return id && id.trim() ? id : undefined;
}

/** 把 chrome.identity 的英文报错翻译成人话（报错文本取自 Chromium identity API 源码）。 */
export function authError(msg: string, interactive: boolean): AppError {
  // Chrome 设置里关掉了"允许登录 Chrome"（prefs::kSigninAllowed），或被组织策略禁止
  if (/turned off browser sign-?in/i.test(msg)) {
    return new AppError(
      'auth',
      'Chrome 关闭了"允许登录 Chrome"，扩展无法用你的 Google 账号授权',
      '地址栏打开 chrome://settings/syncSetup →「其他 Google 服务」里打开"允许登录 Chrome"→ 点右上角头像，用你加进测试用户的 Google 账号登录（不必开启同步）→ 回来再点"连接 YouTube"。如果这个开关是灰色的（由组织管理），这台电脑的 Chrome 不能用这种授权方式',
    );
  }
  if (/not signed in|sign in/i.test(msg)) {
    return new AppError('auth', 'Chrome 当前没有登录 Google 账号，无法授权', '先在 Chrome 右上角登录你的 Google 账号，再点"连接 YouTube"');
  }
  if (/did not approve|canceled|cancelled|user closed/i.test(msg)) {
    return new AppError(
      'auth',
      '授权没有完成',
      '如果授权页显示"Access blocked"或"Error 403: access_denied"：到 Google Cloud → Google Auth Platform →「目标对象 / Audience」→ 测试用户，添加你登录 Chrome 的这个 Gmail，几分钟后再点"连接 YouTube"。如果是你自己关掉了授权页：需要允许"查看你的 YouTube 账号"（只读）才能同步订阅和找片',
    );
  }
  if (/bad client id|invalid.*client/i.test(msg)) {
    return new AppError('oauth_config', 'OAuth Client ID 无效或与扩展 ID 不匹配', '核对 Google Cloud 里 OAuth 客户端的"商品 ID"是否等于设置页显示的扩展 ID');
  }
  if (!interactive) return new AppError('auth', '尚未连接 YouTube 账号，或授权已失效', '在设置页点"连接 YouTube"');
  return new AppError('auth', `YouTube 授权失败：${msg.slice(0, 200)}`);
}

export function chromeAuth(): AuthProvider {
  const configured = () => !!oauthClientId();
  const assertConfigured = () => {
    if (!configured()) {
      throw new AppError(
        'oauth_config',
        '还没有配置 Google OAuth 客户端',
        '按 README「Google Cloud 配置」创建"Chrome 扩展"类型的 OAuth 客户端，把 Client ID 写进 local/config.json 后重新构建',
      );
    }
  };
  return {
    configured,
    async getToken(interactive) {
      assertConfigured();
      try {
        const r = await chrome.identity.getAuthToken({ interactive, scopes: [GOOGLE_OAUTH_SCOPE] });
        if (!r.token) throw new Error('empty token');
        if (r.grantedScopes && r.grantedScopes.some((s) => s !== GOOGLE_OAUTH_SCOPE && !s.endsWith('/userinfo.email') && s !== 'openid')) {
          // 理论上不会发生：我们只申请 youtube.readonly
          console.warn('[TubeMuse] 授权范围超出预期');
        }
        return r.token;
      } catch (e) {
        throw authError(e instanceof Error ? e.message : String(e), interactive);
      }
    },
    async invalidate(token) {
      await chrome.identity.removeCachedAuthToken({ token });
    },
    async status() {
      if (!configured()) return 'not_configured';
      try {
        const r = await chrome.identity.getAuthToken({ interactive: false, scopes: [GOOGLE_OAUTH_SCOPE] });
        return r.token ? 'connected' : 'disconnected';
      } catch {
        return 'disconnected';
      }
    },
    async disconnect() {
      if (!configured()) return;
      try {
        const r = await chrome.identity.getAuthToken({ interactive: false, scopes: [GOOGLE_OAUTH_SCOPE] });
        if (r.token) {
          // 吊销令牌：只发往 Google 官方 OAuth 端点，令牌放在请求体里
          await fetch(ENDPOINTS.googleOAuthRevoke, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: r.token }).toString(),
          }).catch(() => undefined);
          await chrome.identity.removeCachedAuthToken({ token: r.token });
        }
      } catch {
        // 本来就没连接
      }
      await chrome.identity.clearAllCachedAuthTokens();
    },
  };
}
