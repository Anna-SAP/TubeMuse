// 发现：X 上与兴趣相关的热点（带原文链接，一键转成找片）+ 每周新博主推荐（只打开频道，不订阅）。

import { useEffect, useState } from 'preact/hooks';
import { channelUrl } from '../../core/discovery';
import { formatCount } from '../../core/format';
import { formatClock, formatRelative } from '../../core/time';
import type { CreatorRecommendation, Hotspot } from '../../core/types';
import { currentWeekKey, dismissCreator, runDiscovery } from '../../services/discovery-service';
import type { AppError } from '../../services/errors';
import { hotspotsFresh, refreshHotspots } from '../../services/hotspot-service';
import { stores } from '../../services/repo';
import { appCtx, asAppError, useStore, useXSpend } from '../shared/app';
import { ErrorBox, Notice, Spinner } from '../shared/components';
import { openInCurrentTab } from '../shared/download';

function HotspotCard({ h, onSearch }: { h: Hotspot; onSearch: (u: string) => void }) {
  const ctx = appCtx();
  return (
    <li class="hotspot" data-testid="hotspot">
      <div class="hotspot-title">
        <strong>{h.title}</strong> <span class="badge">{h.topic}</span>
      </div>
      <p class="small">{h.summary}</p>
      <ul class="hotspot-posts">
        {h.posts.map((p) => (
          <li>
            <span class="muted small">
              ❤ {formatCount(p.likes)} · 🔁 {formatCount(p.reposts)} · {formatRelative(Date.parse(p.createdAt), ctx.now())}
            </span>{' '}
            <span class="post-text">{p.text.slice(0, 90)}</span>{' '}
            <a href={p.url} target="_blank" rel="noopener noreferrer" data-testid="post-link">
              原文 ↗
            </a>
          </li>
        ))}
      </ul>
      <button class="btn small primary" data-testid="hotspot-search" onClick={() => onSearch(h.utterance)}>
        用这句找片：「{h.utterance}」
      </button>
    </li>
  );
}

function CreatorCard({ r, onDismiss }: { r: CreatorRecommendation; onDismiss: () => void }) {
  return (
    <li class="creator" data-testid="creator">
      <div class="row">
        <strong class="creator-name">{r.title}</strong>
        {r.subscriberCount !== undefined && <span class="muted small">{formatCount(r.subscriberCount)} 订阅</span>}
        <span class="badge">{r.topic}</span>
      </div>
      <ul class="small reasons-list">
        {r.reasons.map((x) => (
          <li>{x}</li>
        ))}
      </ul>
      <div class="muted small">最近的视频：</div>
      <ol class="small recent-videos">
        {r.recentVideos.map((v) => (
          <li>
            <a
              href={`https://www.youtube.com/watch?v=${v.videoId}`}
              onClick={(e) => {
                e.preventDefault();
                openInCurrentTab(v.videoId);
              }}
            >
              {v.title}
            </a>
          </li>
        ))}
      </ol>
      <div class="row">
        <button class="btn small" data-testid="open-channel" onClick={() => void chrome.tabs.update({ url: channelUrl(r.channelId) })}>
          打开频道
        </button>
        <button class="btn link small" onClick={onDismiss}>
          不感兴趣
        </button>
      </div>
    </li>
  );
}

export function DiscoverView({ onSearch }: { onSearch: (utterance: string) => void }) {
  const ctx = appCtx();
  const settings = useStore(stores.settings);
  const secrets = useStore(stores.secrets);
  const hotspots = useStore(stores.hotspots);
  const discovery = useStore(stores.discovery);
  const x = useXSpend();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<AppError>();
  const [autoTried, setAutoTried] = useState(false);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(await asAppError(e));
    } finally {
      setBusy(undefined);
    }
  };

  // 打开"发现"页且缓存过期时自动刷新一次（设置里可关）
  useEffect(() => {
    if (!settings || !secrets || autoTried || hotspots === undefined) return;
    setAutoTried(true);
    if (settings.x.enabled && settings.x.autoRefresh && secrets.xBearerToken && !hotspotsFresh(hotspots, settings.x.cacheHours, ctx.now())) {
      void run('hot', () => refreshHotspots(ctx));
    }
  }, [settings, secrets, hotspots]);

  if (!settings || !secrets) return null;
  const weekKey = currentWeekKey(ctx, settings.weekly.weekday);
  const week = discovery?.weeks[weekKey];
  const blocked = x?.blocked;

  return (
    <div class="discover">
      {error && <ErrorBox error={error} onClose={() => setError(undefined)} />}
      <section class="panel">
        <div class="row">
          <h2>X 热点</h2>
          {x && (
            <span class={`small ${x.warn ? 'warn-text' : 'muted'}`} data-testid="x-budget-line">
              今日花费 ${x.spentUsd.toFixed(3)} / ${x.budgetUsd.toFixed(2)}
            </span>
          )}
        </div>
        {!settings.x.enabled ? (
          <p class="muted">X 热点已在设置中关闭。</p>
        ) : !secrets.xBearerToken ? (
          <Notice kind="info">
            填写 X 的 Bearer Token 后，这里会显示与你兴趣相关的热点（每条附原文链接，一键转成找片）。
            <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
              去设置
            </button>
          </Notice>
        ) : (
          <>
            <p class="muted small">
              用你的兴趣簇关键词检索 X 上最近 {24} 小时的高互动帖子，再整理成 {settings.x.minItems}–{settings.x.maxItems} 条。按读到的帖子数计费（$0.005/条，同一条当天重复读取不再计费），
              缓存 {settings.x.cacheHours} 小时；每日上限 ${settings.x.dailyBudgetUsd.toFixed(2)}，按 UTC 日计（你的本地时间 {x ? formatClock(x.resetAt) : ''} 重置）。
            </p>
            {x?.warn && !x.exhausted && <Notice kind="warn">今天的 X 预算已用 {Math.round(x.ratio * 100)}%，快到上限了。</Notice>}
            {x?.exhausted && <Notice kind="warn">今天的 X 预算已用完，不会再发请求。</Notice>}
            {blocked && (
              <Notice kind="warn">
                今天的 X 请求已停止：{blocked.reason}
                <button class="btn link small" onClick={() => void run('hot', () => refreshHotspots(ctx, { force: true, retryAfterBlock: true }))}>
                  我已处理，重试
                </button>
              </Notice>
            )}
            <div class="row wrap">
              <button class="btn" disabled={!!busy || !!x?.exhausted} onClick={() => void run('hot', () => refreshHotspots(ctx, { force: true }))}>
                刷新热点
              </button>
              {hotspots && <span class="muted small">更新于 {formatRelative(hotspots.fetchedAt, ctx.now())}{hotspots.postsRead ? ` · 读了 ${hotspots.postsRead} 条帖子，花费 $${hotspots.spentUsd.toFixed(3)}` : ''}</span>}
            </div>
            {busy === 'hot' && <Spinner label="正在读取 X 帖子并整理热点…" />}
            {hotspots?.notes.length ? (
              <Notice kind={hotspots.partial ? 'warn' : 'info'}>
                <ul class="small" data-testid="hotspot-notes">
                  {hotspots.notes.map((n) => (
                    <li>{n}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}
            <ul class="hotspot-list">
              {(hotspots?.items ?? []).map((h) => (
                <HotspotCard key={h.id} h={h} onSearch={onSearch} />
              ))}
            </ul>
          </>
        )}
      </section>

      <section class="panel">
        <div class="row">
          <h2>本周新博主</h2>
          <span class="muted small" data-testid="discovery-quota">
            本周已用 search {week?.searchCalls ?? 0}/{settings.discovery.weeklySearchCalls} 次
          </span>
        </div>
        {!settings.discovery.enabled ? (
          <p class="muted">新博主发现已在设置中关闭。</p>
        ) : (
          <>
            <p class="muted small">
              每周一次，从你的兴趣出发找最近活跃、你还没订阅的频道，最多 {Math.min(5, settings.discovery.maxChannels)} 个。只提供"打开频道"，不会替你订阅。
            </p>
            <div class="row wrap">
              <button
                class="btn"
                disabled={!!busy || (week?.searchCalls ?? 0) >= settings.discovery.weeklySearchCalls}
                onClick={() => void run('disc', () => runDiscovery(ctx))}
              >
                {week?.generatedAt ? '再找一次（用本周剩余次数）' : '现在发现'}
              </button>
              {week?.generatedAt && <span class="muted small">更新于 {formatRelative(week.generatedAt, ctx.now())}</span>}
            </div>
            {busy === 'disc' && <Spinner label="正在找新博主…" />}
            {week?.notes.length ? (
              <ul class="muted small">
                {week.notes.map((n) => (
                  <li>{n}</li>
                ))}
              </ul>
            ) : null}
            <ul class="creator-list">
              {(week?.recommendations ?? [])
                .filter((r) => !discovery?.dismissed[r.channelId])
                .map((r) => (
                  <CreatorCard key={r.channelId} r={r} onDismiss={() => void dismissCreator(ctx, r.channelId, r.title)} />
                ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
