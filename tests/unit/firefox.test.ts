// Firefox 版（DECISIONS §69）里不依赖浏览器的那部分逻辑。浏览器里的行为由 tests/e2e/firefox/ 在真的 Firefox 里验证。
import { describe, expect, it } from 'vitest';
import { BROWSER, IS_FIREFOX, SPEECH_PLATFORM } from '../../src/platform';
import { requestedOrigins } from '../../src/ui/shared/host-access';

describe('平台常量', () => {
  it('没有注入 __BROWSER__（单元测试、Chrome 版）时按 Chrome：有云端识别', () => {
    expect(BROWSER).toBe('chrome');
    expect(IS_FIREFOX).toBe(false);
    expect(SPEECH_PLATFORM.hasCloud).toBe(true);
  });
});

describe('网站权限检查要查哪些网站', () => {
  it('API 的 host_permissions 加上各内容脚本的 matches，去重', () => {
    expect(
      requestedOrigins({
        host_permissions: ['https://www.googleapis.com/*', 'https://api.openai.com/*'],
        content_scripts: [{ matches: ['https://www.youtube.com/*'] }, { matches: ['https://www.youtube.com/*', 'https://x.com/*'] }, {}],
      }),
    ).toEqual(['https://www.googleapis.com/*', 'https://api.openai.com/*', 'https://www.youtube.com/*', 'https://x.com/*']);
    expect(requestedOrigins({})).toEqual([]);
  });
});
