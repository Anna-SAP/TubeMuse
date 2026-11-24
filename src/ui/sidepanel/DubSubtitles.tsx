// 配音字幕（用户 2026-11-18 要求，见 DECISIONS §86）：「配音」页里的一节——勾选要不要在视频画面底部显示配音的字幕，
// 给这个配音弄一份字幕（选字幕文件；没有字幕文件时从配音音频识别，见 DubAsr.tsx 与 DECISIONS §91；或用小宇宙里已经生成的那一集），
// 调样式（字体、字号、文字颜色、背景色与不透明度、粗体、描边、抬高多少）。
// 字幕是配音的字幕：页面里按配音实际放到的位置显示（不按视频时间）；这里的"此刻这一句"也按配音的位置算。
// 字幕文字存在本机（每个视频一个键）；样式存在设置里，对所有视频生效，改了页面上立刻变。

import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS, DUB, DUB_SUB_FONTS, type DubSubFont } from '../../config/defaults';
import { formatClockSec, type DubRecord, type DubTabState } from '../../core/dub';
import {
  DUB_SUB_LANG_LABELS,
  dubCueAt,
  dubSubCss,
  dubSubFontPx,
  dubSubHiddenText,
  dubSubVisible,
  dubSubsMetaText,
  dubSubsNote,
  sanitizeDubSubStyle,
  type DubSubStyle,
  type DubSubsDoc,
  type XyzSubsChoice,
} from '../../core/dub-subs';
import { SubtitleFileError } from '../../core/subtitle-track';
import { listXyzSubsForDub, readDubSubtitles, removeDubSubtitles, setDubSubtitleFile, copyXyzSubsForDub, type DubSubsSaved } from '../../services/dub-service';
import { stores } from '../../services/repo';
import { appCtx, useStore } from '../shared/app';
import { DubAsr } from './DubAsr';
import { asrJob, useAsrJob } from './dub-asr-job';

const problemText = (e: unknown): string => (e instanceof SubtitleFileError ? (e.hint ? `${e.message}：${e.hint}` : e.message) : e instanceof Error ? e.message : String(e));

const pct = (x: number) => `${Math.round(x * 100)}%`;

const SAMPLE = '这是配音字幕的样子 Aa 123';

function StyleControls({ style, sample, onChange }: { style: DubSubStyle; sample: string; onChange: (patch: Partial<DubSubStyle>) => void }) {
  const css = dubSubCss(style);
  const d = DEFAULT_SETTINGS.dub.subtitles;
  const isDefault = (Object.keys(d) as (keyof DubSubStyle)[]).every((k) => k === 'show' || d[k] === style[k]);
  return (
    <details class="dub-subs-style" data-testid="dub-subs-style">
      <summary>字幕样式（对所有视频生效，改了页面上立刻变）</summary>
      <div class="dub-subs-preview" data-testid="dub-subs-preview" aria-label="样式预览">
        <span class="dub-subs-preview-line" style={{ ...css, fontSize: `${dubSubFontPx(style, 640, 360, false)}px` }}>
          {sample}
        </span>
      </div>
      <div class="dub-subs-grid">
        <label>
          <span>字体</span>
          <select class="input" data-testid="dub-subs-font" value={style.font} onChange={(e) => onChange({ font: e.currentTarget.value as DubSubFont })}>
            {(Object.keys(DUB_SUB_FONTS) as DubSubFont[]).map((f) => (
              <option value={f}>{DUB_SUB_FONTS[f].label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>字号</span>
          <input
            type="range"
            data-testid="dub-subs-scale"
            min={DUB.subs.scale.min}
            max={DUB.subs.scale.max}
            step={DUB.subs.scale.step}
            value={style.scale}
            aria-label="字号倍数"
            onInput={(e) => onChange({ scale: Number(e.currentTarget.value) })}
          />
          <span class="dub-subs-num" data-testid="dub-subs-scale-value">
            {pct(style.scale)}
          </span>
        </label>
        <label>
          <span>文字颜色</span>
          <input type="color" data-testid="dub-subs-color" value={style.color} onInput={(e) => onChange({ color: e.currentTarget.value })} />
          <span class="dub-subs-num">{style.color}</span>
        </label>
        <label>
          <span>背景色</span>
          <input type="color" data-testid="dub-subs-bg" value={style.background} onInput={(e) => onChange({ background: e.currentTarget.value })} />
          <span class="dub-subs-num">{style.background}</span>
        </label>
        <label>
          <span>背景不透明度</span>
          <input
            type="range"
            data-testid="dub-subs-bg-opacity"
            min={0}
            max={1}
            step={0.05}
            value={style.backgroundOpacity}
            aria-label="背景不透明度"
            onInput={(e) => onChange({ backgroundOpacity: Number(e.currentTarget.value) })}
          />
          <span class="dub-subs-num" data-testid="dub-subs-bg-opacity-value">
            {style.backgroundOpacity === 0 ? '没有背景' : pct(style.backgroundOpacity)}
          </span>
        </label>
        <label>
          <span>位置</span>
          <input
            type="range"
            data-testid="dub-subs-raise"
            min={DUB.subs.raisePct.min}
            max={DUB.subs.raisePct.max}
            step={DUB.subs.raisePct.step}
            value={style.raisePct}
            aria-label="从画面底部再抬高多少"
            onInput={(e) => onChange({ raisePct: Number(e.currentTarget.value) })}
          />
          <span class="dub-subs-num" data-testid="dub-subs-raise-value">
            {style.raisePct === 0 ? '画面底部' : `抬高 ${style.raisePct}%`}
          </span>
        </label>
      </div>
      <div class="row wrap">
        <label class="inline">
          <input type="checkbox" data-testid="dub-subs-bold" checked={style.bold} onChange={(e) => onChange({ bold: e.currentTarget.checked })} />
          粗体
        </label>
        <label class="inline">
          <input type="checkbox" data-testid="dub-subs-outline" checked={style.outline} onChange={(e) => onChange({ outline: e.currentTarget.checked })} />
          文字描边（背景很淡时看得清）
        </label>
        <button class="btn link small" data-testid="dub-subs-reset" disabled={isDefault} onClick={() => onChange({ ...d, show: style.show })}>
          恢复默认样式
        </button>
      </div>
      <p class="muted small">
        字号的基准随播放器大小变（全屏、剧场模式自动变大），这里调的是倍数。字幕默认在画面底部、控制栏上方；YouTube 自己的字幕或 TubeMuse 的另两层字幕也开着时，配音字幕叠在它们上面。
      </p>
    </details>
  );
}

/** 用小宇宙里已经生成的字幕：列出本机存着的那几集，看起来就是这个配音的排在最前 */
function XyzPicker({ rec, busy, onUse }: { rec: DubRecord; busy: boolean; onUse: (eid: string) => void }) {
  const ctx = appCtx();
  const [list, setList] = useState<XyzSubsChoice[]>();
  const [eid, setEid] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const open = async () => {
    setProblem(undefined);
    try {
      const found = await listXyzSubsForDub(ctx, rec);
      setList(found);
      setEid(found[0]?.eid);
    } catch (e) {
      setProblem(problemText(e));
    }
  };
  if (!list) {
    return (
      <>
        <button class="btn small" data-testid="dub-subs-xyz" disabled={busy} onClick={() => void open()}>
          用小宇宙里已生成的字幕…
        </button>
        {problem && <span class="small warn-text">{problem}</span>}
      </>
    );
  }
  if (!list.length) {
    return (
      <p class="muted small dub-subs-xyz-list" data-testid="dub-subs-xyz-empty">
        本机还没有小宇宙的字幕。可以直接点"从配音音频识别字幕…"；配音如果就是小宇宙上的某一集，也可以打开那一集的页面，在「小宇宙」页生成整集字幕（带英文译文），再回到这里选用。
        <button class="btn link small" onClick={() => setList(undefined)}>
          收起
        </button>
      </p>
    );
  }
  const chosen = list.find((x) => x.eid === eid) ?? list[0]!;
  const partial = chosen.durationSec !== undefined && chosen.coveredSec < chosen.durationSec - 5;
  return (
    <div class="dub-subs-xyz-list" data-testid="dub-subs-xyz-list">
      <div class="row wrap">
        <select class="input" data-testid="dub-subs-xyz-select" value={chosen.eid} onChange={(e) => setEid(e.currentTarget.value)}>
          {list.map((x) => (
            <option value={x.eid}>
              {x.match ? '★ ' : ''}
              {x.title} · {x.podcastTitle} · {x.count} 句
            </option>
          ))}
        </select>
        <button class="btn primary small" data-testid="dub-subs-xyz-use" disabled={busy} onClick={() => onUse(chosen.eid)}>
          用这一集的字幕
        </button>
        <button class="btn link small" onClick={() => setList(undefined)}>
          收起
        </button>
      </div>
      <p class="muted small" data-testid="dub-subs-xyz-note">
        {chosen.match ? '★ 这一集看起来就是这个配音（标题在配音的文件名里，或两边一样长）。' : '没有哪一集和这个配音的文件名、时长对得上：自己认一下是不是同一段音频。'}
        {partial && chosen.durationSec !== undefined ? `这一集的字幕只生成了 ${formatClockSec(chosen.coveredSec)} / ${formatClockSec(chosen.durationSec)}，没生成的地方没有字幕。` : ''}
        抄的是此刻的一份：那一集之后又生成了新的，要再点一次。
      </p>
    </div>
  );
}

export function DubSubtitles({ rec, state }: { rec: DubRecord; state: DubTabState }) {
  const ctx = appCtx();
  const settings = useStore(stores.settings);
  const fileRef = useRef<HTMLInputElement>(null);
  const [doc, setDoc] = useState<DubSubsDoc | null>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [note, setNote] = useState<string>();
  // 正在从这个配音的音频识别字幕（DECISIONS §91）：做完会换掉这个配音的字幕，这期间不让同时选文件 / 去掉
  const asr = useAsrJob();
  const recognizing = asr?.videoId === rec.videoId && asrJob.busy();
  /** 选文件那一刻的视频（文件对话框开着时你可能换了视频） */
  const pickFor = useRef<string>();
  const stamp = rec.subs?.addedAt;
  // 这个配音存着的字幕（"此刻这一句"和预览用）：换了视频、换了一份字幕时重读
  useEffect(() => {
    let live = true;
    setDoc(undefined);
    if (stamp === undefined) return;
    void readDubSubtitles(ctx, rec.videoId).then(
      (d) => live && setDoc(d),
      () => live && setDoc(null),
    );
    return () => {
      live = false;
    };
  }, [rec.videoId, stamp]);
  useEffect(() => {
    setProblem(undefined);
    setNote(undefined);
  }, [rec.videoId]);
  /** 刚改、还没存好的样式：界面先按它显示（拖滑块、点勾选框时不被还没更新的旧值弹回去），存下的值追上后作废 */
  const [draft, setDraft] = useState<Partial<DubSubStyle>>({});
  const storedKey = JSON.stringify(settings?.dub.subtitles);
  useEffect(() => {
    const stored = settings?.dub.subtitles;
    if (!stored) return;
    setDraft((d) => {
      const rest = Object.fromEntries(Object.entries(d).filter(([k, v]) => stored[k as keyof DubSubStyle] !== v)) as Partial<DubSubStyle>;
      return Object.keys(rest).length === Object.keys(d).length ? d : rest;
    });
  }, [storedKey]);
  if (!settings) return null;
  const style = sanitizeDubSubStyle({ ...settings.dub.subtitles, ...draft });
  const setStyle = (patch: Partial<DubSubStyle>) => {
    // 先按存进去之后的样子取值（夹进范围、取整），草稿和存下的才对得上
    const clean = sanitizeDubSubStyle({ ...style, ...patch });
    const changed = Object.fromEntries((Object.keys(patch) as (keyof DubSubStyle)[]).map((k) => [k, clean[k]])) as Partial<DubSubStyle>;
    setDraft((d) => ({ ...d, ...changed }));
    void stores.settings
      .update(ctx.kv, ctx.locker, (x) => ({ ...x, dub: { ...x.dub, subtitles: { ...x.dub.subtitles, ...changed } } }))
      // 存进去的和原来一样时存储不会报变化，上面那个清理等不到：存好后过一会儿把这一次的草稿收掉（期间又改过的不动）
      .finally(() => setTimeout(() => setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k, v]) => changed[k as keyof DubSubStyle] !== v)) as Partial<DubSubStyle>), 500));
  };

  const saved = (r: DubSubsSaved | undefined, what: string) => {
    if (!r) return setProblem('这个视频的配音已经移除了，字幕没有存。');
    setNote(`${what}：${dubSubsNote({ ...r.prepared, count: r.meta.count })}。`);
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setProblem(undefined);
    setNote(undefined);
    try {
      await fn();
    } catch (e) {
      setProblem(problemText(e));
    } finally {
      setBusy(false);
    }
  };
  const onFile = (input: HTMLInputElement) => {
    const f = input.files?.[0];
    input.value = '';
    const forVideo = pickFor.current ?? rec.videoId;
    pickFor.current = undefined;
    if (!f) return;
    if (forVideo !== rec.videoId) return setProblem('选文件时换了视频，没有存。回到那个视频再选一次。');
    void run(async () => {
      try {
        saved(await setDubSubtitleFile(ctx, rec.videoId, f, f.name), `已把「${f.name}」存成这个配音的字幕`);
      } catch (e) {
        throw new Error(`「${f.name}」用不了：${problemText(e)}`);
      }
    });
  };
  const pick = () => {
    pickFor.current = rec.videoId;
    fileRef.current?.click();
  };
  const useXyz = (eid: string) => void run(async () => saved(await copyXyzSubsForDub(ctx, rec.videoId, eid), '已用小宇宙里这一集的字幕'));
  const remove = () =>
    void run(async () => {
      await removeDubSubtitles(ctx, rec.videoId);
      setNote('已去掉这个配音的字幕（你电脑上的字幕文件、小宇宙里的字幕都不受影响）。');
    });

  // 此刻：和页面里同一套判断——配音放到哪，就是哪一句
  const playback = { ...(state.reason ? { reason: state.reason } : {}), blocked: !!state.blocked };
  const cue = doc && state.dubTime !== undefined && state.phase === 'ready' && dubSubVisible(playback) ? dubCueAt(doc.cues, state.dubTime) : undefined;
  let now: string;
  if (!style.show) now = '已关闭：画面上不显示配音字幕。';
  else if (!settings.dub.enabled) now = '中文配音已在设置中关闭。';
  else if (!rec.subs) now = recognizing ? '这个配音还没有字幕：正在从配音音频识别，做完自动显示。' : '这个配音还没有字幕：在上面选一个字幕文件、从配音音频识别，或用小宇宙里已经生成的那一集。';
  else if (doc === null) now = '';
  else if (!state.active) now = '开启配音后显示：字幕跟着配音走，配音放到哪句显示哪句。';
  else if (state.phase !== 'ready') now = '配音载入好之后显示。';
  else if (!dubSubVisible(playback)) now = `此刻不显示：${dubSubHiddenText(playback)}。`;
  else if (cue) now = `此刻（中文 ${formatClockSec(state.dubTime ?? 0)}）：${cue.text.replace(/\n/g, ' / ')}`;
  else now = `此刻（中文 ${formatClockSec(state.dubTime ?? 0)}）两句之间，没有字幕。`;

  return (
    <div class="dub-subs" data-testid="dub-subs">
      <div class="row">
        <strong>配音字幕</strong>
      </div>
      <input type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" hidden ref={fileRef} data-testid="dub-subs-file" onChange={(e) => onFile(e.currentTarget)} />
      <label class="inline">
        <input type="checkbox" data-testid="dub-subs-show" checked={style.show} onChange={(e) => setStyle({ show: e.currentTarget.checked })} />
        在视频画面底部显示配音的字幕（{DUB_SUB_LANG_LABELS[DUB.subs.lang]}，跟着配音走）
      </label>
      {rec.subs ? (
        <p class="small dub-subs-meta" data-testid="dub-subs-meta">
          字幕：<span class="clip-file">{dubSubsMetaText(rec.subs)}</span>
          {rec.subs.reduced && <span class="muted">（双语字幕，只显示{DUB_SUB_LANG_LABELS[DUB.subs.lang]}那几行）</span>}
          {rec.subs.lang !== DUB.subs.lang && !rec.subs.reduced && <span class="warn-text">（看起来不是配音的语言，照样显示）</span>}
        </p>
      ) : (
        <p class="muted small" data-testid="dub-subs-about">
          字幕是配音这段音频的字幕，时间按配音文件自己的时间：显示时跟配音实际放到的位置走，不按视频时间。有字幕文件（.srt /
          .vtt）就直接选，中英双语的只显示中文那几行；没有字幕文件时，点"从配音音频识别字幕…"让 TubeMuse 从这段配音里识别出带时间轴的字幕（一句一句发往 OpenAI
          转写，花费记在「字幕 $」里，点开先看预计花费）；配音就是小宇宙上的某一集、那一集的字幕已经在「小宇宙」页生成过时，也可以直接选用。
        </p>
      )}
      {rec.subs && doc === null && (
        <p class="small warn-text" data-testid="dub-subs-missing">
          本机存着的这份字幕不见了（浏览器的存储可能被清理过）：重新选一次。
        </p>
      )}
      <div class="row wrap">
        <button class={`btn small${rec.subs ? '' : ' primary'}`} data-testid="dub-subs-pick" disabled={busy || recognizing} onClick={pick}>
          {rec.subs ? '换一个字幕文件…' : '选字幕文件（.srt / .vtt）…'}
        </button>
        <DubAsr key={`asr:${rec.videoId}`} rec={rec} disabled={busy} />
        <XyzPicker key={rec.videoId} rec={rec} busy={busy || recognizing} onUse={useXyz} />
        {rec.subs && (
          <button class="btn link small" data-testid="dub-subs-remove" disabled={busy || recognizing} onClick={remove}>
            去掉字幕
          </button>
        )}
      </div>
      {now && (
        <p class={`small dub-subs-now${cue ? '' : ' muted'}`} data-testid="dub-subs-now" data-showing={cue ? 'true' : 'false'}>
          {now}
        </p>
      )}
      {note && (
        <p class="small" data-testid="dub-subs-note">
          {note}
        </p>
      )}
      {problem && (
        <p class="small warn-text" data-testid="dub-subs-problem" role="alert">
          {problem}
        </p>
      )}
      <StyleControls style={style} sample={cue?.text ?? doc?.cues[0]?.text ?? SAMPLE} onChange={setStyle} />
    </div>
  );
}
