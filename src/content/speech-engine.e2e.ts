// 仅用于 e2e 构建（dist-e2e）：假的语音识别器。Playwright 的 Chromium 连不上 Google 的语音服务，
// 所以按固定节奏"听出"字：每句"第 N 句：我说到哪里了"逐字出现（interim），说完给 final，停顿一下再说下一句。
// 页面 <html data-fake-speech="network"> 时模拟"连不上语音服务"。正式构建不含本文件（构建自检会拦）。

import type { RecognitionCtor, RecognitionLike } from '../services/speech';

type Result = { isFinal: boolean; 0: { transcript: string } };

let sentence = 0;

class FakeSpeechRecognition implements RecognitionLike {
  lang = '';
  continuous = false;
  interimResults = false;
  processLocally?: boolean;
  onresult: RecognitionLike['onresult'] = null;
  onerror: RecognitionLike['onerror'] = null;
  onend: RecognitionLike['onend'] = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private results: Result[] = [];

  static async available(): Promise<string> {
    return 'downloadable';
  }

  start(track?: MediaStreamTrack): void {
    if (!track || track.kind !== 'audio' || track.readyState !== 'live') throw new DOMException('audio track is not live', 'InvalidStateError');
    if (document.documentElement.getAttribute('data-fake-speech') === 'network') {
      setTimeout(() => {
        this.onerror?.({ error: 'network' });
        this.onend?.();
      }, 300);
      return;
    }
    let phrase = '';
    let shown = 0;
    let pauseUntil = 0;
    this.timer = setInterval(() => {
      if (track.readyState !== 'live') return this.finish();
      const now = Date.now();
      if (!phrase) {
        if (now < pauseUntil) return;
        sentence++;
        phrase = `第 ${sentence} 句：我说到哪里了`;
        shown = 0;
        this.results.push({ isFinal: false, 0: { transcript: '' } });
      }
      shown = Math.min(phrase.length, shown + 2);
      const done = shown >= phrase.length;
      const index = this.results.length - 1;
      this.results[index] = { isFinal: done, 0: { transcript: phrase.slice(0, shown) } };
      this.onresult?.({ resultIndex: index, results: Object.assign([...this.results], { length: this.results.length }) });
      if (done) {
        phrase = '';
        pauseUntil = now + 700;
      }
    }, 150);
  }

  stop(): void {
    this.finish();
  }

  abort(): void {
    this.finish();
  }

  private finish(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    setTimeout(() => this.onend?.(), 0);
  }
}

export function speechRecognitionCtor(): RecognitionCtor | undefined {
  return FakeSpeechRecognition as unknown as RecognitionCtor;
}
