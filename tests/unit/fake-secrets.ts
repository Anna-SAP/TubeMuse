// 测试用的假 Key / 令牌（DECISIONS §73）。
// 有的测试要验证"按格式认出 Key、令牌并遮掉"，假值就得长得像真的；可这样一整串字符原样写进源码，
// GitHub 的密钥扫描分不出真假，会当成真 Key 报"已公开泄露"——2026-11-13 的告警 #1 就是 xyz.test.ts 里的一个假 OpenAI Key。
// 所以前缀（sk-proj-、sk-ant-、ya29.、AIza……）和后面的部分分开写，运行时再拼起来：
// 源码里没有一整串像 Key 的字符，测试拿到的值和以前一模一样。
// tests/unit/secret-hygiene.test.mjs 守着：仓库里再出现像真 Key 的字面量，单测就失败。

/** 把前缀和后面的部分拼成一个假凭据。后面的部分写明 test / fake，一眼看得出不是真的 */
export function fakeSecret(prefix: string, rest: string): string {
  return prefix + rest;
}
