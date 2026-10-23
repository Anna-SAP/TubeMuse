import { describe, expect, it } from 'vitest';
import { chooseMode, detectLocal, describeMode, startRecognition, type RecognitionCtor, type RecognitionLike } from '../../src/services/speech';

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
