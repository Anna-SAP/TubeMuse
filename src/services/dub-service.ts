// 中文配音（DECISIONS §74）：关联 / 换 / 移除本地 .m4a、存偏移、把音频分块交给 YouTube 页面里的配音脚本。
// 音频进出都只在本机：从你选的文件读进 IndexedDB，开启时由后台从 IndexedDB 读出来交给那个标签页。不发任何网络请求。

import { DUB } from '../config/defaults';
import { bytesToBase64 } from '../core/clips';
import {
  DubFileError,
  checkDubFile,
  clampDelay,
  dubMapOf,
  englishAlignSuggestion,
  isDubPortRequest,
  probeM4a,
  quickAlignSuggestion,
  sanitizeOverallRate,
  sanitizeQuickRate,
  withAnchor,
  withSegmentOffset,
  type DubAnchor,
  type DubIndex,
  type DubPortReply,
  type DubRecord,
  type DubSubsMeta,
} from '../core/dub';
import { prepareDubCues, rankXyzForDub, xyzCuesForDub, type DubSubsDoc, type PreparedDubSubs, type XyzSubsChoice } from '../core/dub-subs';
import { SubtitleFileError, parseSubtitleFile, type SubCue } from '../core/subtitle-track';
import type { XyzTranscript } from '../core/xyz';
import type { AppContext } from './context';
import type { DubAudioStore } from './dub-store';
import { dubAsrStore, dubSubsStore, newId, stores, xyzTranscriptStore } from './repo';

function audioStore(ctx: AppContext): DubAudioStore {
  if (!ctx.dubAudio) throw new DubFileError('这个浏览器环境里没有 IndexedDB，存不了配音文件');
  return ctx.dubAudio;
}

export interface AttachInput {
  videoId: string;
  file: Blob;
  fileName: string;
  title?: string;
  videoDurationSec?: number;
}

/** 读你选的文件的一段（检查格式用） */
export const blobReader = (blob: Blob) => async (start: number, end: number) => new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer());

/**
 * 给这个视频关联一个 .m4a：检查格式、读出时长，存进 IndexedDB，再记下对应关系。
 * 已经关联过的视频换成新文件（偏移和对齐点保留：同一个视频换一版配音，多半还是那样），旧文件随后删掉。
 */
export async function attachDub(ctx: AppContext, input: AttachInput): Promise<DubRecord> {
  checkDubFile(input.fileName, input.file.type, input.file.size);
  const probe = await probeM4a(blobReader(input.file), input.file.size);
  const store = audioStore(ctx);
  const fileId = newId('dub');
  let previous: string | undefined;
  let saved: DubRecord | undefined;
  // 存音频与记对应关系在同一把锁里：核对存储（checkDubStorage）不会把刚存进去、还没记下的音频当成没人用的删掉
  await stores.dubs.update(ctx.kv, ctx.locker, async (index) => {
    try {
      await store.put(fileId, input.file);
    } catch (e) {
      throw new DubFileError('没能存进本机', `浏览器的存储出错（${e instanceof Error ? e.message : String(e)}）。磁盘空间不够时先腾出一些再试。`);
    }
    const old = index[input.videoId];
    previous = old?.fileId;
    const videoDurationSec = input.videoDurationSec && Number.isFinite(input.videoDurationSec) ? Math.round(input.videoDurationSec * 1000) / 1000 : old?.videoDurationSec;
    // 快速对齐开着时换文件（DECISIONS §82）：倍速按新文件的时长重新算（要的是"整段放满"，旧倍速对新文件多半不对）；
    // 新的倍速超出能用的范围时回到手动对齐；算不出来（读不到时长）时先留着旧的，界面上会如实显示还差多少
    const quick = old?.quickRate !== undefined ? quickAlignSuggestion(probe.durationSec, videoDurationSec) : undefined;
    const quickRate = old?.quickRate === undefined ? undefined : quick ? (quick.ok ? quick.rate : undefined) : old.quickRate;
    // 加快英文（DECISIONS §87）同理：英文的倍速按新文件的时长重新算
    const english = old?.englishRate !== undefined ? englishAlignSuggestion(probe.durationSec, videoDurationSec) : undefined;
    const englishRate = old?.englishRate === undefined ? undefined : english ? (english.ok ? english.rate : undefined) : old.englishRate;
    const rec: DubRecord = {
      videoId: input.videoId,
      fileId,
      fileName: input.fileName.slice(0, DUB.fileNameMaxChars),
      size: input.file.size,
      mime: input.file.type || 'audio/mp4',
      delaySec: old?.delaySec ?? 0,
      // 同一个视频换一版配音：偏移和对齐点多半还能用，保留（界面上说明，不对再删）
      ...(old?.anchors?.length ? { anchors: old.anchors } : {}),
      ...(quickRate !== undefined ? { quickRate } : {}),
      ...(englishRate !== undefined ? { englishRate } : {}),
      // 整体倍速（DECISIONS §87）是你听的快慢，和文件无关：保留
      ...(old?.overallRate !== undefined ? { overallRate: old.overallRate } : {}),
      // 字幕也保留（DECISIONS §86）：同一段话换一版录音，字幕多半还对得上；对不上由你换一份
      ...(old?.subs ? { subs: old.subs } : {}),
      addedAt: ctx.now(),
      ...(probe.durationSec ? { durationSec: probe.durationSec } : {}),
      ...(videoDurationSec ? { videoDurationSec } : {}),
      ...(input.title ? { title: input.title.slice(0, DUB.titleMaxChars) } : old?.title ? { title: old.title } : {}),
    };
    saved = rec;
    return { ...index, [input.videoId]: rec };
  });
  if (previous && previous !== fileId) {
    await store.delete(previous).catch(() => undefined);
    // 识别到一半的进度是旧文件的（DECISIONS §91）：换了文件就作废
    await ctx.kv.remove(dubAsrStore(input.videoId).key);
  }
  return saved!;
}

/** 取消关联：先删对应关系（页面里的配音随即停下），再删音频 */
export async function removeDub(ctx: AppContext, videoId: string): Promise<void> {
  let fileId: string | undefined;
  await stores.dubs.update(ctx.kv, ctx.locker, (index) => {
    fileId = index[videoId]?.fileId;
    const { [videoId]: _gone, ...rest } = index;
    return rest;
  });
  // 这个配音的字幕、识别到一半的进度一并删掉（DECISIONS §86、§91）
  await ctx.kv.remove(dubSubsStore(videoId).key);
  await ctx.kv.remove(dubAsrStore(videoId).key);
  if (fileId) await audioStore(ctx).delete(fileId);
}

/** 存开头那一段的偏移（秒，正 = 中文推后） */
export async function setDubDelay(ctx: AppContext, videoId: string, delaySec: number): Promise<void> {
  await stores.dubs.update(ctx.kv, ctx.locker, (index) => {
    const rec = index[videoId];
    return rec ? { ...index, [videoId]: { ...rec, delaySec: clampDelay(delaySec) } } : index;
  });
}

function withMap(rec: DubRecord, map: { delaySec: number; anchors: readonly DubAnchor[] }): DubRecord {
  const { anchors: _old, ...rest } = rec;
  return { ...rest, delaySec: map.delaySec, ...(map.anchors.length ? { anchors: [...map.anchors] } : {}) };
}

/** 存某一段的偏移（DECISIONS §75）：segment −1 = 开头那段；k = 第 k 个对齐点之后那段（改这个对齐点的中文位置，视频位置不动） */
export async function setDubSegmentOffset(ctx: AppContext, videoId: string, segment: number, offset: number): Promise<void> {
  await stores.dubs.update(ctx.kv, ctx.locker, (index) => {
    const rec = index[videoId];
    if (!rec || segment >= (rec.anchors?.length ?? 0)) return index;
    return { ...index, [videoId]: withMap(rec, withSegmentOffset(dubMapOf(rec), segment, offset)) };
  });
}

/**
 * 加一个对齐点：视频的这一刻对应中文的这一刻。离已有的不到 1 秒时替换那一个。
 * 最多 DUB.maxAnchors 个，满了说明原因、不加。返回加完后的记录
 */
export async function addDubAnchor(ctx: AppContext, videoId: string, anchor: DubAnchor): Promise<DubRecord | undefined> {
  let saved: DubRecord | undefined;
  let full = false;
  await stores.dubs.update(ctx.kv, ctx.locker, (index) => {
    const rec = index[videoId];
    if (!rec || !Number.isFinite(anchor.video) || !Number.isFinite(anchor.dub) || anchor.video <= 0) return index;
    const anchors = withAnchor(rec.anchors ?? [], anchor);
    if (anchors.length > DUB.maxAnchors) {
      full = true;
      return index;
    }
    saved = withMap(rec, { delaySec: rec.delaySec, anchors });
    return { ...index, [videoId]: saved };
  });
  if (full) throw new DubFileError(`对齐点已经有 ${DUB.maxAnchors} 个了`, '先删掉几个用不上的再加。');
  return saved;
}

/** 删第 k 个对齐点：它前面那一段一直延续到下一个对齐点 */
export async function removeDubAnchor(ctx: AppContext, videoId: string, k: number): Promise<void> {
  await stores.dubs.update(ctx.kv, ctx.locker, (index) => {
    const rec = index[videoId];
    if (!rec?.anchors || k < 0 || k >= rec.anchors.length) return index;
    return { ...index, [videoId]: withMap(rec, { delaySec: rec.delaySec, anchors: rec.anchors.filter((_, i) => i !== k) }) };
  });
}

/** 按倍速对齐的哪一种：快速对齐（中文变速）/ 加快英文（英文变速，DECISIONS §87） */
export type DubRateAlign = { kind: 'quick' | 'english'; rate: number };

/**
 * 按倍速对齐：给 { kind, rate } = 开这一种（另一种同时关掉，两种只会开一种）；undefined = 切回手动对齐。
 * 开头的偏移和对齐点始终原样留着。倍速不在能用的范围里时不存（返回 false）
 */
export async function setDubRateAlign(ctx: AppContext, videoId: string, align: DubRateAlign | undefined): Promise<boolean> {
  const rate = align === undefined ? undefined : sanitizeQuickRate(align.rate);
  if (align !== undefined && rate === undefined) return false;
  let done = false;
  await stores.dubs.update(ctx.kv, ctx.locker, (index) => {
    const rec = index[videoId];
    if (!rec) return index;
    done = true;
    const { quickRate: _q, englishRate: _e, ...rest } = rec;
    if (!align || rate === undefined) return { ...index, [videoId]: rest };
    return { ...index, [videoId]: align.kind === 'quick' ? { ...rest, quickRate: rate } : { ...rest, englishRate: rate } };
  });
  return done;
}

/**
 * 快速对齐（DECISIONS §82）：给倍速 = 开（中文整段按这个倍速放）；undefined = 切回手动对齐。
 * 开头的偏移和对齐点始终原样留着。倍速不在能用的范围里时不存（返回 false）
 */
export async function setDubQuickRate(ctx: AppContext, videoId: string, rate: number | undefined): Promise<boolean> {
  return setDubRateAlign(ctx, videoId, rate === undefined ? undefined : { kind: 'quick', rate });
}

/** 加快英文（DECISIONS §87）：给倍速 = 开（英文原声整段按这个倍速放、中文原速）；undefined = 切回手动对齐 */
export async function setDubEnglishRate(ctx: AppContext, videoId: string, rate: number | undefined): Promise<boolean> {
  return setDubRateAlign(ctx, videoId, rate === undefined ? undefined : { kind: 'english', rate });
}

/**
 * 整体倍速（DECISIONS §87）：对齐之后两边一起变快 / 变慢，对齐不变。1 = 不变速（去掉这一项）。
 * 不在范围里时不存（返回 false）
 */
export async function setDubOverallRate(ctx: AppContext, videoId: string, rate: number): Promise<boolean> {
  const r = Number.isFinite(rate) ? Number(rate.toFixed(2)) : NaN;
  const overall = sanitizeOverallRate(r);
  if (overall === undefined && r !== 1) return false;
  let done = false;
  await stores.dubs.update(ctx.kv, ctx.locker, (index) => {
    const rec = index[videoId];
    if (!rec) return index;
    done = true;
    const { overallRate: _old, ...rest } = rec;
    return { ...index, [videoId]: overall === undefined ? rest : { ...rest, overallRate: overall } };
  });
  return done;
}

// ── 配音字幕（DECISIONS §86）──

export interface DubSubsSaved {
  meta: DubSubsMeta;
  prepared: PreparedDubSubs;
}

/**
 * 给这个视频的配音存一份字幕：整理（排好、去重叠；双语的只留配音语言的那几行），字幕本身按视频分键存，
 * 记录里只记它是哪来的、多少句。先存字幕、再记说明：页面里的字幕脚本看到说明时字幕已经在了。
 * 一句都不剩时抛 SubtitleFileError；这个视频没有配音时返回 undefined
 */
export async function setDubSubtitles(ctx: AppContext, videoId: string, input: { name: string; cues: readonly SubCue[]; source: DubSubsMeta['source'] }): Promise<DubSubsSaved | undefined> {
  const prepared = prepareDubCues(input.cues);
  if (!prepared.cues.length) throw new SubtitleFileError('这份字幕里一句能显示的都没有');
  if (!(await stores.dubs.read(ctx.kv))[videoId]) return undefined;
  const doc: DubSubsDoc = { videoId, cues: prepared.cues };
  await dubSubsStore(videoId).update(ctx.kv, ctx.locker, () => doc);
  const meta: DubSubsMeta = {
    name: input.name.trim().slice(0, DUB.fileNameMaxChars) || '字幕',
    count: prepared.cues.length,
    lang: prepared.lang,
    source: input.source,
    ...(prepared.reduced ? { reduced: true } : {}),
    addedAt: ctx.now(),
  };
  let saved = false;
  await stores.dubs.update(ctx.kv, ctx.locker, (index) => {
    const rec = index[videoId];
    if (!rec) return index;
    saved = true;
    return { ...index, [videoId]: { ...rec, subs: meta } };
  });
  if (!saved) {
    // 存字幕的工夫里这个配音被移除了：字幕不留
    await ctx.kv.remove(dubSubsStore(videoId).key);
    return undefined;
  }
  return { meta, prepared };
}

/** 读你选的字幕文件（.srt / .vtt）存成这个配音的字幕 */
export async function setDubSubtitleFile(ctx: AppContext, videoId: string, file: Blob, fileName: string): Promise<DubSubsSaved | undefined> {
  if (file.size > DUB.export.maxSubtitleFileBytes) {
    throw new SubtitleFileError('这个字幕文件太大了', `字幕文件一般只有几十 KB；最大 ${DUB.export.maxSubtitleFileBytes / 1024 / 1024} MB。是不是选成了音频或视频文件？`);
  }
  return setDubSubtitles(ctx, videoId, { name: fileName, cues: parseSubtitleFile(await file.text()), source: 'file' });
}

/** 去掉这个配音的字幕：先去掉说明（页面里的字幕随即消失），再删字幕本身 */
export async function removeDubSubtitles(ctx: AppContext, videoId: string): Promise<void> {
  await stores.dubs.update(ctx.kv, ctx.locker, (index) => {
    const rec = index[videoId];
    if (!rec?.subs) return index;
    const { subs: _gone, ...rest } = rec;
    return { ...index, [videoId]: rest };
  });
  await ctx.kv.remove(dubSubsStore(videoId).key);
}

/** 这个配音存着的字幕；没有（或存储里的坏了）时 null */
export async function readDubSubtitles(ctx: AppContext, videoId: string): Promise<DubSubsDoc | null> {
  return dubSubsStore(videoId).read(ctx.kv);
}

async function xyzTranscripts(ctx: AppContext): Promise<XyzTranscript[]> {
  const eids = Object.keys(await stores.xyzTranscriptIndex.read(ctx.kv));
  const all = await Promise.all(eids.map((eid) => xyzTranscriptStore(eid).read(ctx.kv)));
  return all.filter((t): t is XyzTranscript => !!t && Array.isArray(t.cues));
}

/** 小宇宙里已经生成、存在本机的字幕（只读本机存储，不联网、不花钱）：看起来就是这个配音的那一集排前面 */
export async function listXyzSubsForDub(ctx: AppContext, rec: Pick<DubRecord, 'fileName' | 'durationSec'>): Promise<XyzSubsChoice[]> {
  return rankXyzForDub(await xyzTranscripts(ctx), { fileName: rec.fileName, ...(rec.durationSec ? { durationSec: rec.durationSec } : {}) });
}

/** 把小宇宙里那一集已经生成的字幕存成这个配音的字幕（抄一份此刻的：之后那一集又生成了新的，要再点一次） */
export async function copyXyzSubsForDub(ctx: AppContext, videoId: string, eid: string): Promise<DubSubsSaved | undefined> {
  const t = await xyzTranscriptStore(eid).read(ctx.kv);
  if (!t?.cues?.length) throw new SubtitleFileError('小宇宙里这一集的字幕不见了', '回到小宇宙那一集的页面，在「小宇宙」页重新生成字幕。');
  return setDubSubtitles(ctx, videoId, { name: t.title || eid, cues: xyzCuesForDub(t.cues), source: 'xyz' });
}

/** 本机存储的核对：没人用的音频（例如关联写到一半浏览器关了）删掉；对应关系还在、音频却没了的列出来 */
export async function checkDubStorage(ctx: AppContext): Promise<{ missing: string[]; removedOrphans: number }> {
  const store = audioStore(ctx);
  return ctx.locker.withLock(stores.dubs.key, async () => {
    const index: DubIndex = await stores.dubs.read(ctx.kv);
    const keys = new Set(await store.keys());
    const used = new Set(Object.values(index).map((r) => r.fileId));
    let removedOrphans = 0;
    for (const k of keys) {
      if (used.has(k)) continue;
      await store.delete(k).catch(() => undefined);
      removedOrphans++;
    }
    return { missing: Object.values(index).filter((r) => !keys.has(r.fileId)).map((r) => r.videoId), removedOrphans };
  });
}

/**
 * 后台：YouTube 页面里的配音脚本要音频。核对对应关系后从 IndexedDB 分块读出、转成 base64 交过去
 * （扩展消息只能传文字）。post 返回 false 表示那边已经断开，停下。
 */
export async function streamDubAudio(ctx: AppContext, request: unknown, post: (m: DubPortReply) => boolean): Promise<void> {
  if (!isDubPortRequest(request)) {
    post({ type: 'error', message: '配音请求不对' });
    return;
  }
  const rec = (await stores.dubs.read(ctx.kv))[request.videoId];
  if (!rec || rec.fileId !== request.fileId) {
    post({ type: 'error', message: '这个视频的配音已经移除或换了文件', hint: '在侧边栏「配音」页重新开启。' });
    return;
  }
  const blob = ctx.dubAudio ? await ctx.dubAudio.get(rec.fileId).catch(() => undefined) : undefined;
  if (!blob) {
    post({ type: 'error', message: '本机找不到这个配音文件', hint: '浏览器的存储可能被清理过：在侧边栏「配音」页移除它，再重新选择文件。' });
    return;
  }
  if (!post({ type: 'meta', size: blob.size, mime: rec.mime })) return;
  for (let at = 0; at < blob.size; at += DUB.chunkBytes) {
    const bytes = new Uint8Array(await blob.slice(at, Math.min(blob.size, at + DUB.chunkBytes)).arrayBuffer());
    if (!post({ type: 'chunk', data: bytesToBase64(bytes) })) return;
  }
  post({ type: 'done' });
}
