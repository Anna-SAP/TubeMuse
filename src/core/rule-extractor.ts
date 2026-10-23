// 本地规则提取器：LLM 解析之后的"兜底守卫"。
// 对常见约束（时效、时长、语言、字幕、Shorts、形式、清晰度……）做确定性识别；
// 若 LLM 漏掉了某个被规则识别到的约束，就以 source='rule' 补进来，保证不静默丢失。

import { rawConstraint, type RawConstraint } from './constraints';

export interface RuleHit {
  raw: RawConstraint;
  /** 在原句中的位置，用于判断是否与 LLM 约束重叠 */
  start: number;
  end: number;
}

const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 解析阿拉伯数字或简单中文数字（≤ 99），"半" = 0.5 */
export function parseNumber(token: string): number | undefined {
  const t = token.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === '半') return 0.5;
  if (t === '十') return 10;
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(t);
  if (m) return (m[1] ? (CN_DIGITS[m[1]] ?? 1) : 1) * 10 + (m[2] ? (CN_DIGITS[m[2]] ?? 0) : 0);
  if (t.length === 1 && t in CN_DIGITS) return CN_DIGITS[t];
  return undefined;
}

const NUM = '(\\d+(?:\\.\\d+)?|[一二两三四五六七八九十半]{1,3})';
const UNIT_HOURS: Record<string, number> = {
  小时: 1,
  个小时: 1,
  天: 24,
  日: 24,
  周: 168,
  星期: 168,
  个星期: 168,
  礼拜: 168,
  个礼拜: 168,
  月: 720,
  个月: 720,
  年: 8760,
};
const EN_UNIT_HOURS: Record<string, number> = { hour: 1, day: 24, week: 168, month: 720, year: 8760 };

type Rule = (text: string) => RuleHit[];

function allMatches(re: RegExp, text: string): RegExpExecArray[] {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  return [...text.matchAll(new RegExp(re.source, flags))];
}

function hit(m: RegExpExecArray, raw: Omit<Parameters<typeof rawConstraint>[0], 'span'>): RuleHit {
  return { raw: rawConstraint({ ...raw, span: m[0].trim() }), start: m.index, end: m.index + m[0].length };
}

const recencyRule: Rule = (text) => {
  const hits: RuleHit[] = [];
  for (const m of allMatches(new RegExp(`(?:近|最近|过去|这)?${NUM}\\s*(个小时|小时|天|日|个星期|星期|个礼拜|礼拜|周|个月|月|年)(?:以?内|之内|里)`), text)) {
    const n = parseNumber(m[1] ?? '');
    const unit = UNIT_HOURS[m[2] ?? ''];
    if (n !== undefined && unit) hits.push(hit(m, { kind: 'recency', withinHours: Math.max(1, Math.round(n * unit)) }));
  }
  for (const m of allMatches(new RegExp(`(?:近|最近|过去)${NUM}\\s*(个小时|小时|天|日|个星期|星期|周|个月|月|年)`), text)) {
    const n = parseNumber(m[1] ?? '');
    const unit = UNIT_HOURS[m[2] ?? ''];
    if (n !== undefined && unit) hits.push(hit(m, { kind: 'recency', withinHours: Math.max(1, Math.round(n * unit)) }));
  }
  for (const m of allMatches(/今天|今日|当天/, text)) hits.push(hit(m, { kind: 'recency', withinHours: 24 }));
  for (const m of allMatches(/本周|这周|这一周/, text)) hits.push(hit(m, { kind: 'recency', withinHours: 168 }));
  for (const m of allMatches(/本月|这个月/, text)) hits.push(hit(m, { kind: 'recency', withinHours: 720 }));
  for (const m of allMatches(/\b(?:in the |within the )?(?:past|last)\s+(\d+)\s+(hour|day|week|month|year)s?\b/i, text)) {
    const unit = EN_UNIT_HOURS[(m[2] ?? '').toLowerCase()];
    if (unit) hits.push(hit(m, { kind: 'recency', withinHours: Number(m[1]) * unit }));
  }
  for (const m of allMatches(/\b(?:past|last|this)\s+(hour|day|week|month|year)\b/i, text)) {
    const unit = EN_UNIT_HOURS[(m[1] ?? '').toLowerCase()];
    if (unit) hits.push(hit(m, { kind: 'recency', withinHours: unit }));
  }
  for (const m of allMatches(/\btoday\b/i, text)) hits.push(hit(m, { kind: 'recency', withinHours: 24 }));
  return hits;
};

const durationRule: Rule = (text) => {
  const hits: RuleHit[] = [];
  const toMin = (n: number, unit: string) => (/小时|hour|hr/i.test(unit) ? n * 60 : n);
  const unitRe = '(个小时|小时|分钟|分|hours?|hrs?|minutes?|mins?)';
  // 区间：5 到 10 分钟 / 5-10 分钟
  for (const m of allMatches(new RegExp(`${NUM}\\s*(?:到|至|-|~|–)\\s*${NUM}\\s*${unitRe}`, 'i'), text)) {
    const a = parseNumber(m[1] ?? '');
    const b = parseNumber(m[2] ?? '');
    if (a !== undefined && b !== undefined) {
      hits.push(hit(m, { kind: 'duration', minMinutes: toMin(a, m[3] ?? ''), maxMinutes: toMin(b, m[3] ?? '') }));
    }
  }
  // 下限：一小时以上 / 超过 30 分钟 / at least 1 hour / over an hour
  for (const m of allMatches(new RegExp(`(?:超过|大于|长于|至少|不少于|不低于)?\\s*${NUM}\\s*${unitRe}(?:以上|多|\\+|起)`, 'i'), text)) {
    const n = parseNumber(m[1] ?? '');
    if (n !== undefined) hits.push(hit(m, { kind: 'duration', minMinutes: toMin(n, m[2] ?? '') }));
  }
  for (const m of allMatches(new RegExp(`(?:超过|大于|长于|至少|不少于|不低于)\\s*${NUM}\\s*${unitRe}`, 'i'), text)) {
    const n = parseNumber(m[1] ?? '');
    if (n !== undefined) hits.push(hit(m, { kind: 'duration', minMinutes: toMin(n, m[2] ?? '') }));
  }
  for (const m of allMatches(/\b(?:over|more than|longer than|at least)\s+(an?|\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b/i, text)) {
    const n = /^an?$/i.test(m[1] ?? '') ? 1 : Number(m[1]);
    hits.push(hit(m, { kind: 'duration', minMinutes: toMin(n, m[2] ?? '') }));
  }
  // 上限：10 分钟以内 / 不超过半小时 / under 10 minutes
  for (const m of allMatches(new RegExp(`${NUM}\\s*${unitRe}(?:以内|之内|以下|内)`, 'i'), text)) {
    const n = parseNumber(m[1] ?? '');
    if (n !== undefined) hits.push(hit(m, { kind: 'duration', maxMinutes: toMin(n, m[2] ?? '') }));
  }
  for (const m of allMatches(new RegExp(`(?:不超过|少于|短于|小于|不到)\\s*${NUM}\\s*${unitRe}`, 'i'), text)) {
    const n = parseNumber(m[1] ?? '');
    if (n !== undefined) hits.push(hit(m, { kind: 'duration', maxMinutes: toMin(n, m[2] ?? '') }));
  }
  for (const m of allMatches(/\b(?:under|less than|shorter than)\s+(an?|\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b/i, text)) {
    const n = /^an?$/i.test(m[1] ?? '') ? 1 : Number(m[1]);
    hits.push(hit(m, { kind: 'duration', maxMinutes: toMin(n, m[2] ?? '') }));
  }
  for (const m of allMatches(/长视频/, text)) hits.push(hit(m, { kind: 'duration', minMinutes: 20 }));
  return hits;
};

const LANG_WORDS: [RegExp, string][] = [
  [/英文|英语|English/i, 'en'],
  [/中文|汉语|国语|普通话|Chinese|Mandarin/i, 'zh'],
  [/日语|日文|Japanese/i, 'ja'],
  [/韩语|韩文|Korean/i, 'ko'],
  [/粤语|Cantonese/i, 'yue'],
];

const languageRule: Rule = (text) => {
  const hits: RuleHit[] = [];
  for (const [re, code] of LANG_WORDS) {
    for (const m of allMatches(re, text)) {
      // "中文字幕" / "English subtitles" 是字幕语言，由字幕规则处理
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 10);
      if (/^\s*(字幕|subtitles?|captions?|subs\b)/i.test(after)) continue;
      hits.push(hit(m, { kind: 'language', language: code }));
    }
  }
  return hits;
};

const captionRule: Rule = (text) => {
  const hits: RuleHit[] = [];
  for (const m of allMatches(/(英文|英语|中文|日文|日语|English|Chinese|Japanese)?\s*(?:带|有|配|含)?\s*字幕|\b(?:with\s+)?(?:English\s+|Chinese\s+)?(?:subtitles?|subtitled|captions?|closed captions?)\b|\bCC\b/i, text)) {
    const langWord = m[1] ?? /English|Chinese/i.exec(m[0])?.[0] ?? '';
    const language = LANG_WORDS.find(([re]) => re.test(langWord))?.[1] ?? '';
    hits.push(hit(m, { kind: 'caption', language }));
  }
  return hits;
};

const shortsRule: Rule = (text) =>
  allMatches(/(?:不要|别要?|排除|不看|去掉|过滤掉?|非|除了|no|without|exclude|excluding|not)\s*(?:youtube\s*)?(?:shorts?|短视频|竖屏短片)/i, text).map((m) =>
    hit(m, { kind: 'exclude_shorts' }),
  );

const FORMAT_WORDS: [RegExp, string][] = [
  [/访谈|采访|专访|对谈|\binterviews?\b/i, 'interview'],
  [/播客|\bpodcasts?\b/i, 'podcast'],
  [/讲座|演讲|公开课|\blectures?\b|\bkeynotes?\b/i, 'lecture'],
  [/教程|教学|\btutorials?\b|\bhow[- ]to\b/i, 'tutorial'],
  [/科普|讲解|\bexplainers?\b|\bexplained\b/i, 'explainer'],
  [/纪录片|\bdocumentar(?:y|ies)\b/i, 'documentary'],
  [/评测|测评|\breviews?\b/i, 'review'],
  [/新闻|快讯|\bnews\b/i, 'news'],
];

const formatRule: Rule = (text) => {
  const hits: RuleHit[] = [];
  for (const [re, format] of FORMAT_WORDS) {
    for (const m of allMatches(re, text)) hits.push(hit(m, { kind: 'format', format, terms: [m[0]] }));
  }
  return hits;
};

const qualityRule: Rule = (text) => {
  const table: [RegExp, string][] = [
    [/高质量|优质|精品|\bhigh[- ]quality\b/i, 'other'],
    [/硬核|深度|深入|\bin[- ]depth\b/i, 'in_depth'],
    [/权威|专业|\bauthoritative\b/i, 'authoritative'],
    [/高赞|口碑好|好评/i, 'high_engagement'],
    [/热门|爆款|最火|\bpopular\b/i, 'popular'],
    [/制作精良|画面精美/i, 'production'],
  ];
  const hits: RuleHit[] = [];
  for (const [re, aspect] of table) for (const m of allMatches(re, text)) hits.push(hit(m, { kind: 'quality', aspect }));
  return hits;
};

const definitionRule: Rule = (text) =>
  allMatches(/\b4K\b|\b8K\b|1080[pP]|2160[pP]|高清|超清|蓝光|\bHD\b/i, text).map((m) => hit(m, { kind: 'definition', terms: [m[0]] }));

const liveRule: Rule = (text) => {
  const hits: RuleHit[] = [];
  for (const m of allMatches(/正在直播|直播中|\blive now\b|\blivestream(?:ing)?\b/i, text)) hits.push(hit(m, { kind: 'live', eventType: 'live' }));
  for (const m of allMatches(/直播回放|\bstream replay\b/i, text)) hits.push(hit(m, { kind: 'live', eventType: 'completed' }));
  return hits;
};

const sortRule: Rule = (text) => {
  const hits: RuleHit[] = [];
  for (const m of allMatches(/最新(?:发布)?的?|最近发布|\b(?:latest|newest|most recent)\b/i, text)) hits.push(hit(m, { kind: 'sort', sortBy: 'recency' }));
  for (const m of allMatches(/最热门?|最火|播放量?最高|\bmost (?:popular|viewed)\b/i, text)) hits.push(hit(m, { kind: 'sort', sortBy: 'popularity' }));
  return hits;
};

const countRule: Rule = (text) => {
  const hits: RuleHit[] = [];
  for (const m of allMatches(new RegExp(`${NUM}\\s*(?:个|条|部|支)(?!小时|月|星期|礼拜|半?钟)(?:视频|片子|影片)?`), text)) {
    const n = parseNumber(m[1] ?? '');
    if (n !== undefined && n >= 1 && n <= 50 && Number.isInteger(n)) hits.push(hit(m, { kind: 'count', count: n }));
  }
  for (const m of allMatches(/\b(?:top|give me|show me)\s+(\d{1,2})\b/i, text)) hits.push(hit(m, { kind: 'count', count: Number(m[1]) }));
  return hits;
};

const minViewsRule: Rule = (text) => {
  const hits: RuleHit[] = [];
  const mult = (u: string | undefined) => (u === '万' ? 1e4 : u === '亿' ? 1e8 : /k/i.test(u ?? '') ? 1e3 : /m/i.test(u ?? '') ? 1e6 : 1);
  for (const m of allMatches(new RegExp(`播放(?:量|数)?\\s*(?:超过|大于|高于|>|≥)?\\s*${NUM}\\s*(万|亿|[kKmM])?\\s*(?:次)?(?:以上|\\+)?`), text)) {
    const n = parseNumber(m[1] ?? '');
    if (n !== undefined && (m[2] || /以上|超过|大于|高于|\+/.test(m[0]))) hits.push(hit(m, { kind: 'min_views', minViews: n * mult(m[2]) }));
  }
  for (const m of allMatches(new RegExp(`${NUM}\\s*(万|亿)\\s*(?:次)?(?:播放|观看)(?:以上|\\+)?`), text)) {
    const n = parseNumber(m[1] ?? '');
    if (n !== undefined) hits.push(hit(m, { kind: 'min_views', minViews: n * mult(m[2]) }));
  }
  return hits;
};

const subscriptionsRule: Rule = (text) =>
  allMatches(/我订阅的(?:频道)?|订阅(?:的)?频道里|\bfrom my subscriptions\b|\bchannels i (?:follow|subscribe to)\b/i, text).map((m) =>
    hit(m, { kind: 'subscriptions_only' }),
  );

const excludeTermsRule: Rule = (text) => {
  const hits: RuleHit[] = [];
  for (const m of allMatches(/(?:不要|别要|排除|不看|去掉)\s*([^\s，,。、；;的]{1,12})/, text)) {
    const term = (m[1] ?? '').trim();
    if (!term || /^(?:shorts?|短视频|竖屏短片)$/i.test(term)) continue;
    hits.push(hit(m, { kind: 'exclude_terms', terms: [term] }));
  }
  for (const m of allMatches(/\b(?:without|excluding|no)\s+([A-Za-z][\w-]{2,20})\b/gi, text)) {
    const term = m[1] ?? '';
    if (/^shorts?$|^subtitles?$|^captions?$/i.test(term)) continue;
    hits.push(hit(m, { kind: 'exclude_terms', terms: [term] }));
  }
  return hits;
};

const RULES: Rule[] = [
  recencyRule,
  durationRule,
  languageRule,
  captionRule,
  shortsRule,
  formatRule,
  qualityRule,
  definitionRule,
  liveRule,
  sortRule,
  countRule,
  minViewsRule,
  subscriptionsRule,
  excludeTermsRule,
];

/** 对原句跑全部规则；同类且重叠的命中只保留最长的一个。 */
export function extractByRules(text: string): RuleHit[] {
  const all = RULES.flatMap((rule) => rule(text));
  all.sort((a, b) => b.end - b.start - (a.end - a.start));
  const kept: RuleHit[] = [];
  for (const h of all) {
    // 同一片段只归一个类别：已被更长命中覆盖的跳过
    const overlap = kept.some((k) => h.start < k.end && k.start < h.end && (k.raw.kind === h.raw.kind || (k.start <= h.start && k.end >= h.end)));
    if (!overlap) kept.push(h);
  }
  return kept.sort((a, b) => a.start - b.start);
}
