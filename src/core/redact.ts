// 任何要展示给用户或写进日志的文本都先经过这里：去掉密钥、令牌。

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ya29\.[A-Za-z0-9._-]{10,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /AAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%_-]{20,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi,
  /(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
  /([?&](?:key|access_token|token)=)[^&\s]+/gi,
];

export const REDACTED = '[已隐藏]';

export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const re of PATTERNS) {
    out = out.replace(re, (match, prefix: unknown) => (typeof prefix === 'string' && match.startsWith(prefix) ? prefix + REDACTED : REDACTED));
  }
  return out;
}
