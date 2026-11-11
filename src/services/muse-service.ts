// 「问 muse」（2026-11-11 新增，见 DECISIONS §60、§63）：你点按钮的那一刻"冻结"——向当前标签页的录制脚本要这条视频 / 帖子此刻的样子。
// YouTube 再做两件事：向多语字幕脚本要位置前后的字幕（它已经读到的，或为这一次提问取来的；都没有时用本机存的自动字幕），
// 以及作者、简介和章节（官方 videos.list：本机记着就不查，没有才查一次，1 unit；章节是从简介里认出来的）。
// 不调大模型、不向 Muse 发任何东西；拼咨询包的纯逻辑在 core/muse.ts。

import { MUSE } from '../config/defaults';
import {
  MUSE_MSG,
  autoTranscriptAround,
  museCaptionProblem,
  rememberMuseVideo,
  sanitizeMuseCaptionReply,
  sanitizeMuseSnapshot,
  type MuseCaptions,
  type MusePositionGap,
  type MuseSnapshot,
  type MuseVideoInfo,
} from '../core/muse';
import type { ClipSite } from '../core/clips';
import { OperationBudget } from '../core/quota';
import type { AppContext } from './context';
import { toAppError } from './errors';
import { makeCharger, makeExhaustedMarker } from './quota-service';
import { stores, subtitleTrackStore } from './repo';
import { createYouTube } from './youtube';

/** 给当前标签页的内容脚本发一条消息、拿回复（侧边栏里是 chrome.tabs.sendMessage；单测里是假的） */
export type MuseSend = (msg: Record<string, unknown>) => Promise<unknown>;

export interface MuseFreeze {
  /** 冻结的时刻（你点按钮的时候） */
  at: number;
  /** 校验过的快照；YouTube 的作者（和页面上没读到时的标题）已经补上 */
  snapshot: MuseSnapshot;
  /** 冻结位置前后的字幕 / 转写（只有 YouTube、且取到了才有） */
  captions?: MuseCaptions;
  /** YouTube：官方接口给的简介（章节从它里面认） */
  description?: string;
  /** 要让你知道的事：哪一项没取到、为什么 */
  notes: string[];
}

export interface MuseFreezeOptions {
  /** YouTube：还没读到字幕时，为这一次提问取视频自带的字幕（设置里可关） */
  fetchCaptions: boolean;
}

export type MuseFreezeResult = { ok: true; freeze: MuseFreeze } | { ok: false; message: string };

export const MUSE_NO_SCRIPT =
  '当前标签页没有响应：它不是 YouTube 视频页、小红书、X、酷播、Instagram、抖音或 B 站网页版。如果是，刷新一下那个页面再点「问 muse」（扩展安装或更新之前打开的页面里还没有 TubeMuse 的脚本）';

/** 没带上字幕时面板里的提示：前半句是这一次没取到的原因 */
export const MUSE_CAPTION_HINT = '想带上的话，先在"字幕"页打开多语字幕或自动字幕，等字幕出来后再点一次「问 muse」';

function gapNote(gap: MusePositionGap, site: ClipSite): string {
  if (gap === 'ad') return '正在播广告：这时读到的是广告的进度，所以播放位置写的是「未知」。广告结束后再点一次「问 muse」';
  if (site === 'xhs') return '这篇笔记里没找到视频（图文笔记，或视频还没出来），播放位置写的是「未知」';
  if (site === 'x') return '这条帖子里没找到视频，播放位置写的是「未知」';
  return '没找到播放器里的视频，播放位置写的是「未知」；等视频开始播放后再点一次「问 muse」';
}

/** 等 p，最多等 ms 毫秒；超时返回 'timeout'（p 照常继续，只是不等它了） */
async function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), ms)));
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 冻结位置前后的字幕 / 转写。先问多语字幕脚本：它已经读到的 YouTube 字幕直接用，没有时（且允许）为这一次提问取一种语言；
 * 再没有，用本机存的自动字幕（语音识别的转写）。都没有时返回原因。
 */
async function youtubeCaptions(ctx: AppContext, send: MuseSend, videoId: string, position: number, fetchCaptions: boolean): Promise<{ captions?: MuseCaptions; problem?: string }> {
  // 内容脚本自己最多取 MUSE.captionFetchMs；这里多等一小会儿，它一直不回话（例如页面卡住）也不干等
  const reply = await within(
    send({ type: MUSE_MSG.captions, t: position, fetch: fetchCaptions }).catch(() => undefined),
    MUSE.captionFetchMs + 2000,
  );
  const cc = reply === 'timeout' ? undefined : sanitizeMuseCaptionReply(reply, videoId);
  if (cc) return { captions: cc };
  const track = await subtitleTrackStore(videoId).read(ctx.kv);
  const auto = autoTranscriptAround(track?.cues, position);
  if (auto) return { captions: auto };
  if (reply === 'timeout') return { problem: '那个页面一直没有回话（可能卡住了）' };
  if (reply === undefined || reply === null) return { problem: '那个页面里的字幕脚本没有应答（刷新那个页面再试）' };
  const problem = museCaptionProblem(reply, videoId);
  return problem ? { problem } : {};
}

/**
 * 这个视频的标题、频道名和简介：本机记着（最近问过）就直接用，没有才向官方接口查一次（videos.list，1 unit，记进配额）。
 * 没连接 YouTube 时 problem = 'disconnected'，查询出错时是错误原因。
 */
async function lookupVideoInfo(ctx: AppContext, videoId: string): Promise<{ info?: MuseVideoInfo; problem?: string }> {
  const cached = (await stores.museVideos.read(ctx.kv))[videoId];
  if (cached) return { info: cached };
  if ((await ctx.auth.status()) !== 'connected') return { problem: 'disconnected' };
  const settings = await stores.settings.read(ctx.kv);
  try {
    const yt = createYouTube({
      http: ctx.http,
      auth: ctx.auth,
      baseUrl: ctx.endpoints.youtubeApi,
      charge: makeCharger(ctx, new OperationBudget({ searchCalls: 0, generalUnits: 1 }, '「问 muse」查视频的作者和简介'), settings.quota),
      onQuotaExhausted: makeExhaustedMarker(ctx),
    });
    const found = await yt.videoIntro(videoId);
    const info: MuseVideoInfo = found
      ? { title: found.title, channelTitle: found.channelTitle, description: found.description, fetchedAt: ctx.now() }
      : { title: '', channelTitle: '', description: '', fetchedAt: ctx.now(), missing: true };
    await stores.museVideos.update(ctx.kv, ctx.locker, (all) => rememberMuseVideo(all, videoId, info));
    return { info };
  } catch (e) {
    return { problem: toAppError(e).message };
  }
}

/**
 * YouTube 的作者、简介（章节写在简介里）：页面上的不读，走官方接口。最多等 MUSE.infoLookupMs，超时就先写「无」并说明，
 * 查到的结果留给下一次。没查到时，作者还可以用本机观看记录那份资料里的（不花配额）。
 */
async function youtubeInfo(ctx: AppContext, videoId: string): Promise<{ author?: string; title?: string; description?: string; note?: string }> {
  const blank = '咨询包里写的是「无」';
  const r = await within(
    lookupVideoInfo(ctx, videoId).catch((e: unknown): { info?: MuseVideoInfo; problem?: string } => ({ problem: e instanceof Error ? e.message : String(e) })),
    MUSE.infoLookupMs,
  );
  if (r !== 'timeout' && r.info && !r.info.missing) {
    const { title, channelTitle, description } = r.info;
    return {
      ...(channelTitle ? { author: channelTitle } : { note: `YouTube 官方接口没有给出这个视频的频道名，作者一项${blank}` }),
      ...(title ? { title } : {}),
      ...(description.trim() ? { description } : {}),
    };
  }
  if (r !== 'timeout' && r.info?.missing) return { note: `YouTube 官方接口查不到这个视频（可能已删除或设为私享），作者、简介和章节${blank}` };
  const meta = (await stores.videoMeta.read(ctx.kv))[videoId];
  const known = meta && !meta.missing ? meta : undefined;
  const what = known?.channelTitle ? '简介和章节' : '作者、简介和章节';
  const note =
    r === 'timeout'
      ? `${what}没查到：YouTube 官方接口 ${MUSE.infoLookupMs / 1000} 秒内没有回应，${blank}。稍后再点一次「问 muse」（查到后本机会记住）`
      : r.problem === 'disconnected'
        ? `${what}没取到：没有连接 YouTube（或授权已过期），${blank}。连接后再点一次「问 muse」`
        : `${what}没取到：${r.problem ?? 'YouTube 官方接口没有返回这个视频'}，${blank}`;
  return { ...(known?.channelTitle ? { author: known.channelTitle } : {}), ...(known?.title ? { title: known.title } : {}), note };
}

/**
 * 冻结：读当前标签页这条视频 / 帖子此刻的样子（播放位置就是这一刻的，不暂停视频）。
 * 认不出当前这条视频、或标签页里没有 TubeMuse 的脚本时返回原因，不生成咨询包。
 */
export async function freezeMuse(ctx: AppContext, send: MuseSend, options: MuseFreezeOptions = { fetchCaptions: true }): Promise<MuseFreezeResult> {
  let raw: unknown;
  try {
    raw = await send({ type: MUSE_MSG.snapshot });
  } catch {
    raw = undefined;
  }
  const at = ctx.now();
  if (raw === undefined || raw === null) return { ok: false, message: MUSE_NO_SCRIPT };
  const snap = sanitizeMuseSnapshot(raw);
  if (!snap) return { ok: false, message: '页面交回来的信息对不上（这条视频的链接和 ID 不一致），没有生成咨询包：刷新那个页面再试' };
  if (snap.unavailable || !snap.videoId) return { ok: false, message: snap.unavailable ?? '没认出当前这条视频' };
  const notes: string[] = [];
  if (snap.gap) notes.push(gapNote(snap.gap, snap.site));
  if (snap.site !== 'youtube') return { ok: true, freeze: { at, snapshot: snap, notes } };
  const { videoId, position } = snap;
  const [cap, info] = await Promise.all([position !== undefined ? youtubeCaptions(ctx, send, videoId, position, options.fetchCaptions) : undefined, youtubeInfo(ctx, videoId)]);
  if (info.note) notes.push(info.note);
  if (cap && !cap.captions) notes.push(`没有带上字幕：${cap.problem ?? '没有取到这个视频的字幕'}。${MUSE_CAPTION_HINT}`);
  const title = snap.title ?? info.title;
  const snapshot: MuseSnapshot = { ...snap, ...(title ? { title } : {}), ...(info.author ? { author: info.author } : {}) };
  return { ok: true, freeze: { at, snapshot, ...(cap?.captions ? { captions: cap.captions } : {}), ...(info.description ? { description: info.description } : {}), notes } };
}

/** 你存在本机的 Key / 令牌：拼咨询包时万一原样出现在文字里，换掉（只在本机比对，不发往任何地方） */
export async function museSecrets(ctx: AppContext): Promise<string[]> {
  const [s, auth] = await Promise.all([stores.secrets.read(ctx.kv), stores.youtubeAuth.read(ctx.kv)]);
  return [s.anthropicApiKey, s.openaiApiKey, s.xBearerToken, s.googleClientSecret, auth?.accessToken, auth?.refreshToken].filter((x): x is string => !!x);
}
