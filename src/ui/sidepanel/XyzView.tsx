// 小宇宙（DECISIONS §72）：当前标签页这一集的字幕（开关、显示方式、整集生成、下载）、片段快照、收藏、收听记录。
// 状态来自注入小宇宙页面的脚本（只在本扩展内部传递）；字幕、收藏、收听记录来自本机存储。
// 快照的波形和音频片段：向后台要这一段的音频（后台只读小宇宙 CDN 上的公开音频），在侧边栏里解码。

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { XYZ } from '../../config/defaults';
import { parseTimecode } from '../../core/clips';
import { waveformBars } from '../../core/podcast-audio';
import { base64ToBytes, formatAudioDuration, formatUsd } from '../../core/subtitles';
import { dayKey } from '../../core/time';
import {
  LISTEN_STATUS_LABELS,
  XYZ_DISPLAY_LABELS,
  XYZ_EXPORT_LABELS,
  XYZ_MSG,
  addSnapshot,
  applyXyzOp,
  checkSnapRange,
  cueLines,
  defaultSnapRange,
  episodeUrl,
  estimateXyzUsd,
  exportTranscript,
  filterXyzSaved,
  formatRangeLabel,
  formatXyzTime,
  listenCompletion,
  listenStatus,
  listensByDay,
  pickXyzCue,
  podcastUrl,
  smallCover,
  snapShareText,
  snapTexts,
  xyzFileBase,
  xyzTagCounts,
  type XyzCue,
  type XyzDisplay,
  type XyzEpisodeInfo,
  type XyzExportFormat,
  type XyzKind,
  type XyzListItem,
  type XyzOp,
  type XyzSnapshotRecord,
  type XyzTabState,
} from '../../core/xyz';
import { newId, stores, xyzTranscriptStore } from '../../services/repo';
import { subtitleTranslationModel } from '../../services/subtitle-service';
import { xyzPolishModel } from '../../services/xyz-service';
import { encodeWavPcm } from '../../core/podcast-audio';
import { appCtx, useStore, useSubtitleSpend } from '../shared/app';
import { copyPngToClipboard } from '../shared/clipboard';
import { Notice } from '../shared/components';
import { downloadBlob, downloadText } from '../shared/download';
import { useActiveTabState } from '../shared/tab-state';
import { TagChips, TagEditor, TagFilterBar, TagManager } from '../shared/tags';
import { SHORTCUTS_PAGE, SPEECH_PLATFORM } from '../../platform';
import { canvasPng, drawCard } from './xyz-card';

type Sub = 'captions' | 'snap' | 'saved' | 'listens';

const NO_RESPONSE = '小宇宙页面没有回应：刷新那个页面再试（扩展安装或更新之前打开的页面里还没有 TubeMuse 的脚本）';

async function tell<T>(tabId: number | undefined, msg: Record<string, unknown>): Promise<T | undefined> {
  if (tabId === undefined) return undefined;
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as T | undefined;
  } catch {
    return undefined;
  }
}

async function saveOp(op: XyzOp): Promise<string | undefined> {
  let error: string | undefined;
  await stores.xyzSaved.update(appCtx().kv, appCtx().locker, (st) => {
    const r = applyXyzOp(st, op);
    error = r.error;
    return r.state;
  });
  return error;
}

// ── 读音频（快照的波形与音频片段） ──

type WindowReply = { ok: true; audio: string; mime: string; firstTime: number; skipSec: number; endTime: number } | { ok: false; message: string; hint?: string; wait?: boolean };

async function readWindow(audioUrl: string, from: number, to: number): Promise<WindowReply> {
  try {
    return ((await chrome.runtime.sendMessage({ type: XYZ_MSG.window, audioUrl, from, to })) as WindowReply | undefined) ?? { ok: false, message: '扩展后台没有回应' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

async function decodeAt(b64: string, sampleRate: number, channels: number): Promise<AudioBuffer> {
  const bytes = base64ToBytes(b64);
  return new OfflineAudioContext(channels, 1, sampleRate).decodeAudioData(bytes.buffer as ArrayBuffer);
}

function channelData(buf: AudioBuffer, from: number, to: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const a = Math.max(0, Math.floor(from * buf.sampleRate));
    const b = Math.min(buf.length, Math.ceil(to * buf.sampleRate));
    const own = new Float32Array(Math.max(0, b - a));
    buf.copyFromChannel(own, c, a);
    out.push(own);
  }
  return out;
}

/** 快照波形显示的范围：片段两边各多显示一些（总长不超过后台一次能读的 120 秒） */
function waveRange(from: number, to: number, duration: number): { a: number; b: number } {
  const len = to - from;
  const pad = Math.min(Math.max(XYZ.snapContextMinSec, len * XYZ.snapContextRatio), (118 - len) / 2);
  const a = Math.max(0, from - pad);
  const b = Math.min(duration || to + pad, to + pad);
  return { a, b };
}

// ── 当前这一集 ──

function EpisodeHeader({ info, tab }: { info: XyzEpisodeInfo; tab: XyzTabState }) {
  const saved = useStore(stores.xyzSaved);
  const epSaved = !!saved?.episodes[info.eid];
  const podSaved = !!(info.pid && saved?.podcasts[info.pid]);
  const toggleEpisode = () =>
    void saveOp(
      epSaved
        ? { op: 'remove', kind: 'episode', id: info.eid }
        : {
            op: 'save',
            kind: 'episode',
            item: {
              id: info.eid,
              title: info.title,
              podcastTitle: info.podcastTitle,
              ...(info.pid ? { pid: info.pid } : {}),
              ...(info.cover ? { cover: info.cover } : {}),
              ...(info.duration ? { duration: info.duration } : {}),
              ...(info.pubDate ? { pubDate: info.pubDate } : {}),
              tags: [],
              savedAt: Date.now(),
            },
          },
    );
  const togglePodcast = () =>
    info.pid &&
    void saveOp(podSaved ? { op: 'remove', kind: 'podcast', id: info.pid } : { op: 'save', kind: 'podcast', item: { id: info.pid, title: info.podcastTitle, ...(info.cover ? { cover: info.cover } : {}), tags: [], savedAt: Date.now() } });
  return (
    <section class="panel xyz-head" data-testid="xyz-episode">
      {info.cover ? <img class="xyz-cover" src={smallCover(info.cover)} alt="" width={64} height={64} /> : <div class="xyz-cover xyz-cover-empty">{Array.from(info.podcastTitle || '宇')[0]}</div>}
      <div class="xyz-head-main">
        <a class="xyz-title" href={episodeUrl(info.eid)} target="_blank" rel="noopener noreferrer" data-testid="xyz-title">
          {info.title || '（无标题）'}
        </a>
        <div class="muted small">
          {info.pid ? (
            <a href={podcastUrl(info.pid)} target="_blank" rel="noopener noreferrer">
              {info.podcastTitle}
            </a>
          ) : (
            info.podcastTitle
          )}
          {tab.duration ? ` · ${formatXyzTime(tab.duration)}` : ''}
          {tab.playing ? ' · 播放中' : ''}
        </div>
        <div class="row wrap xyz-head-actions">
          <button class={`btn small${epSaved ? ' on' : ''}`} aria-pressed={epSaved} data-testid="xyz-save-episode" onClick={toggleEpisode}>
            {epSaved ? '★ 已收藏这一集' : '☆ 收藏这一集'}
          </button>
          {info.pid && (
            <button class={`btn small${podSaved ? ' on' : ''}`} aria-pressed={podSaved} data-testid="xyz-save-podcast" onClick={togglePodcast}>
              {podSaved ? '★ 已收藏节目' : '☆ 收藏节目'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

// ── 字幕 ──

function CaptionsPanel({ tabId, tab, cues, transcriptDone }: { tabId: number | undefined; tab: XyzTabState; cues: XyzCue[]; transcriptDone: number }) {
  const settings = useStore(stores.settings);
  const secrets = useStore(stores.secrets);
  const spend = useSubtitleSpend();
  const [confirmWhole, setConfirmWhole] = useState(false);
  const [format, setFormat] = useState<XyzExportFormat>('srt-bilingual');
  const [error, setError] = useState<string>();
  const listRef = useRef<HTMLOListElement>(null);
  const currentId = pickXyzCue(cues, tab.truePos)?.id;
  // 当前这句滚到看得见的地方（hook 要放在下面的提前返回之前）
  useEffect(() => {
    listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [currentId]);
  if (!settings || !secrets) return null;
  const x = settings.xyz;
  const openai = x.asrEngine === 'openai';
  const polishModel = xyzPolishModel(settings);
  const { provider } = subtitleTranslationModel(settings);
  const llmKey = provider === 'anthropic' ? secrets.anthropicApiKey : secrets.openaiApiKey;
  const info = tab.info;
  const current = pickXyzCue(cues, tab.truePos);
  const remaining = Math.max(0, (tab.duration || 0) - transcriptDone);
  const estimate = estimateXyzUsd(remaining, openai ? settings.subtitles.asrModel || 'gpt-transcribe' : undefined, polishModel);
  const setX = (patch: Partial<typeof x>) => void stores.settings.update(appCtx().kv, appCtx().locker, (s) => ({ ...s, xyz: { ...s.xyz, ...patch } }));

  const toggle = async (on: boolean) => {
    setError(undefined);
    const r = await tell<XyzTabState>(tabId, { type: XYZ_MSG.toggle, on });
    if (!r) setError(NO_RESPONSE);
  };
  const whole = async (on: boolean) => {
    setConfirmWhole(false);
    const r = await tell<XyzTabState>(tabId, { type: XYZ_MSG.whole, on });
    if (!r) setError(NO_RESPONSE);
  };
  const seek = async (c: XyzCue) => {
    const r = await tell<{ ok: boolean; message?: string }>(tabId, { type: XYZ_MSG.seek, to: c.start });
    if (!r?.ok) setError(r?.message ?? NO_RESPONSE);
  };
  const download = async () => {
    if (!info) return;
    const t = await xyzTranscriptStore(info.eid).read(appCtx().kv);
    if (!t) return;
    const f = exportTranscript(t, info, format);
    downloadText(`${xyzFileBase(info.title, info.eid)}.${format === 'srt-zh' ? 'zh.' : format === 'srt-en' ? 'en.' : ''}${f.ext}`, f.text, f.mime);
  };
  const lines = cues.filter((c) => c.raw || c.zh || c.en);
  return (
    <>
      {!x.enabled && (
        <Notice kind="warn">
          小宇宙功能已在设置中关闭。
          <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
            打开设置
          </button>
        </Notice>
      )}
      {x.enabled && openai && !secrets.openaiApiKey && (
        <Notice kind="warn">
          <span data-testid="xyz-need-openai">转写方式是 OpenAI（质量最好），需要 OpenAI API Key。</span>
          <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
            去填写
          </button>
          <button class="btn link small" data-testid="xyz-use-browser" onClick={() => setX({ asrEngine: 'browser' })}>
            改用浏览器识别（免费）
          </button>
        </Notice>
      )}
      {x.enabled && x.polish && !llmKey && (
        <Notice kind="warn">
          校对 / 翻译要用 {provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API Key（没有它只显示转写原文、没有另一种语言）。
          <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
            去填写
          </button>
        </Notice>
      )}
      <section class="panel" data-testid="xyz-captions">
        <h2>中英字幕</h2>
        <dl class="kv">
          <dt>状态</dt>
          <dd data-testid="xyz-status">{tab.status}</dd>
          <dt>转写</dt>
          <dd>
            {openai ? `OpenAI（${settings.subtitles.asrModel || 'gpt-transcribe'}）` : `浏览器识别（${SPEECH_PLATFORM.hasCloud ? '装了本地语音包时在本机，否则声音发往 Google' : '只在本机识别'}）`}
            {!openai && <div class="muted small">浏览器识别只能按 1 倍速边放边认，质量不如 OpenAI；在设置页「18. 小宇宙」可以换回。</div>}
          </dd>
          <dt>校对 / 翻译</dt>
          <dd>{polishModel ? `${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}（${polishModel}）：改错字、补标点、统一人名术语，译出另一种语言` : '关闭（只显示转写原文）'}</dd>
          <dt>已生成</dt>
          <dd data-testid="xyz-progress">
            {formatXyzTime(transcriptDone)} / {formatXyzTime(tab.duration)} · {lines.length} 句{tab.pending ? `（转写中 ${tab.pending} 句）` : ''}
          </dd>
        </dl>
        {tab.scan !== undefined && tab.scan < 1 && (
          <p class="muted small" data-testid="xyz-scan">
            正在建立时间索引 {Math.round(tab.scan * 100)}%：这一集是可变码率 mp3，要先把音频文件读一遍（只读帧头，不保存音频）。
          </p>
        )}
        {tab.timingNote && <p class="warn-text small">{tab.timingNote}</p>}
        {tab.error && (
          <div class="notice notice-error" role="alert" data-testid="xyz-error">
            <div class="notice-body">
              <strong>{tab.error.message}</strong>
              {tab.error.hint && <div class="muted">{tab.error.hint}</div>}
              {openai && /OpenAI|额度|充值|credit|billing/i.test(tab.error.message + (tab.error.hint ?? '')) && (
                <button class="btn link small" onClick={() => setX({ asrEngine: 'browser' })}>
                  改用浏览器识别（免费）
                </button>
              )}
            </div>
          </div>
        )}
        {error && (
          <Notice kind="warn" onClose={() => setError(undefined)}>
            {error}
          </Notice>
        )}
        <div class="row wrap">
          {tab.active ? (
            <button class="btn" data-testid="xyz-toggle" onClick={() => void toggle(false)}>
              关闭字幕
            </button>
          ) : (
            <button class="btn primary" data-testid="xyz-toggle" disabled={!x.enabled} onClick={() => void toggle(true)}>
              开始字幕
            </button>
          )}
          <div class="seg" role="group" aria-label="页面上显示">
            {(['bilingual', 'zh', 'en', 'off'] as XyzDisplay[]).map((d) => (
              <button class={`seg-btn${x.display === d ? ' on' : ''}`} aria-pressed={x.display === d} data-testid={`xyz-display-${d}`} onClick={() => setX({ display: d })}>
                {d === 'bilingual' ? '双语' : d === 'zh' ? '中文' : d === 'en' ? 'English' : '不显示'}
              </button>
            ))}
          </div>
        </div>
        <p class="muted small">
          字幕叠在小宇宙页面底部播放器上方（{XYZ_DISPLAY_LABELS[x.display]}）。边听边转写，最多提前 {Math.round(x.lookaheadSec / 60)} 分钟；暂停时转写到那里就停。快捷键 Alt+Shift+S 也能开关（可在 {SHORTCUTS_PAGE} 修改）。
        </p>
        <div class="xyz-whole">
          {tab.whole ? (
            <div class="row wrap">
              <progress max={tab.duration || 1} value={transcriptDone} />
              <span class="small">{Math.round((transcriptDone / Math.max(1, tab.duration)) * 100)}%</span>
              <button class="btn small" data-testid="xyz-whole-stop" onClick={() => void whole(false)}>
                停止
              </button>
            </div>
          ) : confirmWhole ? (
            <div class="row wrap">
              <span class="small" data-testid="xyz-whole-estimate">
                还有 {formatAudioDuration(remaining)} 没生成，预计约 {formatUsd(estimate)}
                {spend ? `（今天的字幕额度还剩 ${formatUsd(spend.remainingUsd)}）` : ''}。
              </span>
              <button class="btn small primary" data-testid="xyz-whole-go" onClick={() => void whole(true)}>
                确认生成
              </button>
              <button class="btn small" onClick={() => setConfirmWhole(false)}>
                取消
              </button>
            </div>
          ) : (
            <button class="btn small" data-testid="xyz-whole" disabled={!x.enabled || !tab.duration || remaining < 1} onClick={() => setConfirmWhole(true)}>
              {remaining < 1 && tab.duration ? '整集字幕已生成' : '生成整集字幕（用于下载）'}
            </button>
          )}
        </div>
      </section>

      <section class="panel">
        <h2>下载字幕</h2>
        <div class="row wrap">
          <select class="input" value={format} data-testid="xyz-format" onChange={(e) => setFormat(e.currentTarget.value as XyzExportFormat)}>
            {(Object.keys(XYZ_EXPORT_LABELS) as XyzExportFormat[]).map((f) => (
              <option value={f}>{XYZ_EXPORT_LABELS[f]}</option>
            ))}
          </select>
          <button class="btn" data-testid="xyz-download" disabled={!lines.length} onClick={() => void download()}>
            下载
          </button>
        </div>
        <p class="muted small">
          {lines.length
            ? remaining >= 1
              ? `只含已生成的部分（${formatXyzTime(transcriptDone)}）；要完整的字幕先点"生成整集字幕"。`
              : '整集字幕已生成。'
            : '还没有字幕：先点"开始字幕"。'}
          文件由浏览器存进下载文件夹，不经过网络。
        </p>
      </section>

      {lines.length > 0 && (
        <section class="panel">
          <details open>
            <summary>这一集的字幕（{lines.length} 句，点一句跳到那里）</summary>
            <ol class="cue-list xyz-cues" ref={listRef} data-testid="xyz-cue-list">
              {lines.map((c) => {
                const l = cueLines(c);
                return (
                  <li class={current?.id === c.id ? 'on' : ''} onClick={() => void seek(c)}>
                    <span class="cue-time">{formatXyzTime(c.start)}</span>
                    <span class="cue-text">
                      {l.zh || l.en || c.raw}
                      {l.zh && l.en && <span class="cue-tr">{l.en}</span>}
                      {c.polishError && <span class="muted small">未校对：{c.polishError}</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
          </details>
        </section>
      )}
      {spend && (
        <p class="muted small" data-testid="xyz-spend">
          今天的字幕花费（与 YouTube 自动字幕共用"字幕 $"额度）：{formatUsd(spend.spentUsd)} / ${spend.budgetUsd.toFixed(2)}。去向：
          {openai ? '这一集的音频（几秒一句）发往 OpenAI 转写' : '这一集的音频交给浏览器自带的语音识别'}；
          {polishModel ? `转写出的文字和节目名、标题、简介摘录发往${provider === 'anthropic' ? ' Anthropic' : ' OpenAI'}校对 / 翻译` : '不校对、不翻译'}。音频只在内存里，不保存；字幕文字只存在本机。
        </p>
      )}
    </>
  );
}

// ── 片段快照 ──

/** 输入框里的时间：00:21 或 00:21.2（精确到 0.1 秒） */
function timeText(sec: number): string {
  const tenth = Math.round((sec % 1) * 10) % 10;
  return formatXyzTime(sec) + (tenth ? `.${tenth}` : '');
}

interface SnapSource {
  eid: string;
  title: string;
  podcastTitle: string;
  cover?: string;
  color?: string;
  audioUrl?: string;
  duration: number;
}

function SnapshotPanel({ tabId, tab, cues }: { tabId: number | undefined; tab: XyzTabState; cues: XyzCue[] }) {
  const info = tab.info;
  const log = useStore(stores.xyzSnapshots) ?? [];
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');
  const [zh, setZh] = useState('');
  const [en, setEn] = useState('');
  const [edited, setEdited] = useState(false);
  const [wave, setWave] = useState<{ key: string; bars?: number[]; a: number; b: number; problem?: string }>();
  const [preview, setPreview] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn'; text: string }>();
  const [record, setRecord] = useState<XyzSnapshotRecord>();
  const coverRef = useRef<HTMLImageElement>();
  const src: SnapSource | undefined = record
    ? { eid: record.eid, title: record.title, podcastTitle: record.podcastTitle, ...(record.cover ? { cover: record.cover } : {}), ...(record.color ? { color: record.color } : {}), ...(record.audioUrl ? { audioUrl: record.audioUrl } : {}), duration: 0 }
    : info
      ? { eid: info.eid, title: info.title, podcastTitle: info.podcastTitle, ...(info.cover ? { cover: info.cover } : {}), ...(info.color ? { color: info.color } : {}), ...(info.audioUrl ? { audioUrl: info.audioUrl } : {}), duration: tab.duration }
      : undefined;
  const start = parseTimecode(startText);
  const end = parseTimecode(endText);
  const problem = startText || endText ? checkSnapRange(start, end, src?.duration) : undefined;
  const valid = !!src && start !== null && end !== null && !problem;

  // 第一次打开：默认是当前这句（不够 20 秒连上后面几句）
  useEffect(() => {
    if (!info || record) return;
    const r = defaultSnapRange(cues, tab.truePos, tab.duration || undefined);
    // 只填空着的框：你已经开始输入的不覆盖
    setStartText((cur) => cur || timeText(r.start));
    setEndText((cur) => cur || timeText(r.end));
  }, [info?.eid]);

  // 字幕文字跟着片段走（你改过就不再覆盖）
  useEffect(() => {
    if (!valid || edited || record) return;
    const t = snapTexts(cues, start!, end!);
    setZh(t.zh);
    setEn(t.en);
  }, [valid, start, end, cues, edited]);

  // 在页面进度条上标出片段；离开这一页时去掉
  useEffect(() => {
    if (record || !info) return;
    void tell(tabId, { type: XYZ_MSG.mark, mark: valid ? { from: start, to: end } : null });
  }, [tabId, valid, start, end, record]);
  useEffect(() => () => void tell(tabId, { type: XYZ_MSG.mark, mark: null }), [tabId]);

  // 封面
  useEffect(() => {
    coverRef.current = undefined;
    if (!src?.cover) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      coverRef.current = img;
      setWave((w) => (w ? { ...w } : w));
    };
    img.src = smallCover(src.cover);
  }, [src?.cover]);

  // 波形：片段前后的真实音频（停手 0.4 秒后再读）
  useEffect(() => {
    if (!valid || !src?.audioUrl) return;
    const { a, b } = waveRange(start!, end!, src.duration);
    const key = `${src.audioUrl}|${a.toFixed(1)}|${b.toFixed(1)}`;
    if (wave?.key === key) return;
    const t = setTimeout(() => {
      void (async () => {
        const r = await readWindow(src.audioUrl!, a, b);
        if (!r.ok) return setWave({ key, a, b, problem: r.message });
        try {
          const buf = await decodeAt(r.audio, 8000, 1);
          const [pcm] = channelData(buf, a - r.firstTime, b - r.firstTime);
          setWave({ key, a, b, bars: waveformBars(pcm!, XYZ.waveformBars) });
        } catch (e) {
          setWave({ key, a, b, problem: `解码失败（${e instanceof Error ? e.message : String(e)}）` });
        }
      })();
    }, 400);
    return () => clearTimeout(t);
  }, [valid, start, end, src?.audioUrl]);

  const card = () => {
    if (!src || start === null || end === null) return undefined;
    const w = wave && wave.key.startsWith(`${src.audioUrl}|`) ? wave : undefined;
    const span = w ? w.b - w.a : 1;
    return drawCard({
      title: src.title,
      podcastTitle: src.podcastTitle,
      cover: coverRef.current,
      color: src.color,
      zh,
      en,
      bars: w?.bars,
      selFrom: w ? (start - w.a) / span : 0.3,
      selTo: w ? (end - w.a) / span : 0.7,
      label: formatRangeLabel(start, end),
      url: episodeUrl(src.eid),
    });
  };

  // 预览图
  useEffect(() => {
    if (!valid) return setPreview(undefined);
    const t = setTimeout(() => {
      const c = card();
      if (!c) return;
      void canvasPng(c).then(
        (png) => setPreview((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(png);
        }),
        () => setPreview(undefined),
      );
    }, 150);
    return () => clearTimeout(t);
  }, [valid, start, end, zh, en, wave, src?.title]);

  const remember = async () => {
    if (!src || start === null || end === null) return;
    const rec: XyzSnapshotRecord = {
      id: newId('snap'),
      eid: src.eid,
      title: src.title,
      podcastTitle: src.podcastTitle,
      ...(src.cover ? { cover: src.cover } : {}),
      ...(src.color ? { color: src.color } : {}),
      ...(src.audioUrl ? { audioUrl: src.audioUrl } : {}),
      start,
      end,
      zh,
      en,
      createdAt: Date.now(),
    };
    await stores.xyzSnapshots.update(appCtx().kv, appCtx().locker, (l) => addSnapshot(l, rec));
  };

  const fileBase = () => (src && start !== null && end !== null ? `${xyzFileBase(src.title, src.eid)}_${formatXyzTime(start).replace(/:/g, '-')}_${formatXyzTime(end).replace(/:/g, '-')}` : 'snapshot');

  const exportImage = async () => {
    const c = card();
    if (!c) return;
    setMsg(undefined);
    // 剪贴板要在点击的这一刻登记（见 Capture，DECISIONS §62）
    const png = canvasPng(c);
    const copied = copyPngToClipboard(png, 5000);
    try {
      downloadBlob(`${fileBase()}.png`, await png);
      const r = await copied;
      setMsg(r.ok ? { kind: 'ok', text: '图片已存进下载文件夹，也放进了剪贴板（切到微信等应用可以直接粘贴）。' } : { kind: 'warn', text: `图片已存进下载文件夹；没能放进剪贴板：${r.skipped ? '原因不明' : r.message}` });
      await remember();
    } catch (e) {
      setMsg({ kind: 'warn', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const copyLink = async () => {
    if (!src || start === null || end === null) return;
    try {
      await navigator.clipboard.writeText(snapShareText(src, start, end));
      setMsg({ kind: 'ok', text: '链接已复制（小宇宙的单集链接不认时间参数，片段的起止写在链接上方）。' });
      await remember();
    } catch (e) {
      setMsg({ kind: 'warn', text: `没能复制：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const share = async () => {
    const c = card();
    if (!c || !src || start === null || end === null) return;
    setMsg(undefined);
    const png = canvasPng(c);
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    const file = new File([await png], `${fileBase()}.png`, { type: 'image/png' });
    const data: ShareData = { files: [file], title: src.title, text: snapShareText(src, start, end) };
    if (typeof nav.share === 'function' && nav.canShare?.(data)) {
      try {
        await nav.share(data);
        await remember();
        return setMsg({ kind: 'ok', text: '已交给系统的分享面板。' });
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return;
      }
    }
    // 这个浏览器（或系统）没有带图片的分享：放进剪贴板，自己粘贴
    const r = await copyPngToClipboard(png, 5000);
    setMsg(
      r.ok
        ? { kind: 'ok', text: '这个浏览器不能直接调用系统分享：已把卡片图片放进剪贴板，切到微信、微博等应用粘贴即可。' }
        : { kind: 'warn', text: `这个浏览器不能直接调用系统分享，图片也没能放进剪贴板（${r.skipped ? '原因不明' : r.message}）：请用"导出图片"。` },
    );
    if (r.ok) await remember();
  };

  const exportAudio = async () => {
    if (!src?.audioUrl || start === null || end === null) return;
    setBusy('audio');
    setMsg(undefined);
    try {
      const r = await readWindow(src.audioUrl, start, end);
      if (!r.ok) return setMsg({ kind: 'warn', text: `没读到这段音频：${r.message}` });
      const buf = await decodeAt(r.audio, 44100, 2);
      const pcm = channelData(buf, start - r.firstTime, end - r.firstTime);
      downloadBlob(`${fileBase()}.wav`, new Blob([encodeWavPcm(buf.numberOfChannels === 1 ? [pcm[0]!] : pcm, buf.sampleRate) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }));
      setMsg({ kind: 'ok', text: '音频片段（WAV）已存进下载文件夹。' });
    } catch (e) {
      setMsg({ kind: 'warn', text: `导出音频失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(undefined);
    }
  };

  const listen = async () => {
    if (start === null || end === null) return;
    const r = await tell<{ ok: boolean; message?: string }>(tabId, { type: XYZ_MSG.seek, to: start, end });
    if (!r?.ok) setMsg({ kind: 'warn', text: r?.message ?? NO_RESPONSE });
  };

  const grab = (which: 'start' | 'end') => {
    const t = timeText(Math.floor(tab.truePos * 10) / 10);
    setRecord(undefined);
    if (which === 'start') setStartText(t);
    else setEndText(t);
  };

  const useCurrentCue = () => {
    const r = defaultSnapRange(cues, tab.truePos, tab.duration || undefined);
    setRecord(undefined);
    setEdited(false);
    setStartText(timeText(r.start));
    setEndText(timeText(r.end));
  };

  const texts = valid ? snapTexts(cues, start!, end!) : undefined;
  return (
    <>
      <section class="panel" data-testid="xyz-snap">
        <h2>音频片段 + 字幕的快照</h2>
        {record && (
          <Notice kind="info" onClose={() => setRecord(undefined)}>
            正在看"我的快照"里的一条：{record.title}
          </Notice>
        )}
        {!src ? (
          <p class="muted small">打开一个小宇宙单集页，在这里选一段，生成带字幕的分享卡片。</p>
        ) : (
          <>
            <div class="clip-range">
              <label class="stack">
                <span class="small muted">开始</span>
                <div class="row">
                  <input class="input" data-testid="xyz-snap-start" value={startText} onInput={(e) => setStartText(e.currentTarget.value)} />
                  {!record && (
                    <button class="btn small" onClick={() => grab('start')}>
                      取当前
                    </button>
                  )}
                </div>
              </label>
              <label class="stack">
                <span class="small muted">结束</span>
                <div class="row">
                  <input class="input" data-testid="xyz-snap-end" value={endText} onInput={(e) => setEndText(e.currentTarget.value)} />
                  {!record && (
                    <button class="btn small" onClick={() => grab('end')}>
                      取当前
                    </button>
                  )}
                </div>
              </label>
            </div>
            <div class="row wrap">
              {!record && (
                <button class="btn small" onClick={useCurrentCue}>
                  用当前这句
                </button>
              )}
              {valid && <span class="small xyz-range-label" data-testid="xyz-snap-label">{formatRangeLabel(start!, end!)}</span>}
            </div>
            {problem && <p class="warn-text small">{problem}</p>}
            {valid && texts && !texts.zh && !texts.en && !edited && <p class="muted small">这一段还没有字幕：先在"字幕"里开始字幕（或生成整集字幕），卡片上的文字也可以自己写。</p>}
            {valid && texts && (texts.zh || texts.en) && !texts.complete && !edited && <p class="muted small">这一段的字幕还没校对 / 翻译完，过几秒会自动更新。</p>}
            <label class="stack">
              <span class="small muted">卡片上的中文（可改）</span>
              <textarea class="input" rows={3} data-testid="xyz-snap-zh" value={zh} onInput={(e) => (setZh(e.currentTarget.value), setEdited(true))} />
            </label>
            <label class="stack">
              <span class="small muted">卡片上的英文（可改）</span>
              <textarea class="input" rows={2} data-testid="xyz-snap-en" value={en} onInput={(e) => (setEn(e.currentTarget.value), setEdited(true))} />
            </label>
            {edited && (
              <button class="btn link small" onClick={() => setEdited(false)}>
                恢复成字幕原文
              </button>
            )}
            {wave?.problem && <p class="warn-text small">波形：{wave.problem}</p>}
            {preview && <img class="xyz-card-preview" src={preview} alt="快照卡片预览" data-testid="xyz-card-preview" />}
            <div class="row wrap xyz-snap-actions">
              <button class="btn primary" data-testid="xyz-share" disabled={!valid} onClick={() => void share()}>
                分享这段快照
              </button>
              <button class="btn" data-testid="xyz-export-image" disabled={!valid} onClick={() => void exportImage()}>
                导出图片
              </button>
              <button class="btn" data-testid="xyz-copy-link" disabled={!valid} onClick={() => void copyLink()}>
                复制链接
              </button>
              <button class="btn" data-testid="xyz-export-audio" disabled={!valid || !src.audioUrl || busy === 'audio'} onClick={() => void exportAudio()}>
                {busy === 'audio' ? '导出中…' : '导出音频片段'}
              </button>
              {!record && (
                <button class="btn" data-testid="xyz-listen" disabled={!valid} onClick={() => void listen()}>
                  ▶ 试听
                </button>
              )}
            </div>
            {msg && (
              <Notice kind={msg.kind === 'ok' ? 'ok' : 'warn'} onClose={() => setMsg(undefined)}>
                <span data-testid="xyz-snap-msg">{msg.text}</span>
              </Notice>
            )}
            <p class="muted small">卡片在本机画好，导出时存进下载文件夹；"分享"交给系统的分享面板，由你选发给谁。TubeMuse 不会替你在小宇宙或别的平台发帖。</p>
          </>
        )}
      </section>
      {log.length > 0 && (
        <section class="panel">
          <h2>我的快照（{log.length}）</h2>
          <ul class="clip-log" data-testid="xyz-snap-log">
            {log.slice(0, 30).map((r) => (
              <li>
                <button
                  class="btn link small"
                  onClick={() => {
                    setRecord(r);
                    setEdited(true);
                    setZh(r.zh);
                    setEn(r.en);
                    setStartText(timeText(r.start));
                    setEndText(timeText(r.end));
                  }}
                >
                  {r.title}
                </button>
                <span class="muted small">
                  {formatRangeLabel(r.start, r.end)} · {new Date(r.createdAt).toLocaleDateString('zh-CN')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// ── 收藏 ──

function SavedItem({ x, onTag }: { x: XyzListItem; onTag: (t: string) => void }) {
  const { kind, item } = x;
  return (
    <li class="card xhs-item" data-testid="xyz-saved-item" data-kind={kind}>
      <div class="xhs-item-head">
        <span class={`xhs-kind ${kind === 'episode' ? 'note' : 'user'}`}>{kind === 'episode' ? '单集' : '节目'}</span>
        <a class="xhs-title" href={kind === 'episode' ? episodeUrl(item.id) : podcastUrl(item.id)} target="_blank" rel="noopener noreferrer">
          {item.title || '（无标题）'} ↗
        </a>
      </div>
      <div class="muted small xhs-meta">
        {kind === 'episode' && x.item.podcastTitle && <span>{x.item.podcastTitle}</span>}
        {kind === 'episode' && x.item.duration ? <span>{formatXyzTime(x.item.duration)}</span> : null}
        <span>收藏于 {new Date(item.savedAt).toLocaleDateString('zh-CN')}</span>
      </div>
      <div class="xhs-tags">
        <TagChips tags={item.tags} onPick={onTag} onRemove={(t) => void saveOp({ op: 'tags', kind, id: item.id, add: [], remove: [t] })} />
        <TagEditor onAdd={(add) => saveOp({ op: 'tags', kind, id: item.id, add, remove: [] })} />
      </div>
      <div class="xhs-actions">
        <button class="btn small" data-testid="xyz-unsave" onClick={() => void saveOp({ op: 'remove', kind, id: item.id })}>
          移出收藏
        </button>
      </div>
    </li>
  );
}

function SavedPanel() {
  const state = useStore(stores.xyzSaved);
  const [kind, setKind] = useState<'all' | XyzKind>('all');
  const [tag, setTag] = useState<string>();
  const [q, setQ] = useState('');
  const [manage, setManage] = useState(false);
  if (!state) return null;
  const eps = Object.keys(state.episodes).length;
  const pods = Object.keys(state.podcasts).length;
  const tags = xyzTagCounts(state);
  const list = filterXyzSaved(state, { kind, ...(tag ? { tag } : {}), q });
  return (
    <div data-testid="xyz-saved">
      <p class="muted small">在上面点"收藏这一集 / 收藏节目"收进这里，打上标签。只存在本机，不会在小宇宙上订阅或收藏。</p>
      <div class="xhs-filters">
        <div class="seg" role="group" aria-label="类型">
          {(
            [
              ['all', `全部 ${eps + pods}`],
              ['episode', `单集 ${eps}`],
              ['podcast', `节目 ${pods}`],
            ] as const
          ).map(([k, label]) => (
            <button class={`seg-btn${kind === k ? ' on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {label}
            </button>
          ))}
        </div>
        <input class="input xhs-search" type="search" placeholder="搜标题、节目、标签" aria-label="搜索收藏" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      {tags.length > 0 && <TagFilterBar tags={tags} active={tag} onPick={setTag} manage={manage} onToggleManage={() => setManage(!manage)} testId="xyz-tag-filter" />}
      {manage && (
        <section class="panel">
          <TagManager
            tags={tags}
            empty="还没有标签。"
            testId="xyz-tag-manager"
            onRename={(from, to) => saveOp({ op: 'renameTag', from, to })}
            onDelete={(t) => saveOp({ op: 'deleteTag', tag: t })}
            onRenamed={(from, to) => tag === from && setTag(to)}
          />
        </section>
      )}
      {list.length ? (
        <ul class="cards" data-testid="xyz-saved-list">
          {list.map((x) => (
            <SavedItem key={`${x.kind}:${x.item.id}`} x={x} onTag={setTag} />
          ))}
        </ul>
      ) : (
        <p class="muted small">{eps + pods === 0 ? '还没有收藏。' : '没有符合筛选条件的收藏。'}</p>
      )}
    </div>
  );
}

// ── 收听记录 ──

function ListensPanel() {
  const settings = useStore(stores.settings);
  const log = useStore(stores.xyzListens);
  const [confirm, setConfirm] = useState(false);
  if (!settings || !log) return null;
  const tz = appCtx().timeZone;
  const groups = listensByDay(log, (at) => dayKey(at, tz));
  const remove = (eid: string) =>
    void stores.xyzListens.update(appCtx().kv, appCtx().locker, (l) => {
      const next = { ...l };
      delete next[eid];
      return next;
    });
  const clearAll = () => {
    setConfirm(false);
    void stores.xyzListens.write(appCtx().kv, {});
  };
  const total = Object.values(log).reduce((s, r) => s + r.playSec, 0);
  return (
    <div data-testid="xyz-listens">
      {!settings.xyz.tracking && <Notice kind="warn">收听记录已在设置里关闭（设置页「18. 小宇宙」）：新的收听不再记下。</Notice>}
      <p class="muted small">
        在小宇宙网页版上听过的单集：只计真正在播放的时间（暂停不计），拖动进度条跳过的部分不算"听过"。只存在本机。共 {Object.keys(log).length} 集、{formatAudioDuration(total)}。
      </p>
      {groups.length === 0 && <p class="muted small">还没有收听记录。</p>}
      {groups.map((g) => (
        <section class="panel">
          <h2>{g.day}</h2>
          <ul class="cards">
            {g.items.map((r) => {
              const status = listenStatus(r, settings.tracking);
              const pct = Math.round(listenCompletion(r) * 100);
              return (
                <li class="card xyz-listen" data-testid="xyz-listen-item">
                  <div class="row">
                    {r.cover ? <img class="xyz-cover small" src={smallCover(r.cover)} alt="" width={40} height={40} /> : null}
                    <div class="xyz-head-main">
                      <a href={episodeUrl(r.eid)} target="_blank" rel="noopener noreferrer">
                        {r.title || '（无标题）'}
                      </a>
                      <div class="muted small">
                        {r.podcastTitle} · <span data-testid="xyz-listen-status">{LISTEN_STATUS_LABELS[status]}</span> · 听了 {formatAudioDuration(r.playSec)} · 听到 {formatXyzTime(r.lastPos)}
                      </div>
                      <div class="xyz-bar" title={`听过 ${pct}% 的内容`}>
                        <span style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    <button class="icon-btn" title="删除这条记录" onClick={() => remove(r.eid)}>
                      ×
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {groups.length > 0 &&
        (confirm ? (
          <div class="row">
            <button class="btn small danger" onClick={clearAll}>
              确认清空收听记录
            </button>
            <button class="btn small" onClick={() => setConfirm(false)}>
              取消
            </button>
          </div>
        ) : (
          <button class="btn small" onClick={() => setConfirm(true)}>
            清空收听记录
          </button>
        ))}
    </div>
  );
}

// ── 整页 ──

export function XyzView() {
  const settings = useStore(stores.settings);
  const saved = useStore(stores.xyzSaved);
  const { tabId, state } = useActiveTabState<XyzTabState>(XYZ_MSG.getState, XYZ_MSG.state, 1000);
  const [sub, setSub] = useState<Sub>('captions');
  const eid = state?.info?.eid;
  const trackStore = useMemo(() => (eid ? xyzTranscriptStore(eid) : undefined), [eid]);
  const transcript = useStore(trackStore);
  if (!settings) return null;
  const cues = transcript?.cues ?? [];
  const doneSec = transcript ? transcript.done.reduce((n, [a, b]) => n + (b - a), 0) : 0;
  const onEpisode = state?.page === 'episode' && !!state.info;
  const savedCount = saved ? Object.keys(saved.episodes).length + Object.keys(saved.podcasts).length : 0;
  return (
    <div class="xyz" data-testid="xyz-view">
      {onEpisode ? (
        <EpisodeHeader info={state.info!} tab={state} />
      ) : (
        <p class="muted small" data-testid="xyz-not-episode">
          {state === null
            ? '当前标签页不是小宇宙网页版（www.xiaoyuzhoufm.com）。如果是，刷新一下那个页面（扩展安装或更新之前打开的页面里还没有 TubeMuse 的脚本）。'
            : '打开一个小宇宙的单集页（www.xiaoyuzhoufm.com/episode/…），这里会出现这一集的字幕、快照和收藏。'}
        </p>
      )}
      <div class="seg xyz-sub" role="tablist" aria-label="小宇宙">
        {(
          [
            ['captions', '字幕'],
            ['snap', '片段快照'],
            ['saved', `收藏${savedCount ? ` ${savedCount}` : ''}`],
            ['listens', '收听记录'],
          ] as [Sub, string][]
        ).map(([id, label]) => (
          <button role="tab" aria-selected={sub === id} class={`seg-btn${sub === id ? ' on' : ''}`} data-testid={`xyz-sub-${id}`} onClick={() => setSub(id)}>
            {label}
          </button>
        ))}
      </div>
      {sub === 'captions' &&
        (onEpisode ? <CaptionsPanel tabId={tabId} tab={state!} cues={cues} transcriptDone={doneSec} /> : <p class="muted small">字幕只在小宇宙单集页上可用。</p>)}
      {sub === 'snap' && (onEpisode ? <SnapshotPanel tabId={tabId} tab={state!} cues={cues} /> : <SnapshotPanelLogOnly />)}
      {sub === 'saved' && <SavedPanel />}
      {sub === 'listens' && <ListensPanel />}
    </div>
  );
}

/** 不在单集页时：只列"我的快照" */
function SnapshotPanelLogOnly() {
  const log = useStore(stores.xyzSnapshots) ?? [];
  return log.length ? (
    <section class="panel">
      <h2>我的快照（{log.length}）</h2>
      <ul class="clip-log">
        {log.slice(0, 30).map((r) => (
          <li>
            <a href={episodeUrl(r.eid)} target="_blank" rel="noopener noreferrer">
              {r.title}
            </a>
            <span class="muted small"> {formatRangeLabel(r.start, r.end)}</span>
          </li>
        ))}
      </ul>
      <p class="muted small">回到那一集的页面可以重新生成卡片。</p>
    </section>
  ) : (
    <p class="muted small">打开一个小宇宙单集页，在这里选一段，生成带字幕的分享卡片。</p>
  );
}
