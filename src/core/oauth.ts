// Google 隐式授权（response_type=token）的纯逻辑：拼授权地址、解析回跳、判断令牌是否还能用。
// 文档：developers.google.com/identity/protocols/oauth2/javascript-implicit-flow

import { GOOGLE_OAUTH } from '../config/defaults';

export interface OAuthToken {
  accessToken: string;
  /** 毫秒时间戳 */
  expiresAt: number;
  scope: string;
}

/** select_account：交互授权时让用户挑账号（浏览器里登录了多个 Google 账号时尤其需要）；none：静默续期 */
export type OAuthPrompt = 'select_account' | 'none';

export function buildAuthUrl(p: { authorizeUrl: string; clientId: string; redirectUri: string; scope: string; state: string; prompt: OAuthPrompt }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'token',
    scope: p.scope,
    state: p.state,
    prompt: p.prompt,
  });
  // 不带 include_granted_scopes：只要这一个只读范围，不顺带拿到以前授过的其他范围
  return `${p.authorizeUrl}?${q.toString()}`;
}

export type RedirectResult =
  | { ok: true; token: OAuthToken }
  /** error 取 Google 回跳里的 error 字段；本地校验失败时为 state_mismatch / missing_token / scope_missing */
  | { ok: false; error: string };

/** 解析回跳地址（结果在 # 片段里；个别错误放在查询串里，两处都看）。 */
export function parseAuthRedirect(redirectUrl: string, expectedState: string, requiredScope: string, now: number): RedirectResult {
  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    return { ok: false, error: 'invalid_redirect' };
  }
  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  for (const [k, v] of url.searchParams) if (!params.has(k)) params.set(k, v);
  // 先校验 state：不是本次发起的回跳一律丢弃（防 CSRF），连错误信息也不采信
  if (params.get('state') !== expectedState) return { ok: false, error: 'state_mismatch' };
  const error = params.get('error');
  if (error) return { ok: false, error };
  const accessToken = params.get('access_token');
  if (!accessToken) return { ok: false, error: 'missing_token' };
  const scope = params.get('scope') ?? requiredScope;
  if (!scope.split(/\s+/).includes(requiredScope)) return { ok: false, error: 'scope_missing' };
  const expiresIn = Number(params.get('expires_in'));
  const seconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : GOOGLE_OAUTH.defaultExpiresInSec;
  return { ok: true, token: { accessToken, expiresAt: now + seconds * 1000, scope } };
}

/** 令牌在留出安全余量后仍有效 */
export function tokenUsable(t: { accessToken?: string; expiresAt?: number } | null | undefined, now: number): boolean {
  return !!t?.accessToken && typeof t.expiresAt === 'number' && t.expiresAt - GOOGLE_OAUTH.expiryMarginMs > now;
}

/** prompt=none 时 Google 表示"需要用户操作"的错误码 */
export const SILENT_NEEDS_USER = new Set(['interaction_required', 'login_required', 'consent_required', 'account_selection_required']);
