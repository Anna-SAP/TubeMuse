import { describe, expect, it } from 'vitest';
import { chooseMode, detectLocal, describeMode, noLocalMessage, speechErrorMessage, startRecognition, type RecognitionCtor, type RecognitionLike } from '../../src/services/speech';
import type { SpeechPlatform } from '../../src/platform';

/** Firefox：没有云端识别，本机模型由 Mozilla 提供（DECISIONS §69） */
const FIREFOX: SpeechPlatform = { hasCloud: false, packSource: 'Mozilla' };

function fakeRecognition(availability: string | undefined) {
  const instances: RecognitionLike[] = [];
  class R implements RecognitionLike {
    lang = '';
    continuous = true;
    interimResults = false;
    processLocally?: boolean;
    onresult: RecognitionLike['onresult'] = null;
    onerror: RecognitionLike['onerror'] = null;
    onend: RecognitionLike['onend'] = null;
    started = false;
    constructor() {
      instances.push(this);
    }
    start() {
      this.started = true;
    }
    stop() {
      this.onend?.();
    }
    abort() {}
  }
  const ctor = R as unknown as RecognitionCtor;
  if (availability !== undefined) ctor.available = async () => availability;
  return { ctor, instances };
}

describe('语音：本地优先、去向透明', () => {
  it('不支持 available() 的浏览器 → unsupported → 云端（并明示）', async () => {
    const { ctor } = fakeRecognition(undefined);
    const a = await detectLocal({ Recognition: ctor }, 'zh-CN');
    expect(a).toBe('unsupported');
    expect(chooseMode(true, a)).toBe('cloud');
    expect(describeMode('cloud')).toContain('Google');
  });

  it('本地可用且偏好本地 → processLocally=true', async () => {
    const { ctor, instances } = fakeRecognition('available');
    const a = await detectLocal({ Recognition: ctor }, 'zh-CN');
    const mode = chooseMode(true, a);
    expect(mode).toBe('local');
    startRecognition({ Recognition: ctor }, 'zh-CN', mode, { onText: () => {}, onError: () => {}, onEnd: () => {} });
    expect(instances[0]!.processLocally).toBe(true);
    expect(instances[0]!.lang).toBe('zh-CN');
  });

  it('转写只回填文本（最终结果标记 isFinal），不自动执行', () => {
    const { ctor, instances } = fakeRecognition('available');
    const texts: [string, boolean][] = [];
    startRecognition({ Recognition: ctor }, 'en-US', 'cloud', { onText: (t, f) => texts.push([t, f]), onError: () => {}, onEnd: () => {} });
    const rec = instances[0]!;
    expect(rec.processLocally).toBeUndefined();
    rec.onresult!({ resultIndex: 0, results: { length: 1, 0: { isFinal: false, 0: { transcript: 'find ai' } } } });
    rec.onresult!({ resultIndex: 0, results: { length: 1, 0: { isFinal: true, 0: { transcript: 'find ai videos' } } } });
    expect(texts).toEqual([
      ['find ai', false],
      ['find ai videos', true],
    ]);
  });

  it('权限错误给出人话提示（指向授权页）', () => {
    const { ctor, instances } = fakeRecognition('available');
    const errs: string[] = [];
    startRecognition({ Recognition: ctor }, 'zh-CN', 'cloud', { onText: () => {}, onError: (m) => errs.push(m), onEnd: () => {} });
    instances[0]!.onerror!({ error: 'not-allowed' });
    expect(errs[0]).toContain('授权页');
  });
});

describe('没有云端识别的浏览器（Firefox）', () => {
  it('本机模型可用：在本机识别，"优先本地"关着也一样', () => {
    expect(chooseMode(true, 'available', FIREFOX)).toBe('local');
    expect(chooseMode(false, 'available', FIREFOX)).toBe('local');
  });

  it('本机模型不可用：mode 为 none，说明为什么、怎么办，不说"发往 Google"', () => {
    for (const a of ['unavailable', 'unsupported', 'downloadable', 'downloading'] as const) {
      expect(chooseMode(true, a, FIREFOX)).toBe('none');
      expect(noLocalMessage(a, '中文', FIREFOX)).not.toContain('Google');
    }
    expect(noLocalMessage('downloadable', '中文', FIREFOX)).toContain('Mozilla');
    expect(noLocalMessage('unavailable', '中文', FIREFOX)).toContain('打字');
    expect(describeMode('none')).not.toContain('Google');
  });

  it('mode 为 none 时不开始识别，直接说明', () => {
    const { ctor, instances } = fakeRecognition('unavailable');
    const errors: string[] = [];
    let ended = false;
    startRecognition({ Recognition: ctor }, 'zh-CN', 'none', { onText: () => {}, onError: (m) => errors.push(m), onEnd: () => (ended = true) }, FIREFOX);
    expect(instances).toHaveLength(0);
    expect(errors[0]).toContain('本机');
    expect(ended).toBe(true);
  });

  it('识别一声不响地结束（Firefox 识别不了时就是这样）：替它说出来；有过结果就不说', () => {
    const { ctor, instances } = fakeRecognition('available');
    const errors: string[] = [];
    startRecognition({ Recognition: ctor }, 'en-US', 'local', { onText: () => {}, onError: (m) => errors.push(m), onEnd: () => {} }, FIREFOX);
    instances[0]!.onend!();
    expect(errors[0]).toContain('没有识别出文字');
    const heard: string[] = [];
    startRecognition({ Recognition: ctor }, 'en-US', 'local', { onText: () => {}, onError: (m) => heard.push(m), onEnd: () => {} }, FIREFOX);
    instances[1]!.onresult!({ resultIndex: 0, results: { length: 1, 0: { isFinal: true, 0: { transcript: 'hi' } } } });
    instances[1]!.onend!();
    expect(heard).toEqual([]);
  });

  it('Chrome（有云端）：一声不响地结束时照旧不多说', () => {
    const { ctor, instances } = fakeRecognition('available');
    const errors: string[] = [];
    startRecognition({ Recognition: ctor }, 'en-US', 'cloud', { onText: () => {}, onError: (m) => errors.push(m), onEnd: () => {} });
    instances[0]!.onend!();
    expect(errors).toEqual([]);
  });

  it('本机模型不支持这个语言：指向换语言，不提"改用云端"', () => {
    expect(speechErrorMessage('language-not-supported', 'local', FIREFOX)).not.toContain('云端');
    expect(speechErrorMessage('language-not-supported', 'local')).toContain('云端');
  });
});
