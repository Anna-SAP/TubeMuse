// "保存完整双语视频"的声音怎么算（纯逻辑，不碰 DOM；用户 2026-11-16 选定离线合成，见 DECISIONS §83）。
// 目标：算出来的声音和开着配音播放时听到的一致——
//   · 中文放在哪里：用对齐图那一套（core/dub-align.ts 的 dubAlignment，它是照着跟随规则 dubStep 摊开的）：
//     开头的偏移、每个对齐点、先说完就停下等画面、说得慢就在下一个对齐点跳过去；快速对齐时整段按倍速放。
//   · 快速对齐的变速：变速不变调（浏览器播放时用的也是这一类算法——按波形相似度找拼接点再叠加，WSOLA）。
//     算出来的波形和浏览器实时播的不会逐个样本相同，但速度、音高、对上的位置一样。
//   · 混音：原声 × 80% + 中文 × 100%，过同一条软限幅曲线（和片段录制的双语混音同一个公式，DECISIONS §76）。
// 这里只有算法：流式的重采样、流式的变速、每一段中文放在输出的哪几个样本上、逐块混音。解码、编码在 services/dub-export.ts。

import { DUB } from '../config/defaults';
import { safeFileTitle } from './clips';
import type { DubRecord } from './dub';
import type { DubAlignment } from './dub-align';

// ── 软限幅：和片段录制里 WaveShaper 用的曲线是同一个函数 ──

/** 满幅 knee 以下原样不动；超过的部分用 tanh 平滑压进 1 以内；最多接得住 headroom 倍满幅（再大按 headroom 算） */
export function softLimit(v: number, knee: number = DUB.mixLimiter.knee, headroom: number = DUB.mixLimiter.headroom): number {
  const a = Math.abs(v);
  if (a <= knee) return v;
  const room = 1 - knee;
  return Math.sign(v) * (knee + room * Math.tanh((Math.min(a, headroom) - knee) / room));
}

/**
 * 混一块：out = 软限幅(原声 × origGain + 中文)。写回 orig（省内存）。
 * 中文是单声道时两边都放；原声是单声道、中文是立体声时取中文两边的平均。dub 为空 = 这一块没有中文
 */
export function mixBlock(orig: Float32Array[], dub: Float32Array[] | undefined, origGain: number = DUB.originalVolume): void {
  for (let c = 0; c < orig.length; c++) {
    const o = orig[c]!;
    if (!dub?.length) {
      for (let i = 0; i < o.length; i++) o[i] = softLimit(o[i]! * origGain);
      continue;
    }
    const d = dub[Math.min(c, dub.length - 1)]!;
    const d2 = orig.length === 1 && dub.length > 1 ? dub[1]! : undefined;
    for (let i = 0; i < o.length; i++) o[i] = softLimit(o[i]! * origGain + (d2 ? (d[i]! + d2[i]!) / 2 : d[i]!));
  }
}

// ── 小工具：能往后追加、从前面丢掉的样本缓冲 ──

class Fifo {
  private buf: Float32Array;
  /** buf[0] 对应的绝对位置 */
  base = 0;
  len = 0;
  constructor(capacity = 8192) {
    this.buf = new Float32Array(capacity);
  }
  get end(): number {
    return this.base + this.len;
  }
  push(x: Float32Array): void {
    if (this.len + x.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.buf.length * 2, this.len + x.length));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(x, this.len);
    this.len += x.length;
  }
  /** 丢掉绝对位置 upTo 之前的 */
  drop(upTo: number): void {
    const n = Math.min(this.len, Math.max(0, upTo - this.base));
    if (!n) return;
    this.buf.copyWithin(0, n, this.len);
    this.base += n;
    this.len -= n;
  }
  /** 绝对位置 i 的样本；不在缓冲里（开头之前、还没到的）算 0 */
  at(i: number): number {
    const k = i - this.base;
    return k >= 0 && k < this.len ? this.buf[k]! : 0;
  }
  /** 缓冲本身和它的起点（热循环里直接下标访问） */
  raw(): { data: Float32Array; base: number; len: number } {
    return { data: this.buf, base: this.base, len: this.len };
  }
}

// ── 重采样（流式）：加窗 sinc 插值 ──

const RESAMPLE = {
  /** sinc 每边取几个过零点 */
  zeros: 12,
  /** 核函数的表：每个输入样本之间分多少格（格之间线性插值） */
  phases: 256,
  /** 通带留到奈奎斯特频率的这么多 */
  cutoff: 0.94,
  kaiserBeta: 8,
};

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 30; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-10 * sum) break;
  }
  return sum;
}

/**
 * 把采样率从 inRate 换到 outRate，一块一块喂（push），最后 flush。
 * 输出的第 n 个样本正好对应输入时间 n ÷ outRate：没有延迟，不用另外对齐
 */
export class StreamResampler {
  private readonly step: number;
  private readonly half: number;
  private readonly table: Float32Array;
  private readonly inputs: Fifo[];
  private fed = 0;
  private produced = 0;
  constructor(
    readonly inRate: number,
    readonly outRate: number,
    readonly channels: number,
  ) {
    this.step = inRate / outRate;
    // 降采样时把截止频率跟着降，核函数相应变宽
    const fc = Math.min(1, outRate / inRate) * RESAMPLE.cutoff;
    this.half = Math.ceil(RESAMPLE.zeros / fc);
    const n = this.half * RESAMPLE.phases + 2;
    this.table = new Float32Array(n);
    const i0 = besselI0(RESAMPLE.kaiserBeta);
    for (let i = 0; i < n; i++) {
      const t = i / RESAMPLE.phases;
      const x = Math.PI * fc * t;
      const sinc = x < 1e-9 ? 1 : Math.sin(x) / x;
      const r = Math.min(1, t / this.half);
      this.table[i] = fc * sinc * (besselI0(RESAMPLE.kaiserBeta * Math.sqrt(1 - r * r)) / i0);
    }
    this.inputs = Array.from({ length: channels }, () => new Fifo());
  }

  push(chs: Float32Array[]): Float32Array[] {
    for (let c = 0; c < this.channels; c++) this.inputs[c]!.push(chs[Math.min(c, chs.length - 1)]!);
    this.fed += chs[0]!.length;
    return this.run(false);
  }

  flush(): Float32Array[] {
    return this.run(true);
  }

  private run(final: boolean): Float32Array[] {
    // 能算到第几个输出：它右边要用到的输入都已经到了（收尾时缺的按 0）
    const total = Math.ceil(this.fed / this.step - 1e-9);
    const ready = final ? total : Math.min(total, Math.floor((this.fed - this.half - 1) / this.step) + 1);
    const n = Math.max(0, ready - this.produced);
    const out = Array.from({ length: this.channels }, () => new Float32Array(n));
    if (!n) return out;
    const { half, table, step } = this;
    const P = RESAMPLE.phases;
    for (let c = 0; c < this.channels; c++) {
      const { data, base, len } = this.inputs[c]!.raw();
      const o = out[c]!;
      for (let k = 0; k < n; k++) {
        const x = (this.produced + k) * step;
        const lo = Math.max(Math.ceil(x - half), base);
        const hi = Math.min(Math.floor(x + half), base + len - 1);
        let acc = 0;
        for (let i = lo; i <= hi; i++) {
          const pos = Math.abs(x - i) * P;
          const p = pos | 0;
          const f = pos - p;
          acc += data[i - base]! * (table[p]! + (table[p + 1]! - table[p]!) * f);
        }
        o[k] = acc;
      }
    }
    this.produced += n;
    const keepFrom = Math.floor(this.produced * step - half) - 1;
    for (const f of this.inputs) f.drop(keepFrom);
    return out;
  }
}

// ── 变速不变调（流式）：WSOLA ──

const STRETCH = {
  /** 每一帧多长（秒）、帧之间重叠一半 */
  windowSec: 0.02,
  /** 在目标位置前后这么多秒里找最像的拼接点 */
  searchSec: 0.01,
  /** 先隔几个样本粗找（按采样率定，约每 0.125 毫秒一个点），再在最好的那个附近细找 */
  coarseHz: 8000,
};

/**
 * 把声音放慢 / 放快而不改音高：rate = 每输出 1 秒用掉输入的多少秒（0.84 = 慢放，和 <audio>.playbackRate 一个意思）。
 * 做法：每 10 毫秒输出取输入里一帧 20 毫秒的声音，加窗后一半一半地叠起来；这一帧本该取"上一帧接着往下"的位置，
 * 和按速度算出的目标位置差得太远时，在目标位置附近找一个和"接着往下"的波形最像的地方跳过去——周期对得上，听不出拼接。
 * 输出的第 0 个样本对应输入的第 0 个样本；输入共 L 个样本时输出约 L ÷ rate 个
 */
export class TimeStretcher {
  private readonly N: number;
  private readonly H: number;
  private readonly search: number;
  private readonly coarse: number;
  private readonly window: Float32Array;
  private readonly inputs: Fifo[];
  private readonly mono: Fifo;
  private readonly tails: Float32Array[];
  private fed = 0;
  private frame = 0;
  /** 上一帧取的是输入的哪里 */
  private prev = 0;
  constructor(
    readonly rate: number,
    readonly sampleRate: number,
    readonly channels: number,
  ) {
    this.N = Math.max(8, Math.round((STRETCH.windowSec * sampleRate) / 2) * 2);
    this.H = this.N / 2;
    this.search = Math.max(4, Math.round(STRETCH.searchSec * sampleRate));
    this.coarse = Math.max(1, Math.round(sampleRate / STRETCH.coarseHz));
    this.window = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N);
    this.inputs = Array.from({ length: channels }, () => new Fifo());
    this.mono = channels === 1 ? this.inputs[0]! : new Fifo();
    this.tails = Array.from({ length: channels }, () => new Float32Array(this.H));
  }

  push(chs: Float32Array[]): Float32Array[] {
    const n = chs[0]!.length;
    for (let c = 0; c < this.channels; c++) this.inputs[c]!.push(chs[Math.min(c, chs.length - 1)]!);
    if (this.channels > 1) {
      const m = new Float32Array(n);
      for (let c = 0; c < this.channels; c++) {
        const x = chs[Math.min(c, chs.length - 1)]!;
        for (let i = 0; i < n; i++) m[i] = m[i]! + x[i]! / this.channels;
      }
      this.mono.push(m);
    }
    this.fed += n;
    return this.run(false);
  }

  flush(): Float32Array[] {
    return this.run(true);
  }

  /** 在 [lo, hi] 里找和 tpl（"接着往下"的那一帧）最像的起点 */
  private best(lo: number, hi: number, natural: number): number {
    const { data, base, len } = this.mono.raw();
    const { N, coarse } = this;
    const at = (i: number) => {
      const k = i - base;
      return k >= 0 && k < len ? data[k]! : 0;
    };
    const score = (p: number, stepJ: number) => {
      let corr = 0;
      let energy = 1e-9;
      for (let j = 0; j < N; j += stepJ) {
        const x = at(p + j);
        corr += x * at(natural + j);
        energy += x * x;
      }
      return corr / Math.sqrt(energy);
    };
    let bestP = lo;
    let bestS = -Infinity;
    for (let p = lo; p <= hi; p += coarse) {
      const s = score(p, coarse);
      if (s > bestS) {
        bestS = s;
        bestP = p;
      }
    }
    if (coarse > 1) {
      const from = Math.max(lo, bestP - coarse + 1);
      const to = Math.min(hi, bestP + coarse - 1);
      bestS = -Infinity;
      for (let p = from; p <= to; p++) {
        const s = score(p, 1);
        if (s > bestS) {
          bestS = s;
          bestP = p;
        }
      }
    }
    return bestP;
  }

  private run(final: boolean): Float32Array[] {
    const { N, H, search, rate } = this;
    const outs: Float32Array[][] = [];
    for (;;) {
      const target = Math.round(this.frame * H * rate);
      const natural = this.frame === 0 ? 0 : this.prev + H;
      // 这一帧可能用到的最靠后的输入
      const need = Math.max(target + search, natural) + N;
      if (!final && need > this.fed) break;
      // 收尾：目标位置已经在输入之外，没有可放的了
      if (final && target >= this.fed) break;
      let pick = natural;
      if (this.frame > 0 && Math.abs(natural - target) > search) pick = this.best(Math.max(0, target - search), target + search, natural);
      const block = Array.from({ length: this.channels }, () => new Float32Array(H));
      for (let c = 0; c < this.channels; c++) {
        const { data, base, len } = this.inputs[c]!.raw();
        const tail = this.tails[c]!;
        const o = block[c]!;
        for (let i = 0; i < N; i++) {
          const k = pick + i - base;
          const v = (k >= 0 && k < len ? data[k]! : 0) * this.window[i]!;
          if (i < H) o[i] = tail[i]! + v;
          else tail[i - H] = v;
        }
      }
      outs.push(block);
      this.prev = pick;
      this.frame++;
      // 下一帧最早用到哪里：之前的可以丢了
      const keep = Math.min(this.prev + H, Math.round(this.frame * H * rate) - search) - 1;
      for (const f of this.inputs) f.drop(keep);
      if (this.channels > 1) this.mono.drop(keep);
    }
    if (final) outs.push(this.tails.map((t) => t.slice()));
    const n = outs.reduce((s, b) => s + b[0]!.length, 0);
    const out = Array.from({ length: this.channels }, () => new Float32Array(n));
    let o = 0;
    for (const b of outs) {
      for (let c = 0; c < this.channels; c++) out[c]!.set(b[c]!, o);
      o += b[0]!.length;
    }
    return out;
  }
}

// ── 每一段中文放在输出的哪几个样本上 ──

export interface RenderPiece {
  /** 输出里的样本范围 [outStart, outEnd) */
  outStart: number;
  outEnd: number;
  /** 中文的哪一段（秒） */
  d0: number;
  d1: number;
  /** 视频每走 1 秒，中文走 rate 秒（1 = 正常速度；快速对齐时是那个倍速） */
  rate: number;
}

/** 把对齐摊开的结果换成输出采样率下的样本范围；按时间排好，互不重叠 */
export function renderPieces(al: DubAlignment, outRate: number): RenderPiece[] {
  const total = Math.round(al.videoDuration * outRate);
  const out: RenderPiece[] = [];
  let floor = 0;
  for (const p of [...al.pieces].sort((a, b) => a.v0 - b.v0)) {
    const outStart = Math.max(floor, Math.min(total, Math.round(p.v0 * outRate)));
    const outEnd = Math.max(outStart, Math.min(total, Math.round(p.v1 * outRate)));
    if (outEnd <= outStart) continue;
    const rate = p.rate ?? 1;
    // 开头被前一段占掉了一点（四舍五入）时，中文也相应往后挪
    const d0 = p.d0 + (outStart / outRate - p.v0) * rate;
    out.push({ outStart, outEnd, d0: Math.max(0, d0), d1: p.d1, rate });
    floor = outEnd;
  }
  return out;
}

/** 每一段中文开头和结尾各渐入 / 渐出这么多秒：中文是从中间切进来、切出去的，硬切会咔哒一下 */
export const PIECE_FADE_SEC = 0.004;

/** 一段里第 i 个样本（共 n 个）的渐入渐出倍数 */
export function pieceFade(i: number, n: number, fade: number): number {
  if (fade <= 0) return 1;
  return Math.max(0, Math.min(1, (i + 1) / fade, (n - i) / fade));
}

// ── 文件名 ──

/** 合成出来的文件叫什么：视频标题_双语完整版.mp4；没有标题时用你选的原视频文件的名字，再没有就用视频 ID */
export function exportFileName(rec: Pick<DubRecord, 'title' | 'videoId'>, sourceName: string): string {
  const base = safeFileTitle(rec.title ?? '') || safeFileTitle(sourceName.replace(/\.[A-Za-z0-9]{1,5}$/, '')) || `youtube-${rec.videoId}`;
  return `${base}_双语完整版.mp4`;
}
