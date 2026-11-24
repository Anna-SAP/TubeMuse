// "从配音音频识别字幕"的任务（DECISIONS §91）：识别在侧边栏这个页面里跑，一次一个。
// 任务不跟着界面走：切到别的标签页、切到侧边栏别的功能页，识别照常进行，做完自动存成这个配音的字幕；关掉侧边栏才会中断——
// 中断了也不要紧：进度存在本机（services/dub-asr-service.ts），下次接着识别，付过钱的句子不重来。
// 这里只管两件事：用浏览器自带的解码器把一段 AAC 解成 16 kHz 单声道；把进度、结果、出错原因交给界面。

import { useEffect, useState } from 'preact/hooks';
import { SUBTITLES } from '../../config/defaults';
import type { DubAsrProgress, DubAsrSummary } from '../../core/dub-asr';
import type { AppContext } from '../../services/context';
import { DubAsrStopped, runDubAsr, type DubAsrDeps } from '../../services/dub-asr-service';
import { toAppError } from '../../services/errors';

export interface AsrJob {
  videoId: string;
  /** running：正在识别；stopping：你点了停止，在等在途的几句回来；done：存好了；stopped：停下了（可以接着识别）；error：出错了 */
  phase: 'running' | 'stopping' | 'done' | 'stopped' | 'error';
  progress?: DubAsrProgress;
  startedAt: number;
  summary?: DubAsrSummary;
  error?: { message: string; hint?: string };
}

let job: AsrJob | undefined;
let abort: AbortController | undefined;
const listeners = new Set<() => void>();

function set(next: AsrJob | undefined): void {
  job = next;
  for (const l of listeners) l();
}

/** 把一段音频字节（一帧一个 ADTS 头的 AAC）解成 16 kHz 单声道：浏览器解码时顺带换好采样率，多声道取平均 */
async function decode(data: Uint8Array): Promise<Float32Array> {
  const ac = new OfflineAudioContext(1, 1, SUBTITLES.sampleRate);
  const whole = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
  const buf = await ac.decodeAudioData((whole ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) as ArrayBuffer);
  const n = buf.length;
  const out = new Float32Array(n);
  const tmp = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    buf.copyFromChannel(tmp, c);
    for (let i = 0; i < n; i++) out[i]! += tmp[i]! / buf.numberOfChannels;
  }
  return out;
}

const deps: DubAsrDeps = { decode };

export const asrJob = {
  get: (): AsrJob | undefined => job,
  busy: (): boolean => job?.phase === 'running' || job?.phase === 'stopping',
  /** 开始（或接着）识别这个视频的配音；restart：不接着上次的进度，从头来 */
  async start(ctx: AppContext, videoId: string, restart = false): Promise<void> {
    if (asrJob.busy()) return;
    const startedAt = Date.now();
    abort = new AbortController();
    set({ videoId, phase: 'running', startedAt });
    const mine = () => job?.startedAt === startedAt;
    try {
      const r = await runDubAsr(ctx, videoId, deps, {
        signal: abort.signal,
        restart,
        onProgress: (progress) => {
          if (mine() && job) set({ ...job, progress });
        },
      });
      if (mine() && job) set({ ...job, phase: 'done', summary: r.summary });
    } catch (err) {
      if (!mine() || !job) return;
      if (err instanceof DubAsrStopped) return set({ ...job, phase: 'stopped' });
      const e = toAppError(err);
      set({ ...job, phase: 'error', error: { message: e.message, ...(e.hint ? { hint: e.hint } : {}) } });
    }
  },
  /** 停止：不再发新的句子；在途的几句等它们回来（钱已经花了），然后存好进度 */
  stop(): void {
    if (job?.phase !== 'running') return;
    abort?.abort();
    set({ ...job, phase: 'stopping' });
  },
  /** 收起做完 / 停下 / 出错的那一条 */
  clear(): void {
    if (!asrJob.busy()) set(undefined);
  },
};

export function useAsrJob(): AsrJob | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return job;
}
