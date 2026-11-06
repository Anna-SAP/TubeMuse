// eMails：列出 Gmail 里当前打开的文章汇总邮件中的文章，评 0–10 分、给总体结论、按分数筛选，一键收藏并打标签。
// 这一页开着时才向邮件脚本要内容；只有点"评估"或"生成总体结论"才发给大模型。收藏只存在本机，链接在新标签页打开（不把正在看的邮件换掉）。

import { useState } from 'preact/hooks';
import { EMAIL } from '../../config/defaults';
import {
  EMAIL_MSG,
  bandCounts,
  digestStats,
  emailTagCounts,
  filterEmail,
  rankArticles,
  sanitizeArticle,
  scoreBand,
  verdictFacts,
  verdictHeadline,
  verdictKey,
  type EmailArticle,
  type EmailBand,
  type EmailDigestStats,
  type EmailOp,
  type EmailRow,
  type EmailSavedArticle,
  type EmailTabState,
  type EmailVerdict,
} from '../../core/email';
import { formatCount } from '../../core/format';
import { applyEmail, concludeArticles, estimateEmailUsd, scoreArticles, type EmailScoreResult } from '../../services/email-service';
import type { AppError } from '../../services/errors';
import { stores } from '../../services/repo';
import { appCtx, asAppError, useStore } from '../shared/app';
import { ErrorBox, Notice, Spinner } from '../shared/components';
import { useActiveTabState } from '../shared/tab-state';
import { TagChips, TagEditor, TagFilterBar, TagManager } from '../shared/tags';

const BAND_NAMES: Record<EmailBand, string> = { read: '值得精读', maybe: '一般', skip: '建议跳过' };
const PROVIDERS = { anthropic: 'Anthropic', openai: 'OpenAI' } as const;

const run = (op: EmailOp): Promise<string | undefined> => applyEmail(appCtx(), op);

function ScoreBadge({ score, title }: { score: number | undefined; title?: string }) {
  if (score === undefined) return <span class="email-score none" title="还没有评估">–</span>;
  return (
    <span class={`email-score ${scoreBand(score)}`} data-testid="email-score" title={title ?? BAND_NAMES[scoreBand(score)]}>
      {score}
    </span>
  );
}

function metaParts(a: EmailArticle): string[] {
  return [
    ...(a.author ? [a.author] : []),
    ...(a.publication ? [a.publication] : []),
    ...(a.author || a.publication ? [] : [a.site]),
    ...(a.readMinutes !== undefined ? [`${a.readMinutes} 分钟`] : []),
    ...(a.claps !== undefined ? [`${formatCount(a.claps)} 掌声`] : []),
    ...(a.responses !== undefined ? [`${formatCount(a.responses)} 回应`] : []),
    ...(a.memberOnly ? ['会员文章'] : []),
  ];
}

/** 收藏上的标签：两个列表共用 */
function SavedTags({ item, onTag }: { item: EmailSavedArticle; onTag: (t: string) => void }) {
  return (
    <div class="xhs-tags">
      <TagChips tags={item.tags} onPick={onTag} onRemove={(t) => void run({ op: 'tags', id: item.id, add: [], remove: [t] })} />
      <TagEditor onAdd={(add) => run({ op: 'tags', id: item.id, add, remove: [] })} />
    </div>
  );
}

function ArticleCard({ row, saved, onTag, onRemove, onError }: { row: EmailRow; saved: EmailSavedArticle | undefined; onTag: (t: string) => void; onRemove: (item: EmailSavedArticle) => void; onError: (e: string | undefined) => void }) {
  const { article: a, score } = row;
  const save = async () => onError(await run({ op: 'save', article: a, ...(score ? { score: { score: score.score, reason: score.reason } } : {}), tags: [] }));
  return (
    <li class="card email-item" data-testid="email-item" data-band={score ? scoreBand(score.score) : 'none'}>
      <div class="email-head">
        <ScoreBadge score={score?.score} {...(score ? { title: `${BAND_NAMES[scoreBand(score.score)]} · ${score.model} 评于 ${new Date(score.at).toLocaleDateString('zh-CN')}` } : {})} />
        <a class="xhs-title" href={a.url} target="_blank" rel="noopener noreferrer" data-testid="email-title">
          {a.title} ↗
        </a>
      </div>
      <div class="muted small xhs-meta">
        {metaParts(a).map((p) => (
          <span>{p}</span>
        ))}
      </div>
      {a.excerpt && <p class="small email-excerpt">{a.excerpt}</p>}
      {score && (
        <p class="small email-reason" data-testid="email-reason">
          {score.reason}
        </p>
      )}
      {saved && <SavedTags item={saved} onTag={onTag} />}
      <div class="xhs-actions">
        {saved ? (
          <button class="btn small" data-testid="email-unsave" onClick={() => onRemove(saved)}>
            ★ 已收藏
          </button>
        ) : (
          <button class="btn small" data-testid="email-save" onClick={() => void save()}>
            ☆ 收藏
          </button>
        )}
      </div>
    </li>
  );
}

function Sent({ r }: { r: EmailScoreResult }) {
  if (!r.asked && r.verdict !== 'written') return <>这些文章都评过了，没有发给大模型。</>;
  const cost = `（${r.model}，约 $${r.usd.toFixed(4)}${r.estimatedPrice ? '，这个模型不在价格表里，按最贵一档估算' : ''}）`;
  if (!r.asked) return <>写好了总体结论{cost}。</>;
  return (
    <>
      评完 {r.scored} 篇{r.verdict === 'written' ? '并写好了总体结论' : ''}
      {cost}
      {r.cached > 0 && `，${r.cached} 篇用了之前的评分`}。
      {r.missing > 0 && ` 还有 ${r.missing} 篇大模型没有给出分数：再点一次"评估"。`}
    </>
  );
}

/** 总体结论。分数分布由本地算，一定有；大模型写的那段没有时（之前评的、上次没写成）可以单独生成 */
function VerdictPanel({ stats, verdict, busy, onConclude }: { stats: EmailDigestStats; verdict: EmailVerdict | undefined; busy: boolean; onConclude: () => void }) {
  return (
    <section class="panel email-verdict" data-testid="email-verdict" data-none={stats.counts.read === 0 ? 'true' : undefined}>
      <div class="email-verdict-head">
        <span class="muted small">总体结论</span>
        <strong data-testid="email-verdict-headline">{verdictHeadline(stats)}</strong>
      </div>
      <p class="small muted email-verdict-text" data-testid="email-verdict-facts">
        {verdictFacts(stats)}
      </p>
      {verdict ? (
        <>
          <p class="small email-verdict-text" data-testid="email-verdict-summary">
            {verdict.summary}
          </p>
          {verdict.whyNone && (
            <p class="small email-verdict-text" data-testid="email-verdict-why">
              <strong>为什么一篇都没有：</strong>
              {verdict.whyNone}
            </p>
          )}
          <p class="muted small email-verdict-text">{verdict.model} 写于 {new Date(verdict.at).toLocaleDateString('zh-CN')}，只根据标题、摘要和分数，没有读正文。</p>
        </>
      ) : (
        !busy && (
          <div class="row email-actions">
            <button class="btn small" data-testid="email-conclude" onClick={onConclude}>
              生成总体结论
            </button>
            <span class="muted small">{stats.counts.read === 0 ? '让大模型说说为什么一篇都没有。' : '让大模型概述这一封的整体质量。'}不重新打分。</span>
          </div>
        )
      )}
    </section>
  );
}

function CurrentMail({ onTag, onRemove, onError }: { onTag: (t: string) => void; onRemove: (item: EmailSavedArticle) => void; onError: (e: string | undefined) => void }) {
  const settings = useStore(stores.settings);
  const scores = useStore(stores.emailScores);
  const verdicts = useStore(stores.emailVerdicts);
  const saved = useStore(stores.emailSaved);
  const { state: tab } = useActiveTabState<EmailTabState>(EMAIL_MSG.getState, EMAIL_MSG.state, EMAIL.pollMs);
  const [band, setBand] = useState<'all' | EmailBand>('all');
  const [progress, setProgress] = useState<string>();
  const [result, setResult] = useState<EmailScoreResult>();
  const [error, setError] = useState<AppError>();
  if (!settings || !scores || !verdicts || !saved || tab === undefined) return null;
  if (tab === null) {
    return (
      <p class="muted small" data-testid="email-no-script">
        当前标签页不是 Gmail。打开 Gmail，点开一封文章汇总邮件（比如 Medium Daily Digest）。如果已经在 Gmail 里，刷新一下页面：页面可能是在 TubeMuse 安装或更新之前打开的。
      </p>
    );
  }
  if (tab.page === 'none') {
    return (
      <p class="muted small" data-testid="email-no-mail">
        Gmail 里还没有打开的邮件：点开一封文章汇总邮件（比如 Medium Daily Digest）。
      </p>
    );
  }
  if (tab.page === 'unreadable') {
    return (
      <Notice kind="warn">
        <span data-testid="email-unreadable">看得到打开了邮件"{tab.subject}"，但读不到正文：Gmail 可能改版了，TubeMuse 要跟着改（content/email.ts 里的 GMAIL）。</span>
      </Notice>
    );
  }
  const articles = tab.articles.map(sanitizeArticle).filter((a): a is EmailArticle => !!a);
  const heading = (
    <div class="email-mail" data-testid="email-mail">
      <div class="email-subject">{tab.subject || '（无主题）'}</div>
      <div class="muted small" data-testid="email-found">
        {tab.sender ? `${tab.sender} · ` : ''}
        {articles.length ? `找到 ${articles.length} 篇文章` : '没有找到文章列表'}
      </div>
    </div>
  );
  if (!articles.length) {
    return (
      <>
        {heading}
        <p class="muted small" data-testid="email-no-articles">
          这封邮件不像文章汇总，或者版式 TubeMuse 还不认识。邮件内容没有发给大模型。
        </p>
      </>
    );
  }
  const rows = rankArticles(articles, scores);
  const counts = bandCounts(rows);
  const scoredCount = counts.read + counts.maybe + counts.skip;
  const unscored = articles.length - scoredCount;
  const shown = band === 'all' ? rows : rows.filter((r) => r.score && scoreBand(r.score.score) === band);
  const verdict = verdicts[verdictKey(rows)];
  // 还有没评的文章时，分数分布说明不了这封邮件（大模型漏评、已经写过结论的除外）
  const showVerdict = scoredCount > 0 && (unscored === 0 || !!verdict);
  const provider = PROVIDERS[settings.llm.provider];
  const evaluate = async (force: boolean) => {
    setError(undefined);
    setResult(undefined);
    setProgress(`正在评估（0/${force ? articles.length : unscored}）…`);
    try {
      const r = await scoreArticles(appCtx(), articles, { force, onProgress: (done, total) => setProgress(done < total ? `正在评估（${done}/${total}）…` : '正在写总体结论…') });
      setResult(r);
      if (r.verdict === 'failed') setError(await asAppError(r.verdictError));
    } catch (e) {
      setError(await asAppError(e));
    } finally {
      setProgress(undefined);
    }
  };
  const conclude = async () => {
    setError(undefined);
    setResult(undefined);
    setProgress('正在写总体结论…');
    try {
      setResult(await concludeArticles(appCtx(), articles));
    } catch (e) {
      setError(await asAppError(e));
    } finally {
      setProgress(undefined);
    }
  };
  return (
    <>
      {heading}
      {tab.clipped && (
        <Notice kind="warn">
          <span data-testid="email-clipped">Gmail 把这封邮件截断了，后面的文章读不到：点邮件底部的"查看完整邮件"，或者只评前面这些。</span>
        </Notice>
      )}
      {progress ? (
        <Spinner label={progress} />
      ) : (
        <div class="row email-actions">
          {unscored > 0 ? (
            <button class="btn primary" data-testid="email-evaluate" onClick={() => void evaluate(false)}>
              评估{scoredCount > 0 ? '剩下的' : '这'} {unscored} 篇
            </button>
          ) : (
            <button class="btn" data-testid="email-reevaluate" onClick={() => void evaluate(true)}>
              重新评估
            </button>
          )}
        </div>
      )}
      {unscored > 0 && (
        <p class="muted small" data-testid="email-estimate">
          用 {estimateEmailUsd(settings, unscored).model} 评 {unscored} 篇并写结论，预计约 ${estimateEmailUsd(settings, unscored).usd.toFixed(4)}（估算）；每日大模型预算 ${settings.llm.dailyBudgetUsd.toFixed(2)}。
        </p>
      )}
      <p class="muted small" data-testid="email-disclosure">
        点"评估"后，文章的标题、摘要、作者、刊物、站点名、阅读时长和互动数发给 {provider}；评完再把每篇的标题、分数和理由发过去，写总体结论。不发邮件主题、发件人、收件人和链接。大模型没有读正文，分数和结论都只是预判。
      </p>
      {result && (
        <Notice kind="info" onClose={() => setResult(undefined)}>
          <span data-testid="email-result">
            <Sent r={result} />
          </span>
        </Notice>
      )}
      {error && <ErrorBox error={error} onClose={() => setError(undefined)} />}
      {showVerdict && <VerdictPanel stats={digestStats(rows)} verdict={verdict} busy={!!progress} onConclude={() => void conclude()} />}
      {scoredCount > 0 && (
        <div class="seg" role="group" aria-label="按分数筛选" data-testid="email-bands">
          {(
            [
              ['all', `全部 ${rows.length}`],
              ['read', `${BAND_NAMES.read} ${counts.read}`],
              ['maybe', `${BAND_NAMES.maybe} ${counts.maybe}`],
              ['skip', `${BAND_NAMES.skip} ${counts.skip}`],
            ] as const
          ).map(([k, label]) => (
            <button class={`seg-btn${band === k ? ' on' : ''}`} aria-pressed={band === k} onClick={() => setBand(k)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {shown.length ? (
        <ul class="cards" data-testid="email-list">
          {shown.map((r) => (
            <ArticleCard key={r.article.id} row={r} saved={saved.articles[r.article.id]} onTag={onTag} onRemove={onRemove} onError={onError} />
          ))}
        </ul>
      ) : (
        <p class="muted small" data-testid="email-band-empty">
          {band === 'read' && showVerdict ? '这封邮件没有值得精读的文章，原因见上面的总体结论。' : '这一档没有文章。'}
        </p>
      )}
    </>
  );
}

function SavedItem({ item, onTag, onRemove }: { item: EmailSavedArticle; onTag: (t: string) => void; onRemove: () => void }) {
  return (
    <li class="card email-item" data-testid="email-saved-item">
      <div class="email-head">
        <ScoreBadge score={item.score} />
        <a class="xhs-title" href={item.url} target="_blank" rel="noopener noreferrer">
          {item.title} ↗
        </a>
      </div>
      <div class="muted small xhs-meta">
        {metaParts(item).map((p) => (
          <span>{p}</span>
        ))}
        <span>收藏于 {new Date(item.savedAt).toLocaleDateString('zh-CN')}</span>
      </div>
      {item.reason && <p class="small email-reason">{item.reason}</p>}
      <SavedTags item={item} onTag={onTag} />
      <div class="xhs-actions">
        <button class="btn small" data-testid="email-remove" onClick={onRemove}>
          移出收藏
        </button>
      </div>
    </li>
  );
}

export function EmailView() {
  const settings = useStore(stores.settings);
  const saved = useStore(stores.emailSaved);
  const [mode, setMode] = useState<'mail' | 'saved'>('mail');
  const [tag, setTag] = useState<string>();
  const [q, setQ] = useState('');
  const [manage, setManage] = useState(false);
  const [removed, setRemoved] = useState<EmailSavedArticle>();
  const [error, setError] = useState<string>();
  if (!settings || !saved) return null;
  if (!settings.email.enabled) return <Notice kind="warn">eMails 已在设置里关闭（设置页"16. eMails"）。关闭时不读邮件，已有收藏保留。</Notice>;
  const total = Object.keys(saved.articles).length;
  const tags = emailTagCounts(saved);
  const list = filterEmail(saved, { ...(tag ? { tag } : {}), q });
  const remove = async (item: EmailSavedArticle) => {
    const e = await run({ op: 'remove', id: item.id });
    setError(e);
    if (!e) setRemoved(item);
  };
  const restore = async () => {
    if (!removed) return;
    setError(await run({ op: 'restore', item: removed }));
    setRemoved(undefined);
  };
  const pickTag = (t: string) => {
    setTag(t);
    setMode('saved');
  };
  return (
    <div class="xhs" data-testid="email-view">
      <p class="muted small">在 Gmail 里打开文章汇总邮件（比如 Medium Daily Digest），这里列出里面的文章、给每篇打 0–10 分，帮你挑出值得精读的、跳过低质内容。这一页开着时才读邮件，收藏只存在本机。</p>
      <div class="seg" role="group" aria-label="eMails 内容">
        {(
          [
            ['mail', '当前邮件'],
            ['saved', `收藏 ${total}`],
          ] as const
        ).map(([k, label]) => (
          <button class={`seg-btn${mode === k ? ' on' : ''}`} aria-pressed={mode === k} data-testid={`email-mode-${k}`} onClick={() => setMode(k)}>
            {label}
          </button>
        ))}
      </div>
      {removed && (
        <Notice kind="info" onClose={() => setRemoved(undefined)}>
          已移出"{removed.title}"。
          <button class="btn link small" data-testid="email-undo" onClick={() => void restore()}>
            撤销
          </button>
        </Notice>
      )}
      {error && (
        <Notice kind="warn" onClose={() => setError(undefined)}>
          {error}
        </Notice>
      )}
      {mode === 'mail' ? (
        <CurrentMail onTag={pickTag} onRemove={(item) => void remove(item)} onError={setError} />
      ) : (
        <>
          <input class="input xhs-search" type="search" placeholder="搜标题、作者、刊物、标签" aria-label="搜索收藏的文章" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
          {tags.length > 0 && <TagFilterBar tags={tags} active={tag} onPick={setTag} manage={manage} onToggleManage={() => setManage(!manage)} testId="email-tag-filter" />}
          {manage && (
            <section class="panel">
              <TagManager
                tags={tags}
                empty="还没有标签：在收藏的文章上加。"
                testId="email-tag-manager"
                onRename={(from, to) => run({ op: 'renameTag', from, to })}
                onDelete={(t) => run({ op: 'deleteTag', tag: t })}
                onRenamed={(from, to) => tag === from && setTag(to)}
              />
            </section>
          )}
          {list.length ? (
            <ul class="cards" data-testid="email-saved-list">
              {list.map((item) => (
                <SavedItem key={item.id} item={item} onTag={setTag} onRemove={() => void remove(item)} />
              ))}
            </ul>
          ) : (
            <p class="muted small" data-testid="email-saved-empty">
              {total === 0 ? '还没有收藏。在"当前邮件"里点文章下面的"收藏"。' : '没有符合筛选条件的收藏。'}
            </p>
          )}
        </>
      )}
    </div>
  );
}
