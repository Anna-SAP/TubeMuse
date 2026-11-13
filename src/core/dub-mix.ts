// 中文配音 × 片段录制（用户 2026-11-13 要求，见 DECISIONS §76）：配音开着时，录下的片段里是双语混音（原声按 80% + 中文配音）。
// 配音脚本（content/dub.ts）和片段录制脚本（content/clipper.ts）是同一个扩展注入同一个页面的两个内容脚本，跑在同一个隔离环境里
// （网页自己的脚本看不到）：配音脚本在这个环境的全局对象上挂一个只读的"混音来源"，录制脚本录 YouTube 时来取。
// 配音脚本自己仍然不采集任何声音；录制脚本只对这个配音的 <audio> 调 captureStream()，和它对视频做的一样。

const KEY = Symbol.for('tubemuse.dub.mix');

export interface DubMixSource {
  /** 正在跟随视频的配音 <audio>（开着配音、已载入）；没有时 undefined */
  audio(): HTMLAudioElement | undefined;
  /** 原声此刻的音量倍数：配音开着、正降着原声时是 0.8，否则 1。录音里的原声也按它混，和你听到的一样 */
  originalGain(): number;
}

type Holder = Record<symbol, unknown>;

/** 配音脚本：挂上（或摘掉）混音来源 */
export function publishDubMix(src: DubMixSource | undefined): void {
  const g = globalThis as unknown as Holder;
  if (src) g[KEY] = src;
  else delete g[KEY];
}

/** 录制脚本：取混音来源；配音脚本没在这个页面上时 undefined */
export function dubMix(): DubMixSource | undefined {
  const v = (globalThis as unknown as Holder)[KEY] as Partial<DubMixSource> | undefined;
  return v && typeof v.audio === 'function' && typeof v.originalGain === 'function' ? (v as DubMixSource) : undefined;
}

/** 原声的混音倍数：只认 0–1 之间的有限数，别的一律按 1（不降） */
export function originalMixGain(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1 ? x : 1;
}

/**
 * 软限幅曲线（WaveShaperNode 用；输入先乘 1/headroom，曲线的 [-1, 1] 对应原来的 [-headroom, headroom]）：
 * |v| ≤ knee 时输出 v（线性，不改音量）；超过 knee 的部分用 tanh 平滑压进 (knee, 1)，不硬削波
 */
export function softLimitCurve(points: number, knee: number, headroom: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points);
  const room = 1 - knee;
  for (let i = 0; i < points; i++) {
    const v = ((i / (points - 1)) * 2 - 1) * headroom;
    const a = Math.abs(v);
    curve[i] = a <= knee ? v : Math.sign(v) * (knee + room * Math.tanh((a - knee) / room));
  }
  return curve;
}
