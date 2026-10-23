// 结果卡：不点开也能判断值不值得看；1–10 打分；低分归因；展示"因为这次打分系统改了什么"。

import { useState } from 'preact/hooks';
import { formatViews } from '../../core/format';
import { needsAttribution } from '../../core/learning';
import { scoreBreakdown } from '../../core/ranking';
import { formatDuration, formatRelative } from '../../core/time';
import { KIND_LABELS, type Adjustment, type RankedItem, type RankingModel, type RatingRecord, type SearchSession } from '../../core/types';
import { ChangeList } from '../shared/ChangeList';

export interface ResultActions {
  onRate: (videoId: string, rating: number) => void;
  onAttribute: (videoId: string, attribution: 'understanding' | 'retrieval' | 'none', aspect?: string, note?: string) => void;
  onRevert: (adjustmentId: string) => void;
  onReparseWithCorrection: () => void;
}

function openVideo(id: string) {
  // 在当前标签页打开（侧边栏所在窗口的活动标签页）
  void chrome.tabs.update({ url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` });
}

function RatingBar({ value, onRate }: { value: number | undefined; onRate: (n: number) => void }) {
  return (
    <div class="rating" role="group" aria-label="打分 1 到 10">
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
        <button class={`rate-btn${value === n ? ' on' : ''}${n <= 5 ? ' low' : ''}`} title={`${n} 分`} onClick={() => onRate(n)} data-rate={n}>
          {n}
        </button>
      ))}
    </div>
  );
}

function AttributionPrompt({ session, record, actions }: { session: SearchSession; record: RatingRecord; actions: ResultActions }) {
  const [mode, setMode] = useState<'choose' | 'understanding'>('choose');
  const [aspect, setAspect] = useState('whole');
  const [note, setNote] = useState('');
  if (mode === 'understanding') {
    return (
      <div class="attrib">
        <div>哪里理解错了？</div>
        <select class="input" value={aspect} onChange={(e) => setAspect(e.currentTarget.value)}>
          <option value="whole">整体意思理解错了</option>
          {session.intent.constraints.map((c) => (
            <option value={c.id}>
              {KIND_LABELS[c.kind]}：{c.span ? `「${c.span}」→ ` : ''}
              {c.label}
            </option>
          ))}
        </select>
        <textarea class="input" rows={2} placeholder="你其实想要的是……（可选，会作为纠正发给 LLM）" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
        <div class="row">
          <button class="btn primary small" onClick={() => actions.onAttribute(record.videoId, 'understanding', aspect, note)}>
            记下这条纠正
          </button>
          <button class="btn small" onClick={() => setMode('choose')}>
            返回
          </button>
        </div>
      </div>
    );
  }
  return (
    <div class="attrib">
      <div>你给了 {record.rating} 分。主要是哪里不对？</div>
      <div class="row wrap">
        <button class="btn small" data-attr="understanding" onClick={() => setMode('understanding')}>
          理解错了我的意思
        </button>
        <button class="btn small" data-attr="retrieval" onClick={() => actions.onAttribute(record.videoId, 'retrieval')}>
          意思对，但这条找错/排错了
        </button>
        <button class="btn small link" data-attr="none" onClick={() => actions.onAttribute(record.videoId, 'none')}>
          不归因
        </button>
      </div>
    </div>
  );
}

function AdjustmentBox({ adj, actions }: { adj: Adjustment; actions: ResultActions }) {
  const hasCorrection = adj.changes.some((c) => c.type === 'correction');
  return (
    <div class={`adjust${adj.reverted ? ' reverted' : ''}`} data-testid="adjustment">
      <div class="adjust-title">{adj.reverted ? '这次调整已撤销' : '因为这次打分，系统改了：'}</div>
      <ChangeList changes={adj.changes} />
      {!adj.reverted && (
        <div class="row wrap">
          {adj.changes.some((c) => c.type !== 'none') && (
            <button class="btn link small" onClick={() => actions.onRevert(adj.id)}>
              撤销这次调整
            </button>
          )}
          {hasCorrection && (
            <button class="btn link small" onClick={actions.onReparseWithCorrection}>
              按纠正重新理解并搜索
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ResultCard(props: {
  item: RankedItem;
  index: number;
  delta: number | undefined;
  session: SearchSession;
  record: RatingRecord | undefined;
  adjustment: Adjustment | undefined;
  model: RankingModel | undefined;
  hasProfile: boolean;
  subscribed: boolean;
  now: number;
  actions: ResultActions;
}) {
  const { item, record, session, actions } = props;
  const v = item.video;
  const [why, setWhy] = useState(false);
  const pending = record?.searchId === session.id && record.attribution === 'pending';
  return (
    <li class="card" data-video-id={v.id}>
      <div class="card-main">
        {v.thumbnailUrl && (
          <button class="thumb" onClick={() => openVideo(v.id)} title="在当前标签页打开">
            <img src={v.thumbnailUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />
            <span class="dur">{formatDuration(v.durationSec)}</span>
          </button>
        )}
        <div class="card-text">
          <a
            class="title"
            href={`https://www.youtube.com/watch?v=${v.id}`}
            onClick={(e) => {
              e.preventDefault();
              openVideo(v.id);
            }}
          >
            <span class="rank-no">{props.index + 1}.</span> {v.title}
            {props.delta ? <span class={`delta ${props.delta > 0 ? 'up' : 'down'}`}>{props.delta > 0 ? `↑${props.delta}` : `↓${-props.delta}`}</span> : null}
          </a>
          <div class="meta">
            <span class="channel">{v.channelTitle}</span>
            {props.subscribed && <span class="badge sub">已订阅</span>}
          </div>
          <div class="meta muted">
            {formatDuration(v.durationSec)} · {formatRelative(Date.parse(v.publishedAt), props.now)} · {formatViews(v.viewCount)}
          </div>
        </div>
      </div>
      {item.badges.length > 0 && (
        <div class="badges">
          {item.badges.map((b) => (
            <span class={`badge ${b.startsWith('✓') ? 'ok' : 'approx'}`}>{b}</span>
          ))}
        </div>
      )}
      <div class="reasons">
        <span class="reasons-title">为什么推给你：</span>
        <ul>
          {item.reasons.length ? item.reasons.map((r) => <li>{r}</li>) : <li class="muted">与检索词相关（没有更强的个人化理由）</li>}
        </ul>
      </div>
      {item.warnings.length > 0 && (
        <div class="warnings">
          {item.warnings.map((w) => (
            <div>⚠ {w}</div>
          ))}
        </div>
      )}
      {v.description && <div class="desc">{v.description.slice(0, 140)}</div>}
      <div class="card-foot">
        <RatingBar value={record?.rating} onRate={(n) => actions.onRate(v.id, n)} />
        <button class="btn link small" onClick={() => setWhy(!why)}>
          {why ? '收起' : '排序明细'}
        </button>
      </div>
      {why && props.model && (
        <table class="breakdown">
          <tbody>
            {scoreBreakdown(item, props.model, session.plan, props.hasProfile).map((b) => (
              <tr>
                <td>{b.label}</td>
                <td class="num">权重 {b.weight.toFixed(2)}</td>
                <td class="num">× {b.value.toFixed(2)}</td>
                <td class="num">= {b.contribution.toFixed(3)}</td>
              </tr>
            ))}
            <tr class="total">
              <td>总分（含软约束与偏好加成）</td>
              <td colSpan={3} class="num">
                {item.score.toFixed(3)}
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {pending && record && <AttributionPrompt session={session} record={record} actions={actions} />}
      {record && !pending && record.searchId === session.id && props.adjustment && <AdjustmentBox adj={props.adjustment} actions={actions} />}
      {record && record.searchId === session.id && !pending && !props.adjustment && needsAttribution(record.rating) && <div class="muted small">已记录。</div>}
    </li>
  );
}
