// "保存完整双语视频"的任务（DECISIONS §83、§84）：合成在侧边栏这个页面里跑，一次一个。
// 任务不跟着界面走：切到别的标签页、切到侧边栏别的功能页，合成照常进行，做完自动交给浏览器保存；关掉侧边栏才会中断。
// 带上原声字幕时（§84），字幕按这个顺序找：你选的字幕文件 → 原视频文件里嵌着的字幕轨 → 从开着的 YouTube 页面取这个视频自带的字幕；
// 都没有时停下来问你（选一个字幕文件 / 不带字幕继续 / 取消），不悄悄合成一份没有字幕的。

import { useEffect, useState } from 'preact/hooks';
import { DUB } from '../../config/defaults';
import { dubMapOf, type DubRecord } from '../../core/dub';
import { exportFileName } from '../../core/dub-render';
import { Mp4Error } from '../../core/mp4-remux';
import { MULTICC_MSG } from '../../core/multi-captions';
import { SubtitleFileError, mp4Language, toSrt, type ExportCaptionReply, type SubCue, type SubSource } from '../../core/subtitle-track';
import { ExportCancelled, exportBilingual, probeSource, readEmbeddedSubtitles, readSubtitleFile, type ExportResult, type ExportSubtitles, type SourceProbe } from '../../services/dub-export';
import type { DubAudioStore } from '../../services/dub-store';

/** 这次合成用的字幕：从哪来、叫什么、多少句 */
export interface JobSubtitles {
  source: SubSource;
  /** 字幕文件的名字 / YouTube 字幕菜单里的名字 / 嵌着的那条轨的语言 */
  label: string;
  count: number;
}

export interface ExportOptions {
  /** 带上原声字幕（写成视频里一条可以开关的字幕轨） */
  subtitles: boolean;
  /** 现在开着这个视频的 YouTube 页面的那个标签页（可以从它那里取字幕）；没开着时不给 */
  youtubeTabId?: number;
}

export interface ExportJob {
  videoId: string;
  title: string;
  /** 你选的原视频文件 */
  sourceName: string;
  sourceBytes: number;
  /**
   * checking：正在读你选的文件；confirm：时长和 YouTube 上的对不上，等你确认；subs：正在准备字幕；
   * need-subs：要带字幕但没找到，等你决定；mixing：正在解码、混音、编码；
   * done：做完了（已交给浏览器保存）；error：出错了；cancelled：你取消了
   */
  phase: 'checking' | 'confirm' | 'subs' | 'need-subs' | 'mixing' | 'done' | 'error' | 'cancelled';
  source?: Pick<SourceProbe, 'durationSec' | 'video' | 'audio'>;
  /** YouTube 上这个视频的时长（关联配音时记下的）；和文件的时长差多少秒 */
  expectedSec?: number;
  /** 这次要不要带字幕（你在 need-subs 里选了"不带字幕"后变成 false） */
  wantSubtitles: boolean;
  /** 找到的字幕 */
  subtitles?: JobSubtitles;
  /** need-subs：为什么没找到（或你刚选的字幕文件哪里不对） */
  subtitlesProblem?: string;
  /** 已经混好多少秒（新文件的时间） */
  doneSec: number;
  /** 新文件一共多长（画面变速时和原视频不一样长，DECISIONS §87）；开始混之前没有 */
  totalSec?: number;
  startedAt: number;
  result?: Pick<ExportResult, 'bytes' | 'durationSec' | 'sourceSec' | 'speed' | 'dubSpeed' | 'audioLabel' | 'audioCodec' | 'aacFailed' | 'elapsedMs' | 'pieces'> & {
    fileName: string;
    savedAt: number;
    /** 写进视频的字幕（没带时没有这一项） */
    subtitles?: JobSubtitles;
    /** 要带字幕、也找到了，但没有一句落在视频时长以内：没有写入 */
    subtitlesEmpty?: boolean;
  };
  error?: { message: string; hint?: string };
}

/** 你事先为某个视频选好的字幕文件（只在这次打开侧边栏期间记着，不存本机） */
export interface ChosenSubtitleFile {
  name: string;
  cues: SubCue[];
  language: string;
}

let job: ExportJob | undefined;
/** 不放进 job（不拿去渲染）的东西：文件、读出来的索引、字幕、合成好的文件 */
let held:
  | {
      file: File;
      rec: DubRecord;
      store: DubAudioStore | undefined;
      options: ExportOptions;
      probe?: SourceProbe;
      subtitles?: ExportSubtitles & { source: SubSource; label: string };
      abort?: AbortController;
      blob?: Blob;
      srt?: string;
    }
  | undefined;
const chosen = new Map<string, ChosenSubtitleFile>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}
function set(next: ExportJob | undefined): void {
  job = next;
  notify();
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

/** 从文件名里认语言：yt-dlp 存的字幕叫"标题.en.vtt"、"标题.zh-Hans.srt" */
function languageOfFileName(name: string): string {
  const m = /\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.(?:srt|vtt)$/i.exec(name);
  return mp4Language(m?.[1]);
}

const LANGUAGE_NAMES: Record<string, string> = { eng: 'English', zho: '中文', jpn: '日本語', kor: '한국어', fra: 'Français', deu: 'Deutsch', spa: 'Español' };
/** 播放器字幕菜单里显示的名字 */
const trackName = (language: string, fallback: string) => LANGUAGE_NAMES[language] ?? fallback;

async function parseChosen(file: File): Promise<ChosenSubtitleFile> {
  return { name: file.name, cues: await readSubtitleFile(file), language: languageOfFileName(file.name) };
}

function problemText(e: unknown): string {
  if (e instanceof SubtitleFileError) return e.hint ? `${e.message}：${e.hint}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

/** 向开着这个视频的 YouTube 页面要它自带的原声字幕 */
async function fetchFromYouTube(tabId: number, videoId: string): Promise<ExportCaptionReply | { ok: false; problem: string }> {
  try {
    const r = (await chrome.tabs.sendMessage(tabId, { type: MULTICC_MSG.exportCaptions })) as ExportCaptionReply | undefined;
    if (!r) return { ok: false, problem: '那个 YouTube 页面没有回话（换了视频，或者页面是扩展更新之前打开的：刷新一下）' };
    if (r.videoId !== videoId) return { ok: false, problem: '那个标签页现在放的已经不是这个视频了' };
    return r;
  } catch {
    return { ok: false, problem: '那个 YouTube 页面没有回话（页面关了，或者是扩展更新之前打开的：刷新一下）' };
  }
}

/** 找字幕：你选的字幕文件 → 原视频文件里嵌着的 → YouTube 上这个视频自带的。找到了记在 held.subtitles；没找到返回原因 */
async function findSubtitles(): Promise<string | undefined> {
  const h = held;
  if (!h?.probe) return '还没读到原视频文件';
  const file = chosen.get(h.rec.videoId);
  if (file) {
    h.subtitles = { cues: file.cues, language: file.language, name: trackName(file.language, 'Subtitles'), source: 'file', label: file.name };
    return undefined;
  }
  const embedded = await readEmbeddedSubtitles(h.file, h.probe);
  if (embedded) {
    h.subtitles = { cues: embedded.cues, language: embedded.language, name: trackName(embedded.language, 'Subtitles'), source: 'embedded', label: embedded.language === 'und' ? '语言没写明' : embedded.language };
    return undefined;
  }
  if (h.options.youtubeTabId === undefined) return '原视频文件里没有嵌着字幕，现在也没开着这个视频的 YouTube 页面（开着时可以从那里取它自带的字幕）';
  const r = await fetchFromYouTube(h.options.youtubeTabId, h.rec.videoId);
  if (!r.ok) return `原视频文件里没有嵌着字幕；从 YouTube 页面也没取到：${r.problem}`;
  const language = mp4Language(r.lang);
  h.subtitles = { cues: r.cues, language, name: r.label || trackName(language, 'Subtitles'), source: 'youtube', label: r.label || r.lang };
  return undefined;
}

async function run(): Promise<void> {
  const h = held;
  if (!h?.probe || !job) return;
  const mine = job.startedAt;
  const abort = new AbortController();
  h.abort = abort;
  const subs = job.wantSubtitles ? h.subtitles : undefined;
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
      // 整体倍速（DECISIONS §87）一起写进去：和开着配音时听到、看到的一样
      ...(h.rec.overallRate !== undefined ? { overallRate: h.rec.overallRate } : {}),
      ...(subs ? { subtitles: { cues: subs.cues, language: subs.language, name: subs.name } } : {}),
      signal: abort.signal,
      onProgress: (p) => {
        // 一秒一秒地报太碎：每推进 1% 左右更新一次界面
        if (job?.startedAt === mine && (p.done - shown >= p.total / 100 || p.done >= p.total)) {
          shown = p.done;
          patch({ doneSec: p.done, totalSec: p.total });
        }
      },
    });
    if (job?.startedAt !== mine) return;
    const fileName = exportFileName(h.rec, h.file.name);
    h.blob = result.blob;
    h.srt = result.subtitleCues ? toSrt(result.subtitleCues) : undefined;
    save(result.blob, fileName);
    patch({
      phase: 'done',
      doneSec: result.durationSec,
      result: {
        bytes: result.bytes,
        durationSec: result.durationSec,
        sourceSec: result.sourceSec,
        speed: result.speed,
        dubSpeed: result.dubSpeed,
        audioLabel: result.audioLabel,
        audioCodec: result.audioCodec,
        ...(result.aacFailed ? { aacFailed: result.aacFailed } : {}),
        // 从你选好文件算起（含读文件、准备字幕、万一 AAC 不行重来的那一遍）
        elapsedMs: Date.now() - mine,
        pieces: result.pieces,
        ...(subs && result.subtitleCues ? { subtitles: { source: subs.source, label: subs.label, count: result.subtitleCues.length } } : {}),
        ...(subs && !result.subtitleCues ? { subtitlesEmpty: true } : {}),
        fileName,
        savedAt: Date.now(),
      },
    });
  } catch (e) {
    if (job?.startedAt === mine) fail(e);
  }
}

/** 时长核对过了：要带字幕就先把字幕找齐，找不到停下来问；然后合成 */
async function proceed(): Promise<void> {
  const h = held;
  if (!h || !job) return;
  const mine = job.startedAt;
  try {
    if (job.wantSubtitles && !h.subtitles) {
      patch({ phase: 'subs' });
      const problem = await findSubtitles();
      if (job?.startedAt !== mine || job.phase !== 'subs') return;
      if (problem) return patch({ phase: 'need-subs', subtitlesProblem: problem });
      // findSubtitles 把找到的记在 held 上
      const found = held?.subtitles;
      if (found) patch({ subtitles: { source: found.source, label: found.label, count: found.cues.length } });
    }
    await run();
  } catch (e) {
    if (job?.startedAt === mine) fail(e);
  }
}

export const exportJob = {
  get: (): ExportJob | undefined => job,
  /** 正在干活（这时不能开始另一个）；等你确认 / 等你决定字幕时不算 */
  busy: (): boolean => job?.phase === 'checking' || job?.phase === 'subs' || job?.phase === 'mixing',
  /** 你选好了原视频文件：先读一下是不是能用、时长对不对得上，对得上就直接开始 */
  async start(rec: DubRecord, file: File, store: DubAudioStore | undefined, options: ExportOptions): Promise<void> {
    if (exportJob.busy()) return;
    held = { file, rec, store, options };
    const startedAt = Date.now();
    set({
      videoId: rec.videoId,
      title: rec.title || rec.videoId,
      sourceName: file.name,
      sourceBytes: file.size,
      phase: 'checking',
      wantSubtitles: options.subtitles,
      doneSec: 0,
      startedAt,
      ...(rec.videoDurationSec ? { expectedSec: rec.videoDurationSec } : {}),
    });
    try {
      const probe = await probeSource(file);
      if (job?.startedAt !== startedAt || !held) return;
      held.probe = probe;
      patch({ source: { durationSec: probe.durationSec, video: probe.video, audio: probe.audio } });
      const off = rec.videoDurationSec ? Math.abs(probe.durationSec - rec.videoDurationSec) : 0;
      if (off > DUB.export.durationToleranceSec) return patch({ phase: 'confirm' });
      await proceed();
    } catch (e) {
      if (job?.startedAt === startedAt) fail(e);
    }
  },
  /** 时长对不上时你点了"仍然合成" */
  async confirm(): Promise<void> {
    if (job?.phase === 'confirm') await proceed();
  },
  /** 没找到字幕时你选了一个字幕文件：读得出来就用它接着合成，读不出来留在原地说明哪里不对 */
  async provideSubtitleFile(file: File): Promise<void> {
    if (job?.phase !== 'need-subs' || !held) return;
    const mine = job.startedAt;
    try {
      const parsed = await parseChosen(file);
      if (job?.startedAt !== mine || !held) return;
      chosen.set(held.rec.videoId, parsed);
      notify();
      await proceed();
    } catch (e) {
      if (job?.startedAt === mine) patch({ subtitlesProblem: `「${file.name}」用不了：${problemText(e)}` });
    }
  },
  /** 没找到字幕时你选了"不带字幕，继续" */
  async skipSubtitles(): Promise<void> {
    if (job?.phase !== 'need-subs') return;
    patch({ wantSubtitles: false });
    await proceed();
  },
  cancel(): void {
    held?.abort?.abort();
    if (job?.phase === 'confirm' || job?.phase === 'checking' || job?.phase === 'subs' || job?.phase === 'need-subs') patch({ phase: 'cancelled' });
  },
  /** 再存一次（浏览器拦下了下载，或者想再要一份） */
  saveAgain(): void {
    if (job?.phase === 'done' && job.result && held?.blob) {
      save(held.blob, job.result.fileName);
      patch({ result: { ...job.result, savedAt: Date.now() } });
    }
  },
  /** 把写进视频的那份字幕另存成 .srt：和视频同名，放在一起时多数播放器会自动加载 */
  saveSubtitles(): void {
    if (job?.phase !== 'done' || !job.result?.subtitles || !held?.srt) return;
    save(new Blob([held.srt], { type: 'application/x-subrip;charset=utf-8' }), job.result.fileName.replace(/\.mp4$/, '.srt'));
  },
  /** 收起这一条（合成好的文件不再留着） */
  clear(): void {
    if (exportJob.busy()) return;
    held = undefined;
    set(undefined);
  },

  /** 事先为这个视频选一个字幕文件（合成时优先用它）；读不出来时抛出原因 */
  async chooseSubtitleFile(videoId: string, file: File): Promise<ChosenSubtitleFile> {
    const parsed = await parseChosen(file);
    chosen.set(videoId, parsed);
    notify();
    return parsed;
  },
  chosenSubtitleFile: (videoId: string): ChosenSubtitleFile | undefined => chosen.get(videoId),
  dropSubtitleFile(videoId: string): void {
    chosen.delete(videoId);
    notify();
  },
  subtitleProblem: problemText,
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
