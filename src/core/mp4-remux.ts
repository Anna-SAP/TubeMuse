// MP4 的拆封与重新封装（纯逻辑，不碰 DOM）：给"保存完整双语视频"用（用户 2026-11-16 选定的做法，见 DECISIONS §83）。
// 你选一个本地的原视频文件（MP4），这里读出它的索引（moov）：画面轨的每一帧在文件的哪里、原声轨怎么解码；
// 再写出一个新的 MP4——画面轨的数据原样照搬（不解码、不重新编码，只改"每一块在新文件的哪里"），
// 原声轨换成混好的那一条新音轨（原声 80% + 中文配音，由 services/dub-export.ts 解码、混音、编码）。
// 新文件的内容用"几段原文件 + 几段新字节"来描述，由调用方拼成 Blob：原视频几百 MB 也不用读进内存。
// 只认普通的（不分片的）MP4；分片 MP4、WebM / MKV、MOV 说清楚并给出转换办法，不硬来。

export type FileRead = (start: number, end: number) => Promise<Uint8Array>;

export class Mp4Error extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'Mp4Error';
    if (hint) this.hint = hint;
  }
}

const u16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const i32 = (b: Uint8Array, o: number) => u32(b, o) | 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

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
    } else if (size === 0) size = to - o;
    if (size < body - o || o + size > to) return;
    yield { type, start: o, body, end: o + size };
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

// ── 写 ──

class Writer {
  private buf = new Uint8Array(1024);
  private len = 0;
  private room(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v: number): this {
    this.room(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }
  u16(v: number): this {
    return this.u8(v >>> 8).u8(v);
  }
  u32(v: number): this {
    this.room(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }
  u64(v: number): this {
    return this.u32(Math.floor(v / 2 ** 32)).u32(v % 2 ** 32);
  }
  str(s: string): this {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }
  zeros(n: number): this {
    this.room(n);
    this.len += n;
    return this;
  }
  bytes(b: Uint8Array): this {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }
  done(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.len);
  }
}

/** 一个盒子：4 字节长度 + 类型 + 内容 */
function box(type: string, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const w = new Writer().u32(size).str(type);
  for (const p of parts) w.bytes(p);
  return w.done();
}

/** 带版本号和标志的盒子 */
function fullBox(type: string, version: number, flags: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
  return box(type, new Writer().u8(version).u8(flags >>> 16).u16(flags & 0xffff).done(), body);
}

// ── 读：文件最外层 ──

export interface Mp4Top {
  ftyp: Uint8Array;
  moov: Uint8Array;
}

const NOT_MP4_HINT = '需要 MP4 格式的原视频（画面多半是 H.264，带原声）。';
const REMUX_HINT = '用 ffmpeg 原样转一下封装（不重新编码，几秒钟）：ffmpeg -i 原文件 -c copy 新文件.mp4，再选新文件。';

/** 文件开头几个字节看着像什么（不是 MP4 时说得具体一点） */
function sniff(head: Uint8Array): string | undefined {
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'WebM / MKV';
  if (tag(head, 0) === 'RIFF') return 'AVI / WAV';
  if (tag(head, 0) === 'FLV\u0001') return 'FLV';
  if (head[0] === 0x47 && head[188] === 0x47) return 'MPEG-TS';
  return undefined;
}

/**
 * 读出 ftyp 和 moov（moov 在文件末尾也行：顺着盒子头一路跳过去，不读中间的数据）。
 * 不是 MP4、分片 MP4、没写完的文件：抛 Mp4Error，说明是什么、怎么办
 */
export async function readMp4Top(read: FileRead, total: number, maxMoovBytes = 256 * 1024 * 1024): Promise<Mp4Top> {
  if (total < 16) throw new Mp4Error('这个文件是空的，或者没下载完', NOT_MP4_HINT);
  const head = await read(0, Math.min(total, 256));
  const kind = sniff(head);
  if (kind) throw new Mp4Error(`这是 ${kind} 文件，不是 MP4`, `${NOT_MP4_HINT}${REMUX_HINT}`);
  let ftyp: Uint8Array | undefined;
  let moov: Uint8Array | undefined;
  let fragmented = false;
  let o = 0;
  let first = true;
  while (o + 8 <= total) {
    const h = await read(o, Math.min(total, o + 16));
    let size = u32(h, 0);
    const type = tag(h, 4);
    let headLen = 8;
    if (size === 1 && h.length >= 16) {
      size = u64(h, 8);
      headLen = 16;
    } else if (size === 0) size = total - o;
    if (first && !/^(ftyp|moov|free|skip|wide|mdat|styp)$/.test(type)) throw new Mp4Error('这个文件不是 MP4', NOT_MP4_HINT);
    first = false;
    if (size < headLen) throw new Mp4Error('这个 MP4 文件的结构坏了（盒子长度不对）', '重新导出或重新取得一份再试。');
    if (type === 'ftyp') ftyp = await read(o, Math.min(total, o + Math.min(size, 4096)));
    else if (type === 'moov') {
      if (size > maxMoovBytes) throw new Mp4Error('这个 MP4 的索引（moov）太大了，没法处理');
      if (o + size > total) throw new Mp4Error('这个 MP4 文件没写完（索引被截断了）', '多半是没下载完：重新取得一份完整的文件。');
      moov = await read(o, o + size);
    } else if (type === 'moof') fragmented = true;
    if (moov && (ftyp || o > 0)) break;
    o += size;
  }
  if (!moov) {
    if (fragmented) throw new Mp4Error('这是分片 MP4（fragmented），这里处理不了', REMUX_HINT);
    throw new Mp4Error('这个 MP4 里没有索引（moov）：文件没写完，或者不是普通的 MP4', '多半是没下载完：重新取得一份完整的文件。');
  }
  if (!ftyp) ftyp = box('ftyp', new Writer().str('isom').u32(0x200).str('isom').str('iso2').str('mp41').done());
  const major = tag(ftyp, 8);
  if (major === 'qt  ') throw new Mp4Error('这是 QuickTime（.mov）文件，不是 MP4', `${NOT_MP4_HINT}${REMUX_HINT}`);
  return { ftyp, moov };
}

// ── 读：moov ──

export interface Mp4Chunk {
  /** 在原文件里的位置与长度 */
  offset: number;
  size: number;
  firstSample: number;
  samples: number;
}

export interface Mp4AudioInfo {
  /** WebCodecs 的编码名：mp4a.40.2（AAC-LC）、mp4a.40.5（HE-AAC）、opus、mp3 */
  codec: string;
  /** 给人看的名字 */
  label: string;
  sampleRate: number;
  channels: number;
  /** 解码器配置：AAC 的 AudioSpecificConfig；Opus 的 OpusHead */
  description?: Uint8Array;
}

export interface Mp4Track {
  id: number;
  /** vide / soun / sbtl（字幕）/ 别的（章节、时间码…） */
  handler: string;
  /** 这条轨的语言：三个小写字母（ISO 639-2），没写明是 und */
  language: string;
  timescale: number;
  /** 媒体时长（timescale 单位） */
  mediaDuration: number;
  /** 这条轨在片子里占多久（片子的时间单位，tkhd） */
  movieDuration: number;
  /** stsd 里第一个条目的类型：avc1、hvc1、vp09、av01、mp4a、Opus… */
  entry: string;
  width?: number;
  height?: number;
  audio?: Mp4AudioInfo;
  /** 认不出、解不了这条音轨的原因（用人话）；有它就没有 audio */
  audioProblem?: string;
  count: number;
  sizes: Uint32Array;
  /** 每个样本在原文件里的位置 */
  offsets: Float64Array;
  /** 每个样本的解码时间（timescale 单位） */
  dts: Float64Array;
  chunks: Mp4Chunk[];
  /** 编辑列表：开头空出多久（片子的时间单位）；从媒体的哪里开始放（timescale 单位） */
  editEmpty: number;
  editStart: number;
  /** trak 盒子在 moov 里的位置 */
  trak: { start: number; end: number };
}

export interface Mp4Movie {
  timescale: number;
  duration: number;
  nextTrackId: number;
  tracks: Mp4Track[];
  /** 带 mvex：分片 MP4 */
  fragmented: boolean;
}

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

/** esds → objectTypeIndication 与 AudioSpecificConfig */
function parseEsds(b: Uint8Array, e: Box): { oti: number; asc?: Uint8Array } | undefined {
  let o = e.body + 4;
  if (b[o] !== 0x03) return undefined;
  let d = descLen(b, o + 1);
  o = d.at + 2;
  const flags = b[o++]!;
  if (flags & 0x80) o += 2;
  if (flags & 0x40) o += 1 + b[o]!;
  if (flags & 0x20) o += 2;
  if (b[o] !== 0x04) return undefined;
  d = descLen(b, o + 1);
  const end = d.at + d.len;
  const oti = b[d.at]!;
  o = d.at + 13;
  if (o < end && b[o] === 0x05) {
    const s = descLen(b, o + 1);
    return { oti, asc: b.slice(s.at, s.at + s.len) };
  }
  return { oti };
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** AudioSpecificConfig 开头：AAC 类型与采样率 */
function ascInfo(asc: Uint8Array): { aot: number; sampleRate: number; channels: number } {
  let pos = 0;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v = (v << 1) | (((asc[pos >> 3] ?? 0) >> (7 - (pos & 7))) & 1);
    return v >>> 0;
  };
  let aot = read(5);
  if (aot === 31) aot = 32 + read(6);
  const fi = read(4);
  const sampleRate = fi === 15 ? read(24) : (AAC_RATES[fi] ?? 0);
  const channels = read(4);
  return { aot, sampleRate, channels };
}

/** dOps（MP4 里 Opus 的配置，大端）→ OpusHead（解码器要的，小端） */
function opusHeadFromDops(b: Uint8Array, d: Box): Uint8Array {
  const o = d.body;
  const channels = b[o + 1]!;
  const preSkip = u16(b, o + 2);
  const rate = u32(b, o + 4);
  const gain = u16(b, o + 8);
  const family = b[o + 10]!;
  const w = new Writer().str('OpusHead').u8(1).u8(channels);
  w.u8(preSkip & 0xff).u8(preSkip >>> 8);
  w.u8(rate & 0xff).u8((rate >>> 8) & 0xff).u8((rate >>> 16) & 0xff).u8((rate >>> 24) & 0xff);
  w.u8(gain & 0xff).u8(gain >>> 8).u8(family);
  if (family !== 0) w.bytes(b.subarray(o + 11, d.end));
  return w.done();
}

function audioInfo(b: Uint8Array, entry: Box): { audio?: Mp4AudioInfo; problem?: string } {
  const sv = u16(b, entry.body + 8);
  const channels = u16(b, entry.body + 16);
  const rate = u32(b, entry.body + 24) >>> 16;
  const from = entry.body + 28 + (sv === 1 ? 16 : sv === 2 ? 36 : 0);
  if (entry.type === 'mp4a') {
    let esds: Box | undefined;
    for (const x of boxes(b, from, entry.end)) {
      if (x.type === 'esds') esds = x;
      if (x.type === 'wave') for (const y of boxes(b, x.body, x.end)) if (y.type === 'esds') esds = y;
    }
    const e = esds ? parseEsds(b, esds) : undefined;
    if (!e) return { problem: '原声轨缺少解码器配置（esds）' };
    if (e.oti === 0x69 || e.oti === 0x6b) return { audio: { codec: 'mp3', label: 'MP3', sampleRate: rate, channels } };
    if (e.oti !== 0x40 && e.oti !== 0x66 && e.oti !== 0x67 && e.oti !== 0x68) return { problem: `原声轨的编码不认识（0x${e.oti.toString(16)}）` };
    if (!e.asc) return { problem: '原声的 AAC 轨缺少 AudioSpecificConfig' };
    const a = ascInfo(e.asc);
    return {
      audio: {
        codec: `mp4a.40.${a.aot}`,
        label: a.aot === 2 ? 'AAC' : a.aot === 5 || a.aot === 29 ? 'HE-AAC' : `AAC（类型 ${a.aot}）`,
        sampleRate: a.sampleRate || rate,
        channels: a.channels || channels,
        description: e.asc,
      },
    };
  }
  if (entry.type === 'Opus') {
    let dops: Box | undefined;
    for (const x of boxes(b, from, entry.end)) if (x.type === 'dOps') dops = x;
    if (!dops) return { problem: '原声的 Opus 轨缺少配置（dOps）' };
    return { audio: { codec: 'opus', label: 'Opus', sampleRate: 48000, channels: b[dops.body + 1] || channels, description: opusHeadFromDops(b, dops) } };
  }
  if (entry.type === '.mp3') return { audio: { codec: 'mp3', label: 'MP3', sampleRate: rate, channels } };
  const names: Record<string, string> = { 'ac-3': 'AC-3（杜比）', 'ec-3': 'E-AC-3（杜比）', fLaC: 'FLAC', alac: 'ALAC', 'dtsc': 'DTS' };
  return { problem: `原声是 ${names[entry.type] ?? entry.type} 编码，浏览器解不了` };
}

function parseTrack(b: Uint8Array, trak: Box, movieTimescale: number): Mp4Track | undefined {
  const tkhd = child(b, trak, 'tkhd');
  const mdhd = path(b, trak, 'mdia', 'mdhd');
  const hdlr = path(b, trak, 'mdia', 'hdlr');
  const stbl = path(b, trak, 'mdia', 'minf', 'stbl');
  if (!tkhd || !mdhd || !hdlr || !stbl) return undefined;
  const tv = b[tkhd.body]!;
  const id = u32(b, tkhd.body + (tv === 1 ? 20 : 12));
  const movieDuration = tv === 1 ? u64(b, tkhd.body + 28) : u32(b, tkhd.body + 20);
  const mv = b[mdhd.body]!;
  const timescale = mv === 1 ? u32(b, mdhd.body + 20) : u32(b, mdhd.body + 12);
  const mediaDuration = mv === 1 ? u64(b, mdhd.body + 24) : u32(b, mdhd.body + 16);
  const handler = tag(b, hdlr.body + 8);
  const packed = u16(b, mdhd.body + (mv === 1 ? 32 : 20));
  const letters = [(packed >> 10) & 31, (packed >> 5) & 31, packed & 31];
  const language = letters.every((x) => x >= 1 && x <= 26) ? String.fromCharCode(...letters.map((x) => x + 0x60)) : 'und';
  if (!timescale) return undefined;

  const stsd = child(b, stbl, 'stsd');
  const entry = stsd ? (boxes(b, stsd.body + 8, stsd.end).next().value as Box | undefined) : undefined;
  const stsz = child(b, stbl, 'stsz');
  const stsc = child(b, stbl, 'stsc');
  const stts = child(b, stbl, 'stts');
  const stco = child(b, stbl, 'stco') ?? child(b, stbl, 'co64');
  if (!entry || !stsz || !stsc || !stts || !stco) return undefined;

  const fixed = u32(b, stsz.body + 4);
  const count = u32(b, stsz.body + 8);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || u32(b, stsz.body + 12 + i * 4);

  const chunkCount = u32(b, stco.body + 4);
  const co64 = stco.type === 'co64';
  const chunkOffset = (c: number) => (co64 ? u64(b, stco.body + 8 + c * 8) : u32(b, stco.body + 8 + c * 4));
  const runs: { first: number; per: number }[] = [];
  const stscN = u32(b, stsc.body + 4);
  for (let i = 0; i < stscN; i++) runs.push({ first: u32(b, stsc.body + 8 + i * 12) - 1, per: u32(b, stsc.body + 12 + i * 12) });
  const offsets = new Float64Array(count);
  const chunks: Mp4Chunk[] = [];
  let s = 0;
  for (let r = 0; r < runs.length && s < count; r++) {
    const last = r + 1 < runs.length ? runs[r + 1]!.first : chunkCount;
    for (let c = runs[r]!.first; c < last && s < count; c++) {
      const start = chunkOffset(c);
      let off = start;
      const firstSample = s;
      for (let k = 0; k < runs[r]!.per && s < count; k++) {
        offsets[s] = off;
        off += sizes[s]!;
        s++;
      }
      chunks.push({ offset: start, size: off - start, firstSample, samples: s - firstSample });
    }
  }
  if (s < count) throw new Mp4Error('这个 MP4 的索引对不上（样本表与分块表不一致）', '文件可能损坏：重新取得一份再试。');

  const dts = new Float64Array(count);
  const sttsN = u32(b, stts.body + 4);
  let t = 0;
  let k = 0;
  for (let i = 0; i < sttsN && k < count; i++) {
    const n = u32(b, stts.body + 8 + i * 8);
    const delta = u32(b, stts.body + 12 + i * 8);
    for (let j = 0; j < n && k < count; j++) {
      dts[k++] = t;
      t += delta;
    }
  }
  for (; k < count; k++) dts[k] = t;

  let editEmpty = 0;
  let editStart = 0;
  const elst = path(b, trak, 'edts', 'elst');
  if (elst) {
    const ev = b[elst.body]!;
    const n = u32(b, elst.body + 4);
    for (let i = 0; i < n; i++) {
      const at = elst.body + 8 + i * (ev === 1 ? 20 : 12);
      const segment = ev === 1 ? u64(b, at) : u32(b, at);
      const mediaTime = ev === 1 ? (u32(b, at + 8) === 0xffffffff ? -1 : u64(b, at + 8)) : i32(b, at + 4);
      // 开头的空白段（media_time = −1）之后的第一段有内容的
      if (mediaTime < 0) editEmpty += segment;
      else {
        editStart = mediaTime;
        break;
      }
    }
  }

  const track: Mp4Track = {
    id,
    handler,
    language,
    timescale,
    mediaDuration: mediaDuration || t,
    movieDuration: movieDuration || Math.round(((mediaDuration || t) / timescale) * movieTimescale),
    entry: entry.type,
    count,
    sizes,
    offsets,
    dts,
    chunks,
    editEmpty,
    editStart,
    trak: { start: trak.start, end: trak.end },
  };
  if (handler === 'vide') {
    track.width = u16(b, entry.body + 24);
    track.height = u16(b, entry.body + 26);
  } else if (handler === 'soun') {
    const a = audioInfo(b, entry);
    if (a.audio) track.audio = a.audio;
    else track.audioProblem = a.problem ?? '原声轨认不出来';
  }
  return track;
}

/** 解析 moov：各条轨的样本表。moov 是整个 moov 盒子的字节 */
export function parseMovie(moov: Uint8Array): Mp4Movie {
  const root: Box = { type: 'root', start: 0, body: 0, end: moov.length };
  const mv = child(moov, root, 'moov');
  const mvhd = mv ? child(moov, mv, 'mvhd') : undefined;
  if (!mv || !mvhd) throw new Mp4Error('这个 MP4 的索引（moov）读不出来', '文件可能损坏：重新取得一份再试。');
  const v = moov[mvhd.body]!;
  const timescale = v === 1 ? u32(moov, mvhd.body + 20) : u32(moov, mvhd.body + 12);
  const duration = v === 1 ? u64(moov, mvhd.body + 24) : u32(moov, mvhd.body + 16);
  const nextTrackId = u32(moov, mvhd.end - 4);
  if (!timescale) throw new Mp4Error('这个 MP4 的时间单位是 0，读不出时长');
  const tracks: Mp4Track[] = [];
  for (const x of boxes(moov, mv.body, mv.end)) {
    if (x.type !== 'trak') continue;
    const t = parseTrack(moov, x, timescale);
    if (t) tracks.push(t);
  }
  return { timescale, duration, nextTrackId, tracks, fragmented: !!child(moov, mv, 'mvex') };
}

export interface Mp4Source {
  movie: Mp4Movie;
  video: Mp4Track;
  audio: Mp4Track & { audio: Mp4AudioInfo };
  /** 嵌在文件里的字幕轨（只认 MP4 自己的文字字幕 tx3g）；章节轨不算 */
  subtitles: Mp4Track[];
  /** 画面一共多长（秒）：新文件的时长 */
  durationSec: number;
}

const VIDEO_LABELS: Record<string, string> = { avc1: 'H.264', avc3: 'H.264', hvc1: 'H.265', hev1: 'H.265', vp09: 'VP9', av01: 'AV1', mp4v: 'MPEG-4' };

/** 画面编码给人看的名字 */
export const videoCodecLabel = (entry: string): string => VIDEO_LABELS[entry] ?? entry;

/** 一条轨在片子时间轴上的时长（秒） */
export function trackSeconds(movie: Mp4Movie, t: Mp4Track): number {
  return t.movieDuration / movie.timescale;
}

/** 挑出要用的画面轨和原声轨；不能用的情况说清楚 */
export function pickSource(movie: Mp4Movie): Mp4Source {
  if (movie.fragmented || movie.tracks.every((t) => t.count === 0)) throw new Mp4Error('这是分片 MP4（fragmented），这里处理不了', REMUX_HINT);
  const video = movie.tracks.find((t) => t.handler === 'vide' && t.count > 0);
  if (!video) throw new Mp4Error('这个文件里没有画面：选的是不是只有声音的文件？', '需要带画面和原声的原视频（MP4）。');
  const sounds = movie.tracks.filter((t) => t.handler === 'soun' && t.count > 0);
  if (!sounds.length) throw new Mp4Error('这个文件里没有声音：选的是不是只有画面的那一份？', '双语视频要用原声（降到 80%）：需要带原声的原视频。');
  const audio = sounds.find((t) => t.audio);
  if (!audio?.audio) throw new Mp4Error(sounds[0]!.audioProblem ?? '原声轨认不出来', '把原声转成 AAC 再试：ffmpeg -i 原文件 -c:v copy -c:a aac 新文件.mp4');
  if (audio.audio.channels > 2) throw new Mp4Error(`原声是 ${audio.audio.channels} 声道（环绕声），这里只处理单声道和立体声`, '把原声转成立体声再试：ffmpeg -i 原文件 -c:v copy -ac 2 新文件.mp4');
  const durationSec = trackSeconds(movie, video);
  if (!(durationSec > 0)) throw new Mp4Error('读不出这个视频的时长');
  const subtitles = movie.tracks.filter((t) => t.handler === 'sbtl' && t.entry === 'tx3g' && t.count > 0);
  return { movie, video, audio: audio as Mp4Source['audio'], subtitles, durationSec };
}

// ── 写：新文件 ──

/** 编好的新音轨 */
export interface EncodedAudio {
  codec: 'aac' | 'opus';
  /** 交给编码器的采样率与声道数 */
  sampleRate: number;
  channels: number;
  bitrate: number;
  /** AAC 的 AudioSpecificConfig / Opus 的 OpusHead；没有时按采样率和声道数写一个 */
  description?: Uint8Array;
  frames: Uint8Array[];
  /** 每帧多少个样本（按 timescale 算）：AAC 1024；Opus 960（20 毫秒，timescale 固定 48000） */
  frameSamples: number;
  /** 开头要跳过多少个样本（编码器的起始延迟；写进编辑列表） */
  priming: number;
}

export type OutPart = { kind: 'bytes'; bytes: Uint8Array<ArrayBuffer> } | { kind: 'file'; start: number; end: number };

export interface RemuxPlan {
  parts: OutPart[];
  size: number;
  durationSec: number;
}

const IDENTITY = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function ascFor(sampleRate: number, channels: number): Uint8Array {
  const fi = Math.max(0, AAC_RATES.indexOf(sampleRate));
  return new Uint8Array([(2 << 3) | (fi >> 1), ((fi & 1) << 7) | (channels << 3)]);
}

function descriptor(tagByte: number, body: Uint8Array): Uint8Array {
  const w = new Writer().u8(tagByte);
  // 长度固定写成 4 字节（高位续位），播放器都认
  w.u8(0x80 | ((body.length >>> 21) & 0x7f)).u8(0x80 | ((body.length >>> 14) & 0x7f)).u8(0x80 | ((body.length >>> 7) & 0x7f)).u8(body.length & 0x7f);
  return w.bytes(body).done();
}

function audioSampleEntry(a: EncodedAudio, timescale: number): Uint8Array {
  const head = new Writer().zeros(6).u16(1).zeros(8).u16(a.channels).u16(16).u16(0).u16(0).u32((timescale & 0xffff) * 65536);
  if (a.codec === 'aac') {
    const asc = a.description?.length ? a.description : ascFor(a.sampleRate, a.channels);
    const dcd = new Writer().u8(0x40).u8(0x15).u8(0).u16(0).u32(a.bitrate).u32(a.bitrate).bytes(descriptor(0x05, asc)).done();
    const es = new Writer().u16(0).u8(0).bytes(descriptor(0x04, dcd)).bytes(descriptor(0x06, new Uint8Array([2]))).done();
    return box('mp4a', head.done(), fullBox('esds', 0, 0, descriptor(0x03, es)));
  }
  // Opus：OpusHead（小端）→ dOps（大端）
  const h = a.description;
  const hasHead = !!h && h.length >= 19 && String.fromCharCode(...h.subarray(0, 8)) === 'OpusHead';
  const channels = hasHead ? h[9]! : a.channels;
  const preSkip = hasHead ? h[10]! | (h[11]! << 8) : 312;
  const inputRate = hasHead ? (h[12]! | (h[13]! << 8) | (h[14]! << 16) | (h[15]! << 24)) >>> 0 : a.sampleRate;
  const gain = hasHead ? h[16]! | (h[17]! << 8) : 0;
  const family = hasHead ? h[18]! : 0;
  const d = new Writer().u8(0).u8(channels).u16(preSkip).u32(inputRate).u16(gain).u8(family);
  if (hasHead && family !== 0) d.bytes(h.subarray(19));
  return box('Opus', head.done(), box('dOps', d.done()));
}

interface AudioLayout {
  timescale: number;
  /** 每块多少帧 */
  perChunk: number;
  chunkCount: number;
}

function audioTrak(a: EncodedAudio, lay: AudioLayout, id: number, movieTimescale: number, movieDuration: number, chunkOffsets: Float64Array): Uint8Array {
  const n = a.frames.length;
  const mediaDuration = n * a.frameSamples;
  const tkhd = new Writer().u32(0).u32(0).u32(id).u32(0).u32(movieDuration).zeros(8).u16(0).u16(1).u16(0x0100).u16(0);
  for (const m of IDENTITY) tkhd.u32(m);
  tkhd.u32(0).u32(0);
  const elst = new Writer().u32(1).u32(movieDuration).u32(a.priming).u32(0x00010000);
  const mdhd = new Writer().u32(0).u32(0).u32(lay.timescale).u32(mediaDuration).u16(0x55c4).u16(0);
  const hdlr = new Writer().u32(0).str('soun').zeros(12).str('TubeMuse bilingual mix').u8(0);
  const stsd = new Writer().u32(1).bytes(audioSampleEntry(a, lay.timescale));
  const stts = new Writer().u32(1).u32(n).u32(a.frameSamples);
  // 每块 perChunk 帧，最后一块可能少几帧
  const lastCount = n - (lay.chunkCount - 1) * lay.perChunk;
  const stsc = new Writer();
  if (lay.chunkCount > 1 && lastCount !== lay.perChunk) stsc.u32(2).u32(1).u32(lay.perChunk).u32(1).u32(lay.chunkCount).u32(lastCount).u32(1);
  else stsc.u32(1).u32(1).u32(lay.chunkCount > 1 ? lay.perChunk : n).u32(1);
  const stsz = new Writer().u32(0).u32(n);
  for (const f of a.frames) stsz.u32(f.length);
  const co64 = new Writer().u32(chunkOffsets.length);
  for (const o of chunkOffsets) co64.u64(o);
  const stbl = box('stbl', fullBox('stsd', 0, 0, stsd.done()), fullBox('stts', 0, 0, stts.done()), fullBox('stsc', 0, 0, stsc.done()), fullBox('stsz', 0, 0, stsz.done()), fullBox('co64', 0, 0, co64.done()));
  const dinf = box('dinf', fullBox('dref', 0, 0, new Writer().u32(1).bytes(fullBox('url ', 0, 1, new Uint8Array(0))).done()));
  const minf = box('minf', fullBox('smhd', 0, 0, new Uint8Array(4)), dinf, stbl);
  const mdia = box('mdia', fullBox('mdhd', 0, 0, mdhd.done()), fullBox('hdlr', 0, 0, hdlr.done()), minf);
  return box('trak', fullBox('tkhd', 0, 3, tkhd.done()), box('edts', fullBox('elst', 0, 0, elst.done())), mdia);
}

/** 要写进新文件的字幕轨（MP4 的文字字幕 tx3g：播放器里可以开关的那种） */
export interface TextTrackInput {
  /** 首尾相接、铺满全片的样本：显示多久（timescale 单位）和它的字节（2 字节长度 + UTF-8 文字） */
  samples: { duration: number; bytes: Uint8Array }[];
  timescale: number;
  /** 三个小写字母的语言代码（eng、zho…；und = 未指明） */
  language: string;
  /** 播放器字幕菜单里显示的名字 */
  name: string;
}

/** 字幕轨每块放多少个样本 */
const TEXT_SAMPLES_PER_CHUNK = 16;

function textTrak(t: TextTrackInput, id: number, movieTimescale: number, movieDuration: number, video: Pick<Mp4Track, 'width' | 'height'>, chunkOffsets: Float64Array): Uint8Array {
  const n = t.samples.length;
  const vw = video.width || 1280;
  const vh = video.height || 720;
  // 字幕占画面底部的一条：字号按画面高度定，留两行的地方（认这些参数的主要是 QuickTime / 苹果的播放器；VLC、mpv 按自己的设置排）
  const fontSize = Math.max(16, Math.min(96, Math.round(vh * 0.045)));
  const boxH = Math.min(vh, Math.round((fontSize * 2.6) / 2) * 2);
  const mediaDuration = t.samples.reduce((sum, x) => sum + x.duration, 0);
  const tkhd = new Writer().u32(0).u32(0).u32(id).u32(0).u32(movieDuration).zeros(8).u16(0).u16(2).u16(0).u16(0);
  // 平移到画面底部
  for (const m of [0x00010000, 0, 0, 0, 0x00010000, 0, 0, (vh - boxH) * 65536, 0x40000000]) tkhd.u32(m);
  tkhd.u32(vw * 65536).u32(boxH * 65536);
  const lang = /^[a-z]{3}$/.test(t.language) ? t.language : 'und';
  const packed = ((lang.charCodeAt(0) - 0x60) << 10) | ((lang.charCodeAt(1) - 0x60) << 5) | (lang.charCodeAt(2) - 0x60);
  const mdhd = new Writer().u32(0).u32(0).u32(t.timescale).u32(mediaDuration).u16(packed).u16(0);
  const hdlr = new Writer().u32(0).str('sbtl').zeros(12).bytes(new TextEncoder().encode(t.name)).u8(0);
  const font = 'Sans-Serif';
  const ftab = box('ftab', new Writer().u16(1).u16(1).u8(font.length).str(font).done());
  const tx3g = box(
    'tx3g',
    new Writer()
      .zeros(6)
      .u16(1)
      // 显示标志 0；水平居中（1）、垂直靠下（−1）；背景透明
      .u32(0)
      .u8(1)
      .u8(0xff)
      .u32(0)
      // 文字框：上、左、下、右
      .u16(0)
      .u16(0)
      .u16(boxH)
      .u16(vw)
      // 默认样式：字体 1、常规、字号、白色不透明
      .u16(0)
      .u16(0)
      .u16(1)
      .u8(0)
      .u8(fontSize)
      .u32(0xffffffff)
      .done(),
    ftab,
  );
  // 时长相同的相邻样本合成一条
  const runs: [number, number][] = [];
  for (const x of t.samples) {
    const last = runs[runs.length - 1];
    if (last && last[1] === x.duration) last[0]++;
    else runs.push([1, x.duration]);
  }
  const stts = new Writer().u32(runs.length);
  for (const [count, delta] of runs) stts.u32(count).u32(delta);
  const chunkCount = chunkOffsets.length;
  const lastCount = n - (chunkCount - 1) * TEXT_SAMPLES_PER_CHUNK;
  const stsc = new Writer();
  if (chunkCount > 1 && lastCount !== TEXT_SAMPLES_PER_CHUNK) stsc.u32(2).u32(1).u32(TEXT_SAMPLES_PER_CHUNK).u32(1).u32(chunkCount).u32(lastCount).u32(1);
  else stsc.u32(1).u32(1).u32(chunkCount > 1 ? TEXT_SAMPLES_PER_CHUNK : n).u32(1);
  const stsz = new Writer().u32(0).u32(n);
  for (const x of t.samples) stsz.u32(x.bytes.length);
  const co64 = new Writer().u32(chunkCount);
  for (const o of chunkOffsets) co64.u64(o);
  const stbl = box('stbl', fullBox('stsd', 0, 0, new Writer().u32(1).bytes(tx3g).done()), fullBox('stts', 0, 0, stts.done()), fullBox('stsc', 0, 0, stsc.done()), fullBox('stsz', 0, 0, stsz.done()), fullBox('co64', 0, 0, co64.done()));
  const dinf = box('dinf', fullBox('dref', 0, 0, new Writer().u32(1).bytes(fullBox('url ', 0, 1, new Uint8Array(0))).done()));
  const minf = box('minf', fullBox('nmhd', 0, 0, new Uint8Array(0)), dinf, stbl);
  const mdia = box('mdia', fullBox('mdhd', 0, 0, mdhd.done()), fullBox('hdlr', 0, 0, hdlr.done()), minf);
  // 标志 3：这条轨默认开着（播放器里可以关）
  return box('trak', fullBox('tkhd', 0, 3, tkhd.done()), mdia);
}

/** 画面轨原样照搬：只把分块位置表换成新的（一律写成 64 位的 co64），去掉指向别的轨的引用（tref） */
function videoTrak(moov: Uint8Array, t: Mp4Track, chunkOffsets: Float64Array): Uint8Array {
  const co64 = new Writer().u32(chunkOffsets.length);
  for (const o of chunkOffsets) co64.u64(o);
  const replaced = fullBox('co64', 0, 0, co64.done());
  const containers = new Set(['trak', 'mdia', 'minf', 'stbl']);
  const rebuild = (b: Box): Uint8Array => {
    const parts: Uint8Array[] = [];
    for (const c of boxes(moov, b.body, b.end)) {
      if (b.type === 'trak' && c.type === 'tref') continue;
      if (b.type === 'stbl' && (c.type === 'stco' || c.type === 'co64')) parts.push(replaced);
      else if (containers.has(c.type)) parts.push(rebuild(c));
      else parts.push(moov.subarray(c.start, c.end));
    }
    return box(b.type, ...parts);
  };
  return rebuild({ type: 'trak', start: t.trak.start, body: t.trak.start + 8, end: t.trak.end });
}

function mvhdFor(moov: Uint8Array, duration: number, nextTrackId: number): Uint8Array {
  const root: Box = { type: 'root', start: 0, body: 0, end: moov.length };
  const mvhd = path(moov, root, 'moov', 'mvhd')!;
  const out = moov.slice(mvhd.start, mvhd.end);
  const body = mvhd.body - mvhd.start;
  const w = (o: number, v: number) => {
    out[o] = (v >>> 24) & 0xff;
    out[o + 1] = (v >>> 16) & 0xff;
    out[o + 2] = (v >>> 8) & 0xff;
    out[o + 3] = v & 0xff;
  };
  if (out[body] === 1) {
    w(body + 24, Math.floor(duration / 2 ** 32));
    w(body + 28, duration % 2 ** 32);
  } else w(body + 16, duration);
  w(out.length - 4, nextTrackId);
  return out;
}

/** 新音轨每块放多久的帧（秒）：和画面的块交错着放，播放器读起来顺 */
const AUDIO_CHUNK_SEC = 0.5;

/**
 * 排出新文件：ftyp + moov（索引在前，打开就能放）+ mdat（画面的块原样照搬，和新音轨的块按时间交错）。
 * 画面的数据用"原文件的第几个字节到第几个字节"表示，不读进内存
 */
export function buildRemux(top: Mp4Top, src: Pick<Mp4Source, 'movie' | 'video' | 'durationSec'>, audio: EncodedAudio, text?: TextTrackInput): RemuxPlan {
  const { movie, video } = src;
  if (!audio.frames.length) throw new Mp4Error('新音轨是空的，没法写文件');
  const timescale = audio.codec === 'opus' ? 48000 : audio.sampleRate;
  const perChunk = Math.max(1, Math.round((AUDIO_CHUNK_SEC * timescale) / audio.frameSamples));
  const lay: AudioLayout = { timescale, perChunk, chunkCount: Math.ceil(audio.frames.length / perChunk) };
  const movieDuration = Math.round(src.durationSec * movie.timescale);

  // 各条轨的块按开始时间排（同一时刻画面在前，其次声音，再是字幕）
  interface Item {
    at: number;
    /** 0 = 画面，1 = 声音，2 = 字幕 */
    kind: 0 | 1 | 2;
    index: number;
    size: number;
  }
  const items: Item[] = [];
  video.chunks.forEach((c, i) => items.push({ at: (video.dts[c.firstSample] ?? 0) / video.timescale, kind: 0, index: i, size: c.size }));
  const audioChunks: Uint8Array<ArrayBuffer>[] = [];
  for (let c = 0; c < lay.chunkCount; c++) {
    const frames = audio.frames.slice(c * perChunk, (c + 1) * perChunk);
    const bytes = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let o = 0;
    for (const f of frames) {
      bytes.set(f, o);
      o += f.length;
    }
    audioChunks.push(bytes);
    items.push({ at: Math.max(0, (c * perChunk * audio.frameSamples - audio.priming) / timescale), kind: 1, index: c, size: bytes.length });
  }
  const textChunks: Uint8Array<ArrayBuffer>[] = [];
  if (text?.samples.length) {
    let at = 0;
    for (let c = 0; c * TEXT_SAMPLES_PER_CHUNK < text.samples.length; c++) {
      const group = text.samples.slice(c * TEXT_SAMPLES_PER_CHUNK, (c + 1) * TEXT_SAMPLES_PER_CHUNK);
      const bytes = new Uint8Array(group.reduce((n, x) => n + x.bytes.length, 0));
      let o = 0;
      for (const x of group) {
        bytes.set(x.bytes, o);
        o += x.bytes.length;
      }
      textChunks.push(bytes);
      items.push({ at: at / text.timescale, kind: 2, index: c, size: bytes.length });
      at += group.reduce((n, x) => n + x.duration, 0);
    }
  }
  items.sort((x, y) => x.at - y.at || x.kind - y.kind || x.index - y.index);

  const videoOffsets = new Float64Array(video.chunks.length);
  const audioOffsets = new Float64Array(lay.chunkCount);
  const textOffsets = new Float64Array(textChunks.length);
  // 先按位置 0 写一遍 moov 量出它多长（co64 的长度不随数值变），再填真正的位置
  const makeMoov = () => {
    const root: Box = { type: 'root', start: 0, body: 0, end: top.moov.length };
    const mv = child(top.moov, root, 'moov')!;
    const udta = child(top.moov, mv, 'udta');
    const audioId = Math.max(movie.nextTrackId, ...movie.tracks.map((t) => t.id + 1));
    return box(
      'moov',
      mvhdFor(top.moov, movieDuration, audioId + (textChunks.length ? 2 : 1)),
      videoTrak(top.moov, video, videoOffsets),
      audioTrak(audio, lay, audioId, movie.timescale, movieDuration, audioOffsets),
      ...(text && textChunks.length ? [textTrak(text, audioId + 1, movie.timescale, movieDuration, video, textOffsets)] : []),
      ...(udta ? [top.moov.subarray(udta.start, udta.end)] : []),
    );
  };
  const dataSize = items.reduce((n, x) => n + x.size, 0);
  const headSize = top.ftyp.length + makeMoov().length + 16;
  let o = headSize;
  for (const x of items) {
    (x.kind === 0 ? videoOffsets : x.kind === 1 ? audioOffsets : textOffsets)[x.index] = o;
    o += x.size;
  }
  const mdatHead = new Writer().u32(1).str('mdat').u64(16 + dataSize).done();
  const parts: OutPart[] = [{ kind: 'bytes', bytes: new Uint8Array(top.ftyp) }, { kind: 'bytes', bytes: new Uint8Array(makeMoov()) }, { kind: 'bytes', bytes: mdatHead }];
  for (const x of items) {
    if (x.kind !== 0) {
      parts.push({ kind: 'bytes', bytes: (x.kind === 1 ? audioChunks : textChunks)[x.index]! });
      continue;
    }
    const c = video.chunks[x.index]!;
    const last = parts[parts.length - 1]!;
    // 原文件里紧挨着的两块：并成一段
    if (last.kind === 'file' && last.end === c.offset) last.end = c.offset + c.size;
    else parts.push({ kind: 'file', start: c.offset, end: c.offset + c.size });
  }
  return { parts, size: headSize + dataSize, durationSec: src.durationSec };
}

/** 把排好的各段拼成字节（测试用；真正导出时由调用方拼成 Blob，画面那几段直接引用原文件） */
export async function assembleRemux(plan: RemuxPlan, read: FileRead): Promise<Uint8Array> {
  const out = new Uint8Array(plan.size);
  let o = 0;
  for (const p of plan.parts) {
    const bytes = p.kind === 'bytes' ? p.bytes : await read(p.start, p.end);
    out.set(bytes, o);
    o += bytes.length;
  }
  return out;
}
