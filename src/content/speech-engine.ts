// 浏览器自带的语音识别（Web Speech API）。单独一个文件：e2e 构建会把它换成按脚本出字的假识别器
// （speech-engine.e2e.ts，Playwright 的 Chromium 连不上 Google 的语音服务），正式构建不含测试代码。

import type { RecognitionCtor } from '../services/speech';

export function speechRecognitionCtor(): RecognitionCtor | undefined {
  const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}
