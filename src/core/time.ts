// 时间工具：太平洋时间日界（配额重置）、ISO 8601 时长、相对时间。

const HOUR = 3_600_000;
export const DAY_MS = 24 * HOUR;

function partsIn(timeZone: string, at: number): { y: number; m: number; d: number; h: number; min: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(at))) p[part.type] = part.value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute) };
}

/** 某时刻在指定时区的日期键 YYYY-MM-DD。 */
export function dayKey(at: number, timeZone: string): string {
  const { y, m, d } = partsIn(timeZone, at);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 下一个指定时区零点对应的 UTC 毫秒（自动处理夏令时）。 */
export function nextMidnight(at: number, timeZone: string): number {
  const { y, m, d } = partsIn(timeZone, at);
  // 目标是"明天 00:00"，候选 UTC 偏移覆盖 -12..+14 小时
  const base = Date.UTC(y, m - 1, d + 1);
  for (let offset = -14; offset <= 12; offset++) {
    const candidate = base + offset * HOUR;
    const p = partsIn(timeZone, candidate);
    if (p.h === 0 && p.min === 0 && dayKey(candidate, timeZone) !== dayKey(at, timeZone) && candidate > at) {
      return candidate;
    }
  }
  return base + 8 * HOUR;
}

/** 解析 YouTube 的 ISO 8601 时长（如 PT1H2M3S、P1DT2H、P0D）为秒。无法解析返回 0。 */
export function parseIsoDuration(iso: string | undefined): number {
  if (!iso) return 0;
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso);
  if (!m) return 0;
  const [, w, d, h, min, s] = m;
  return (
    Number(w ?? 0) * 604800 + Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Math.round(Number(s ?? 0))
  );
}

/** RFC 3339（去掉毫秒），用于 publishedAfter 等 API 参数 */
export function toRfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function formatDuration(sec: number): string {
  if (sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function formatRelative(fromMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - fromMs);
  const min = diff / 60_000;
  if (min < 1) return '刚刚';
  if (min < 60) return `${Math.floor(min)} 分钟前`;
  const h = min / 60;
  if (h < 24) return `${Math.floor(h)} 小时前`;
  const d = h / 24;
  if (d < 7) return `${Math.floor(d)} 天前`;
  if (d < 30) return `${Math.floor(d / 7)} 周前`;
  if (d < 365) return `${Math.floor(d / 30)} 个月前`;
  return `${Math.floor(d / 365)} 年前`;
}

export function formatHoursWindow(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    if (days === 7) return '一周内';
    if (days % 30 === 0) return `${days / 30} 个月内`;
    return `${days} 天内`;
  }
  return `${hours} 小时内`;
}

export function formatClock(at: number): string {
  const dt = new Date(at);
  return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}
