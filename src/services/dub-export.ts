// 保存完整双语视频（用户 2026-11-16 选定的做法，见 DECISIONS §83）：你提供原视频文件（MP4），在本机离线合成。
// 只在扩展自己的页面（侧边栏）里跑：用浏览器自带的音频解码器 / 编码器（WebCodecs），不播放、不联网、不经过 YouTube 页面。
//   1. 读出原视频的索引（core/mp4-remux.ts）；画面轨的数据一个字节都不读进来。
//   2. 原声轨解码成波形；中文配音（扩展自己的 IndexedDB 里那份 m4a）按对齐摊开的每一段解码，
//      快速对齐时变速不变调，再换到原声的采样率（core/dub-render.ts）。
//   3. 一秒一秒地混：原声 × 80% + 中文，过软限幅，交给编码器（能编 AAC 就用 AAC，不能时用 Opus）。
//   4. 写新文件：索引 + 原文件里的画面数据（直接引用你选的那个文件，不复制进内存）+ 新音轨。
// 整个过程占的内存只有几秒钟的声音；耗时主要是音频的解码和编码，比视频时长短得多。

import { DUB } from '../config/defaults';
import { dubAlignment, type DubAlignment } from '../core/dub-align';
import type { DubMap } from '../core/dub';
import { PIECE_FADE_SEC, StreamResampler, TimeStretcher, mixBlock, pieceFade, renderPieces, type RenderPiece } from '../core/dub-render';
import {
  Mp4Error,
  buildRemux,
  parseMovie,
  pickSource,
  readMp4Top,
  trackSeconds,
  videoCodecLabel,
  type EncodedAudio,
  type FileRead,
  type Mp4AudioInfo,
  type Mp4Source,
  type Mp4Top,
  type Mp4Track,
} from '../core/mp4-remux';

type AudioTrack = Mp4Track & { audio: Mp4AudioInfo };

const readerOf =
  (blob: Blob): FileRead =>
  async (start, end) =>
    new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer());

export class ExportCancelled extends Error {
  constructor() {
    super('已取消');
    this.name = 'ExportCancelled';
  }
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExportCancelled();
}

/** 让出一下，让解码器 / 编码器的结果进来（不用 setTimeout：连着用会被浏览器拖到每次 4 毫秒） */
const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : undefined;
const waiting: (() => void)[] = [];
if (channel) channel.port1.onmessage = () => waiting.shift()?.();
function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    if (!channel) return void setTimeout(resolve, 0);
    waiting.push(resolve);
    channel.port2.postMessage(0);
  });
}

/** 等这个解码器 / 编码器消化掉一些（或者 50 毫秒，哪个先到） */
function settle(target: EventTarget): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      target.removeEventListener('dequeue', done);
      resolve();
    };
    const timer = setTimeout(done, 50);
    target.addEventListener('dequeue', done);
  });
}

// ── 你选的原视频 ──

export interface SourceProbe {
  top: Mp4Top;
  source: Mp4Source;
  durationSec: number;
  video: { label: string; width: number; height: number };
  audio: { label: string; sampleRate: number; channels: number };
}

/** 能不能在这个浏览器里做（要有音频解码器和编码器） */
export function exportSupported(): boolean {
  return typeof AudioDecoder === 'function' && typeof AudioEncoder === 'function' && typeof AudioData === 'function';
}

function decoderConfig(a: Mp4AudioInfo): AudioDecoderConfig {
  return { codec: a.codec, sampleRate: a.sampleRate, numberOfChannels: a.channels, ...(a.description ? { description: a.description } : {}) };
}

async function canDecode(a: Mp4AudioInfo): Promise<boolean> {
  try {
    return (await AudioDecoder.isConfigSupported(decoderConfig(a))).supported === true;
  } catch {
    return false;
  }
}

/** 读你选的原视频：是不是能用的 MP4、多长、画面和原声是什么编码。只读索引，不读画面数据 */
export async function probeSource(file: Blob): Promise<SourceProbe> {
  if (!exportSupported()) throw new Mp4Error('这个浏览器没有音频编解码接口（WebCodecs），做不了离线合成', '请用最新版 Google Chrome 或 Firefox。');
  const top = await readMp4Top(readerOf(file), file.size);
  const source = pickSource(parseMovie(top.moov));
  if (!(await canDecode(source.audio.audio))) {
    throw new Mp4Error(`这个浏览器解不了原视频的声音（${source.audio.audio.label}）`, '把原声转成 AAC 再试：ffmpeg -i 原文件 -c:v copy -c:a aac 新文件.mp4');
  }
  return {
    top,
    source,
    durationSec: source.durationSec,
    video: { label: videoCodecLabel(source.video.entry), width: source.video.width ?? 0, height: source.video.height ?? 0 },
    audio: { label: source.audio.audio.label, sampleRate: source.audio.audio.sampleRate, channels: source.audio.audio.channels },
  };
}

// ── 解码一条音轨的一段 ──

interface Pcm {
  chs: Float32Array[];
  rate: number;
  /** 第一个样本的媒体时间（秒） */
  at: number;
}

/** 把一条音轨的第 from 到第 to 帧顺序解码出来；pull() 一次给一小块，解完给 null */
class TrackDecoder {
  private readonly dec: AudioDecoder;
  private readonly out: Pcm[] = [];
  private error: Error | undefined;
  private next: number;
  private flushed = false;
  private closed = false;

  constructor(
    private readonly read: FileRead,
    private readonly track: AudioTrack,
    from: number,
    private readonly to: number,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.next = Math.max(0, from);
    this.dec = new AudioDecoder({
      output: (d) => {
        try {
          const chs: Float32Array[] = [];
          for (let c = 0; c < d.numberOfChannels; c++) {
            const x = new Float32Array(d.numberOfFrames);
            d.copyTo(x, { planeIndex: c, format: 'f32-planar' });
            chs.push(x);
          }
          if (d.numberOfFrames > 0) this.out.push({ chs, rate: d.sampleRate, at: d.timestamp / 1e6 });
        } catch (e) {
          this.error = e instanceof Error ? e : new Error(String(e));
        } finally {
          d.close();
        }
      },
      error: (e) => {
        this.error = new Mp4Error(`声音解码出错（${track.audio.label}）：${e.message}`, '文件可能损坏；或者把声音转成 AAC 再试。');
      },
    });
    this.dec.configure(decoderConfig(track.audio));
  }

  /** 读进来的一窗：原文件的 [winStart, winStart + win.length) */
  private win: Uint8Array = new Uint8Array(0);
  private winStart = 0;

  /**
   * 喂一小批。声音在原视频里是和画面交错着放的（每隔一两帧声音就夹一段画面），一帧一帧去读要读几万次、慢得很；
   * 所以一次读一大窗（把中间夹着的画面也读进来，用完就丢），这一窗里的声音帧都从内存里取
   */
  private async feed(): Promise<void> {
    const t = this.track;
    const first = this.next;
    const start = t.offsets[first]!;
    const size = t.sizes[first]!;
    if (start < this.winStart || start + size > this.winStart + this.win.length) {
      // 最多读到这一段要用的最后一帧为止（配音的一小段不用读 4 MB）
      const lastEnd = t.offsets[this.to - 1]! + t.sizes[this.to - 1]!;
      const end = Math.max(start + size, Math.min(start + DUB.export.readWindowBytes, lastEnd > start ? lastEnd : start + size));
      this.win = await this.read(start, end);
      this.winStart = start;
      if (this.win.length < size) throw new Mp4Error('原文件读到一半没有了', '文件可能没下载完，或者在合成过程中被挪走了。');
    }
    let i = first;
    for (; i < this.to && i - first < 64; i++) {
      const o = t.offsets[i]! - this.winStart;
      if (o < 0 || o + t.sizes[i]! > this.win.length) break;
      const dur = (i + 1 < t.count ? t.dts[i + 1]! : t.mediaDuration) - t.dts[i]!;
      this.dec.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round((t.dts[i]! / t.timescale) * 1e6),
          duration: Math.max(0, Math.round((dur / t.timescale) * 1e6)),
          data: this.win.subarray(o, o + t.sizes[i]!),
        }),
      );
    }
    this.next = i;
  }

  async pull(): Promise<Pcm | null> {
    for (;;) {
      checkAbort(this.signal);
      if (this.error) throw this.error;
      const ready = this.out.shift();
      if (ready) return ready;
      if (this.next < this.to) {
        if (this.dec.decodeQueueSize > 48) await settle(this.dec);
        else {
          await this.feed();
          await yieldTask();
        }
      } else if (!this.flushed) {
        this.flushed = true;
        await this.dec.flush();
      } else return null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.dec.close();
    } catch {
      // 已经关了
    }
  }
}

/** 攒着解码出来的小块，按需要的个数取：不够时返回的短一些 */
class Blocks {
  private readonly q: Float32Array[][] = [];
  private head = 0;
  size = 0;
  push(chs: Float32Array[]): void {
    if (!chs[0]?.length) return;
    this.q.push(chs);
    this.size += chs[0].length;
  }
  /** 取走最多 n 个样本，写进 dst 的 at 处（dst 的声道数可以和来源不同：多的丢掉、少的重复） */
  take(dst: Float32Array[], at: number, n: number): number {
    let done = 0;
    while (done < n && this.q.length) {
      const b = this.q[0]!;
      const k = Math.min(n - done, b[0]!.length - this.head);
      for (let c = 0; c < dst.length; c++) dst[c]!.set(b[Math.min(c, b.length - 1)]!.subarray(this.head, this.head + k), at + done);
      this.head += k;
      done += k;
      if (this.head >= b[0]!.length) {
        this.q.shift();
        this.head = 0;
      }
    }
    this.size -= done;
    return done;
  }
  skip(n: number): number {
    let done = 0;
    while (done < n && this.q.length) {
      const k = Math.min(n - done, this.q[0]![0]!.length - this.head);
      this.head += k;
      done += k;
      if (this.head >= this.q[0]![0]!.length) {
        this.q.shift();
        this.head = 0;
      }
    }
    this.size -= done;
    return done;
  }
}

/** 第一帧的解码时间不晚于 units 的那一帧 */
function frameAt(t: Mp4Track, units: number): number {
  let lo = 0;
  let hi = t.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t.dts[mid]! <= units) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 这条轨的播放时间 p（秒）对应的媒体时间（秒）：加上编辑列表跳过的开头，减掉开头空出来的 */
function mediaTime(t: Mp4Track, movieTimescale: number, p: number): number {
  return p + t.editStart / t.timescale - t.editEmpty / movieTimescale;
}

// ── 原声：从头到尾顺序读，样本 0 = 视频的 0 秒 ──

class OrigStream {
  private readonly dec: TrackDecoder;
  private readonly blocks = new Blocks();
  private resampler: StreamResampler | undefined;
  private started = false;
  private ended = false;
  /** 开头还要补多少个 0 / 还要丢多少个样本 */
  private lead = 0;
  private drop = 0;
  rate = 0;
  channels = 0;

  constructor(
    read: FileRead,
    private readonly src: Mp4Source,
    signal: AbortSignal | undefined,
  ) {
    this.dec = new TrackDecoder(read, src.audio, 0, src.audio.count, signal);
  }

  /** 解出第一块，知道实际的采样率和声道数（HE-AAC 解出来是标称的两倍） */
  async open(): Promise<void> {
    const first = await this.dec.pull();
    if (!first) throw new Mp4Error('原视频的声音解不出来（一帧都没有）', '文件可能损坏：重新取得一份再试。');
    this.rate = first.rate;
    this.channels = first.chs.length;
    // 这一块第一个样本在视频时间轴上的位置
    const at = first.at - mediaTime(this.src.audio, this.src.movie.timescale, 0);
    const shift = Math.round(at * this.rate);
    if (shift > 0) this.lead = shift;
    else this.drop = -shift;
    this.accept(first.chs);
    this.started = true;
  }

  /** 输出换成另一个采样率（编码器不认原来的采样率时） */
  resampleTo(outRate: number): void {
    if (outRate === this.rate) return;
    this.resampler = new StreamResampler(this.rate, outRate, this.channels);
    // 已经攒着的那一块也要过一遍
    const have = this.blocks.size;
    const pending = Array.from({ length: this.channels }, () => new Float32Array(have));
    this.blocks.take(pending, 0, have);
    this.blocks.push(this.resampler.push(pending));
  }

  private accept(chs: Float32Array[]): void {
    let x = chs;
    if (this.drop > 0) {
      const k = Math.min(this.drop, x[0]!.length);
      x = x.map((c) => c.subarray(k));
      this.drop -= k;
    }
    if (this.lead > 0 && x[0]!.length) {
      const lead = this.lead;
      this.lead = 0;
      x = x.map((c) => {
        const y = new Float32Array(lead + c.length);
        y.set(c, lead);
        return y;
      });
    }
    this.blocks.push(this.resampler ? this.resampler.push(x) : x);
  }

  /** 正好 n 个样本（声道数 = channels）；原声比画面短时后面补 0 */
  async read(n: number, channels: number): Promise<Float32Array[]> {
    if (!this.started) await this.open();
    while (this.blocks.size < n && !this.ended) {
      const p = await this.dec.pull();
      if (p) this.accept(p.chs);
      else {
        this.ended = true;
        if (this.resampler) this.blocks.push(this.resampler.flush());
      }
    }
    const out = Array.from({ length: channels }, () => new Float32Array(n));
    this.blocks.take(out, 0, n);
    return out;
  }

  close(): void {
    this.dec.close();
  }
}

// ── 中文：按对齐摊开的每一段，放到输出的时间轴上 ──

/** 一段中文：解码它用到的那几帧 →（快速对齐时）变速 → 换采样率 → 渐入渐出，顺序给出 total 个样本 */
class PieceStream {
  private readonly dec: TrackDecoder;
  private readonly blocks = new Blocks();
  private readonly total: number;
  private given = 0;
  private stretcher: TimeStretcher | undefined;
  private resampler: StreamResampler | undefined;
  private srcRate = 0;
  private srcLeft = 0;
  /** 第一块开头还要丢多少个样本（给解码器热身的那几帧） */
  private skipLeft = 0;
  private ended = false;
  channels = 1;

  constructor(
    read: FileRead,
    private readonly track: AudioTrack,
    private readonly movieTimescale: number,
    private readonly piece: RenderPiece,
    private readonly outRate: number,
    signal: AbortSignal | undefined,
  ) {
    this.total = piece.outEnd - piece.outStart;
    const m0 = mediaTime(track, movieTimescale, piece.d0);
    const m1 = mediaTime(track, movieTimescale, piece.d1);
    const from = Math.max(0, frameAt(track, m0 * track.timescale) - DUB.export.prerollFrames);
    const to = Math.min(track.count, frameAt(track, m1 * track.timescale) + 2);
    this.dec = new TrackDecoder(read, track, from, to, signal);
  }

  private through(chs: Float32Array[], final: boolean): void {
    let x = chs;
    if (this.stretcher) {
      x = this.stretcher.push(x);
      if (final) x = join(x, this.stretcher.flush());
    }
    if (this.resampler) {
      x = this.resampler.push(x);
      if (final) x = join(x, this.resampler.flush());
    }
    this.blocks.push(x);
  }

  private async more(): Promise<void> {
    const p = await this.dec.pull();
    if (!p) {
      this.ended = true;
      if (this.srcRate) this.through(Array.from({ length: this.channels }, () => new Float32Array(0)), true);
      return;
    }
    let x = p.chs;
    if (!this.srcRate) {
      this.srcRate = p.rate;
      this.channels = x.length;
      this.srcLeft = Math.round((this.piece.d1 - this.piece.d0) * p.rate);
      if (Math.abs(this.piece.rate - 1) > 1e-6) this.stretcher = new TimeStretcher(this.piece.rate, p.rate, x.length);
      if (p.rate !== this.outRate) this.resampler = new StreamResampler(p.rate, this.outRate, x.length);
      // 这一块从哪里开始才是这一段要的（前面是给解码器热身的）
      const skip = Math.round((mediaTime(this.track, this.movieTimescale, this.piece.d0) - p.at) * p.rate);
      if (skip < 0) {
        // 解码器给的比要的晚（文件开头）：前面补 0，位置才对得上
        x = x.map((c) => {
          const y = new Float32Array(c.length - skip);
          y.set(c, -skip);
          return y;
        });
      } else this.skipLeft = skip;
    }
    if (this.skipLeft > 0) {
      const k = Math.min(this.skipLeft, x[0]!.length);
      x = x.map((c) => c.subarray(k));
      this.skipLeft -= k;
    }
    if (x[0]!.length > this.srcLeft) x = x.map((c) => c.subarray(0, this.srcLeft));
    this.srcLeft -= x[0]!.length;
    if (x[0]!.length) this.through(x, false);
    if (this.srcLeft <= 0 && !this.ended) {
      // 这一段要的都有了：后面多解的不要
      this.ended = true;
      this.through(Array.from({ length: this.channels }, () => new Float32Array(0)), true);
    }
  }

  /** 这一段接下来的 n 个样本，写进 dst 的 at 处（不够的地方留 0） */
  async readInto(dst: Float32Array[], at: number, n: number): Promise<void> {
    while (this.blocks.size < n && !this.ended) await this.more();
    const got = this.blocks.take(dst, at, n);
    const fade = Math.round(PIECE_FADE_SEC * this.outRate);
    // 只有开头和结尾那几毫秒要乘：中间的不动
    if (this.given < fade || this.given + n > this.total - fade) {
      for (let i = 0; i < got; i++) {
        const g = pieceFade(this.given + i, this.total, fade);
        if (g < 1) for (const c of dst) c[at + i] = c[at + i]! * g;
      }
    }
    this.given += n;
  }

  get finished(): boolean {
    return this.given >= this.total;
  }

  close(): void {
    this.dec.close();
  }
}

function join(a: Float32Array[], b: Float32Array[]): Float32Array[] {
  return a.map((x, c) => {
    const y = new Float32Array(x.length + b[c]!.length);
    y.set(x);
    y.set(b[c]!, x.length);
    return y;
  });
}

class DubTimeline {
  private index = 0;
  private current: PieceStream | undefined;
  channels = 1;

  constructor(
    private readonly file: FileRead,
    private readonly track: AudioTrack,
    private readonly movieTimescale: number,
    private readonly pieces: RenderPiece[],
    private readonly outRate: number,
    private readonly signal: AbortSignal | undefined,
  ) {}

  /** 输出里 [start, start + n) 这一块的中文；这一块里没有中文时返回 undefined */
  async read(start: number, n: number): Promise<Float32Array[] | undefined> {
    const end = start + n;
    let out: Float32Array[] | undefined;
    while (this.index < this.pieces.length) {
      const p = this.pieces[this.index]!;
      if (p.outStart >= end) break;
      const from = Math.max(start, p.outStart);
      const to = Math.min(end, p.outEnd);
      if (to > from) {
        this.current ??= new PieceStream(this.file, this.track, this.movieTimescale, p, this.outRate, this.signal);
        // 中文是单声道还是立体声，解出第一块才知道：先按立体声留位置，单声道时两边一样
        out ??= [new Float32Array(n), new Float32Array(n)];
        await this.current.readInto(out, from - start, to - from);
        this.channels = this.current.channels;
      }
      if (p.outEnd <= end) {
        this.current?.close();
        this.current = undefined;
        this.index++;
      } else break;
    }
    return out && this.channels === 1 ? [out[0]!] : out;
  }

  close(): void {
    this.current?.close();
  }
}

// ── 编码 ──

interface EncoderChoice {
  codec: 'aac' | 'opus';
  label: string;
  config: AudioEncoderConfig;
}

async function supportedEncoder(choice: EncoderChoice): Promise<boolean> {
  try {
    return (await AudioEncoder.isConfigSupported(choice.config)).supported === true;
  } catch {
    return false;
  }
}

/**
 * 用什么编码、什么采样率：优先 AAC（到处都能放），其次 Opus；采样率先用原声自己的（不用重采样），编码器不认时再试 48000。
 * avoidAac：AAC 编码器刚才中途出过错，这一遍不用它
 */
async function pickOutput(rate: number, channels: number, avoidAac: boolean): Promise<{ rate: number; enc: EncoderChoice } | undefined> {
  const rates = rate === 48000 ? [48000] : [rate, 48000];
  const kinds: ((r: number) => EncoderChoice)[] = [
    (r) => ({ codec: 'aac', label: 'AAC', config: { codec: 'mp4a.40.2', sampleRate: r, numberOfChannels: channels, bitrate: DUB.export.aacBitrate } }),
    (r) => ({ codec: 'opus', label: 'Opus', config: { codec: 'opus', sampleRate: r, numberOfChannels: channels, bitrate: DUB.export.opusBitrate } }),
  ];
  for (const kind of kinds) {
    for (const r of rates) {
      const enc = kind(r);
      if (avoidAac && enc.codec === 'aac') continue;
      if (await supportedEncoder(enc)) return { rate: r, enc };
    }
  }
  return undefined;
}

function planar(chs: Float32Array[]): Float32Array<ArrayBuffer> {
  const n = chs[0]!.length;
  const data = new Float32Array(n * chs.length);
  chs.forEach((c, i) => data.set(c, i * n));
  return data;
}

interface Encoded {
  frames: Uint8Array[];
  description: Uint8Array | undefined;
  /** 第一帧的时长（微秒） */
  frameMicros: number;
}

/** 编码器自己出的错（和文件、解码无关）：AAC 出这种错时改用 Opus 重来一遍 */
class EncoderError extends Mp4Error {}

class Encoder {
  private readonly enc: AudioEncoder;
  private error: Error | undefined;
  readonly result: Encoded = { frames: [], description: undefined, frameMicros: 0 };

  constructor(private readonly choice: EncoderChoice) {
    this.enc = new AudioEncoder({
      output: (chunk, meta) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        this.result.frames.push(bytes);
        if (!this.result.frameMicros && chunk.duration) this.result.frameMicros = chunk.duration;
        const d = meta?.decoderConfig?.description;
        if (d && !this.result.description) this.result.description = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice() : new Uint8Array(d).slice();
      },
      error: (e) => {
        this.error = new EncoderError(`声音编码出错（${choice.label}）：${e.message}`);
      },
    });
    this.enc.configure(choice.config);
  }

  async write(chs: Float32Array[], atSample: number): Promise<void> {
    if (this.error) throw this.error;
    const rate = this.choice.config.sampleRate!;
    const data = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: chs[0]!.length, numberOfChannels: chs.length, timestamp: Math.round((atSample / rate) * 1e6), data: planar(chs) });
    this.enc.encode(data);
    data.close();
    while (this.enc.encodeQueueSize > 4) await settle(this.enc);
  }

  async finish(): Promise<Encoded> {
    await this.enc.flush();
    if (this.error) throw this.error;
    return this.result;
  }

  close(): void {
    try {
      this.enc.close();
    } catch {
      // 已经关了
    }
  }
}

/**
 * AAC 编码器开头会多出一小段（起始延迟），各家不一样（1024、2112 个样本都有）。量一下：编一段固定的噪声再解回来，
 * 看它往后挪了多少个样本——写进新音轨的编辑列表，声音和画面才严丝合缝。量不出来时按常见的 1024 算
 */
export async function measureAacPriming(config: AudioEncoderConfig): Promise<number> {
  const fallback = DUB.export.defaultAacPriming;
  try {
    const rate = config.sampleRate!;
    const channels = config.numberOfChannels!;
    const n = Math.round(rate * 0.5);
    const probe = new Float32Array(n);
    let seed = 12345;
    for (let i = Math.round(rate * 0.05); i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      probe[i] = (seed / 0x7fffffff - 0.5) * 0.5;
    }
    const enc = new Encoder({ codec: 'aac', label: 'AAC', config });
    await enc.write(Array.from({ length: channels }, () => probe), 0);
    const encoded = await enc.finish();
    enc.close();
    if (!encoded.frames.length) return fallback;
    const back: Float32Array[] = [];
    let failed = false;
    const dec = new AudioDecoder({
      output: (d) => {
        const x = new Float32Array(d.numberOfFrames);
        d.copyTo(x, { planeIndex: 0, format: 'f32-planar' });
        back.push(x);
        d.close();
      },
      error: () => {
        failed = true;
      },
    });
    dec.configure({ codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: channels, ...(encoded.description ? { description: encoded.description } : {}) });
    encoded.frames.forEach((f, i) => dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((i * 1024 * 1e6) / rate), data: f })));
    await dec.flush();
    dec.close();
    if (failed || !back.length) return fallback;
    const y = new Float32Array(back.reduce((sum, b) => sum + b.length, 0));
    let filled = 0;
    for (const b of back) {
      y.set(b, filled);
      filled += b.length;
    }
    let best: number = fallback;
    let bestScore = -Infinity;
    for (let lag = 0; lag <= 4096; lag++) {
      let s = 0;
      for (let i = Math.round(rate * 0.05); i < n && i + lag < y.length; i += 3) s += probe[i]! * y[i + lag]!;
      if (s > bestScore) {
        bestScore = s;
        best = lag;
      }
    }
    return bestScore > 0 ? best : fallback;
  } catch {
    return fallback;
  }
}

// ── 合成 ──

export interface ExportInput {
  /** 你选的原视频文件 */
  file: Blob;
  probe: SourceProbe;
  /** 这个视频的中文配音（m4a） */
  dub: Blob;
  map: DubMap;
  signal?: AbortSignal;
  /** done / total：已经混好多少秒 / 全片多少秒 */
  onProgress?: (p: { phase: 'mixing' | 'writing'; done: number; total: number }) => void;
}

export interface ExportResult {
  blob: Blob;
  bytes: number;
  durationSec: number;
  /** 新音轨的编码：AAC（到处都能放）；这个浏览器编不了 AAC 时用 Opus */
  audioLabel: string;
  audioCodec: 'aac' | 'opus';
  /** 本来想用 AAC、编码器出错后改用了 Opus：出的什么错 */
  aacFailed?: string;
  sampleRate: number;
  /** 中文配音实际的时长（秒）和它排成了几段 */
  dubSec: number;
  pieces: number;
  alignment: DubAlignment;
  elapsedMs: number;
}

/** 配音文件里的音轨 */
async function openDub(dub: Blob): Promise<{ read: FileRead; track: AudioTrack; movieTimescale: number; seconds: number }> {
  const read = readerOf(dub);
  const top = await readMp4Top(read, dub.size, DUB.maxMoovBytes);
  const movie = parseMovie(top.moov);
  const track = movie.tracks.find((t) => t.handler === 'soun' && t.count > 0 && t.audio);
  if (!track?.audio) throw new Mp4Error('配音文件里没有能解码的声音', '在「配音」页给这个视频换一个文件再试。');
  if (!(await canDecode(track.audio))) throw new Mp4Error(`这个浏览器解不了配音文件的声音（${track.audio.label}）`, '把配音转成 AAC 编码的 m4a 再试。');
  return { read, track: track as AudioTrack, movieTimescale: movie.timescale, seconds: trackSeconds(movie, track) };
}

/**
 * 合成完整的双语视频：画面原样照搬，声音 = 原声 × 80% + 按对齐摆好的中文配音。
 * 返回的 Blob 里画面那部分直接引用你选的文件（不占内存）：保存完之前别挪动、别删那个文件
 */
export async function exportBilingual(input: ExportInput): Promise<ExportResult> {
  try {
    return await exportOnce(input, false);
  } catch (e) {
    // AAC 编码器中途出错（个别机器上系统自带的编码器会这样）：不白跑，改用 Opus 重新合成一遍，并在结果里写明
    if (!(e instanceof EncoderError) || !e.message.includes('AAC')) throw e;
    return { ...(await exportOnce(input, true)), aacFailed: e.message };
  }
}

async function exportOnce(input: ExportInput, avoidAac: boolean): Promise<ExportResult> {
  const started = performance.now();
  const { probe, signal } = input;
  const src = probe.source;
  const dub = await openDub(input.dub);
  const alignment = dubAlignment(input.map, src.durationSec, dub.seconds);
  const orig = new OrigStream(readerOf(input.file), src, signal);
  let timeline: DubTimeline | undefined;
  let encoder: Encoder | undefined;
  try {
    await orig.open();
    const channels = Math.min(2, orig.channels);
    const out = await pickOutput(orig.rate, channels, avoidAac);
    if (!out) throw new Mp4Error('这个浏览器编不了声音（AAC 和 Opus 都不行）', '请用最新版 Google Chrome 或 Firefox。');
    orig.resampleTo(out.rate);
    const pieces = renderPieces(alignment, out.rate);
    timeline = new DubTimeline(dub.read, dub.track, dub.movieTimescale, pieces, out.rate, signal);
    encoder = new Encoder(out.enc);
    const total = Math.round(src.durationSec * out.rate);
    const block = Math.round(DUB.export.blockSec * out.rate);
    for (let at = 0; at < total; at += block) {
      checkAbort(signal);
      const n = Math.min(block, total - at);
      const mixed = await orig.read(n, channels);
      mixBlock(mixed, await timeline.read(at, n));
      await encoder.write(mixed, at);
      input.onProgress?.({ phase: 'mixing', done: (at + n) / out.rate, total: src.durationSec });
    }
    const encoded = await encoder.finish();
    checkAbort(signal);
    input.onProgress?.({ phase: 'writing', done: src.durationSec, total: src.durationSec });
    if (!encoded.frames.length) throw new Mp4Error('编码器没有给出任何声音数据');
    const audio: EncodedAudio =
      out.enc.codec === 'aac'
        ? { codec: 'aac', sampleRate: out.rate, channels, bitrate: DUB.export.aacBitrate, ...(encoded.description ? { description: encoded.description } : {}), frames: encoded.frames, frameSamples: 1024 as number, priming: await measureAacPriming(out.enc.config) }
        : {
            codec: 'opus',
            sampleRate: out.rate,
            channels,
            bitrate: DUB.export.opusBitrate,
            ...(encoded.description ? { description: encoded.description } : {}),
            frames: encoded.frames,
            // Opus 在 MP4 里的时间单位固定是 48000；每帧多长看编码器给的（默认 20 毫秒）
            frameSamples: Math.round(((encoded.frameMicros || 20_000) * 48000) / 1e6),
            priming: 0,
          };
    const plan = buildRemux(probe.top, src, audio);
    const blob = new Blob(
      plan.parts.map((p) => (p.kind === 'bytes' ? p.bytes : input.file.slice(p.start, p.end))),
      { type: 'video/mp4' },
    );
    return {
      blob,
      bytes: plan.size,
      durationSec: src.durationSec,
      audioLabel: out.enc.label,
      audioCodec: out.enc.codec,
      sampleRate: out.rate,
      dubSec: dub.seconds,
      pieces: pieces.length,
      alignment,
      elapsedMs: Math.round(performance.now() - started),
    };
  } finally {
    orig.close();
    timeline?.close();
    encoder?.close();
  }
}
