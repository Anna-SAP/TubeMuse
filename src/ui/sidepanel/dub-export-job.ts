// "保存完整双语视频"的任务（DECISIONS §83）：合成在侧边栏这个页面里跑，一次一个。
// 任务不跟着界面走：切到别的标签页、切到侧边栏别的功能页，合成照常进行，做完自动交给浏览器保存；关掉侧边栏才会中断。

import { useEffect, useState } from 'preact/hooks';
import { DUB } from '../../config/defaults';
import { dubMapOf, type DubRecord } from '../../core/dub';
import { exportFileName } from '../../core/dub-render';
import { Mp4Error } from '../../core/mp4-remux';
import { ExportCancelled, exportBilingual, probeSource, type ExportResult, type SourceProbe } from '../../services/dub-export';
import type { DubAudioStore } from '../../services/dub-store';

export interface ExportJob {
  videoId: string;
  title: string;
  /** 你选的原视频文件 */
  sourceName: string;
  sourceBytes: number;
  /**
   * checking：正在读你选的文件；confirm：时长和 YouTube 上的对不上，等你确认；mixing：正在解码、混音、编码；
   * done：做完了（已交给浏览器保存）；error：出错了；cancelled：你取消了
   */
  phase: 'checking' | 'confirm' | 'mixing' | 'done' | 'error' | 'cancelled';
  source?: Pick<SourceProbe, 'durationSec' | 'video' | 'audio'>;
  /** YouTube 上这个视频的时长（关联配音时记下的）；和文件的时长差多少秒 */
  expectedSec?: number;
  /** 已经混好多少秒 */
  doneSec: number;
  startedAt: number;
  result?: Pick<ExportResult, 'bytes' | 'durationSec' | 'audioLabel' | 'audioCodec' | 'aacFailed' | 'elapsedMs' | 'pieces'> & { fileName: string; savedAt: number };
  error?: { message: string; hint?: string };
}

let job: ExportJob | undefined;
/** 不放进 job（不拿去渲染）的东西：文件、读出来的索引、合成好的文件 */
let held: { file: File; rec: DubRecord; probe?: SourceProbe; abort?: AbortController; blob?: Blob; store: DubAudioStore | undefined } | undefined;
const listeners = new Set<() => void>();

function set(next: ExportJob | undefined): void {
  job = next;
  for (const l of listeners) l();
}
function patch(p: Partial<ExportJob>): void {
  if (job) set({ ...job, ...p });
}

/** 交给浏览器存进下载文件夹（不经过网络）。文件可能很大，地址多留一会儿再收回 */
function save(blob: Blob, fileName: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 120_000);
}

function fail(e: unknown): void {
  if (e instanceof ExportCancelled) return patch({ phase: 'cancelled' });
  const message = e instanceof Error ? e.message : String(e);
  patch({ phase: 'error', error: { message: e instanceof Mp4Error ? message : `合成出错：${message}`, ...(e instanceof Mp4Error && e.hint ? { hint: e.hint } : {}) } });
}

async function run(): Promise<void> {
  const h = held;
  if (!h?.probe || !job) return;
  const mine = job.startedAt;
  const abort = new AbortController();
  h.abort = abort;
  patch({ phase: 'mixing', doneSec: 0 });
  try {
    const dub = await h.store?.get(h.rec.fileId);
    if (!dub) throw new Mp4Error('本机找不到这个视频的配音音频', '在「配音」页给这个视频重新选一次 .m4a 文件。');
    let shown = 0;
    const result = await exportBilingual({
      file: h.file,
      probe: h.probe,
      dub,
      map: dubMapOf(h.rec),
      signal: abort.signal,
      onProgress: (p) => {
        // 一秒一秒地报太碎：每推进 1% 左右更新一次界面
        if (job?.startedAt === mine && (p.done - shown >= p.total / 100 || p.done >= p.total)) {
          shown = p.done;
          patch({ doneSec: p.done });
        }
      },
    });
    if (job?.startedAt !== mine) return;
    const fileName = exportFileName(h.rec, h.file.name);
    h.blob = result.blob;
    save(result.blob, fileName);
    patch({ phase: 'done', doneSec: result.durationSec, result: {
        bytes: result.bytes,
        durationSec: result.durationSec,
        audioLabel: result.audioLabel,
        audioCodec: result.audioCodec,
        ...(result.aacFailed ? { aacFailed: result.aacFailed } : {}),
        // 从你选好文件算起（含读文件、万一 AAC 不行重来的那一遍）
        elapsedMs: Date.now() - mine,
        pieces: result.pieces,
        fileName,
        savedAt: Date.now(),
      },
    });
  } catch (e) {
    if (job?.startedAt === mine) fail(e);
  }
}

export const exportJob = {
  get: (): ExportJob | undefined => job,
  busy: (): boolean => job?.phase === 'checking' || job?.phase === 'mixing',
  /** 你选好了原视频文件：先读一下是不是能用、时长对不对得上，对得上就直接开始 */
  async start(rec: DubRecord, file: File, store: DubAudioStore | undefined): Promise<void> {
    if (exportJob.busy()) return;
    held = { file, rec, store };
    const startedAt = Date.now();
    set({ videoId: rec.videoId, title: rec.title || rec.videoId, sourceName: file.name, sourceBytes: file.size, phase: 'checking', doneSec: 0, startedAt, ...(rec.videoDurationSec ? { expectedSec: rec.videoDurationSec } : {}) });
    try {
      const probe = await probeSource(file);
      if (job?.startedAt !== startedAt || !held) return;
      held.probe = probe;
      patch({ source: { durationSec: probe.durationSec, video: probe.video, audio: probe.audio } });
      const off = rec.videoDurationSec ? Math.abs(probe.durationSec - rec.videoDurationSec) : 0;
      if (off > DUB.export.durationToleranceSec) return patch({ phase: 'confirm' });
      await run();
    } catch (e) {
      if (job?.startedAt === startedAt) fail(e);
    }
  },
  /** 时长对不上时你点了"仍然合成" */
  async confirm(): Promise<void> {
    if (job?.phase === 'confirm') await run();
  },
  cancel(): void {
    held?.abort?.abort();
    if (job?.phase === 'confirm' || job?.phase === 'checking') patch({ phase: 'cancelled' });
  },
  /** 再存一次（浏览器拦下了下载，或者想再要一份） */
  saveAgain(): void {
    if (job?.phase === 'done' && job.result && held?.blob) {
      save(held.blob, job.result.fileName);
      patch({ result: { ...job.result, savedAt: Date.now() } });
    }
  },
  /** 收起这一条（合成好的文件不再留着） */
  clear(): void {
    if (exportJob.busy()) return;
    held = undefined;
    set(undefined);
  },
};

export function useExportJob(): ExportJob | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return job;
}
