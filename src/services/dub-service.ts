// 中文配音（DECISIONS §73）：关联 / 换 / 移除本地 .m4a、存偏移、把音频分块交给 YouTube 页面里的配音脚本。
// 音频进出都只在本机：从你选的文件读进 IndexedDB，开启时由后台从 IndexedDB 读出来交给那个标签页。不发任何网络请求。

import { DUB } from '../config/defaults';
import { bytesToBase64 } from '../core/clips';
import { DubFileError, checkDubFile, clampDelay, isDubPortRequest, probeM4a, type DubIndex, type DubPortReply, type DubRecord } from '../core/dub';
import type { AppContext } from './context';
import type { DubAudioStore } from './dub-store';
import { newId, stores } from './repo';

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
 * 已经关联过的视频换成新文件（偏移保留：同一个视频换一版配音，开头多半还是那样），旧文件随后删掉。
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
    const rec: DubRecord = {
      videoId: input.videoId,
      fileId,
      fileName: input.fileName.slice(0, DUB.fileNameMaxChars),
      size: input.file.size,
      mime: input.file.type || 'audio/mp4',
      delaySec: old?.delaySec ?? 0,
      addedAt: ctx.now(),
      ...(probe.durationSec ? { durationSec: probe.durationSec } : {}),
      ...(input.videoDurationSec && Number.isFinite(input.videoDurationSec) ? { videoDurationSec: Math.round(input.videoDurationSec * 1000) / 1000 } : old?.videoDurationSec ? { videoDurationSec: old.videoDurationSec } : {}),
      ...(input.title ? { title: input.title.slice(0, DUB.titleMaxChars) } : old?.title ? { title: old.title } : {}),
    };
    saved = rec;
    return { ...index, [input.videoId]: rec };
  });
  if (previous && previous !== fileId) await store.delete(previous).catch(() => undefined);
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
  if (fileId) await audioStore(ctx).delete(fileId);
}

/** 存偏移（秒，正 = 中文推后） */
export async function setDubDelay(ctx: AppContext, videoId: string, delaySec: number): Promise<void> {
  await stores.dubs.update(ctx.kv, ctx.locker, (index) => {
    const rec = index[videoId];
    return rec ? { ...index, [videoId]: { ...rec, delaySec: clampDelay(delaySec) } } : index;
  });
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
