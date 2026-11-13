// 「配音」页（DECISIONS §73）：给当前 YouTube 视频关联一个本地中文配音（.m4a），开 / 关，调偏移，移除；管理所有关联过的视频。
// 还有侧边栏顶部的一行提示（DubPrompt）：当前视频有中文配音、还没开启时显示。
// 状态来自注入 YouTube 页面的配音脚本（只在本扩展内部传递）；对应关系在本机存储，音频在扩展自己的 IndexedDB。

import { useEffect, useRef, useState } from 'preact/hooks';
import { DUB } from '../../config/defaults';
import { DUB_MSG, DubFileError, clampDelay, delayText, durationNote, formatBytes, formatClockSec, type DubRecord, type DubTabState } from '../../core/dub';
import { attachDub, checkDubStorage, removeDub, setDubDelay } from '../../services/dub-service';
import { stores } from '../../services/repo';
import { appCtx, asAppError, useStore } from '../shared/app';
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

/** 偏移：滑块（拖动时实时生效，松手后存下）、微调按钮与输入框 */
function DelayControl({ rec, tabId, live }: { rec: DubRecord; tabId: number | undefined; live: number | undefined }) {
  const ctx = appCtx();
  const [draft, setDraft] = useState<number>();
  // 存好的值追上了草稿：草稿作废
  useEffect(() => {
    if (draft !== undefined && clampDelay(draft) === rec.delaySec) setDraft(undefined);
  }, [rec.delaySec]);
  const value = draft ?? live ?? rec.delaySec;
  const preview = (d: number) => {
    setDraft(d);
    if (tabId !== undefined) void chrome.tabs.sendMessage(tabId, { type: DUB_MSG.setDelay, videoId: rec.videoId, delaySec: d }).catch(() => undefined);
  };
  const commit = (d: number) => {
    const c = clampDelay(d);
    setDraft(c);
    void setDubDelay(ctx, rec.videoId, c);
  };
  const nudge = (by: number) => commit(value + by);
  const range = DUB.delayRangeSec;
  return (
    <div class="dub-delay" data-testid="dub-delay">
      <div class="row">
        <strong>偏移</strong>
        <span class="dub-delay-value" data-testid="dub-delay-value">
          {value > 0 ? '+' : ''}
          {value.toFixed(1)} 秒
        </span>
      </div>
      <input
        type="range"
        class="dub-range"
        data-testid="dub-delay-range"
        min={-range}
        max={range}
        step={DUB.delayStepSec}
        value={Math.max(-range, Math.min(range, value))}
        aria-label="配音偏移（秒）"
        onInput={(e) => preview(Number(e.currentTarget.value))}
        onChange={(e) => commit(Number(e.currentTarget.value))}
      />
      <div class="row dub-range-ends muted small">
        <span>← 中文提前</span>
        <span>中文推后 →</span>
      </div>
      <div class="row wrap">
        <button class="btn small" onClick={() => nudge(-1)}>
          −1 秒
        </button>
        <button class="btn small" onClick={() => nudge(-0.1)}>
          −0.1
        </button>
        <input
          class="input num"
          type="number"
          data-testid="dub-delay-input"
          step={DUB.delayStepSec}
          min={-DUB.maxDelaySec}
          max={DUB.maxDelaySec}
          value={value}
          aria-label="偏移（秒）"
          onChange={(e) => commit(Number(e.currentTarget.value))}
        />
        <button class="btn small" onClick={() => nudge(0.1)}>
          +0.1
        </button>
        <button class="btn small" onClick={() => nudge(1)}>
          +1 秒
        </button>
        <button class="btn link small" disabled={value === 0} onClick={() => commit(0)}>
          归零
        </button>
      </div>
      <p class="muted small" data-testid="dub-delay-text">
        {delayText(value)}。边听边调，让中文的第一句和原视频的第一句同时开始；偏移按视频存下，下次打开直接用。
      </p>
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
      setDone(`已把 ${saved.fileName} 关联到这个视频。${wasOn ? '' : '点"开启配音"开始播放。'}`);
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

  const dubDuration = rec?.durationSec ?? state?.dubDuration;
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
            <DelayControl key={rec.videoId} rec={rec} tabId={tabId} live={state.delaySec} />
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
                    {r.delaySec.toFixed(1)} 秒{missing.includes(r.videoId) ? ' · 本机的音频不见了' : ''}
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
          <li>同步只跟随视频的播放、暂停、拖动进度和倍速，再加上你设的偏移。中文是另外录的，长度和停顿与原视频不一样，不做逐句对齐：越往后可能差得越多，需要时再调偏移。</li>
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
