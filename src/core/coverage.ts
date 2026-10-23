// 约束覆盖守卫：
//  1) 规则提取器识别到、但 LLM 没有覆盖的约束 → 以 source='rule' 补入；
//  2) 原句中既不属于任何约束、也不是口语填充词的片段 → 以 source='coverage' 的"其他要求"补入（仅作参考）。
// 这样口令里的每一部分要么被落实，要么在回显里明确标注，绝不静默丢弃。

import { normalizeConstraint, rawConstraint } from './constraints';
import { extractByRules } from './rule-extractor';
import type { Constraint, ConstraintKind } from './types';

/** 同一句里通常只出现一次的类别：已有同类约束即视为覆盖。 */
const SINGLETON_KINDS = new Set<ConstraintKind>([
  'recency',
  'duration',
  'language',
  'caption',
  'exclude_shorts',
  'sort',
  'count',
  'min_views',
  'definition',
  'live',
  'subscriptions_only',
]);

const FILLERS = [
  '帮我找一下',
  '帮我找找',
  '帮我搜一下',
  '帮我找',
  '帮我搜',
  '帮忙找',
  '给我找',
  '给我推荐',
  '推荐一下',
  '推荐一些',
  '推荐几个',
  '我想看看',
  '我想看',
  '我想要',
  '我要看',
  '想看看',
  '想看',
  '想要',
  '找一下',
  '找找',
  '搜一下',
  '看一下',
  '看看',
  '来点',
  '来些',
  '一些',
  '一点',
  '几个',
  '相关的',
  '有关的',
  '关于',
  '相关',
  '有关',
  '视频',
  '影片',
  '片子',
  '节目',
  '内容',
  '以及',
  '或者',
  '还有',
  '并且',
  '而且',
  '同时',
  '然后',
  '最好',
  '一下',
  '请',
  '帮',
  '找',
  '搜',
  '推荐',
  '给',
  '我',
  '的',
  '地',
  '得',
  '了',
  '吧',
  '呢',
  '啊',
  '呀',
  '和',
  '与',
  '及',
  '些',
  '点',
  '个',
  '条',
  '要',
  '看',
];

const EN_STOPWORDS = new Set(
  'i me my want wanna to watch find show give recommend some any videos video clips clip about on the a an of for with and or please that are is in from me something stuff can you could would like'.split(
    ' ',
  ),
);

export interface Range {
  start: number;
  end: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 在原句中定位片段：忽略大小写与空白差异。 */
export function locateSpan(text: string, span: string): Range | undefined {
  const s = span.trim();
  if (!s) return undefined;
  const chars = [...s.replace(/\s+/g, '')];
  if (!chars.length) return undefined;
  const re = new RegExp(chars.map(escapeRe).join('\\s*'), 'iu');
  const m = re.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : undefined;
}

function overlaps(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

function constraintRanges(text: string, c: Constraint): Range[] {
  const ranges: Range[] = [];
  const main = locateSpan(text, c.span);
  if (main) ranges.push(main);
  // 主题词等也算覆盖（LLM 偶尔会把片段轻微改写）
  for (const t of c.params.terms ?? []) {
    const r = locateSpan(text, t);
    if (r) ranges.push(r);
  }
  return ranges;
}

/** 找出未被任何范围覆盖、去掉填充词后仍有意义的片段。 */
export function leftoverSegments(text: string, covered: Range[]): string[] {
  // range 用的是 UTF-16 下标，这里按下标逐个标记
  const masked = text
    .split('')
    .map((ch, i) => (covered.some((r) => i >= r.start && i < r.end) ? '\u0000' : ch))
    .join('');
  let rest = masked;
  for (const f of FILLERS) rest = rest.split(f).join('\u0000');
  const segments = rest
    .split(/[\u0000\s,，。.!！?？、；;:：'"“”‘’()（）[\]【】<>《》\-–—~·…]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  return segments.filter((seg) => {
    const cjk = (seg.match(/[㐀-鿿]/g) ?? []).length;
    if (cjk >= 2) return true;
    const words = seg.toLowerCase().match(/[a-z][a-z0-9+#.]*/g) ?? [];
    return words.some((w) => w.length >= 3 && !EN_STOPWORDS.has(w));
  });
}

export interface GuardResult {
  constraints: Constraint[];
  notes: string[];
}

/** 对 LLM 解析出的约束做覆盖守卫。nextId 用于给新增约束编号。 */
export function applyCoverageGuards(text: string, llmConstraints: Constraint[], nextId: () => string): GuardResult {
  const constraints = [...llmConstraints];
  const notes: string[] = [];
  const covered: Range[] = constraints.flatMap((c) => constraintRanges(text, c));

  for (const h of extractByRules(text)) {
    const kind = h.raw.kind as ConstraintKind;
    const range = { start: h.start, end: h.end };
    const coveredBySpan = covered.some((r) => overlaps(r, range));
    const coveredByKind = SINGLETON_KINDS.has(kind) && constraints.some((c) => c.kind === kind);
    if (coveredBySpan || coveredByKind) continue;
    const added = normalizeConstraint(h.raw, nextId(), 'rule');
    constraints.push(added);
    covered.push(range);
    notes.push(`本地规则补充了 LLM 漏掉的约束：「${added.span}」→ ${added.label}`);
  }

  for (const seg of leftoverSegments(text, covered)) {
    const c = normalizeConstraint(
      rawConstraint({ kind: 'other', span: seg, description: `未被理解的片段「${seg}」`, terms: [seg] }),
      nextId(),
      'coverage',
    );
    c.normalizationNote = '系统没能确定这部分的含义，只作为关键词参考；如有误请编辑或删除';
    constraints.push(c);
    notes.push(`原句中「${seg}」没有被理解为任何约束，已作为"其他要求"列出`);
  }
  return { constraints, notes };
}
