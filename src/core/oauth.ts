// Google 授权码 + PKCE（response_type=code、access_type=offline）的纯逻辑：
// 拼授权地址、解析回跳、解析令牌端点的响应、判断令牌是否还能用、把令牌端点的错误归类。
// 文档：developers.google.com/identity/protocols/oauth2/web-server
// 为什么不用隐式授权（response_type=token）：它没有刷新令牌，每小时只能靠隐藏窗口里的 prompt=none 续期，
// 而 Google 常常回 interaction_required（要你在窗口里确认或选择账号），续不上（DECISIONS §53）。

import { GOOGLE_OAUTH } from '../config/defaults';

export interface OAuthToken {
  accessToken: string;
  /** 毫秒时间戳 */
  expiresAt: number;
  scope: string;
  /** 只有换授权码时才有（续期时 Google 一般不再给新的） */
  refreshToken?: string;
  /** Google 给了刷新令牌有效期（refresh_token_expires_in）时，它失效的时间 */
  refreshExpiresAt?: number;
}

export function buildAuthUrl(p: { authorizeUrl: string; clientId: string; redirectUri: string; scope: string; state: string; codeChallenge: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: p.scope,
    state: p.state,
    // offline：要刷新令牌，之后在后台续期，不再需要你在场
    access_type: 'offline',
    prompt: GOOGLE_OAUTH.interactivePrompt,
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256',
  });
  // 不带 include_granted_scopes：只要这一个只读范围，不顺带拿到以前授过的其他范围
  return `${p.authorizeUrl}?${q.toString()}`;
}

export type CodeResult =
  | { ok: true; code: string }
  /** error 取 Google 回跳里的 error 字段；本地校验失败时为 invalid_redirect / state_mismatch / missing_code */
  | { ok: false; error: string };

/** 解析回跳地址（授权码在查询串里；也看 # 片段，以防万一）。 */
export function parseCodeRedirect(redirectUrl: string, expectedState: string): CodeResult {
  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    return { ok: false, error: 'invalid_redirect' };
  }
  const params = new URLSearchParams(url.search);
  for (const [k, v] of new URLSearchParams(url.hash.replace(/^#/, ''))) if (!params.has(k)) params.set(k, v);
  // 先校验 state：不是本次发起的回跳一律丢弃（防 CSRF），连错误信息也不采信
  if (params.get('state') !== expectedState) return { ok: false, error: 'state_mismatch' };
  const error = params.get('error');
  if (error) return { ok: false, error };
  const code = params.get('code');
  if (!code) return { ok: false, error: 'missing_code' };
  return { ok: true, code };
}

export type TokenResult =
  | { ok: true; token: OAuthToken }
  /** missing_token：响应里没有访问令牌；scope_missing：授权里没有 youtube.readonly */
  | { ok: false; error: 'missing_token' | 'scope_missing' };

const positive = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** 解析令牌端点（换授权码、续期）的成功响应 */
export function parseTokenResponse(body: unknown, requiredScope: string, now: number): TokenResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const accessToken = typeof b.access_token === 'string' ? b.access_token : '';
  if (!accessToken) return { ok: false, error: 'missing_token' };
  const scope = typeof b.scope === 'string' && b.scope ? b.scope : requiredScope;
  if (!scope.split(/\s+/).includes(requiredScope)) return { ok: false, error: 'scope_missing' };
  const seconds = positive(b.expires_in) ?? GOOGLE_OAUTH.defaultExpiresInSec;
  const refreshToken = typeof b.refresh_token === 'string' && b.refresh_token ? b.refresh_token : undefined;
  const refreshSeconds = positive(b.refresh_token_expires_in);
  return {
    ok: true,
    token: {
      accessToken,
      expiresAt: now + seconds * 1000,
      scope,
      ...(refreshToken ? { refreshToken } : {}),
      ...(refreshSeconds ? { refreshExpiresAt: now + refreshSeconds * 1000 } : {}),
    },
  };
}

/** 令牌端点的错误码（OAuth 标准的 error 字段）；没有时用 http_<状态码> */
export function tokenErrorCode(status: number, body: unknown): string {
  const e = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  return typeof e === 'string' && e ? e.slice(0, 60) : `http_${status}`;
}

/**
 * 续期失败归类：
 * - transient：网络、Google 服务端 5xx、限流 → 授权本身没坏，稍后自动再试，不标成"已过期"
 * - revoked：刷新令牌失效（invalid_grant：测试状态下 7 天到期、你在 Google 账号里移除了授权、改了密码……）→ 只能重新授权
 * - client：Google 不认这个客户端或 Client Secret → 改设置页的 Client Secret，刷新令牌还能用
 * - other：其他 → 记下原因，冷却后再试
 */
export type RenewFailure = 'transient' | 'revoked' | 'client' | 'other';

const CLIENT_ERRORS = new Set(['invalid_client', 'unauthorized_client', 'deleted_client', 'disabled_client']);

export function classifyTokenError(status: number, code: string): RenewFailure {
  if (status >= 500 || status === 429) return 'transient';
  if (code === 'invalid_grant') return 'revoked';
  if (CLIENT_ERRORS.has(code)) return 'client';
  return 'other';
}

/** 令牌在留出安全余量后仍有效 */
export function tokenUsable(t: { accessToken?: string; expiresAt?: number } | null | undefined, now: number): boolean {
  return !!t?.accessToken && typeof t.expiresAt === 'number' && t.expiresAt - GOOGLE_OAUTH.expiryMarginMs > now;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE 的 code_verifier：32 字节随机数 → 43 个字符（RFC 7636 要求 43–128 个字符） */
export function pkceVerifier(random: Uint8Array): string {
  if (random.length < 32) throw new Error('PKCE 需要至少 32 字节随机数');
  return base64url(random);
}

/** PKCE 的 code_challenge（S256）：BASE64URL(SHA256(verifier)) */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
