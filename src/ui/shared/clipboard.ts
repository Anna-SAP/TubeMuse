// 把图片放进系统剪贴板（只在扩展页面里用；不经过网络，不需要 clipboardWrite 权限）。
// 见 DECISIONS §62。

/** 放进剪贴板的结果。skipped：图没出来（截图本身没成），剪贴板原样未动 */
export type CopyImageResult = { ok: true } | { ok: false; skipped: true } | { ok: false; skipped?: false; message: string };

export interface CopyImageDeps {
  /** navigator.clipboard；测试里换成假的 */
  clipboard?: Pick<Clipboard, 'write'> | undefined;
  /** ClipboardItem 构造函数；测试里换成假的 */
  Item?: (new (items: Record<string, Promise<Blob>>) => ClipboardItem) | undefined;
}

const FOCUS_HINT = '侧边栏当时不在最前面（点完马上切走了？）';

function whyNot(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  const text = e instanceof Error ? e.message : String(e);
  if (name === 'NotAllowedError') return /focus/i.test(text) ? FOCUS_HINT : `浏览器不允许这个页面写剪贴板（${text}）`;
  return text || name || '原因不明';
}

/**
 * 把一张 PNG 放进系统剪贴板。图可以还没准备好：这里立刻向浏览器登记这次写入，图出来后才真正写进去。
 * 必须在点击的那一刻（同一段同步代码里）调用：浏览器只在页面有焦点、刚被点过时才让写；
 * 等截图传回来再调，中间隔了几次消息往返，你已经切到别的窗口的话就会被拒。
 * 不抛错：成没成都用返回值说明。png 被拒绝（截图没成）时返回 skipped，剪贴板原样未动。
 */
export async function copyPngToClipboard(png: Promise<Blob>, timeoutMs: number, deps: CopyImageDeps = {}): Promise<CopyImageResult> {
  const clipboard = 'clipboard' in deps ? deps.clipboard : globalThis.navigator?.clipboard;
  const Item = 'Item' in deps ? deps.Item : (globalThis as { ClipboardItem?: CopyImageDeps['Item'] }).ClipboardItem;
  // 截图没成时 png 会被拒绝：这里先接住，免得浏览器不支持、直接返回时它成了没人处理的拒绝
  png.catch(() => undefined);
  if (!clipboard?.write || !Item) return { ok: false, message: '这个浏览器不支持把图片放进剪贴板' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const written = clipboard.write([new Item({ 'image/png': png })]);
    // 图出来之后才开始计时：等图的时间不算在剪贴板头上
    const waited = png.then(
      () => new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), timeoutMs))),
      () => 'skipped' as const,
    );
    const r = await Promise.race([written.then(() => 'done' as const), waited]);
    if (r === 'done') return { ok: true };
    return r === 'skipped' ? { ok: false, skipped: true } : { ok: false, message: `浏览器 ${Math.round(timeoutMs / 1000)} 秒都没有写完` };
  } catch (e) {
    // 截图没成时浏览器也会拒绝这次写入：那不是剪贴板的问题
    const pngFailed = await png.then(
      () => false,
      () => true,
    );
    return pngFailed ? { ok: false, skipped: true } : { ok: false, message: whyNot(e) };
  } finally {
    clearTimeout(timer);
  }
}
