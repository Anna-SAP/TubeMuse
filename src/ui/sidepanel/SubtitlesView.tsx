// 字幕页：多语字幕（YouTube 原生字幕叠加）的语言与开关；自动字幕的状态与开关、今日花费、已生成的字幕。
// 状态来自注入 YouTube 页面的字幕脚本（只在本扩展内部传递）；字幕文字来自本机存储。

import { useMemo, useState } from 'preact/hooks';
import { BROWSER_SPEECH_LANGS, MULTI_CC, SUBTITLE_LANGS } from '../../config/defaults';
import { MULTICC_MSG, type CcOption, type MultiCcTabState } from '../../core/multi-captions';
import { RECOGNITION_MODE_LABELS, formatAudioDuration, formatCueTime, formatUsd, speechLangName, type SubtitleTabState } from '../../core/subtitles';
import { formatClock } from '../../core/time';
import { stores, subtitleTrackStore } from '../../services/repo';
import { subtitleTranslationModel } from '../../services/subtitle-service';
import { useStore, useSubtitleSpend } from '../shared/app';
import { Notice } from '../shared/components';
import { useActiveTabState } from '../shared/tab-state';

const CAPTION_LABELS = { available: '有', unavailable: '没有', unknown: '还没判断出来' } as const;

/** 识别语言是怎么定的 */
const LANG_SOURCE_LABELS = { setting: '设置里指定', video: '按视频的语言', title: '按标题文字推断', default: '默认', manual: '你选的' } as const;

export function SubtitlesView() {
  const settings = useStore(stores.settings);
  const secrets = useStore(stores.secrets);
  const spend = useSubtitleSpend();
  const { tabId, state } = useActiveTabState<SubtitleTabState>('tubemuse:subtitles:get-state', 'tubemuse:subtitles:state');
  const videoId = state?.videoId;
  const trackStore = useMemo(() => (videoId ? subtitleTrackStore(videoId) : undefined), [videoId]);
  const track = useStore(trackStore);
  const [busy, setBusy] = useState(false);
  if (!settings || !secrets) return null;

  const setLang = async (lang: string) => {
    if (tabId === undefined) return;
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'tubemuse:subtitles:set-lang', lang });
    } catch {
      // 页面已关闭或换走
    }
  };

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
  const openai = (state?.engine ?? s.asrEngine) === 'openai';
  const rec = state?.recognition;

  return (
    <div class="subtitles">
      <MultiCaptionsPanel />
      {!s.enabled && (
        <Notice kind="warn">
          自动字幕已在设置中关闭。
          <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
            打开设置
          </button>
        </Notice>
      )}
      {s.enabled && openai && !secrets.openaiApiKey && (
        <Notice kind="warn">
          转写方式是 OpenAI，需要 OpenAI API Key（Anthropic 没有语音转文字接口）。也可以在设置页改用免费的浏览器识别。
          <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
            去填写
          </button>
        </Notice>
      )}

      <section class="panel" data-testid="subtitle-tab">
        <h2>自动字幕（语音识别 + 翻译）</h2>
        {state ? (
          <>
            <dl class="kv">
              <dt>视频</dt>
              <dd>{state.videoId ?? '—'}</dd>
              <dt>原生字幕</dt>
              <dd>{CAPTION_LABELS[state.captions]}</dd>
              <dt>状态</dt>
              <dd data-testid="subtitle-status">{state.status}</dd>
              <dt>转写</dt>
              <dd data-testid="subtitle-mode">{openai ? RECOGNITION_MODE_LABELS.openai : rec?.mode ? `浏览器识别 · ${RECOGNITION_MODE_LABELS[rec.mode]}` : '浏览器识别（还没开始）'}</dd>
              {!openai && rec && rec.lang && (
                <>
                  <dt>识别语言</dt>
                  <dd>
                    <select class="input" data-testid="subtitle-lang" value={rec.lang} onChange={(e) => void setLang(e.currentTarget.value)}>
                      {!(rec.lang in BROWSER_SPEECH_LANGS) && <option value={rec.lang}>{speechLangName(rec.lang)}</option>}
                      {Object.entries(BROWSER_SPEECH_LANGS)
                        .filter(([code]) => code !== 'auto')
                        .map(([code, name]) => (
                          <option value={code}>{name}</option>
                        ))}
                    </select>
                    <div class="muted small">
                      {LANG_SOURCE_LABELS[rec.source]}
                      {rec.note ? `：${rec.note}` : ''}
                    </div>
                  </dd>
                </>
              )}
              <dt>已生成</dt>
              <dd>
                {state.cues} 句{state.pending ? `（处理中 ${state.pending} 句）` : ''}
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
            {formatUsd(spend.spentUsd)} / ${spend.budgetUsd.toFixed(2)}：{spend.asrSeconds ? `OpenAI 转写 ${formatAudioDuration(spend.asrSeconds)}，` : ''}翻译 {spend.translations} 句。{openai ? '' : '浏览器识别不收费。'}
            {spend.exhausted && <strong class="warn-text"> 已到上限，已停止识别。</strong>}
          </p>
          <p class="muted small">
            本地估算{spend.estimatedPrice ? '（有模型不在价目表里，按保守单价估算）' : ''}，以 OpenAI / {provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} 账单为准；你的本地时间 {formatClock(spend.resetAt)} 重置。
          </p>
          <p class="muted small">
            去向：
            {openai
              ? `视频的声音（切成几秒一段）发往 OpenAI 转写为文字（${s.asrModel}）`
              : `视频的声音交给浏览器自带的语音识别（${rec?.mode ? RECOGNITION_MODE_LABELS[rec.mode] : '装了本地语音包时在本机识别，否则由 Chrome 发往 Google'}）`}
            ；转写出的文字发往{provider === 'anthropic' ? ' Anthropic' : ' OpenAI'}（{model}）翻译成
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

const CC_KIND_LABELS: Record<CcOption['kind'], { text: string; cls: string }> = {
  native: { text: '原生字幕', cls: 'ok' },
  asr: { text: 'YouTube 自动生成', cls: 'sub' },
  auto: { text: 'YouTube 机翻', cls: 'approx' },
  missing: { text: '这个视频没有', cls: '' },
};

/** 多语字幕：当前视频有哪些 YouTube 字幕、正在显示哪几种；勾选只对这个视频生效 */
function MultiCaptionsPanel() {
  const settings = useStore(stores.settings);
  const { tabId, state } = useActiveTabState<MultiCcTabState>(MULTICC_MSG.getState, MULTICC_MSG.state);
  const [busy, setBusy] = useState(false);
  if (!settings) return null;
  const cc = settings.multiCaptions;

  const send = async (msg: object) => {
    if (tabId === undefined) return;
    setBusy(true);
    try {
      await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      // 页面已关闭或换走：状态会随标签页事件刷新
    } finally {
      setBusy(false);
    }
  };
  const checked = (state?.options ?? []).filter((o) => o.checked).map((o) => o.code);
  const full = checked.length >= MULTI_CC.maxLines;
  const toggleLang = (o: CcOption) => void send({ type: MULTICC_MSG.setLangs, langs: o.checked ? checked.filter((c) => c !== o.code) : [...checked, o.code] });

  return (
    <section class="panel" data-testid="multicc-panel">
      <h2>多语字幕（YouTube 字幕叠加显示）</h2>
      {!cc.enabled && (
        <Notice kind="warn">
          多语字幕已在设置中关闭。
          <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
            打开设置
          </button>
        </Notice>
      )}
      {state ? (
        <>
          <p data-testid="multicc-status">{state.status}</p>
          {state.error?.hint && <p class="muted small">{state.error.hint}</p>}
          {state.options.length > 0 && (
            <ul class="cc-langs" data-testid="multicc-langs">
              {state.options.map((o) => {
                const kind = CC_KIND_LABELS[o.kind];
                return (
                  <li>
                    <label class="inline">
                      <input type="checkbox" checked={o.checked} disabled={busy || (!o.checked && full)} onChange={() => toggleLang(o)} />
                      <span class="cc-lang-name">{o.label}</span>
                      <span class={`badge ${kind.cls}`}>
                        {kind.text}
                        {o.original ? ' · 原声' : ''}
                      </span>
                      {o.cues !== undefined && <span class="muted small">{o.cues} 句</span>}
                    </label>
                    {(o.note || o.error) && <div class="muted small cc-lang-note">{o.error ?? o.note}</div>}
                  </li>
                );
              })}
            </ul>
          )}
          {state.overridden && (
            <button class="btn link small" disabled={busy} onClick={() => void send({ type: MULTICC_MSG.setLangs, langs: null })}>
              这个视频改回默认语言
            </button>
          )}
          {state.videoId && cc.enabled && (
            <div class="row">
              {state.active ? (
                <button class="btn" disabled={busy} onClick={() => void send({ type: MULTICC_MSG.toggle, on: false })}>
                  关闭多语字幕
                </button>
              ) : (
                <button class="btn primary" disabled={busy} onClick={() => void send({ type: MULTICC_MSG.toggle, on: true })}>
                  显示多语字幕
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <p class="muted small">当前标签页不是 YouTube 视频页。如果是，刷新一下那个页面（扩展安装或更新之前打开的页面里还没有多语字幕脚本）。</p>
      )}
      <p class="muted small">
        快捷键 Alt+Shift+C。勾选只对这个视频生效，最多 {MULTI_CC.maxLines} 种；默认语言在设置页「13. 多语字幕」里改。
      </p>
      <p class="muted small">
        字幕来自 YouTube 播放页自己的字幕接口：复用播放器的字幕请求，只换语言（和你在播放器字幕菜单里换语言时一样），只存在这个标签页的内存里。显示期间 TubeMuse 暂时关掉 YouTube 原生字幕，关闭多语字幕时恢复。"机翻"是 YouTube 自带的自动翻译，不花钱。
      </p>
    </section>
  );
}
