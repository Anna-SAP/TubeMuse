// YouTube 授权：chrome.identity.launchWebAuthFlow + Google"Web 应用"类型客户端的隐式授权（只申请 youtube.readonly）。
// 不依赖浏览器级 Google 登录，Comet 等非 Chrome 的 Chromium 浏览器同样可用：授权窗口里登录哪个 Google 账号就用哪个。
// 访问令牌约 1 小时有效、没有刷新令牌：过期后先静默续期（prompt=none），不成功就明确请用户重新授权。
// 交互授权（连接 / 重新授权）由后台发起，见 auth-service.ts。

import { GOOGLE_OAUTH, GOOGLE_OAUTH_SCOPE } from '../config/defaults';
import { ENDPOINTS, GOOGLE_OAUTH_AUTHORIZE_URL } from '../config/endpoints';
import { SILENT_NEEDS_USER, buildAuthUrl, parseAuthRedirect, tokenUsable } from '../core/oauth';
import { AppError } from './errors';
import { stores } from './repo';
import type { KV, Locker } from './storage';

/** expired：连接过，但令牌过期且静默续期失败，需要用户重新授权 */
export type AuthStatus = 'connected' | 'expired' | 'disconnected' | 'not_configured';

export interface AuthProvider {
  /** interactive=true 时弹出 Google 登录 / 授权窗口 */
  getToken(interactive: boolean): Promise<string>;
  /** 令牌被 API 拒绝（401）后调用，让下次重新获取 */
  invalidate(token: string): Promise<void>;
  status(): Promise<AuthStatus>;
  /** 断开：删除本地令牌；令牌仍有效时同时向 Google 吊销。返回是否吊销成功 */
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

/** 静默续期失败；reason 是具体原因（Google 的错误码或浏览器的报错），一并显示，不笼统地说"没有成功" */
function expiredError(reason?: string): AppError & { reason?: string } {
  const e = new AppError(
    'auth',
    `YouTube 授权已过期，自动续期没有成功${reason ? `（${reason}）` : ''}`,
    '点"重新授权"（设置页「2. YouTube 账号」或侧边栏顶部）。Google 的访问令牌约 1 小时有效；自动续期要求这个浏览器里的网页版 Google 账号保持登录',
  );
  return reason ? Object.assign(e, { reason }) : e;
}

/** prompt=none 时 Google 回跳里的错误 → 简短原因 */
export function silentReason(code: string): string {
  if (code === 'login_required') return 'Google 要求重新登录（login_required）';
  if (SILENT_NEEDS_USER.has(code)) return `Google 要求你在授权窗口里确认或选择账号（${code}）`;
  if (code === 'state_mismatch') return '回跳校验失败（state 不匹配）';
  return `Google 返回 ${code.slice(0, 60)}`;
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
      return new AppError('auth', `Google 授权没有返回访问令牌（${error.slice(0, 60)}）`, '重新点"连接 YouTube"；反复出现请核对 Google Cloud 里的客户端类型是否为"Web 应用"');
  }
}

export interface WebAuthDeps {
  kv: KV;
  locker: Locker;
  clientId: string | undefined;
  authorizeUrl: string;
  revokeUrl: string;
  redirectUrl: () => string;
  /** 打开授权窗口，返回最终回跳地址 */
  launch: (url: string, interactive: boolean) => Promise<string | undefined>;
  http: typeof fetch;
  now: () => number;
  randomState: () => string;
}

export function webAuthFlowAuth(d: WebAuthDeps): AuthProvider {
  const store = stores.youtubeAuth;
  const configured = () => !!d.clientId;
  /** 同一页面里多个请求同时发现令牌过期时，只续期一次 */
  let renewing: Promise<string> | undefined;
  /** 交互授权同一时间只开一个窗口：重复点击等同一个结果 */
  let connecting: Promise<string> | undefined;

  async function runFlow(interactive: boolean): Promise<string> {
    const state = d.randomState();
    const url = buildAuthUrl({
      authorizeUrl: d.authorizeUrl,
      clientId: d.clientId!,
      redirectUri: d.redirectUrl(),
      scope: GOOGLE_OAUTH_SCOPE,
      state,
      prompt: interactive ? 'select_account' : 'none',
    });
    let redirect: string | undefined;
    try {
      redirect = await d.launch(url, interactive);
    } catch (e) {
      // 浏览器的报错只有固定文案（不含回跳地址），可以原样记下
      const msg = e instanceof Error ? e.message : String(e);
      if (!interactive) throw expiredError(`浏览器报告：${msg.slice(0, 120)}`);
      throw authError(msg);
    }
    if (!redirect) throw interactive ? authError('empty redirect') : expiredError('授权窗口没有返回结果');
    const r = parseAuthRedirect(redirect, state, GOOGLE_OAUTH_SCOPE, d.now());
    // 交互授权失败要说交互授权的原因：不能报成"自动续期没有成功"（和横幅一字不差，看起来像什么都没发生）
    if (!r.ok) throw interactive ? redirectError(r.error) : expiredError(silentReason(r.error));
    const now = d.now();
    await store.update(d.kv, d.locker, (prev) => ({
      accessToken: r.token.accessToken,
      expiresAt: r.token.expiresAt,
      scope: r.token.scope,
      connectedAt: prev?.connectedAt ?? now,
    }));
    return r.token.accessToken;
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
        connecting ??= runFlow(true).finally(() => {
          connecting = undefined;
        });
        return connecting;
      }
      const st = await store.read(d.kv);
      if (!st) throw NOT_CONNECTED();
      if (tokenUsable(st, d.now())) return st.accessToken!;
      if (st.renewFailedAt && d.now() - st.renewFailedAt < GOOGLE_OAUTH.silentRetryAfterMs) throw expiredError(st.renewReason);
      renewing ??= runFlow(false)
        .catch(async (e: unknown) => {
          const reason = (e as { reason?: unknown }).reason;
          const err = typeof reason === 'string' ? e : expiredError(`意外错误：${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
          // 只有仍是"已连接"状态才记失败（用户可能刚好断开了）；同时有交互授权刚写入的新令牌时不记（那不算过期）
          await store.update(d.kv, d.locker, (s) =>
            s && !tokenUsable(s, d.now()) ? { ...s, renewFailedAt: d.now(), renewReason: (err as { reason: string }).reason } : s,
          );
          throw err;
        })
        .finally(() => {
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
      // 令牌过期但还没试过静默续期：下次调用 API 时自动续期，仍算已连接；续期失败过才需要用户出手
      return st.renewFailedAt ? 'expired' : 'connected';
    },
    async disconnect() {
      const st = await store.read(d.kv);
      let revoked = false;
      if (st && tokenUsable(st, d.now())) {
        // 吊销：只发往 Google 官方 OAuth 端点，令牌放在请求体里
        const res = await d
          .http(d.revokeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: st.accessToken! }).toString(),
          })
          .catch(() => undefined);
        revoked = !!res?.ok;
      }
      await d.kv.remove(store.key);
      await d.kv.remove(stores.authAttempt.key);
      return { revoked };
    },
  };
}

export function chromeAuth(kv: KV, locker: Locker): AuthProvider {
  return webAuthFlowAuth({
    kv,
    locker,
    clientId: oauthClientId(),
    authorizeUrl: GOOGLE_OAUTH_AUTHORIZE_URL,
    revokeUrl: ENDPOINTS.googleOAuthRevoke,
    redirectUrl: oauthRedirectUrl,
    launch: (url, interactive) =>
      chrome.identity.launchWebAuthFlow(
        // 静默续期给页面一点时间完成跳转（Google 有时用脚本跳转），超时即视为需要用户操作
        interactive ? { url, interactive } : { url, interactive, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: GOOGLE_OAUTH.silentTimeoutMs },
      ),
    http: (input, init) => fetch(input, init),
    now: () => Date.now(),
    randomState: () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''),
  });
}
