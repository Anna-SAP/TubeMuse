// 回显：逐条展示"我理解到的约束"以及每条约束如何落实；可编辑后重搜。

import { useState } from 'preact/hooks';
import { FORMAT_DEFAULT_TERMS, FORMAT_LABELS, LANGUAGE_NAMES, QUALITY_LABELS, SORT_LABELS, makeUserConstraint, withParams } from '../../core/constraints';
import { describeCost } from '../../core/planner';
import { formatRelative } from '../../core/time';
import {
  CHANNEL_MODES,
  CONSTRAINT_KINDS,
  EVENT_TYPES,
  FORMAT_KINDS,
  KIND_LABELS,
  QUALITY_ASPECTS,
  SORT_BYS,
  type Constraint,
  type ConstraintKind,
  type ConstraintParams,
  type CoverageStatus,
  type Disposition,
  type Intent,
  type SearchPlan,
  type SearchSession,
} from '../../core/types';
import type { QuotaSnapshot } from '../../core/quota';

const STATUS: Record<CoverageStatus, { label: string; cls: string }> = {
  enforced: { label: '已落实', cls: 'st-ok' },
  approximate: { label: '近似落实', cls: 'st-approx' },
  partial: { label: '部分落实', cls: 'st-partial' },
  reference_only: { label: '仅作参考', cls: 'st-ref' },
  unsupported: { label: '无法满足', cls: 'st-no' },
};

const SOURCE_LABELS: Partial<Record<Constraint['source'], string>> = {
  rule: '本地规则补充',
  coverage: '未识别片段',
  user: '你添加的',
};

function dispText(d: Disposition): { tag: string; text: string; cls: string } {
  switch (d.type) {
    case 'api_param':
      return { tag: 'API 参数', text: `${d.param} = ${d.value}${d.note ? `（${d.note}）` : ''}`, cls: 'd-api' };
    case 'query_term':
      return { tag: '检索词', text: d.detail, cls: 'd-query' };
    case 'post_filter':
      return { tag: '后置过滤', text: `${d.detail}${d.note ? `（${d.note}）` : ''}`, cls: 'd-filter' };
    case 'rank_factor':
      return { tag: '排序因子', text: `${d.detail}${d.note ? `（${d.note}）` : ''}`, cls: 'd-rank' };
    case 'result_count':
      return { tag: '数量', text: d.detail, cls: 'd-count' };
    case 'unsupported':
      return { tag: '无法满足', text: d.reason, cls: 'd-no' };
    case 'reference_only':
      return { tag: '仅作参考', text: d.reason, cls: 'd-ref' };
  }
}

function defaultParams(kind: ConstraintKind): ConstraintParams {
  switch (kind) {
    case 'language':
      return { language: 'en' };
    case 'recency':
      return { withinHours: 168 };
    case 'duration':
      return { minMinutes: 20 };
    case 'format':
      return { format: 'interview', terms: FORMAT_DEFAULT_TERMS.interview };
    case 'quality':
      return { aspect: 'other' };
    case 'channel':
      return { channelNames: [], mode: 'prefer' };
    case 'min_views':
      return { minViews: 10_000 };
    case 'sort':
      return { sortBy: 'recency' };
    case 'count':
      return { count: 10 };
    case 'live':
      return { eventType: 'live' };
    case 'region':
      return { regionCode: 'US' };
    case 'topic':
    case 'exclude_terms':
      return { terms: [] };
    case 'other':
      return { description: '', terms: [] };
    default:
      return {};
  }
}

const splitTerms = (s: string) =>
  s
    .split(/[,，、;；]/)
    .map((x) => x.trim())
    .filter(Boolean);

function TermsInput({ value, onChange, placeholder }: { value: string[] | undefined; onChange: (v: string[]) => void; placeholder?: string }) {
  return (
    <input
      class="input"
      value={(value ?? []).join('、')}
      placeholder={placeholder ?? '多个用顿号或逗号分隔'}
      onChange={(e) => onChange(splitTerms(e.currentTarget.value))}
    />
  );
}

function NumberInput({ value, onChange, min = 0, step = 1 }: { value: number | undefined; onChange: (v: number | undefined) => void; min?: number; step?: number }) {
  return (
    <input
      class="input num"
      type="number"
      min={min}
      step={step}
      value={value ?? ''}
      onChange={(e) => {
        const v = e.currentTarget.value;
        onChange(v === '' ? undefined : Number(v));
      }}
    />
  );
}

function Select<T extends string>({ value, options, labels, onChange }: { value: T | undefined; options: readonly T[]; labels?: Partial<Record<T, string>>; onChange: (v: T) => void }) {
  return (
    <select class="input" value={value} onChange={(e) => onChange(e.currentTarget.value as T)}>
      {options.map((o) => (
        <option value={o}>{labels?.[o] ?? o}</option>
      ))}
    </select>
  );
}

const CHANNEL_MODE_LABELS = { only: '只要', exclude: '排除', prefer: '优先' } as const;
const EVENT_LABELS = { live: '正在直播', completed: '直播回放', upcoming: '即将直播' } as const;
const LANG_OPTIONS = ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt', 'yue'] as const;

function ParamEditor({ c, onChange }: { c: Constraint; onChange: (p: ConstraintParams) => void }) {
  const p = c.params;
  const set = (patch: Partial<ConstraintParams>) => {
    const next = { ...p, ...patch };
    for (const k of Object.keys(next) as (keyof ConstraintParams)[]) if (next[k] === undefined) delete next[k];
    onChange(next);
  };
  switch (c.kind) {
    case 'topic':
    case 'exclude_terms':
    case 'definition':
      return <TermsInput value={p.terms} onChange={(terms) => set({ terms })} />;
    case 'language':
      return <Select value={p.language as (typeof LANG_OPTIONS)[number]} options={LANG_OPTIONS} labels={LANGUAGE_NAMES} onChange={(language) => set({ language })} />;
    case 'caption':
      return (
        <label class="inline">
          字幕语言（可选）：
          <Select value={(p.language ?? '') as '' | (typeof LANG_OPTIONS)[number]} options={['', ...LANG_OPTIONS]} labels={{ '': '不限', ...LANGUAGE_NAMES }} onChange={(language) => set({ language: language || undefined })} />
        </label>
      );
    case 'recency':
      return (
        <label class="inline">
          最近 <NumberInput value={p.withinHours} min={1} onChange={(withinHours) => set({ withinHours })} /> 小时内（24=1 天，168=1 周）
        </label>
      );
    case 'duration':
      return (
        <label class="inline">
          ≥ <NumberInput value={p.minMinutes} onChange={(minMinutes) => set({ minMinutes: minMinutes || undefined })} /> 分钟，≤{' '}
          <NumberInput value={p.maxMinutes} onChange={(maxMinutes) => set({ maxMinutes: maxMinutes || undefined })} /> 分钟（空 = 不限）
        </label>
      );
    case 'format':
      return (
        <div class="stack">
          <Select value={p.format} options={FORMAT_KINDS} labels={FORMAT_LABELS} onChange={(format) => set({ format, terms: FORMAT_DEFAULT_TERMS[format] })} />
          <TermsInput value={p.terms} onChange={(terms) => set({ terms })} placeholder="用于匹配标题的关键词" />
        </div>
      );
    case 'quality':
      return <Select value={p.aspect} options={QUALITY_ASPECTS} labels={QUALITY_LABELS} onChange={(aspect) => set({ aspect })} />;
    case 'channel':
      return (
        <div class="stack">
          <Select value={p.mode} options={CHANNEL_MODES} labels={CHANNEL_MODE_LABELS} onChange={(mode) => set({ mode })} />
          <TermsInput value={p.channelNames} onChange={(channelNames) => set({ channelNames })} placeholder="频道名" />
        </div>
      );
    case 'min_views':
      return (
        <label class="inline">
          播放量 ≥ <NumberInput value={p.minViews} step={1000} onChange={(minViews) => set({ minViews })} />
        </label>
      );
    case 'sort':
      return <Select value={p.sortBy} options={SORT_BYS} labels={SORT_LABELS} onChange={(sortBy) => set({ sortBy })} />;
    case 'count':
      return (
        <label class="inline">
          显示 <NumberInput value={p.count} min={1} onChange={(count) => set({ count })} /> 条
        </label>
      );
    case 'live':
      return <Select value={p.eventType} options={EVENT_TYPES} labels={EVENT_LABELS} onChange={(eventType) => set({ eventType })} />;
    case 'region':
      return <input class="input" value={p.regionCode ?? ''} maxLength={2} onChange={(e) => set({ regionCode: e.currentTarget.value.toUpperCase() })} />;
    case 'other':
      return (
        <div class="stack">
          <input class="input" value={p.description ?? ''} placeholder="这项要求是什么" onChange={(e) => set({ description: e.currentTarget.value })} />
          <TermsInput value={p.terms} onChange={(terms) => set({ terms })} placeholder="可用于匹配的关键词（没有就留空）" />
        </div>
      );
    default:
      return <span class="muted">这类约束没有可调参数</span>;
  }
}

const IMPORTANCE_KINDS = new Set<ConstraintKind>(['language', 'recency', 'duration', 'caption', 'min_views', 'definition']);

function ConstraintRow({
  c,
  plan,
  onChange,
  onDelete,
}: {
  c: Constraint;
  plan: SearchPlan | undefined;
  onChange: (c: Constraint) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const status = plan?.coverage[c.id];
  const ds = plan?.dispositions[c.id] ?? [];
  return (
    <li class="echo-row" data-kind={c.kind}>
      <div class="echo-head">
        <span class="kind-chip">{KIND_LABELS[c.kind]}</span>
        {c.span && <span class="span-quote">「{c.span}」</span>}
        <span class="echo-label">{c.label}</span>
        {status && <span class={`status ${STATUS[status].cls}`}>{STATUS[status].label}</span>}
        <span class="row-actions">
          <button class="icon-btn" title="编辑" onClick={() => setEditing(!editing)}>
            ✎
          </button>
          <button class="icon-btn" title="删除这个约束" onClick={onDelete}>
            ×
          </button>
        </span>
      </div>
      {(SOURCE_LABELS[c.source] || c.normalizationNote) && (
        <div class="echo-note">
          {SOURCE_LABELS[c.source] && <span class="src-tag">{SOURCE_LABELS[c.source]}</span>}
          {c.normalizationNote}
        </div>
      )}
      <ul class="disp-list">
        {ds.map((d) => {
          const t = dispText(d);
          return (
            <li class={t.cls}>
              <span class="d-tag">{t.tag}</span>
              {t.text}
            </li>
          );
        })}
      </ul>
      {editing && (
        <div class="echo-editor">
          <ParamEditor c={c} onChange={(params) => onChange(withParams(c, params))} />
          {IMPORTANCE_KINDS.has(c.kind) && (
            <label class="inline">
              <input type="checkbox" checked={c.importance === 'soft'} onChange={(e) => onChange({ ...c, importance: e.currentTarget.checked ? 'soft' : 'hard' })} />
              只是偏好（不满足也保留，满足的加分）
            </label>
          )}
          <button class="btn small" onClick={() => setEditing(false)}>
            完成
          </button>
        </div>
      )}
    </li>
  );
}

export interface EchoProps {
  intent: Intent;
  plan: SearchPlan | undefined;
  session: SearchSession | undefined;
  quota: QuotaSnapshot | undefined;
  dirty: boolean;
  busy: boolean;
  now: number;
  maxQueries: number;
  onChange: (intent: Intent) => void;
  onResearch: () => void;
  onReparse: () => void;
}

export function Echo(props: EchoProps) {
  const { intent, plan, session } = props;
  const [adding, setAdding] = useState<ConstraintKind | ''>('');
  const update = (constraints: Constraint[]) => props.onChange({ ...intent, constraints });
  const sameSession = session && session.intent === intent;
  const notes = [...intent.notes, ...(plan?.notes ?? [])];
  return (
    <section class="echo" aria-label="理解回显">
      <div class="echo-title">
        <strong>我的理解</strong>
        {intent.interpretation && <span class="interp">{intent.interpretation}</span>}
      </div>
      {intent.correctionsUsed > 0 && <div class="muted small">参考了你的 {intent.correctionsUsed} 条理解纠正</div>}
      <ul class="echo-list">
        {intent.constraints.map((c) => (
          <ConstraintRow
            key={c.id}
            c={c}
            plan={plan}
            onChange={(nc) => update(intent.constraints.map((x) => (x.id === c.id ? nc : x)))}
            onDelete={() => update(intent.constraints.filter((x) => x.id !== c.id))}
          />
        ))}
      </ul>
      <div class="echo-add">
        <select
          class="input"
          value={adding}
          onChange={(e) => {
            const kind = e.currentTarget.value as ConstraintKind;
            if (!kind) return;
            const id = `u${Date.now().toString(36)}`;
            update([...intent.constraints, makeUserConstraint(kind, id, defaultParams(kind))]);
            setAdding('');
          }}
        >
          <option value="">+ 添加约束…</option>
          {CONSTRAINT_KINDS.map((k) => (
            <option value={k}>{KIND_LABELS[k]}</option>
          ))}
        </select>
      </div>

      <div class="queries">
        <div class="muted small">检索词（每条 1 次 search）：</div>
        {intent.queries.map((q, i) => (
          <div class="query-row">
            <input
              class="input"
              value={q.q}
              onChange={(e) => {
                const queries = intent.queries.map((x, j) => (j === i ? { ...x, q: e.currentTarget.value.trim() } : x)).filter((x) => x.q);
                props.onChange({ ...intent, queries });
              }}
            />
            {q.language && <span class="lang-tag">{LANGUAGE_NAMES[q.language] ?? q.language}</span>}
            {intent.queries.length > 1 && (
              <button class="icon-btn" title="删除检索词" onClick={() => props.onChange({ ...intent, queries: intent.queries.filter((_, j) => j !== i) })}>
                ×
              </button>
            )}
          </div>
        ))}
        {intent.queries.length < props.maxQueries && (
          <button class="btn link" onClick={() => props.onChange({ ...intent, queries: [...intent.queries, { q: intent.topic || '新的检索词' }] })}>
            + 添加检索词
          </button>
        )}
      </div>

      {notes.length > 0 && (
        <ul class="echo-notes">
          {notes.map((n) => (
            <li>{n}</li>
          ))}
        </ul>
      )}

      <div class="cost-line">
        {sameSession && session?.fromCache ? (
          <span class="badge cache">缓存 · {formatRelative(session.createdAt - (session.cacheAgeMs ?? 0), props.now)}的结果 · 未消耗配额</span>
        ) : sameSession && session ? (
          <span>
            本次实际消耗：search ×{session.cost.searchCalls}、{session.cost.generalUnits} units
            {session.extraPagesUsed ? `（含因过滤后不足而追加的 ${session.extraPagesUsed} 次翻页）` : ''}
          </span>
        ) : plan ? (
          <span>
            预计：{describeCost(plan)}
            {props.quota && `；今日剩 search ${props.quota.search.remaining} 次`}
          </span>
        ) : null}
      </div>

      {sameSession && session && session.filterStats.some((f) => f.removed > 0) && (
        <div class="filter-stats small">
          候选 {session.fetchedCount} 条
          {session.filterStats
            .filter((f) => f.removed > 0)
            .map((f) => ` → 「${f.label}」淘汰 ${f.removed}`)
            .join('')}
          {' → '}剩 {session.fetchedCount - session.filterStats.reduce((s, f) => s + f.removed, 0)} 条
        </div>
      )}

      <div class="echo-actions">
        <button class="btn primary" disabled={!props.dirty || props.busy} onClick={props.onResearch}>
          按修改重搜
        </button>
        <button class="btn" disabled={props.busy} onClick={props.onReparse} title="把原句重新交给 LLM 理解">
          重新理解原句
        </button>
      </div>
    </section>
  );
}
