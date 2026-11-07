// YouTube 授权：chrome.identity.launchWebAuthFlow + Google"Web 应用"类型客户端的授权码 + PKCE（只申请 youtube.readonly）。
// 不依赖浏览器级 Google 登录，Comet 等非 Chrome 的 Chromium 浏览器同样可用：授权窗口里登录哪个 Google 账号就用哪个。
// 连接时拿到刷新令牌（access_type=offline），存在本机；访问令牌约 1 小时有效，过期后在后台用刷新令牌向 Google 令牌端点换新的——
// 不弹窗、不开隐藏窗口、不依赖浏览器里网页版 Google 的登录状态，扩展重新加载、浏览器重启后照样续得上（DECISIONS §53）。
// 交互授权（连接 / 重新授权）由后台发起，见 auth-service.ts。

import { GOOGLE_OAUTH, GOOGLE_OAUTH_SCOPE } from '../config/defaults';
import { ENDPOINTS, GOOGLE_OAUTH_AUTHORIZE_URL } from '../config/endpoints';
import { buildAuthUrl, classifyTokenError, parseCodeRedirect, parseTokenResponse, pkceChallenge, pkceVerifier, tokenErrorCode, tokenUsable } from '../core/oauth';
import { AppError } from './errors';
import { stores, type YouTubeAuthState } from './repo';
import type { KV, Locker } from './storage';

/** expired：连接过，但现在续不上（刷新令牌失效、Client Secret 不对、旧版授权没有刷新令牌），需要你处理一次 */
export type AuthStatus = 'connected' | 'expired' | 'disconnected' | 'not_configured';

export interface AuthProvider {
  /** interactive=true 时弹出 Google 登录 / 授权窗口 */
  getToken(interactive: boolean): Promise<string>;
  /** 令牌被 API 拒绝（401）后调用，让下次重新获取 */
  invalidate(token: string): Promise<void>;
  status(): Promise<AuthStatus>;
  /** 断开：删除本地令牌，并向 Google 吊销（有刷新令牌时吊销它，连带它换出的访问令牌）。返回是否吊销成功 */
  disconnect(): Promise<{ revoked: boolean }>;
  /** 是否在构建时配置了 OAuth Client ID */
  configured(): boolean;
}

/** 连接过 YouTube（令牌可能需要续期）：后台任务可以尝试调用，失败会记录并提示，不会静默 */
export function isLinked(s: AuthStatus): boolean {
  return s === 'connected' || s === 'expired';
}

declare const __OAUTH_CLIENT_ID__: string;

export function oauthClientId(): string | undefined {
  const id = typeof __OAUTH_CLIENT_ID__ === 'string' ? __OAUTH_CLIENT_ID__.trim() : '';
  return id || undefined;
}

/** Google Cloud 里"已获授权的重定向 URI"要填的地址：https://<扩展ID>.chromiumapp.org/ */
export function oauthRedirectUrl(): string {
  return chrome.identity.getRedirectURL();
}

const NOT_CONNECTED = () => new AppError('auth', '尚未连接 YouTube 账号', '在设置页点"连接 YouTube"');

/** 旧版（隐式授权）记录没有刷新令牌：过期后只能重新授权一次 */
export const LEGACY_REASON = '这是旧版授权，没有刷新令牌，访问令牌过期后不能自动续期。在设置页填好 Client Secret 后点"重新授权"一次，之后会一直自动续期';
const NO_SECRET_REASON = '还没有填写 OAuth Client Secret，无法自动续期';

/** 需要你处理时的具体原因（界面显示用）：记下的续期失败原因；旧版授权说明没有刷新令牌 */
export function authProblem(st: YouTubeAuthState | null | undefined): string | undefined {
  if (!st) return undefined;
  if (st.renewReason) return st.renewReason;
  if (!st.refreshToken) return LEGACY_REASON;
  return undefined;
}

/** 续期没成功；reason 是具体原因，一并显示，不笼统地说"没有成功"。fix=secret 时要做的是改 Client Secret，而不是重新授权 */
function expiredError(reason: string | undefined, fix?: 'secret'): AppError & { reason?: string } {
  const e = new AppError(
    'auth',
    `YouTube 授权已过期，自动续期没有成功${reason ? `（${reason}）` : ''}`,
    fix === 'secret'
      ? '到设置页「2. YouTube 账号」重新填写 OAuth Client Secret（刷新令牌还在，填好就能续上，不用重新授权）'
      : '点"重新授权"（设置页「2. YouTube 账号」或侧边栏顶部）。授权一次后，访问令牌过期会在后台自动续期',
  );
  return reason ? Object.assign(e, { reason }) : e;
}

/** 续期时 Google 令牌端点的错误码 → 人话原因 */
export function renewReason(code: string): string {
  switch (code) {
    case 'invalid_grant':
      return `刷新令牌已失效（invalid_grant）。常见原因：Google Cloud 里的应用还是"测试"状态，Google 让刷新令牌 ${GOOGLE_OAUTH.testingRefreshTtlDays} 天后失效；或你在 Google 账号里移除了 TubeMuse 的访问权限、改了密码`;
    case 'invalid_client':
    case 'deleted_client':
    case 'disabled_client':
      return `Google 不认这个 Client Secret 或客户端（${code}）：可能填错了，或已在 Google Cloud 里停用、删除`;
    case 'unauthorized_client':
      return 'Google 不允许这个客户端续期（unauthorized_client）：客户端类型须为"Web 应用"，Client Secret 须属于同一个客户端';
    default:
      return `Google 拒绝续期（${code}）`;
  }
}

/** 交互授权时 launchWebAuthFlow 抛出的错误 → 人话。浏览器报错原文不保证稳定，按关键词宽松匹配。 */
export function authError(msg: string): AppError {
  if (/did not approve|closed|cancel/i.test(msg)) {
    // Google 拦下请求时（未加入测试用户、回跳地址不匹配、客户端无效）只会显示错误页，用户关掉窗口后扩展收到的也是这一条
    return new AppError(
      'auth',
      '授权没有完成',
      '看授权窗口里的提示：显示"Access blocked"或"Error 403: access_denied"→ 到 Google Cloud → Google Auth Platform →「目标对象 / Audience」把这个 Gmail 加进测试用户；显示"redirect_uri_mismatch"→ 客户端的"已获授权的重定向 URI"必须与设置页显示的回跳地址完全一致（含结尾的 /）；显示"invalid_client"或"OAuth client was not found"→ 核对 Client ID，客户端类型须为"Web 应用"。如果是你自己关掉了窗口，再点一次"连接 YouTube"即可',
    );
  }
  if (/could not be loaded|load/i.test(msg)) {
    return new AppError('network', '打不开 Google 授权页', '检查网络能否访问 accounts.google.com 后重试');
  }
  return new AppError('auth', `YouTube 授权失败：${msg.slice(0, 200)}`, '重新点"连接 YouTube"；反复出现请按 README「故障排查」核对 Google Cloud 配置');
}

/** 交互授权时 Google 回跳里的错误 → 人话 */
function redirectError(error: string): AppError {
  switch (error) {
    case 'access_denied':
      return new AppError('auth', '你在 Google 授权页拒绝了访问', '需要允许"查看你的 YouTube 账号"（只读）才能同步订阅和找片；重新点"连接 YouTube"');
    case 'state_mismatch':
      return new AppError('auth', '授权回跳校验失败（state 不匹配），本次结果已丢弃', '重新点"连接 YouTube"');
    case 'scope_missing':
      return new AppError('auth', '授权里没有包含"查看你的 YouTube 账号"', '重新点"连接 YouTube"，在授权页勾选这一项');
    default:
      return new AppError('auth', `Google 授权没有返回授权码（${error.slice(0, 60)}）`, '重新点"连接 YouTube"；反复出现请核对 Google Cloud 里的客户端类型是否为"Web 应用"');
  }
}

/** 用授权码换令牌时令牌端点的错误 → 人话 */
function exchangeError(code: string): AppError {
  if (code === 'invalid_client' || code === 'unauthorized_client' || code === 'deleted_client' || code === 'disabled_client') {
    return new AppError(
      'oauth_config',
      `Google 不认这个 Client Secret（${code}）`,
      '核对设置页里的 Client Secret 与 Client ID 属于同一个"Web 应用"客户端（Google Cloud → Google Auth Platform →「客户端」）。Secret 只在创建时显示一次，丢了就在该客户端页面点"Add secret"新建一个，粘贴到设置页',
    );
  }
  if (code === 'redirect_uri_mismatch') {
    return new AppError('oauth_config', '回跳地址与 Google Cloud 里登记的不一致（redirect_uri_mismatch）', '客户端的"已获授权的重定向 URI"必须与设置页显示的回跳地址完全一致（含结尾的 /）');
  }
  if (code === 'invalid_grant') return new AppError('auth', '授权码已失效（invalid_grant）', '重新点"连接 YouTube"');
  return new AppError('auth', `Google 没有发放令牌（${code}）`, '重新点"连接 YouTube"；反复出现请按 README「故障排查」核对 Google Cloud 配置');
}

export interface WebAuthDeps {
  kv: KV;
  locker: Locker;
  clientId: string | undefined;
  /** 设置页里填的 Client Secret（每次用时现读，改了立刻生效） */
  clientSecret: () => Promise<string | undefined>;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  redirectUrl: () => string;
  /** 打开（交互的）授权窗口，返回最终回跳地址 */
  launch: (url: string) => Promise<string | undefined>;
  http: typeof fetch;
  now: () => number;
  randomState: () => string;
  /** PKCE 的 code_verifier */
  randomVerifier: () => string;
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

export function webAuthFlowAuth(d: WebAuthDeps): AuthProvider {
  const store = stores.youtubeAuth;
  const configured = () => !!d.clientId;
  /** 同一页面里多个请求同时发现令牌过期时，只续期一次 */
  let renewing: Promise<string> | undefined;
  /** 交互授权同一时间只开一个窗口：重复点击等同一个结果 */
  let connecting: Promise<string> | undefined;

  /** 向令牌端点 POST 表单；网络错误 / 超时转成人话 */
  async function postToken(form: Record<string, string>, networkError: () => AppError): Promise<{ status: number; ok: boolean; body: unknown }> {
    let res: Response;
    try {
      res = await d.http(d.tokenUrl, { method: 'POST', headers: FORM, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(GOOGLE_OAUTH.tokenTimeoutMs) });
    } catch {
      throw networkError();
    }
    return { status: res.status, ok: res.ok, body: await res.json().catch(() => ({})) };
  }

  /** 交互授权：弹窗 → 授权码 → 换访问令牌与刷新令牌 → 存下 */
  async function connect(): Promise<string> {
    const secret = (await d.clientSecret())?.trim();
    if (!secret) {
      throw new AppError(
        'oauth_config',
        '还没有填写 Google OAuth Client Secret',
        '在设置页「2. YouTube 账号」粘贴 Google Cloud 里这个"Web 应用"客户端的 Client Secret（多以 GOCSPX- 开头）后再连接。有了它才能拿到刷新令牌，之后访问令牌过期会在后台自动续期',
      );
    }
    const state = d.randomState();
    const verifier = d.randomVerifier();
    const redirectUri = d.redirectUrl();
    const url = buildAuthUrl({ authorizeUrl: d.authorizeUrl, clientId: d.clientId!, redirectUri, scope: GOOGLE_OAUTH_SCOPE, state, codeChallenge: await pkceChallenge(verifier) });
    let redirect: string | undefined;
    try {
      redirect = await d.launch(url);
    } catch (e) {
      throw authError(e instanceof Error ? e.message : String(e));
    }
    if (!redirect) throw authError('empty redirect');
    const r = parseCodeRedirect(redirect, state);
    if (!r.ok) throw redirectError(r.error);
    const res = await postToken(
      { code: r.code, client_id: d.clientId!, client_secret: secret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier },
      () => new AppError('network', '连不上 Google 换取令牌（网络错误或超时）', '检查网络能否访问 oauth2.googleapis.com 后重新点"连接 YouTube"'),
    );
    if (!res.ok) throw exchangeError(tokenErrorCode(res.status, res.body));
    const now = d.now();
    const t = parseTokenResponse(res.body, GOOGLE_OAUTH_SCOPE, now);
    if (!t.ok) throw redirectError(t.error);
    if (!t.token.refreshToken) {
      // prompt=consent + access_type=offline 时 Google 照例会给；万一没给，不能假装"会自动续期"
      throw new AppError('auth', 'Google 没有发放刷新令牌，无法自动续期', '重新点"连接 YouTube"；反复出现时到 Google 账号「安全 → 第三方应用和服务」移除 TubeMuse 后再连接');
    }
    const token = t.token;
    // 整条替换：旧的续期失败标记、旧版记录一并清掉
    await store.update(d.kv, d.locker, (prev) => ({
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      scope: token.scope,
      refreshToken: token.refreshToken!,
      refreshIssuedAt: now,
      ...(token.refreshExpiresAt ? { refreshExpiresAt: token.refreshExpiresAt } : {}),
      connectedAt: prev?.connectedAt ?? now,
    }));
    return token.accessToken;
  }

  /** 记下续期失败（只在记录仍是用这个刷新令牌、且没有别处刚换来新令牌时） */
  async function markFailed(refreshToken: string, reason: string, opts: { drop?: boolean; fix?: 'secret' } = {}): Promise<void> {
    await store.update(d.kv, d.locker, (s) => {
      if (!s || s.refreshToken !== refreshToken || tokenUsable(s, d.now())) return s;
      const { renewFix: _f, ...rest } = s;
      const next: YouTubeAuthState = { ...rest, renewFailedAt: d.now(), renewReason: reason, ...(opts.fix ? { renewFix: opts.fix } : {}) };
      if (opts.drop) {
        delete next.refreshToken;
        delete next.refreshIssuedAt;
        delete next.refreshExpiresAt;
      }
      return next;
    });
  }

  /** 用刷新令牌换新的访问令牌。各页面（侧边栏、设置页、后台）之间用锁串行：一个换完，其他直接用它的结果 */
  function renew(): Promise<string> {
    return d.locker.withLock(`${store.key}:renew`, async () => {
      const cur = await store.read(d.kv);
      if (!cur) throw NOT_CONNECTED();
      if (tokenUsable(cur, d.now())) return cur.accessToken!;
      const rt = cur.refreshToken;
      if (!rt) throw expiredError(authProblem(cur));
      const secret = (await d.clientSecret())?.trim();
      if (!secret) {
        await markFailed(rt, NO_SECRET_REASON, { fix: 'secret' });
        throw expiredError(NO_SECRET_REASON, 'secret');
      }
      const res = await postToken(
        { client_id: d.clientId!, client_secret: secret, refresh_token: rt, grant_type: 'refresh_token' },
        () => new AppError('network', '自动续期 YouTube 授权时连不上 Google（网络错误或超时）', '检查网络后重试。授权本身没有失效，联网后会自动续上'),
      );
      if (res.ok) {
        const now = d.now();
        const t = parseTokenResponse(res.body, GOOGLE_OAUTH_SCOPE, now);
        if (!t.ok) {
          const reason = t.error === 'scope_missing' ? 'Google 续期给的令牌不含"查看你的 YouTube 账号"' : 'Google 续期没有返回访问令牌';
          await markFailed(rt, reason);
          throw expiredError(reason);
        }
        const token = t.token;
        await store.update(d.kv, d.locker, (s) => {
          // 续期途中你断开了，或交互授权换了新的刷新令牌：不覆盖
          if (!s || s.refreshToken !== rt) return s;
          const { renewFailedAt: _a, renewReason: _b, renewFix: _c, ...rest } = s;
          return {
            ...rest,
            accessToken: token.accessToken,
            expiresAt: token.expiresAt,
            scope: token.scope,
            // Google 一般不轮换刷新令牌；给了新的就换上
            ...(token.refreshToken ? { refreshToken: token.refreshToken, refreshIssuedAt: now } : {}),
            ...(token.refreshExpiresAt ? { refreshExpiresAt: token.refreshExpiresAt } : {}),
          };
        });
        return token.accessToken;
      }
      const code = tokenErrorCode(res.status, res.body);
      const kind = classifyTokenError(res.status, code);
      if (kind === 'transient') {
        // 不标成"已过期"：授权本身没坏，下次用时再试
        throw new AppError('network', `Google 授权服务暂时不可用（${code}），这次没有续上`, '稍后重试。授权本身没有失效，不用重新授权');
      }
      const reason = renewReason(code);
      if (kind === 'revoked') await markFailed(rt, reason, { drop: true });
      else await markFailed(rt, reason, kind === 'client' ? { fix: 'secret' } : {});
      throw expiredError(reason, kind === 'client' ? 'secret' : undefined);
    });
  }

  return {
    configured,
    async getToken(interactive) {
      if (!configured()) {
        throw new AppError(
          'oauth_config',
          '还没有配置 Google OAuth 客户端',
          '按 README「Google Cloud 配置」创建"Web 应用"类型的 OAuth 客户端，把 Client ID 写进 local/config.json 后重新构建',
        );
      }
      if (interactive) {
        connecting ??= connect().finally(() => {
          connecting = undefined;
        });
        return connecting;
      }
      const st = await store.read(d.kv);
      if (!st) throw NOT_CONNECTED();
      if (tokenUsable(st, d.now())) return st.accessToken!;
      if (!st.refreshToken) throw expiredError(authProblem(st));
      if (st.renewFailedAt && d.now() - st.renewFailedAt < GOOGLE_OAUTH.renewRetryAfterMs) throw expiredError(st.renewReason, st.renewFix);
      renewing ??= renew().finally(() => {
        renewing = undefined;
      });
      return renewing;
    },
    async invalidate(token) {
      await store.update(d.kv, d.locker, (s) => {
        if (!s || s.accessToken !== token) return s;
        const { accessToken: _a, expiresAt: _e, ...rest } = s;
        return rest;
      });
    },
    async status() {
      if (!configured()) return 'not_configured';
      const st = await store.read(d.kv);
      if (!st) return 'disconnected';
      if (tokenUsable(st, d.now())) return 'connected';
      // 访问令牌过期但有刷新令牌：下次调用 API 时在后台续期，仍算已连接；续期被拒过、或没有刷新令牌，才需要你出手
      if (!st.refreshToken || st.renewFailedAt) return 'expired';
      return 'connected';
    },
    async disconnect() {
      const st = await store.read(d.kv);
      let revoked = false;
      // 吊销刷新令牌会连带它换出的访问令牌；旧版记录只能吊销仍有效的访问令牌
      const token = st?.refreshToken ?? (st && tokenUsable(st, d.now()) ? st.accessToken : undefined);
      if (token) {
        // 吊销：只发往 Google 官方 OAuth 端点，令牌放在请求体里
        const res = await d
          .http(d.revokeUrl, { method: 'POST', headers: FORM, body: new URLSearchParams({ token }).toString() })
          .catch(() => undefined);
        revoked = !!res?.ok;
      }
      await d.kv.remove(store.key);
      await d.kv.remove(stores.authAttempt.key);
      return { revoked };
    },
  };
}

/** 你在设置页改了 Client Secret：清掉"Client Secret 不对 / 没填"的续期失败标记，下次用时立刻重试 */
export async function clearSecretFailure(kv: KV, locker: Locker): Promise<void> {
  await stores.youtubeAuth.update(kv, locker, (s) => {
    if (!s || s.renewFix !== 'secret') return s;
    const { renewFailedAt: _a, renewReason: _b, renewFix: _c, ...rest } = s;
    return rest;
  });
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function chromeAuth(kv: KV, locker: Locker): AuthProvider {
  return webAuthFlowAuth({
    kv,
    locker,
    clientId: oauthClientId(),
    clientSecret: async () => (await stores.secrets.read(kv)).googleClientSecret,
    authorizeUrl: GOOGLE_OAUTH_AUTHORIZE_URL,
    tokenUrl: ENDPOINTS.googleOAuthToken,
    revokeUrl: ENDPOINTS.googleOAuthRevoke,
    redirectUrl: oauthRedirectUrl,
    launch: (url) => chrome.identity.launchWebAuthFlow({ url, interactive: true }),
    http: (input, init) => fetch(input, init),
    now: () => Date.now(),
    randomState: () => randomHex(16),
    randomVerifier: () => pkceVerifier(crypto.getRandomValues(new Uint8Array(32))),
  });
}
