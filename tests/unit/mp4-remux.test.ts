// MP4 的拆封与重新封装（"保存完整双语视频"，DECISIONS §83）：读出原视频的索引、画面轨原样照搬、换上新音轨、排出新文件。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Mp4Error, assembleRemux, buildRemux, parseMovie, pickSource, readMp4Top, trackSeconds, videoCodecLabel, type EncodedAudio, type FileRead, type TextTrackInput } from '../../src/core/mp4-remux';
import { SUB_TIMESCALE, cuesFromSamples, decodeTextSample, encodeTextSample, subtitleSamples, type SubCue } from '../../src/core/subtitle-track';

const SOURCE = new Uint8Array(readFileSync(new URL('../fixtures/dub-source.mp4', import.meta.url)));
const M4A = new Uint8Array(readFileSync(new URL('../fixtures/xyz-tones.m4a', import.meta.url)));
const readOf =
  (b: Uint8Array): FileRead =>
  async (start, end) =>
    b.slice(start, end);

async function open(b: Uint8Array) {
  const top = await readMp4Top(readOf(b), b.length);
  return { top, src: pickSource(parseMovie(top.moov)) };
}

/** 把一条音轨的帧原样取出来，当作"编好的新音轨"（测试里没有编码器） */
function framesOf(b: Uint8Array, t: { count: number; offsets: Float64Array; sizes: Uint32Array }): Uint8Array[] {
  return Array.from({ length: t.count }, (_, i) => b.slice(t.offsets[i]!, t.offsets[i]! + t.sizes[i]!));
}

describe('读出原视频的索引', () => {
  it('测试用的原视频：16 秒，320×180 的 H.264 画面 240 帧，AAC 立体声 44.1 kHz', async () => {
    const { src } = await open(SOURCE);
    expect(src.durationSec).toBeCloseTo(16, 2);
    expect(src.video).toMatchObject({ handler: 'vide', entry: 'avc1', width: 320, height: 180, count: 240 });
    expect(videoCodecLabel(src.video.entry)).toBe('H.264');
    expect(src.audio.audio).toMatchObject({ codec: 'mp4a.40.2', label: 'AAC', sampleRate: 44100, channels: 2 });
    expect(src.audio.audio.description?.length).toBeGreaterThanOrEqual(2);
    expect(trackSeconds(src.movie, src.audio)).toBeCloseTo(16, 1);
    // 每个样本的位置都落在文件里，块把样本一个不落地分完
    expect(src.video.chunks.reduce((n, c) => n + c.samples, 0)).toBe(240);
    for (let i = 0; i < src.video.count; i++) expect(src.video.offsets[i]! + src.video.sizes[i]!).toBeLessThanOrEqual(SOURCE.length);
    // AAC 编码器的起始延迟写在编辑列表里（ffmpeg 的是 1024 个样本）
    expect(src.audio.editStart).toBe(1024);
  });
  it('索引在文件末尾也读得到（只顺着盒子头跳，不读中间的数据）', async () => {
    const { top } = await open(SOURCE);
    // 把 moov 挪到最后：ftyp + mdat… + moov
    const moovAt = SOURCE.findIndex((_, i) => String.fromCharCode(...SOURCE.subarray(i + 4, i + 8)) === 'moov');
    const moved = new Uint8Array([...SOURCE.subarray(0, moovAt), ...SOURCE.subarray(moovAt + top.moov.length), ...top.moov]);
    const reads: number[] = [];
    const tail = await readMp4Top(async (s, e) => (reads.push(e - s), moved.slice(s, e)), moved.length);
    expect(tail.moov).toEqual(top.moov);
    expect(Math.max(...reads)).toBe(top.moov.length);
    expect(reads.filter((n) => n > 4096)).toHaveLength(1);
  });
  it('不是 MP4、没写完、只有声音：说清楚是什么、怎么办', async () => {
    const webm = new Uint8Array(64);
    webm.set([0x1a, 0x45, 0xdf, 0xa3]);
    await expect(readMp4Top(readOf(webm), webm.length)).rejects.toThrow(/WebM \/ MKV/);
    await expect(readMp4Top(readOf(webm), webm.length)).rejects.toMatchObject({ hint: expect.stringContaining('ffmpeg -i') });
    await expect(readMp4Top(readOf(new Uint8Array(64).fill(7)), 64)).rejects.toThrow('不是 MP4');
    await expect(readMp4Top(readOf(new Uint8Array(4)), 4)).rejects.toThrow(/空的|没下载完/);
    // 截掉后半个文件：索引在开头，读得到；但把索引截断就读不到了
    const { top } = await open(SOURCE);
    const cut = SOURCE.slice(0, 40 + Math.floor(top.moov.length / 2));
    await expect(readMp4Top(readOf(cut), cut.length)).rejects.toThrow(/没写完/);
    // m4a（只有声音）：不能当原视频
    const audioOnly = await readMp4Top(readOf(M4A), M4A.length);
    expect(() => pickSource(parseMovie(audioOnly.moov))).toThrow(/没有画面/);
    expect(new Mp4Error('x', 'y')).toMatchObject({ name: 'Mp4Error', hint: 'y' });
  });
});

describe('写出新文件：画面原样照搬，换上新音轨', () => {
  async function remux(audio: Partial<EncodedAudio> = {}) {
    const { top, src } = await open(SOURCE);
    const encoded: EncodedAudio = {
      codec: 'aac',
      sampleRate: 44100,
      channels: 2,
      bitrate: 64000,
      ...(src.audio.audio.description ? { description: src.audio.audio.description } : {}),
      frames: framesOf(SOURCE, src.audio),
      frameSamples: 1024,
      priming: 1024,
      ...audio,
    };
    const plan = buildRemux(top, src, encoded);
    const out = await assembleRemux(plan, readOf(SOURCE));
    return { src, plan, out, encoded, again: await open(out) };
  }
  it('新文件能重新读出来：时长不变，画面的每一帧字节都和原文件一样', async () => {
    const { src, plan, out, again } = await remux();
    expect(out.length).toBe(plan.size);
    expect(again.src.durationSec).toBeCloseTo(src.durationSec, 3);
    expect(again.src.video).toMatchObject({ entry: 'avc1', width: 320, height: 180, count: 240, timescale: src.video.timescale, editStart: src.video.editStart });
    expect(Array.from(again.src.video.dts)).toEqual(Array.from(src.video.dts));
    for (let i = 0; i < src.video.count; i++) {
      const a = SOURCE.subarray(src.video.offsets[i]!, src.video.offsets[i]! + src.video.sizes[i]!);
      const b = out.subarray(again.src.video.offsets[i]!, again.src.video.offsets[i]! + again.src.video.sizes[i]!);
      if (a.length !== b.length || a.some((x, k) => x !== b[k])) throw new Error(`第 ${i} 帧画面和原文件不一样`);
    }
    // 索引在前（打开就能放），数据在后
    expect(String.fromCharCode(...out.subarray(4, 8))).toBe('ftyp');
    expect(String.fromCharCode(...out.subarray(again.top.ftyp.length + 4, again.top.ftyp.length + 8))).toBe('moov');
    // 留着这个文件给本机的 ffprobe 看（CI 上没有就不写）
    if (process.env.TUBEMUSE_KEEP_REMUX) writeFileSync(process.env.TUBEMUSE_KEEP_REMUX, out);
  });
  it('新音轨（AAC）：帧一个不少、字节不变，解码器配置、采样率、起始延迟都写对', async () => {
    const { out, encoded, again } = await remux();
    const a = again.src.audio;
    expect(a.audio).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 44100, channels: 2 });
    expect(Array.from(a.audio.description ?? [])).toEqual(Array.from(encoded.description ?? []));
    expect(a.count).toBe(encoded.frames.length);
    expect(a.editStart).toBe(1024);
    expect(a.timescale).toBe(44100);
    expect(framesOf(out, a).every((f, i) => f.length === encoded.frames[i]!.length && f.every((x, k) => x === encoded.frames[i]![k]))).toBe(true);
    // 只有两条轨：原来的原声轨不带过去
    expect(again.src.movie.tracks.map((t) => t.handler)).toEqual(['vide', 'soun']);
    expect(again.src.movie.nextTrackId).toBeGreaterThan(Math.max(...again.src.movie.tracks.map((t) => t.id)));
  });
  it('画面和声音的块按时间交错着放；原文件里连着的画面并成一段，不逐帧读', async () => {
    const { plan, again } = await remux();
    const v = again.src.video.chunks.map((c) => c.offset);
    const a = again.src.audio.chunks.map((c) => c.offset);
    expect(a.length).toBeGreaterThan(20);
    // 第一块声音之后还有画面，最后一块画面之前已经有声音：不是"画面全在前、声音全在后"
    expect(a[0]!).toBeLessThan(v[v.length - 1]!);
    expect(a[a.length - 1]!).toBeGreaterThan(v[1]!);
    expect(plan.parts.filter((p) => p.kind === 'file').length).toBeLessThanOrEqual(again.src.video.chunks.length);
    expect(plan.parts.reduce((n, p) => n + (p.kind === 'bytes' ? p.bytes.length : p.end - p.start), 0)).toBe(plan.size);
  });
  it('新音轨是 Opus 时：时间单位固定 48000，配置从 OpusHead 换成 dOps（再读出来还是原样）', async () => {
    const head = new Uint8Array([...new TextEncoder().encode('OpusHead'), 1, 2, 0x38, 0x01, 0x44, 0xac, 0, 0, 0, 0, 0]);
    const frames = Array.from({ length: 800 }, (_, i) => new Uint8Array(40 + (i % 7)).fill(i & 0xff));
    const { again } = await remux({ codec: 'opus', sampleRate: 44100, description: head, frames, frameSamples: 960, priming: 0 });
    const a = again.src.audio;
    expect(a.audio).toMatchObject({ codec: 'opus', sampleRate: 48000, channels: 2 });
    expect(Array.from(a.audio.description ?? [])).toEqual(Array.from(head));
    expect(a).toMatchObject({ entry: 'Opus', timescale: 48000, count: 800, editStart: 0 });
    expect(a.mediaDuration).toBe(800 * 960);
  });
  it('没有帧的新音轨：不写文件', async () => {
    const { top, src } = await open(SOURCE);
    expect(() => buildRemux(top, src, { codec: 'aac', sampleRate: 44100, channels: 2, bitrate: 64000, frames: [], frameSamples: 1024, priming: 0 })).toThrow(/空的/);
  });
});

describe('写出新文件：带上一条字幕轨（DECISIONS §84）', () => {
  const CUES: SubCue[] = [
    { start: 0.5, end: 3, text: 'So in college,' },
    { start: 3.1, end: 6, text: 'I was a government major,' },
    { start: 6.2, end: 10, text: 'which means I had to write\na lot of papers. 中文也行' },
    { start: 14, end: 15.5, text: 'Thank you.' },
  ];
  async function withText(cues: SubCue[] = CUES) {
    const { top, src } = await open(SOURCE);
    const audio: EncodedAudio = { codec: 'aac', sampleRate: 44100, channels: 2, bitrate: 64000, ...(src.audio.audio.description ? { description: src.audio.audio.description } : {}), frames: framesOf(SOURCE, src.audio), frameSamples: 1024, priming: 1024 };
    const text: TextTrackInput = { samples: subtitleSamples(cues, src.durationSec).map((x) => ({ duration: x.duration, bytes: encodeTextSample(x.text) })), timescale: SUB_TIMESCALE, language: 'eng', name: 'English' };
    const plan = buildRemux(top, src, audio, text);
    const out = await assembleRemux(plan, readOf(SOURCE));
    return { src, out, plain: await assembleRemux(buildRemux(top, src, audio), readOf(SOURCE)), again: await open(out) };
  }
  /** 把新文件里字幕轨的样本读回来 */
  function readBack(out: Uint8Array, t: { count: number; offsets: Float64Array; sizes: Uint32Array; dts: Float64Array; timescale: number; mediaDuration: number }) {
    return Array.from({ length: t.count }, (_, i) => ({
      start: t.dts[i]! / t.timescale,
      end: (i + 1 < t.count ? t.dts[i + 1]! : t.mediaDuration) / t.timescale,
      text: decodeTextSample(out.subarray(t.offsets[i]!, t.offsets[i]! + t.sizes[i]!)),
    }));
  }
  it('新文件多一条字幕轨：tx3g、英文、毫秒为单位、铺满全片；读回来每一句的文字和时间都对', async () => {
    const { out, again } = await withText();
    expect(again.src.movie.tracks.map((t) => t.handler)).toEqual(['vide', 'soun', 'sbtl']);
    const sub = again.src.subtitles[0]!;
    expect(sub).toMatchObject({ handler: 'sbtl', entry: 'tx3g', language: 'eng', timescale: 1000, mediaDuration: 16000 });
    expect(trackSeconds(again.src.movie, sub)).toBeCloseTo(16, 2);
    expect(cuesFromSamples(readBack(out, sub))).toEqual(CUES);
    // 句子之间、开头、结尾的空档是空样本：一共 4 句 + 5 段空档
    expect(sub.count).toBe(9);
    // 留着给本机的 ffprobe / ffmpeg 看
    if (process.env.TUBEMUSE_KEEP_REMUX_SUBS) writeFileSync(process.env.TUBEMUSE_KEEP_REMUX_SUBS, out);
  });
  it('画面和声音不受影响：和不带字幕时一样，每一帧画面仍和原文件逐字节相同', async () => {
    const { src, out, plain, again } = await withText();
    const noSub = await open(plain);
    expect(again.src.video.count).toBe(240);
    expect(again.src.audio.count).toBe(noSub.src.audio.count);
    expect(noSub.src.subtitles).toEqual([]);
    for (let i = 0; i < src.video.count; i++) {
      const a = SOURCE.subarray(src.video.offsets[i]!, src.video.offsets[i]! + src.video.sizes[i]!);
      const b = out.subarray(again.src.video.offsets[i]!, again.src.video.offsets[i]! + again.src.video.sizes[i]!);
      if (a.length !== b.length || a.some((x, k) => x !== b[k])) throw new Error(`第 ${i} 帧画面和原文件不一样`);
    }
    expect(again.src.movie.nextTrackId).toBeGreaterThan(Math.max(...again.src.movie.tracks.map((t) => t.id)));
  });
  it('句子很多时分成好几块，和画面、声音按时间交错；没有字幕（空列表）就不写这条轨', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ start: i * 0.25, end: i * 0.25 + 0.2, text: `line ${i}` }));
    const { out, again } = await withText(many);
    const sub = again.src.subtitles[0]!;
    expect(sub.chunks.length).toBeGreaterThan(3);
    expect(cuesFromSamples(readBack(out, sub)).map((c) => c.text)).toEqual(many.map((c) => c.text));
    expect(sub.chunks[sub.chunks.length - 1]!.offset).toBeGreaterThan(again.src.video.chunks[1]!.offset);
    const none = await withText([]);
    // 没有一句字幕时样本只有一个空的：仍是一条合法的轨，但调用方不会传空的进来（见 services/dub-export.ts）
    expect(none.again.src.movie.tracks.length).toBe(3);
  });
  it('原视频文件里嵌着的字幕轨认得出来（章节轨、别的文字轨不算）', async () => {
    const { out } = await withText();
    const again = await open(out);
    expect(again.src.subtitles).toHaveLength(1);
    expect(again.src.subtitles[0]!.language).toBe('eng');
    const { src } = await open(SOURCE);
    expect(src.subtitles).toEqual([]);
    expect(src.video.language).toBe('und');
  });
});

describe('配音文件（m4a）也用同一套读法', () => {
  it('读出音轨：AAC、帧表、时长', async () => {
    const top = await readMp4Top(readOf(M4A), M4A.length);
    const movie = parseMovie(top.moov);
    const a = movie.tracks.find((t) => t.handler === 'soun')!;
    expect(a.audio?.codec).toBe('mp4a.40.2');
    expect(trackSeconds(movie, a)).toBeGreaterThan(91);
    expect(a.count).toBeGreaterThan(1000);
    expect(existsSync(new URL('../fixtures/xyz-tones.m4a', import.meta.url))).toBe(true);
  });
});
