// 小红书：在小红书网页版上收进 TubeMuse 的笔记与博主——按类型、标签、关键词筛选，加减标签，改名 / 删除标签，移出（可撤销）。
// 顶部显示当前标签页的状况（找到几张卡片、几张是页面数据里的发布时间、几张由笔记 ID 推算），读不到时说明原因。
// 只读写本机存储；链接在新标签页打开（不把正在看的页面换掉）。

import { useState } from 'preact/hooks';
import { XHS_MSG, filterXhs, formatXhsTime, parseXhsOp, tagCounts, type XhsKind, type XhsListItem, type XhsTabState } from '../../core/xhs';
import { stores } from '../../services/repo';
import { applyXhs } from '../../services/xhs-service';
import { appCtx, useStore } from '../shared/app';
import { Notice } from '../shared/components';
import { useActiveTabState } from '../shared/tab-state';
import { TagChips, TagEditor, TagFilterBar, TagManager } from '../shared/tags';

const PAGE_NAMES: Record<XhsTabState['page'], string> = { profile: '博主主页', note: '笔记详情', feed: '笔记列表', other: '小红书页面' };

async function run(raw: Record<string, unknown>): Promise<string | undefined> {
  const op = parseXhsOp(raw, Date.now(), false);
  if (!op) return '这个标签名不能用：去掉 # 和空白后是空的';
  const r = await applyXhs(appCtx(), op);
  return r.ok ? undefined : r.error;
}

function TabStatus({ s }: { s: XhsTabState }) {
  if (!s.enabled) return <Notice kind="warn">小红书功能已在设置里关闭（设置页"15. 小红书"）。</Notice>;
  const parts = [`找到 ${s.cards} 张笔记卡片`];
  if (s.exact) parts.push(`${s.exact} 张显示页面数据里的发布时间`);
  if (s.approx) parts.push(`${s.approx} 张由笔记 ID 推算（标 ≈）`);
  if (s.unknown) parts.push(`${s.unknown} 张时间未知`);
  return (
    <div class="muted small xhs-status" data-testid="xhs-tab-status">
      当前页（{PAGE_NAMES[s.page]}）：{s.page === 'note' && !s.cards ? '详情页的日期旁显示发布时间' : parts.join(' · ')}
      {s.pageData === 'unavailable' && (
        <div class="xhs-warn" data-testid="xhs-bridge-missing">
          读不到这一页的页面数据，只能用笔记 ID 推算时间：页面可能是在 TubeMuse 安装或更新之前打开的，刷新一下再看。
        </div>
      )}
      {s.unknown > 0 && s.pageData !== 'unavailable' && <div>时间未知的卡片没有笔记 ID（通常是没登录小红书），页面数据里也对不上。</div>}
    </div>
  );
}

function Item({ x, onTag, onRemove }: { x: XhsListItem; onTag: (t: string) => void; onRemove: () => void }) {
  const ctx = appCtx();
  const { kind, item } = x;
  const title = kind === 'note' ? x.item.title || '（无标题）' : x.item.name || '（未知博主）';
  return (
    <li class="card xhs-item" data-testid="xhs-item" data-kind={kind}>
      <div class="xhs-item-head">
        <span class={`xhs-kind ${kind}`}>{kind === 'note' ? '笔记' : '博主'}</span>
        <a class="xhs-title" href={item.url} target="_blank" rel="noopener noreferrer">
          {title} ↗
        </a>
      </div>
      <div class="muted small xhs-meta">
        {kind === 'note' && x.item.authorName && <span>{x.item.authorName}</span>}
        {kind === 'note' && x.item.publishedAt !== undefined && x.item.timeSource && (
          <time dateTime={new Date(x.item.publishedAt).toISOString()} data-testid="xhs-item-time">
            发布 {formatXhsTime(x.item.publishedAt, x.item.timeSource, ctx.timeZone)}
          </time>
        )}
        <span>收藏于 {new Date(item.savedAt).toLocaleDateString('zh-CN')}</span>
      </div>
      <div class="xhs-tags">
        <TagChips tags={item.tags} onPick={onTag} onRemove={(t) => void run({ op: 'tags', kind, id: item.id, add: [], remove: [t] })} />
        <TagEditor onAdd={(add) => run({ op: 'tags', kind, id: item.id, add, remove: [] })} />
      </div>
      <div class="xhs-actions">
        <button class="btn small" data-testid="xhs-remove" onClick={onRemove}>
          移出收藏
        </button>
      </div>
    </li>
  );
}

export function XhsView() {
  const settings = useStore(stores.settings);
  const state = useStore(stores.xhs);
  const { state: tab } = useActiveTabState<XhsTabState>(XHS_MSG.getState, XHS_MSG.state);
  const [kind, setKind] = useState<'all' | XhsKind>('all');
  const [tag, setTag] = useState<string>();
  const [q, setQ] = useState('');
  const [manage, setManage] = useState(false);
  const [removed, setRemoved] = useState<XhsListItem>();
  const [error, setError] = useState<string>();
  if (!settings || !state) return null;
  const notes = Object.keys(state.notes).length;
  const users = Object.keys(state.users).length;
  const tags = tagCounts(state);
  const list = filterXhs(state, { kind, ...(tag ? { tag } : {}), q });
  const remove = async (x: XhsListItem) => {
    const e = await run({ op: 'remove', kind: x.kind, id: x.item.id });
    setError(e);
    if (!e) setRemoved(x);
  };
  const restore = async () => {
    if (!removed) return;
    setError(await run({ op: 'restore', kind: removed.kind, item: removed.item }));
    setRemoved(undefined);
  };
  return (
    <div class="xhs" data-testid="xhs-view">
      <p class="muted small">
        在小红书网页版（xiaohongshu.com / rednote.com）上，笔记卡片作者那一行显示发布时间；点封面左下角的"收藏"、博主主页名字旁或笔记详情"关注"旁的按钮，把笔记 / 博主收进这里并打标签。只存在本机，不会在小红书上收藏或关注。
      </p>
      {tab && <TabStatus s={tab} />}
      {!settings.xhs.enabled && !tab && <Notice kind="warn">小红书功能已在设置里关闭（设置页"15. 小红书"）。</Notice>}

      <div class="xhs-filters">
        <div class="seg" role="group" aria-label="类型">
          {(
            [
              ['all', `全部 ${notes + users}`],
              ['note', `笔记 ${notes}`],
              ['user', `博主 ${users}`],
            ] as const
          ).map(([k, label]) => (
            <button class={`seg-btn${kind === k ? ' on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {label}
            </button>
          ))}
        </div>
        <input class="input xhs-search" type="search" placeholder="搜标题、作者、标签" aria-label="搜索收藏" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      {tags.length > 0 && (
        <TagFilterBar tags={tags} active={tag} onPick={setTag} manage={manage} onToggleManage={() => setManage(!manage)} testId="xhs-tag-filter" />
      )}
      {manage && (
        <section class="panel">
          <TagManager
            tags={tags}
            empty='还没有标签：在小红书页面上点"收藏"，或在下面的收藏里加。'
            testId="xhs-tag-manager"
            onRename={(from, to) => run({ op: 'renameTag', from, to })}
            onDelete={(t) => run({ op: 'deleteTag', tag: t })}
            onRenamed={(from, to) => tag === from && setTag(to)}
          />
        </section>
      )}
      {removed && (
        <Notice kind="info" onClose={() => setRemoved(undefined)}>
          已移出"{removed.kind === 'note' ? removed.item.title || '（无标题）' : removed.item.name}"。
          <button class="btn link small" onClick={() => void restore()}>
            撤销
          </button>
        </Notice>
      )}
      {error && (
        <Notice kind="warn" onClose={() => setError(undefined)}>
          {error}
        </Notice>
      )}
      {list.length ? (
        <ul class="cards" data-testid="xhs-list">
          {list.map((x) => (
            <Item key={`${x.kind}:${x.item.id}`} x={x} onTag={(t) => setTag(t)} onRemove={() => void remove(x)} />
          ))}
        </ul>
      ) : (
        <p class="muted small" data-testid="xhs-empty">
          {notes + users === 0 ? '还没有收藏。打开小红书网页版，在笔记卡片或博主主页上点"收藏"。' : '没有符合筛选条件的收藏。'}
        </p>
      )}
    </div>
  );
}
