// YouTube 授权：launchWebAuthFlow + Google 授权码 + PKCE + 刷新令牌。浏览器 API 与 Google 令牌端点全部用假实现注入，不出网。

import { describe, expect, it } from 'vitest';
import { GOOGLE_OAUTH, GOOGLE_OAUTH_SCOPE } from '../../src/config/defaults';
import { buildAuthUrl, classifyTokenError, parseCodeRedirect, parseTokenResponse, pkceChallenge, pkceVerifier, tokenErrorCode, tokenUsable } from '../../src/core/oauth';
import { redact } from '../../src/core/redact';
import { LEGACY_REASON, authError, authProblem, clearSecretFailure, renewReason, webAuthFlowAuth } from '../../src/services/auth';
import { attemptView, connectYouTube, fromAuthReply, toAuthReply } from '../../src/services/auth-service';
import { ENDPOINTS } from '../../src/config/endpoints';
import type { AppContext } from '../../src/services/context';
import { AppError } from '../../src/services/errors';
import { EXPORT_EXCLUDED_KEYS, stores, type YouTubeAuthState } from '../../src/services/repo';
import { memoryKV, memoryLocker, type KV, type Locker } from '../../src/services/storage';

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
const CLIENT = '1234-abc.apps.googleusercontent.com';
const SECRET = 'fake-client-secret-for-tests';
const T0 = Date.parse('2026-10-24T10:00:00Z');
const HOUR = 3_600_000;

type Launch = (url: URL) => string | Error;
type Form = Record<string, string>;
/** 令牌端点的应答：返回 undefined 时走默认的"像 Google 一样"的行为；返回 Error 模拟网络失败 */
type TokenFault = (form: Form) => { status: number; body: unknown } | Error | undefined;

/** 同一份浏览器存储、同一个时钟、同一个（假的）Google */
interface Shared {
  kv: KV & { data: Map<string, unknown> };
  locker: Locker;
  clock: { now: number };
  google: { n: number; codes: Map<string, { challenge: string; redirect: string }>; liveRefresh: Set<string> };
}

/**
 * 一个"扩展上下文"里的授权模块。传入 shared 可以让多个实例共用同一份存储（模拟侧边栏 + 后台，或扩展重新加载后的新实例）。
 * 假的 Google：授权页把 state 原样带回并发授权码；令牌端点校验 Client Secret 与 PKCE，发访问令牌与刷新令牌。
 */
function setup(opts: { clientId?: string | null; secret?: string | null; launch?: Launch; shared?: Shared } = {}) {
  const shared: Shared = opts.shared ?? { kv: memoryKV(), locker: memoryLocker(), clock: { now: T0 }, google: { n: 0, codes: new Map(), liveRefresh: new Set() } };
  const { codes, liveRefresh } = shared.google;
  let secret: string | undefined = opts.secret === null ? undefined : (opts.secret ?? SECRET);
  const launches: URL[] = [];
  const requests: { url: string; form: Form }[] = [];
  /** 让某次授权窗口先停住（模拟用户还在窗口里登录），由测试决定何时放行 */
  let hold: (() => Promise<void>) | undefined;
  /** 让续期请求先停住 */
  let holdToken: (() => Promise<void>) | undefined;
  let launch: Launch =
    opts.launch ??
    ((url) => {
      const code = `4/code-${++shared.google.n}`;
      codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect: url.searchParams.get('redirect_uri')! });
      return `${REDIRECT}?${new URLSearchParams({ state: url.searchParams.get('state')!, code, scope: GOOGLE_OAUTH_SCOPE })}`;
    });
  let fault: TokenFault | undefined;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const auth = webAuthFlowAuth({
    kv: shared.kv,
    locker: shared.locker,
    clientId: opts.clientId === null ? undefined : (opts.clientId ?? CLIENT),
    clientSecret: async () => secret,
    authorizeUrl: AUTHORIZE,
    tokenUrl: TOKEN,
    revokeUrl: REVOKE,
    redirectUrl: () => REDIRECT,
    launch: async (url) => {
      const u = new URL(url);
      launches.push(u);
      await Promise.resolve();
      if (hold) await hold();
      const r = launch(u);
      if (r instanceof Error) throw r;
      return r;
    },
    http: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
      requests.push({ url, form });
      if (url === REVOKE) return json(200, {});
      if (form.grant_type === 'refresh_token' && holdToken) await holdToken();
      const f = fault?.(form);
      if (f instanceof Error) throw f;
      if (f) return json(f.status, f.body);
      if (form.client_id !== CLIENT || form.client_secret !== SECRET) return json(401, { error: 'invalid_client', error_description: 'Unauthorized' });
      if (form.grant_type === 'authorization_code') {
        const c = codes.get(form.code ?? '');
        codes.delete(form.code ?? '');
        if (!c || c.redirect !== form.redirect_uri || (await pkceChallenge(form.code_verifier ?? '')) !== c.challenge) return json(400, { error: 'invalid_grant' });
        const refresh = `1//0refresh-${++shared.google.n}-abcdefghijklmnopqrstuvwxyz`;
        liveRefresh.add(refresh);
        return json(200, { access_token: `ya29.token-${++shared.google.n}-abcdefghijklmnop`, expires_in: 3599, refresh_token: refresh, scope: GOOGLE_OAUTH_SCOPE, token_type: 'Bearer' });
      }
      if (form.grant_type === 'refresh_token') {
        if (!liveRefresh.has(form.refresh_token ?? '')) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        return json(200, { access_token: `ya29.token-${++shared.google.n}-abcdefghijklmnop`, expires_in: 3599, scope: GOOGLE_OAUTH_SCOPE, token_type: 'Bearer' });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }) as typeof fetch,
    now: () => shared.clock.now,
    randomState: () => `state${launches.length}`,
    randomVerifier: () => pkceVerifier(new Uint8Array(32).fill(launches.length + 1)),
  });
  return {
    auth,
    shared,
    kv: shared.kv,
    launches,
    requests,
    refreshes: () => requests.filter((r) => r.form.grant_type === 'refresh_token'),
    now: () => shared.clock.now,
    advance: (ms: number) => (shared.clock.now += ms),
    setLaunch: (l: Launch) => (launch = l),
    setFault: (f: TokenFault | undefined) => (fault = f),
    setSecret: (s: string | undefined) => (secret = s),
    setHold: (h: typeof hold) => (hold = h),
    setHoldToken: (h: typeof holdToken) => (holdToken = h),
    revokeAllRefresh: () => liveRefresh.clear(),
  };
}

const fail = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as AppError);
const read = (kv: KV) => stores.youtubeAuth.read(kv);
/** 让排队中的异步步骤（含 PKCE 的 SHA-256）先跑完 */
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('授权码 + PKCE 的纯逻辑', () => {
  it('授权地址：只申请 youtube.readonly，response_type=code、access_type=offline、prompt=consent select_account、PKCE S256，不带 include_granted_scopes', () => {
    const u = new URL(buildAuthUrl({ authorizeUrl: AUTHORIZE, clientId: CLIENT, redirectUri: REDIRECT, scope: GOOGLE_OAUTH_SCOPE, state: 's1', codeChallenge: 'chal' }));
    expect(`${u.origin}${u.pathname}`).toBe(AUTHORIZE);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: GOOGLE_OAUTH_SCOPE,
      state: 's1',
      access_type: 'offline',
      prompt: 'consent select_account',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
    });
  });

  it('PKCE：与 RFC 7636 附录 B 的示例一致；verifier 至少 43 个字符', async () => {
    const bytes = new Uint8Array([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]);
    const v = pkceVerifier(bytes);
    expect(v).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(await pkceChallenge(v)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(pkceVerifier(new Uint8Array(32).fill(255))).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => pkceVerifier(new Uint8Array(16))).toThrow();
  });

  it('解析回跳：授权码在查询串；state 不符时连错误也不采信；拒绝、缺授权码、坏地址', () => {
    expect(parseCodeRedirect(`${REDIRECT}?state=s&code=4/abc&scope=x`, 's')).toEqual({ ok: true, code: '4/abc' });
    expect(parseCodeRedirect(`${REDIRECT}#state=s&code=4/abc`, 's')).toEqual({ ok: true, code: '4/abc' });
    expect(parseCodeRedirect(`${REDIRECT}?state=evil&code=4/abc`, 's')).toEqual({ ok: false, error: 'state_mismatch' });
    expect(parseCodeRedirect(`${REDIRECT}?error=access_denied&state=other`, 's')).toEqual({ ok: false, error: 'state_mismatch' });
    expect(parseCodeRedirect(`${REDIRECT}?error=access_denied&state=s`, 's')).toEqual({ ok: false, error: 'access_denied' });
    expect(parseCodeRedirect(`${REDIRECT}?state=s`, 's')).toEqual({ ok: false, error: 'missing_code' });
    expect(parseCodeRedirect('not a url', 's')).toEqual({ ok: false, error: 'invalid_redirect' });
  });

  it('解析令牌端点响应：访问令牌、有效期、刷新令牌及其期限；缺令牌、缺范围', () => {
    const ok = parseTokenResponse({ access_token: 'ya29.a', expires_in: 3599, refresh_token: '1//0r', refresh_token_expires_in: 604799, scope: GOOGLE_OAUTH_SCOPE }, GOOGLE_OAUTH_SCOPE, T0);
    expect(ok).toEqual({ ok: true, token: { accessToken: 'ya29.a', expiresAt: T0 + 3_599_000, scope: GOOGLE_OAUTH_SCOPE, refreshToken: '1//0r', refreshExpiresAt: T0 + 604_799_000 } });
    const plain = parseTokenResponse({ access_token: 'ya29.a' }, GOOGLE_OAUTH_SCOPE, T0);
    expect(plain).toEqual({ ok: true, token: { accessToken: 'ya29.a', expiresAt: T0 + GOOGLE_OAUTH.defaultExpiresInSec * 1000, scope: GOOGLE_OAUTH_SCOPE } });
    expect(parseTokenResponse({}, GOOGLE_OAUTH_SCOPE, T0)).toEqual({ ok: false, error: 'missing_token' });
    expect(parseTokenResponse(null, GOOGLE_OAUTH_SCOPE, T0)).toEqual({ ok: false, error: 'missing_token' });
    expect(parseTokenResponse({ access_token: 'ya29.a', scope: 'openid' }, GOOGLE_OAUTH_SCOPE, T0)).toEqual({ ok: false, error: 'scope_missing' });
  });

  it('续期失败归类：网络 / 5xx / 限流是暂时的；invalid_grant 要重新授权；客户端错误要改 Client Secret', () => {
    expect(tokenErrorCode(400, { error: 'invalid_grant' })).toBe('invalid_grant');
    expect(tokenErrorCode(502, '<html>')).toBe('http_502');
    expect(classifyTokenError(503, 'http_503')).toBe('transient');
    expect(classifyTokenError(429, 'rate_limit')).toBe('transient');
    expect(classifyTokenError(400, 'invalid_grant')).toBe('revoked');
    expect(classifyTokenError(401, 'invalid_client')).toBe('client');
    expect(classifyTokenError(400, 'unauthorized_client')).toBe('client');
    expect(classifyTokenError(400, 'invalid_request')).toBe('other');
    expect(renewReason('invalid_grant')).toContain(`${GOOGLE_OAUTH.testingRefreshTtlDays} 天`);
  });

  it('令牌留出安全余量后才算有效', () => {
    expect(tokenUsable({ accessToken: 'a', expiresAt: T0 + GOOGLE_OAUTH.expiryMarginMs + 1 }, T0)).toBe(true);
    expect(tokenUsable({ accessToken: 'a', expiresAt: T0 + GOOGLE_OAUTH.expiryMarginMs }, T0)).toBe(false);
    expect(tokenUsable({ expiresAt: T0 + HOUR }, T0)).toBe(false);
    expect(tokenUsable(null, T0)).toBe(false);
  });

  it('脱敏：Client Secret、刷新令牌、表单里的授权码与 verifier 都不会出现在报错里', () => {
    const text = `bad client GOCSPX-abcdefghijklmnop token 1//0abcdefghijklmnopqrstuv body code=4/xyz&client_secret=hunter2hunter2&refresh_token=1//0zzz&code_verifier=vvvv`;
    const out = redact(text);
    for (const s of ['GOCSPX-abcdefghijklmnop', '1//0abcdefghijklmnopqrstuv', '4/xyz', 'hunter2hunter2', '1//0zzz', 'vvvv']) expect(out).not.toContain(s);
  });
});

describe('连接 YouTube（交互授权）', () => {
  it('没配置 Client ID：明确报错，不弹窗', async () => {
    const { auth, launches } = setup({ clientId: null });
    expect(await auth.status()).toBe('not_configured');
    const e = await fail(auth.getToken(true));
    expect(e).toBeInstanceOf(AppError);
    expect(e?.kind).toBe('oauth_config');
    expect(e?.hint).toContain('Web 应用');
    expect(launches).toHaveLength(0);
  });

  it('没填 Client Secret：说清楚要填什么、为什么，不弹窗', async () => {
    const { auth, launches, requests } = setup({ secret: null });
    const e = await fail(auth.getToken(true));
    expect(e?.kind).toBe('oauth_config');
    expect(e?.message).toContain('Client Secret');
    expect(e?.hint).toContain('自动续期');
    expect(launches).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('从没连接过：后台取令牌直接说"尚未连接"，不弹窗、不发请求', async () => {
    const { auth, launches, requests } = setup();
    expect(await auth.status()).toBe('disconnected');
    expect((await fail(auth.getToken(false)))?.message).toContain('尚未连接');
    expect(launches).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('点"连接"：弹窗 → 授权码 → 带 Client Secret 与 PKCE verifier 换令牌 → 存下访问令牌与刷新令牌；有效期内直接复用', async () => {
    const { auth, kv, launches, requests } = setup();
    const token = await auth.getToken(true);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.searchParams.get('response_type')).toBe('code');
    expect(launches[0]!.searchParams.get('access_type')).toBe('offline');
    expect(launches[0]!.searchParams.has('client_secret')).toBe(false); // Secret 不进授权地址
    expect(requests).toHaveLength(1);
    const ex = requests[0]!;
    expect(ex.url).toBe(TOKEN);
    expect(ex.form).toMatchObject({ grant_type: 'authorization_code', code: '4/code-1', client_id: CLIENT, client_secret: SECRET, redirect_uri: REDIRECT });
    expect(await pkceChallenge(ex.form.code_verifier!)).toBe(launches[0]!.searchParams.get('code_challenge'));
    const st = await read(kv);
    expect(st).toMatchObject({ accessToken: token, expiresAt: T0 + 3_599_000, scope: GOOGLE_OAUTH_SCOPE, connectedAt: T0, refreshIssuedAt: T0 });
    expect(st?.refreshToken).toMatch(/^1\/\/0refresh-/);
    expect(await auth.status()).toBe('connected');
    expect(await auth.getToken(false)).toBe(token);
    expect(launches).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it('交互授权的各种失败都翻译成人话，且不保存任何令牌', async () => {
    const cases: [Launch | undefined, TokenFault | undefined, RegExp][] = [
      [() => new Error('The user did not approve access.'), undefined, /授权没有完成/],
      [(u) => `${REDIRECT}?error=access_denied&state=${u.searchParams.get('state')}`, undefined, /拒绝了访问/],
      [() => `${REDIRECT}?code=4/forged&state=forged`, undefined, /state 不匹配/],
      [(u) => `${REDIRECT}?state=${u.searchParams.get('state')}`, undefined, /没有返回授权码/],
      [(u) => `${REDIRECT}?error=interaction_required&state=${u.searchParams.get('state')}`, undefined, /interaction_required/],
      [() => new Error('Authorization page could not be loaded.'), undefined, /打不开 Google 授权页/],
      [undefined, () => ({ status: 401, body: { error: 'invalid_client' } }), /不认这个 Client Secret/],
      [undefined, () => ({ status: 400, body: { error: 'redirect_uri_mismatch' } }), /回跳地址/],
      [undefined, () => new TypeError('Failed to fetch'), /连不上 Google 换取令牌/],
      [undefined, () => ({ status: 200, body: { access_token: 'ya29.no-refresh-abcdefghij', expires_in: 3599, scope: GOOGLE_OAUTH_SCOPE } }), /没有发放刷新令牌/],
      [undefined, () => ({ status: 200, body: { access_token: 'ya29.x-abcdefghijklmnop', refresh_token: '1//0r', scope: 'openid' } }), /没有包含/],
    ];
    for (const [launch, fault, re] of cases) {
      const s = setup(launch ? { launch } : {});
      s.setFault(fault);
      const e = await fail(s.auth.getToken(true));
      expect(e?.message).toMatch(re);
      expect(e?.message).not.toContain('自动续期没有成功'); // 交互授权的失败不借用横幅的话
      expect(await read(s.kv)).toBeNull();
    }
  });

  it('"授权没有完成"的提示覆盖测试用户、回跳地址、客户端类型，且不再提 Chrome 专属设置', () => {
    const e = authError('The user did not approve access.');
    for (const s of ['测试用户', 'access_denied', 'redirect_uri_mismatch', '回跳地址', 'Web 应用']) expect(e.hint).toContain(s);
    expect(`${e.message}${e.hint}`).not.toMatch(/chrome:\/\/settings|允许登录 Chrome/);
  });

  it('换令牌失败的报错里不出现 Client Secret、授权码或 verifier', async () => {
    const s = setup();
    s.setFault((f) => ({ status: 400, body: { error: `weird ${f.client_secret} ${f.code}` } }));
    const e = await fail(s.auth.getToken(true));
    // 错误码截短、并在展示前统一脱敏
    expect(redact(`${e?.message}${e?.hint}`, [SECRET])).not.toContain(SECRET);
  });

  it('连点两次"连接"只开一个授权窗口，两次都拿到同一个结果', async () => {
    const { auth, launches, setHold } = setup();
    let release!: () => void;
    setHold(() => new Promise<void>((r) => (release = r)));
    const a = auth.getToken(true);
    const b = auth.getToken(true);
    await tick();
    release();
    expect(await a).toBe(await b);
    expect(launches).toHaveLength(1);
  });
});

describe('自动续期（刷新令牌，不弹窗）', () => {
  it('连续 30 小时、每小时用一次：每次都在后台用刷新令牌换新令牌，不弹窗，状态始终"已连接"', async () => {
    const s = setup();
    await s.auth.getToken(true);
    const seen = new Set<string>();
    for (let h = 1; h <= 30; h++) {
      s.advance(HOUR);
      expect(await s.auth.status()).toBe('connected');
      seen.add(await s.auth.getToken(false));
    }
    expect(seen.size).toBe(30);
    expect(s.launches).toHaveLength(1); // 只有最初那一次交互授权
    expect(s.refreshes()).toHaveLength(30);
    expect(s.refreshes().every((r) => r.url === TOKEN && r.form.client_secret === SECRET && r.form.client_id === CLIENT && r.form.refresh_token?.startsWith('1//0'))).toBe(true);
    expect((await read(s.kv))?.renewFailedAt).toBeUndefined();
  });

  it('几天没用（浏览器关着）：再用时一次续上', async () => {
    const s = setup();
    await s.auth.getToken(true);
    s.advance(3 * 24 * HOUR);
    expect(await s.auth.status()).toBe('connected');
    expect(await s.auth.getToken(false)).toMatch(/^ya29\./);
    expect(s.launches).toHaveLength(1);
  });

  it('扩展重新加载（内存清空、存储还在）：新实例照样是"已连接"，过期后自己用刷新令牌续期，不弹窗', async () => {
    const before = setup();
    const token = await before.auth.getToken(true);
    // 新的一份授权模块：只共用浏览器存储、时钟与 Google，就像重新加载后的 service worker / 侧边栏
    const after = setup({ shared: before.shared });
    expect(await after.auth.status()).toBe('connected');
    expect(await after.auth.getToken(false)).toBe(token);
    for (let h = 1; h <= 25; h++) {
      before.advance(HOUR);
      expect(await after.auth.status()).toBe('connected');
      expect(await after.auth.getToken(false)).toMatch(/^ya29\./);
    }
    expect(after.refreshes()).toHaveLength(25);
    expect(before.launches.length + after.launches.length).toBe(1);
  });

  it('同一页面里同时多个请求只续期一次；不同页面（侧边栏 + 后台）同时续期也只发一次', async () => {
    const a = setup();
    await a.auth.getToken(true);
    const b = setup({ shared: a.shared });
    a.advance(HOUR);
    const [x, y, z] = await Promise.all([a.auth.getToken(false), a.auth.getToken(false), b.auth.getToken(false)]);
    expect(x).toBe(y);
    expect(z).toBe(x);
    expect(a.refreshes().length + b.refreshes().length).toBe(1);
  });

  it('401 后作废访问令牌：下次自动用刷新令牌续期，不弹窗', async () => {
    const { auth, launches, refreshes } = setup();
    const t = await auth.getToken(true);
    await auth.invalidate(t);
    expect(await auth.status()).toBe('connected');
    expect(await auth.getToken(false)).not.toBe(t);
    expect(launches).toHaveLength(1);
    expect(refreshes()).toHaveLength(1);
  });

  it('Google 轮换了刷新令牌：换上新的', async () => {
    const s = setup();
    await s.auth.getToken(true);
    s.advance(HOUR);
    s.setFault((f) => (f.grant_type === 'refresh_token' ? { status: 200, body: { access_token: 'ya29.rotated-abcdefghijklmnop', expires_in: 3599, refresh_token: '1//0rotated-abcdefghijklmnopqrstu', scope: GOOGLE_OAUTH_SCOPE } } : undefined));
    expect(await s.auth.getToken(false)).toBe('ya29.rotated-abcdefghijklmnop');
    expect((await read(s.kv))?.refreshToken).toBe('1//0rotated-abcdefghijklmnopqrstu');
  });

  it('网络错误 / Google 5xx：说清楚是暂时的，不标"已过期"，下次再用时重试', async () => {
    const s = setup();
    await s.auth.getToken(true);
    s.advance(HOUR);
    s.setFault(() => new TypeError('Failed to fetch'));
    const e1 = await fail(s.auth.getToken(false));
    expect(e1?.kind).toBe('network');
    expect(e1?.hint).toContain('没有失效');
    s.setFault(() => ({ status: 503, body: {} }));
    expect((await fail(s.auth.getToken(false)))?.kind).toBe('network');
    expect(await s.auth.status()).toBe('connected');
    expect((await read(s.kv))?.renewFailedAt).toBeUndefined();
    s.setFault(undefined);
    expect(await s.auth.getToken(false)).toMatch(/^ya29\./);
    expect(s.launches).toHaveLength(1);
  });

  it('刷新令牌失效（invalid_grant）：状态变"已过期"，写明原因（含测试状态 7 天）；丢掉失效的刷新令牌，之后不再白发请求；重新授权后恢复', async () => {
    const s = setup();
    await s.auth.getToken(true);
    s.advance(HOUR);
    s.revokeAllRefresh();
    const e = await fail(s.auth.getToken(false));
    expect(e?.kind).toBe('auth');
    expect(e?.message).toContain('invalid_grant');
    expect(e?.hint).toContain('重新授权');
    expect(await s.auth.status()).toBe('expired');
    const st = await read(s.kv);
    expect(st?.refreshToken).toBeUndefined();
    expect(st?.renewReason).toContain('7 天');
    expect(authProblem(st)).toContain('invalid_grant');
    const sent = s.requests.length;
    s.advance(GOOGLE_OAUTH.renewRetryAfterMs * 4);
    expect((await fail(s.auth.getToken(false)))?.message).toContain('invalid_grant');
    expect(s.requests).toHaveLength(sent);

    expect(await s.auth.getToken(true)).toMatch(/^ya29\./);
    expect(await s.auth.status()).toBe('connected');
    const after = await read(s.kv);
    expect(after?.renewFailedAt).toBeUndefined();
    expect(after?.renewReason).toBeUndefined();
    expect(after?.refreshToken).toBeTruthy();
  });

  it('Client Secret 不对（invalid_client）：保留刷新令牌，提示改 Client Secret；改好后立即续上，不用重新授权', async () => {
    const s = setup();
    await s.auth.getToken(true);
    s.advance(HOUR);
    s.setSecret('fake-client-secret-wrong');
    const e = await fail(s.auth.getToken(false));
    expect(e?.message).toContain('invalid_client');
    expect(e?.hint).toContain('Client Secret');
    expect(e?.hint).toContain('不用重新授权');
    const st = await read(s.kv);
    expect(st?.refreshToken).toBeTruthy();
    expect(st?.renewFix).toBe('secret');
    expect(await s.auth.status()).toBe('expired');
    // 冷却期内不反复打扰 Google
    const sent = s.requests.length;
    await fail(s.auth.getToken(false));
    expect(s.requests).toHaveLength(sent);
    // 你在设置页存了正确的 Secret
    s.setSecret(SECRET);
    await clearSecretFailure(s.kv, s.shared.locker);
    expect(await s.auth.status()).toBe('connected');
    expect(await s.auth.getToken(false)).toMatch(/^ya29\./);
    expect(s.launches).toHaveLength(1);
  });

  it('Client Secret 被删了：续期前就说明，不发请求', async () => {
    const s = setup();
    await s.auth.getToken(true);
    s.advance(HOUR);
    s.setSecret(undefined);
    const sent = s.requests.length;
    const e = await fail(s.auth.getToken(false));
    expect(e?.message).toContain('Client Secret');
    expect(s.requests).toHaveLength(sent);
    expect((await read(s.kv))?.renewFix).toBe('secret');
  });

  it('其他拒绝（如 invalid_request）：记下原因、冷却期内不重试，过后再试', async () => {
    const s = setup();
    await s.auth.getToken(true);
    s.advance(HOUR);
    s.setFault(() => ({ status: 400, body: { error: 'invalid_request' } }));
    expect((await fail(s.auth.getToken(false)))?.message).toContain('invalid_request');
    expect(await s.auth.status()).toBe('expired');
    const n = s.refreshes().length;
    await fail(s.auth.getToken(false));
    expect(s.refreshes()).toHaveLength(n);
    s.setFault(undefined);
    s.advance(GOOGLE_OAUTH.renewRetryAfterMs);
    expect(await s.auth.getToken(false)).toMatch(/^ya29\./);
    expect(await s.auth.status()).toBe('connected');
  });

  it('续期还在等、你已经重新授权成功：之后旧刷新令牌的失败不会把新记录标成"已过期"', async () => {
    const s = setup();
    await s.auth.getToken(true);
    s.advance(HOUR);
    let release!: () => void;
    s.setHoldToken(() => new Promise<void>((r) => (release = r)));
    s.revokeAllRefresh();
    const renewing = fail(s.auth.getToken(false));
    await tick();
    s.setHoldToken(undefined);
    const fresh = await s.auth.getToken(true);
    release();
    expect((await renewing)?.message).toContain('invalid_grant');
    const st = await read(s.kv);
    expect(st?.accessToken).toBe(fresh);
    expect(st?.renewFailedAt).toBeUndefined();
    expect(st?.refreshToken).toBeTruthy();
    expect(await s.auth.status()).toBe('connected');
  });
});

describe('旧版（隐式授权）记录', () => {
  const legacy = (expiresAt: number): YouTubeAuthState => ({ accessToken: 'ya29.legacy-abcdefghijklmnop', expiresAt, scope: GOOGLE_OAUTH_SCOPE, connectedAt: T0 - 9 * 24 * HOUR });

  it('还没过期：照常可用；过期后直接说"旧版授权、重新授权一次"，不开窗口、不发请求', async () => {
    const s = setup();
    await stores.youtubeAuth.write(s.kv, legacy(T0 + HOUR));
    expect(await s.auth.status()).toBe('connected');
    expect(await s.auth.getToken(false)).toBe('ya29.legacy-abcdefghijklmnop');
    s.advance(HOUR);
    expect(await s.auth.status()).toBe('expired');
    const e = await fail(s.auth.getToken(false));
    expect(e?.message).toContain('旧版授权');
    expect(authProblem(await read(s.kv))).toBe(LEGACY_REASON);
    expect(s.launches).toHaveLength(0);
    expect(s.requests).toHaveLength(0);
    // 重新授权一次就换成有刷新令牌的新记录
    await s.auth.getToken(true);
    expect((await read(s.kv))?.refreshToken).toBeTruthy();
    expect((await read(s.kv))?.connectedAt).toBe(T0 - 9 * 24 * HOUR);
  });
});

describe('断开与导出', () => {
  it('断开：向 Google 吊销刷新令牌（令牌只在请求体里），然后删除本地记录', async () => {
    const { auth, kv, requests } = setup();
    await auth.getToken(true);
    const rt = (await read(kv))!.refreshToken!;
    expect(await auth.disconnect()).toEqual({ revoked: true });
    const revoke = requests.filter((r) => r.url === REVOKE);
    expect(revoke).toHaveLength(1);
    expect(revoke[0]!.url).not.toContain(rt);
    expect(revoke[0]!.form).toEqual({ token: rt });
    expect(await read(kv)).toBeNull();
    expect(await auth.status()).toBe('disconnected');
  });

  it('断开：访问令牌过期了也照样吊销刷新令牌', async () => {
    const { auth, requests, advance } = setup();
    await auth.getToken(true);
    advance(10 * HOUR);
    expect(await auth.disconnect()).toEqual({ revoked: true });
    expect(requests.filter((r) => r.url === REVOKE)).toHaveLength(1);
  });

  it('断开旧版记录：令牌已过期时不发请求，如实返回没有吊销', async () => {
    const { auth, kv, requests } = setup();
    await stores.youtubeAuth.write(kv, { accessToken: 'ya29.old-abcdefghijklmnop', expiresAt: T0 - 1, connectedAt: T0 - HOUR });
    expect(await auth.disconnect()).toEqual({ revoked: false });
    expect(requests).toHaveLength(0);
  });

  it('访问令牌、刷新令牌、Client Secret 与授权尝试记录都不进导出文件', () => {
    expect(EXPORT_EXCLUDED_KEYS.has(stores.youtubeAuth.key)).toBe(true);
    expect(EXPORT_EXCLUDED_KEYS.has(stores.authAttempt.key)).toBe(true);
    expect(EXPORT_EXCLUDED_KEYS.has(stores.secrets.key)).toBe(true);
  });
});

describe('后台执行的连接 / 重新授权', () => {
  function ctxFor(s: ReturnType<typeof setup>): AppContext {
    return { kv: s.kv, locker: memoryLocker(), http: fetch, now: s.now, auth: s.auth, endpoints: ENDPOINTS, timeZone: 'UTC' };
  }

  it('开始时记"进行中"，成功后清掉失败记录；失败时记下人话原因（发起的页面关了也看得到）', async () => {
    const s = setup();
    let release!: () => void;
    s.setHold(() => new Promise<void>((r) => (release = r)));
    const running = connectYouTube(ctxFor(s));
    await tick();
    expect(attemptView(await stores.authAttempt.read(s.kv), s.now())).toEqual({ state: 'pending', startedAt: T0 });
    release();
    await running;
    expect(attemptView(await stores.authAttempt.read(s.kv), s.now())).toEqual({ state: 'none' });
    expect(await s.auth.status()).toBe('connected');

    s.setHold(undefined);
    s.setLaunch(() => new Error('The user did not approve access.'));
    s.advance(60_000);
    const e = await fail(connectYouTube(ctxFor(s)));
    expect(e?.message).toContain('授权没有完成');
    const v = attemptView(await stores.authAttempt.read(s.kv), s.now());
    expect(v).toMatchObject({ state: 'failed', at: T0 + 60_000, message: '授权没有完成' });
    expect(v.state === 'failed' && v.hint).toContain('测试用户');
  });

  it('开始了却一直没结束（窗口没交回结果）：超过等待上限后说"没有交回结果"，而不是一直显示进行中', () => {
    expect(attemptView({ startedAt: T0 }, T0 + GOOGLE_OAUTH.interactiveMaxMs - 1).state).toBe('pending');
    expect(attemptView({ startedAt: T0 }, T0 + GOOGLE_OAUTH.interactiveMaxMs)).toEqual({ state: 'lost', startedAt: T0 });
    expect(attemptView(null, T0)).toEqual({ state: 'none' });
  });

  it('后台回给页面的结果：错误原样还原成人话错误；后台没响应也明确报错', () => {
    expect(() => fromAuthReply({ ok: true })).not.toThrow();
    const reply = toAuthReply(new AppError('auth', '授权没有完成', '看授权窗口里的提示'));
    expect(reply).toEqual({ ok: false, error: { kind: 'auth', message: '授权没有完成', hint: '看授权窗口里的提示' } });
    expect(() => fromAuthReply(reply)).toThrow('授权没有完成');
    expect(() => fromAuthReply(undefined)).toThrow('后台没有响应');
  });

  it('断开时一并删掉授权尝试记录', async () => {
    const s = setup();
    await connectYouTube(ctxFor(s));
    expect(await stores.authAttempt.read(s.kv)).not.toBeNull();
    await s.auth.disconnect();
    expect(await stores.authAttempt.read(s.kv)).toBeNull();
  });
});
