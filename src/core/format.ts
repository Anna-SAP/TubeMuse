// 展示用的数字格式化。

function trim(n: number): string {
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

/** 播放量级：8,523 / 12 万 / 3.4 亿 */
export function formatCount(n: number | undefined): string {
  if (n === undefined) return '未知';
  if (n < 10_000) return n.toLocaleString('en-US');
  if (n < 100_000_000) return `${trim(n / 10_000)} 万`;
  return `${trim(n / 100_000_000)} 亿`;
}

export function formatViews(n: number | undefined): string {
  return n === undefined ? '播放量未公开' : `${formatCount(n)} 次播放`;
}

export function formatPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatSigned(n: number, digits = 2): string {
  const s = n.toFixed(digits);
  return n > 0 ? `+${s}` : s;
}

/** 时长：不到 1 小时用分钟，否则用小时（保留 1 位） */
export function formatSpan(sec: number): string {
  const min = Math.round(sec / 60);
  return min < 60 ? `${min} 分钟` : `${(sec / 3600).toFixed(1)} 小时`;
}
