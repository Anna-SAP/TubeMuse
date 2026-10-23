// 导师提醒：侧边栏顶部一条可关闭的横幅（不弹窗），附一个具体的小台阶。

import { reminderActions } from '../../services/reminder-service';
import { stores } from '../../services/repo';
import { appCtx, useStore } from '../shared/app';
import { openInCurrentTab } from '../shared/download';

export function ReminderBanner({ onUseUtterance }: { onUseUtterance: (u: string) => void }) {
  const ctx = appCtx();
  const state = useStore(stores.reminderState);
  const a = state?.active;
  if (!a || a.dismissed) return null;
  return (
    <aside class="reminder" role="status" data-testid="reminder">
      <div>{a.message}</div>
      {a.step?.kind === 'video' && a.step.videoId && (
        <div class="reminder-step">
          <a
            href={`https://www.youtube.com/watch?v=${a.step.videoId}`}
            onClick={(e) => {
              e.preventDefault();
              openInCurrentTab(a.step!.videoId!);
            }}
          >
            《{a.step.title}》
          </a>
          {a.step.channelTitle && <span class="muted small">（{a.step.channelTitle}）</span>}
          <div class="muted small">{a.step.why}</div>
        </div>
      )}
      {a.step?.kind === 'search' && a.step.utterance && (
        <div class="reminder-step">
          <button class="btn small" onClick={() => onUseUtterance(a.step!.utterance!)}>
            「{a.step.utterance}」
          </button>
          <div class="muted small">{a.step.why}</div>
        </div>
      )}
      <div class="row wrap">
        <button class="btn small" onClick={() => void reminderActions.dismiss(ctx)}>
          知道了
        </button>
        <button class="btn link small" onClick={() => void reminderActions.mute7(ctx)}>
          静音 7 天
        </button>
        <button class="btn link small" onClick={() => void reminderActions.disable(ctx)}>
          不再提醒
        </button>
      </div>
    </aside>
  );
}
