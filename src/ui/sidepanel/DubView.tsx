// 「配音」页（DECISIONS §74、§75）：给当前 YouTube 视频关联一个本地中文配音（.m4a），开 / 关，调偏移、加对齐点，移除；管理所有关联过的视频。
// 还有侧边栏顶部的一行提示（DubPrompt）：当前视频有中文配音、还没开启时显示。
// 状态来自注入 YouTube 页面的配音脚本（只在本扩展内部传递）；对应关系在本机存储，音频在扩展自己的 IndexedDB。

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DUB } from '../../config/defaults';
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
  segmentOffsetText,
  withSegmentOffset,
  type DubMark,
  type DubRecord,
  type DubTabState,
} from '../../core/dub';
import { addDubAnchor, attachDub, checkDubStorage, removeDub, removeDubAnchor, setDubSegmentOffset } from '../../services/dub-service';
import { stores } from '../../services/repo';
import { appCtx, asAppError, useStore } from '../shared/app';
import { DubAlignMap, DubGapReadout, useDubAlignNow } from './DubAlignMap';
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

const signed = (x: number) => `${x > 0.04 ? '+' : x < -0.04 ? '−' : ''}${Math.abs(x).toFixed(1)} 秒`;

/**
 * 对齐（DECISIONS §75）：视频此刻所在那一段的偏移（微调按钮、输入框、"中文位置"滑块，都只改这一段）、
 * "在这里加对齐点"、对齐点列表。开头那一段的偏移就是原来的"偏移"。
 */
function AlignControl({ rec, tabId, state, onNote }: { rec: DubRecord; tabId: number | undefined; state: DubTabState; onNote: (n: { text: string; undo?: () => void } | undefined) => void }) {
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
  const liveMap = useMemo(() => {
    const base = dubMapOf(rec);
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

  const where =
    seg.index < 0
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
      <DubAlignMap now={alignNow} map={liveMap} segment={seg.index} onPreview={previewOffset} onCommit={commit} />
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
    </div>
  );
}

export function DubView() {
  const ctx = appCtx();
  const settings = useStore(stores.settings);
  const index = useStore(stores.dubs);
  const { tabId, state } = useActiveTabState<DubTabState>(DUB_MSG.getState, DUB_MSG.state, 1000);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<Problem>();
  const [done, setDone] = useState<string>();
  const [alignNote, setAlignNote] = useState<{ text: string; undo?: () => void }>();
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [missing, setMissing] = useState<string[]>([]);

  /** 选文件那一刻的视频（文件对话框开着时你可能换了标签页） */
  const pickFor = useRef<string>();
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
      setDone(`已把 ${saved.fileName} 关联到这个视频。${saved.anchors?.length ? '原来的偏移和对齐点保留着：新文件不一样的话在下面删掉重设。' : ''}${wasOn ? '' : '点"开启配音"开始播放。'}`);
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
  const note = durationNote(dubDuration, videoDuration);

  return (
    <div class="dub">
      <input type="file" accept=".m4a,audio/mp4,audio/x-m4a" hidden ref={fileRef} data-testid="dub-file" onChange={(e) => void onFile(e.currentTarget)} />
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
            <AlignControl key={rec.videoId} rec={rec} tabId={tabId} state={state} onNote={setAlignNote} />
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
                    {r.delaySec.toFixed(1)} 秒{r.anchors?.length ? ` · ${r.anchors.length} 个对齐点` : ''}{missing.includes(r.videoId) ? ' · 本机的音频不见了' : ''}
                  </div>
                  {r.videoId !== videoId && (
                    <>
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
          <li>配音开启时，原声降到你的音量的 80%（降 20%），中文保持正常音量、不跟 YouTube 的音量与静音走；关闭、换视频、离开页面时原声恢复。广告期间配音暂停、原声恢复。</li>
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
