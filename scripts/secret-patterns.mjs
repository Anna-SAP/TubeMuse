// @ts-check
// 像真 Key / 令牌 / 私钥的字符串长什么样（DECISIONS §73）。两处用到：
// - scripts/build.mjs：安装包里出现就构建失败（Key 只能由你在设置页填、只存本机）；
// - tests/unit/secret-hygiene.test.mjs：仓库里任何一个文件出现就单测失败。GitHub 的密钥扫描只看文字、
//   分不出真假：测试里写一个像真 Key 的假值，也会被当成"已公开泄露"报警（2026-11-13 的告警 #1 就是这样来的）。
// 测试要用像 Key 的假值时，用 tests/unit/fake-secrets.ts 把前缀和后面的部分分开写、运行时再拼起来。

/** @typedef {{ re: RegExp, what: string }} SecretPattern */

/** @type {readonly SecretPattern[]} */
export const SECRET_PATTERNS = [
  { re: /sk-ant-[A-Za-z0-9_-]{16,}/, what: 'Anthropic API Key' },
  // 项目 / 服务账号 / 管理员 Key：真 Key 里有 - 和 _，所以不能只认连续的字母数字
  { re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/, what: 'OpenAI API Key' },
  { re: /\bsk-[A-Za-z0-9]{32,}/, what: 'OpenAI API Key' },
  { re: /AIza[0-9A-Za-z_-]{35}/, what: 'Google API Key' },
  { re: /ya29\.[0-9A-Za-z_-]{20,}/, what: 'Google 访问令牌' },
  { re: /GOCSPX-[0-9A-Za-z_-]{20,}/, what: 'Google OAuth Client Secret' },
  { re: /\b1\/\/0[0-9A-Za-z_-]{30,}/, what: 'Google 刷新令牌' },
  { re: /AAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]{30,}/, what: 'X Bearer Token' },
  // 发布工作流用到 GitHub 的令牌（DECISIONS §70）
  { re: /\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/, what: 'GitHub 令牌' },
];

/**
 * 一段真的私钥：有开头那一行，后面紧跟着正文。只有开头那一行不算——报错提示里要告诉你"以 -----BEGIN PRIVATE KEY----- 开头"。
 * 安装包查得更严：连开头那一行都不许有（scripts/build.mjs）。
 * @type {SecretPattern}
 */
export const PRIVATE_KEY_BLOCK = { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40}/, what: '私钥' };

/** @typedef {{ what: string, line: number, preview: string }} SecretFinding */

/**
 * 在一段文字里找像真凭据的东西。报出来的只有开头几个字符：万一真是 Key，也不把它整串抄进测试输出、CI 日志。
 * @param {string} text
 * @returns {SecretFinding[]}
 */
export function findSecrets(text) {
  /** @type {SecretFinding[]} */
  const found = [];
  for (const { re, what } of [...SECRET_PATTERNS, PRIVATE_KEY_BLOCK]) {
    for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
      const at = m.index ?? 0;
      found.push({ what, line: text.slice(0, at).split('\n').length, preview: `${m[0].slice(0, 10)}…` });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}
