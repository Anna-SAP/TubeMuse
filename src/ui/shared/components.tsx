import type { ComponentChildren } from 'preact';
import { formatClock } from '../../core/time';
import type { QuotaSnapshot } from '../../core/quota';
import type { XSnapshot } from '../../core/x-budget';
import { formatAudioDuration, formatUsd, type SubtitleSnapshot } from '../../core/subtitles';
import { AppError } from '../../services/errors';
import { attemptView } from '../../services/auth-service';
import type { AuthAttempt } from '../../services/repo';

export function ErrorBox({ error, onClose }: { error: AppError; onClose?: () => void }) {
  return (
    <div class="notice notice-error" role="alert">
      <div class="notice-body">
        <strong>{error.message}</strong>
        {error.hint && <div class="muted">{error.hint}</div>}
      </div>
      {onClose && (
        <button class="icon-btn" title="关闭" onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
}

/**
 * 最近一次连接 / 重新授权的进展。授权在后台执行，发起的页面关掉再打开也能看到：窗口还开着、失败原因、或窗口没交回结果。
 * hideFailure：这个页面刚才自己发起、已经在别处显示了同一个错误时不重复
 */
export function AuthAttemptNote({ attempt, hideFailure }: { attempt: AuthAttempt | null | undefined; hideFailure?: boolean }) {
  const v = attemptView(attempt, Date.now());
  if (v.state === 'pending') {
    return (
      <p class="muted small" data-testid="auth-pending">
        授权窗口已打开（{formatClock(v.startedAt)} 起）：在窗口里登录并选择账号，完成后这里会自动更新。关掉这个页面也没关系，结果会保存。
      </p>
    );
  }
  if (v.state === 'lost') {
    return <ErrorBox error={new AppError('auth', `${formatClock(v.startedAt)} 打开的授权窗口没有把结果交回扩展`, '再点一次"重新授权"，在弹出的窗口里完成登录、选择账号，结束前不要关闭它')} />;
  }
  if (v.state === 'failed' && !hideFailure) {
    return <ErrorBox error={new AppError('auth', `上次授权（${formatClock(v.at)}）没有完成：${v.message}`, v.hint)} />;
  }
  return null;
}

export function Notice({ kind = 'info', children, onClose }: { kind?: 'info' | 'warn' | 'ok'; children: ComponentChildren; onClose?: () => void }) {
  return (
    <div class={`notice notice-${kind}`}>
      <div class="notice-body">{children}</div>
      {onClose && (
        <button class="icon-btn" title="关闭" onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
}

function Bar({ label, used, limit, warn, title }: { label: string; used: number; limit: number; warn: boolean; title: string }) {
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  return (
    <div class={`quota-bar${warn ? ' warn' : ''}`} title={title}>
      <span class="quota-label">{label}</span>
      <span class="quota-track">
        <span class="quota-fill" style={{ width: `${pct}%` }} />
      </span>
      <span class="quota-num">
        {used.toLocaleString()}/{limit.toLocaleString()}
      </span>
    </div>
  );
}

function XBar({ x }: { x: XSnapshot }) {
  const pct = Math.min(100, Math.round(x.ratio * 100));
  return (
    <div class={`quota-bar${x.warn || x.blocked ? ' warn' : ''}`} title={`今日 X 花费（本地估算，按 UTC 日计，你的本地时间 ${formatClock(x.resetAt)} 重置）${x.blocked ? `。已停止：${x.blocked.reason}` : ''}`} data-testid="x-spend">
      <span class="quota-label">X $</span>
      <span class="quota-track">
        <span class="quota-fill" style={{ width: `${pct}%` }} />
      </span>
      <span class="quota-num">
        {x.spentUsd.toFixed(2)}/{x.budgetUsd.toFixed(2)}
      </span>
    </div>
  );
}

function SubBar({ sub }: { sub: SubtitleSnapshot }) {
  const pct = Math.min(100, Math.round(sub.ratio * 100));
  const title = `今日自动字幕花费${formatUsd(sub.spentUsd)}（本地估算${sub.estimatedPrice ? '，含按保守单价估算的部分' : ''}）：语音转写 ${formatAudioDuration(sub.asrSeconds)}、翻译 ${sub.translations} 句。你的本地时间 ${formatClock(sub.resetAt)} 重置`;
  return (
    <div class={`quota-bar${sub.warn || sub.exhausted ? ' warn' : ''}`} title={title} data-testid="subtitle-spend">
      <span class="quota-label">字幕 $</span>
      <span class="quota-track">
        <span class="quota-fill" style={{ width: `${pct}%` }} />
      </span>
      <span class="quota-num">
        {sub.spentUsd.toFixed(2)}/{sub.budgetUsd.toFixed(2)}
      </span>
    </div>
  );
}

/** 配额实时显示（本地估算），接近上限变色 */
export function QuotaMeter({ snap, x, sub }: { snap: QuotaSnapshot | undefined; x?: XSnapshot | undefined; sub?: SubtitleSnapshot | undefined }) {
  if (!snap) return null;
  const reset = `太平洋时间零点重置（你的本地时间 ${formatClock(snap.resetAt)}）；本地估算，仅统计本扩展的调用`;
  return (
    <div class="quota" aria-label="YouTube 配额">
      <Bar label="search" used={snap.search.used} limit={snap.search.limit} warn={snap.search.warn} title={`今日 search.list 次数。${reset}`} />
      <Bar label="units" used={snap.general.used} limit={snap.general.limit} warn={snap.general.warn} title={`今日其他接口 units。${reset}`} />
      {x && <XBar x={x} />}
      {sub && <SubBar sub={sub} />}
    </div>
  );
}

export function QuotaWarning({ snap }: { snap: QuotaSnapshot | undefined }) {
  if (!snap) return null;
  const msgs: string[] = [];
  if (snap.search.exhausted) msgs.push('今天的 search 次数已用完');
  else if (snap.search.warn) msgs.push(`今天的 search 已用 ${Math.round(snap.search.ratio * 100)}%，还剩 ${snap.search.remaining} 次`);
  if (snap.general.exhausted) msgs.push('今天的接口配额已用完');
  else if (snap.general.warn) msgs.push(`今天的接口配额已用 ${Math.round(snap.general.ratio * 100)}%`);
  if (!msgs.length) return null;
  return (
    <Notice kind="warn">
      {msgs.join('；')}。配额在你本地时间 {formatClock(snap.resetAt)} 重置。
    </Notice>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div class="spinner-row" role="status">
      <span class="spinner" />
      <span>{label}</span>
    </div>
  );
}
