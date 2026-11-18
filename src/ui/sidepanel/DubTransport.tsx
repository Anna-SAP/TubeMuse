// 视频控制键（用户 2026-11-18 要求，见 DECISIONS §85）：「配音」页对齐图的图例下面一排按键——暂停 / 继续，
// 后退 5 / 10 / 30 / 60 秒，前进 5 / 10 / 15 / 30 / 60 秒。对着对齐图调对齐时，不用离开侧边栏去点 YouTube 的播放器。
// 按键只是给 YouTube 页面里的配音脚本发一条消息，由它对 <video> 暂停 / 继续、改播放位置；配音不用另外管，
// 视频一停、一跳，它照现在的对齐（偏移和对齐点，或快速对齐的倍速）自己跟上。做不成时（广告、页面没回话）把原因写在按键下面。

import { useEffect, useRef, useState } from 'preact/hooks';
import { DUB } from '../../config/defaults';
import { DUB_MSG, formatClockSec, seekLabel, type DubControl, type DubControlReply, type DubTabState } from '../../core/dub';

async function sendControl(tabId: number | undefined, control: DubControl): Promise<DubControlReply | undefined> {
  if (tabId === undefined) return undefined;
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: DUB_MSG.control, ...control })) as DubControlReply | undefined;
  } catch {
    return undefined;
  }
}

export function DubTransport({ tabId, state, onDone }: { tabId: number | undefined; state: DubTabState; onDone: () => void }) {
  const [problem, setProblem] = useState<string>();
  /** 刚按下暂停 / 播放、页面还没报回新状态时，按键上先显示按下之后的样子 */
  const [pending, setPending] = useState<boolean>();
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  useEffect(() => setPending(undefined), [state.videoPaused]);

  const hasVideo = state.videoTime !== undefined;
  // 跳转、缓冲途中视频没在走，但也不是停着：按"停没停"写按键，按下去做的才和写的一样
  const playing = pending ?? state.videoPaused === false;
  const run = async (control: DubControl) => {
    setProblem(undefined);
    if (control.action === 'toggle-play') setPending(!playing);
    const reply = await sendControl(tabId, control);
    if (!alive.current) return;
    if (!reply) {
      setPending(undefined);
      setProblem('YouTube 页面没有回话：页面可能已经关掉或换走了；是扩展更新之前打开的页面的话，刷新一下。');
    } else if (!reply.ok) {
      setPending(undefined);
      setProblem(reply.problem ?? '没有做成');
    }
    onDone();
  };
  const seek = (by: number) => (
    <button class="btn small" data-testid="dub-seek" data-by={by} disabled={!hasVideo} title={`视频${by < 0 ? '后退' : '前进'} ${Math.abs(by)} 秒`} onClick={() => void run({ action: 'seek', by })}>
      {seekLabel(by)}
    </button>
  );
  return (
    <div class="dub-transport" data-testid="dub-transport" role="group" aria-label="控制视频">
      <div class="dub-transport-keys">
        <span class="muted small dub-transport-lbl">视频</span>
        <span class="dub-transport-group" role="group" aria-label="后退">
          {[...DUB.transport.backSec].sort((a, b) => b - a).map((sec) => seek(-sec))}
        </span>
        <button class="btn small primary dub-transport-play" data-testid="dub-play" data-playing={playing ? 'true' : 'false'} disabled={!hasVideo} onClick={() => void run({ action: 'toggle-play' })}>
          {playing ? '暂停' : '播放'}
        </button>
        <span class="dub-transport-group" role="group" aria-label="前进">
          {DUB.transport.forwardSec.map((sec) => seek(sec))}
        </span>
        {state.videoTime !== undefined && state.videoDuration !== undefined && (
          <span class="muted small dub-transport-at" data-testid="dub-transport-at">
            {formatClockSec(state.videoTime)} / {formatClockSec(state.videoDuration)}
          </span>
        )}
      </div>
      {problem ? (
        <p class="small warn-text" data-testid="dub-transport-problem" role="alert">
          {problem}
        </p>
      ) : (
        !hasVideo && (
          <p class="muted small" data-testid="dub-transport-note">
            读到视频的播放位置后可用（广告期间不能前进 / 后退）。
          </p>
        )
      )}
    </div>
  );
}
