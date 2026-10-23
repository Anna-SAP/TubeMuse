// YouTube 授权：launchWebAuthFlow + Google 隐式授权。浏览器 API 全部用假实现注入，不出网。

import { describe, expect, it } from 'vitest';
import { GOOGLE_OAUTH, GOOGLE_OAUTH_SCOPE } from '../../src/config/defaults';
import { buildAuthUrl, parseAuthRedirect, tokenUsable } from '../../src/core/oauth';
import { authError, webAuthFlowAuth } from '../../src/services/auth';
import { AppError } from '../../src/services/errors';
import { EXPORT_EXCLUDED_KEYS, stores } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
const CLIENT = '1234-abc.apps.googleusercontent.com';
const T0 = Date.parse('2026-10-24T10:00:00Z');
const HOUR = 3_600_000;

type Reply = (url: URL, interactive: boolean) => string | Error;

function setup(opts: { clientId?: string | null; reply?: Reply } = {}) {
  const kv = memoryKV();
  let now = T0;
  let n = 0;
  const launches: { url: URL; interactive: boolean }[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  // 默认：像 Google 一样把 state 原样带回，每次发一个新令牌
  let reply: Reply =
    opts.reply ??
    ((url) => `${REDIRECT}#${new URLSearchParams({ access_token: `ya29.token-${++n}-abcdefghijklmnop`, token_type: 'Bearer', expires_in: '3599', scope: GOOGLE_OAUTH_SCOPE, state: url.searchParams.get('state')! })}`);
  const auth = webAuthFlowAuth({
    kv,
    locker: memoryLocker(),
    clientId: opts.clientId === null ? undefined : (opts.clientId ?? CLIENT),
    authorizeUrl: AUTHORIZE,
    revokeUrl: REVOKE,
    redirectUrl: () => REDIRECT,
    launch: async (url, interactive) => {
      const u = new URL(url);
      launches.push({ url: u, interactive });
      await Promise.resolve();
      const r = reply(u, interactive);
      if (r instanceof Error) throw r;
      return r;
    },
    http: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
    now: () => now,
    randomState: () => `state${launches.length}`,
  });
  return { auth, kv, launches, requests, advance: (ms: number) => (now += ms), setReply: (r: Reply) => (reply = r) };
}

const fail = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as AppError);

describe('隐式授权的纯逻辑', () => {
  it('授权地址：只申请 youtube.readonly，response_type=token，带 state，不带 include_granted_scopes', () => {
    const u = new URL(buildAuthUrl({ authorizeUrl: AUTHORIZE, clientId: CLIENT, redirectUri: REDIRECT, scope: GOOGLE_OAUTH_SCOPE, state: 's1', prompt: 'select_account' }));
    expect(`${u.origin}${u.pathname}`).toBe(AUTHORIZE);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      response_type: 'token',
      scope: GOOGLE_OAUTH_SCOPE,
      state: 's1',
      prompt: 'select_account',
    });
  });

  it('解析回跳：成功、默认有效期、state 不符、拒绝、缺令牌、缺范围', () => {
    const ok = parseAuthRedirect(`${REDIRECT}#access_token=ya29.x&expires_in=3599&scope=${encodeURIComponent(GOOGLE_OAUTH_SCOPE)}&state=s`, 's', GOOGLE_OAUTH_SCOPE, T0);
    expect(ok).toEqual({ ok: true, token: { accessToken: 'ya29.x', expiresAt: T0 + 3_599_000, scope: GOOGLE_OAUTH_SCOPE } });
    const noExp = parseAuthRedirect(`${REDIRECT}#access_token=ya29.x&state=s`, 's', GOOGLE_OAUTH_SCOPE, T0);
    expect(noExp.ok && noExp.token.expiresAt).toBe(T0 + GOOGLE_OAUTH.defaultExpiresInSec * 1000);
    // state 不符时，连错误信息也不采信
    expect(parseAuthRedirect(`${REDIRECT}#access_token=ya29.x&state=evil`, 's', GOOGLE_OAUTH_SCOPE, T0)).toEqual({ ok: false, error: 'state_mismatch' });
    expect(parseAuthRedirect(`${REDIRECT}#error=access_denied&state=other`, 's', GOOGLE_OAUTH_SCOPE, T0)).toEqual({ ok: false, error: 'state_mismatch' });
    expect(parseAuthRedirect(`${REDIRECT}#error=access_denied&state=s`, 's', GOOGLE_OAUTH_SCOPE, T0)).toEqual({ ok: false, error: 'access_denied' });
    expect(parseAuthRedirect(`${REDIRECT}?error=access_denied&state=s`, 's', GOOGLE_OAUTH_SCOPE, T0)).toEqual({ ok: false, error: 'access_denied' });
    expect(parseAuthRedirect(`${REDIRECT}#state=s`, 's', GOOGLE_OAUTH_SCOPE, T0)).toEqual({ ok: false, error: 'missing_token' });
    expect(parseAuthRedirect(`${REDIRECT}#access_token=ya29.x&scope=openid&state=s`, 's', GOOGLE_OAUTH_SCOPE, T0)).toEqual({ ok: false, error: 'scope_missing' });
    expect(parseAuthRedirect('not a url', 's', GOOGLE_OAUTH_SCOPE, T0)).toEqual({ ok: false, error: 'invalid_redirect' });
  });

  it('令牌留出安全余量后才算有效', () => {
    expect(tokenUsable({ accessToken: 'a', expiresAt: T0 + GOOGLE_OAUTH.expiryMarginMs + 1 }, T0)).toBe(true);
    expect(tokenUsable({ accessToken: 'a', expiresAt: T0 + GOOGLE_OAUTH.expiryMarginMs }, T0)).toBe(false);
    expect(tokenUsable({ expiresAt: T0 + HOUR }, T0)).toBe(false);
    expect(tokenUsable(null, T0)).toBe(false);
  });
});

describe('launchWebAuthFlow 授权', () => {
  it('没配置 Client ID：明确报错，不弹窗', async () => {
    const { auth, launches } = setup({ clientId: null });
    expect(await auth.status()).toBe('not_configured');
    const e = await fail(auth.getToken(true));
    expect(e).toBeInstanceOf(AppError);
    expect(e?.kind).toBe('oauth_config');
    expect(e?.hint).toContain('Web 应用');
    expect(launches).toHaveLength(0);
  });

  it('从没连接过：后台取令牌直接说"尚未连接"，不弹窗', async () => {
    const { auth, launches } = setup();
    expect(await auth.status()).toBe('disconnected');
    expect((await fail(auth.getToken(false)))?.message).toContain('尚未连接');
    expect(launches).toHaveLength(0);
  });

  it('点"连接"：弹窗选账号 → 存令牌与过期时间；有效期内直接复用，不再弹窗', async () => {
    const { auth, kv, launches } = setup();
    const token = await auth.getToken(true);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.interactive).toBe(true);
    expect(launches[0]!.url.searchParams.get('prompt')).toBe('select_account');
    const st = await stores.youtubeAuth.read(kv);
    expect(st).toMatchObject({ accessToken: token, expiresAt: T0 + 3_599_000, scope: GOOGLE_OAUTH_SCOPE, connectedAt: T0 });
    expect(await auth.status()).toBe('connected');
    expect(await auth.getToken(false)).toBe(token);
    expect(launches).toHaveLength(1);
  });

  it('过期后静默续期（prompt=none，不弹窗）；同时多个请求只续期一次', async () => {
    const { auth, launches, advance } = setup();
    const first = await auth.getToken(true);
    advance(HOUR);
    expect(await auth.status()).toBe('connected'); // 还没试过续期：仍算已连接
    const [a, b] = await Promise.all([auth.getToken(false), auth.getToken(false)]);
    expect(a).toBe(b);
    expect(a).not.toBe(first);
    expect(launches).toHaveLength(2);
    expect(launches[1]!.interactive).toBe(false);
    expect(launches[1]!.url.searchParams.get('prompt')).toBe('none');
  });

  it('静默续期失败：明确报"已过期"、状态变 expired；冷却期内不反复尝试，之后再试；重新授权后恢复', async () => {
    const { auth, kv, launches, advance, setReply } = setup();
    await auth.getToken(true);
    advance(HOUR);
    setReply((url, interactive) => (interactive ? `${REDIRECT}#access_token=ya29.again-abcdefghijklmnop&expires_in=3599&state=${url.searchParams.get('state')}` : `${REDIRECT}#error=interaction_required&state=${url.searchParams.get('state')}`));
    const e = await fail(auth.getToken(false));
    expect(e?.kind).toBe('auth');
    expect(e?.message).toContain('已过期');
    expect(e?.hint).toContain('重新授权');
    expect(await auth.status()).toBe('expired');
    expect((await stores.youtubeAuth.read(kv))?.renewFailedAt).toBe(T0 + HOUR);

    await fail(auth.getToken(false));
    expect(launches).toHaveLength(2); // 冷却期内没有再弹
    advance(GOOGLE_OAUTH.silentRetryAfterMs);
    await fail(auth.getToken(false));
    expect(launches).toHaveLength(3);

    expect(await auth.getToken(true)).toBe('ya29.again-abcdefghijklmnop');
    expect(await auth.status()).toBe('connected');
    expect((await stores.youtubeAuth.read(kv))?.renewFailedAt).toBeUndefined();
  });

  it('静默续期时窗口加载失败或超时：同样报"已过期"', async () => {
    const { auth, advance, setReply } = setup();
    await auth.getToken(true);
    advance(HOUR);
    setReply(() => new Error('User interaction required.'));
    expect((await fail(auth.getToken(false)))?.message).toContain('已过期');
  });

  it('交互授权的各种失败都翻译成人话，且不保存任何令牌', async () => {
    const cases: [Reply, RegExp][] = [
      [() => new Error('The user did not approve access.'), /授权没有完成/],
      [(u) => `${REDIRECT}#error=access_denied&state=${u.searchParams.get('state')}`, /拒绝了访问/],
      [() => `${REDIRECT}#access_token=ya29.forged-abcdefghijklmnop&state=forged`, /state 不匹配/],
      [(u) => `${REDIRECT}#access_token=ya29.x-abcdefghijklmnop&scope=openid&state=${u.searchParams.get('state')}`, /没有包含/],
      [() => new Error('Authorization page could not be loaded.'), /打不开 Google 授权页/],
    ];
    for (const [reply, re] of cases) {
      const { auth, kv } = setup({ reply });
      const e = await fail(auth.getToken(true));
      expect(e?.message).toMatch(re);
      expect(await stores.youtubeAuth.read(kv)).toBeNull();
    }
  });

  it('"授权没有完成"的提示覆盖测试用户、回跳地址、客户端类型，且不再提 Chrome 专属设置', () => {
    const e = authError('The user did not approve access.');
    for (const s of ['测试用户', 'access_denied', 'redirect_uri_mismatch', '回跳地址', 'Web 应用']) expect(e.hint).toContain(s);
    expect(`${e.message}${e.hint}`).not.toMatch(/chrome:\/\/settings|允许登录 Chrome/);
  });

  it('401 后作废令牌：下次自动静默续期', async () => {
    const { auth, launches } = setup();
    const t = await auth.getToken(true);
    await auth.invalidate(t);
    expect(await auth.status()).toBe('connected');
    expect(await auth.getToken(false)).not.toBe(t);
    expect(launches.at(-1)!.interactive).toBe(false);
  });

  it('断开：令牌有效时只向 Google 吊销端点发送（令牌在请求体里），然后删除本地记录', async () => {
    const { auth, kv, requests } = setup();
    const t = await auth.getToken(true);
    expect(await auth.disconnect()).toEqual({ revoked: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(REVOKE);
    expect(requests[0]!.url).not.toContain(t);
    expect(String(requests[0]!.init?.body)).toBe(`token=${t}`);
    expect(await stores.youtubeAuth.read(kv)).toBeNull();
    expect(await auth.status()).toBe('disconnected');
  });

  it('断开：令牌已过期时不发请求，如实返回没有吊销', async () => {
    const { auth, requests, advance } = setup();
    await auth.getToken(true);
    advance(HOUR);
    expect(await auth.disconnect()).toEqual({ revoked: false });
    expect(requests).toHaveLength(0);
  });

  it('访问令牌不进导出文件', () => {
    expect(EXPORT_EXCLUDED_KEYS.has(stores.youtubeAuth.key)).toBe(true);
  });
});
