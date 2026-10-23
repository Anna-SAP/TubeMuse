// chrome.identity 报错 → 人话提示（报错原文取自 Chromium identity API）。

import { describe, expect, it } from 'vitest';
import { authError } from '../../src/services/auth';

describe('YouTube 授权报错', () => {
  it('关掉了"允许登录 Chrome" → 指向具体开关，而不是原样显示英文', () => {
    const e = authError('The user turned off browser signin', true);
    expect(e.kind).toBe('auth');
    expect(e.message).toContain('允许登录 Chrome');
    expect(e.message).not.toMatch(/turned off/i);
    expect(e.hint).toContain('chrome://settings/syncSetup');
    expect(e.hint).toContain('不必开启同步');
  });

  it('其他已知报错保持原有映射', () => {
    expect(authError('The user is not signed in.', true).message).toContain('没有登录 Google 账号');
    const notApproved = authError('The user did not approve access.', true);
    expect(notApproved.message).toContain('授权没有完成');
    // Google 拦下未加入测试用户的账号时，用户只能关掉页面，扩展收到的也是"未批准"
    expect(notApproved.hint).toContain('测试用户');
    expect(notApproved.hint).toContain('access_denied');
    expect(authError('OAuth2 request failed: Service responded with error: bad client id', true).kind).toBe('oauth_config');
    expect(authError('OAuth2 not granted or revoked.', false).message).toContain('尚未连接');
    expect(authError('Something unexpected', true).message).toBe('YouTube 授权失败：Something unexpected');
  });
});
