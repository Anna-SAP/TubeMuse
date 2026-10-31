// 语音输入：Web Speech API。优先本地识别（processLocally，实验特性，先检测）；
// 否则使用浏览器的云端语音服务——界面会明示"音频将发送到 Google"。
// 侧边栏无法弹出麦克风授权框：需要先在标签页中打开 mic-permission.html 授权一次。

export type LocalAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';
export type MicState = 'granted' | 'denied' | 'prompt' | 'unknown';
export type VoiceMode = 'local' | 'cloud';

interface RecognitionResultList {
  length: number;
  [i: number]: { isFinal: boolean; 0: { transcript: string } };
}

export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  onresult: ((e: { resultIndex: number; results: RecognitionResultList }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  /** 传入音轨时识别这条音轨（Chrome 135+），不传则用麦克风 */
  start(audioTrack?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}

export interface RecognitionCtor {
  new (): RecognitionLike;
  available?: (opts: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (opts: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
}

export interface SpeechEnv {
  Recognition?: RecognitionCtor;
  queryMic?: () => Promise<MicState>;
}

export function browserSpeechEnv(): SpeechEnv {
  const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  const env: SpeechEnv = {
    queryMic: async () => {
      try {
        const s = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        return s.state as MicState;
      } catch {
        return 'unknown';
      }
    },
  };
  const Recognition = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (Recognition) env.Recognition = Recognition;
  return env;
}

export async function detectLocal(env: SpeechEnv, lang: string): Promise<LocalAvailability> {
  const R = env.Recognition;
  if (!R) return 'unsupported';
  if (typeof R.available !== 'function') return 'unsupported';
  try {
    const r = await R.available({ langs: [lang], processLocally: true });
    return r === 'available' || r === 'downloadable' || r === 'downloading' ? r : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** 下载本地语音包（由浏览器从 Google 下载模型，之后识别在本机完成） */
export async function installLocal(env: SpeechEnv, lang: string): Promise<boolean> {
  const R = env.Recognition;
  if (!R?.install) return false;
  try {
    return await R.install({ langs: [lang], processLocally: true });
  } catch {
    return false;
  }
}

export function chooseMode(preferLocal: boolean, availability: LocalAvailability): VoiceMode {
  return preferLocal && availability === 'available' ? 'local' : 'cloud';
}

export function describeMode(mode: VoiceMode): string {
  return mode === 'local' ? '本地识别：音频不离开这台电脑' : '云端识别：音频会发送到浏览器的语音服务（Google）';
}

export function speechErrorMessage(code: string, mode: VoiceMode): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '没有麦克风权限。侧边栏无法直接弹出授权框，请点"打开授权页"授权一次';
    case 'no-speech':
      return '没听到声音，再试一次？';
    case 'audio-capture':
      return '找不到可用的麦克风';
    case 'network':
      return '云端语音服务连不上（需要能访问 Google 的语音服务）';
    case 'language-not-supported':
      return mode === 'local' ? '本地识别暂不支持这个语言，可以在设置中关闭"优先本地识别"改用云端' : '语音服务不支持这个语言';
    case 'aborted':
      return '识别已取消';
    default:
      return `语音识别出错（${code}）`;
  }
}

export interface RecognitionHandlers {
  onText: (text: string, isFinal: boolean) => void;
  onError: (message: string, code: string) => void;
  onEnd: () => void;
}

/** 开始一次识别。转写只回填到输入框，由用户确认后才执行。 */
export function startRecognition(env: SpeechEnv, lang: string, mode: VoiceMode, h: RecognitionHandlers): { stop: () => void } {
  const R = env.Recognition;
  if (!R) {
    h.onError('这个浏览器不支持语音识别', 'unsupported');
    h.onEnd();
    return { stop: () => {} };
  }
  const rec = new R();
  rec.lang = lang;
  rec.continuous = false;
  rec.interimResults = true;
  if (mode === 'local') rec.processLocally = true;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!;
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    h.onText((finalText + interim).trim(), interim === '');
  };
  rec.onerror = (e) => h.onError(speechErrorMessage(e.error, mode), e.error);
  rec.onend = () => h.onEnd();
  rec.start();
  return { stop: () => rec.stop() };
}
