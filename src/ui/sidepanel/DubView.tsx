// 「配音」页（DECISIONS §74、§75）：给当前 YouTube 视频关联一个本地中文配音（.m4a），开 / 关，调偏移、加对齐点，移除；管理所有关联过的视频。
// "保存完整双语视频"（DECISIONS §83）：你选原视频文件（MP4），在这个页面里离线合成（画面照搬，声音换成双语混音），不用播放。
// 勾了"带上原声字幕"时（DECISIONS §84）把原声语言的字幕写成视频里一条可以开关的字幕轨。
// 还有侧边栏顶部的一行提示（DubPrompt）：当前视频有中文配音、还没开启时显示。
// 状态来自注入 YouTube 页面的配音脚本（只在本扩展内部传递）；对应关系在本机存储，音频在扩展自己的 IndexedDB。

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DUB } from '../../config/defaults';
import { formatTimecode } from '../../core/clips';
import { formatClock } from '../../core/time';
import {
  DUB_MSG,
  DubFileError,
  clampDelay,
  delayText,
  dubMapOf,
  durationNote,
  formatBytes,
  formatClockSec,
  misorderedAnchors,
  quickAlignSuggestion,
  rateExactText,
  rateText,
  rateWord,
  segmentOffsetText,
  withSegmentOffset,
  type DubMark,
  type DubRecord,
  type DubTabState,
  type QuickAlignSuggestion,
} from '../../core/dub';
import { quickFormulaText } from '../../core/dub-align';
import { exportSupported } from '../../services/dub-export';
import { addDubAnchor, attachDub, checkDubStorage, removeDub, removeDubAnchor, setDubQuickRate, setDubSegmentOffset } from '../../services/dub-service';
import { stores } from '../../services/repo';
import { appCtx, asAppError, useStore } from '../shared/app';
import { DubAlignMap, DubGapReadout, useDubAlignNow } from './DubAlignMap';
import { DubSubtitles } from './DubSubtitles';
import { DubTransport } from './DubTransport';
import { SUB_SOURCE_LABELS } from '../../core/subtitle-track';
import { exportJob, useExportJob, type ExportJob } from './dub-export-job';
import { Notice } from '../shared/components';
import { openInCurrentTab } from '../shared/download';
import { useActiveTabState } from '../shared/tab-state';

type Problem = { message: string; hint?: string };

async function toProblem(e: unknown): Promise<Problem> {
  if (e instanceof DubFileError) return { message: e.message, ...(e.hint ? { hint: e.hint } : {}) };
  const err = await asAppError(e);
  return { message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
}

function ProblemBox({ problem, onClose }: { problem: Problem; onClose?: () => void }) {
  return (
    <div class="notice notice-error" role="alert" data-testid="dub-error">
      <div class="notice-body">
        <strong>{problem.message}</strong>
        {problem.hint && <div class="muted">{problem.hint}</div>}
      </div>
      {onClose && (
        <button class="icon-btn" title="关闭" onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
}

async function toggleDub(tabId: number | undefined, on: boolean): Promise<void> {
  if (tabId === undefined) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: DUB_MSG.toggle, on });
  } catch {
    // 页面已关闭或换走：状态会随标签页事件刷新
  }
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function volumeText(v: NonNullable<DubTabState['volume']>, phase: DubTabState['phase']): string {
  if (v.blocked) return `YouTube 一直把音量改回 ${pct(v.user)}：原声没有降低（配音照常）。关掉再开启配音会再试一次。`;
  if (v.ducked) return `你的音量 ${pct(v.user)} → 现在 ${pct(v.now)}（原声降 20%）${v.muted ? '；YouTube 正在静音' : ''}`;
  if (phase === 'ready') return `${pct(v.now)}（广告期间恢复原来的音量）`;
  return `${pct(v.now)}（配音放起来后降 20%）`;
}

/** 侧边栏 → 配音脚本：某一段的实时偏移（拖动"中文位置"时），回复脚本算好后的状态 */
async function previewSegment(tabId: number | undefined, msg: { videoId: string; segment: number; offset?: number; dubAt?: number }): Promise<DubTabState | undefined> {
  if (tabId === undefined) return undefined;
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: DUB_MSG.setDelay, ...msg })) as DubTabState | undefined;
  } catch {
    return undefined;
  }
}

/** 中文是怎么叠上去的（和开着配音播放时一样）：快速对齐的倍速，或开头的偏移加对齐点 */
const alignSummary = (rec: DubRecord): string => {
  if (rec.quickRate !== undefined) return `中文按快速对齐的 ${rateText(rec.quickRate)} ${rateWord(rec.quickRate)}叠上去（音调不变）`;
  const n = rec.anchors?.length ?? 0;
  return `中文按开头的偏移和${n ? `全部 ${n} 个对齐点` : '现在的对齐'}叠上去`;
};

const secondsUsed = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`);

/** 一次合成的状态：正在读文件 / 时长对不上等确认 / 正在合成（进度）/ 做完了 / 出错 / 已取消 */
function ExportStatus({ job, withTitle }: { job: ExportJob; withTitle?: boolean }) {
  const subsRef = useRef<HTMLInputElement>(null);
  const src = job.source;
  const sourceLine = src ? `${job.sourceName} · ${formatBytes(job.sourceBytes)} · ${formatTimecode(Math.round(src.durationSec))} · 画面 ${src.video.label} ${src.video.width}×${src.video.height} · 原声 ${src.audio.label}` : `${job.sourceName} · ${formatBytes(job.sourceBytes)}`;
  return (
    <div class="clip-ready" data-testid="dub-export" data-phase={job.phase}>
      {withTitle && <strong>完整双语视频：{job.title}</strong>}
      <div class="muted small clip-file" data-testid="dub-export-source">
        原视频：{sourceLine}
      </div>
      {job.phase === 'checking' && <p class="small">正在读这个文件的索引…</p>}
      {job.phase === 'subs' && (
        <p class="small" data-testid="dub-export-subs-wait">
          正在准备原声字幕…（从 YouTube 页面取的时候，播放器的字幕可能闪一下：是请它打开一次字幕、拿到后立刻关回去）
        </p>
      )}
      {job.phase === 'need-subs' && (
        <>
          <p class="small warn-text" data-testid="dub-export-need-subs">
            你勾了"带上原声字幕"，但没有找到字幕：{job.subtitlesProblem}。选一个字幕文件（.srt / .vtt），或者这一次不带字幕。
          </p>
          <input
            type="file"
            accept=".srt,.vtt,text/vtt,application/x-subrip"
            hidden
            ref={subsRef}
            data-testid="dub-export-subs-file"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (f) void exportJob.provideSubtitleFile(f);
            }}
          />
          <div class="row wrap">
            <button class="btn primary" data-testid="dub-export-subs-pick" onClick={() => subsRef.current?.click()}>
              选字幕文件…
            </button>
            <button class="btn" data-testid="dub-export-subs-skip" onClick={() => void exportJob.skipSubtitles()}>
              不带字幕，继续合成
            </button>
            <button class="btn" onClick={() => exportJob.cancel()}>
              取消
            </button>
          </div>
        </>
      )}
      {job.phase === 'confirm' && src && (
        <>
          <p class="small warn-text" data-testid="dub-export-mismatch">
            这个文件长 {formatTimecode(Math.round(src.durationSec))}，YouTube 上这个视频是 {formatTimecode(Math.round(job.expectedSec ?? 0))}，差 {Math.abs(src.durationSec - (job.expectedSec ?? 0)).toFixed(1)}{' '}
            秒。对齐是按 YouTube 上的视频时间标的：用别的版本（剪过的、另一次上传的）合成，中文会对不上。先确认是不是选错了文件。
          </p>
          <div class="row">
            <button class="btn" data-testid="dub-export-confirm" onClick={() => void exportJob.confirm()}>
              仍然合成
            </button>
            <button class="btn" onClick={() => exportJob.cancel()}>
              取消
            </button>
          </div>
        </>
      )}
      {job.phase === 'mixing' && (
        <>
          <div class="clip-timer">
            <span class="rec-dot" aria-hidden="true" />
            <span data-testid="dub-export-progress">{formatTimecode(Math.floor(job.doneSec))}</span>
            {src && <span class="muted"> / {formatTimecode(Math.round(src.durationSec))}</span>}
            <span class="muted"> · 已用 {secondsUsed(Date.now() - job.startedAt)}</span>
          </div>
          {src && <progress class="clip-progress" max={src.durationSec} value={Math.min(job.doneSec, src.durationSec)} />}
          <p class="muted small">正在本机合成：解码原声和中文、混音、重新编码成一条音轨；画面不动。可以切到别的标签页或侧边栏别的页，别关侧边栏。</p>
          <div class="row">
            <button class="btn" data-testid="dub-export-cancel" onClick={() => exportJob.cancel()}>
              取消
            </button>
          </div>
        </>
      )}
      {job.phase === 'done' && job.result && (
        <>
          <strong class="clip-file" data-testid="dub-export-file">
            {job.result.fileName}
          </strong>
          <div class="small" data-testid="dub-export-done">
            合成好了：全片 {formatTimecode(Math.round(job.result.durationSec))} · {formatBytes(job.result.bytes)} · 画面原样照搬 · 声音 {job.result.audioLabel}（原声降 20% + 中文 {job.result.pieces} 段）· 用时{' '}
            {secondsUsed(job.result.elapsedMs)}
          </div>
          {job.result.audioCodec === 'opus' && (
            <p class="small warn-text" data-testid="dub-export-opus">
              {job.result.aacFailed ? `AAC 编码器出错了（${job.result.aacFailed}），改用 Opus 重新合成了一遍。` : '这个浏览器编不了 AAC，声音用的是 Opus。'}
              浏览器、VLC、mpv、IINA 能正常播放；Windows 自带的播放器、QuickTime 和一些手机可能放出来没有声音。
            </p>
          )}
          {job.result.subtitles && (
            <p class="small" data-testid="dub-export-subs">
              原声字幕：{job.result.subtitles.count} 句，{SUB_SOURCE_LABELS[job.result.subtitles.source]}（{job.result.subtitles.label}）。写成了视频里的一条字幕轨，默认开着、可以关：VLC、mpv、IINA、QuickTime
              和手机自带的播放器认它；浏览器直接打开 mp4、Windows 自带的播放器可能不显示——这时点"另存字幕（.srt）"，和视频放在同一个文件夹里（同名），播放器会自动加载。
            </p>
          )}
          {job.result.subtitlesEmpty && (
            <p class="small warn-text" data-testid="dub-export-subs-empty">
              找到的字幕里没有一句落在这个视频的时长以内，没有写进去。
            </p>
          )}
          {!job.result.subtitles && !job.result.subtitlesEmpty && (
            <p class="small muted" data-testid="dub-export-no-subs">
              这一份没有带字幕。
            </p>
          )}
          <p class="small" data-testid="dub-export-saved">
            已在 {formatClock(job.result.savedAt)} 交给浏览器存进下载文件夹。保存完之前别挪动、别删你选的那个原视频文件（新文件里的画面是从它那里直接写过去的）。没看到文件？浏览器可能拦下了下载：点"再存一次"。
          </p>
          <div class="row">
            <button class="btn" data-testid="dub-export-again" onClick={() => exportJob.saveAgain()}>
              再存一次
            </button>
            {job.result.subtitles && (
              <button class="btn" data-testid="dub-export-srt" onClick={() => exportJob.saveSubtitles()}>
                另存字幕（.srt）
              </button>
            )}
            <button class="btn" onClick={() => exportJob.clear()}>
              收起
            </button>
          </div>
        </>
      )}
      {job.phase === 'error' && job.error && <ProblemBox problem={job.error} onClose={() => exportJob.clear()} />}
      {job.phase === 'cancelled' && (
        <div class="row">
          <span class="small" data-testid="dub-export-cancelled">
            已取消，没有生成文件。
          </span>
          <button class="btn link small" onClick={() => exportJob.clear()}>
            收起
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 保存完整双语视频（用户 2026-11-16 选定的做法，DECISIONS §83）：你选这个视频的原视频文件（MP4），在这个页面里离线合成——
 * 画面原样照搬，声音换成"原声降 20% + 按现在的对齐叠上去的中文"，做完自动存进下载文件夹。不播放、不联网，一般不到一分钟
 */
function FullSave({ rec, missing, onPick, onYouTube }: { rec: DubRecord; missing: boolean; onPick: () => void; onYouTube: boolean }) {
  const ctx = appCtx();
  const settings = useStore(stores.settings);
  const job = useExportJob();
  const subsRef = useRef<HTMLInputElement>(null);
  const [subsProblem, setSubsProblem] = useState<string>();
  const mine = job?.videoId === rec.videoId ? job : undefined;
  const busy = exportJob.busy();
  const supported = exportSupported();
  const withSubs = settings?.dub.exportSubtitles ?? true;
  const chosen = exportJob.chosenSubtitleFile(rec.videoId);
  const blocked = !supported
    ? '这个浏览器没有音频编解码接口（WebCodecs），做不了离线合成：请用最新版 Google Chrome 或 Firefox。'
    : missing
      ? '本机的配音音频不见了：先在上面重新选择 .m4a 文件。'
      : busy && !mine
        ? `正在合成另一个视频（${job?.title ?? ''}），做完再来。`
        : undefined;
  const setWithSubs = (on: boolean) => void stores.settings.update(ctx.kv, ctx.locker, (x) => ({ ...x, dub: { ...x.dub, exportSubtitles: on } }));
  const onSubs = async (input: HTMLInputElement) => {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    setSubsProblem(undefined);
    try {
      await exportJob.chooseSubtitleFile(rec.videoId, f);
    } catch (e) {
      setSubsProblem(`「${f.name}」用不了：${exportJob.subtitleProblem(e)}`);
    }
  };
  return (
    <div class="dub-full" data-testid="dub-full">
      <div class="row">
        <strong>保存完整双语视频</strong>
      </div>
      <p class="muted small" data-testid="dub-full-about">
        选这个视频的原视频文件（MP4），TubeMuse 在本机直接合成，不用播放：画面原样照搬（不重新编码），声音换成开着配音时听到的那样——原声降 20%，{alignSummary(rec)}。
        {rec.videoDurationSec ? `${formatTimecode(Math.round(rec.videoDurationSec))} 的视频` : '一般'}几十秒就好，做完自动存进下载文件夹；合成时可以切到别的标签页，别关侧边栏。
        原视频文件要你自己准备：TubeMuse 不下载 YouTube 的视频。
      </p>
      <label class="inline">
        <input type="checkbox" data-testid="dub-full-subs" checked={withSubs} disabled={busy} onChange={(e) => setWithSubs(e.currentTarget.checked)} />
        带上原声字幕（英文原文）：写成视频里一条可以开关的字幕轨
      </label>
      {withSubs && (
        <div class="dub-full-subs" data-testid="dub-full-subs-source">
          <input type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" hidden ref={subsRef} data-testid="dub-full-subs-file" onChange={(e) => void onSubs(e.currentTarget)} />
          {chosen ? (
            <p class="small" data-testid="dub-full-subs-chosen">
              用你选的字幕文件：<span class="clip-file">{chosen.name}</span>（{chosen.cues.length} 句）
              <button class="btn link small" data-testid="dub-full-subs-drop" disabled={busy} onClick={() => exportJob.dropSubtitleFile(rec.videoId)}>
                不用这个文件
              </button>
            </p>
          ) : (
            <p class="muted small" data-testid="dub-full-subs-auto">
              字幕不在视频文件里（YouTube 的字幕是播放器另外取的），所以要另找：原视频文件里嵌着字幕轨就用它；没有的话，
              {onYouTube
                ? '从这个 YouTube 页面取这个视频自带的原声字幕（作者上传的优先，没有就用自动生成的；取的时候播放器的字幕可能闪一下）'
                : '要开着这个视频的 YouTube 页面才能从那里取——现在没开着'}
              。也可以自己选一个字幕文件。
              <button class="btn link small" data-testid="dub-full-subs-pick" disabled={busy} onClick={() => subsRef.current?.click()}>
                选字幕文件（.srt / .vtt）…
              </button>
            </p>
          )}
          {subsProblem && (
            <p class="small warn-text" data-testid="dub-full-subs-problem">
              {subsProblem}
            </p>
          )}
        </div>
      )}
      <div class="row">
        <button class="btn primary" data-testid="dub-full-pick" disabled={busy || !!blocked} onClick={onPick}>
          选择原视频文件（.mp4）…
        </button>
      </div>
      {blocked && (
        <p class="muted small" data-testid="dub-full-blocked">
          {blocked}
        </p>
      )}
      {mine && <ExportStatus job={mine} />}
    </div>
  );
}

const signed = (x: number) => `${x > 0.04 ? '+' : x < -0.04 ? '−' : ''}${Math.abs(x).toFixed(1)} 秒`;

/** 手动对齐留着的东西：开头偏移和 3 个对齐点 */
const manualKept = (rec: DubRecord) => {
  const n = rec.anchors?.length ?? 0;
  return n ? `开头偏移和 ${n} 个对齐点` : '开头偏移';
};

/**
 * 快速对齐（DECISIONS §82）：按"中文时长 ÷ 视频时长"给出建议倍速，点一下中文整段按它放（变速不变调），和原声同时开始、同时结束，
 * 不用一个个加对齐点。开着时写明用的倍速，可以切回手动对齐（开头偏移和对齐点一直留着）；
 * 倍速和现在的时长对不上时（设好之后换过文件）给出新的建议。
 */
function QuickAlign({ rec, suggestion, onApply, onManual }: { rec: DubRecord; suggestion: QuickAlignSuggestion | undefined; onApply: (rate: number) => void; onManual: () => void }) {
  const on = rec.quickRate;
  const same = suggestion ? Math.abs(suggestion.videoSec - suggestion.dubSec) < DUB.quick.sameSec : false;
  const stale = on !== undefined && !!suggestion?.ok && Math.abs(suggestion.rate - on) > DUB.quick.staleRate;
  return (
    <div class={`dub-quick${on !== undefined ? ' on' : ''}`} data-testid="dub-quick" data-on={on !== undefined ? 'true' : 'false'}>
      {on !== undefined ? (
        <>
          <div class="dub-quick-head">
            <strong>快速对齐已开</strong>
            <span data-testid="dub-quick-now">
              中文整段按 <b class="dub-quick-num">{rateText(on)}</b>（精确 {rateExactText(on)}）{rateWord(on)}，音调不变
            </span>
            <button class="btn small" data-testid="dub-quick-off" onClick={onManual}>
              切回手动对齐
            </button>
          </div>
          {stale && suggestion && (
            <p class="small warn-text" data-testid="dub-quick-stale">
              这个倍速和现在的时长对不上（{quickFormulaText(suggestion)}）：
              <button class="btn primary small" data-testid="dub-quick-apply" onClick={() => onApply(suggestion.rate)}>
                改用 {rateText(suggestion.rate)}
              </button>
            </p>
          )}
          <p class="muted small" data-testid="dub-quick-note">
            中文和原声同时开始、同时结束，中间按比例走；手动对齐的{manualKept(rec)}都留着（这期间不用），切回去照旧生效。两边的节奏不是处处一样，个别地方中文仍可能早几秒或晚几秒：差得多就切回手动对齐点。
          </p>
        </>
      ) : !suggestion ? (
        <>
          <div class="dub-quick-head">
            <strong>快速对齐</strong>
          </div>
          <p class="muted small" data-testid="dub-quick-note">
            读到视频和中文两边的时长后，这里给出建议的中文倍速（开启配音、等它载入）。
          </p>
        </>
      ) : !suggestion.ok ? (
        <>
          <div class="dub-quick-head">
            <strong>快速对齐</strong>
            <span class="muted small">{quickFormulaText(suggestion)}</span>
          </div>
          <p class="small warn-text" data-testid="dub-quick-note">
            {suggestion.why}
          </p>
        </>
      ) : same ? (
        <>
          <div class="dub-quick-head">
            <strong>快速对齐</strong>
          </div>
          <p class="muted small" data-testid="dub-quick-note">
            两边一样长（差不到 {DUB.quick.sameSec} 秒），不用变速。
          </p>
        </>
      ) : (
        <>
          <div class="dub-quick-head">
            <strong>快速对齐</strong>
            <span>建议中文{rateWord(suggestion.rate)}到</span>
            <button
              class="btn primary dub-quick-rate"
              data-testid="dub-quick-apply"
              title={`中文整段按 ${rateExactText(suggestion.rate)}× ${rateWord(suggestion.rate)}，和原声同时开始、同时结束`}
              onClick={() => onApply(suggestion.rate)}
            >
              {rateText(suggestion.rate)}
            </button>
            <span class="muted small" data-testid="dub-quick-formula">
              = {quickFormulaText(suggestion)}
            </span>
          </div>
          <p class="muted small" data-testid="dub-quick-note">
            点这个倍速：中文整段按它{rateWord(suggestion.rate)}（音调不变），和原声同时开始、同时结束，上面的"还差"直接到 0，不用再一个个加对齐点。已有的{manualKept(rec)}会留着，随时切回手动对齐。
          </p>
        </>
      )}
    </div>
  );
}

/**
 * 对齐（DECISIONS §75）：视频此刻所在那一段的偏移（微调按钮、输入框、"中文位置"滑块，都只改这一段）、
 * "在这里加对齐点"、对齐点列表。开头那一段的偏移就是原来的"偏移"。
 */
function AlignControl({
  rec,
  tabId,
  state,
  onNote,
  onControl,
}: {
  rec: DubRecord;
  tabId: number | undefined;
  state: DubTabState;
  onNote: (n: { text: string; undo?: () => void } | undefined) => void;
  /** 按了视频控制键：现在就再读一次页面的状态（不等下一次轮询） */
  onControl: () => void;
}) {
  const ctx = appCtx();
  const seg = state.segment ?? { index: -1, fromVideo: 0, offset: rec.delaySec, count: rec.anchors?.length ?? 0 };
  const [draft, setDraft] = useState<{ index: number; offset: number }>();
  const [draftPos, setDraftPos] = useState<number>();
  const [problem, setProblem] = useState<Problem>();
  // 存好的值（经配音脚本报回来）追上了草稿，或者已经换到别的段：草稿作废
  useEffect(() => {
    if (draft && (draft.index !== seg.index || Math.abs(draft.offset - seg.offset) < 0.05)) setDraft(undefined);
  }, [seg.index, seg.offset]);
  const offset = draft && draft.index === seg.index ? draft.offset : seg.offset;
  const anchors = rec.anchors ?? [];
  const bad = misorderedAnchors(dubMapOf(rec));
  const dubDuration = state.dubDuration ?? rec.durationSec;
  const position = draftPos ?? state.target;

  // 对齐图（DECISIONS §77）：按此刻的实时偏移画——拖"中文位置"、按微调按钮、在图上拖中文时，图立刻跟着变
  const liveOffset = draft && draft.index === seg.index ? draft.offset : draftPos !== undefined && state.videoTime !== undefined ? clampDelay(state.videoTime - draftPos) : seg.offset;
  const quickOn = rec.quickRate !== undefined;
  const liveMap = useMemo(() => {
    const base = dubMapOf(rec);
    // 快速对齐开着时（DECISIONS §82）全程按倍速走：没有实时偏移这回事
    if (base.quickRate !== undefined) return base;
    return seg.index < base.anchors.length ? withSegmentOffset(base, seg.index, liveOffset) : base;
  }, [rec, seg.index, liveOffset]);
  // 读到这一份状态的时刻：两次读位置之间，图上的播放头按倍速往前推
  const stamp = useMemo(() => performance.now(), [state]);
  const previewTimer = useRef<ReturnType<typeof setTimeout>>();
  const previewWant = useRef<number>();
  const commit = (value: number) => {
    const c = clampDelay(value);
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = undefined;
    setDraft({ index: seg.index, offset: c });
    void setDubSegmentOffset(ctx, rec.videoId, seg.index, c);
  };
  /** 在对齐图上拖中文：图立刻跟着变；页面里的配音每 80 毫秒跟一次（不必每个像素都让它跳一下） */
  const previewOffset = (value: number) => {
    const c = clampDelay(value);
    setDraft({ index: seg.index, offset: c });
    previewWant.current = c;
    if (previewTimer.current) return;
    previewTimer.current = setTimeout(() => {
      previewTimer.current = undefined;
      if (previewWant.current !== undefined) void previewSegment(tabId, { videoId: rec.videoId, segment: seg.index, offset: previewWant.current });
    }, 80);
  };
  useEffect(() => () => previewTimer.current && clearTimeout(previewTimer.current), []);
  // 此刻（DECISIONS §77–§79）：顶上的"还差多少"读数和对齐图用同一个播放头
  const videoDuration = state.videoDuration ?? rec.videoDurationSec;
  const alignNow = useDubAlignNow({
    map: liveMap,
    ...(videoDuration ? { videoDuration } : {}),
    ...(dubDuration !== undefined ? { dubDuration } : {}),
    ...(state.videoTime !== undefined ? { videoTime: state.videoTime } : {}),
    stamp,
    playing: !!state.videoPlaying,
    rate: state.videoRate ?? 1,
  });
  // 快速对齐（DECISIONS §82）：建议倍速按和"还差多少"同一组时长算（载入后是 <audio> 和 <video> 实际读到的）
  const suggestion = quickAlignSuggestion(dubDuration, videoDuration);
  const applyQuick = async (rate: number) => {
    setProblem(undefined);
    try {
      if (!(await setDubQuickRate(ctx, rec.videoId, rate))) {
        setProblem({ message: '没能开启快速对齐', hint: '这个倍速不在能用的范围里，仍用手动对齐点。' });
        return;
      }
      onNote({
        text: `已开快速对齐：中文整段按 ${rateText(rate)} ${rateWord(rate)}，和原声同时开始、同时结束。手动对齐的${manualKept(rec)}都留着。`,
        undo: () => void setDubQuickRate(ctx, rec.videoId, undefined).then(() => onNote(undefined)),
      });
    } catch (e) {
      setProblem(await toProblem(e));
    }
  };
  const backToManual = async () => {
    setProblem(undefined);
    const was = rec.quickRate;
    try {
      await setDubQuickRate(ctx, rec.videoId, undefined);
      onNote({
        text: `已切回手动对齐：${manualKept(rec)}照旧生效，中文按正常速度放。`,
        ...(was !== undefined ? { undo: () => void setDubQuickRate(ctx, rec.videoId, was).then(() => onNote(undefined)) } : {}),
      });
    } catch (e) {
      setProblem(await toProblem(e));
    }
  };
  const nudge = (by: number) => commit(offset + by);
  const previewPos = (dubAt: number) => {
    setDraftPos(dubAt);
    void previewSegment(tabId, { videoId: rec.videoId, segment: seg.index, dubAt });
  };
  const commitPos = async (dubAt: number) => {
    const s = await previewSegment(tabId, { videoId: rec.videoId, segment: seg.index, dubAt });
    const live = s?.segment;
    if (live && live.index === seg.index) commit(live.offset);
    setTimeout(() => setDraftPos(undefined), 1200);
  };
  const mark = async () => {
    setProblem(undefined);
    let m: DubMark | undefined;
    try {
      m = tabId === undefined ? undefined : ((await chrome.tabs.sendMessage(tabId, { type: DUB_MSG.mark })) as DubMark | undefined);
    } catch {
      m = undefined;
    }
    if (!m) {
      setProblem({ message: '没拿到此刻的位置', hint: '要在开着配音、正在看这个视频（不是广告）时加对齐点。' });
      return;
    }
    try {
      await addDubAnchor(ctx, rec.videoId, m);
      onNote({ text: `已在视频 ${formatClockSec(m.video)}（中文 ${formatClockSec(m.dub)}）加了对齐点：从这里起是新的一段，用上面的按钮或"中文位置"单独调，前面的不受影响。` });
    } catch (e) {
      setProblem(await toProblem(e));
    }
  };
  const remove = (k: number) => {
    const a = anchors[k];
    if (!a) return;
    void removeDubAnchor(ctx, rec.videoId, k).then(() =>
      onNote({
        text: `已删除视频 ${formatClockSec(a.video)} 的对齐点：它前面那一段一直延续到下一个对齐点。`,
        undo: () => void addDubAnchor(ctx, rec.videoId, a).then(() => onNote(undefined)),
      }),
    );
  };

  const where = quickOn
    ? `快速对齐，全程一段（中文 ${rateText(rec.quickRate ?? 1)} ${rateWord(rec.quickRate ?? 1)}）`
    : seg.index < 0
      ? seg.count
        ? `开头这一段（到视频 ${formatClockSec(anchors[0]?.video ?? 0)} 的对齐点为止）`
        : '全程一个偏移（还没有对齐点）'
      : `第 ${seg.index + 1} 个对齐点之后（视频 ${formatClockSec(seg.fromVideo)} 起${seg.nextVideo !== undefined ? `，到 ${formatClockSec(seg.nextVideo)}` : ''}）`;
  const steps: [number, string][] = [
    [-60, '−1 分'],
    [-10, '−10 秒'],
    [-1, '−1 秒'],
    [-0.1, '−0.1'],
  ];
  return (
    <div class="dub-delay" data-testid="dub-align">
      <div class="row">
        <strong>对齐</strong>
        <span class="muted small" data-testid="dub-segment">
          现在在：{where}
        </span>
      </div>
      <DubGapReadout now={alignNow} />
      <QuickAlign rec={rec} suggestion={suggestion} onApply={(rate) => void applyQuick(rate)} onManual={() => void backToManual()} />
      <DubAlignMap now={alignNow} map={liveMap} segment={seg.index} onPreview={previewOffset} onCommit={commit} footer={<DubTransport tabId={tabId} state={state} onDone={onControl} />} />
      {quickOn && problem && <ProblemBox problem={problem} onClose={() => setProblem(undefined)} />}
      {quickOn ? (
        <details class="dub-kept" data-testid="dub-kept">
          <summary>
            手动对齐留着的：{manualKept(rec)}（快速对齐期间不用，切回手动对齐后照旧生效）
          </summary>
          <ol class="dub-anchors" data-testid="dub-anchors">
            <li class="dub-anchor-start">
              <span>开头：{delayText(rec.delaySec)}</span>
            </li>
            {anchors.map((a, k) => (
              <li data-testid="dub-anchor" {...(k === 0 ? { value: 1 } : {})}>
                <span>
                  视频 {formatClockSec(a.video)} ↔ 中文 {formatClockSec(a.dub)}（{signed(Number((a.video - a.dub).toFixed(1)))}）
                </span>
              </li>
            ))}
          </ol>
        </details>
      ) : (
        <>
          <div class="row">
            <span>这一段的偏移</span>
            <span class="dub-delay-value" data-testid="dub-delay-value">
              {signed(offset)}
            </span>
          </div>
          {dubDuration !== undefined && position !== undefined && (
            <>
              <input
                type="range"
                class="dub-range"
                data-testid="dub-position-range"
                min={0}
                max={Math.ceil(dubDuration)}
                step={1}
                value={Math.max(0, Math.min(dubDuration, position))}
                aria-label="此刻放中文的哪里"
                onInput={(e) => previewPos(Number(e.currentTarget.value))}
                onChange={(e) => void commitPos(Number(e.currentTarget.value))}
              />
              <div class="row dub-range-ends muted small">
                <span>中文位置 {formatClockSec(Math.max(0, position))}</span>
                <span>共 {formatClockSec(dubDuration)}</span>
              </div>
            </>
          )}
          <div class="row wrap">
            {steps.map(([by, label]) => (
              <button class="btn small" onClick={() => nudge(by)}>
                {label}
              </button>
            ))}
            <input
              class="input num"
              type="number"
              data-testid="dub-delay-input"
              step={DUB.delayStepSec}
              min={-DUB.maxDelaySec}
              max={DUB.maxDelaySec}
              value={Number(offset.toFixed(1))}
              aria-label="这一段的偏移（秒）"
              onChange={(e) => commit(Number(e.currentTarget.value))}
            />
            {[...steps].reverse().map(([by, label]) => (
              <button class="btn small" onClick={() => nudge(-by)}>
                {label.replace('−', '+')}
              </button>
            ))}
            {seg.index < 0 && (
              <button class="btn link small" disabled={offset === 0} onClick={() => commit(0)}>
                归零
              </button>
            )}
          </div>
          <p class="muted small" data-testid="dub-delay-text">
            {segmentOffsetText({ index: seg.index, offset })}。＋ 让中文推后（往回退），− 让中文提前（往前跳）；拖"中文位置"直接选此刻放中文的哪里。按视频存下，下次打开直接用。
          </p>
          <div class="row">
            <button class="btn primary small" data-testid="dub-anchor-add" disabled={state.phase !== 'ready' || state.videoTime === undefined} onClick={() => void mark()}>
              在这里加对齐点
            </button>
          </div>
          <p class="muted small">
            中文和原视频差得多（比如中文短了十几分钟、删掉了一些段落）时：在对不上的地方点"在这里加对齐点"，再把这一段调到中英说的是同一句。
            对齐点之间中文按正常速度放：中文先说完就停下等画面（这时听到的是原声），说得慢就在下一个对齐点跳过去。
          </p>
          {problem && <ProblemBox problem={problem} onClose={() => setProblem(undefined)} />}
          <ol class="dub-anchors" data-testid="dub-anchors">
            <li class={`dub-anchor-start${seg.index < 0 ? ' on' : ''}`}>
              <span>开头：{delayText(rec.delaySec)}</span>
            </li>
            {anchors.map((a, k) => (
              <li class={seg.index === k ? 'on' : ''} data-testid="dub-anchor" {...(k === 0 ? { value: 1 } : {})}>
                <span>
                  视频 {formatClockSec(a.video)} ↔ 中文 {formatClockSec(a.dub)}（{signed(Number((a.video - a.dub).toFixed(1)))}）
                  {bad.includes(k) && <strong class="warn-text"> 中文位置不比前一个靠后：前一段的中文会被整段跳过</strong>}
                </span>
                <button class="btn link small" data-testid="dub-anchor-remove" onClick={() => remove(k)}>
                  删除
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

export function DubView() {
  const ctx = appCtx();
  const settings = useStore(stores.settings);
  const index = useStore(stores.dubs);
  const { tabId, state, refresh } = useActiveTabState<DubTabState>(DUB_MSG.getState, DUB_MSG.state, 1000);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<Problem>();
  const [done, setDone] = useState<string>();
  const [alignNote, setAlignNote] = useState<{ text: string; undo?: () => void }>();
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [missing, setMissing] = useState<string[]>([]);

  /** 选文件那一刻的视频（文件对话框开着时你可能换了标签页） */
  const pickFor = useRef<string>();
  /** 保存完整双语视频：选原视频文件的那个输入框，和这次是给哪个视频选的 */
  const sourceRef = useRef<HTMLInputElement>(null);
  const exportFor = useRef<string>();
  const job = useExportJob();
  const fileIds = index ? Object.values(index).map((r) => r.fileId).sort().join(',') : undefined;
  // 核对本机存储：清掉没人用的音频，标出音频不见了的
  useEffect(() => {
    if (fileIds === undefined) return;
    void checkDubStorage(ctx)
      .then((r) => setMissing(r.missing))
      .catch(() => undefined);
  }, [fileIds]);

  if (!settings || !index) return null;
  const videoId = state?.videoId ?? undefined;
  const rec = videoId ? index[videoId] : undefined;
  const records = Object.values(index).sort((a, b) => b.addedAt - a.addedAt);
  const totalBytes = records.reduce((n, r) => n + r.size, 0);

  const pick = () => {
    setProblem(undefined);
    setDone(undefined);
    pickFor.current = videoId;
    fileRef.current?.click();
  };
  const pickSource = (vid: string) => {
    exportFor.current = vid;
    sourceRef.current?.click();
  };
  const onSource = (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    // 用此刻存着的对齐（选文件的工夫里可能又调过）
    const vid = exportFor.current ?? videoId;
    exportFor.current = undefined;
    const target = vid ? index[vid] : undefined;
    // 要不要带字幕看设置；开着这个视频的 YouTube 页面时，字幕可以从那里取
    const onPage = vid === videoId && tabId !== undefined;
    if (file && target) void exportJob.start(target, file, ctx.dubAudio, { subtitles: settings.dub.exportSubtitles, ...(onPage ? { youtubeTabId: tabId } : {}) });
  };
  const onFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    const forVideo = pickFor.current ?? videoId;
    if (!file || !forVideo) return;
    if (forVideo !== videoId) {
      setProblem({ message: '选文件时换了标签页，没有关联', hint: '回到那个视频再选一次。' });
      return;
    }
    setBusy(`正在检查并存入本机：${file.name}（${formatBytes(file.size)}）…`);
    setProblem(undefined);
    setDone(undefined);
    try {
      const wasOn = !!state?.active;
      const saved = await attachDub(ctx, {
        videoId,
        file,
        fileName: file.name,
        ...(state?.title ? { title: state.title } : {}),
        ...(state?.videoDuration ? { videoDurationSec: state.videoDuration } : {}),
      });
      // 换文件时快速对齐开着（DECISIONS §82）：倍速已按新文件的时长重新算；新倍速超出范围时回到了手动对齐
      const hadQuick = rec?.quickRate !== undefined;
      const quickNote = !hadQuick
        ? ''
        : saved.quickRate === undefined
          ? '新文件和视频的时长差得太多，快速对齐已关，回到手动对齐。'
          : saved.quickRate !== rec?.quickRate
            ? `快速对齐的倍速按新文件的时长重新算成 ${rateText(saved.quickRate)}（精确 ${rateExactText(saved.quickRate)}）。`
            : '';
      setDone(
        `已把 ${saved.fileName} 关联到这个视频。${quickNote}${saved.anchors?.length ? '原来的偏移和对齐点保留着：新文件不一样的话在下面删掉重设。' : ''}${saved.subs ? '原来的配音字幕也保留着：和新文件对不上的话换一份。' : ''}${wasOn ? '' : '点"开启配音"开始播放。'}`,
      );
    } catch (e) {
      setProblem(await toProblem(e));
    } finally {
      setBusy(undefined);
    }
  };
  const remove = async (vid: string) => {
    setConfirmRemove(undefined);
    setProblem(undefined);
    setDone(undefined);
    try {
      await removeDub(ctx, vid);
      setDone('已移除：音频已从本机删除（你电脑上原来的文件不受影响）。');
    } catch (e) {
      setProblem(await toProblem(e));
    }
  };

  const removeConfirm = (vid: string) =>
    confirmRemove === vid ? (
      <div class="danger-zone" data-testid="dub-remove-confirm">
        <p class="small">移除后这个视频不再有中文配音，音频从本机（浏览器的存储）删除；你电脑上原来的 .m4a 文件不受影响。</p>
        <div class="row">
          <button class="btn danger small" data-testid="dub-remove-yes" onClick={() => void remove(vid)}>
            确认移除
          </button>
          <button class="btn small" onClick={() => setConfirmRemove(undefined)}>
            取消
          </button>
        </div>
      </div>
    ) : null;

  // 实际放的时长（配音载入后由 <audio> 读出）优先，和对齐区算"还差多少"用的同一个；没载入时用文件里写的（DECISIONS §79）
  const dubDuration = state?.dubDuration ?? rec?.durationSec;
  const videoDuration = state?.videoDuration ?? rec?.videoDurationSec;
  const note = durationNote(dubDuration, videoDuration, rec?.quickRate);

  return (
    <div class="dub">
      <input type="file" accept=".m4a,audio/mp4,audio/x-m4a" hidden ref={fileRef} data-testid="dub-file" onChange={(e) => void onFile(e.currentTarget)} />
      <input type="file" accept=".mp4,.m4v,video/mp4" hidden ref={sourceRef} data-testid="dub-full-file" onChange={(e) => onSource(e.currentTarget)} />
      {job && job.videoId !== videoId && (
        <section class="panel" data-testid="dub-export-other">
          <ExportStatus job={job} withTitle />
        </section>
      )}
      {!settings.dub.enabled && (
        <Notice kind="warn">
          中文配音已在设置中关闭。
          <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
            打开设置
          </button>
        </Notice>
      )}
      <section class="panel" data-testid="dub-current">
        <h2>中文配音</h2>
        {state === undefined ? (
          <p class="muted small">正在读取当前标签页…</p>
        ) : state === null || !state.videoId ? (
          <p class="muted small">当前标签页不是 YouTube 视频页。如果是，刷新一下那个页面（扩展安装或更新之前打开的页面里还没有配音脚本）。</p>
        ) : !rec ? (
          <>
            <p class="small">
              {state.title ? `《${state.title}》` : '这个视频'}还没有中文配音。选一个本地 .m4a 文件关联到它：之后打开同一个视频时会提示有中文版。
            </p>
            <button class="btn primary" data-testid="dub-pick" disabled={!!busy || !settings.dub.enabled} onClick={pick}>
              选择 .m4a 文件…
            </button>
          </>
        ) : (
          <>
            <dl class="kv">
              <dt>文件</dt>
              <dd data-testid="dub-file-name">
                {rec.fileName} · {formatBytes(rec.size)}
                {missing.includes(rec.videoId) && <strong class="warn-text"> 本机的音频不见了，请重新选择文件</strong>}
              </dd>
              {note && (
                <>
                  <dt>时长</dt>
                  <dd data-testid="dub-duration">{note}</dd>
                </>
              )}
              <dt>状态</dt>
              <dd data-testid="dub-status">{state.status}</dd>
              {state.active && state.volume && (
                <>
                  <dt>原声</dt>
                  <dd data-testid="dub-volume">{volumeText(state.volume, state.phase)}</dd>
                </>
              )}
              {state.active && state.phase === 'ready' && state.videoTime !== undefined && state.dubTime !== undefined && (
                <>
                  <dt>位置</dt>
                  <dd data-testid="dub-position">
                    视频 {formatClockSec(state.videoTime)} · 中文 {formatClockSec(state.dubTime)}
                  </dd>
                </>
              )}
            </dl>
            {state.phase === 'loading' && state.progress !== undefined && <progress class="dub-progress" max={1} value={state.progress} />}
            {state.error && <ProblemBox problem={state.error} />}
            <div class="row wrap">
              {state.active ? (
                <button class="btn" data-testid="dub-toggle" onClick={() => void toggleDub(tabId, false)}>
                  关闭配音
                </button>
              ) : (
                <button class="btn primary" data-testid="dub-toggle" disabled={!settings.dub.enabled} onClick={() => void toggleDub(tabId, true)}>
                  开启配音
                </button>
              )}
              <button class="btn small" data-testid="dub-replace" disabled={!!busy} onClick={pick}>
                换一个文件…
              </button>
              <button class="btn small danger" data-testid="dub-remove" onClick={() => setConfirmRemove(rec.videoId)}>
                移除…
              </button>
            </div>
            {removeConfirm(rec.videoId)}
            <DubSubtitles rec={rec} state={state} />
            <FullSave rec={rec} missing={missing.includes(rec.videoId)} onPick={() => pickSource(rec.videoId)} onYouTube={tabId !== undefined} />
            <AlignControl key={rec.videoId} rec={rec} tabId={tabId} state={state} onNote={setAlignNote} onControl={refresh} />
            {alignNote && (
              <Notice kind="ok" onClose={() => setAlignNote(undefined)}>
                <span data-testid="dub-align-note">{alignNote.text}</span>
                {alignNote.undo && (
                  <button class="btn link small" data-testid="dub-anchor-undo" onClick={alignNote.undo}>
                    撤销
                  </button>
                )}
              </Notice>
            )}
          </>
        )}
        {busy && <p class="muted small" data-testid="dub-busy">{busy}</p>}
        {done && (
          <Notice kind="ok" onClose={() => setDone(undefined)}>
            <span data-testid="dub-done">{done}</span>
          </Notice>
        )}
        {problem && <ProblemBox problem={problem} onClose={() => setProblem(undefined)} />}
      </section>

      <section class="panel" data-testid="dub-list">
        <h2>已关联的视频（{records.length}）</h2>
        {records.length === 0 ? (
          <p class="muted small">还没有。打开一个 YouTube 视频，在上面选择 .m4a 文件。</p>
        ) : (
          <>
            <ul class="dub-list">
              {records.map((r) => (
                <li data-testid="dub-item">
                  <div>
                    <a
                      href={`https://www.youtube.com/watch?v=${r.videoId}`}
                      onClick={(e) => {
                        e.preventDefault();
                        openInCurrentTab(r.videoId);
                      }}
                    >
                      {r.title || r.videoId}
                    </a>
                    {r.videoId === videoId && <span class="muted small">（当前视频）</span>}
                  </div>
                  <div class="muted small">
                    {r.fileName} · {formatBytes(r.size)}
                    {r.durationSec ? ` · ${formatClockSec(r.durationSec)}` : ''} · 偏移 {r.delaySec > 0 ? '+' : ''}
                    {r.delaySec.toFixed(1)} 秒{r.anchors?.length ? ` · ${r.anchors.length} 个对齐点` : ''}
                    {r.quickRate !== undefined ? ` · 快速对齐 ${rateText(r.quickRate)}` : ''}
                    {r.subs ? ` · 字幕 ${r.subs.count} 句` : ''}
                    {missing.includes(r.videoId) ? ' · 本机的音频不见了' : ''}
                  </div>
                  {r.videoId !== videoId && (
                    <>
                      <button class="btn link small" data-testid="dub-item-export" disabled={exportJob.busy() || missing.includes(r.videoId) || !exportSupported()} onClick={() => pickSource(r.videoId)}>
                        保存完整双语视频…
                      </button>
                      <button class="btn link small" onClick={() => setConfirmRemove(r.videoId)}>
                        移除…
                      </button>
                      {removeConfirm(r.videoId)}
                    </>
                  )}
                </li>
              ))}
            </ul>
            <p class="muted small">共占用本机 {formatBytes(totalBytes)}（浏览器里的扩展存储）。</p>
          </>
        )}
      </section>

      <section class="panel">
        <h2>说明</h2>
        <ul class="muted small dub-notes">
          <li>同步只跟随视频的播放、暂停、拖动进度和倍速，再加上你设的偏移和对齐点。中文是另外录的，长度和停顿与原视频不一样（还可能删掉了一些段落），不做逐句对齐：越往后可能差得越多，在对不上的地方加对齐点、单独调那一段。</li>
          <li>对齐点之间中文始终按正常速度放：中文先说完就停下等画面，说得慢就在下一个对齐点跳过去（会跳过中文没说完的那一点）。</li>
          <li>
            快速对齐：不想一个个加对齐点时，点建议的倍速（中文时长 ÷ 视频时长），中文整段按它变速放（音调不变），和原声同时开始、同时结束。对上的是开头和结尾，中间按比例走，不是逐句对齐；手动对齐的偏移和对齐点一直留着，随时切回。
          </li>
          <li>配音开启时，原声降到你的音量的 80%（降 20%），中文保持正常音量、不跟 YouTube 的音量与静音走；关闭、换视频、离开页面时原声恢复。广告期间配音暂停、原声恢复。</li>
          <li>
            "保存完整双语视频"不用播放：你选这个视频的原视频文件（MP4），TubeMuse 在侧边栏里离线合成——画面原样照搬，原声和中文解码后按现在的对齐混在一起，重新编码成一条音轨（能用 AAC 就用 AAC，否则用 Opus）。快速对齐时中文用变速不变调的算法放慢 / 放快，和播放时听到的是同一种效果，波形不会逐个样本相同。原视频文件只在合成时读，不存进扩展；TubeMuse 不下载 YouTube 的视频，这个文件要你自己准备。不在 YouTube 页面上也能做：在"已关联的视频"里点"保存完整双语视频…"。
          </li>
          <li>
            对齐图下面的"视频"一排按键控制的是 YouTube 页面里的视频（暂停 / 播放，后退、前进几秒），和你自己在播放器上操作一样；配音照现在的对齐跟上。广告期间不能前进 / 后退。
          </li>
          <li>
            配音字幕是配音这段音频自己的字幕（你选的 .srt / .vtt，或小宇宙里已经生成的那一集），按配音实际放到的位置显示，不按视频时间：中文停下等画面、还没开始、已经放完时不显示。TubeMuse
            不在这里转写或翻译，字幕里写什么就显示什么；中英双语的字幕只显示中文那几行。字幕文字存在本机，会随"导出数据"一起导出。
          </li>
          <li>配音由 YouTube 页面里的 TubeMuse 脚本播放，关掉侧边栏也继续；刷新页面后要重新开启（只提示，不自动出声）。</li>
          <li>音频文件存在这个浏览器里（扩展自己的 IndexedDB），不上传、不发任何网络请求；导出数据时只导出视频与文件名、偏移的对应关系，不含音频本身；"清空全部数据"会一并删除。</li>
        </ul>
      </section>
    </div>
  );
}

/** 侧边栏顶部：当前视频有中文配音、还没开启时提示一行（设置里可关；"这次不用"只对这个视频、这次打开侧边栏有效） */
export function DubPrompt({ onOpen, hidden }: { onOpen: () => void; hidden: boolean }) {
  const settings = useStore(stores.settings);
  const { tabId, state } = useActiveTabState<DubTabState>(DUB_MSG.getState, DUB_MSG.state);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  if (hidden || !settings?.dub.enabled || !settings.dub.prompt || !state?.available || state.active || !state.videoId || dismissed.has(state.videoId)) return null;
  const vid = state.videoId;
  return (
    <aside class="reminder dub-prompt" role="status" data-testid="dub-prompt">
      <div>
        这个视频有中文配音：<strong>{state.fileName}</strong>
      </div>
      <div class="row wrap">
        <button class="btn primary small" data-testid="dub-prompt-on" onClick={() => void toggleDub(tabId, true)}>
          开启配音
        </button>
        <button class="btn link small" onClick={onOpen}>
          去「配音」页
        </button>
        <button class="btn link small" onClick={() => setDismissed(new Set([...dismissed, vid]))}>
          这次不用
        </button>
      </div>
    </aside>
  );
}
