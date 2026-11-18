// 故事（2026-11-18 新增，见 DECISIONS §88）：停在一条新闻或帖子上，点「读这个页面」看读到了什么，点「调研来龙去脉」联网调研，
// 结果分清"已证实 / 只是说法 / 有争议 / 查无实据"，每一条都标着来源编号，来源可以点开核对。
// 读页面不花钱、只在你点的时候读；调研要花钱、只在你点"调研"时发生。调研过的存在本机，同一个页面缓存一段时间内再打开不再花钱。

import { useEffect, useState } from 'preact/hooks';
import { STORY } from '../../config/defaults';
import {
  PAGE_SOURCE_ID,
  STORY_STATUSES,
  STORY_STATUS_HINTS,
  STORY_STATUS_LABELS,
  pastedStoryPage,
  referencedSources,
  sourceIndex,
  statusCounts,
  storyKey,
  type StoryPage,
  type StoryPost,
  type StoryRecord,
  type StorySource,
  type StoryStatus,
} from '../../core/story';
import { IS_FIREFOX, SHORTCUTS_PAGE } from '../../platform';
import type { AppError } from '../../services/errors';
import { stores } from '../../services/repo';
import { deleteStory, estimateStoryUsd, lastStoryFor, researchStory, type StoryStage } from '../../services/story-service';
import { appCtx, asAppError, useStore } from '../shared/app';
import { ErrorBox, Notice, Spinner } from '../shared/components';
import { hasSiteAccess, readStoryTab, requestSiteAccess, sitePattern, type StoryTabRead } from './story-page';

const PROVIDERS = { anthropic: 'Anthropic', openai: 'OpenAI' } as const;
const PLATFORM_LABELS = { x: 'X 帖子', web: '网页', paste: '粘贴的文字' } as const;

function fmtTime(v: string | number | undefined): string {
  if (v === undefined || v === '') return '';
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(t)) return String(v);
  return new Date(t).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function ago(at: number, now: number): string {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  if (min < 48 * 60) return `${Math.round(min / 60)} 小时前`;
  return `${Math.round(min / 1440)} 天前`;
}

/** 快捷键现在是哪个（你可能在浏览器里改过）；没设置时为空 */
function useStoryShortcut(): string | undefined {
  const [key, setKey] = useState<string>();
  useEffect(() => {
    void chrome.commands
      ?.getAll()
      .then((all) => setKey(all.find((c) => c.name === 'story-read')?.shortcut || undefined))
      .catch(() => undefined);
  }, []);
  return key;
}

function StatusBadge({ status, downgraded }: { status: StoryStatus; downgraded?: boolean | undefined }) {
  return (
    <span class={`story-st st-${status}`} title={downgraded ? '大模型标成"已证实"，但没有给出可查的来源，这里按"只是说法"显示' : STORY_STATUS_HINTS[status]} data-testid="story-status">
      {STORY_STATUS_LABELS[status]}
      {downgraded ? '*' : ''}
    </span>
  );
}

function Refs({ ids, index, page }: { ids: readonly string[]; index: Map<string, StorySource>; page: StoryPage }) {
  if (!ids.length) return <span class="story-noref muted">（没有来源）</span>;
  return (
    <span class="story-refs">
      {ids.map((id) => {
        if (id === PAGE_SOURCE_ID) {
          return page.url ? (
            <a href={page.url} target="_blank" rel="noopener noreferrer" title="你正在看的这个页面" data-testid="story-ref">
              [页面]
            </a>
          ) : (
            <span title="你粘贴的文字">[页面]</span>
          );
        }
        const s = index.get(id);
        return s ? (
          <a href={s.url} target="_blank" rel="noopener noreferrer" title={`${s.title} · ${s.site}`} data-testid="story-ref">
            [{id}]
          </a>
        ) : null;
      })}
    </span>
  );
}

function PostBlock({ post, label, testId }: { post: StoryPost; label: string; testId: string }) {
  const [open, setOpen] = useState(false);
  const long = post.text.length > 280;
  return (
    <div class="story-post" data-testid={testId}>
      <div class="muted small">{label}</div>
      <div class="story-post-head">
        <strong>{post.author ?? post.handle ?? '（作者不详）'}</strong>
        {post.author && post.handle && <span class="muted small"> {post.handle}</span>}
        {(post.time || post.timeLabel) && <span class="muted small"> · {post.time ? fmtTime(post.time) : post.timeLabel}</span>}
      </div>
      {post.text && <p class={`story-post-text${long && !open ? ' clamp' : ''}`}>{post.text}</p>}
      {long && (
        <button class="btn link small" onClick={() => setOpen(!open)}>
          {open ? '收起' : '展开全文'}
        </button>
      )}
      {post.media.length > 0 && (
        <div class="muted small">
          附带：{post.media.map((m) => (m === 'video' ? '视频' : m === 'gif' ? '动图' : m.startsWith('photo:') ? `图片（${m.slice(6)}）` : '图片')).join('、')}
        </div>
      )}
      {post.metrics && <div class="muted small story-metrics">{post.metrics}</div>}
    </div>
  );
}

/** 读到了什么：就是要发给大模型的那些（正文只发前一部分） */
function PageCard({ page }: { page: StoryPage }) {
  const [open, setOpen] = useState(false);
  const meta = [
    page.site,
    ...(page.platform === 'web' ? page.authors : []),
    ...(page.published ? [`发布于 ${fmtTime(page.published)}`] : []),
    ...(page.modified && page.modified !== page.published ? [`更新于 ${fmtTime(page.modified)}`] : []),
    `读于 ${fmtTime(page.readAt)}`,
  ];
  return (
    <section class="panel story-page" data-testid="story-page">
      <div class="story-page-head">
        <span class="badge">{PLATFORM_LABELS[page.platform]}</span>
        {page.url ? (
          <a class="xhs-title" href={page.url} target="_blank" rel="noopener noreferrer" data-testid="story-page-title">
            {page.title}
          </a>
        ) : (
          <span class="xhs-title" data-testid="story-page-title">
            {page.title}
          </span>
        )}
      </div>
      <div class="muted small xhs-meta">
        {meta.map((m) => (
          <span>{m}</span>
        ))}
      </div>
      {page.platform === 'x' && page.post && <PostBlock post={page.post} label="主帖" testId="story-post" />}
      {page.platform === 'x' && page.quoted && <PostBlock post={page.quoted} label="引用的帖子" testId="story-quoted" />}
      {page.card && (
        <div class="muted small" data-testid="story-card">
          链接卡片：{page.card.text}
        </div>
      )}
      {page.platform !== 'x' && (
        <>
          {page.description && <p class="small story-desc">{page.description}</p>}
          {page.text && (
            <>
              <p class={`small story-text${open ? '' : ' clamp'}`} data-testid="story-page-text">
                {page.text}
              </p>
              <button class="btn link small" onClick={() => setOpen(!open)}>
                {open ? '收起' : `展开正文（${page.text.length} 字${page.truncated ? '，只读了前面一部分' : ''}）`}
              </button>
            </>
          )}
        </>
      )}
      {page.selection && (
        <div class="story-selection small" data-testid="story-selection">
          <span class="muted">你选中的部分（会优先查它）：</span>
          {page.selection}
        </div>
      )}
    </section>
  );
}

function StoryResult({ rec, now, onDelete }: { rec: StoryRecord; now: number; onDelete?: () => void }) {
  const { brief, page } = rec;
  const index = sourceIndex(rec.sources);
  const counts = statusCounts(brief);
  const used = referencedSources(brief);
  const paused = rec.searchErrors.includes('paused');
  const searchErrors = rec.searchErrors.filter((e) => e !== 'paused');
  return (
    <section class="story-result" data-testid="story-result">
      <h3 class="story-headline" data-testid="story-headline">
        {brief.headline || page.title}
      </h3>
      {brief.summary && (
        <p class="story-summary" data-testid="story-summary">
          {brief.summary}
        </p>
      )}
      <div class="story-legend" data-testid="story-legend">
        {STORY_STATUSES.map((s) => (
          <span class={`story-st st-${s}`} title={STORY_STATUS_HINTS[s]}>
            {STORY_STATUS_LABELS[s]} {counts[s]}
          </span>
        ))}
      </div>
      {brief.caveat && (
        <Notice kind="warn">
          <span data-testid="story-caveat">{brief.caveat}</span>
        </Notice>
      )}
      {brief.downgraded > 0 && (
        <p class="muted small" data-testid="story-downgraded">
          * 有 {brief.downgraded} 条大模型标成"已证实"，但没有给出可查的来源（只有页面本身不算），这里按"只是说法"显示。
        </p>
      )}
      {paused && (
        <Notice kind="warn">
          <span data-testid="story-paused">调研没有做完（服务方的搜索循环到了上限），下面是做到一半的结果：可以点"重新调研"。</span>
        </Notice>
      )}
      {brief.claims.length > 0 && (
        <div class="story-sec" data-testid="story-claims">
          <h4>核心说法，逐条核对</h4>
          <ul class="story-list">
            {brief.claims.map((c) => (
              <li data-testid="story-claim" data-status={c.status}>
                <StatusBadge status={c.status} downgraded={c.downgraded} /> {c.text}
                {c.speaker && <span class="muted small"> —— {c.speaker}</span>}
                {c.note && <div class="small story-note">{c.note}</div>}
                <Refs ids={c.sources} index={index} page={page} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {brief.timeline.length > 0 && (
        <div class="story-sec" data-testid="story-timeline">
          <h4>来龙去脉</h4>
          <ol class="story-timeline">
            {brief.timeline.map((t) => (
              <li>
                <span class="story-when">{t.when}</span> {t.event} <Refs ids={t.sources} index={index} page={page} />
              </li>
            ))}
          </ol>
        </div>
      )}
      {brief.perspectives.length > 0 && (
        <div class="story-sec" data-testid="story-perspectives">
          <h4>各方立场</h4>
          <ul class="story-list">
            {brief.perspectives.map((p) => (
              <li>
                <strong>{p.who}</strong>：{p.stance} <Refs ids={p.sources} index={index} page={page} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {brief.context.length > 0 && (
        <div class="story-sec" data-testid="story-context">
          <h4>相关背景</h4>
          <ul class="story-list">
            {brief.context.map((c) => (
              <li data-status={c.status}>
                <StatusBadge status={c.status} downgraded={c.downgraded} /> {c.text}
                {c.note && <div class="small story-note">{c.note}</div>}
                <Refs ids={c.sources} index={index} page={page} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {brief.analysis.length > 0 && (
        <div class="story-sec story-analysis" data-testid="story-analysis">
          <h4>深层含义</h4>
          <p class="muted small">这一部分是大模型根据上面的来源做的分析和推测，不是事实。</p>
          <ul class="story-list">
            {brief.analysis.map((a) => (
              <li>
                <span class="story-st st-analysis">分析</span> {a.text} <Refs ids={a.sources} index={index} page={page} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {brief.openQuestions.length > 0 && (
        <div class="story-sec" data-testid="story-open">
          <h4>还不清楚的</h4>
          <ul class="story-list">
            {brief.openQuestions.map((q) => (
              <li>{q}</li>
            ))}
          </ul>
        </div>
      )}
      <div class="story-sec" data-testid="story-sources">
        <h4>来源（{rec.sources.length}）</h4>
        {rec.sources.length ? (
          <ol class="story-sources">
            {rec.sources.map((s) => (
              <li data-testid="story-source" data-used={used.has(s.id) ? 'true' : undefined}>
                <span class="story-sid">{s.id}</span>{' '}
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title}
                </a>
                <span class="muted small">
                  {' '}
                  · {s.site}
                  {s.date ? ` · ${s.date}` : ''}
                  {s.cited ? '' : ' · 只在搜索结果里出现'}
                </span>
                {s.quotes.map((q) => (
                  <blockquote class="story-quote small">{q}</blockquote>
                ))}
              </li>
            ))}
          </ol>
        ) : (
          <p class="muted small">这次调研没有找到任何来源：上面的内容都没有出处，只能当线索。</p>
        )}
      </div>
      <p class="muted small" data-testid="story-footer">
        {rec.queries.length > 0 && <>搜了：{rec.queries.map((q) => `"${q}"`).join('、')}。</>}
        {searchErrors.length > 0 && <> 有 {searchErrors.length} 种搜索出错（{searchErrors.join('、')}），出错的那几次不收费。</>}
        {rec.model}（{PROVIDERS[rec.provider]}）· 搜索 {rec.searches} 次 · 约 ${rec.usd.toFixed(4)}
        {rec.estimatedPrice ? '（模型不在价格表里，按最贵一档估）' : ''} · 调研于 {fmtTime(rec.at)}（{ago(rec.at, now)}）。
        内容是大模型根据搜索结果写的，可能出错：重要的事请点来源核对。
      </p>
      {onDelete && (
        <div class="xhs-actions">
          <button class="btn small" data-testid="story-delete" onClick={onDelete}>
            删除这条
          </button>
        </div>
      )}
    </section>
  );
}

function ReadProblem({ read, shortcut }: { read: Exclude<StoryTabRead, { ok: true }>; shortcut: string | undefined }) {
  if (read.reason === 'no-access' || read.reason === 'no-tab') {
    const how = shortcut ? `按 ${shortcut}` : `在 ${SHORTCUTS_PAGE} 给「读当前页面的故事」设一个快捷键再按它`;
    return (
      <Notice kind="warn">
        <span data-testid="story-no-access">
          TubeMuse 现在没有读这个页面的权限。任选一种：在页面上点右键 →「TubeMuse：讲讲这个故事」；或者{how}
          {IS_FIREFOX ? '' : '；或者点浏览器工具栏上的 TubeMuse 图标'}。这只对这一次、这一个页面有效；读过一次后，可以让浏览器记住这个网站。
          浏览器自己的页面（设置页、扩展商店、新标签页）谁都不能读。
        </span>
      </Notice>
    );
  }
  const text: Record<string, string> = {
    skipped: '这个网站有自己的约定（YouTube、小红书、Gmail、Instagram、抖音、B 站、小宇宙、酷播），故事不读它的页面。想查里面的内容，把文字粘贴到下面"粘贴文字来查"里。',
    'x-nopost': '这是 X 的信息流或个人主页：点开一条帖子（网址里有 /status/）再读。故事只读那一条帖子，不读信息流。',
    'x-not-found': '这是一条 X 帖子，但页面上没找到它（可能还没加载完、帖子已删除，或 X 改版了）：等页面加载完再点一次。',
    empty: '这个页面上没读到正文（可能还没加载完，或者正文在框架 / 图片里）：等页面加载完再试，或者选中要查的文字后再点。',
    bad: '页面交回来的内容对不上，没有使用：刷新那个页面再试。',
  };
  return (
    <Notice kind="warn">
      <span data-testid={`story-read-${read.reason}`}>{text[read.reason] ?? '没读到这个页面。'}</span>
    </Notice>
  );
}

/** 用网页右键菜单 / 快捷键（只对这一次有效）读到的网站：问一句要不要以后直接读 */
function SiteAccessOffer({ page }: { page: StoryPage }) {
  const [state, setState] = useState<'unknown' | 'has' | 'offer' | 'refused'>('unknown');
  const pattern = page.platform === 'web' ? sitePattern(page.url) : undefined;
  useEffect(() => {
    if (!pattern) return setState('has');
    void hasSiteAccess(page.url).then((ok) => setState(ok ? 'has' : 'offer'));
  }, [pattern]);
  if (!pattern || state === 'has' || state === 'unknown') return null;
  const host = pattern.replace(/^\w+:\/\//, '').replace(/\/\*$/, '');
  return (
    <p class="muted small" data-testid="story-site-offer">
      这次是借你的右键 / 快捷键读的。
      <button
        class="btn link small"
        onClick={() => {
          // 必须在点击的这一刻调用：浏览器只在用户操作时弹授权框
          void requestSiteAccess(pattern).then((ok) => setState(ok ? 'has' : 'refused'));
        }}
      >
        以后在 {host} 上直接读
      </button>
      {state === 'refused' ? '（没有授权）' : '（浏览器会弹窗问你；可以在设置页随时收回）'}
    </p>
  );
}

function PasteBox({ onUse }: { onUse: (page: StoryPage) => void }) {
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  return (
    <details class="story-paste" data-testid="story-paste">
      <summary class="muted small">读不了页面？粘贴文字来查</summary>
      <textarea class="input" rows={4} placeholder="把新闻或帖子的文字粘贴到这里" value={text} onInput={(e) => setText(e.currentTarget.value)} data-testid="story-paste-text" />
      <input class="input" type="url" placeholder="原文链接（可不填）" value={link} onInput={(e) => setLink(e.currentTarget.value)} data-testid="story-paste-link" />
      <button
        class="btn small"
        disabled={!text.trim()}
        data-testid="story-paste-use"
        onClick={() => {
          const page = pastedStoryPage(text, link, Date.now());
          if (page) onUse(page);
        }}
      >
        用这段文字
      </button>
    </details>
  );
}

function CurrentStory({ request }: { request: { tabId: number; n: number } | undefined }) {
  const settings = useStore(stores.settings);
  const stories = useStore(stores.stories);
  const shortcut = useStoryShortcut();
  const [read, setRead] = useState<StoryTabRead>();
  const [page, setPage] = useState<StoryPage>();
  const [reading, setReading] = useState(false);
  const [stage, setStage] = useState<StoryStage>();
  const [shown, setShown] = useState<{ rec: StoryRecord; cached: boolean; reusedNotes: boolean }>();
  const [error, setError] = useState<AppError>();

  const readNow = async (tabId?: number) => {
    setReading(true);
    setError(undefined);
    setShown(undefined);
    try {
      const r = await readStoryTab(tabId);
      setRead(r);
      setPage(r.ok ? r.page : undefined);
    } finally {
      setReading(false);
    }
  };
  // 右键菜单 / 快捷键：后台留了话，读那个标签页
  useEffect(() => {
    if (request) void readNow(request.tabId);
  }, [request?.n]);
  // 换了页面：这个页面以前调研过的话，直接显示（标明是什么时候的）
  useEffect(() => {
    if (!page) return;
    void lastStoryFor(appCtx(), page).then((rec) => rec && setShown({ rec, cached: true, reusedNotes: false }));
  }, [page && storyKey(page), page?.readAt]);

  if (!settings || !stories) return null;
  const now = Date.now();
  const fresh = shown && now - shown.rec.at < settings.story.cacheHours * 3_600_000;
  const est = estimateStoryUsd(settings);
  const provider = PROVIDERS[settings.llm.provider];
  const run = async (force: boolean) => {
    if (!page) return;
    setError(undefined);
    setStage('search');
    try {
      const r = await researchStory(appCtx(), page, { force, onStage: setStage });
      setShown({ rec: r.record, cached: r.cached, reusedNotes: r.reusedNotes });
    } catch (e) {
      setError(await asAppError(e));
    } finally {
      setStage(undefined);
    }
  };
  return (
    <>
      <div class="row story-actions">
        <button class={`btn${page ? '' : ' primary'}`} data-testid="story-read" disabled={reading || !!stage} onClick={() => void readNow()}>
          {page ? '重新读当前页面' : '读这个页面'}
        </button>
        <span class="muted small">只在你点的时候读，读到的先给你看{shortcut ? `；快捷键 ${shortcut}` : ''}</span>
      </div>
      {reading && <Spinner label="正在读当前页面…" />}
      {read && !read.ok && !reading && <ReadProblem read={read} shortcut={shortcut} />}
      {page && (
        <>
          <PageCard page={page} />
          <SiteAccessOffer page={page} />
          {stage ? (
            <Spinner label={stage === 'search' ? `正在联网搜索、核实（最多搜 ${settings.story.maxSearches} 次，通常要半分钟到两分钟）…` : '正在整理成"已证实 / 说法 / 推测"…'} />
          ) : (
            <div class="row story-actions">
              {fresh ? (
                <button class="btn" data-testid="story-rerun" onClick={() => void run(true)}>
                  重新调研
                </button>
              ) : (
                <button class="btn primary" data-testid="story-run" onClick={() => void run(false)}>
                  {shown ? '重新调研（上次的结果已过期）' : '调研来龙去脉'}
                </button>
              )}
            </div>
          )}
          {!stage && (
            <p class="muted small" data-testid="story-disclosure">
              点"调研"后，上面读到的内容（标题、作者、时间、正文前 {STORY.promptTextChars} 字、你选中的文字；X 帖子是主帖和引用的那一条）发给 {provider}，
              由它用自带的联网搜索查资料（最多 {settings.story.maxSearches} 次{settings.llm.provider === 'openai' ? '，OpenAI 没有硬上限，次数靠提示词约束' : ''}），
              再把调研笔记和来源清单发过去整理。用 {est.model} 预计约 ${est.usd.toFixed(3)}（估算，含每次 $0.01 的搜索费）；每日大模型预算 ${settings.llm.dailyBudgetUsd.toFixed(2)}。
            </p>
          )}
        </>
      )}
      {error && <ErrorBox error={error} onClose={() => setError(undefined)} />}
      {shown && !stage && (
        <>
          {shown.cached && (
            <p class="muted small" data-testid="story-cached">
              {fresh
                ? `这个页面 ${ago(shown.rec.at, now)}调研过，直接显示上次的结果，没有再花钱（${settings.story.cacheHours} 小时内有效）。`
                : `这是 ${ago(shown.rec.at, now)}的调研结果，可能已经过时：点"重新调研"查最新的。`}
            </p>
          )}
          {shown.reusedNotes && (
            <p class="muted small" data-testid="story-reused">
              用了刚才的调研笔记，只重做了整理这一步，没有再搜索。
            </p>
          )}
          <StoryResult rec={shown.rec} now={now} />
        </>
      )}
      <PasteBox
        onUse={(p) => {
          setRead(undefined);
          setShown(undefined);
          setError(undefined);
          setPage(p);
        }}
      />
    </>
  );
}

function History() {
  const stories = useStore(stores.stories);
  const [open, setOpen] = useState<string>();
  if (!stories) return null;
  if (!stories.items.length) {
    return (
      <p class="muted small" data-testid="story-history-empty">
        还没有调研过的故事。
      </p>
    );
  }
  const now = Date.now();
  return (
    <ul class="cards" data-testid="story-history">
      {stories.items.map((rec) => (
        <li class="card" data-testid="story-history-item">
          <button class="btn link story-history-title" onClick={() => setOpen(open === rec.id ? undefined : rec.id)}>
            {rec.brief.headline || rec.page.title}
          </button>
          <div class="muted small xhs-meta">
            <span>{PLATFORM_LABELS[rec.page.platform]}</span>
            <span>{rec.page.site}</span>
            <span>{fmtTime(rec.at)}</span>
            <span>约 ${rec.usd.toFixed(4)}</span>
          </div>
          {open === rec.id && <StoryResult rec={rec} now={now} onDelete={() => void deleteStory(appCtx(), rec.id).then(() => setOpen(undefined))} />}
        </li>
      ))}
    </ul>
  );
}

export function StoryView({ request }: { request?: { tabId: number; n: number } | undefined }) {
  const settings = useStore(stores.settings);
  const stories = useStore(stores.stories);
  const [mode, setMode] = useState<'current' | 'history'>('current');
  useEffect(() => {
    if (request) setMode('current');
  }, [request?.n]);
  if (!settings || !stories) return null;
  if (!settings.story.enabled) return <Notice kind="warn">故事已在设置里关闭（设置页"20. 故事"）。关闭时不读页面、不调研，已有的记录保留。</Notice>;
  return (
    <div class="story" data-testid="story-view">
      <p class="muted small">停在一条新闻或帖子上，点"读这个页面"，再点"调研来龙去脉"：TubeMuse 联网查它的前因后果、各方立场和深层含义，分清已证实的事实、某一方的说法和推测，每一条都标着可以点开核对的来源。</p>
      <div class="seg" role="group" aria-label="故事">
        {(
          [
            ['current', '当前页面'],
            ['history', `调研过的 ${stories.items.length}`],
          ] as const
        ).map(([k, label]) => (
          <button class={`seg-btn${mode === k ? ' on' : ''}`} aria-pressed={mode === k} data-testid={`story-mode-${k}`} onClick={() => setMode(k)}>
            {label}
          </button>
        ))}
      </div>
      {mode === 'current' ? <CurrentStory request={request} /> : <History />}
    </div>
  );
}
