// 「问 muse」（2026-11-11 新增，见 DECISIONS §60）：你点按钮的那一刻"冻结"——向当前标签页的录制脚本要这条视频 / 帖子此刻的样子，
// YouTube 再取已有的字幕（多语字幕已读到的，否则本机存的自动字幕）和作者（官方 videos.list：本机有缓存就不查，没有才查一次，1 unit）。
// 不调大模型、不向 Muse 发任何东西；拼咨询包的纯逻辑在 core/muse.ts。

import { MUSE } from '../config/defaults';
import { MUSE_MSG, autoTranscriptAround, sanitizeMuseCaptionReply, sanitizeMuseSnapshot, type MuseCaptions, type MusePositionGap, type MuseSnapshot } from '../core/muse';
import type { ClipSite } from '../core/clips';
import type { AppContext } from './context';
import { stores, subtitleTrackStore } from './repo';
import { lookupVideoMeta } from './subtitle-service';

/** 给当前标签页的内容脚本发一条消息、拿回复（侧边栏里是 chrome.tabs.sendMessage；单测里是假的） */
export type MuseSend = (msg: Record<string, unknown>) => Promise<unknown>;

export interface MuseFreeze {
  /** 冻结的时刻（你点按钮的时候） */
  at: number;
  /** 校验过的快照；YouTube 的作者（和页面上没读到时的标题）已经补上 */
  snapshot: MuseSnapshot;
  /** 冻结位置前后的字幕 / 转写（只有 YouTube、且已经读到时才有） */
  captions?: MuseCaptions;
  /** 要让你知道的事：哪一项没取到、为什么 */
  notes: string[];
}

export type MuseFreezeResult = { ok: true; freeze: MuseFreeze } | { ok: false; message: string };

export const MUSE_NO_SCRIPT =
  '当前标签页没有响应：它不是 YouTube 视频页、小红书、X、酷播、Instagram 或抖音网页版。如果是，刷新一下那个页面再点「问 muse」（扩展安装或更新之前打开的页面里还没有 TubeMuse 的脚本）';

function gapNote(gap: MusePositionGap, site: ClipSite): string {
  if (gap === 'ad') return '正在播广告：这时读到的是广告的进度，所以播放位置写的是「未知」。广告结束后再点一次「问 muse」';
  if (gap === 'shorts') return 'Shorts 的播放位置读不到，写的是「未知」';
  if (site === 'xhs') return '这篇笔记里没找到视频（图文笔记，或视频还没出来），播放位置写的是「未知」';
  if (site === 'x') return '这条帖子里没找到视频，播放位置写的是「未知」';
  return '没找到播放器里的视频，播放位置写的是「未知」；等视频开始播放后再点一次「问 muse」';
}

/** 冻结位置前后的字幕 / 转写：先问多语字幕脚本已经读到的 YouTube 字幕，没有再看本机存的自动字幕；都没有时 undefined */
async function youtubeCaptions(ctx: AppContext, send: MuseSend, videoId: string, position: number): Promise<MuseCaptions | undefined> {
  let reply: unknown;
  try {
    reply = await send({ type: MUSE_MSG.captions, t: position });
  } catch {
    reply = undefined;
  }
  const cc = sanitizeMuseCaptionReply(reply, videoId);
  if (cc) return cc;
  const track = await subtitleTrackStore(videoId).read(ctx.kv);
  return autoTranscriptAround(track?.cues, position);
}

/**
 * YouTube 的作者（频道名）：页面上的不读，走官方接口——本机有这个视频的资料（与观看记录、自动字幕共用缓存）就直接用，
 * 没有才查一次 videos.list（1 unit，记进配额）。最多等 MUSE.authorLookupMs：超时就先写「无」并说明，查到的结果留给下一次。
 */
async function youtubeMeta(ctx: AppContext, videoId: string): Promise<{ author?: string; title?: string; note?: string }> {
  const blank = '咨询包里写的是「无」';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), MUSE.authorLookupMs)));
  const lookup = lookupVideoMeta(ctx, videoId, '「问 muse」查视频作者').catch((e: unknown) => ({ meta: undefined, problem: e instanceof Error ? e.message : String(e) }));
  const r = await Promise.race([lookup, timeout]);
  clearTimeout(timer);
  if (r === 'timeout') return { note: `作者没查到：YouTube 官方接口 ${MUSE.authorLookupMs / 1000} 秒内没有回应，${blank}。稍后再点一次「问 muse」（查到后本机会记住）` };
  if (r.meta?.missing) return { note: `YouTube 官方接口查不到这个视频（可能已删除或设为私享），作者一项${blank}` };
  if (r.meta) return { ...(r.meta.channelTitle ? { author: r.meta.channelTitle } : { note: `YouTube 官方接口没有给出这个视频的频道名，作者一项${blank}` }), ...(r.meta.title ? { title: r.meta.title } : {}) };
  if (r.problem === 'disconnected') return { note: `作者没取到：没有连接 YouTube（或授权已过期），${blank}。连接后再点一次「问 muse」` };
  return { note: `作者没取到：${r.problem ?? 'YouTube 官方接口没有返回这个视频'}，${blank}` };
}

/**
 * 冻结：读当前标签页这条视频 / 帖子此刻的样子（播放位置就是这一刻的，不暂停视频）。
 * 认不出当前这条视频、或标签页里没有 TubeMuse 的脚本时返回原因，不生成咨询包。
 */
export async function freezeMuse(ctx: AppContext, send: MuseSend): Promise<MuseFreezeResult> {
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
  const [captions, meta] = await Promise.all([snap.position !== undefined ? youtubeCaptions(ctx, send, snap.videoId, snap.position) : undefined, youtubeMeta(ctx, snap.videoId)]);
  if (meta.note) notes.push(meta.note);
  const title = snap.title ?? meta.title;
  const snapshot: MuseSnapshot = { ...snap, ...(title ? { title } : {}), ...(meta.author ? { author: meta.author } : {}) };
  return { ok: true, freeze: { at, snapshot, ...(captions ? { captions } : {}), notes } };
}

/** 你存在本机的 Key / 令牌：拼咨询包时万一原样出现在文字里，换掉（只在本机比对，不发往任何地方） */
export async function museSecrets(ctx: AppContext): Promise<string[]> {
  const [s, auth] = await Promise.all([stores.secrets.read(ctx.kv), stores.youtubeAuth.read(ctx.kv)]);
  return [s.anthropicApiKey, s.openaiApiKey, s.xBearerToken, s.googleClientSecret, auth?.accessToken, auth?.refreshToken].filter((x): x is string => !!x);
}
