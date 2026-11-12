// 语音按钮：明示识别方式（本地 / 云端），转写只回填输入框。
// Firefox 没有云端识别（DECISIONS §69）：本机模型可用就在本机识别；没有时写明为什么用不了、能不能下载，不假装在听。

import { useEffect, useRef, useState } from 'preact/hooks';
import { BROWSER_SPEECH_LANGS } from '../../config/defaults';
import { SPEECH_PLATFORM } from '../../platform';
import {
  browserSpeechEnv,
  chooseMode,
  describeMode,
  detectLocal,
  installLocal,
  noLocalMessage,
  startRecognition,
  type LocalAvailability,
  type VoiceMode,
} from '../../services/speech';

const env = browserSpeechEnv();

function openMicPermissionPage() {
  void chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
}

export function VoiceInput({ lang, preferLocal, onText }: { lang: string; preferLocal: boolean; onText: (text: string, isFinal: boolean) => void }) {
  /** 还没查出来时为空：这期间不下"用不了"的结论 */
  const [detected, setAvailability] = useState<LocalAvailability>();
  const availability: LocalAvailability = detected ?? 'unsupported';
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<{ msg: string; perm: boolean }>();
  const [installing, setInstalling] = useState(false);
  const handle = useRef<{ stop: () => void }>();

  useEffect(() => {
    setAvailability(undefined);
    void detectLocal(env, lang).then(setAvailability);
  }, [lang]);

  const mode: VoiceMode = chooseMode(preferLocal, availability);
  const supported = !!env.Recognition;
  const langName = (BROWSER_SPEECH_LANGS as Record<string, string>)[lang] ?? lang;
  /** 没有云端识别的浏览器（Firefox）：模型能下载时不管"优先本地"开没开都给下载按钮——不下载就识别不了 */
  const offerInstall = availability === 'downloadable' && (preferLocal || !SPEECH_PLATFORM.hasCloud);

  async function toggle() {
    if (listening) {
      handle.current?.stop();
      return;
    }
    setError(undefined);
    if (mode === 'none' && detected) {
      setError({ msg: noLocalMessage(availability, langName), perm: false });
      return;
    }
    const mic = (await env.queryMic?.()) ?? 'unknown';
    if (mic === 'denied') {
      setError({ msg: '麦克风权限被拒绝了。打开授权页后按提示在浏览器设置里允许本扩展使用麦克风。', perm: true });
      return;
    }
    if (mic === 'prompt') {
      setError({ msg: '侧边栏无法直接弹出麦克风授权框，需要先在新标签页里授权一次（之后就不用了）。', perm: true });
      return;
    }
    setListening(true);
    handle.current = startRecognition(env, lang, mode, {
      onText,
      onError: (msg, code) => setError({ msg, perm: code === 'not-allowed' || code === 'service-not-allowed' }),
      onEnd: () => setListening(false),
    });
  }

  if (!supported) return <div class="voice muted small">这个浏览器不支持语音识别</div>;
  return (
    <div class="voice">
      <button class={`btn mic${listening ? ' live' : ''}`} onClick={toggle} title={listening ? '停止' : '语音输入'} aria-pressed={listening}>
        {listening ? '■ 停止' : '🎤 说'}
      </button>
      <span class={`voice-mode ${mode}`} title={describeMode(mode)} data-testid="voice-mode">
        {mode === 'local' ? '本地识别' : mode === 'cloud' ? '云端识别（音频发往 Google）' : '本机没有可用的语音模型'}
      </span>
      {offerInstall && (
        <button
          class="btn link small"
          disabled={installing}
          onClick={async () => {
            setInstalling(true);
            const ok = await installLocal(env, lang);
            setInstalling(false);
            setAvailability(ok ? await detectLocal(env, lang) : 'unavailable');
          }}
        >
          {SPEECH_PLATFORM.hasCloud ? (installing ? '正在下载本地语音包…' : '下载本地语音包') : installing ? `正在下载本机语音模型（从 ${SPEECH_PLATFORM.packSource}）…` : '下载本机语音模型'}
        </button>
      )}
      {availability === 'downloading' && <span class="muted small">本地语音包下载中…</span>}
      {mode === 'none' && detected && !error && (
        <div class="voice-error small" data-testid="voice-unavailable">
          {noLocalMessage(availability, langName)}
        </div>
      )}
      {error && (
        <div class="voice-error small">
          {error.msg}
          {error.perm && (
            <button class="btn link small" onClick={openMicPermissionPage}>
              打开授权页
            </button>
          )}
        </div>
      )}
    </div>
  );
}
