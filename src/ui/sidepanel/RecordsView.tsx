// 记录：今天（或某一天）真正看了什么、学习/娱乐判定（可纠正）、近 7 天占比、每日总结与每周自省、导出记忆库。

import { useEffect, useMemo, useState } from 'preact/hooks';
import { YOUTUBE_CATEGORIES } from '../../config/defaults';
import { weekEndingOn } from '../../core/schedule';
import { renderMemoryLibrary } from '../../core/summary';
import { formatSpan } from '../../core/format';
import { dayKey, formatDuration, formatRelative } from '../../core/time';
import { NATURE_LABELS, WATCH_STATUS_LABELS, type DailySummary, type Nature, type NatureVerdict, type VideoMeta, type WatchRecord, type WeeklyReport, type WindowStats } from '../../core/types';
import type { AppError } from '../../services/errors';
import { stores } from '../../services/repo';
import { checkReminder } from '../../services/reminder-service';
import { generateDailySummary, generateWeeklyReport } from '../../services/summary-service';
import { correctNature, currentWindowStats, dayEntries } from '../../services/watch-service';
import { appCtx, asAppError, useStore } from '../shared/app';
import { ErrorBox, Notice, Spinner } from '../shared/components';
import { downloadText, openInCurrentTab } from '../shared/download';

type Entry = { record: WatchRecord; meta?: VideoMeta; nature: Nature; verdict: NatureVerdict };

function WatchRow({ e, onCorrect }: { e: Entry; onCorrect: (nature: Nature | null, scope: 'video' | 'channel') => void }) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<Nature>(e.nature);
  const r = e.record;
  const title = e.meta && !e.meta.missing ? e.meta.title : e.meta?.missing ? '（视频已不可见）' : `（还没取到标题）${r.videoId}`;
  const cat = e.meta?.categoryId ? YOUTUBE_CATEGORIES[e.meta.categoryId]?.name : undefined;
  return (
    <li class="watch-row" data-video-id={r.videoId} data-status={r.status} data-nature={e.nature}>
      <a
        class="title"
        href={`https://www.youtube.com/watch?v=${r.videoId}`}
        onClick={(ev) => {
          ev.preventDefault();
          openInCurrentTab(r.videoId);
        }}
      >
        {title}
      </a>
      <div class="meta muted">
        {e.meta?.channelTitle && <span>{e.meta.channelTitle} · </span>}
        {r.durationSec > 0 && <span>时长 {formatDuration(Math.round(r.durationSec))} · </span>}
        看了 {Math.max(1, Math.round(r.playSec / 60))} 分钟{r.status !== 'glance' ? ` · 完成 ${Math.round(r.completion * 100)}%` : ''}
      </div>
      <div class="badges">
        <span class={`badge st-${r.status}`}>
          {WATCH_STATUS_LABELS[r.status]}
          {r.status === 'glance' && r.playSec < 60 ? `（${Math.round(r.playSec)} 秒）` : ''}
        </span>
        <span class={`badge nat-${e.nature}`} title={e.verdict.reasons.join('\n')}>
          {NATURE_LABELS[e.nature]}
          {e.verdict.source !== 'signals' ? '（你纠正过）' : ''}
        </span>
        {r.background && <span class="badge bg">后台收听</span>}
        {r.shorts && <span class="badge">Shorts</span>}
        <button class="btn link small" onClick={() => setOpen(!open)}>
          {open ? '收起' : '判定依据 / 纠正'}
        </button>
      </div>
      {open && (
        <div class="verdict">
          <ul>
            {e.verdict.reasons.map((x) => (
              <li>{x}</li>
            ))}
            {cat && <li class="muted">YouTube 分类：{cat}</li>}
          </ul>
          <div class="row wrap">
            <select class="input small" value={pick} onChange={(ev) => setPick(ev.currentTarget.value as Nature)}>
              {(['learning', 'entertainment', 'other'] as Nature[]).map((n) => (
                <option value={n}>{NATURE_LABELS[n]}</option>
              ))}
            </select>
            <button class="btn small" data-scope="video" onClick={() => onCorrect(pick, 'video')}>
              只改这条
            </button>
            <button class="btn small" data-scope="channel" disabled={!e.meta?.channelId} onClick={() => onCorrect(pick, 'channel')}>
              这个频道都算{NATURE_LABELS[pick]}
            </button>
            {e.verdict.source !== 'signals' && (
              <button class="btn link small" onClick={() => onCorrect(null, e.verdict.source === 'user_channel' ? 'channel' : 'video')}>
                撤销纠正
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function SummaryCard({ s }: { s: DailySummary }) {
  const [open, setOpen] = useState(false);
  const list = (title: string, items: DailySummary['learned']) => (
    <>
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((i) => (
            <li>
              <strong>{i.title}</strong>
              {i.channelTitle ? `（${i.channelTitle}）` : ''} — {i.text}
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted small">（没有）</p>
      )}
    </>
  );
  return (
    <li class="summary-card" data-day={s.day}>
      <div class="row">
        <button class="btn link" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} {s.day}
        </button>
        <span class="summary-headline">{s.headline}</span>
      </div>
      {open && (
        <div class="summary-body">
          <p class="muted small">
            看了 {s.stats.videos} 个（看完 {s.stats.completed} · 部分 {s.stats.partial} · 瞥一眼 {s.stats.glance}
            {s.stats.background ? ` · 后台收听 ${s.stats.background}` : ''}），有效观看 {s.stats.playMinutes} 分钟
          </p>
          {list('今日学了什么', s.learned)}
          {list('值得回看', s.revisit)}
          {list('只是路过', s.passingBy)}
          <h3>与近期目标的关联</h3>
          <p>{s.goalLink}</p>
          {s.notes.length > 0 && <p class="muted small">说明：{s.notes.join('；')}</p>}
          {s.manual && <p class="muted small">这是手动生成的预览；到点后会按完整的一天重新生成。</p>}
          <button class="btn small" onClick={() => downloadText(`tubemuse-${s.day}.md`, s.markdown)}>
            导出这天（Markdown）
          </button>
        </div>
      )}
    </li>
  );
}

function WeeklyCard({ w }: { w: WeeklyReport }) {
  const [open, setOpen] = useState(false);
  return (
    <li class="summary-card">
      <div class="row">
        <button class="btn link" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} {w.fromDay} ~ {w.weekKey}
        </button>
        <span class="summary-headline">低分 {w.lowRatings} 次</span>
      </div>
      {open && (
        <div class="summary-body">
          {w.overview && <p>{w.overview}</p>}
          <h3>低分案例的共性</h3>
          {w.patterns.length ? (
            <ul>
              {w.patterns.map((p) => (
                <li>
                  <strong>{p.pattern}</strong>
                  {p.examples.length ? `（例：${p.examples.join('、')}）` : ''}
                  <div class="muted small">建议：{p.suggestion}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted small">{w.lowRatings ? '（案例太少，看不出共性）' : '（没有低分）'}</p>
          )}
          <h3>本周已自动调整了什么</h3>
          {w.adjustments.length ? (
            <ul>
              {w.adjustments.map((a) => (
                <li>{a}</li>
              ))}
            </ul>
          ) : (
            <p class="muted small">（没有调整）</p>
          )}
          <button class="btn small" onClick={() => downloadText(`tubemuse-week-${w.weekKey}.md`, w.markdown)}>
            导出（Markdown）
          </button>
        </div>
      )}
    </li>
  );
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

export function RecordsView() {
  const ctx = appCtx();
  const settings = useStore(stores.settings);
  const log = useStore(stores.watchLog);
  const metas = useStore(stores.videoMeta);
  const rules = useStore(stores.natureRules);
  const clusters = useStore(stores.clusters);
  const summaries = useStore(stores.summaries);
  const weeklies = useStore(stores.weeklyReports);
  const job = useStore(stores.jobState);
  const today = dayKey(ctx.now(), ctx.timeZone);
  const [day, setDay] = useState(today);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [stats, setStats] = useState<WindowStats>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<AppError>();

  useEffect(() => {
    void dayEntries(ctx, day).then(setEntries);
    if (settings) void currentWindowStats(ctx, settings.reminder.windowDays).then(setStats);
  }, [day, log, metas, rules, clusters, settings]);

  const days = useMemo(() => Object.keys(log ?? {}).sort().reverse().slice(0, 30), [log]);
  const summaryList = useMemo(() => Object.values(summaries ?? {}).sort((a, b) => (a.day < b.day ? 1 : -1)), [summaries]);
  const weeklyList = useMemo(() => Object.values(weeklies ?? {}).sort((a, b) => (a.weekKey < b.weekKey ? 1 : -1)), [weeklies]);
  const failures = Object.entries(job?.failures ?? {});
  const total = entries.reduce((s, e) => s + e.record.playSec, 0);

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

  if (!settings) return null;
  return (
    <div class="records">
      {!settings.tracking.enabled && (
        <Notice kind="warn">
          观看追踪已关闭。
          <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
            去设置开启
          </button>
        </Notice>
      )}
      <section class="panel">
        <div class="row">
          <h2>观看记录</h2>
          <select class="input small" value={day} onChange={(e) => setDay(e.currentTarget.value)} aria-label="选择日期">
            {!days.includes(today) && <option value={today}>今天 {today}</option>}
            {days.map((d) => (
              <option value={d}>{d === today ? `今天 ${d}` : d}</option>
            ))}
          </select>
        </div>
        <p class="muted small">
          只在 youtube.com 读取播放器状态：暂停、广告、拖动进度条都不计入；后台标签页里的播放照常计入并标为"后台收听"。
        </p>
        {entries.length ? (
          <>
            <p class="small">
              {entries.length} 个视频 · 有效观看 {Math.round(total / 60)} 分钟
            </p>
            <ol class="watch-list">
              {entries.map((e) => (
                <WatchRow key={e.record.videoId} e={e} onCorrect={(n, scope) =>
                    void run('correct', async () => {
                      await correctNature(ctx, e.record.videoId, n, scope);
                      // 纠正会改变学习/娱乐占比：立刻重新评估提醒
                      await checkReminder(ctx);
                    })
                  } />
              ))}
            </ol>
          </>
        ) : (
          <p class="muted">这一天还没有观看记录。</p>
        )}
      </section>

      {stats && (
        <section class="panel" data-testid="window-stats">
          <h2>最近 {settings.reminder.windowDays} 天</h2>
          <div class="ratio-bar" aria-label="学习娱乐占比">
            <span class="r-learn" style={{ width: pct(stats.learningRatio) }} />
            <span class="r-fun" style={{ width: pct(stats.entertainmentRatio) }} />
          </div>
          <p class="small">
            共 {formatSpan(stats.totalSec)} · 学习 {pct(stats.learningRatio)} · 娱乐 {pct(stats.entertainmentRatio)} · 其他{' '}
            {pct(stats.totalSec ? stats.otherSec / stats.totalSec : 0)}
          </p>
          <p class="muted small">
            按有效观看时长计算。娱乐 &gt; {pct(settings.reminder.entertainmentRatio)} 且学习 &lt; {pct(settings.reminder.learningRatio)} 时会在侧边栏顶部轻声提醒一次（两次至少间隔{' '}
            {settings.reminder.minGapDays} 天）。判定不对可以在上面逐条纠正。
          </p>
        </section>
      )}

      <section class="panel">
        <h2>每日总结</h2>
        <p class="muted small">
          每天 {settings.summary.time} 自动生成{settings.summary.enabled ? '' : '（已关闭）'}；浏览器那时没开的话，下次打开时补上（最多补 7 天）。
        </p>
        <div class="row wrap">
          <button class="btn" disabled={!!busy} onClick={() => run('daily', () => generateDailySummary(ctx, day, { manual: day === today }))}>
            {day === today ? '现在生成今天的总结（预览）' : `生成 ${day} 的总结`}
          </button>
          <button
            class="btn"
            disabled={!summaryList.length}
            onClick={() => downloadText(`tubemuse-memory-${today}.md`, renderMemoryLibrary(summaryList, weeklyList, ctx.now()))}
          >
            导出记忆库（Markdown）
          </button>
        </div>
        {busy === 'daily' && <Spinner label="正在生成总结…" />}
        {error && <ErrorBox error={error} onClose={() => setError(undefined)} />}
        {failures.length > 0 && (
          <Notice kind="warn">
            有 {failures.length} 个定时任务没完成：
            <ul class="small">
              {failures.map(([key, f]) => (
                <li>
                  {key.replace('daily:', '每日总结 ').replace('weekly:', '周报 ')}（{formatRelative(f.at, ctx.now())}）：{f.message}
                  {f.hint ? `。${f.hint}` : ''}
                </li>
              ))}
            </ul>
          </Notice>
        )}
        <ul class="summary-list">
          {summaryList.map((s) => (
            <SummaryCard key={s.day} s={s} />
          ))}
        </ul>
      </section>

      <section class="panel">
        <h2>每周自省</h2>
        <p class="muted small">
          每周{'日一二三四五六'[settings.weekly.weekday]} {settings.summary.time} 自动生成{settings.weekly.enabled ? '' : '（已关闭）'}：低分案例有什么共性、这周系统据你的打分自动改了什么。
        </p>
        <button class="btn" disabled={!!busy} onClick={() => run('weekly', () => generateWeeklyReport(ctx, weekEndingOn(today, settings.weekly.weekday)))}>
          生成本周（到今天为止）的自省报告
        </button>
        {busy === 'weekly' && <Spinner label="正在生成周报…" />}
        <ul class="summary-list">
          {weeklyList.map((w) => (
            <WeeklyCard key={w.weekKey} w={w} />
          ))}
        </ul>
      </section>
    </div>
  );
}
