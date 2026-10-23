// 画像：同步订阅与喜欢的视频，查看 / 编辑兴趣簇。

import { useMemo, useState } from 'preact/hooks';
import { editCluster, moveChannel, unassignedChannels } from '../../core/clusters';
import { estimateSyncCost } from '../../core/quota';
import { formatRelative } from '../../core/time';
import type { ChannelInfo, InterestCluster, Nature } from '../../core/types';
import type { AppError } from '../../services/errors';
import { generateClusters, saveClusters, syncProfile } from '../../services/profile-service';
import { newId, stores } from '../../services/repo';
import { clearTakeout, importTakeout } from '../../services/takeout-service';
import { appCtx, asAppError, useStore } from '../shared/app';
import { ErrorBox, Notice, Spinner } from '../shared/components';

const splitTerms = (s: string) =>
  s
    .split(/[,，、;；]/)
    .map((x) => x.trim())
    .filter(Boolean);

function ClusterCard({
  cluster,
  clusters,
  channelMap,
  onChange,
  onDelete,
}: {
  cluster: InterestCluster;
  clusters: InterestCluster[];
  channelMap: Map<string, ChannelInfo>;
  onChange: (next: InterestCluster[]) => void;
  onDelete: () => void;
}) {
  const ctx = appCtx();
  const [open, setOpen] = useState(false);
  const patch = (p: Partial<InterestCluster>) => onChange(editCluster(clusters, cluster.id, p, ctx.now()));
  return (
    <li class="cluster" data-cluster={cluster.name}>
      <div class="cluster-head">
        <input class="input cluster-name" value={cluster.name} onChange={(e) => patch({ name: e.currentTarget.value.trim() || cluster.name })} />
        {cluster.locked && <span class="badge" title="你编辑过，重新生成时会保留">已锁定</span>}
        <button class="icon-btn" title="删除兴趣簇" onClick={onDelete}>
          ×
        </button>
      </div>
      <input class="input" value={cluster.description} placeholder="一句话描述" onChange={(e) => patch({ description: e.currentTarget.value })} />
      <label class="field">
        关键词（用于匹配视频标题）
        <input class="input" value={cluster.keywords.join('、')} onChange={(e) => patch({ keywords: splitTerms(e.currentTarget.value) })} />
      </label>
      <label class="field-row">
        <span>权重</span>
        <input type="range" min={0.2} max={2} step={0.1} value={cluster.weight} onChange={(e) => patch({ weight: Number(e.currentTarget.value) })} />
        <span class="num">{cluster.weight.toFixed(1)}</span>
        <span class="muted small">（评分会自动微调）</span>
      </label>
      <label class="field-row">
        <span>倾向</span>
        <select class="input small" data-testid="cluster-nature" value={cluster.nature ?? 'other'} onChange={(e) => patch({ nature: e.currentTarget.value as Nature })}>
          <option value="learning">学习</option>
          <option value="entertainment">娱乐</option>
          <option value="other">说不清</option>
        </select>
        <span class="muted small">（用于判定观看记录是学习还是娱乐）</span>
      </label>
      <button class="btn link small" onClick={() => setOpen(!open)}>
        {open ? '收起频道' : `频道（${cluster.channelIds.length}）`}
      </button>
      {open && (
        <ul class="channel-list">
          {cluster.channelIds.map((id) => (
            <li>
              <span>{channelMap.get(id)?.title ?? id}</span>
              <select class="input small" value={cluster.id} onChange={(e) => onChange(moveChannel(clusters, id, e.currentTarget.value || undefined, ctx.now()))}>
                {clusters.map((c) => (
                  <option value={c.id}>{c.name}</option>
                ))}
                <option value="">（移出所有簇）</option>
              </select>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function ProfileView() {
  const ctx = appCtx();
  const profile = useStore(stores.profile);
  const state = useStore(stores.clusters);
  const settings = useStore(stores.settings);
  const [busy, setBusy] = useState<string>();
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<AppError>();
  const [done, setDone] = useState<string>();

  const channels = useMemo(() => [...(profile?.subscriptions ?? []), ...(profile?.likedChannels ?? [])], [profile]);
  const channelMap = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);
  const clusters = state?.clusters ?? [];
  const unassigned = useMemo(() => unassignedChannels(profile?.subscriptions ?? [], clusters), [profile, clusters]);
  const cost = estimateSyncCost(profile?.syncedAt ? profile.subscriptions.length : undefined, settings?.profile.likedVideosMax ?? 300);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setError(undefined);
    setDone(undefined);
    try {
      setDone(await fn());
    } catch (e) {
      setError(await asAppError(e));
    } finally {
      setBusy(undefined);
      setProgress(undefined);
    }
  };

  const save = (next: InterestCluster[]) => void saveClusters(ctx, next).catch(async (e) => setError(await asAppError(e)));

  return (
    <div class="profile">
      <section class="panel">
        <h2>同步画像</h2>
        <p class="muted small">
          画像只来自你的订阅列表、"喜欢的视频"（YouTube API 不提供观看历史）。只读，不会改动你的 YouTube 账号。
        </p>
        {profile?.syncedAt ? (
          <p>
            上次同步：{formatRelative(profile.syncedAt, ctx.now())} · {profile.subscriptions.length} 个订阅 · {profile.likedVideos.length} 个喜欢的视频
          </p>
        ) : (
          <p>还没有同步。</p>
        )}
        <button
          class="btn primary"
          disabled={!!busy}
          onClick={() =>
            run('sync', async () => {
              const r = await syncProfile(ctx, (p) => setProgress(p.detail));
              return `同步完成：${r.profile.subscriptions.length} 个订阅、${r.profile.likedVideos.length} 个喜欢的视频，消耗 ${r.unitsSpent} units`;
            })
          }
        >
          同步订阅与喜欢的视频
        </button>
        <span class="muted small"> 预计约 {cost.units} units（{cost.detail}）</span>
      </section>

      <section class="panel">
        <h2>兴趣簇</h2>
        <p class="muted small">
          兴趣簇用于"个人品味"排序与消歧。生成时只把频道名、简介片段、YouTube 主题分类和喜欢的视频标题发给 LLM（频道用本地编号，不发送频道 ID）。你编辑过的簇会被锁定，重新生成时保留。
        </p>
        <div class="row wrap">
          <button
            class="btn"
            disabled={!!busy || !profile?.syncedAt}
            onClick={() =>
              run('cluster', async () => {
                const cs = await generateClusters(ctx);
                return `已生成 ${cs.length} 个兴趣簇`;
              })
            }
          >
            {clusters.length ? '重新生成（保留已锁定的簇）' : '生成兴趣簇'}
          </button>
          <button
            class="btn"
            disabled={!!busy}
            onClick={() =>
              save([
                ...clusters,
                { id: newId('k'), name: '新的兴趣', description: '', keywords: [], channelIds: [], weight: 1, locked: true, source: 'user', updatedAt: ctx.now() },
              ])
            }
          >
            新建兴趣簇
          </button>
        </div>
        {busy && <Spinner label={progress ?? (busy === 'sync' ? '正在同步…' : '正在请 LLM 归纳兴趣簇…')} />}
        {error && <ErrorBox error={error} onClose={() => setError(undefined)} />}
        {done && <Notice kind="ok" onClose={() => setDone(undefined)}>{done}</Notice>}
        <ul class="clusters">
          {clusters.map((c) => (
            <ClusterCard key={c.id} cluster={c} clusters={clusters} channelMap={channelMap} onChange={save} onDelete={() => save(clusters.filter((x) => x.id !== c.id))} />
          ))}
        </ul>
        {clusters.length > 0 && unassigned.length > 0 && (
          <details class="unassigned">
            <summary>未归类的订阅频道（{unassigned.length}）</summary>
            <ul class="channel-list">
              {unassigned.map((ch) => (
                <li>
                  <span>{ch.title}</span>
                  <select class="input small" value="" onChange={(e) => e.currentTarget.value && save(moveChannel(clusters, ch.id, e.currentTarget.value, ctx.now()))}>
                    <option value="">归入…</option>
                    {clusters.map((c) => (
                      <option value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <TakeoutSection />
    </div>
  );
}

/** 可选：导入 Google Takeout 观看历史，补充画像（只在本机解析，不调用任何 API） */
function TakeoutSection() {
  const ctx = appCtx();
  const takeout = useStore(stores.takeout);
  const [error, setError] = useState<AppError>();
  const [busy, setBusy] = useState(false);
  return (
    <section class="panel">
      <h2>导入 YouTube 观看历史（可选）</h2>
      <p class="muted small">
        YouTube API 不提供观看历史。你可以在 <code>takeout.google.com</code> 只勾选"YouTube 和 YouTube Music → 历史记录"、格式选 JSON 导出，再在这里选择{' '}
        <code>watch-history.json</code>。文件只在本机解析，保存的是按频道的观看次数和最近 300 条，用于"个人品味"排序和生成兴趣簇（只把频道名和次数发给 LLM）。
      </p>
      {takeout && (
        <p class="small" data-testid="takeout-status">
          已导入 {takeout.totalEntries} 条（{takeout.firstWatched?.slice(0, 10)} ~ {takeout.lastWatched?.slice(0, 10)}），涉及 {takeout.channels.length} 个频道；跳过广告{' '}
          {takeout.skipped.ads} 条、已删除视频 {takeout.skipped.noVideo} 条。
        </p>
      )}
      <div class="row wrap">
        <label class="btn">
          {busy ? '正在解析…' : takeout ? '重新导入' : '选择 watch-history.json'}
          <input
            type="file"
            accept=".json,application/json"
            hidden
            data-testid="takeout-file"
            onChange={async (e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (!file) return;
              setBusy(true);
              setError(undefined);
              try {
                await importTakeout(ctx, await file.text());
              } catch (err) {
                setError(await asAppError(err));
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
        {takeout && (
          <button class="btn link" onClick={() => void clearTakeout(ctx)}>
            删除导入的数据
          </button>
        )}
      </div>
      {error && <ErrorBox error={error} onClose={() => setError(undefined)} />}
    </section>
  );
}
