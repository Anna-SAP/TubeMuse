// 语音按钮：明示识别方式（本地 / 云端），转写只回填输入框。

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  browserSpeechEnv,
  chooseMode,
  describeMode,
  detectLocal,
  installLocal,
  startRecognition,
  type LocalAvailability,
  type VoiceMode,
} from '../../services/speech';

const env = browserSpeechEnv();

function openMicPermissionPage() {
  void chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
}

export function VoiceInput({ lang, preferLocal, onText }: { lang: string; preferLocal: boolean; onText: (text: string, isFinal: boolean) => void }) {
  const [availability, setAvailability] = useState<LocalAvailability>('unsupported');
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<{ msg: string; perm: boolean }>();
  const [installing, setInstalling] = useState(false);
  const handle = useRef<{ stop: () => void }>();

  useEffect(() => {
    void detectLocal(env, lang).then(setAvailability);
  }, [lang]);

  const mode: VoiceMode = chooseMode(preferLocal, availability);
  const supported = !!env.Recognition;

  async function toggle() {
    if (listening) {
      handle.current?.stop();
      return;
    }
    setError(undefined);
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
      <span class={`voice-mode ${mode}`} title={describeMode(mode)}>
        {mode === 'local' ? '本地识别' : '云端识别（音频发往 Google）'}
      </span>
      {preferLocal && availability === 'downloadable' && (
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
          {installing ? '正在下载本地语音包…' : '下载本地语音包'}
        </button>
      )}
      {availability === 'downloading' && <span class="muted small">本地语音包下载中…</span>}
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
