// 找片：一句话 → 回显 → 结果 → 打分。

import { useEffect, useMemo, useState } from 'preact/hooks';
import type { QuotaSnapshot } from '../../core/quota';
import type { Intent, RankedItem, SearchPlan, SearchSession } from '../../core/types';
import type { AppError } from '../../services/errors';
import { parseUtterance } from '../../services/intent-service';
import { attribute, rate, revertAdjustment } from '../../services/rating-service';
import { stores } from '../../services/repo';
import { latestSession, previewPlan, rerankSession, runSearch } from '../../services/search-service';
import { appCtx, asAppError, useStore } from '../shared/app';
import { ErrorBox, Notice, Spinner } from '../shared/components';
import { Echo } from './Echo';
import { ResultCard, type ResultActions } from './Results';
import { VoiceInput } from './Voice';

type Phase = 'idle' | 'parsing' | 'searching';

export function FindView({ quota, prefill }: { quota: QuotaSnapshot | undefined; prefill?: { text: string; n: number; autoSubmit?: boolean } }) {
  const ctx = appCtx();
  const settings = useStore(stores.settings);
  const ratings = useStore(stores.ratings);
  const adjustments = useStore(stores.adjustments);
  const model = useStore(stores.rankingModel);
  const profile = useStore(stores.profile);
  const clusterState = useStore(stores.clusters);

  const [text, setText] = useState('');
  const [voiceLang, setVoiceLang] = useState<string>();
  const [phase, setPhase] = useState<Phase>('idle');
  const [intent, setIntent] = useState<Intent>();
  const [plan, setPlan] = useState<SearchPlan>();
  const [dirty, setDirty] = useState(false);
  const [session, setSession] = useState<SearchSession>();
  const [ranked, setRanked] = useState<RankedItem[]>();
  const [deltas, setDeltas] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<AppError>();
  const [confirm, setConfirm] = useState<{ reason: string; maxQueries: number; intent: Intent }>();

  // 提醒横幅里的"找片口令"台阶：只填进输入框，由你决定要不要搜
  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    // 来自 X 热点的"一键找片"：你点了按钮，直接发起
    if (prefill.autoSubmit) void submit(prefill.text);
  }, [prefill]);

  // 恢复上一次的结果（保持当时的顺序）
  useEffect(() => {
    void latestSession(ctx).then((r) => {
      if (!r) return;
      setSession(r.session);
      setRanked(r.ranked);
      setIntent(r.session.intent);
      setText(r.session.utterance);
    });
  }, []);

  useEffect(() => {
    if (!intent) return setPlan(undefined);
    let alive = true;
    void previewPlan(ctx, intent).then((p) => alive && setPlan(p));
    return () => {
      alive = false;
    };
  }, [intent, profile, settings]);

  const fail = async (e: unknown) => {
    setError(await asAppError(e));
    setPhase('idle');
  };

  async function search(it: Intent, reduceTo?: number) {
    setError(undefined);
    setConfirm(undefined);
    // 新结果到来前不显示旧结果，避免它们挂在新的回显下面造成误解
    setSession(undefined);
    setRanked(undefined);
    setPhase('searching');
    try {
      const out = await runSearch(ctx, reduceTo ? { intent: it, reduceTo } : { intent: it });
      if (out.kind === 'confirm') {
        setConfirm({ reason: out.reason, maxQueries: out.maxQueries, intent: it });
        setPhase('idle');
        return;
      }
      setSession(out.session);
      setRanked(out.ranked);
      setDeltas({});
      setExpanded(false);
      setDirty(false);
      setPhase('idle');
    } catch (e) {
      await fail(e);
    }
  }

  async function submit(utterance: string) {
    setError(undefined);
    setConfirm(undefined);
    setSession(undefined);
    setRanked(undefined);
    setIntent(undefined);
    setPhase('parsing');
    try {
      const it = await parseUtterance(ctx, utterance);
      setIntent(it);
      setDirty(false);
      await search(it);
    } catch (e) {
      await fail(e);
    }
  }

  async function rerank() {
    if (!session) return;
    const before = session.rankedIds;
    const r = await rerankSession(ctx, session.id);
    if (!r) return;
    const d: Record<string, number> = {};
    r.session.rankedIds.forEach((id, i) => {
      const b = before.indexOf(id);
      if (b >= 0 && b !== i) d[id] = b - i;
    });
    setSession(r.session);
    setRanked(r.ranked);
    setDeltas(d);
  }

  const actions: ResultActions = {
    onRate: (videoId, rating) => {
      if (!session) return;
      rate(ctx, session.id, videoId, rating).catch(fail);
    },
    onAttribute: (videoId, attribution, aspect, note) => {
      attribute(ctx, { videoId, attribution, ...(aspect ? { aspect } : {}), ...(note ? { note } : {}) }).catch(fail);
    },
    onRevert: (id) => {
      revertAdjustment(ctx, id).catch(fail);
    },
    onReparseWithCorrection: () => {
      if (session) void submit(session.utterance);
    },
  };

  const subscribed = useMemo(() => new Set((profile?.subscriptions ?? []).map((s) => s.id)), [profile]);
  const hasProfile = !!profile?.syncedAt || (clusterState?.clusters.length ?? 0) > 0;
  const shownCount = session ? (expanded ? Math.max(settings?.search.expandedResults ?? 20, session.plan.resultCount) : session.plan.resultCount) : 0;
  const shown = (ranked ?? []).slice(0, shownCount);
  const modelChanged = !!session && !!model && model.version !== session.modelVersion;
  const busy = phase !== 'idle';
  const lang = voiceLang ?? settings?.voice.lang ?? 'zh-CN';

  return (
    <div class="find">
      <form
        class="query-box"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void submit(text);
        }}
      >
        <textarea
          class="input query"
          rows={2}
          placeholder="一句话说想看什么，例如：帮我找两天内最新的 AI 技术科普视频"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              if (!busy) void submit(text);
            }
          }}
        />
        <div class="query-actions">
          <VoiceInput lang={lang} preferLocal={settings?.voice.preferLocal ?? true} onText={(t) => setText(t)} />
          <select class="input lang" value={lang} onChange={(e) => setVoiceLang(e.currentTarget.value)} title="语音识别语言">
            <option value="zh-CN">中文</option>
            <option value="en-US">English</option>
          </select>
          <button class="btn primary" type="submit" disabled={busy || !text.trim()}>
            找片
          </button>
        </div>
      </form>

      {phase === 'parsing' && <Spinner label="正在理解你的口令…" />}
      {phase === 'searching' && <Spinner label="正在搜索并排序…" />}
      {error && <ErrorBox error={error} onClose={() => setError(undefined)} />}
      {confirm && (
        <Notice kind="warn">
          {confirm.reason}。要只用前 {confirm.maxQueries} 条检索词继续吗？
          <div class="row">
            <button class="btn primary small" onClick={() => void search(confirm.intent, confirm.maxQueries)}>
              用 {confirm.maxQueries} 次继续
            </button>
            <button class="btn small" onClick={() => setConfirm(undefined)}>
              取消
            </button>
          </div>
        </Notice>
      )}

      {intent && (
        <Echo
          intent={intent}
          plan={plan}
          session={session}
          quota={quota}
          dirty={dirty}
          busy={busy}
          now={ctx.now()}
          maxQueries={settings?.quota.searchCallsPerQuery ?? 3}
          onChange={(it) => {
            setIntent(it);
            setDirty(true);
          }}
          onResearch={() => intent && void search(intent)}
          onReparse={() => void submit(intent.utterance)}
        />
      )}

      {session && ranked && (
        <section class="results" aria-label="结果">
          {modelChanged && (
            <Notice kind="ok">
              排序参数已根据你的评分更新。
              <button class="btn link small" onClick={() => void rerank()}>
                按新偏好重排当前结果
              </button>
              （不消耗配额）
            </Notice>
          )}
          {ranked.length === 0 ? (
            <Notice kind="info">过滤后没有符合全部条件的视频。可以在上方回显里放宽某个约束（例如把它改成"只是偏好"），再点"按修改重搜"——只改过滤条件会命中缓存，不再消耗配额。</Notice>
          ) : (
            <ol class="cards">
              {shown.map((item, i) => {
                const record = ratings?.[item.video.id];
                const adj = record?.adjustmentId ? adjustments?.find((a) => a.id === record.adjustmentId) : undefined;
                return (
                  <ResultCard
                    key={item.video.id}
                    item={item}
                    index={i}
                    delta={deltas[item.video.id]}
                    session={session}
                    record={record}
                    adjustment={adj}
                    model={model}
                    hasProfile={hasProfile}
                    subscribed={subscribed.has(item.video.channelId)}
                    now={ctx.now()}
                    actions={actions}
                  />
                );
              })}
            </ol>
          )}
          {ranked.length > shown.length && !expanded && (
            <button class="btn wide" onClick={() => setExpanded(true)}>
              展开到 {Math.min(ranked.length, settings?.search.expandedResults ?? 20)} 条
            </button>
          )}
        </section>
      )}
    </div>
  );
}
