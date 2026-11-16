// "保存完整双语视频"的声音怎么算（DECISIONS §83）：软限幅与混音、重采样、变速不变调、每一段中文放在输出的哪里。

import { describe, expect, it } from 'vitest';
import { DUB } from '../../src/config/defaults';
import { dubAlignment } from '../../src/core/dub-align';
import { softLimitCurve } from '../../src/core/dub-mix';
import { PIECE_FADE_SEC, StreamResampler, TimeStretcher, exportFileName, mixBlock, pieceFade, renderPieces, softLimit } from '../../src/core/dub-render';

const sine = (hz: number, rate: number, seconds: number, amp = 0.5) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

/** 这一段里 hz 这个频率的振幅（Goertzel） */
function tone(x: Float32Array, rate: number, hz: number, from = 0, to = x.length): number {
  const w = (2 * Math.PI * hz) / rate;
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i++) {
    re += x[i]! * Math.cos(w * i);
    im -= x[i]! * Math.sin(w * i);
  }
  return (2 * Math.hypot(re, im)) / (to - from);
}

const rms = (x: Float32Array, from = 0, to = x.length) => Math.sqrt(x.subarray(from, to).reduce((s, v) => s + v * v, 0) / (to - from));

/** 一块一块喂进去（每块 chunk 个样本），把出来的接起来 */
function feed(t: { push(c: Float32Array[]): Float32Array[]; flush(): Float32Array[] }, chs: Float32Array[], chunk: number): Float32Array[] {
  const outs: Float32Array[][] = [];
  for (let o = 0; o < chs[0]!.length; o += chunk) outs.push(t.push(chs.map((c) => c.subarray(o, o + chunk))));
  outs.push(t.flush());
  return chs.map((_, c) => {
    const all = new Float32Array(outs.reduce((n, b) => n + b[c]!.length, 0));
    let at = 0;
    for (const b of outs) {
      all.set(b[c]!, at);
      at += b[c]!.length;
    }
    return all;
  });
}

describe('软限幅与混音：和片段录制的双语混音是同一条曲线', () => {
  it('和 WaveShaper 用的那张曲线表逐点一致', () => {
    const { knee, headroom, points } = DUB.mixLimiter;
    const curve = softLimitCurve(points, knee, headroom);
    for (let i = 0; i < points; i += 97) {
      const v = ((i / (points - 1)) * 2 - 1) * headroom;
      expect(softLimit(v)).toBeCloseTo(curve[i]!, 6);
    }
    // 满幅 90% 以下原样不动；再大也压在 1 以内；超过曲线范围的按曲线的两头算
    expect(softLimit(0.5)).toBe(0.5);
    expect(softLimit(-0.9)).toBe(-0.9);
    expect(softLimit(1.5)).toBeLessThan(1);
    expect(softLimit(1.5)).toBeGreaterThan(0.9);
    expect(softLimit(5)).toBe(softLimit(headroom));
  });
  it('原声 × 80% + 中文 × 100%；没有中文的地方原声也是 80%', () => {
    const orig = [Float32Array.from([0.5, 0.5, -0.25, 0]), Float32Array.from([0.1, 0.1, 0.1, 0.1])];
    mixBlock(orig, [Float32Array.from([0.3, 0, 0.2, -0.4])]);
    expect(Array.from(orig[0]!).map((v) => +v.toFixed(4))).toEqual([0.7, 0.4, 0, -0.4]);
    // 中文是单声道：两边都放
    expect(Array.from(orig[1]!).map((v) => +v.toFixed(4))).toEqual([0.38, 0.08, 0.28, -0.32]);
    const alone = [Float32Array.from([0.5, -1])];
    mixBlock(alone, undefined);
    expect(Array.from(alone[0]!).map((v) => +v.toFixed(4))).toEqual([0.4, -0.8]);
    expect(DUB.originalVolume).toBe(0.8);
  });
  it('两边叠起来超过满幅：平滑压住，不削波；原声是单声道、中文是立体声时取中文两边的平均', () => {
    const loud = [Float32Array.from([1, 1])];
    mixBlock(loud, [Float32Array.from([1, 0.5]), Float32Array.from([1, 0.1])]);
    expect(loud[0]![0]!).toBeLessThanOrEqual(1);
    expect(loud[0]![0]!).toBeGreaterThan(0.95);
    expect(loud[0]![1]!).toBeCloseTo(softLimit(0.8 + 0.3), 6);
  });
});

describe('重采样', () => {
  it('32 kHz → 44.1 kHz（配音常见的情况）：长度按比例、音高和音量不变', () => {
    const [out] = feed(new StreamResampler(32000, 44100, 1), [sine(1000, 32000, 2)], 4096);
    expect(out!.length).toBe(88200);
    expect(tone(out!, 44100, 1000, 4410, 83790)).toBeCloseTo(0.5, 2);
    expect(tone(out!, 44100, 1378, 4410, 83790)).toBeLessThan(0.002);
  });
  it('没有延迟：输入第 16000 个样本上的一下脉冲，出来正好在对应的时刻', () => {
    const x = new Float32Array(32000);
    x[16000] = 1;
    const [out] = feed(new StreamResampler(32000, 48000, 1), [x], 1000);
    let peak = 0;
    for (let i = 0; i < out!.length; i++) if (Math.abs(out![i]!) > Math.abs(out![peak]!)) peak = i;
    expect(peak).toBe(24000);
  });
  it('降采样（48 kHz → 44.1 kHz）：听得见的频率留着，超出新采样率一半的滤掉，不折回来变成杂音', () => {
    const mixed = sine(3000, 48000, 1, 0.4).map((v, i) => v + 0.4 * Math.sin((2 * Math.PI * 23500 * i) / 48000));
    const [out] = feed(new StreamResampler(48000, 44100, 1), [mixed], 5000);
    expect(tone(out!, 44100, 3000, 2000, 42000)).toBeCloseTo(0.4, 2);
    expect(rms(out!, 2000, 42000)).toBeLessThan(0.4 / Math.SQRT2 + 0.01);
  });
  it('怎么分块喂结果都一样；立体声两边各算各的', () => {
    const l = sine(440, 32000, 0.5);
    const r = sine(660, 32000, 0.5, 0.25);
    const a = feed(new StreamResampler(32000, 44100, 2), [l, r], 333);
    const b = feed(new StreamResampler(32000, 44100, 2), [l, r], 16000);
    expect(a[0]!.length).toBe(b[0]!.length);
    expect(Math.max(...Array.from(a[0]!, (v, i) => Math.abs(v - b[0]![i]!)))).toBeLessThan(1e-6);
    expect(tone(a[1]!, 44100, 660, 2000, 20000)).toBeCloseTo(0.25, 2);
    expect(tone(a[1]!, 44100, 440, 2000, 20000)).toBeLessThan(0.002);
  });
});

describe('变速不变调（快速对齐的那个倍速）', () => {
  it('用户的例子 0.8355 倍：变长到 1 ÷ 0.8355 倍，音高不变（不是放慢后变低）、音量基本不变', () => {
    const rate = 0.835537;
    const [out] = feed(new TimeStretcher(rate, 32000, 1), [sine(440, 32000, 4)], 3200);
    expect(Math.abs(out!.length - (4 * 32000) / rate)).toBeLessThan(32000 * 0.03);
    const a = 16000;
    const b = out!.length - 16000;
    expect(tone(out!, 32000, 440, a, b)).toBeGreaterThan(0.45);
    // 要是变调了，声音会落在 440 × 0.8355 ≈ 368 Hz
    expect(tone(out!, 32000, 440 * rate, a, b)).toBeLessThan(0.03);
    expect(rms(out!, a, b)).toBeCloseTo(0.5 / Math.SQRT2, 1);
  });
  it('快放（1.25 倍）也一样；对上的位置不漂：输入每一秒换一个音，输出里每 1 ÷ 倍速 秒换一个', () => {
    const rate = 1.25;
    const src = new Float32Array(32000 * 6);
    for (let s = 0; s < 6; s++) src.set(sine(300 + 100 * s, 32000, 1), s * 32000);
    const [out] = feed(new TimeStretcher(rate, 32000, 1), [src], 4800);
    expect(Math.abs(out!.length - (6 * 32000) / rate)).toBeLessThan(32000 * 0.03);
    for (let s = 0; s < 6; s++) {
      // 第 s 秒的音，在输出的 [s ÷ 倍速, (s + 1) ÷ 倍速) 里；取中间一段量
      const from = Math.round(((s + 0.25) / rate) * 32000);
      const to = Math.round(((s + 0.75) / rate) * 32000);
      expect(tone(out!, 32000, 300 + 100 * s, from, to)).toBeGreaterThan(0.4);
    }
  });
  it('1 倍速：原样出来（除了开头 10 毫秒的渐入）', () => {
    const x = sine(440, 32000, 1);
    const [out] = feed(new TimeStretcher(1, 32000, 1), [x], 1024);
    expect(Math.abs(out!.length - x.length)).toBeLessThanOrEqual(640);
    expect(Math.max(...Array.from(out!.subarray(640, 30000), (v, i) => Math.abs(v - x[640 + i]!)))).toBeLessThan(1e-4);
  });
  it('怎么分块喂结果都一样；立体声两边用同一组拼接点（左右不会错开）', () => {
    const l = sine(220, 32000, 1.5);
    const a = feed(new TimeStretcher(0.8, 32000, 2), [l, l], 777);
    const b = feed(new TimeStretcher(0.8, 32000, 2), [l, l], 32000);
    expect(a[0]!.length).toBe(b[0]!.length);
    expect(Math.max(...Array.from(a[0]!, (v, i) => Math.abs(v - b[0]![i]!)))).toBeLessThan(1e-6);
    expect(Math.max(...Array.from(a[0]!, (v, i) => Math.abs(v - a[1]![i]!)))).toBeLessThan(1e-6);
  });
});

describe('每一段中文放在输出的哪里：照着对齐图那一套', () => {
  it('用户截图里的开头：不偏移，第一个对齐点 视频 0:15 ↔ 中文 0:09', () => {
    const al = dubAlignment({ delaySec: 0, anchors: [{ video: 15, dub: 9 }, { video: 34, dub: 24 }] }, 1051.3, 878.4);
    const pieces = renderPieces(al, 44100);
    // 开头那段：中文 0–9 秒放在视频 0–9 秒（说完了，9–15 秒等画面，只有原声）
    expect(pieces[0]).toEqual({ outStart: 0, outEnd: 9 * 44100, d0: 0, d1: 9, rate: 1 });
    // 第一个对齐点之后：视频 15 秒起放中文 9 秒起，到中文 24 秒（下一个对齐点）为止
    expect(pieces[1]).toEqual({ outStart: 15 * 44100, outEnd: 30 * 44100, d0: 9, d1: 24, rate: 1 });
    expect(pieces[2]).toMatchObject({ outStart: 34 * 44100, d0: 24, rate: 1 });
    // 最后一段放到中文结束
    expect(pieces[2]!.d1).toBeCloseTo(878.4, 6);
    expect(pieces[2]!.outEnd).toBe(Math.round((34 + 878.4 - 24) * 44100));
  });
  it('中文说得慢：视频先到了下一个对齐点，没说完的跳过', () => {
    const al = dubAlignment({ delaySec: 0, anchors: [{ video: 8, dub: 30.5 }] }, 16, 92);
    const pieces = renderPieces(al, 48000);
    expect(pieces).toEqual([
      { outStart: 0, outEnd: 8 * 48000, d0: 0, d1: 8, rate: 1 },
      { outStart: 8 * 48000, outEnd: 16 * 48000, d0: 30.5, d1: 38.5, rate: 1 },
    ]);
  });
  it('开头的偏移：中文推后时前面空着；中文提前时跳过中文的开头', () => {
    expect(renderPieces(dubAlignment({ delaySec: 2, anchors: [] }, 10, 5), 1000)).toEqual([{ outStart: 2000, outEnd: 7000, d0: 0, d1: 5, rate: 1 }]);
    expect(renderPieces(dubAlignment({ delaySec: -3, anchors: [] }, 10, 20), 1000)).toEqual([{ outStart: 0, outEnd: 10000, d0: 3, d1: 13, rate: 1 }]);
  });
  it('快速对齐：一段到底，中文整段按倍速铺满全片', () => {
    const rate = 878.4 / 1051.3;
    const pieces = renderPieces(dubAlignment({ delaySec: 3, anchors: [{ video: 15, dub: 9 }], quickRate: rate }, 1051.3, 878.4), 44100);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ outStart: 0, outEnd: Math.round(1051.3 * 44100), d0: 0, rate });
    expect(pieces[0]!.d1).toBeCloseTo(878.4, 3);
  });
  it('各段按时间排好、互不重叠、不超出全片（对齐点再多、再乱也一样）', () => {
    const anchors = Array.from({ length: 61 }, (_, k) => ({ video: 15 + k * 17, dub: 9 + k * 14.2 }));
    const pieces = renderPieces(dubAlignment({ delaySec: 0, anchors }, 1051.3, 878.4), 44100);
    expect(pieces.length).toBeGreaterThan(50);
    let at = 0;
    for (const p of pieces) {
      expect(p.outStart).toBeGreaterThanOrEqual(at);
      expect(p.outEnd).toBeGreaterThan(p.outStart);
      expect(p.outEnd).toBeLessThanOrEqual(Math.round(1051.3 * 44100));
      // 正常速度：输出多长，中文就用多长
      expect(Math.abs((p.outEnd - p.outStart) / 44100 - (p.d1 - p.d0))).toBeLessThan(0.001);
      at = p.outEnd;
    }
  });
  it('每一段开头结尾各有几毫秒的渐入渐出，中间不动', () => {
    const fade = Math.round(PIECE_FADE_SEC * 44100);
    expect(pieceFade(0, 44100, fade)).toBeGreaterThan(0);
    expect(pieceFade(0, 44100, fade)).toBeLessThan(0.02);
    expect(pieceFade(fade, 44100, fade)).toBe(1);
    expect(pieceFade(22050, 44100, fade)).toBe(1);
    expect(pieceFade(44099, 44100, fade)).toBeLessThan(0.02);
    expect(pieceFade(5, 44100, 0)).toBe(1);
  });
});

describe('合成出来的文件名', () => {
  it('视频标题_双语完整版.mp4；没有标题用你选的文件名，再没有用视频 ID；不能进文件名的字符去掉', () => {
    expect(exportFileName({ title: 'All Code Is Slop (Except Mine) — Lauren Tan, SpaceXSI', videoId: 'O_zcc6XI12g' }, 'x.mp4')).toBe('All Code Is Slop (Except Mine) — Lauren Tan, SpaceXSI_双语完整版.mp4');
    expect(exportFileName({ videoId: 'O_zcc6XI12g' }, 'All Code Is Slop [O_zcc6XI12g].mp4')).toBe('All Code Is Slop [O_zcc6XI12g]_双语完整版.mp4');
    expect(exportFileName({ title: 'a/b: c?', videoId: 'O_zcc6XI12g' }, 'x.mp4')).toBe('a b c_双语完整版.mp4');
    expect(exportFileName({ title: '', videoId: 'O_zcc6XI12g' }, '.mp4')).toBe('youtube-O_zcc6XI12g_双语完整版.mp4');
  });
});
