// B站（2026-11-25 新增，见 DECISIONS §92）：
// 1. "显示发布时间"：勾上后，B 站视频页右侧"接下来播放"列表里每条视频的播放量后面显示发布时间（由后台向 B 站公开接口查，只发 BV 号）；
//    下面说明当前标签页的情况（找到几条、几条显示了、在查、查不到、被拦了），"不静默"。
// 2. 收藏：当前是 B 站视频页时，直接收藏这个视频并打标签；列表里每条视频封面左上角也有"收藏"。收进来的视频在这里
//    按标签、关键词筛选，加减标签，改名 / 删除标签，移出（可撤销）。只读写本机存储；链接在新标签页打开（不把正在看的页面换掉）。

import { useState } from 'preact/hooks';
import { BILI_MSG, biliTagCounts, filterBili, parseBiliOp, type BiliSavedVideo, type BiliTabState, type BiliVideoInput } from '../../core/bili';
import { formatDateTime, formatDuration, formatRelative } from '../../core/time';
import { applyBili } from '../../services/bili-service';
import { stores } from '../../services/repo';
import { appCtx, useStore } from '../shared/app';
import { Notice } from '../shared/components';
import { useActiveTabState } from '../shared/tab-state';
import { TagChips, TagEditor, TagFilterBar, TagManager } from '../shared/tags';

async function run(raw: Record<string, unknown>): Promise<string | undefined> {
  const op = parseBiliOp(raw, Date.now(), false);
  if (!op) return raw.op === 'save' ? '这个视频的链接认不出来：刷新 B 站页面后再试' : '这个标签名不能用：去掉 # 和空白后是空的';
  const r = await applyBili(appCtx(), op);
  return r.ok ? undefined : r.error;
}

function Meta({ v }: { v: BiliVideoInput }) {
  const ctx = appCtx();
  return (
    <>
      {v.upName &&
        (v.upMid ? (
          <a href={`https://space.bilibili.com/${v.upMid}`} target="_blank" rel="noopener noreferrer" class="bili-up">
            UP {v.upName}
          </a>
        ) : (
          <span class="bili-up">UP {v.upName}</span>
        ))}
      {v.publishedAt !== undefined && (
        <time dateTime={new Date(v.publishedAt).toISOString()} title={formatRelative(v.publishedAt, ctx.now())} data-testid="bili-item-time">
          发布 {formatDateTime(v.publishedAt, ctx.timeZone)}
        </time>
      )}
      {v.duration !== undefined && <span>时长 {formatDuration(v.duration)}</span>}
    </>
  );
}

/** 当前标签页的"接下来播放"列表：找到几条、显示了几条、为什么没显示 */
function TabStatus({ s }: { s: BiliTabState }) {
  if (!s.enabled) return <Notice kind="warn">B 站功能已在设置里关闭（设置页"21. B 站"）。</Notice>;
  if (s.waiting) return <p class="muted small" data-testid="bili-tab-status">当前页：等 B 站把页面加载完再加发布时间和按钮…</p>;
  if (!s.cards) {
    return (
      <p class="muted small" data-testid="bili-tab-status">
        当前页没有"接下来播放"列表（视频页右侧才有）。
      </p>
    );
  }
  if (!s.showPubdate) {
    return (
      <p class="muted small" data-testid="bili-tab-status">
        当前页"接下来播放"列表里有 {s.cards} 条视频。
      </p>
    );
  }
  const parts = [`找到 ${s.cards} 条视频`, `${s.shown} 条显示了发布时间`];
  if (s.pending) parts.push(`${s.pending} 条${s.error ? '没查到' : '正在查'}`);
  if (s.unknown) parts.push(`${s.unknown} 条 B 站接口里查不到（可能已删除或不公开）`);
  return (
    <div class="muted small xhs-status" data-testid="bili-tab-status">
      当前页"接下来播放"：{parts.join(' · ')}
      {s.error && (
        <div class="xhs-warn" data-testid="bili-error">
          {s.error}
        </div>
      )}
    </div>
  );
}

/** 当前是 B 站视频页：直接收藏这个视频 */
function Current({ v, onTag }: { v: BiliVideoInput; onTag: (t: string) => void }) {
  const state = useStore(stores.bili);
  const [error, setError] = useState<string>();
  if (!state) return null;
  const item = state.videos[v.bvid];
  const save = async (tags: string[] = []) => {
    const e = await run({ op: 'save', video: v, tags });
    setError(e);
    return e;
  };
  return (
    <section class="panel bili-current" data-testid="bili-current">
      <div class="muted small">当前视频</div>
      <div class="xhs-item-head">
        <span class="xhs-title" data-testid="bili-current-title">
          {v.title || '（标题还没读到）'}
        </span>
      </div>
      <div class="muted small xhs-meta">
        <Meta v={v} />
      </div>
      <div class="xhs-tags">
        {item ? (
          <>
            <button class="btn small" data-testid="bili-current-unsave" title="移出 TubeMuse 收藏（不影响 B 站上的收藏）" onClick={() => void run({ op: 'remove', bvid: v.bvid }).then(setError)}>
              ★ 已收藏
            </button>
            <TagChips tags={item.tags} onPick={onTag} onRemove={(t) => void run({ op: 'tags', bvid: v.bvid, add: [], remove: [t] }).then(setError)} />
            <TagEditor onAdd={(add) => run({ op: 'tags', bvid: v.bvid, add, remove: [] })} />
          </>
        ) : (
          <>
            <button class="btn small primary" data-testid="bili-current-save" title="收进 TubeMuse（只存在本机，不会在 B 站上收藏）" onClick={() => void save()}>
              ☆ 收藏这个视频
            </button>
            <TagEditor onAdd={(tags) => save(tags)} />
          </>
        )}
      </div>
      {error && <div class="xhs-warn small">{error}</div>}
    </section>
  );
}

function Item({ v, onTag, onRemove }: { v: BiliSavedVideo; onTag: (t: string) => void; onRemove: () => void }) {
  return (
    <li class="card xhs-item" data-testid="bili-item" data-bvid={v.bvid}>
      <div class="xhs-item-head">
        <a class="xhs-title" href={v.url} target="_blank" rel="noopener noreferrer">
          {v.title || v.bvid} ↗
        </a>
      </div>
      <div class="muted small xhs-meta">
        <Meta v={v} />
        <span>收藏于 {new Date(v.savedAt).toLocaleDateString('zh-CN')}</span>
      </div>
      <div class="xhs-tags">
        <TagChips tags={v.tags} onPick={onTag} onRemove={(t) => void run({ op: 'tags', bvid: v.bvid, add: [], remove: [t] })} />
        <TagEditor onAdd={(add) => run({ op: 'tags', bvid: v.bvid, add, remove: [] })} />
      </div>
      <div class="xhs-actions">
        <button class="btn small" data-testid="bili-remove" onClick={onRemove}>
          移出收藏
        </button>
      </div>
    </li>
  );
}

export function BiliView() {
  const settings = useStore(stores.settings);
  const state = useStore(stores.bili);
  const { state: tab } = useActiveTabState<BiliTabState>(BILI_MSG.getState, BILI_MSG.state);
  const [tag, setTag] = useState<string>();
  const [q, setQ] = useState('');
  const [manage, setManage] = useState(false);
  const [removed, setRemoved] = useState<BiliSavedVideo>();
  const [error, setError] = useState<string>();
  if (!settings || !state) return null;
  const ctx = appCtx();
  const setShowPubdate = (on: boolean) => void stores.settings.update(ctx.kv, ctx.locker, (s) => ({ ...s, bili: { ...s.bili, showPubdate: on } }));
  const total = Object.keys(state.videos).length;
  const tags = biliTagCounts(state);
  const list = filterBili(state, { ...(tag ? { tag } : {}), q });
  const remove = async (v: BiliSavedVideo) => {
    const e = await run({ op: 'remove', bvid: v.bvid });
    setError(e);
    if (!e) setRemoved(v);
  };
  const restore = async () => {
    if (!removed) return;
    setError(await run({ op: 'restore', item: removed }));
    setRemoved(undefined);
  };
  return (
    <div class="bili" data-testid="bili-view">
      <p class="muted small">
        在 B 站（www.bilibili.com）看视频时用：右侧"接下来播放"列表里显示每条视频的发布时间；把感兴趣的视频收进 TubeMuse、打标签，下次在这里查看。收藏只存在本机，不会在 B 站上收藏、点赞或关注。
      </p>
      {!settings.bili.enabled && <Notice kind="warn">B 站功能已在设置里关闭（设置页"21. B 站"）。打开后这里的选项才在 B 站页面上生效。</Notice>}

      <section class="panel" data-testid="bili-pubdate-panel">
        <label class="inline">
          <input type="checkbox" data-testid="bili-show-pubdate" checked={settings.bili.showPubdate} onChange={(e) => setShowPubdate(e.currentTarget.checked)} />
          <b>显示发布时间</b>
        </label>
        <p class="muted small">
          勾上后，视频页右侧"接下来播放"列表里每条视频的播放量后面一直显示发布时间：30 天内写"N 天前"，更早的写日期，鼠标停上去看精确到分钟的时间。列表刷新、换视频、点"展开"加载出的新条目都跟着显示。
        </p>
        <p class="muted small">
          B 站页面上没有这个信息，TubeMuse 向 B 站的公开接口（<code>api.bilibili.com</code>）查：只发这些视频的 BV 号，不带 Cookie（不暴露你的账号）；查过的记在本机，不再查。查得太频繁时 B 站会拦，TubeMuse 就停 5 分钟、在这里说明。
        </p>
        {tab ? <TabStatus s={tab} /> : <p class="muted small" data-testid="bili-tab-status">当前标签页不是 B 站页面（如果是，刷新一下那个页面）。</p>}
      </section>

      {tab?.enabled && tab.current && <Current v={tab.current} onTag={setTag} />}

      <h3 class="bili-heading">收藏 {total}</h3>
      <p class="muted small">
        当前视频在上面收藏；"接下来播放"列表里的视频，把鼠标移到封面上，点左上角的"收藏"。
      </p>
      <div class="xhs-filters">
        <input class="input xhs-search" type="search" placeholder="搜标题、UP 主、标签" aria-label="搜索收藏的视频" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      {tags.length > 0 && <TagFilterBar tags={tags} active={tag} onPick={setTag} manage={manage} onToggleManage={() => setManage(!manage)} testId="bili-tag-filter" />}
      {manage && (
        <section class="panel">
          <TagManager
            tags={tags}
            empty="还没有标签：收藏时加，或在下面的收藏里加。"
            testId="bili-tag-manager"
            onRename={(from, to) => run({ op: 'renameTag', from, to })}
            onDelete={(t) => run({ op: 'deleteTag', tag: t })}
            onRenamed={(from, to) => tag === from && setTag(to)}
          />
        </section>
      )}
      {removed && (
        <Notice kind="info" onClose={() => setRemoved(undefined)}>
          已移出"{removed.title || removed.bvid}"。
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
        <ul class="cards" data-testid="bili-list">
          {list.map((v) => (
            <Item key={v.bvid} v={v} onTag={setTag} onRemove={() => void remove(v)} />
          ))}
        </ul>
      ) : (
        <p class="muted small" data-testid="bili-empty">
          {total === 0 ? '还没有收藏。打开 B 站的视频页，在上面"当前视频"里，或"接下来播放"列表里视频封面左上角点"收藏"。' : '没有符合筛选条件的收藏。'}
        </p>
      )}
    </div>
  );
}
