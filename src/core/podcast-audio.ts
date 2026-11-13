// 小宇宙（DECISIONS §72）：播客音频文件的纯逻辑——认格式、建索引、把"时间段"换算成要读的字节、把读到的字节整理成浏览器能解码的样子。
// 只处理小宇宙 CDN 上的两种格式：m4a（MP4 里的 AAC）与 mp3。不解码（解码交给浏览器的 decodeAudioData），不发网络请求（读字节由调用方注入）。
//
// 时间有两种：
//   - 真实时间：从文件开头逐帧数出来的时间，字幕按它存（与跳转方式无关，同一句话永远是同一个时间）；
//   - 页面时间：小宇宙播放器 <audio>.currentTime 报告的时间。m4a、恒定码率 mp3 两者相同（Chrome 实测误差 < 0.1 秒）；
//     可变码率（VBR）mp3 跳转之后，浏览器按文件头里的 Xing 目录粗略定位，报告的时间与真实声音能差出一分钟
//     （2026-11-13 Chrome 实测：《硅谷101》一集跳到 29:00 时，实际放的是 29:41 的声音）。pageOffset 按浏览器的定位规则算出差值。

// ── 读字节 ──

export interface RangeResult {
  bytes: Uint8Array;
  /** 整个文件的字节数（来自 Content-Range） */
  total: number;
}

/** 读文件的 [start, end]（含 end）；越界部分由服务器截掉 */
export type RangeFetch = (start: number, end: number) => Promise<RangeResult>;

export class AudioFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioFormatError';
  }
}

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const i32 = (b: Uint8Array, o: number) => u32(b, o) | 0;
const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

// ── 索引 ──

export interface Mp4Index {
  kind: 'mp4';
  total: number;
  /** aac：加 ADTS 头后解码；mp3：MP4 里装的是 mp3 帧，直接拼起来解码 */
  codec: 'aac' | 'mp3';
  sampleRate: number;
  channels: number;
  /** ADTS 头要用的：AAC 类型（LC = 2）、采样率序号、声道配置 */
  aot: number;
  freqIndex: number;
  channelConfig: number;
  /** 编辑列表里跳过的开头（编码器延迟，秒）：页面时间 = 媒体时间 − editSec */
  editSec: number;
  count: number;
  offsets: Float64Array;
  sizes: Uint32Array;
  /** 每帧开始的媒体时间（秒） */
  starts: Float64Array;
  /** 页面时间轴上的总时长（秒） */
  duration: number;
}

export interface Mp3Scan {
  /** 每隔 every 帧记一个字节位置：offsets[j] 是第 j·every 帧（不算 Xing 帧）的位置 */
  every: number;
  offsets: number[];
  /** Chrome 的跳转锚点：Xing 目录第 i 项指向的位置之后第一帧的帧序号 */
  anchors: number[];
  /** 扫到文件末尾了 */
  complete: boolean;
  /** 扫到第几个字节了（没扫完时，之后的锚点还不知道） */
  scannedTo: number;
}

export interface Mp3Index {
  kind: 'mp3';
  total: number;
  /** 第一帧（可能是 Xing / Info 帧）的位置 */
  dataStart: number;
  /** 第一个有声音的帧的位置（跳过 Xing / Info 帧） */
  audioStart: number;
  sampleRate: number;
  channels: number;
  /** 每帧样本数（MPEG-1 Layer III 是 1152） */
  spf: number;
  /** 恒定码率：每帧平均字节数；可变码率：总字节 / 总帧数 */
  avgFrameBytes: number;
  vbr: boolean;
  /** Xing 头：总帧数、总字节数、100 项目录（0–255） */
  xing?: { frames: number; bytes: number; toc?: number[] };
  /** 页面时间轴上的总时长（秒） */
  duration: number;
  scan?: Mp3Scan;
}

export type AudioIndex = Mp4Index | Mp3Index;

// ── MP4 ──

interface Box {
  type: string;
  start: number;
  /** 内容开始（跳过头） */
  body: number;
  end: number;
}

function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  let o = from;
  while (o + 8 <= to) {
    let size = u32(b, o);
    const type = tag(b, o + 4);
    let body = o + 8;
    if (size === 1) {
      if (o + 16 > to) return;
      size = u64(b, o + 8);
      body = o + 16;
    } else if (size === 0) {
      size = to - o;
    }
    if (size < body - o) return;
    yield { type, start: o, body, end: Math.min(to, o + size) };
    o += size;
  }
}

function child(b: Uint8Array, parent: Box, type: string): Box | undefined {
  for (const x of boxes(b, parent.body, parent.end)) if (x.type === type) return x;
  return undefined;
}

function path(b: Uint8Array, parent: Box, ...types: string[]): Box | undefined {
  let cur: Box | undefined = parent;
  for (const t of types) {
    if (!cur) return undefined;
    cur = child(b, cur, t);
  }
  return cur;
}

/** MPEG-4 描述符的长度（1–4 字节，高位为续位） */
function descLen(b: Uint8Array, o: number): { len: number; at: number } {
  let len = 0;
  let at = o;
  for (let i = 0; i < 4; i++) {
    const x = b[at++]!;
    len = (len << 7) | (x & 0x7f);
    if (!(x & 0x80)) break;
  }
  return { len, at };
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

class Bits {
  private pos = 0;
  constructor(private readonly b: Uint8Array) {}
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos >> 3] ?? 0;
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v >>> 0;
  }
}

/** AudioSpecificConfig → ADTS 头要的三项。HE-AAC（SBR / PS）按底层 AAC-LC 写，解码器隐式还原 */
export function parseAsc(asc: Uint8Array): { aot: number; freqIndex: number; channelConfig: number; sampleRate: number } {
  const r = new Bits(asc);
  const readAot = () => {
    const a = r.read(5);
    return a === 31 ? 32 + r.read(6) : a;
  };
  const readFreq = (): { index: number; rate: number } => {
    const i = r.read(4);
    if (i === 15) {
      const rate = r.read(24);
      const index = AAC_RATES.indexOf(rate);
      return { index, rate };
    }
    return { index: i, rate: AAC_RATES[i] ?? 0 };
  };
  let aot = readAot();
  const freq = readFreq();
  const channelConfig = r.read(4);
  if (aot === 5 || aot === 29) {
    readFreq();
    aot = readAot();
  }
  if (freq.index < 0 || freq.index > 12) throw new AudioFormatError(`不支持的 AAC 采样率（${freq.rate} Hz）`);
  if (aot < 1 || aot > 4) throw new AudioFormatError(`不支持的 AAC 类型（${aot}）`);
  if (channelConfig < 1 || channelConfig > 7) throw new AudioFormatError(`不支持的 AAC 声道配置（${channelConfig}）`);
  return { aot, freqIndex: freq.index, channelConfig, sampleRate: freq.rate };
}

/** 从 esds 里取 objectTypeIndication 与 AudioSpecificConfig */
function parseEsds(b: Uint8Array, box: Box): { oti: number; asc?: Uint8Array } {
  let o = box.body + 4;
  if (b[o] !== 0x03) throw new AudioFormatError('音频描述（esds）格式不对');
  let d = descLen(b, o + 1);
  o = d.at + 2;
  const flags = b[o++]!;
  if (flags & 0x80) o += 2;
  if (flags & 0x40) o += 1 + b[o]!;
  if (flags & 0x20) o += 2;
  if (b[o] !== 0x04) throw new AudioFormatError('音频描述（esds）里没有解码器配置');
  d = descLen(b, o + 1);
  const dcdEnd = d.at + d.len;
  const oti = b[d.at]!;
  o = d.at + 13;
  if (o < dcdEnd && b[o] === 0x05) {
    const s = descLen(b, o + 1);
    return { oti, asc: b.slice(s.at, s.at + s.len) };
  }
  return { oti };
}

/** 解析 moov：取第一条音轨的帧表。moov 是整个 moov 盒子的字节，fileOffset 是它在文件里的位置（帧位置是文件里的绝对位置，用不到它） */
export function parseMoov(moov: Uint8Array, total: number): Mp4Index {
  const root: Box = { type: 'root', start: 0, body: 0, end: moov.length };
  const mv = child(moov, root, 'moov');
  if (!mv) throw new AudioFormatError('m4a 文件里没有 moov');
  for (const trak of boxes(moov, mv.body, mv.end)) {
    if (trak.type !== 'trak') continue;
    const hdlr = path(moov, trak, 'mdia', 'hdlr');
    if (!hdlr || tag(moov, hdlr.body + 8) !== 'soun') continue;
    const mdhd = path(moov, trak, 'mdia', 'mdhd');
    const stbl = path(moov, trak, 'mdia', 'minf', 'stbl');
    if (!mdhd || !stbl) throw new AudioFormatError('m4a 的音轨缺少时间表');
    const v = moov[mdhd.body]!;
    const timescale = v === 1 ? u32(moov, mdhd.body + 20) : u32(moov, mdhd.body + 12);
    if (!timescale) throw new AudioFormatError('m4a 的时间单位为 0');

    // 声音格式
    const stsd = child(moov, stbl, 'stsd');
    if (!stsd) throw new AudioFormatError('m4a 的音轨没有格式描述');
    const entry = boxes(moov, stsd.body + 8, stsd.end).next().value as Box | undefined;
    if (!entry) throw new AudioFormatError('m4a 的音轨没有格式描述');
    if (entry.type !== 'mp4a') throw new AudioFormatError(`不支持的音频编码（${entry.type}）`);
    const sv = u16(moov, entry.body + 8);
    const channels = u16(moov, entry.body + 16);
    const childFrom = entry.body + 28 + (sv === 1 ? 16 : sv === 2 ? 36 : 0);
    let esds: Box | undefined;
    for (const x of boxes(moov, childFrom, entry.end)) {
      if (x.type === 'esds') esds = x;
      if (x.type === 'wave') for (const y of boxes(moov, x.body, x.end)) if (y.type === 'esds') esds = y;
    }
    if (!esds) throw new AudioFormatError('m4a 的音轨没有解码器配置（esds）');
    const { oti, asc } = parseEsds(moov, esds);
    let codec: 'aac' | 'mp3';
    let a = { aot: 0, freqIndex: 0, channelConfig: 0, sampleRate: 0 };
    if (oti === 0x40 || oti === 0x66 || oti === 0x67 || oti === 0x68) {
      if (!asc) throw new AudioFormatError('m4a 的 AAC 音轨缺少 AudioSpecificConfig');
      codec = 'aac';
      a = parseAsc(asc);
    } else if (oti === 0x69 || oti === 0x6b) {
      codec = 'mp3';
    } else {
      throw new AudioFormatError(`不支持的音频编码（0x${oti.toString(16)}）`);
    }

    // 帧表
    const stsz = child(moov, stbl, 'stsz');
    const stsc = child(moov, stbl, 'stsc');
    const stts = child(moov, stbl, 'stts');
    const stco = child(moov, stbl, 'stco') ?? child(moov, stbl, 'co64');
    if (!stsz || !stsc || !stts || !stco) throw new AudioFormatError('m4a 的帧表不完整');
    const fixed = u32(moov, stsz.body + 4);
    const count = u32(moov, stsz.body + 8);
    if (!count) throw new AudioFormatError('m4a 里没有音频帧');
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || u32(moov, stsz.body + 12 + i * 4);

    const chunkCount = u32(moov, stco.body + 4);
    const co64 = stco.type === 'co64';
    const chunkOffset = (c: number) => (co64 ? u64(moov, stco.body + 8 + c * 8) : u32(moov, stco.body + 8 + c * 4));
    const stscN = u32(moov, stsc.body + 4);
    const runs: { first: number; per: number }[] = [];
    for (let i = 0; i < stscN; i++) runs.push({ first: u32(moov, stsc.body + 8 + i * 12) - 1, per: u32(moov, stsc.body + 12 + i * 12) });
    const offsets = new Float64Array(count);
    let s = 0;
    for (let r = 0; r < runs.length && s < count; r++) {
      const lastChunk = r + 1 < runs.length ? runs[r + 1]!.first : chunkCount;
      for (let c = runs[r]!.first; c < lastChunk && s < count; c++) {
        let off = chunkOffset(c);
        for (let k = 0; k < runs[r]!.per && s < count; k++) {
          offsets[s] = off;
          off += sizes[s]!;
          s++;
        }
      }
    }
    if (s < count) throw new AudioFormatError('m4a 的帧表与分块表对不上');

    const starts = new Float64Array(count);
    const sttsN = u32(moov, stts.body + 4);
    let t = 0;
    let k = 0;
    for (let i = 0; i < sttsN && k < count; i++) {
      const n = u32(moov, stts.body + 8 + i * 8);
      const delta = u32(moov, stts.body + 12 + i * 8);
      for (let j = 0; j < n && k < count; j++) {
        starts[k++] = t / timescale;
        t += delta;
      }
    }
    for (; k < count; k++) starts[k] = t / timescale;

    let editSec = 0;
    const elst = path(moov, trak, 'edts', 'elst');
    if (elst) {
      const ev = moov[elst.body]!;
      const n = u32(moov, elst.body + 4);
      for (let i = 0; i < n; i++) {
        const at = elst.body + 8 + i * (ev === 1 ? 20 : 12);
        const mediaTime = ev === 1 ? u64(moov, at + 8) : i32(moov, at + 4);
        if (mediaTime >= 0 && mediaTime < 2 ** 52) {
          editSec = mediaTime / timescale;
          break;
        }
      }
    }
    return {
      kind: 'mp4',
      total,
      codec,
      sampleRate: a.sampleRate || timescale,
      channels,
      aot: a.aot,
      freqIndex: a.freqIndex,
      channelConfig: a.channelConfig,
      editSec,
      count,
      offsets,
      sizes,
      starts,
      duration: Math.max(0, t / timescale - editSec),
    };
  }
  throw new AudioFormatError('m4a 文件里没有音轨');
}

/** ADTS 头（7 字节，无 CRC） */
export function adtsHeader(aot: number, freqIndex: number, channelConfig: number, payload: number): Uint8Array {
  const len = payload + 7;
  return new Uint8Array([
    0xff,
    0xf1,
    (((aot - 1) & 3) << 6) | ((freqIndex & 15) << 2) | ((channelConfig >> 2) & 1),
    ((channelConfig & 3) << 6) | ((len >> 11) & 3),
    (len >> 3) & 0xff,
    ((len & 7) << 5) | 0x1f,
    0xfc,
  ]);
}

// ── MP3 ──

const BITRATES: Record<string, number[]> = {
  'v1l1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  'v1l2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  'v1l3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  'v2l1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  'v2l2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = [44100, 48000, 32000];

export interface Mp3Frame {
  size: number;
  sampleRate: number;
  spf: number;
  channels: number;
  bitrate: number;
  /** 1 = MPEG-1，2 = MPEG-2，2.5 = MPEG-2.5 */
  version: 1 | 2 | 2.5;
  layer: 1 | 2 | 3;
}

/** 读 o 处的帧头；不是合法帧头时 undefined */
export function mp3FrameAt(b: Uint8Array, o: number): Mp3Frame | undefined {
  if (o + 4 > b.length || b[o] !== 0xff || (b[o + 1]! & 0xe0) !== 0xe0) return undefined;
  const vb = (b[o + 1]! >> 3) & 3;
  const lb = (b[o + 1]! >> 1) & 3;
  const bi = (b[o + 2]! >> 4) & 15;
  const si = (b[o + 2]! >> 2) & 3;
  const pad = (b[o + 2]! >> 1) & 1;
  const mode = (b[o + 3]! >> 6) & 3;
  if (vb === 1 || lb === 0 || bi === 0 || bi === 15 || si === 3) return undefined;
  const version = vb === 3 ? 1 : vb === 2 ? 2 : 2.5;
  const layer = (4 - lb) as 1 | 2 | 3;
  const table = version === 1 ? `v1l${layer}` : layer === 1 ? 'v2l1' : 'v2l2';
  const bitrate = BITRATES[table]![bi]! * 1000;
  const sampleRate = SAMPLE_RATES[si]! / (version === 1 ? 1 : version === 2 ? 2 : 4);
  const spf = layer === 1 ? 384 : layer === 2 || version === 1 ? 1152 : 576;
  const size = layer === 1 ? Math.floor((12 * bitrate) / sampleRate + pad) * 4 : Math.floor(((spf / 8) * bitrate) / sampleRate) + pad;
  if (size < 4) return undefined;
  return { size, sampleRate, spf, channels: mode === 3 ? 1 : 2, bitrate, version, layer };
}

/** 从 o 开始找下一个可信的帧（连着两帧的帧头都对，且采样率、层一致）；找不到时 -1 */
export function syncMp3(b: Uint8Array, o: number, limit = b.length): number {
  for (let i = Math.max(0, o); i + 4 <= limit; i++) {
    const f = mp3FrameAt(b, i);
    if (!f) continue;
    const next = mp3FrameAt(b, i + f.size);
    if (i + f.size + 4 > b.length) return i; // 缓冲区到头了：只能信这一帧
    if (next && next.sampleRate === f.sampleRate && next.layer === f.layer) return i;
  }
  return -1;
}

/** ID3v2 标签的长度（没有时 0） */
export function id3Size(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  const footer = b[5]! & 0x10 ? 10 : 0;
  return 10 + footer + ((b[6]! & 0x7f) << 21) + ((b[7]! & 0x7f) << 14) + ((b[8]! & 0x7f) << 7) + (b[9]! & 0x7f);
}

/** 第一帧里的 Xing / Info 头。Info 是恒定码率（LAME 写的） */
function parseXing(b: Uint8Array, o: number, f: Mp3Frame): { kind: 'Xing' | 'Info'; frames?: number; bytes?: number; toc?: number[] } | undefined {
  const side = f.version === 1 ? (f.channels === 1 ? 17 : 32) : f.channels === 1 ? 9 : 17;
  const at = o + 4 + side;
  const t = at + 4 <= b.length ? tag(b, at) : '';
  if (t !== 'Xing' && t !== 'Info') return undefined;
  const flags = u32(b, at + 4);
  let p = at + 8;
  const out: { kind: 'Xing' | 'Info'; frames?: number; bytes?: number; toc?: number[] } = { kind: t };
  if (flags & 1) {
    out.frames = u32(b, p);
    p += 4;
  }
  if (flags & 2) {
    out.bytes = u32(b, p);
    p += 4;
  }
  if (flags & 4) {
    out.toc = Array.from(b.subarray(p, p + 100));
    p += 100;
  }
  return out;
}

/**
 * 认 mp3：head 是文件开头的一段（要能盖住 ID3 标签与第一帧）。
 * 没有 Xing 头时看开头几十帧的码率：都一样算恒定码率，否则算"没有目录的可变码率"（时间对不准，界面会说明）。
 */
export function parseMp3Head(head: Uint8Array, total: number): Mp3Index {
  const id3 = id3Size(head);
  if (id3 >= head.length) throw new AudioFormatError('mp3 开头的标签太长，没读到音频帧');
  const dataStart = syncMp3(head, id3);
  if (dataStart < 0) throw new AudioFormatError('没在 mp3 文件开头找到音频帧');
  const f = mp3FrameAt(head, dataStart)!;
  const xing = parseXing(head, dataStart, f);
  const audioStart = xing ? dataStart + f.size : dataStart;
  const dataBytes = Math.max(1, total - audioStart);
  if (xing?.kind === 'Xing' && xing.frames) {
    const bytes = xing.bytes ?? total - dataStart;
    return {
      kind: 'mp3',
      total,
      dataStart,
      audioStart,
      sampleRate: f.sampleRate,
      channels: f.channels,
      spf: f.spf,
      avgFrameBytes: bytes / xing.frames,
      vbr: true,
      xing: { frames: xing.frames, bytes, ...(xing.toc ? { toc: xing.toc } : {}) },
      duration: (xing.frames * f.spf) / f.sampleRate,
    };
  }
  // 恒定码率：看开头的帧码率是否一致
  const rates = new Set<number>();
  let o = audioStart;
  for (let i = 0; i < 40; i++) {
    const g = mp3FrameAt(head, o);
    if (!g) break;
    rates.add(g.bitrate);
    o += g.size;
  }
  const first = mp3FrameAt(head, audioStart) ?? f;
  const avgFrameBytes = ((first.spf / 8) * first.bitrate) / first.sampleRate;
  const frames = xing?.frames ?? Math.round(dataBytes / avgFrameBytes);
  return {
    kind: 'mp3',
    total,
    dataStart,
    audioStart,
    sampleRate: f.sampleRate,
    channels: f.channels,
    spf: f.spf,
    avgFrameBytes,
    vbr: rates.size > 1,
    ...(xing ? { xing: { frames, bytes: xing.bytes ?? total - dataStart } } : {}),
    duration: (frames * f.spf) / f.sampleRate,
  };
}

/** 可变码率 mp3 要先把整个文件的帧头扫一遍，才能把时间换算成字节 */
export function needsScan(index: AudioIndex): boolean {
  return index.kind === 'mp3' && index.vbr && !index.scan?.complete;
}

/** 时间能不能对准：没有目录的可变码率 mp3 对不准 */
export function timingExact(index: AudioIndex): boolean {
  return index.kind === 'mp4' || !index.vbr || !!index.xing?.toc;
}

/** Chrome 跳转时第 i 项目录指向的字节（ffmpeg 的快速定位：数据开头 + toc[i] × 总字节 / 256） */
export function chromeAnchorByte(index: Mp3Index, i: number): number {
  const toc = index.xing?.toc;
  if (!toc || !index.xing) return index.dataStart;
  return index.dataStart + Math.floor((toc[Math.max(0, Math.min(99, i))]! * index.xing.bytes) / 256);
}

/**
 * 扫描可变码率 mp3 的帧头（流式）：每读到一块字节调用一次 push，最后调用 finish。
 * 记下每 every 帧的位置与 Chrome 的 100 个跳转锚点的帧序号。只看帧头，不留音频。
 */
export class Mp3Scanner {
  private carry = new Uint8Array(0);
  /** carry[0] 在文件里的位置 */
  private carryAt: number;
  private frame = 0;
  private next: number;
  private readonly anchorBytes: number[];
  readonly scan: Mp3Scan;

  constructor(
    private readonly index: Mp3Index,
    every = 64,
  ) {
    this.carryAt = index.audioStart;
    this.next = index.audioStart;
    this.anchorBytes = Array.from({ length: 100 }, (_, i) => chromeAnchorByte(index, i));
    this.scan = { every, offsets: [], anchors: Array.from({ length: 100 }, () => -1), complete: false, scannedTo: index.audioStart };
  }

  /** at：这块字节在文件里的位置（必须接着上一块） */
  push(chunk: Uint8Array, at: number): void {
    if (at !== this.carryAt + this.carry.length) throw new AudioFormatError('扫描 mp3 时读到的字节不连续');
    const buf = new Uint8Array(this.carry.length + chunk.length);
    buf.set(this.carry);
    buf.set(chunk, this.carry.length);
    const base = this.carryAt;
    let o = this.next - base;
    while (o + 4 <= buf.length) {
      let f = mp3FrameAt(buf, o);
      if (!f) {
        const s = syncMp3(buf, o + 1);
        if (s < 0) {
          o = Math.max(o, buf.length - 3);
          break;
        }
        o = s;
        f = mp3FrameAt(buf, o)!;
      }
      if (o + f.size > buf.length) break;
      this.onFrame(base + o);
      o += f.size;
    }
    this.next = base + o;
    const keep = Math.min(buf.length, Math.max(0, buf.length - o) + 3);
    this.carry = buf.slice(buf.length - keep);
    this.carryAt = base + buf.length - keep;
    this.scan.scannedTo = base + buf.length;
  }

  finish(): Mp3Scan {
    for (let i = 0; i < 100; i++) if (this.scan.anchors[i]! < 0) this.scan.anchors[i] = this.frame;
    this.scan.complete = true;
    this.scan.scannedTo = this.index.total;
    return this.scan;
  }

  private onFrame(pos: number): void {
    if (this.frame % this.scan.every === 0) this.scan.offsets.push(pos);
    for (let i = 0; i < 100; i++) if (this.scan.anchors[i]! < 0 && pos >= this.anchorBytes[i]!) this.scan.anchors[i] = this.frame;
    this.frame++;
  }
}

// ── 页面时间 ↔ 真实时间 ──

export type SeekModel = 'chrome' | 'firefox';

/**
 * 真实时间 − 页面时间。seekTarget：最近一次跳转时页面要去的时间（没跳转过为 undefined，此时从头连续播放，两者相同）。
 * 只有可变码率 mp3 才不为 0：
 *   - Chrome（ffmpeg 的快速定位，2026-11-13 实测吻合到 0.05 秒）：跳到 T 时取目录第 i = ⌊T / 时长 × 100⌋ 项指向的那一帧，
 *     把它当成 i × 时长 / 100 秒，往后解码到 T 才开始放。所以差值只跟 i 有关：锚点帧的真实时间 − i × 时长 / 100。
 *   - Firefox（按 Mozilla 源码推得，未实测）：在目录两项之间线性插值出字节位置，把那里当成 T。
 * 扫描还没到需要的位置时返回 undefined（调用方等扫描）。
 */
export function pageOffset(index: AudioIndex, seekTarget: number | undefined, model: SeekModel = 'chrome'): number | undefined {
  if (index.kind !== 'mp3' || !index.vbr || !index.xing?.toc) return 0;
  if (seekTarget === undefined || seekTarget < 0.05) return 0;
  const scan = index.scan;
  if (!scan) return undefined;
  const fdur = index.spf / index.sampleRate;
  if (model === 'chrome') {
    const i = Math.min(99, Math.floor((seekTarget * 100) / index.duration));
    const anchor = scan.anchors[i]!;
    if (anchor < 0) return undefined;
    return anchor * fdur - (i * index.duration) / 100;
  }
  const toc = index.xing.toc;
  const k = Math.max(0, Math.min(100, (seekTarget / index.duration) * 100));
  const a = Math.min(99, Math.floor(k));
  const fa = (toc[a]! * index.xing.bytes) / 256;
  const fb = a < 99 ? (toc[a + 1]! * index.xing.bytes) / 256 : index.xing.bytes;
  const byte = index.dataStart + fa + (fb - fa) * (k - a);
  const frame = frameAtByte(index, byte);
  return frame === undefined ? undefined : frame * fdur - seekTarget;
}

/** 可变码率 mp3：某个字节位置大约是第几帧（检查点之间按平均帧长插值） */
function frameAtByte(index: Mp3Index, byte: number): number | undefined {
  const scan = index.scan;
  if (!scan || (!scan.complete && byte > scan.scannedTo)) return undefined;
  const offs = scan.offsets;
  let lo = 0;
  let hi = offs.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offs[mid]! <= byte) lo = mid;
    else hi = mid - 1;
  }
  const at = offs[lo]!;
  const nextAt = offs[lo + 1] ?? index.total;
  const per = (nextAt - at) / scan.every;
  return lo * scan.every + Math.max(0, Math.min(scan.every, per > 0 ? (byte - at) / per : 0));
}

// ── 时间段 → 字节 ──

/** 读一段音频要读哪些字节、读到之后怎样整理 */
export interface WindowPlan {
  /** 要读的字节 [start, end]（含 end） */
  start: number;
  end: number;
  /** 输出的第一个样本对应的真实时间（秒） */
  firstTime: number;
  /** 解码后开头要丢掉多少秒（预读的帧，用来暖解码器） */
  skipSec: number;
  codec: 'aac' | 'mp3';
}

export interface WindowData {
  /** 交给 decodeAudioData 的字节（ADTS 或 mp3 帧） */
  data: Uint8Array;
  mime: string;
  firstTime: number;
  skipSec: number;
  /** 实际覆盖到的真实时间 */
  endTime: number;
}

/** 解码器暖身：在要的时间段前面多读几帧，解码后丢掉（AAC 的重叠相加、mp3 的比特池都要用到前一帧） */
const PREROLL_FRAMES = 2;

function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 真实时间 [t0, t1) 要读哪些字节。可变码率 mp3 要先扫描（needsScan）；没扫到这里时抛错。
 */
export function planWindow(index: AudioIndex, t0: number, t1: number): WindowPlan {
  const a = Math.max(0, Math.min(t0, index.duration));
  const b = Math.max(a, Math.min(t1, index.duration));
  if (index.kind === 'mp4') {
    const media0 = a + index.editSec;
    const media1 = b + index.editSec;
    let k0 = Math.max(0, lowerBound(index.starts, media0) - 1);
    if (index.starts[k0]! > media0 && k0 > 0) k0--;
    const first = Math.max(0, k0 - PREROLL_FRAMES);
    const k1 = Math.min(index.count - 1, Math.max(k0, lowerBound(index.starts, media1)));
    let start = Infinity;
    let end = 0;
    for (let k = first; k <= k1; k++) {
      start = Math.min(start, index.offsets[k]!);
      end = Math.max(end, index.offsets[k]! + index.sizes[k]! - 1);
    }
    return { start, end, firstTime: index.starts[first]! - index.editSec, skipSec: index.starts[k0]! - index.starts[first]!, codec: index.codec };
  }
  const fdur = index.spf / index.sampleRate;
  const k0 = Math.floor(a / fdur);
  const k1 = Math.ceil(b / fdur);
  const first = Math.max(0, k0 - PREROLL_FRAMES);
  if (!index.vbr) {
    // 多读一帧的余量：真实文件的填充位分布不一定均匀，按位置推的帧号会差一两个字节
    const start = Math.max(index.audioStart, Math.floor(index.audioStart + (first - 1) * index.avgFrameBytes) - 8);
    const end = Math.min(index.total - 1, Math.ceil(index.audioStart + (k1 + 1) * index.avgFrameBytes) + 8);
    return { start, end, firstTime: first * fdur, skipSec: (k0 - first) * fdur, codec: 'mp3' };
  }
  const scan = index.scan;
  if (!scan) throw new AudioFormatError('这一集是可变码率 mp3，要先扫描整个文件');
  const c0 = Math.floor(first / scan.every);
  const c1 = Math.ceil((k1 + 1) / scan.every);
  if (c0 >= scan.offsets.length) throw new AudioFormatError('扫描还没到这个位置');
  const start = scan.offsets[c0]!;
  const end = c1 < scan.offsets.length ? scan.offsets[c1]! - 1 : scan.complete ? index.total - 1 : -1;
  if (end < 0) throw new AudioFormatError('扫描还没到这个位置');
  // 从检查点开始读：多出来的帧算在 skipSec 里
  return { start, end, firstTime: c0 * scan.every * fdur, skipSec: (k0 - c0 * scan.every) * fdur, codec: 'mp3' };
}

/** 把读到的字节整理成能解码的一段 */
export function extractWindow(index: AudioIndex, plan: WindowPlan, bytes: Uint8Array, t1: number): WindowData {
  if (index.kind === 'mp4') {
    const parts: Uint8Array[] = [];
    let first = -1;
    let last = -1;
    const firstMedia = plan.firstTime + index.editSec;
    const k = Math.max(0, lowerBound(index.starts, firstMedia - 1e-9));
    for (let i = k; i < index.count; i++) {
      const off = index.offsets[i]! - plan.start;
      const size = index.sizes[i]!;
      if (off < 0 || off + size > bytes.length) {
        if (first >= 0) break;
        continue;
      }
      if (first < 0) first = i;
      if (index.codec === 'aac') parts.push(adtsHeader(index.aot, index.freqIndex, index.channelConfig, size));
      parts.push(bytes.subarray(off, off + size));
      last = i;
      if (index.starts[i]! - index.editSec >= t1) break;
    }
    if (first < 0) throw new AudioFormatError('读到的字节里没有完整的音频帧');
    const fdur = last + 1 < index.count ? index.starts[last + 1]! - index.starts[last]! : index.starts[last]! - (index.starts[last - 1] ?? 0);
    const data = concatBytes(parts);
    return {
      data,
      mime: index.codec === 'aac' ? 'audio/aac' : 'audio/mpeg',
      firstTime: index.starts[first]! - index.editSec,
      skipSec: Math.max(0, plan.firstTime + plan.skipSec - (index.starts[first]! - index.editSec)),
      endTime: index.starts[last]! - index.editSec + fdur,
    };
  }
  const fdur = index.spf / index.sampleRate;
  let o = syncMp3(bytes, 0);
  if (o < 0) throw new AudioFormatError('读到的字节里没有 mp3 帧');
  // 恒定码率：按位置推出这是第几帧；可变码率：从检查点开始读，第一帧就是检查点那一帧
  const firstFrame = index.vbr ? Math.round(plan.firstTime / fdur) : Math.max(0, Math.round((plan.start + o - index.audioStart) / index.avgFrameBytes));
  const firstTime = firstFrame * fdur;
  let n = 0;
  const startAt = o;
  while (o + 4 <= bytes.length) {
    const f = mp3FrameAt(bytes, o);
    if (!f || o + f.size > bytes.length) break;
    o += f.size;
    n++;
    if (firstTime + n * fdur >= t1 + fdur) break;
  }
  if (!n) throw new AudioFormatError('读到的字节里没有完整的 mp3 帧');
  return {
    data: bytes.slice(startAt, o),
    mime: 'audio/mpeg',
    firstTime,
    skipSec: Math.max(0, plan.firstTime + plan.skipSec - firstTime),
    endTime: firstTime + n * fdur,
  };
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── 打开文件 ──

/** 认格式并建索引。m4a 的 moov 在文件末尾时多读几次（只读盒子头和 moov 本身） */
export async function openAudio(fetchRange: RangeFetch, maxMoovBytes = 16 * 1024 * 1024): Promise<AudioIndex> {
  const first = await fetchRange(0, 65_535);
  const head = first.bytes;
  const total = first.total;
  if (head.length >= 8 && tag(head, 4) === 'ftyp') {
    let o = 0;
    let buf = head;
    let bufAt = 0;
    for (let guard = 0; guard < 64 && o < total; guard++) {
      if (o + 16 > bufAt + buf.length) {
        const r = await fetchRange(o, o + 65_535);
        buf = r.bytes;
        bufAt = o;
      }
      const rel = o - bufAt;
      let size = u32(buf, rel);
      const type = tag(buf, rel + 4);
      if (size === 1) size = u64(buf, rel + 8);
      else if (size === 0) size = total - o;
      if (size < 8) throw new AudioFormatError('m4a 的盒子结构不对');
      if (type === 'moov') {
        if (size > maxMoovBytes) throw new AudioFormatError('m4a 的索引（moov）太大');
        const moov = o + size <= bufAt + buf.length ? buf.slice(rel, rel + size) : (await fetchRange(o, o + size - 1)).bytes;
        if (moov.length < size) throw new AudioFormatError('没读全 m4a 的索引（moov）');
        return parseMoov(moov, total);
      }
      o += size;
    }
    throw new AudioFormatError('m4a 文件里没找到索引（moov）');
  }
  let mp3Head = head;
  const id3 = id3Size(head);
  if (id3 + 8_192 > head.length) mp3Head = (await fetchRange(0, id3 + 65_535)).bytes;
  return parseMp3Head(mp3Head, total);
}

// ── 波形 ──

/** 把一段 PCM 分成 n 根柱子，每根是这段的均方根响度（0–1，按最大的一根归一） */
export function waveformBars(samples: Float32Array, n: number): number[] {
  const out: number[] = [];
  const per = samples.length / Math.max(1, n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * per);
    const b = Math.max(a + 1, Math.floor((i + 1) * per));
    let sum = 0;
    for (let j = a; j < b && j < samples.length; j++) sum += samples[j]! * samples[j]!;
    const rms = Math.sqrt(sum / Math.max(1, b - a));
    out.push(rms);
    if (rms > max) max = rms;
  }
  return out.map((x) => (max > 0 ? Math.round((x / max) * 1000) / 1000 : 0));
}

/** 16-bit PCM WAV（可以是双声道，交错存放）：导出音频片段用 */
export function encodeWavPcm(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const ch = channels.length;
  const n = channels[0]?.length ?? 0;
  const buf = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + n * ch * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, n * ch * 2, true);
  let at = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]![i]!));
      v.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      at += 2;
    }
  }
  return new Uint8Array(buf);
}
