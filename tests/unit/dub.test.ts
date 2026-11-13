// 中文配音（DECISIONS §73）：文件检查、跟随判定、原声降音量、说法、关联 / 换 / 移除、IndexedDB 里的音频交给页面、导出与清空。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DUB } from '../../src/config/defaults';
import { ENDPOINTS } from '../../src/config/endpoints';
import { base64ToBytes } from '../../src/core/clips';
import {
  DubFileError,
  VolumeDuck,
  checkDubFile,
  clampDelay,
  cleanVideoTitle,
  delayText,
  dubReasonText,
  dubStep,
  durationNote,
  formatClockSec,
  isDubPortRequest,
  probeM4a,
  sanitizeDubIndex,
  type DubAudioSample,
  type DubPortReply,
  type DubVideoSample,
} from '../../src/core/dub';
import type { AuthProvider } from '../../src/services/auth';
import type { AppContext } from '../../src/services/context';
import { clearAll, exportAll } from '../../src/services/data-service';
import { attachDub, blobReader, checkDubStorage, removeDub, setDubDelay, streamDubAudio } from '../../src/services/dub-service';
import { memoryDubStore } from '../../src/services/dub-store';
import { stores } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';

const M4A = new Uint8Array(readFileSync(new URL('../fixtures/xyz-tones.m4a', import.meta.url)));
const MP3 = new Uint8Array(readFileSync(new URL('../fixtures/xyz-tones-vbr.mp3', import.meta.url)));
const NOW = Date.parse('2026-11-13T02:00:00Z');
const VID = 'ys6YQ2yfBpM';

const read = (buf: Uint8Array) => async (s: number, e: number) => buf.slice(s, Math.min(buf.length, e));

function setup() {
  const kv = memoryKV();
  const dubAudio = memoryDubStore();
  const auth = { disconnect: async () => ({ revoked: false }) } as unknown as AuthProvider;
  const blocked = (() => {
    throw new Error('配音不该发网络请求');
  }) as unknown as typeof fetch;
  const ctx: AppContext = { kv, locker: memoryLocker(), http: blocked, now: () => NOW, auth, endpoints: ENDPOINTS, timeZone: 'Asia/Shanghai', dubAudio };
  return { ctx, kv, dubAudio };
}

const m4aBlob = (bytes: Uint8Array = M4A, type = 'audio/x-m4a') => new Blob([bytes as BlobPart], { type });

describe('中文配音：文件检查', () => {
  it('只收 .m4a：扩展名或类型对得上才行，空文件和超大的说清楚', () => {
    expect(() => checkDubFile('817.m4a', '', 10)).not.toThrow();
    expect(() => checkDubFile('dub', 'audio/mp4', 10)).not.toThrow();
    expect(() => checkDubFile('817.mp3', 'audio/mpeg', 10)).toThrow(/不是 \.m4a/);
    expect(() => checkDubFile('817.m4a', 'audio/mp4', 0)).toThrow(/空文件/);
    expect(() => checkDubFile('817.m4a', 'audio/mp4', DUB.maxFileBytes + 1)).toThrow(/太大/);
  });

  it('读出 m4a 的时长、认出有声音轨', async () => {
    const p = await probeM4a(read(M4A), M4A.length);
    expect(p.hasAudio).toBe(true);
    expect(p.hasVideo).toBe(false);
    expect(p.durationSec).toBeGreaterThan(91);
    expect(p.durationSec).toBeLessThan(93);
  });

  it('moov 在文件末尾也找得到（只读盒子头和 moov 本身）', async () => {
    const ftypSize = (M4A[0]! << 24) | (M4A[1]! << 16) | (M4A[2]! << 8) | M4A[3]!;
    const moovSize = (M4A[ftypSize]! << 24) | (M4A[ftypSize + 1]! << 16) | (M4A[ftypSize + 2]! << 8) | M4A[ftypSize + 3]!;
    const moved = new Uint8Array(M4A.length);
    moved.set(M4A.subarray(0, ftypSize));
    moved.set(M4A.subarray(ftypSize + moovSize), ftypSize);
    moved.set(M4A.subarray(ftypSize, ftypSize + moovSize), M4A.length - moovSize);
    let bytesRead = 0;
    const p = await probeM4a(async (s, e) => {
      const b = await read(moved)(s, e);
      bytesRead += b.length;
      return b;
    }, moved.length);
    expect(p.durationSec).toBeGreaterThan(91);
    expect(bytesRead).toBeLessThan(moved.length);
  });

  it('不是 m4a（改了扩展名的 mp3）、没写完的文件：说明原因，不收', async () => {
    await expect(probeM4a(read(MP3), MP3.length)).rejects.toThrow(/不是 m4a/);
    const cut = M4A.slice(0, 600);
    await expect(probeM4a(read(cut), cut.length)).rejects.toBeInstanceOf(DubFileError);
  });
});

const video = (over: Partial<DubVideoSample> = {}): DubVideoSample => ({ currentTime: 100, paused: false, ended: false, seeking: false, canPlay: true, rate: 1, ad: false, ...over });
const audio = (over: Partial<DubAudioSample> = {}): DubAudioSample => ({ currentTime: 100, paused: false, duration: 3842, rate: 1, ...over });

describe('中文配音：跟随', () => {
  it('视频在放、位置对得上：继续放，不跳', () => {
    expect(dubStep(video(), audio(), 0)).toEqual({ play: true, reason: 'playing', target: 100 });
    expect(dubStep(video(), audio({ currentTime: 100.2 }), 0).seekTo).toBeUndefined();
  });

  it('拖动进度后差得多：把配音拉到视频位置 − 偏移', () => {
    expect(dubStep(video({ currentTime: 1800 }), audio({ currentTime: 100 }), 2.5)).toMatchObject({ play: true, seekTo: 1797.5 });
    // 偏移为负（中文提前）：配音在视频前面
    expect(dubStep(video({ currentTime: 60 }), audio({ currentTime: 0 }), -3)).toMatchObject({ play: true, seekTo: 63 });
  });

  it('视频暂停 / 跳转中 / 缓冲 / 广告 / 放完：配音停；暂停时也把位置对好', () => {
    expect(dubStep(video({ paused: true }), audio({ currentTime: 50 }), 0)).toMatchObject({ play: false, reason: 'paused', seekTo: 100 });
    expect(dubStep(video({ paused: true }), audio(), 0)).toEqual({ play: false, reason: 'paused', target: 100 });
    expect(dubStep(video({ seeking: true }), audio(), 0)).toMatchObject({ play: false, reason: 'seeking' });
    expect(dubStep(video({ canPlay: false }), audio(), 0)).toMatchObject({ play: false, reason: 'buffering' });
    expect(dubStep(video({ ad: true, currentTime: 5 }), audio(), 0)).toEqual({ play: false, reason: 'ad', target: 5 });
    expect(dubStep(video({ ended: true }), audio(), 0)).toMatchObject({ play: false, reason: 'ended' });
  });

  it('中文推后时，视频还没放到偏移处：配音停在开头等着', () => {
    expect(dubStep(video({ currentTime: 1 }), audio({ currentTime: 30 }), 2)).toEqual({ play: false, reason: 'before-start', target: -1, seekTo: 0 });
    expect(dubStep(video({ currentTime: 1 }), audio({ currentTime: 0 }), 2)).toEqual({ play: false, reason: 'before-start', target: -1 });
    expect(dubReasonText('before-start', 2)).toContain('视频放到 0:02 时中文才开始');
  });

  it('原视频比中文长：中文放完就停', () => {
    expect(dubStep(video({ currentTime: 3850 }), audio({ duration: 3842 }), 0)).toMatchObject({ play: false, reason: 'after-end' });
    // 时长还不知道（NaN）时照常跟随
    expect(dubStep(video({ currentTime: 3850 }), audio({ duration: NaN, currentTime: 3850 }), 0)).toMatchObject({ play: true });
  });

  it('倍速跟着视频；从暂停开始放时先对准（差 0.08 秒以上就跳）', () => {
    expect(dubStep(video({ rate: 1.5 }), audio(), 0).rate).toBe(1.5);
    expect(dubStep(video(), audio({ paused: true, currentTime: 99.85 }), 0).seekTo).toBe(100);
    expect(dubStep(video(), audio({ paused: true, currentTime: 99.95 }), 0).seekTo).toBeUndefined();
  });
});

describe('中文配音：原声降 20%', () => {
  it('开启时降到你的音量的 80%，关闭时恢复', () => {
    const d = new VolumeDuck(0.8);
    d.sync(0.5, 0);
    expect(d.target(false)).toBeUndefined();
    const t = d.target(true)!;
    expect(t).toBeCloseTo(0.4);
    d.wrote(t);
    expect(d.ducked).toBe(true);
    d.sync(0.4, 10); // 我们自己写的，不算你改的
    expect(d.target(true)).toBeUndefined();
    expect(d.userVolume).toBe(0.5);
    const back = d.target(false)!;
    expect(back).toBe(0.5);
    d.wrote(back);
    expect(d.ducked).toBe(false);
  });

  it('降着的时候你在 YouTube 上把音量调到 1：按新的音量再降', () => {
    const d = new VolumeDuck(0.8);
    d.sync(0.5, 0);
    d.wrote(d.target(true)!);
    d.sync(1, 100);
    expect(d.userVolume).toBe(1);
    expect(d.target(true)).toBeCloseTo(0.8);
  });

  it('YouTube 一再把音量改回原值：停手（不来回抢），关闭后不再动它；重新开始时再试', () => {
    const d = new VolumeDuck(0.8);
    d.sync(0.6, 0);
    for (let i = 0; i < DUB.maxVolumeReverts; i++) {
      const t = d.target(true);
      if (t !== undefined) d.wrote(t);
      d.sync(0.6, i * 100);
    }
    expect(d.blocked).toBe(true);
    expect(d.target(true)).toBeUndefined();
    expect(d.target(false)).toBeUndefined();
    d.reset();
    d.sync(0.6, 10_000);
    expect(d.target(true)).toBeCloseTo(0.48);
  });

  it('偶尔被改回一次（换视频、广告结束）不算抢', () => {
    const d = new VolumeDuck(0.8);
    d.sync(0.6, 0);
    d.wrote(d.target(true)!);
    d.sync(0.6, 100);
    expect(d.blocked).toBe(false);
    expect(d.target(true)).toBeCloseTo(0.48);
  });
});

describe('中文配音：说法', () => {
  it('例子：中文 1:04:02、原视频 1:03:49 → 中文长 13 秒，并说明只对齐开头', () => {
    const n = durationNote(3842, 3829)!;
    expect(n).toContain('中文 1:04:02 · 原视频 1:03:49');
    expect(n).toContain('中文长 13 秒');
    expect(n).toContain('越往后可能差得越多');
    expect(n).not.toMatch(/逐句|逐词/);
    expect(durationNote(100, 100.2)).toContain('长度一样');
    expect(durationNote(undefined, 100)).toBeUndefined();
  });

  it('偏移：正 = 中文推后，负 = 中文提前；按 0.1 秒取整、限制范围', () => {
    expect(delayText(2.5)).toContain('中文推后 2.5 秒');
    expect(delayText(-1.2)).toContain('中文提前 1.2 秒');
    expect(delayText(0)).toContain('不偏移');
    expect(clampDelay(0.1 + 0.2)).toBe(0.3);
    expect(clampDelay(-0.04)).toBe(0);
    expect(Object.is(clampDelay(-0.04), -0)).toBe(false);
    expect(clampDelay(99999)).toBe(DUB.maxDelaySec);
    expect(clampDelay('x')).toBe(0);
    expect(formatClockSec(3829)).toBe('1:03:49');
    expect(formatClockSec(42)).toBe('0:42');
  });

  it('页面标题去掉" - YouTube"和未读数', () => {
    expect(cleanVideoTitle('(3) How Claude Code works - Lance Martin - YouTube')).toBe('How Claude Code works - Lance Martin');
  });
});

describe('中文配音：关联、换文件、移除', () => {
  it('关联：音频进 IndexedDB，对应关系与时长进本机存储；偏移存下并取整', async () => {
    const { ctx, dubAudio } = setup();
    const rec = await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: '#817.m4a', title: 'Lance Martin', videoDurationSec: 3829 });
    expect(rec).toMatchObject({ videoId: VID, fileName: '#817.m4a', size: M4A.length, delaySec: 0, addedAt: NOW, videoDurationSec: 3829, title: 'Lance Martin' });
    expect(rec.durationSec).toBeGreaterThan(91);
    expect(dubAudio.data.get(rec.fileId)?.size).toBe(M4A.length);
    // 对应关系里只有元数据，没有音频
    const stored = JSON.stringify(await ctx.kv.getAll());
    expect(stored.length).toBeLessThan(2000);
    await setDubDelay(ctx, VID, 2.34);
    expect((await stores.dubs.read(ctx.kv))[VID]?.delaySec).toBe(2.3);
  });

  it('同一个视频换文件：偏移保留，旧音频删掉', async () => {
    const { ctx, dubAudio } = setup();
    const first = await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a' });
    await setDubDelay(ctx, VID, -1.5);
    const second = await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'b.m4a' });
    expect(second.fileId).not.toBe(first.fileId);
    expect(second.delaySec).toBe(-1.5);
    expect([...dubAudio.data.keys()]).toEqual([second.fileId]);
  });

  it('不是 m4a 的文件不存', async () => {
    const { ctx, dubAudio } = setup();
    await expect(attachDub(ctx, { videoId: VID, file: new Blob([MP3 as BlobPart], { type: 'audio/mpeg' }), fileName: 'x.m4a' })).rejects.toThrow(/不是 m4a/);
    expect(dubAudio.data.size).toBe(0);
    expect(await stores.dubs.read(ctx.kv)).toEqual({});
  });

  it('移除：对应关系和音频都删掉', async () => {
    const { ctx, dubAudio } = setup();
    await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a' });
    await removeDub(ctx, VID);
    expect(await stores.dubs.read(ctx.kv)).toEqual({});
    expect(dubAudio.data.size).toBe(0);
  });

  it('核对存储：没人用的音频删掉，音频不见了的列出来', async () => {
    const { ctx, dubAudio } = setup();
    const rec = await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a' });
    await dubAudio.put('dub_orphan123', m4aBlob());
    expect(await checkDubStorage(ctx)).toEqual({ missing: [], removedOrphans: 1 });
    await dubAudio.delete(rec.fileId);
    expect(await checkDubStorage(ctx)).toEqual({ missing: [VID], removedOrphans: 0 });
  });

  it('读存储时丢弃坏掉的记录', () => {
    const good = { videoId: VID, fileId: 'dub_abc123', fileName: 'a.m4a', size: 10, mime: 'audio/mp4', delaySec: 1.23, addedAt: 1 };
    const idx = sanitizeDubIndex({ [VID]: good, bad: { ...good, videoId: 'bad' }, abcdefgh: { ...good, videoId: 'abcdefgh', fileId: '../x' }, zzzzzzzz: 5 });
    expect(Object.keys(idx)).toEqual([VID]);
    expect(idx[VID]?.delaySec).toBe(1.2);
  });
});

describe('中文配音：把音频交给 YouTube 页面里的脚本', () => {
  it('分块读出、base64 传过去，拼起来和原文件一模一样', async () => {
    const { ctx } = setup();
    // 小块：确认分块与拼接
    const big = new Uint8Array(DUB.chunkBytes * 2 + 12345).map((_, i) => (i * 31) & 0xff);
    big.set(M4A.subarray(0, 4096));
    const rec = await attachDub(ctx, { videoId: VID, file: new Blob([M4A as BlobPart, big as BlobPart], { type: 'audio/mp4' }), fileName: 'big.m4a' });
    const got: DubPortReply[] = [];
    await streamDubAudio(ctx, { type: 'open', videoId: VID, fileId: rec.fileId }, (m) => (got.push(m), true));
    expect(got[0]).toEqual({ type: 'meta', size: rec.size, mime: 'audio/mp4' });
    expect(got.at(-1)).toEqual({ type: 'done' });
    const chunks = got.filter((m): m is Extract<DubPortReply, { type: 'chunk' }> => m.type === 'chunk').map((m) => base64ToBytes(m.data));
    expect(chunks.length).toBe(Math.ceil(rec.size / DUB.chunkBytes));
    const joined = new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
    const original = new Uint8Array(await blobReader(new Blob([M4A as BlobPart, big as BlobPart]))(0, rec.size));
    expect(joined.length).toBe(rec.size);
    expect(Buffer.compare(Buffer.from(joined), Buffer.from(original))).toBe(0);
  });

  it('对不上的请求（文件换了、移除了、格式不对）不给音频；那边断开就停', async () => {
    const { ctx, dubAudio } = setup();
    const rec = await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a' });
    const one = async (req: unknown) => {
      const got: DubPortReply[] = [];
      await streamDubAudio(ctx, req, (m) => (got.push(m), true));
      return got;
    };
    expect(await one({ type: 'open', videoId: VID, fileId: 'dub_other123' })).toEqual([{ type: 'error', message: '这个视频的配音已经移除或换了文件', hint: '在侧边栏「配音」页重新开启。' }]);
    expect((await one({ type: 'open', videoId: VID, fileId: '../../etc' }))[0]).toMatchObject({ type: 'error' });
    expect(isDubPortRequest({ type: 'open', videoId: VID, fileId: rec.fileId })).toBe(true);
    await dubAudio.delete(rec.fileId);
    expect((await one({ type: 'open', videoId: VID, fileId: rec.fileId }))[0]).toMatchObject({ type: 'error', message: '本机找不到这个配音文件' });
    await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a' });
    const again = (await stores.dubs.read(ctx.kv))[VID]!;
    let posts = 0;
    await streamDubAudio(ctx, { type: 'open', videoId: VID, fileId: again.fileId }, () => (++posts, false));
    expect(posts).toBe(1);
  });
});

describe('中文配音：导出与清空', () => {
  it('导出只有对应关系与偏移，不含音频；清空时连 IndexedDB 里的音频一起删', async () => {
    const { ctx, dubAudio } = setup();
    await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: '#817.m4a' });
    const file = await exportAll(ctx);
    expect(file.data.dubs).toBeDefined();
    expect(file.note).toContain('不含音频文件本身');
    expect(JSON.stringify(file).length).toBeLessThan(5000);
    await clearAll(ctx);
    expect(await ctx.kv.getAll()).toEqual({});
    expect(dubAudio.data.size).toBe(0);
  });
});
