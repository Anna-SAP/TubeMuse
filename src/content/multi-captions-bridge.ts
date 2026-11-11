// 多语字幕的页面内助手（用户 2026-11-02 批准的红线变更，见 DECISIONS §37）。
// 运行在 YouTube 页面自己的环境里（manifest 的 world: MAIN）：字幕轨列表和字幕开关只在播放器对象上，
// 普通内容脚本（隔离环境）看不到。它只应答本扩展多语字幕脚本经 window.postMessage 发来的五种请求：
// 1. state：读字幕轨列表、可自动翻译成的语言、当前显示的原生字幕（getPlayerResponse / getOption）；
// 2. prime：让播放器选一条字幕轨——播放器因此自己发出带令牌的字幕请求；
// 3. hide-native：关掉原生字幕（save 时记住原来的选择）；4. restore-native：恢复记住的选择；5. forget-native：不再恢复。
// 不发网络请求、不往页面插元素、不读页面上的文字、不用任何扩展接口（构建时检查）。
// 播放器：播放页是 #movie_player，Shorts 是 #shorts-player（2026-11-11 起，见 DECISIONS §67）。

import { BRIDGE_OPS, BRIDGE_TAG, isLangCode, playerRootId, type BridgeOp } from '../core/multicc-protocol';

interface YtPlayer extends HTMLElement {
  getPlayerResponse?(): unknown;
  getOption?(module: string, option: string): unknown;
  setOption?(module: string, option: string, value: unknown): void;
  loadModule?(module: string): void;
}

/** 关掉原生字幕前它原来的选择（播放器自己的字幕轨对象，原样交还给它） */
let saved: object | undefined;

const get = (o: unknown, key: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined);
const list = (o: unknown): unknown[] => (Array.isArray(o) ? o : []);

/** YouTube 的文字字段：{ simpleText } 或 { runs: [{ text }] } */
function text(o: unknown): string {
  const simple = get(o, 'simpleText');
  if (typeof simple === 'string') return simple;
  return list(get(o, 'runs'))
    .map((r) => get(r, 'text'))
    .filter((t): t is string => typeof t === 'string')
    .join('');
}

/** 正在看的视频所在的播放器：Shorts 上是 #shorts-player，页面上藏着的 #movie_player 不碰 */
function player(): YtPlayer | null {
  return document.getElementById(playerRootId(location.pathname)) as YtPlayer | null;
}

/** 当前显示的原生字幕；关着（或字幕模块没加载）时 undefined */
function currentTrack(p: YtPlayer): object | undefined {
  try {
    const t = p.getOption?.('captions', 'track');
    return t && typeof t === 'object' && typeof get(t, 'languageCode') === 'string' && get(t, 'languageCode') ? t : undefined;
  } catch {
    return undefined;
  }
}

function state(p: YtPlayer): unknown {
  const pr = p.getPlayerResponse?.();
  const tl = get(get(pr, 'captions'), 'playerCaptionsTracklistRenderer');
  const tracks = list(get(tl, 'captionTracks')).map((t) => {
    let lang = get(t, 'languageCode');
    let name = '';
    try {
      const u = new URL(String(get(t, 'baseUrl') ?? ''), location.origin);
      lang = u.searchParams.get('lang') ?? lang;
      name = u.searchParams.get('name') ?? '';
    } catch {
      // 没有地址：用 languageCode
    }
    return { lang, kind: get(t, 'kind') === 'asr' ? 'asr' : '', name, label: text(get(t, 'name')), vssId: String(get(t, 'vssId') ?? ''), translatable: get(t, 'isTranslatable') === true };
  });
  const translationLangs = list(get(tl, 'translationLanguages')).map((l) => ({ code: get(l, 'languageCode'), label: text(get(l, 'languageName')) }));
  const cur = currentTrack(p);
  const native = cur ? { lang: get(cur, 'languageCode'), kind: get(cur, 'kind') === 'asr' ? 'asr' : '', tlang: get(get(cur, 'translationLanguage'), 'languageCode') } : null;
  return { videoId: get(get(pr, 'videoDetails'), 'videoId'), tracks, translationLangs, native };
}

function handle(op: BridgeOp, args: unknown): unknown {
  const p = player();
  if (!p?.setOption || !p.getPlayerResponse) throw new Error('no player');
  switch (op) {
    case 'state':
      return state(p);
    case 'prime': {
      const lang = get(args, 'lang');
      if (!isLangCode(lang)) throw new Error('bad lang');
      p.loadModule?.('captions');
      p.setOption('captions', 'track', { languageCode: lang, ...(get(args, 'kind') === 'asr' ? { kind: 'asr' } : {}) });
      return true;
    }
    case 'hide-native': {
      const cur = currentTrack(p);
      if (cur && get(args, 'save') === true) saved = cur;
      if (cur) p.setOption('captions', 'track', {});
      return { wasOn: !!cur };
    }
    case 'restore-native': {
      const s = saved;
      saved = undefined;
      if (!s) return false;
      p.loadModule?.('captions');
      p.setOption('captions', 'track', s);
      return true;
    }
    case 'forget-native':
      saved = undefined;
      return true;
  }
}

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const m = e.data as { tag?: unknown; dir?: unknown; id?: unknown; op?: unknown; args?: unknown } | null;
  if (!m || m.tag !== BRIDGE_TAG || m.dir !== 'req' || typeof m.id !== 'number' || !(BRIDGE_OPS as readonly unknown[]).includes(m.op)) return;
  let ok = true;
  let data: unknown;
  try {
    data = handle(m.op as BridgeOp, m.args);
  } catch {
    ok = false;
  }
  window.postMessage({ tag: BRIDGE_TAG, dir: 'res', id: m.id, ok, data }, location.origin);
});
