// 片段录制：当前标签页这个视频的录制控制（自由录制 / 按时间段截取）、录好的片段（保存 / 丢弃）、最近录过的片段。
// 录制在 YouTube 页面里的录制脚本完成，这里只经消息控制它；录过的片段记录来自本机存储（只有元数据）。

import { useEffect, useState } from 'preact/hooks';
import {
  CLIP_MSG,
  CLIP_STOP_LABELS,
  checkRange,
  clipWatchUrl,
  formatBytes,
  formatTimecode,
  parseTimecode,
  type ClipMode,
  type ClipTabState,
} from '../../core/clips';
import { formatClock, formatRelative } from '../../core/time';
import { stores } from '../../services/repo';
import { clearClipLog } from '../../services/clip-service';
import { appCtx, useStore } from '../shared/app';
import { Notice } from '../shared/components';
import { useActiveTabState } from '../shared/tab-state';

export function ClipsView() {
  const settings = useStore(stores.settings);
  const log = useStore(stores.clipLog);
  // 推送里不含播放位置：打开这一页时每秒问一次
  const { tabId, state } = useActiveTabState<ClipTabState>(CLIP_MSG.getState, CLIP_MSG.state, 1000);
  const [mode, setMode] = useState<ClipMode>('free');
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const videoId = state?.videoId;
  // 换了视频：时间段清空，免得拿上一个视频的时间去截
  useEffect(() => {
    setStartText('');
    setEndText('');
    setLocalError(undefined);
  }, [videoId]);
  if (!settings) return null;

  const send = async (msg: Record<string, unknown>): Promise<ClipTabState | undefined> => {
    if (tabId === undefined) return undefined;
    setBusy(true);
    try {
      return (await chrome.tabs.sendMessage(tabId, msg)) as ClipTabState | undefined;
    } catch {
      setLocalError('这个标签页没有响应：刷新一下 YouTube 页面再试（扩展安装或更新之前打开的页面里还没有录制脚本）');
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  /** 取视频当前位置填进起点 / 终点（精确到 0.1 秒） */
  const grab = async (which: 'start' | 'end') => {
    const s = await send({ type: CLIP_MSG.getState, precise: true });
    if (!s) return;
    const t = formatTimecode(s.position);
    if (which === 'start') setStartText(t);
    else setEndText(t);
  };

  const chooseMode = (m: ClipMode) => {
    setMode(m);
    setLocalError(undefined);
    // 第一次切到时间段：起点填当前位置，终点往后 30 秒
    if (m === 'range' && state && !startText && !endText) {
      const start = state.position;
      const end = state.duration > 0 ? Math.min(state.duration, start + 30) : start + 30;
      setStartText(formatTimecode(start));
      setEndText(formatTimecode(end));
    }
  };

  const start = async () => {
    setLocalError(undefined);
    if (!state) return;
    if (mode === 'free') return void send({ type: CLIP_MSG.start, mode: 'free' });
    const a = parseTimecode(startText);
    const b = parseTimecode(endText);
    const problem = checkRange(a, b, state.duration, state.maxSec);
    if (problem) return setLocalError(problem);
    await send({ type: CLIP_MSG.start, mode: 'range', start: a, end: b });
  };

  const setBurn = (on: boolean) => void stores.settings.update(appCtx().kv, appCtx().locker, (s) => ({ ...s, clips: { ...s.clips, burnSubtitles: on } }));

  const recording = state?.phase === 'recording' || state?.phase === 'finishing';
  const ready = state?.ready;
  const error = localError ? { message: localError } : state?.error;
  const rangeLen = (() => {
    const a = parseTimecode(startText);
    const b = parseTimecode(endText);
    return a !== null && b !== null && b > a ? b - a : undefined;
  })();

  return (
    <div class="clips">
      {!settings.clips.enabled && (
        <Notice kind="warn">
          片段录制已在设置中关闭。
          <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
            打开设置
          </button>
        </Notice>
      )}

      <section class="panel" data-testid="clip-tab">
        <h2>录制片段</h2>
        {state ? (
          <>
            <dl class="kv">
              <dt>视频</dt>
              <dd>{state.title ?? state.videoId ?? '—'}</dd>
              {state.videoId && (
                <>
                  <dt>当前位置</dt>
                  <dd class="num-inline" data-testid="clip-position">
                    {formatTimecode(state.position)}
                    {state.duration > 0 ? ` / ${formatTimecode(state.duration)}` : ''}
                  </dd>
                </>
              )}
              <dt>状态</dt>
              <dd data-testid="clip-status">{state.status}</dd>
            </dl>

            {!state.unavailable && !recording && (
              <>
                <div class="seg" role="radiogroup" aria-label="录制方式">
                  <button role="radio" aria-checked={mode === 'free'} class={`seg-btn${mode === 'free' ? ' on' : ''}`} onClick={() => chooseMode('free')}>
                    自由录制
                  </button>
                  <button role="radio" aria-checked={mode === 'range'} class={`seg-btn${mode === 'range' ? ' on' : ''}`} data-testid="clip-mode-range" onClick={() => chooseMode('range')}>
                    按时间段截取
                  </button>
                </div>
                {mode === 'free' ? (
                  <p class="muted small">从现在的位置开始录，你点"停止"时结束；随时可以暂停。</p>
                ) : (
                  <>
                    <div class="clip-range">
                      <label class="field">
                        <span>起点</span>
                        <span class="row">
                          <input class="input" data-testid="clip-start-at" value={startText} placeholder="12:03" onInput={(e) => setStartText(e.currentTarget.value)} />
                          <button class="btn small" disabled={busy} title="用视频当前的位置" onClick={() => void grab('start')}>
                            取当前
                          </button>
                        </span>
                      </label>
                      <label class="field">
                        <span>终点</span>
                        <span class="row">
                          <input class="input" data-testid="clip-end-at" value={endText} placeholder="13:10" onInput={(e) => setEndText(e.currentTarget.value)} />
                          <button class="btn small" disabled={busy} title="用视频当前的位置" onClick={() => void grab('end')}>
                            取当前
                          </button>
                        </span>
                      </label>
                    </div>
                    <p class="muted small">
                      {rangeLen !== undefined ? `片段长 ${formatTimecode(rangeLen)}。` : ''}开始后自动跳到起点播放，到终点自动停；按 1 倍速实时录，要花和片段一样长的时间。
                    </p>
                  </>
                )}
                <label class="inline">
                  <input type="checkbox" data-testid="clip-burn" checked={settings.clips.burnSubtitles} onChange={(e) => setBurn(e.currentTarget.checked)} />
                  把字幕烧进画面（录的是播放器里当时显示的字幕：TubeMuse 自动字幕或 YouTube 原生字幕；更费电脑）
                </label>
                <div class="row">
                  <button class="btn primary" data-testid="clip-start" disabled={busy || tabId === undefined} onClick={() => void start()}>
                    ● {mode === 'range' ? '开始截取' : '开始录制'}
                  </button>
                </div>
              </>
            )}

            {recording && (
              <div class="clip-live" data-testid="clip-live">
                <div class="clip-timer">
                  <span class={`rec-dot${state.waiting || state.phase === 'finishing' ? ' paused' : ''}`} aria-hidden="true" />
                  <span data-testid="clip-recorded">{formatTimecode(state.recordedSec)}</span>
                  {state.range && <span class="muted"> / {formatTimecode(state.range.end - state.range.start)}</span>}
                  <span class="muted"> · {formatBytes(state.bytes)}</span>
                </div>
                {state.range && <progress class="clip-progress" max={state.range.end - state.range.start} value={Math.min(state.recordedSec, state.range.end - state.range.start)} />}
                <div class="muted small">
                  {state.format}
                  {state.burn ? ' · 带字幕' : ''} · 单段上限 {formatTimecode(state.maxSec)}
                </div>
                <div class="row">
                  {state.waiting === 'user' ? (
                    <button class="btn" disabled={busy || state.phase === 'finishing'} onClick={() => void send({ type: CLIP_MSG.resume })}>
                      继续
                    </button>
                  ) : (
                    <button class="btn" disabled={busy || state.phase === 'finishing'} onClick={() => void send({ type: CLIP_MSG.pause })}>
                      暂停
                    </button>
                  )}
                  <button class="btn primary" data-testid="clip-stop" disabled={busy || state.phase === 'finishing'} onClick={() => void send({ type: CLIP_MSG.stop })}>
                    ■ {state.autoSave ? '停止并保存' : '停止'}
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div class="notice notice-error" role="alert">
                <div class="notice-body">
                  <strong>{error.message}</strong>
                  {'hint' in error && error.hint && <div class="muted">{error.hint}</div>}
                </div>
              </div>
            )}

            {ready && (
              <div class="clip-ready" data-testid="clip-ready">
                <strong class="clip-file">{ready.fileName}</strong>
                <div class="muted small">
                  {formatTimecode(ready.durationSec)} · {formatBytes(ready.bytes)} · {ready.format}
                  {ready.burned ? ' · 带字幕' : ''} · {CLIP_STOP_LABELS[ready.endedBy]}
                </div>
                {ready.savedAt ? (
                  <p class="small" data-testid="clip-saved">
                    已在 {formatClock(ready.savedAt)} 交给浏览器存进下载文件夹。没看到文件？浏览器可能拦下了"自动下载多个文件"：在地址栏右侧允许后点"再存一次"。
                  </p>
                ) : (
                  <p class="small warn-text">还没保存：片段只在那个 YouTube 标签页的内存里，关掉或刷新页面就没了。</p>
                )}
                <div class="row">
                  <button class={`btn${ready.savedAt ? '' : ' primary'}`} data-testid="clip-save" disabled={busy} onClick={() => void send({ type: CLIP_MSG.save })}>
                    {ready.savedAt ? '再存一次' : '保存到本地'}
                  </button>
                  <button class="btn" disabled={busy} onClick={() => void send({ type: CLIP_MSG.discard })}>
                    {ready.savedAt ? '释放内存' : '丢弃'}
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p class="muted small">当前标签页不是 YouTube 视频页。如果是，刷新一下那个页面（扩展安装或更新之前打开的页面里还没有录制脚本）。</p>
        )}
        <p class="muted small">快捷键 Alt+Shift+R 开始 / 停止（可在 chrome://extensions/shortcuts 修改）；录制中工具栏图标上显示 REC。</p>
      </section>

      {log && log.length > 0 && (
        <section class="panel" data-testid="clip-log">
          <h2>最近录过的片段（{log.length}）</h2>
          <ul class="clip-log">
            {log.slice(0, 30).map((r) => (
              <li>
                <button class="btn link" title="在当前标签页打开视频的这一段" onClick={() => void chrome.tabs.update({ url: clipWatchUrl(r) })}>
                  {r.title ?? r.videoId}
                </button>
                <span class="muted small">
                  {formatTimecode(r.start)}–{formatTimecode(r.end)} · {formatBytes(r.bytes)}
                  {r.burned ? ' · 带字幕' : ''} · {formatRelative(r.savedAt, Date.now())}
                </span>
                <span class="muted small clip-file">{r.fileName}</span>
              </li>
            ))}
          </ul>
          <div class="row">
            <button class="btn small" onClick={() => void clearClipLog(appCtx())}>
              清除记录
            </button>
            <span class="muted small">只清这份清单，下载文件夹里的文件不受影响。</span>
          </div>
        </section>
      )}

      <section class="panel">
        <p class="muted small">
          录制只在本机进行：画面和声音来自正在播放的这个视频（不是麦克风，也不是整个屏幕），不经过网络；广告、暂停、缓冲、切到别的标签页时自动暂停，换视频时自动结束。按当前倍速录。片段由浏览器存进下载文件夹（想每次自己选位置：Chrome 设置 → 下载内容 → "下载前询问每个文件的保存位置"），TubeMuse 只记文件名、时间段和大小。受版权保护（DRM）的视频浏览器不允许录。录下的片段仅供个人学习，请勿传播。
        </p>
      </section>
    </div>
  );
}
