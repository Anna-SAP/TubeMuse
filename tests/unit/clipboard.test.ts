import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIPS } from '../../src/config/defaults';
import { copyPngToClipboard, type CopyImageDeps } from '../../src/ui/shared/clipboard';

/** 假的 ClipboardItem：只记下交给它的各种格式 */
class FakeItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}
const Item = FakeItem as unknown as NonNullable<CopyImageDeps['Item']>;

/** 像浏览器那样的假剪贴板：等图出来才算写完；图没出来就拒绝 */
function fakeClipboard() {
  const written: Blob[] = [];
  const write = vi.fn(async (data: ClipboardItems) => {
    for (const item of data as unknown as FakeItem[]) written.push(await (item.items['image/png'] as Promise<Blob>));
  });
  return { clipboard: { write }, written };
}

function named(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });

describe('Capture：截图同时放进系统剪贴板', () => {
  afterEach(() => vi.useRealTimers());

  it('点击的那一刻就向浏览器登记，图出来后才写进去', async () => {
    const { clipboard, written } = fakeClipboard();
    let give!: (b: Blob) => void;
    const pending = new Promise<Blob>((r) => (give = r));
    const result = copyPngToClipboard(pending, 5000, { clipboard, Item });
    // 还没等任何东西：写入已经登记了，格式是 image/png
    expect(clipboard.write).toHaveBeenCalledTimes(1);
    const item = (clipboard.write.mock.calls[0]?.[0] as unknown as FakeItem[])[0];
    expect(Object.keys(item?.items ?? {})).toEqual(['image/png']);
    expect(written).toHaveLength(0);
    const blob = png();
    give(blob);
    expect(await result).toEqual({ ok: true });
    expect(written).toEqual([blob]);
  });

  it('截图没成（广告、缓冲、没传回来）：不算剪贴板的错，剪贴板里什么都没写', async () => {
    const { clipboard, written } = fakeClipboard();
    let giveUp!: (e: Error) => void;
    const pending = new Promise<Blob>((_, reject) => (giveUp = reject));
    const result = copyPngToClipboard(pending, 5000, { clipboard, Item });
    giveUp(new Error('截图没成'));
    expect(await result).toEqual({ ok: false, skipped: true });
    expect(written).toHaveLength(0);
  });

  it('侧边栏没有焦点时被拒：用人话说明', async () => {
    const clipboard = { write: vi.fn(() => Promise.reject(named('NotAllowedError', 'Document is not focused.'))) };
    const r = await copyPngToClipboard(Promise.resolve(png()), 5000, { clipboard, Item });
    expect(r).toEqual({ ok: false, message: '侧边栏当时不在最前面（点完马上切走了？）' });
  });

  it('浏览器不让写：带上浏览器给的原因', async () => {
    const clipboard = { write: vi.fn(() => Promise.reject(named('NotAllowedError', 'Write permission denied.'))) };
    const r = await copyPngToClipboard(Promise.resolve(png()), 5000, { clipboard, Item });
    expect(r).toEqual({ ok: false, message: '浏览器不允许这个页面写剪贴板（Write permission denied.）' });
  });

  it('write 直接抛错（不是返回被拒的 Promise）也接得住', async () => {
    const clipboard = {
      write: vi.fn((): Promise<void> => {
        throw named('TypeError', 'Type image/png not supported on write.');
      }),
    };
    const r = await copyPngToClipboard(Promise.resolve(png()), 5000, { clipboard, Item });
    expect(r).toEqual({ ok: false, message: 'Type image/png not supported on write.' });
  });

  it('浏览器不支持（没有 clipboard.write 或 ClipboardItem）：说明，不抛错；截图没成时也一样', async () => {
    const { clipboard } = fakeClipboard();
    const unsupported = { ok: false, message: '这个浏览器不支持把图片放进剪贴板' };
    expect(await copyPngToClipboard(Promise.resolve(png()), 5000, { clipboard: undefined, Item })).toEqual(unsupported);
    expect(await copyPngToClipboard(Promise.resolve(png()), 5000, { clipboard, Item: undefined })).toEqual(unsupported);
    expect(await copyPngToClipboard(Promise.reject(new Error('截图没成')), 5000, { clipboard: undefined, Item })).toEqual(unsupported);
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it('浏览器一直不回应：到时间就说明没放进去，等图的时间不算', async () => {
    vi.useFakeTimers();
    const clipboard = { write: vi.fn(() => new Promise<void>(() => undefined)) };
    let give!: (b: Blob) => void;
    const pending = new Promise<Blob>((r) => (give = r));
    let settled: unknown;
    void copyPngToClipboard(pending, CLIPS.captureClipboardTimeoutMs, { clipboard, Item }).then((r) => (settled = r));
    // 图还没出来：过多久都不算超时
    await vi.advanceTimersByTimeAsync(CLIPS.captureClipboardTimeoutMs * 3);
    expect(settled).toBeUndefined();
    give(png());
    await vi.advanceTimersByTimeAsync(CLIPS.captureClipboardTimeoutMs - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ ok: false, message: '浏览器 5 秒都没有写完' });
  });

  it('等剪贴板的上限是个有限的正数：Capture 按钮不会一直卡在"截图中"', () => {
    expect(CLIPS.captureClipboardTimeoutMs).toBeGreaterThan(0);
    expect(Number.isFinite(CLIPS.captureClipboardTimeoutMs)).toBe(true);
  });
});
