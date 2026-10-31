// 豆瓣：订阅条目的最新评论（读取公开 RSS）。只展示从 RSS 里取出的字段，不渲染订阅源里的 HTML。

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { doubanFresh, hueOf, ratingStars } from '../../core/douban';
import { formatRelative } from '../../core/time';
import type { DoubanFeed, DoubanReview } from '../../core/types';
import { addDoubanSubject, refreshDoubanFeed, removeDoubanSubject, selectDoubanSubject } from '../../services/douban-service';
import type { AppError } from '../../services/errors';
import { stores } from '../../services/repo';
import { appCtx, asAppError, useStore } from '../shared/app';
import { ErrorBox, Notice, Spinner } from '../shared/components';

const firstChar = (s: string) => Array.from(s.trim())[0] ?? '?';

function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 本地生成的封面：没有海报、或豆瓣拒绝外站加载海报时使用 */
function Cover({ title }: { title: string }) {
  return (
    <div class="db-cover" style={{ '--h': hueOf(title) }} aria-hidden="true">
      <span class="db-cover-char">{firstChar(title)}</span>
      <span class="db-cover-tag">豆瓣</span>
    </div>
  );
}

function Stars({ rating }: { rating: string }) {
  const n = ratingStars(rating);
  if (n === undefined) return <span class="badge">{rating}</span>;
  return (
    <span class="db-stars" title={`评价：${rating}`} aria-label={`评价：${rating}，${n} 星`}>
      {'★'.repeat(n)}
      <span class="db-stars-off">{'★'.repeat(5 - n)}</span>
    </span>
  );
}

function ReviewCard({ r, now }: { r: DoubanReview; now: number }) {
  const link = (children: ComponentChildren, cls: string) =>
    r.url ? (
      <a class={cls} href={r.url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span class={cls}>{children}</span>
    );
  return (
    <li class="db-review" data-testid="douban-review">
      <div class="db-byline">
        <span class="db-avatar" style={{ '--h': hueOf(r.author) }} aria-hidden="true">
          {firstChar(r.author)}
        </span>
        <span class="db-author">
          {r.authorUrl ? (
            <a href={r.authorUrl} target="_blank" rel="noopener noreferrer">
              {r.author}
            </a>
          ) : (
            r.author
          )}
        </span>
        <span class="muted small" title={r.publishedAt ? absoluteTime(r.publishedAt) : undefined}>
          {r.publishedAt ? formatRelative(r.publishedAt, now) : '时间未知'}
        </span>
        {r.rating && <Stars rating={r.rating} />}
      </div>
      {link(r.title, 'db-title')}
      {r.excerpt && (
        <blockquote class="db-excerpt" data-testid="douban-excerpt">
          {r.excerpt}
          {r.truncated ? '…' : ''}
        </blockquote>
      )}
      {r.url && (
        <div class="db-foot">
          <a class="db-more" href={r.url} target="_blank" rel="noopener noreferrer">
            读全文 ↗
          </a>
        </div>
      )}
    </li>
  );
}

function Hero({ feed, fetchedAt, busy, onRefresh, onRemove }: { feed: DoubanFeed; fetchedAt: number; busy: boolean; onRefresh: () => void; onRemove: () => void }) {
  const ctx = appCtx();
  // 记下加载失败的海报地址（而不是布尔值）：换条目后自然重置
  const [failedPoster, setFailedPoster] = useState<string>();
  const posterFailed = !!feed.posterUrl && failedPoster === feed.posterUrl;
  return (
    <section class="panel db-hero" data-testid="douban-hero">
      <div class="db-hero-main">
        {feed.posterUrl && !posterFailed ? (
          <img class="db-poster" src={feed.posterUrl} alt={`${feed.title} 海报`} referrerpolicy="no-referrer" decoding="async" onError={() => setFailedPoster(feed.posterUrl)} />
        ) : (
          <Cover title={feed.title} />
        )}
        <div class="db-hero-text">
          <div class="db-kind">{feed.kind} · 豆瓣最新评论</div>
          <h2 class="db-subject">{feed.title}</h2>
          <div class="muted small">
            {feed.reviews.length} 篇 · 更新于 {formatRelative(fetchedAt, ctx.now())}
          </div>
          <div class="row wrap db-actions">
            <button class="btn small" disabled={busy} onClick={onRefresh}>
              刷新
            </button>
            {feed.subjectUrl && (
              <a class="btn small" href={feed.subjectUrl} target="_blank" rel="noopener noreferrer">
                在豆瓣打开 ↗
              </a>
            )}
            <button class="btn link small" onClick={onRemove}>
              取消订阅
            </button>
          </div>
        </div>
      </div>
      {posterFailed && (
        <p class="muted small db-note" data-testid="douban-poster-note">
          海报没有加载出来：豆瓣不允许外站直接加载它的图片（防盗链），这里换成了本地生成的封面。扩展不会伪装成豆瓣页面去绕过这个限制。
        </p>
      )}
    </section>
  );
}

export function DoubanView() {
  const ctx = appCtx();
  const settings = useStore(stores.settings);
  const state = useStore(stores.douban);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<AppError>();
  const [draft, setDraft] = useState('');
  const autoTried = useRef(new Set<string>());

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(await asAppError(e));
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const subjects = state?.subjects ?? [];
  const selected = subjects.find((s) => s.id === state?.selected)?.id ?? subjects[0]?.id;
  const entry = selected ? state?.feeds[selected] : undefined;

  // 打开"豆瓣"页、且当前条目没有缓存或缓存已过期时自动读取一次（设置里可关）；每个条目每次打开侧边栏最多自动读一次
  useEffect(() => {
    if (!settings || !state || !selected || autoTried.current.has(selected)) return;
    if (!settings.douban.enabled || !settings.douban.autoRefresh || doubanFresh(entry, settings.douban.cacheMinutes, ctx.now())) return;
    autoTried.current.add(selected);
    void run(`load:${selected}`, () => refreshDoubanFeed(ctx, selected));
  }, [settings, state, selected]);

  if (!settings || !state) return null;
  if (!settings.douban.enabled) {
    return (
      <Notice kind="info">
        豆瓣评论已在设置中关闭。
        <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
          去设置
        </button>
      </Notice>
    );
  }

  const add = async () => {
    if (!draft.trim()) return;
    if (await run('add', () => addDoubanSubject(ctx, draft))) setDraft('');
  };

  return (
    <div class="douban">
      {error && <ErrorBox error={error} onClose={() => setError(undefined)} />}
      <section class="panel">
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input class="input db-input" data-testid="douban-input" placeholder="粘贴豆瓣条目链接或 ID" value={draft} onInput={(e) => setDraft(e.currentTarget.value)} />
          <button class="btn primary" type="submit" disabled={!!busy || !draft.trim()}>
            订阅
          </button>
        </form>
        <p class="muted small db-help">读取条目的公开评论 RSS：只连 www.douban.com，不登录、不带你的豆瓣 Cookie；缓存 {settings.douban.cacheMinutes} 分钟。</p>
        {subjects.length > 0 && (
          <div class="db-chips" aria-label="已订阅的条目">
            {subjects.map((s) => (
              <button
                aria-pressed={s.id === selected}
                class={`db-chip${s.id === selected ? ' on' : ''}`}
                data-testid="douban-chip"
                onClick={() => void selectDoubanSubject(ctx, s.id)}
              >
                {s.title ?? `条目 ${s.id}`}
              </button>
            ))}
          </div>
        )}
      </section>

      {!selected ? (
        <p class="muted">还没有订阅任何条目。粘贴一个豆瓣条目链接（电影、图书、音乐都行）开始。</p>
      ) : entry ? (
        <>
          <Hero
            feed={entry.feed}
            fetchedAt={entry.fetchedAt}
            busy={!!busy}
            onRefresh={() => void run(`load:${selected}`, () => refreshDoubanFeed(ctx, selected, { force: true }))}
            onRemove={() => void run('remove', () => removeDoubanSubject(ctx, selected))}
          />
          {busy === `load:${selected}` && <Spinner label="正在读取豆瓣 RSS…" />}
          {entry.feed.reviews.length ? (
            <>
              <p class="muted small db-note">豆瓣的 RSS 只附每篇评论开头的一小段，点"读全文"到豆瓣看完整内容。</p>
              <ul class="db-reviews">
                {entry.feed.reviews.map((r) => (
                  <ReviewCard key={r.id} r={r} now={ctx.now()} />
                ))}
              </ul>
            </>
          ) : (
            <p class="muted">这个条目暂时没有评论（RSS 是空的）。</p>
          )}
        </>
      ) : busy === `load:${selected}` ? (
        <Spinner label="正在读取豆瓣 RSS…" />
      ) : (
        <div class="row wrap">
          <span class="muted">还没有读到这个条目的评论。</span>
          <button class="btn" onClick={() => void run(`load:${selected}`, () => refreshDoubanFeed(ctx, selected, { force: true }))}>
            读取最新评论
          </button>
          <button class="btn link small" onClick={() => void run('remove', () => removeDoubanSubject(ctx, selected))}>
            取消订阅
          </button>
        </div>
      )}
    </div>
  );
}
