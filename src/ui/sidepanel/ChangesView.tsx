// 改进记录：因为你的打分，系统改了什么（诚实：只是参数与提示，没有训练任何模型）。

import { DEFAULT_FACTOR_WEIGHTS } from '../../config/defaults';
import { formatSigned } from '../../core/format';
import { ALL_FACTORS } from '../../core/ranking';
import { formatRelative } from '../../core/time';
import { FACTOR_LABELS, KIND_LABELS, type Attribution } from '../../core/types';
import { deleteCorrection, revertAdjustment, setCorrectionActive } from '../../services/rating-service';
import { stores } from '../../services/repo';
import { appCtx, useStore } from '../shared/app';
import { ChangeList } from '../shared/ChangeList';

const ATTR_LABELS: Record<Attribution, string> = {
  understanding: '理解错了',
  retrieval: '找错/排错',
  none: '未归因',
  pending: '待归因',
};

export function ChangesView() {
  const ctx = appCtx();
  const model = useStore(stores.rankingModel);
  const adjustments = useStore(stores.adjustments);
  const corrections = useStore(stores.corrections);
  const now = ctx.now();
  const prefs = Object.entries(model?.channelPrefs ?? {})
    .filter(([, p]) => p.value !== 0)
    .sort((a, b) => Math.abs(b[1].value) - Math.abs(a[1].value));

  return (
    <div class="changes">
      <p class="muted small">
        这里是你的评分让系统做出的全部调整：排序因子权重、频道偏好、兴趣簇权重，以及记下的"理解纠正"（之后解析口令时会作为参考发给 LLM）。没有任何模型被重新训练；每一条都可以撤销。
      </p>

      <section class="panel">
        <h2>排序因子权重</h2>
        <table class="weights">
          <thead>
            <tr>
              <th>因子</th>
              <th class="num">当前</th>
              <th class="num">默认</th>
              <th class="num">变化</th>
            </tr>
          </thead>
          <tbody>
            {ALL_FACTORS.map((f) => {
              const cur = model?.weights[f] ?? DEFAULT_FACTOR_WEIGHTS[f];
              const diff = cur - DEFAULT_FACTOR_WEIGHTS[f];
              return (
                <tr>
                  <td>{FACTOR_LABELS[f]}</td>
                  <td class="num">{cur.toFixed(3)}</td>
                  <td class="num muted">{DEFAULT_FACTOR_WEIGHTS[f].toFixed(3)}</td>
                  <td class={`num ${diff > 0.0005 ? 'up' : diff < -0.0005 ? 'down' : 'muted'}`}>{Math.abs(diff) < 0.0005 ? '—' : formatSigned(diff, 3)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {prefs.length > 0 && (
        <section class="panel">
          <h2>频道偏好</h2>
          <ul class="prefs">
            {prefs.map(([id, p]) => (
              <li>
                <span>{p.title || id}</span>
                <span class={`num ${p.value > 0 ? 'up' : 'down'}`}>{formatSigned(p.value)}</span>
                <span class="muted small">（{p.ratings} 次评分）</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section class="panel">
        <h2>调整记录</h2>
        {!adjustments?.length && <p class="muted">还没有。给结果打分后，这里会列出系统据此改了什么。</p>}
        <ul class="adjust-log">
          {(adjustments ?? []).map((a) => (
            <li class={a.reverted ? 'reverted' : ''}>
              <div class="adj-head">
                <span class="muted small">{formatRelative(a.at, now)}</span> 《{a.trigger.title}》{a.trigger.rating} 分 · {ATTR_LABELS[a.trigger.attribution]}
                {a.reverted ? (
                  <span class="badge">已撤销</span>
                ) : (
                  a.changes.some((c) => c.type !== 'none') && (
                    <button class="btn link small" onClick={() => void revertAdjustment(ctx, a.id)}>
                      撤销
                    </button>
                  )
                )}
              </div>
              <div class="muted small">口令：{a.trigger.utterance}</div>
              <ChangeList changes={a.changes} />
            </li>
          ))}
        </ul>
      </section>

      <section class="panel">
        <h2>理解纠正</h2>
        {!corrections?.length && <p class="muted">还没有。低分时选"理解错了"会记在这里。</p>}
        <ul class="corrections">
          {(corrections ?? []).map((c) => (
            <li class={c.active ? '' : 'inactive'}>
              <div>
                原句「{c.utterance}」{c.constraint ? `中的${KIND_LABELS[c.constraint.kind]}「${c.constraint.span || c.constraint.label}」理解有误` : '整体理解有误'}
              </div>
              {c.note && <div class="muted small">你的说明：{c.note}</div>}
              <label class="inline small">
                <input type="checkbox" checked={c.active} onChange={(e) => void setCorrectionActive(ctx, c.id, e.currentTarget.checked)} />
                解析口令时参考
              </label>
              <button class="btn link small" onClick={() => void deleteCorrection(ctx, c.id)}>
                删除
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
