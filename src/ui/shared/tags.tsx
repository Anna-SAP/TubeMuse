// 收藏的标签界面（小红书、eMails 共用）：加标签的输入框、标签条、筛选条、标签管理（改名 / 删除）。
// 操作结果由调用方决定怎么写入：回调返回人话错误，成功时返回 undefined。

import { useState } from 'preact/hooks';
import { splitTags, type TagCount } from '../../core/collection';

type Outcome = Promise<string | undefined>;

export function TagEditor({ onAdd }: { onAdd: (tags: string[]) => Outcome }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const add = async () => {
    const tags = splitTags(text);
    if (!tags.length) return;
    const e = await onAdd(tags);
    setError(e);
    if (!e) setText('');
  };
  return (
    <>
      <input
        class="input small xhs-tag-input"
        placeholder="加标签，回车"
        aria-label="加标签"
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.isComposing) void add();
        }}
      />
      {error && <div class="xhs-warn small">{error}</div>}
    </>
  );
}

/** 一条收藏上的标签：点名字只看这个标签，点 × 去掉 */
export function TagChips({ tags, onPick, onRemove }: { tags: readonly string[]; onPick: (t: string) => void; onRemove: (t: string) => void }) {
  return (
    <>
      {tags.map((t) => (
        <span class="xhs-chip" key={t}>
          <button class="xhs-chip-name" title={`只看 #${t}`} onClick={() => onPick(t)}>
            #{t}
          </button>
          <button class="xhs-chip-x" aria-label={`去掉标签 ${t}`} title="去掉这个标签" onClick={() => onRemove(t)}>
            ×
          </button>
        </span>
      ))}
    </>
  );
}

/** 列表上方的标签筛选条 */
export function TagFilterBar(props: { tags: readonly TagCount[]; active: string | undefined; onPick: (t: string | undefined) => void; manage: boolean; onToggleManage: () => void; testId: string }) {
  const { tags, active, onPick, manage, onToggleManage, testId } = props;
  return (
    <div class="xhs-tag-filter" data-testid={testId}>
      {tags.map(({ tag, count }) => (
        <button class={`xhs-filter-chip${active === tag ? ' on' : ''}`} aria-pressed={active === tag} onClick={() => onPick(active === tag ? undefined : tag)}>
          #{tag} <span class="muted">{count}</span>
        </button>
      ))}
      <button class="btn link small" aria-expanded={manage} onClick={onToggleManage}>
        {manage ? '收起' : '管理标签'}
      </button>
    </div>
  );
}

/** 管理标签：改名（新名字已有时合并成一个）、删除（从所有收藏上去掉，要再点一次确认） */
export function TagManager(props: {
  tags: readonly TagCount[];
  empty: string;
  testId: string;
  onRename: (from: string, to: string) => Outcome;
  onDelete: (tag: string) => Outcome;
  onRenamed: (from: string, to: string) => void;
}) {
  const { tags, empty, testId, onRename, onDelete, onRenamed } = props;
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState<string>();
  const [error, setError] = useState<string>();
  if (!tags.length) return <p class="muted small">{empty}</p>;
  const rename = async (from: string) => {
    const e = await onRename(from, name);
    setError(e);
    if (!e) {
      onRenamed(from, name.trim());
      setEditing(undefined);
    }
  };
  return (
    <ul class="xhs-tag-list" data-testid={testId}>
      {tags.map(({ tag, count }) => (
        <li key={tag}>
          {editing === tag ? (
            <>
              <input
                class="input small"
                value={name}
                aria-label={`把 #${tag} 改名为`}
                onInput={(e) => setName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.isComposing) void rename(tag);
                  if (e.key === 'Escape') setEditing(undefined);
                }}
              />
              <button class="btn small primary" onClick={() => void rename(tag)}>
                保存
              </button>
              <button class="btn small" onClick={() => setEditing(undefined)}>
                取消
              </button>
            </>
          ) : (
            <>
              <span class="xhs-tag-name">#{tag}</span>
              <span class="muted small">{count} 条</span>
              <button
                class="btn link small"
                onClick={() => {
                  setEditing(tag);
                  setName(tag);
                  setConfirm(undefined);
                }}
              >
                改名
              </button>
              {confirm === tag ? (
                <>
                  <button class="btn small danger" onClick={() => void onDelete(tag).then(setError)}>
                    确认从 {count} 条收藏上去掉
                  </button>
                  <button class="btn small" onClick={() => setConfirm(undefined)}>
                    取消
                  </button>
                </>
              ) : (
                <button class="btn link small" onClick={() => setConfirm(tag)}>
                  删除
                </button>
              )}
            </>
          )}
        </li>
      ))}
      {error && <li class="xhs-warn small">{error}</li>}
    </ul>
  );
}
