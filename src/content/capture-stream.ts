// 从正在播放的 <video> 取它自己的音视频流（自动字幕取声音、片段录制取声音）。
// Chrome 与 Firefox 149 起都有标准的 captureStream()：取流不影响你听到的声音。
// 更早的 Firefox 只有带前缀的 mozCaptureStream()，它会把这个视频的声音从扬声器"改道"进流里（你就听不到了，
// Mozilla bug 1541471），所以这里不用它：明说要升级浏览器，不悄悄换成一个会让视频变哑的办法（DECISIONS §69）。

export type CaptureResult = { ok: true; stream: MediaStream } | { ok: false; reason: 'unsupported' | 'blocked' };

/** 也用来取中文配音那个 <audio> 的声音（片段录制混音，DECISIONS §76） */
export function captureVideoStream(video: HTMLMediaElement): CaptureResult {
  const capture = (video as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream;
  if (typeof capture !== 'function') return { ok: false, reason: 'unsupported' };
  try {
    return { ok: true, stream: capture.call(video) };
  } catch {
    // 受版权保护（DRM）或跨站视频：浏览器不让取
    return { ok: false, reason: 'blocked' };
  }
}

/** 浏览器版本太旧、没有标准 captureStream() 时怎么说 */
export const CAPTURE_UNSUPPORTED = '这个浏览器版本还不能在不影响播放声音的前提下取这个视频的声音（Firefox 需要 149 或更新版本）';

/**
 * Firefox 的内容脚本里，DOM 接口（blob.arrayBuffer()、AudioBuffer 等）造出来的 ArrayBuffer / 类型化数组属于页面那一侧，
 * 脚本拿到的是包装过的；在它上面调 subarray / slice 会报 "Permission denied to access property constructor"（161 实测）。
 * 先整块拷进脚本自己的数组再用。Chrome 没有这层包装，拷一次也无妨。
 */
export function ownBytes(buf: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buf.byteLength);
  out.set(new Uint8Array(buf));
  return out;
}
