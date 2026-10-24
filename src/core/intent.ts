// LLM 原始输出 → Intent（规范化 + 覆盖守卫）。纯函数，可用固定样例单测。

import { applyCoverageGuards } from './coverage';
import { clip } from './text';
import { normalizeConstraint, normalizeQueries, rawConstraint, type RawConstraint } from './constraints';
import type { Constraint, Intent } from './types';

export class IntentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntentParseError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function assembleIntent(utterance: string, raw: unknown, now: number, correctionsUsed: number): Intent {
  if (!isRecord(raw)) throw new IntentParseError('LLM 返回的不是 JSON 对象');
  let seq = 0;
  const nextId = () => `c${++seq}`;

  const rawConstraints = Array.isArray(raw.constraints) ? raw.constraints : [];
  const constraints: Constraint[] = rawConstraints
    .filter(isRecord)
    .map((rc) => normalizeConstraint(rawConstraint({ ...(rc as Partial<RawConstraint>), kind: String(rc.kind ?? ''), span: String(rc.span ?? '') }), nextId()));

  const topic = typeof raw.topic === 'string' ? clip(raw.topic.trim(), 60) : '';
  if (!constraints.some((c) => c.kind === 'topic') && topic) {
    constraints.unshift(normalizeConstraint(rawConstraint({ kind: 'topic', span: utterance.includes(topic) ? topic : '', terms: [topic] }), nextId()));
  }

  const guarded = applyCoverageGuards(utterance, constraints, nextId);
  let queries = normalizeQueries(raw.queries);
  if (!queries.length) {
    const terms = guarded.constraints.filter((c) => c.kind === 'topic').flatMap((c) => c.params.terms ?? []);
    const q = clip(terms.length ? terms.join(' ') : topic || utterance, 100);
    queries = [{ q }];
    guarded.notes.push('LLM 没有给出检索词，已用主题词代替');
  }

  return {
    utterance,
    interpretation: typeof raw.interpretation === 'string' ? clip(raw.interpretation.trim(), 300) : '',
    topic,
    queries,
    constraints: guarded.constraints,
    correctionsUsed,
    parsedAt: now,
    notes: guarded.notes,
  };
}
