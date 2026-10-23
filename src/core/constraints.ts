// LLM 原始输出 → 规范化约束。原则：任何约束都不丢——字段无效时降级为"其他要求"并注明原因。

import { formatHoursWindow } from './time';
import { formatCount } from './format';
import { uniqueStrings } from './text';
import {
  CHANNEL_MODES,
  CONSTRAINT_KINDS,
  EVENT_TYPES,
  FORMAT_KINDS,
  QUALITY_ASPECTS,
  SORT_BYS,
  type ChannelMode,
  type Constraint,
  type ConstraintKind,
  type ConstraintParams,
  type ConstraintSource,
  type EventType,
  type FormatKind,
  type QualityAspect,
  type QuerySpec,
  type SortBy,
} from './types';

/** LLM 输出的扁平约束（未使用字段用空值：""、0、[]、"none"）。 */
export interface RawConstraint {
  kind: string;
  span: string;
  label: string;
  importance: string;
  terms: string[];
  language: string;
  withinHours: number;
  minMinutes: number;
  maxMinutes: number;
  format: string;
  aspect: string;
  channelNames: string[];
  mode: string;
  minViews: number;
  count: number;
  sortBy: string;
  eventType: string;
  regionCode: string;
  description: string;
}

export interface RawIntent {
  interpretation: string;
  topic: string;
  queries: { q: string; language: string }[];
  constraints: RawConstraint[];
}

export const LANGUAGE_NAMES: Record<string, string> = {
  en: '英文',
  zh: '中文',
  ja: '日文',
  ko: '韩文',
  es: '西班牙文',
  fr: '法文',
  de: '德文',
  ru: '俄文',
  pt: '葡萄牙文',
  it: '意大利文',
  yue: '粤语',
};

export const FORMAT_LABELS: Record<FormatKind, string> = {
  interview: '访谈',
  tutorial: '教程',
  lecture: '讲座/演讲',
  explainer: '科普讲解',
  podcast: '播客',
  documentary: '纪录片',
  review: '评测',
  news: '新闻',
  other: '特定形式',
};

/** 形式的默认匹配词（LLM 未给出 terms 时使用） */
export const FORMAT_DEFAULT_TERMS: Record<FormatKind, string[]> = {
  interview: ['访谈', '采访', '专访', '对谈', '对话', 'interview', 'conversation', 'podcast'],
  tutorial: ['教程', '教学', '入门', 'tutorial', 'how to', 'guide'],
  lecture: ['讲座', '演讲', '公开课', '课程', 'lecture', 'talk', 'keynote'],
  explainer: ['科普', '讲解', '解读', '原理', 'explained', 'explainer', 'introduction'],
  podcast: ['播客', 'podcast', 'episode'],
  documentary: ['纪录片', 'documentary'],
  review: ['评测', '测评', 'review'],
  news: ['新闻', '快讯', 'news'],
  other: [],
};

export const QUALITY_LABELS: Record<QualityAspect, string> = {
  popular: '热门/高播放',
  high_engagement: '高互动/口碑好',
  authoritative: '权威/专业来源',
  in_depth: '有深度',
  production: '制作精良',
  other: '质量要求',
};

export const SORT_LABELS: Record<SortBy, string> = {
  recency: '越新越好',
  popularity: '越热门越好',
  rating: '口碑越好越好',
  relevance: '最相关',
};

const CHANNEL_MODE_LABELS: Record<ChannelMode, string> = {
  only: '只要',
  exclude: '排除',
  prefer: '优先',
};

const LIVE_LABELS: Record<EventType, string> = {
  live: '正在直播',
  completed: '直播回放',
  upcoming: '即将直播',
};

const LANG_RE = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

function cleanStr(v: unknown, max = 120): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function cleanTerms(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return uniqueStrings(v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 40))).slice(0, 12);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function pick<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

export function normalizeLanguage(v: unknown): string | undefined {
  const s = cleanStr(v, 12).toLowerCase();
  if (!s || s === 'none') return undefined;
  if (!LANG_RE.test(s)) return undefined;
  if (s.startsWith('zh')) return 'zh';
  if (s === 'yue') return 'yue';
  return s.split('-')[0];
}

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

/** 根据参数生成人话描述（回显里展示的是"实际执行的值"，不是 LLM 的措辞）。 */
export function describeConstraint(kind: ConstraintKind, p: ConstraintParams): string {
  switch (kind) {
    case 'topic':
      return p.terms?.length ? `主题：${p.terms.join(' / ')}` : '主题';
    case 'language':
      return `语言：${p.language ? languageName(p.language) : '未指定'}`;
    case 'recency':
      return p.withinHours ? `发布时间：${formatHoursWindow(p.withinHours)}` : '发布时间';
    case 'duration': {
      const min = p.minMinutes ?? 0;
      const max = p.maxMinutes ?? 0;
      if (min && max) return `时长：${min}–${max} 分钟`;
      if (min) return `时长：≥ ${min} 分钟`;
      if (max) return `时长：≤ ${max} 分钟`;
      return '时长';
    }
    case 'format':
      return `形式：${FORMAT_LABELS[p.format ?? 'other']}${p.terms?.length ? `（${p.terms.slice(0, 4).join('、')}）` : ''}`;
    case 'quality':
      return `质量：${QUALITY_LABELS[p.aspect ?? 'other']}`;
    case 'caption':
      return p.language ? `字幕：需要（${languageName(p.language)}字幕）` : '字幕：需要';
    case 'exclude_shorts':
      return '排除 Shorts';
    case 'exclude_terms':
      return `排除：${(p.terms ?? []).join('、')}`;
    case 'channel':
      return `频道：${CHANNEL_MODE_LABELS[p.mode ?? 'prefer']}「${(p.channelNames ?? []).join('」「')}」`;
    case 'subscriptions_only':
      return '只看我订阅的频道';
    case 'min_views':
      return `播放量 ≥ ${formatCount(p.minViews ?? 0)}`;
    case 'definition':
      return p.terms?.some((t) => /4k|2160|8k/i.test(t)) ? `清晰度：${p.terms.join(' / ')}` : '清晰度：高清';
    case 'live':
      return `直播：${LIVE_LABELS[p.eventType ?? 'live']}`;
    case 'region':
      return `地区：${p.regionCode ?? ''}`;
    case 'sort':
      return `排序偏好：${SORT_LABELS[p.sortBy ?? 'relevance']}`;
    case 'count':
      return `数量：${p.count ?? 0} 条`;
    case 'other':
      return p.description || '其他要求';
  }
}

function asOther(raw: RawConstraint, note: string, base: Pick<Constraint, 'id' | 'span' | 'importance' | 'source'>): Constraint {
  const description = cleanStr(raw.description, 200) || cleanStr(raw.label, 200) || base.span || '未能解析的要求';
  const params: ConstraintParams = { description, terms: cleanTerms(raw.terms) };
  return { ...base, kind: 'other', label: describeConstraint('other', params), params, normalizationNote: note };
}

/** 规范化单个约束。无效时转为 other（绝不丢弃）。 */
export function normalizeConstraint(raw: RawConstraint, id: string, source: ConstraintSource = 'llm'): Constraint {
  const base = {
    id,
    span: cleanStr(raw.span, 100),
    importance: (raw.importance === 'soft' ? 'soft' : 'hard') as 'hard' | 'soft',
    source,
  };
  const kind = pick(raw.kind, CONSTRAINT_KINDS);
  if (!kind) return asOther(raw, `未知约束类别「${cleanStr(raw.kind, 30)}」，按"其他要求"处理`, base);

  const terms = cleanTerms(raw.terms);
  let params: ConstraintParams;
  switch (kind) {
    case 'topic':
      params = { terms: terms.length ? terms : base.span ? [base.span] : [] };
      if (!params.terms?.length) return asOther(raw, '主题为空', base);
      break;
    case 'language': {
      const language = normalizeLanguage(raw.language);
      if (!language) return asOther(raw, `无法识别的语言代码「${cleanStr(raw.language, 12)}」`, base);
      params = { language };
      break;
    }
    case 'recency': {
      const h = num(raw.withinHours);
      if (h <= 0 || h > 24 * 365 * 10) return asOther(raw, '时间范围无效', base);
      params = { withinHours: Math.round(h) };
      break;
    }
    case 'duration': {
      const min = Math.max(0, num(raw.minMinutes));
      const max = Math.max(0, num(raw.maxMinutes));
      if (!min && !max) return asOther(raw, '时长范围为空', base);
      if (min && max && min > max) return asOther(raw, '时长下限大于上限', base);
      params = {};
      if (min) params.minMinutes = min;
      if (max) params.maxMinutes = max;
      break;
    }
    case 'format': {
      const format = pick(raw.format, FORMAT_KINDS) ?? 'other';
      params = { format, terms: terms.length ? terms : FORMAT_DEFAULT_TERMS[format] };
      break;
    }
    case 'quality':
      params = { aspect: pick(raw.aspect, QUALITY_ASPECTS) ?? 'other' };
      break;
    case 'caption': {
      const language = normalizeLanguage(raw.language);
      params = language ? { language } : {};
      break;
    }
    case 'exclude_shorts':
    case 'subscriptions_only':
      params = {};
      break;
    case 'definition':
      params = terms.length ? { terms } : {};
      break;
    case 'exclude_terms':
      if (!terms.length) return asOther(raw, '没有给出要排除的词', base);
      params = { terms };
      break;
    case 'channel': {
      const names = cleanTerms(raw.channelNames);
      if (!names.length) return asOther(raw, '没有给出频道名', base);
      params = { channelNames: names, mode: pick(raw.mode, CHANNEL_MODES) ?? 'prefer' };
      break;
    }
    case 'min_views': {
      const v = num(raw.minViews);
      if (v <= 0) return asOther(raw, '播放量下限无效', base);
      params = { minViews: Math.round(v) };
      break;
    }
    case 'live':
      params = { eventType: pick(raw.eventType, EVENT_TYPES) ?? 'live' };
      break;
    case 'region': {
      const code = cleanStr(raw.regionCode, 4).toUpperCase();
      if (!/^[A-Z]{2}$/.test(code)) return asOther(raw, `无效的地区代码「${code}」`, base);
      params = { regionCode: code };
      break;
    }
    case 'sort': {
      const sortBy = pick(raw.sortBy, SORT_BYS);
      if (!sortBy) return asOther(raw, '排序方式无效', base);
      params = { sortBy };
      break;
    }
    case 'count': {
      const c = Math.round(num(raw.count));
      if (c < 1 || c > 50) return asOther(raw, '数量无效', base);
      params = { count: c };
      break;
    }
    case 'other':
      params = { description: cleanStr(raw.description, 200) || cleanStr(raw.label, 200) || base.span, terms };
      break;
  }
  return { ...base, kind, label: describeConstraint(kind, params), params };
}

export function normalizeQueries(raw: unknown): QuerySpec[] {
  if (!Array.isArray(raw)) return [];
  const out: QuerySpec[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const q = cleanStr((item as { q?: unknown }).q, 100);
    if (!q || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    const language = normalizeLanguage((item as { language?: unknown }).language);
    out.push(language ? { q, language } : { q });
  }
  return out.slice(0, 3);
}

/** 新建一个用户手动添加的约束（回显编辑用）。 */
export function makeUserConstraint(kind: ConstraintKind, id: string, params: ConstraintParams = {}): Constraint {
  return { id, kind, span: '', importance: 'hard', source: 'user', params, label: describeConstraint(kind, params) };
}

/** 修改参数后重算描述。 */
export function withParams(c: Constraint, params: ConstraintParams): Constraint {
  return { ...c, params, label: describeConstraint(c.kind, params) };
}

/** 把空白 RawConstraint 补齐，供规则提取器等内部来源复用 normalizeConstraint。 */
export function rawConstraint(partial: Partial<RawConstraint> & { kind: string; span: string }): RawConstraint {
  return {
    label: '',
    importance: 'hard',
    terms: [],
    language: '',
    withinHours: 0,
    minMinutes: 0,
    maxMinutes: 0,
    format: 'none',
    aspect: 'none',
    channelNames: [],
    mode: 'none',
    minViews: 0,
    count: 0,
    sortBy: 'none',
    eventType: 'none',
    regionCode: '',
    description: '',
    ...partial,
  };
}
