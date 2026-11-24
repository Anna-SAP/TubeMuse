// 从配音音频识别字幕（用户 2026-11-24 要求，见 DECISIONS §91）：「配音字幕」一节里"选字幕文件"旁边的入口——
// 没有字幕文件时，让 TubeMuse 直接从已关联的配音（m4a）里识别出带时间轴的字幕，存成这个配音的字幕。
// 点开先给你看：要做什么、声音发到哪、大约花多少、今天的「字幕 $」还剩多少；你点"开始识别"才开始。
// 识别中显示进度，可以停；被打断（停止、关了侧边栏、预算用完、断网）后已识别的留着：接着识别 / 先用已识别的部分 / 丢掉。

import { useEffect, useState } from 'preact/hooks';
import { dubAsrProgressText, dubAsrSummaryText } from '../../core/dub-asr';
import { formatClockSec, type DubRecord } from '../../core/dub';
import { dubSubsMetaText } from '../../core/dub-subs';
import { formatUsd } from '../../core/subtitles';
import { discardDubAsr, planDubAsr, readDubAsrProgress, savePartialDubAsr, type DubAsrPlan } from '../../services/dub-asr-service';
import { toAppError } from '../../services/errors';
import { appCtx } from '../shared/app';
import { asrJob, useAsrJob } from './dub-asr-job';

interface Resume {
  doneTo: number;
  durationSec: number;
  cues: number;
}

function PlanBox({ rec, plan, onStart, onClose }: { rec: DubRecord; plan: DubAsrPlan; onStart: (restart: boolean) => void; onClose: () => void }) {
  const e = plan.estimate;
  const dur = plan.durationSec;
  return (
    <div class="dub-subs-asr" data-testid="dub-asr-plan">
      <p class="small">
        把这段配音{dur ? `（${formatClockSec(dur)}）` : ''}在本机按停顿切成一句一句，<strong>一句一句发往 OpenAI</strong> 转写（<span class="clip-file">{plan.asrModel}</span>
        ）——字幕的时间轴来自切句，按配音文件自己的时间。
        {plan.proofOff
          ? ''
          : `转写出的文字再交给 ${plan.proofModel} 改错字、补标点（只发文字、配音文件名和视频标题，不发声音）。`}
      </p>
      {plan.proofOff && (
        <p class="small warn-text" data-testid="dub-asr-proof-off">
          不校对：{plan.proofOff}。只转写，错字、同音字不会被改；想校对的话先在设置页填好 Key 再开始。
        </p>
      )}
      {e && (
        <p class="small" data-testid="dub-asr-estimate">
          {plan.resume ? `接着识别剩下的 ${formatClockSec(Math.max(0, (dur ?? 0) - plan.resume.doneTo))}：` : ''}预计约 <strong>{formatUsd(e.totalUsd)}</strong>（转写 {formatUsd(e.asrUsd)}
          {e.proofUsd > 0 ? ` + 校对 ${formatUsd(e.proofUsd)}` : ''}），记在「字幕 $」里；今天还剩 {formatUsd(plan.remainingUsd)} / {formatUsd(plan.budgetUsd)}。
          {plan.asrPriceUnknown ? ` 转写模型 ${plan.asrModel} 不在价目表里，按保守单价估算。` : ''}
        </p>
      )}
      {plan.overBudget && !plan.problem && (
        <p class="small warn-text" data-testid="dub-asr-over-budget">
          今天剩下的预算不够识别完：会在用完时停下，已识别的留着。可以先在设置页「12. 自动字幕」调高每日预算，或者明天接着识别。
        </p>
      )}
      {rec.subs && !plan.problem && (
        <p class="muted small" data-testid="dub-asr-replace">
          识别完成后会换掉现在这份字幕（{dubSubsMetaText(rec.subs)}）；完成之前它照常显示。
        </p>
      )}
      {plan.problem ? (
        <p class="small warn-text" data-testid="dub-asr-problem" role="alert">
          {plan.problem.message}
          {plan.problem.hint ? `：${plan.problem.hint}` : ''}
        </p>
      ) : (
        <p class="muted small">一小时的配音大约要几分钟（看网络）。识别时可以切到别的标签页，别关侧边栏；中途停下或关掉也不要紧，已识别的留着，可以接着识别。</p>
      )}
      <div class="row wrap">
        <button class="btn primary small" data-testid="dub-asr-start" disabled={!!plan.problem} onClick={() => onStart(false)}>
          {plan.resume ? '接着识别' : '开始识别'}
        </button>
        {plan.resume && (
          <button class="btn small" data-testid="dub-asr-restart" disabled={!!plan.problem} onClick={() => onStart(true)}>
            从头重新识别
          </button>
        )}
        <button class="btn link small" data-testid="dub-asr-close" onClick={onClose}>
          收起
        </button>
      </div>
    </div>
  );
}

export function DubAsr({ rec, disabled }: { rec: DubRecord; disabled: boolean }) {
  const ctx = appCtx();
  const job = useAsrJob();
  const mine = job?.videoId === rec.videoId ? job : undefined;
  const running = mine?.phase === 'running' || mine?.phase === 'stopping';
  const otherBusy = asrJob.busy() && !mine;
  const [plan, setPlan] = useState<DubAsrPlan>();
  const [loading, setLoading] = useState(false);
  const [resume, setResume] = useState<Resume>();
  const [note, setNote] = useState<string>();
  const [problem, setProblem] = useState<string>();

  // 识别到一半的进度：换了视频 / 配音文件、任务停下或做完时重读
  useEffect(() => {
    let live = true;
    if (running) return;
    void readDubAsrProgress(ctx, rec.videoId).then(
      (d) => live && setResume(d ? { doneTo: d.doneTo, durationSec: d.durationSec, cues: d.cues.filter((c) => c.end <= d.doneTo + 0.01).length } : undefined),
      () => live && setResume(undefined),
    );
    return () => {
      live = false;
    };
  }, [rec.videoId, rec.fileId, mine?.phase]);

  const open = async () => {
    setLoading(true);
    setProblem(undefined);
    setNote(undefined);
    try {
      setPlan(await planDubAsr(ctx, rec.videoId));
    } catch (e) {
      setProblem(toAppError(e).message);
    } finally {
      setLoading(false);
    }
  };
  const start = (restart: boolean) => {
    setPlan(undefined);
    setNote(undefined);
    setProblem(undefined);
    void asrJob.start(ctx, rec.videoId, restart);
  };
  const usePartial = async () => {
    setProblem(undefined);
    try {
      setNote(dubAsrSummaryText((await savePartialDubAsr(ctx, rec.videoId)).summary));
    } catch (e) {
      const err = toAppError(e);
      setProblem(err.hint ? `${err.message}：${err.hint}` : err.message);
    }
  };
  const discard = async () => {
    await discardDubAsr(ctx, rec.videoId);
    setResume(undefined);
    setNote('已丢掉识别到一半的进度（已经存成字幕的不受影响）。');
    if (mine && !running) asrJob.clear();
  };

  const p = mine?.progress;
  return (
    <>
      {!running && !plan && (
        <button
          class="btn small"
          data-testid="dub-subs-asr"
          disabled={disabled || otherBusy || loading}
          title={otherBusy ? '正在识别另一个视频的配音：一次识别一个' : '没有字幕文件时：让 TubeMuse 从这段配音音频里识别出带时间轴的字幕（发往 OpenAI 转写，花费记在「字幕 $」里；点开先看预计花费）'}
          onClick={() => void open()}
        >
          {rec.subs?.source === 'asr' ? '重新从配音音频识别…' : '从配音音频识别字幕…'}
        </button>
      )}
      {plan && !running && <PlanBox rec={rec} plan={plan} onStart={start} onClose={() => setPlan(undefined)} />}
      {running && mine && (
        <div class="dub-subs-asr" data-testid="dub-asr-running">
          <div class="dub-asr-progress">
            <span class="rec-dot" aria-hidden="true" />
            <span data-testid="dub-asr-progress">{p ? dubAsrProgressText(p) : '正在读配音文件…'}</span>
          </div>
          {p && <progress class="clip-progress" max={p.durationSec} value={Math.min(p.doneTo, p.durationSec)} />}
          <p class="muted small">
            正在把配音一句一句发往 OpenAI 转写{p && p.readTo < p.durationSec ? `（已切句到 ${formatClockSec(p.readTo)}）` : ''}
            ，做完自动存成这个配音的字幕。可以切到别的标签页或侧边栏别的页，别关侧边栏。
          </p>
          <div class="row">
            <button class="btn small" data-testid="dub-asr-stop" disabled={mine.phase === 'stopping'} onClick={() => asrJob.stop()}>
              {mine.phase === 'stopping' ? '正在停下（等已经发出去的几句回来）…' : '停止'}
            </button>
          </div>
        </div>
      )}
      {mine?.phase === 'done' && mine.summary && (
        <p class="small dub-subs-asr" data-testid="dub-asr-done">
          {dubAsrSummaryText(mine.summary)}
          <button class="btn link small" onClick={() => asrJob.clear()}>
            知道了
          </button>
        </p>
      )}
      {mine?.phase === 'error' && mine.error && (
        <p class="small warn-text dub-subs-asr" data-testid="dub-asr-error" role="alert">
          识别停下了：{mine.error.message}
          {mine.error.hint ? `（${mine.error.hint}）` : ''}
          <button class="btn link small" onClick={() => asrJob.clear()}>
            知道了
          </button>
        </p>
      )}
      {resume && !running && !plan && (
        <div class="dub-subs-asr" data-testid="dub-asr-resume">
          <p class="small">
            {mine?.phase === 'stopped' ? '已停止。' : ''}上次识别到 {formatClockSec(resume.doneTo)} / {formatClockSec(resume.durationSec)}（{resume.cues} 句），没识别完：已识别的留在本机，接着识别不会重复花钱。
          </p>
          <div class="row wrap">
            <button class="btn primary small" data-testid="dub-asr-resume-open" disabled={disabled || otherBusy || loading} onClick={() => void open()}>
              接着识别…
            </button>
            <button class="btn small" data-testid="dub-asr-partial" disabled={disabled || resume.cues === 0} onClick={() => void usePartial()}>
              先用已识别的这部分
            </button>
            <button class="btn link small" data-testid="dub-asr-discard" disabled={disabled} onClick={() => void discard()}>
              丢掉
            </button>
          </div>
        </div>
      )}
      {note && (
        <p class="small dub-subs-asr" data-testid="dub-asr-note">
          {note}
        </p>
      )}
      {problem && (
        <p class="small warn-text dub-subs-asr" data-testid="dub-asr-problem-note" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}
