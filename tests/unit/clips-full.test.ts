// 整片录制（配音页"录下完整双语视频"，DECISIONS §81）：码率与分辨率的安排、开录前检查、
// 录不了时连视频一起暂停、进度跳变、录完整了没有、文件名与记录。

import { describe, expect, it } from 'vitest';
import { CLIPS } from '../../src/config/defaults';
import {
  CLIP_FULL_WAIT_LABELS,
  checkClipStart,
  checkFullStart,
  decideClip,
  fullFileName,
  fullHold,
  fullIssueText,
  fullIssues,
  fullJump,
  fullMaxSec,
  fullPlan,
  fullStartBlocked,
  sanitizeClipRecord,
  type ClipControl,
  type ClipSample,
  type FullStartContext,
} from '../../src/core/clips';

const ID = 'dQw4w9WgXcQ';

describe('整片录制：画面多大、码率多少', () => {
  it('用户的例子（17:31 的 1080p）：默认码率放得下，按原样录', () => {
    const p = fullPlan(17 * 60 + 31, 1920, 1080)!;
    expect(p).toMatchObject({ width: 1920, height: 1080, videoBps: 8_000_000 });
    expect(p.estBytes).toBeLessThan(CLIPS.full.budgetBytes);
    expect(p.estBytes).toBeGreaterThan(1_000_000_000);
  });
  it('更长的 1080p：默认码率放不下，够默认的四成就只降码率；再长就降一档分辨率', () => {
    // 35 分钟：1.2 GB ÷ 2100 秒 ≈ 4.4 Mbps，过了 1080p 默认 8 Mbps 的四成
    const a = fullPlan(35 * 60, 1920, 1080)!;
    expect(a.height).toBe(1080);
    expect(a.videoBps).toBeLessThan(8_000_000);
    expect(a.videoBps).toBeGreaterThanOrEqual(4_000_000);
    // 一小时出头（用户的另一个视频 1:03:49）：≈ 2.4 Mbps，不到 1080p 的四成，降到 720p（默认 5 Mbps 的四成是 2 Mbps）
    const b = fullPlan(3829, 1920, 1080)!;
    expect(b).toMatchObject({ width: 1280, height: 720 });
    expect(b.videoBps).toBeGreaterThanOrEqual(2_000_000);
    expect(b.estBytes).toBeLessThanOrEqual(CLIPS.full.budgetBytes);
    // 两小时：再降
    const c = fullPlan(2 * 3600, 1920, 1080)!;
    expect(c.height).toBeLessThanOrEqual(480);
    expect(c.estBytes).toBeLessThanOrEqual(CLIPS.full.budgetBytes);
  });
  it('预计体积始终不超过预算，留着余量不撞单段体积上限', () => {
    for (const sec of [60, 600, 1051, 1800, 3600, 5400, 7200, 3 * 3600]) {
      const p = fullPlan(sec, 1920, 1080);
      if (p) expect(p.estBytes).toBeLessThanOrEqual(CLIPS.full.budgetBytes);
    }
    expect(CLIPS.full.budgetBytes).toBeLessThan(CLIPS.maxBytes);
  });
  it('太长的视频放不下：不录（返回 undefined）；时长读不到也不录', () => {
    expect(fullPlan(6 * 3600, 1920, 1080)).toBeUndefined();
    expect(fullPlan(Infinity, 1920, 1080)).toBeUndefined();
    expect(fullPlan(0, 1920, 1080)).toBeUndefined();
    expect(fullPlan(NaN, 1920, 1080)).toBeUndefined();
  });
  it('竖屏、小视频、读不到尺寸', () => {
    expect(fullPlan(600, 1080, 1920)).toMatchObject({ width: 1080, height: 1920 });
    expect(fullPlan(600, 640, 360)).toMatchObject({ width: 640, height: 360, videoBps: 1_500_000 });
    expect(fullPlan(600, 0, 0)).toMatchObject(CLIPS.fallbackSize);
  });
  it('时长上限跟着视频时长走，不受"单段时长上限"（默认 10 分钟）管', () => {
    expect(fullMaxSec(1051)).toBeGreaterThan(1051 + 60);
    expect(fullMaxSec(1051)).toBeLessThan(1051 * 1.5);
  });
});

describe('整片录制：开始前的检查', () => {
  const ok: FullStartContext = { site: 'youtube', shorts: false, dubReady: true, duration: 1051, rate: 1, ad: false, plan: fullPlan(1051, 1920, 1080) };
  it('YouTube 播放页、配音就绪、正常速度：可以开始', () => {
    expect(checkFullStart(ok)).toBeUndefined();
  });
  it('配音没开、Shorts、别的站、直播、广告中、倍速不是 1、太长：都说清楚', () => {
    expect(checkFullStart({ ...ok, dubReady: false })).toContain('先在「配音」页开启配音');
    expect(checkFullStart({ ...ok, shorts: true })).toContain('只能在 YouTube 播放页');
    expect(checkFullStart({ ...ok, site: 'bilibili' })).toContain('只能在 YouTube 播放页');
    expect(checkFullStart({ ...ok, duration: Infinity })).toContain('直播');
    expect(checkFullStart({ ...ok, ad: true })).toContain('广告');
    expect(checkFullStart({ ...ok, rate: 1.5 })).toContain('1.5 倍速');
    expect(checkFullStart({ ...ok, duration: 6 * 3600, plan: undefined })).toContain('太长');
  });
  it('视频已经播完也能开始（反正从头录）；已经在录别的就不行', () => {
    const c = { enabled: true, videoId: ID, hasVideo: true, busy: false, duration: 1051, currentTime: 1051, ended: true, maxSec: 600 };
    expect(checkClipStart({ mode: 'full' }, c)).toBeUndefined();
    expect(checkClipStart({ mode: 'full' }, { ...c, busy: true })).toContain('已经在录');
    expect(checkClipStart({ mode: 'full' }, { ...c, enabled: false })).toContain('设置中关闭');
  });
  it('配音页的按钮什么时候点不了', () => {
    const idle = { phase: 'idle' as const };
    expect(fullStartBlocked({ active: true, phase: 'ready' }, idle)).toBeUndefined();
    expect(fullStartBlocked({ active: false, phase: 'off' }, idle)).toContain('先开启配音');
    expect(fullStartBlocked({ active: true, phase: 'loading' }, idle)).toContain('还没就绪');
    expect(fullStartBlocked({ active: true, phase: 'ready' }, null)).toContain('刷新');
    expect(fullStartBlocked({ active: true, phase: 'ready' }, { ...idle, unavailable: '片段录制已在设置中关闭' })).toContain('片段录制已在设置中关闭');
    expect(fullStartBlocked({ active: true, phase: 'ready' }, { ...idle, shorts: true })).toContain('Shorts');
    expect(fullStartBlocked({ active: true, phase: 'ready' }, { phase: 'recording', mode: 'free' })).toContain('正在录别的片段');
    // 正在录整片：不算"点不了"，界面换成进度
    expect(fullStartBlocked({ active: true, phase: 'ready' }, { phase: 'recording', mode: 'full' })).toBeUndefined();
  });
});

describe('整片录制：录 / 等 / 停，和录不了时连视频一起暂停', () => {
  const control: ClipControl = { mode: 'full', videoId: ID, recordedSec: 100, bytes: 1000, maxSec: fullMaxSec(1051), maxBytes: CLIPS.maxBytes, userPaused: false };
  const sample: ClipSample = { videoId: ID, currentTime: 100, paused: false, ended: false, seeking: false, ready: true, ad: false, visible: true, duration: 1051 };
  it('从头录到结尾：放着就录，放完就结束（不是"到了单段上限"）', () => {
    expect(decideClip(control, sample)).toEqual({ kind: 'record' });
    // 录过了默认的 10 分钟上限也接着录
    expect(decideClip({ ...control, recordedSec: 900 }, { ...sample, currentTime: 900 })).toEqual({ kind: 'record' });
    expect(decideClip({ ...control, recordedSec: 1051 }, { ...sample, currentTime: 1051, ended: true })).toEqual({ kind: 'stop', reason: 'ended' });
  });
  it('标签页切到后台：录制等着，视频也暂停；切回来接着放', () => {
    const hidden = decideClip(control, { ...sample, visible: false });
    expect(hidden).toEqual({ kind: 'wait', why: 'hidden' });
    expect(fullHold(hidden, { paused: false, ad: false, held: false })).toBe('pause');
    // 已经暂停着：不重复
    expect(fullHold(hidden, { paused: true, ad: false, held: true })).toBeUndefined();
    // 切回来：这一轮看到的是"视频已暂停"，而且是我们暂停的 → 接着放
    const back = decideClip(control, { ...sample, paused: true });
    expect(back).toEqual({ kind: 'wait', why: 'paused' });
    expect(fullHold(back, { paused: true, ad: false, held: true })).toBe('play');
    // 是你自己暂停的（不是我们）：不替你接着放
    expect(fullHold(back, { paused: true, ad: false, held: false })).toBeUndefined();
    // 你已经自己点了播放：不再算我们暂停着的
    expect(fullHold(decideClip(control, sample), { paused: false, ad: false, held: true })).toBe('release');
  });
  it('你按了"暂停"：视频也暂停；点"继续"接着放', () => {
    const paused = decideClip({ ...control, userPaused: true }, sample);
    expect(paused).toEqual({ kind: 'wait', why: 'user' });
    expect(fullHold(paused, { paused: false, ad: false, held: false })).toBe('pause');
    expect(fullHold(decideClip(control, { ...sample, paused: true }), { paused: true, ad: false, held: true })).toBe('play');
  });
  it('广告不归我们管：后台时也不暂停广告，广告放完回到正片再暂停；缓冲、你自己暂停视频时什么都不做', () => {
    const adHidden = decideClip(control, { ...sample, ad: true, visible: false });
    expect(adHidden).toEqual({ kind: 'wait', why: 'ad' });
    expect(fullHold(adHidden, { paused: false, ad: true, held: false })).toBeUndefined();
    expect(fullHold(decideClip(control, { ...sample, visible: false }), { paused: false, ad: false, held: false })).toBe('pause');
    expect(fullHold(decideClip(control, { ...sample, seeking: true }), { paused: false, ad: false, held: false })).toBeUndefined();
    expect(fullHold(decideClip(control, { ...sample, paused: true }), { paused: true, ad: false, held: false })).toBeUndefined();
  });
  it('这一段结束了：不再管视频', () => {
    expect(fullHold({ kind: 'stop', reason: 'user' }, { paused: true, ad: false, held: true })).toBe('release');
  });
  it('等着时的说法写明视频也暂停了', () => {
    expect(CLIP_FULL_WAIT_LABELS.hidden).toContain('视频和录制都暂停了');
    expect(CLIP_FULL_WAIT_LABELS.user).toContain('视频也暂停了');
  });
});

describe('整片录制：录完整了没有', () => {
  it('进度正常往前走不算跳；被拖动（往前、往回）算', () => {
    expect(fullJump(undefined, 0, 0.1)).toBe(false);
    expect(fullJump(100, 100.1, 0.1)).toBe(false);
    // 广告、缓冲之后回到差不多原来的位置
    expect(fullJump(100, 100.6, 0.1)).toBe(false);
    expect(fullJump(100, 99.5, 0.1)).toBe(false);
    // 这一轮隔得久（页面卡了一下）：按过去的时间放宽
    expect(fullJump(100, 104, 1.5)).toBe(false);
    expect(fullJump(100, 130, 0.1)).toBe(true);
    expect(fullJump(100, 60, 0.1)).toBe(true);
  });
  const fine = { endedBy: 'ended' as const, jumps: 0, rateChanged: false, dubLost: false, dubbed: true, dubPlayedSec: 870 };
  it('放到结尾、没拖过、没改倍速、配音一直在：录完整了', () => {
    expect(fullIssues(fine)).toEqual([]);
  });
  it('中途停下、拖过进度、改过倍速、关过配音、配音没出声：一条条写明', () => {
    expect(fullIssues({ ...fine, endedBy: 'user' })).toEqual(['stopped-early']);
    expect(fullIssues({ ...fine, endedBy: 'max-bytes' })).toEqual(['stopped-early']);
    expect(fullIssues({ ...fine, jumps: 2 })).toEqual(['jumped']);
    expect(fullIssues({ ...fine, rateChanged: true })).toEqual(['rate']);
    expect(fullIssues({ ...fine, dubLost: true })).toEqual(['dub-off']);
    expect(fullIssues({ ...fine, dubPlayedSec: 0 })).toEqual(['dub-silent']);
    expect(fullIssues({ ...fine, dubbed: false })).toEqual(['dub-silent']);
    expect(fullIssues({ ...fine, endedBy: 'video-changed', jumps: 1, dubLost: true })).toEqual(['stopped-early', 'jumped', 'dub-off']);
    const r = { endedBy: 'user' as const, end: 312, duration: 1051 };
    expect(fullIssueText('stopped-early', r)).toBe('没录到结尾（你停止了录制）：只录到 5:12，全片 17:31');
    expect(fullIssueText('jumped', r)).toContain('拖动');
    expect(fullIssueText('rate', r)).toContain('倍速');
    expect(fullIssueText('dub-off', r)).toContain('只有原声');
    expect(fullIssueText('dub-silent', r)).toContain('没有录进去');
  });
});

describe('整片录制：文件名与记录', () => {
  it('录完整了的文件名：标题_双语完整版；没有标题用视频 ID', () => {
    expect(fullFileName('All Code Is Slop (Except Mine) — Lauren Tan, SpaceXSI', ID, 'mp4')).toBe('All Code Is Slop (Except Mine) — Lauren Tan, SpaceXSI_双语完整版.mp4');
    expect(fullFileName(undefined, ID, 'webm')).toBe(`youtube-${ID}_双语完整版.webm`);
    expect(fullFileName('a/b:c?', ID, 'mp4')).toBe('a b c_双语完整版.mp4');
  });
  const good = { id: 'clip_1', videoId: ID, mode: 'full', start: 0, end: 1051, durationSec: 1051.2, bytes: 1_000_000_000, format: 'MP4（H.264 + AAC）', fileName: 'x_双语完整版.mp4', burned: false, dubbed: true, savedAt: 1_800_000_000_000 };
  it('记录：整片只认 YouTube 的；没录完整的带 partial', () => {
    expect(sanitizeClipRecord(good)).toEqual(good);
    expect(sanitizeClipRecord({ ...good, partial: true })).toEqual({ ...good, partial: true });
    // 别的模式不带 partial
    expect(sanitizeClipRecord({ ...good, mode: 'free', partial: true })).toEqual({ ...good, mode: 'free' });
    expect(sanitizeClipRecord({ ...good, videoId: 'BV1xx411c7mD', url: 'https://www.bilibili.com/video/BV1xx411c7mD/' }, 'bilibili')).toBeNull();
  });
});
