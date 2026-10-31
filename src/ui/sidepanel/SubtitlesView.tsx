// 自动字幕：当前标签页这个视频的字幕状态与开关、今日花费、已生成的字幕。
// 状态来自注入 YouTube 页面的字幕脚本（只在本扩展内部传递）；字幕文字来自本机存储。

import { useEffect, useMemo, useState } from 'preact/hooks';
import { SUBTITLE_LANGS } from '../../config/defaults';
import { formatAudioDuration, formatCueTime, formatUsd, type SubtitleTabState } from '../../core/subtitles';
import { formatClock } from '../../core/time';
import { stores, subtitleTrackStore } from '../../services/repo';
import { subtitleTranslationModel } from '../../services/subtitle-service';
import { useStore, useSubtitleSpend } from '../shared/app';
import { Notice } from '../shared/components';

const CAPTION_LABELS = { available: '有', unavailable: '没有', unknown: '还没判断出来' } as const;

/** 跟踪本窗口的当前标签页，向它的字幕脚本要状态，并接收它主动推送的变化 */
function useTabSubtitleState(): { tabId?: number; state?: SubtitleTabState | null } {
  const [tabId, setTabId] = useState<number>();
  const [state, setState] = useState<SubtitleTabState | null>();
  useEffect(() => {
    let windowId: number | undefined;
    let current: number | undefined;
    const ask = (id: number | undefined) => {
      current = id;
      setTabId(id);
      if (id === undefined) return setState(null);
      chrome.tabs.sendMessage(id, { type: 'tubemuse:subtitles:get-state' }).then(
        (s: SubtitleTabState | undefined) => current === id && setState(s ?? null),
        () => current === id && setState(null), // 不是 YouTube 页面（没有字幕脚本）
      );
    };
    const onActivated = (info: chrome.tabs.OnActivatedInfo) => info.windowId === windowId && ask(info.tabId);
    const onUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (tab.active && tab.windowId === windowId && (change.status === 'complete' || change.url)) ask(id);
    };
    const onMessage = (msg: unknown, sender: chrome.runtime.MessageSender) => {
      const m = msg as { type?: string; state?: SubtitleTabState };
      if (m?.type === 'tubemuse:subtitles:state' && sender.tab?.id === current && m.state) setState(m.state);
      return false;
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.runtime.onMessage.addListener(onMessage);
    void chrome.windows.getCurrent().then(async (w) => {
      windowId = w.id;
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      ask(tab?.id);
    });
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);
  return { ...(tabId !== undefined ? { tabId } : {}), state };
}

export function SubtitlesView() {
  const settings = useStore(stores.settings);
  const secrets = useStore(stores.secrets);
  const spend = useSubtitleSpend();
  const { tabId, state } = useTabSubtitleState();
  const videoId = state?.videoId;
  const trackStore = useMemo(() => (videoId ? subtitleTrackStore(videoId) : undefined), [videoId]);
  const track = useStore(trackStore);
  const [busy, setBusy] = useState(false);
  if (!settings || !secrets) return null;

  const toggle = async (on: boolean) => {
    if (tabId === undefined) return;
    setBusy(true);
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'tubemuse:subtitles:toggle', on });
    } catch {
      // 页面已关闭或换走：状态会随标签页事件刷新
    } finally {
      setBusy(false);
    }
  };

  const lines = (track?.cues ?? []).filter((c) => c.text);
  const { provider, model } = subtitleTranslationModel(settings);
  const s = settings.subtitles;

  return (
    <div class="subtitles">
      {!s.enabled && (
        <Notice kind="warn">
          自动字幕已在设置中关闭。
          <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
            打开设置
          </button>
        </Notice>
      )}
      {s.enabled && !secrets.openaiApiKey && (
        <Notice kind="warn">
          自动字幕需要 OpenAI API Key：语音转写只能用 OpenAI（Anthropic 没有语音转文字接口）。找片等其他功能可以继续用 Anthropic。
          <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
            去填写
          </button>
        </Notice>
      )}

      <section class="panel" data-testid="subtitle-tab">
        <h2>当前标签页</h2>
        {state ? (
          <>
            <dl class="kv">
              <dt>视频</dt>
              <dd>{state.videoId ?? '—'}</dd>
              <dt>原生字幕</dt>
              <dd>{CAPTION_LABELS[state.captions]}</dd>
              <dt>状态</dt>
              <dd data-testid="subtitle-status">{state.status}</dd>
              <dt>已生成</dt>
              <dd>
                {state.cues} 句{state.pending ? `（识别中 ${state.pending} 段）` : ''}
              </dd>
            </dl>
            {state.error && (
              <div class="notice notice-error" role="alert">
                <div class="notice-body">
                  <strong>{state.error.message}</strong>
                  {state.error.hint && <div class="muted">{state.error.hint}</div>}
                </div>
              </div>
            )}
            {state.videoId && s.enabled && (
              <div class="row">
                {state.active ? (
                  <button class="btn" disabled={busy} onClick={() => void toggle(false)}>
                    关闭这个视频的字幕
                  </button>
                ) : (
                  <button class="btn primary" disabled={busy} onClick={() => void toggle(true)}>
                    为这个视频生成字幕
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <p class="muted small">当前标签页不是 YouTube 视频页。如果是，刷新一下那个页面（扩展安装或更新之前打开的页面里还没有字幕脚本）。</p>
        )}
        <p class="muted small">快捷键 Alt+Shift+S 也能开关（可在 chrome://extensions/shortcuts 修改）。</p>
      </section>

      {spend && (
        <section class="panel">
          <h2>今日字幕花费</h2>
          <p data-testid="subtitle-spend-detail">
            {formatUsd(spend.spentUsd)} / ${spend.budgetUsd.toFixed(2)}：语音转写 {formatAudioDuration(spend.asrSeconds)}，翻译 {spend.translations} 句。
            {spend.exhausted && <strong class="warn-text"> 已到上限，已停止识别。</strong>}
          </p>
          <p class="muted small">
            本地估算{spend.estimatedPrice ? '（有模型不在价目表里，按保守单价估算）' : ''}，以 OpenAI / {provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} 账单为准；你的本地时间 {formatClock(spend.resetAt)} 重置。
          </p>
          <p class="muted small">
            去向：视频的声音（切成几秒一段）发往 OpenAI 转写为文字（{s.asrModel}）；转写出的文字发往{provider === 'anthropic' ? ' Anthropic' : ' OpenAI'}（{model}）翻译成
            {SUBTITLE_LANGS[s.targetLang]}（原文已是{SUBTITLE_LANGS[s.targetLang]}时译成 {SUBTITLE_LANGS[s.altTargetLang]}）。音频不保存，字幕文字只存在本机。
          </p>
        </section>
      )}

      {lines.length > 0 && (
        <section class="panel">
          <details>
            <summary>这个视频已生成的字幕（{lines.length} 句）</summary>
            <ol class="cue-list" data-testid="cue-list">
              {lines.map((c) => (
                <li>
                  <span class="cue-time">{formatCueTime(c.start)}</span>
                  <span class="cue-text">
                    {c.text}
                    {c.translation && <span class="cue-tr">{c.translation}</span>}
                    {c.translationError && <span class="muted small">未翻译：{c.translationError}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        </section>
      )}
    </div>
  );
}
