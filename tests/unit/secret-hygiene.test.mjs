// 仓库里不得出现像真 Key / 令牌 / 私钥的字符串（DECISIONS §73）。
// GitHub 的密钥扫描只看文字、分不出真假：2026-11-13 的告警 #1 是 xyz.test.ts 里的一个假 OpenAI Key，被当成"已公开泄露"。
// 这里在提交之前（npm test，也就是 npm run verify 与 CI）就把这类字面量拦下来：
// 真 Key 只能在设置页里填、只存本机；测试要用像 Key 的假值，用 tests/unit/fake-secrets.ts 在运行时拼出来。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findSecrets, PRIVATE_KEY_BLOCK, SECRET_PATTERNS } from '../../scripts/secret-patterns.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** 拼一个像真凭据的样本：源码里同样不出现整串 */
const sample = (/** @type {string} */ prefix, /** @type {string} */ rest) => prefix + rest;

/** 仓库里的文件：已提交的，加上还没提交、也没被 .gitignore 忽略的（local/ 里放的是你本机真的私钥和配置，不查也不该查） */
function repoFiles() {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`要用 git 列出仓库里的文件才能检查有没有像 Key 的字符串，但 git 没跑起来：${e instanceof Error ? e.message : String(e)}`);
  }
  return out.toString('utf8').split('\0').filter(Boolean);
}

describe('仓库里没有像真 Key / 令牌 / 私钥的字符串', () => {
  it('每个文件都查过，一处都没有', () => {
    const files = repoFiles();
    // 列不出文件时别"什么都没查到就算过"
    expect(files).toContain('tests/unit/xyz.test.ts');
    const found = [];
    for (const file of files) {
      const path = join(root, file);
      if (!existsSync(path)) continue; // 本地删掉、还没提交
      const buf = readFileSync(path);
      if (buf.includes(0)) continue; // 图片等二进制文件
      // package-lock.json 里的 sha512-… 是公开的包摘要，不是凭据；去掉，免得碰巧凑成某种 Key 的样子
      const text = buf.toString('utf8').replace(/\bsha(?:1|256|384|512)-[A-Za-z0-9+/=]+/g, '');
      for (const f of findSecrets(text)) found.push(`${file}:${f.line} 疑似${f.what}（${f.preview}）`);
    }
    expect(found, '真 Key 请撤销后从文件里删掉；测试用的假值改用 tests/unit/fake-secrets.ts 的 fakeSecret() 在运行时拼出来').toEqual([]);
  });
});

describe('认得出像真凭据的字符串', () => {
  it('2026-11-13 告警 #1 的那个假 OpenAI Key（sk-proj-…）认得出来', () => {
    expect(findSecrets(`const OPENAI_KEY = '${sample('sk-proj-', 'xyzTestKey0123456789abcdefghijklmnopqrst')}';`)).toEqual([
      { what: 'OpenAI API Key', line: 1, preview: 'sk-proj-xy…' },
    ]);
  });

  it('各家的格式都认得，报出行号，只露开头几个字符', () => {
    const cases = [
      [sample('sk-proj-', 'Ab_Cd-Ef0123456789GhIjKlMnOpQrStUv'), 'OpenAI API Key'],
      [sample('sk-svcacct-', 'Ab_Cd-Ef0123456789GhIjKlMnOpQrStUv'), 'OpenAI API Key'],
      [sample('sk-', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), 'OpenAI API Key'],
      [sample('sk-ant-', 'api03-AbCdEfGhIjKlMnOpQrStUv'), 'Anthropic API Key'],
      [sample('AIza', 'SyA1234567890abcdefghijklmnopqrstuvw'), 'Google API Key'],
      [sample('ya29.', 'a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxx'), 'Google 访问令牌'],
      [sample('GOCSPX-', 'abcdefghijklmnopqrstuvwx'), 'Google OAuth Client Secret'],
      [sample('1//', '0abcdefghijklmnopqrstuvwxyz0123456789'), 'Google 刷新令牌'],
      [sample('AAAAAAAAAAAAAAAAAAAA', 'AFakeXBearerTokenForTests0123456789'), 'X Bearer Token'],
      [sample('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'), 'GitHub 令牌'],
      [`${sample('-----BEGIN ', 'PRIVATE KEY-----')}\n${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(3)}\n`, '私钥'],
    ];
    for (const [secret, what] of cases) {
      const found = findSecrets(`第一行\n  x = "${secret}";\n`);
      expect(found.map((f) => f.what), secret).toEqual([what]);
      expect(found[0]?.line).toBe(2);
      expect(found[0]?.preview).toBe(`${secret.slice(0, 10)}…`);
    }
  });

  it('普通代码和文字不误报：正则本身、带连字符的词、私钥的格式说明、测试里拼出来的假值', () => {
    const plain = [
      ...SECRET_PATTERNS.map((p) => String(p.re)),
      String(PRIVATE_KEY_BLOCK.re),
      'the task-management-framework-for-large-teams-2026 talk',
      'risk-assessment-and-mitigation-strategies',
      '用 sk-learn 做聚类',
      "要粘贴 local/extension-key.pem 的全文，以 -----BEGIN PRIVATE KEY----- 开头、-----END PRIVATE KEY----- 结尾。",
      "const OPENAI_KEY = fakeSecret('sk-proj-', 'xyzTestKey0123456789abcdefghijklmnopqrst');",
      "const XTOKEN = fakeSecret('AAAAAAAAAAAAAAAAAAAA', 'AFakeXBearerTokenForTests0123456789');",
    ];
    for (const text of plain) expect(findSecrets(text), text).toEqual([]);
  });
});
