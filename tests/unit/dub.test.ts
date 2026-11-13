// 中文配音（DECISIONS §74）：文件检查、跟随判定、原声降音量、说法、关联 / 换 / 移除、IndexedDB 里的音频交给页面、导出与清空。
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
  dubSegmentAt,
  dubStep,
  durationNote,
  misorderedAnchors,
  sanitizeAnchors,
  segmentOffsetText,
  withAnchor,
  withSegmentOffset,
  formatClockSec,
  isDubPortRequest,
  probeM4a,
  sanitizeDubIndex,
  type DubAnchor,
  type DubAudioSample,
  type DubMap,
  type DubPortReply,
  type DubVideoSample,
} from '../../src/core/dub';
import type { AuthProvider } from '../../src/services/auth';
import type { AppContext } from '../../src/services/context';
import { clearAll, exportAll } from '../../src/services/data-service';
import { addDubAnchor, attachDub, blobReader, checkDubStorage, removeDub, removeDubAnchor, setDubDelay, setDubSegmentOffset, streamDubAudio } from '../../src/services/dub-service';
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
const m = (delaySec: number, anchors: DubAnchor[] = []): DubMap => ({ delaySec, anchors });

describe('中文配音：跟随', () => {
  it('视频在放、位置对得上：继续放，不跳', () => {
    expect(dubStep(video(), audio(), m(0))).toMatchObject({ play: true, reason: 'playing', target: 100 });
    expect(dubStep(video(), audio({ currentTime: 100.2 }), m(0)).seekTo).toBeUndefined();
  });

  it('拖动进度后差得多：把配音拉到视频位置 − 偏移', () => {
    expect(dubStep(video({ currentTime: 1800 }), audio({ currentTime: 100 }), m(2.5))).toMatchObject({ play: true, seekTo: 1797.5 });
    // 偏移为负（中文提前）：配音在视频前面
    expect(dubStep(video({ currentTime: 60 }), audio({ currentTime: 0 }), m(-3))).toMatchObject({ play: true, seekTo: 63 });
  });

  it('视频暂停 / 跳转中 / 缓冲 / 广告 / 放完：配音停；暂停时也把位置对好', () => {
    expect(dubStep(video({ paused: true }), audio({ currentTime: 50 }), m(0))).toMatchObject({ play: false, reason: 'paused', seekTo: 100 });
    expect(dubStep(video({ paused: true }), audio(), m(0))).toMatchObject({ play: false, reason: 'paused', target: 100 });
    expect(dubStep(video({ paused: true }), audio(), m(0)).seekTo).toBeUndefined();
    expect(dubStep(video({ seeking: true }), audio(), m(0))).toMatchObject({ play: false, reason: 'seeking' });
    expect(dubStep(video({ canPlay: false }), audio(), m(0))).toMatchObject({ play: false, reason: 'buffering' });
    expect(dubStep(video({ ad: true, currentTime: 5 }), audio(), m(0))).toMatchObject({ play: false, reason: 'ad', target: 5 });
    expect(dubStep(video({ ended: true }), audio(), m(0))).toMatchObject({ play: false, reason: 'ended' });
  });

  it('中文推后时，视频还没放到偏移处：配音停在开头等着', () => {
    expect(dubStep(video({ currentTime: 1 }), audio({ currentTime: 30 }), m(2))).toMatchObject({ play: false, reason: 'before-start', target: -1, seekTo: 0 });
    expect(dubStep(video({ currentTime: 1 }), audio({ currentTime: 0 }), m(2))).toMatchObject({ play: false, reason: 'before-start', target: -1, wakeIn: 1 });
    expect(dubStep(video({ currentTime: 1 }), audio({ currentTime: 0 }), m(2)).seekTo).toBeUndefined();
    expect(dubReasonText('before-start', { offset: 2 })).toContain('视频放到 0:02 时中文才开始');
  });

  it('原视频比中文长：中文放完就停', () => {
    expect(dubStep(video({ currentTime: 3850 }), audio({ duration: 3842 }), m(0))).toMatchObject({ play: false, reason: 'after-end' });
    // 时长还不知道（NaN）时照常跟随
    expect(dubStep(video({ currentTime: 3850 }), audio({ duration: NaN, currentTime: 3850 }), m(0))).toMatchObject({ play: true });
  });

  it('倍速跟着视频；从暂停开始放时先对准（差 0.08 秒以上就跳）', () => {
    expect(dubStep(video({ rate: 1.5 }), audio(), m(0)).rate).toBe(1.5);
    expect(dubStep(video(), audio({ paused: true, currentTime: 99.85 }), m(0)).seekTo).toBe(100);
    expect(dubStep(video(), audio({ paused: true, currentTime: 99.95 }), m(0)).seekTo).toBeUndefined();
  });
});

describe('中文配音：对齐点（分段跟随，DECISIONS §75）', () => {
  // 手测的例子：原视频 1:01:43（3703 秒），中文 46:02（2762 秒）；开头中文推后 3 秒，
  // 视频 12:30 ↔ 中文 9:25，视频 30:00 ↔ 中文 22:40
  const anchors: DubAnchor[] = [
    { video: 750, dub: 565 },
    { video: 1800, dub: 1360 },
  ];
  const map = m(3, anchors);

  it('找出视频此刻落在哪一段：开头那段用开头的偏移，对齐点之后用"视频位置 − 中文位置"', () => {
    expect(dubSegmentAt(map, 100)).toEqual({ index: -1, fromVideo: 0, offset: 3, nextVideo: 750, dubEnd: 565 });
    expect(dubSegmentAt(map, 750)).toEqual({ index: 0, fromVideo: 750, offset: 185, nextVideo: 1800, dubEnd: 1360 });
    expect(dubSegmentAt(map, 3000)).toEqual({ index: 1, fromVideo: 1800, offset: 440 });
    expect(dubSegmentAt(m(3), 3000)).toEqual({ index: -1, fromVideo: 0, offset: 3 });
  });

  it('对齐点之后按这一段的偏移跟随：拖到 20:00 → 中文 20:00 − 185 秒', () => {
    expect(dubStep(video({ currentTime: 1200 }), audio({ currentTime: 0 }), map)).toMatchObject({ play: true, seekTo: 1015, segment: { index: 0 } });
    expect(dubStep(video({ currentTime: 2000 }), audio({ currentTime: 1560 }), map)).toMatchObject({ play: true, target: 1560, segment: { index: 1 } });
  });

  it('中文这一段先说完：停在这一段的末尾等画面，到下一个对齐点再接着放', () => {
    // 开头那段中文到 565 秒为止；视频 600 秒时按偏移该放 597 秒——已经越过，停在 565 等
    const hold = dubStep(video({ currentTime: 600 }), audio({ currentTime: 568 }), map);
    expect(hold).toMatchObject({ play: false, reason: 'segment-end', seekTo: 565, wakeIn: 150 });
    expect(dubReasonText('segment-end', hold.segment)).toContain('等画面到 12:30 的对齐点再接着放');
    // 停着、位置也对：不再跳
    expect(dubStep(video({ currentTime: 700 }), audio({ currentTime: 565, paused: true }), map).seekTo).toBeUndefined();
    // 视频到了 12:30：从 565 接着放，不用跳
    const resume = dubStep(video({ currentTime: 750.05 }), audio({ currentTime: 565, paused: true }), map);
    expect(resume).toMatchObject({ play: true, reason: 'playing' });
    expect(resume.seekTo).toBeUndefined();
  });

  it('中文这一段说得慢、视频先到了下一个对齐点：跳到下一段的位置', () => {
    // 第一段中文（565 → 1360）还在 1200 秒处，视频已经到 30:00：跳到 1360
    expect(dubStep(video({ currentTime: 1800.1 }), audio({ currentTime: 1200 }), map)).toMatchObject({ play: true, seekTo: 1360.1, segment: { index: 1 } });
  });

  it('放着的时候算好"再过多久要换做法"（这一段中文说完、或到下一个对齐点），到点立刻处理', () => {
    expect(dubStep(video({ currentTime: 560 }), audio({ currentTime: 557 }), map).wakeIn).toBeCloseTo(8); // 中文 557 → 565
    expect(dubStep(video({ currentTime: 1795 }), audio({ currentTime: 1300 }), map).wakeIn).toBeCloseTo(5); // 视频 → 1800
    expect(dubStep(video({ currentTime: 3000 }), audio({ currentTime: 2560 }), map).wakeIn).toBeUndefined();
  });

  it('加对齐点：按视频时间排好，离已有的不到 1 秒就替换它；读存储时丢掉坏的', () => {
    const a = withAnchor(anchors, { video: 1200.123, dub: 900.456 });
    expect(a.map((x) => x.video)).toEqual([750, 1200.12, 1800]);
    expect(a[1]).toEqual({ video: 1200.12, dub: 900.46 });
    expect(withAnchor(a, { video: 1200.5, dub: 905 }).filter((x) => x.video > 1199 && x.video < 1201)).toEqual([{ video: 1200.5, dub: 905 }]);
    expect(withAnchor([], { video: 10, dub: -3 })).toEqual([{ video: 10, dub: 0 }]);
    expect(sanitizeAnchors([{ video: 1800, dub: 1360 }, { video: 750, dub: 565 }, { video: 'x', dub: 1 }, { video: -1, dub: 1 }, null])).toEqual(anchors);
    expect(sanitizeAnchors('nope')).toEqual([]);
  });

  it('改某一段的偏移：开头那段改 delaySec，对齐点那段只改它的中文位置（视频位置不动）', () => {
    expect(withSegmentOffset(map, -1, 4.04)).toEqual({ delaySec: 4, anchors });
    expect(withSegmentOffset(map, 0, 200).anchors[0]).toEqual({ video: 750, dub: 550 });
    expect(withSegmentOffset(map, 1, 2000).anchors[1]).toEqual({ video: 1800, dub: 0 });
    expect(segmentOffsetText({ index: 0, offset: 185 })).toBe('这一段中文比画面晚 3 分 05 秒');
    expect(segmentOffsetText({ index: 0, offset: -2 })).toBe('这一段中文比画面早 2 秒');
    expect(segmentOffsetText({ index: -1, offset: 3 })).toContain('中文推后 3 秒');
  });

  it('前后颠倒的对齐点（中文位置不比前一个靠后）标出来', () => {
    expect(misorderedAnchors(map)).toEqual([]);
    expect(misorderedAnchors(m(0, [{ video: 100, dub: 90 }, { video: 200, dub: 80 }]))).toEqual([1]);
    // 开头中文提前 10 秒：视频 0 秒时已经放到中文 10 秒，第一个对齐点的中文位置要在它后面
    expect(misorderedAnchors(m(-10, [{ video: 100, dub: 5 }]))).toEqual([0]);
  });

  it('前后颠倒时也有确定的行为：前一段整段停着等（不会乱跳）', () => {
    const bad = m(0, [{ video: 100, dub: 90 }, { video: 200, dub: 80 }]);
    expect(dubStep(video({ currentTime: 150 }), audio({ currentTime: 95 }), bad)).toMatchObject({ play: false, reason: 'segment-end', seekTo: 80 });
  });

  it('存下、删除对齐点，改某一段的偏移；最多 200 个', async () => {
    const { ctx } = setup();
    await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a' });
    await setDubDelay(ctx, VID, 3);
    await addDubAnchor(ctx, VID, { video: 1800, dub: 1360 });
    const rec = await addDubAnchor(ctx, VID, { video: 750, dub: 565 });
    expect(rec?.anchors).toEqual(anchors);
    await setDubSegmentOffset(ctx, VID, 0, 200);
    await setDubSegmentOffset(ctx, VID, -1, 2.5);
    let stored = (await stores.dubs.read(ctx.kv))[VID]!;
    expect(stored).toMatchObject({ delaySec: 2.5, anchors: [{ video: 750, dub: 550 }, { video: 1800, dub: 1360 }] });
    await removeDubAnchor(ctx, VID, 0);
    stored = (await stores.dubs.read(ctx.kv))[VID]!;
    expect(stored.anchors).toEqual([{ video: 1800, dub: 1360 }]);
    await removeDubAnchor(ctx, VID, 0);
    expect((await stores.dubs.read(ctx.kv))[VID]!.anchors).toBeUndefined();
    // 段号对不上（例如对齐点刚被删掉）：不改
    await setDubSegmentOffset(ctx, VID, 3, 100);
    expect((await stores.dubs.read(ctx.kv))[VID]!.delaySec).toBe(2.5);
    for (let i = 1; i <= DUB.maxAnchors; i++) await addDubAnchor(ctx, VID, { video: i * 2, dub: i });
    await expect(addDubAnchor(ctx, VID, { video: 9999, dub: 9000 })).rejects.toThrow(/已经有 200 个/);
  });

  it('换文件时偏移和对齐点都保留', async () => {
    const { ctx } = setup();
    await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'a.m4a' });
    await addDubAnchor(ctx, VID, { video: 750, dub: 565 });
    const again = await attachDub(ctx, { videoId: VID, file: m4aBlob(), fileName: 'b.m4a' });
    expect(again.anchors).toEqual([{ video: 750, dub: 565 }]);
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
    expect(n).toContain('越往后差得越多');
    expect(n).toContain('加对齐点');
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
