// Chrome 自带的本地翻译（Translator API，Chrome 138+）：语言包在本机，不花钱、字幕文字不离开电脑。
// 2026-11-06 实测（Chromium 156）：扩展的 service worker 里能用这个 API，不需要新权限；
// 但语言包还没下载时，那里的 create() 既不成功也不报错，一直挂着。所以后台先查 availability，只有 available 才创建，另加超时。
// 语言包只从设置页的按钮下载（Chrome 要求第一次下载时有用户操作）。

import { SUBTITLES } from '../config/defaults';

export type LocalAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

export interface LanguagePair {
  source: string;
  target: string;
}

export interface LocalTranslator {
  availability(pair: LanguagePair): Promise<LocalAvailability>;
  /** 翻一句；语言包没下载、这对语言不支持时抛出 LocalTranslateError */
  translate(pair: LanguagePair, text: string): Promise<string>;
  /** 必须在按钮的点击事件里同步调用：下载语言包要用户操作。返回准备好了几对、哪几对没成 */
  prepare(pairs: readonly LanguagePair[]): Promise<{ ready: number; failed: string[] }>;
}

export class LocalTranslateError extends Error {
  constructor(
    readonly reason: 'need_download' | 'unsupported' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'LocalTranslateError';
  }
}

interface TranslatorSession {
  translate(text: string): Promise<string>;
}

interface TranslatorApi {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(o: { sourceLanguage: string; targetLanguage: string }): Promise<TranslatorSession>;
}

const api = () => (globalThis as { Translator?: TranslatorApi }).Translator;
const options = (p: LanguagePair) => ({ sourceLanguage: p.source, targetLanguage: p.target });
const pairName = (p: LanguagePair) => `${p.source} → ${p.target}`;

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LocalTranslateError('failed', `${what}没有回应`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** 这个浏览器没有 Translator API 时返回 undefined（Chrome 138 以下、其他 Chromium 浏览器） */
export function chromeLocalTranslator(): LocalTranslator | undefined {
  if (!api()) return undefined;
  const sessions = new Map<string, Promise<TranslatorSession>>();
  const session = (p: LanguagePair) => {
    const key = pairName(p);
    let s = sessions.get(key);
    if (!s) {
      s = api()!.create(options(p));
      sessions.set(key, s);
      s.catch(() => sessions.delete(key));
    }
    return s;
  };
  const availability = async (p: LanguagePair) => (await api()!.availability(options(p))) as LocalAvailability;
  return {
    availability,
    async translate(p, text) {
      if (!sessions.has(pairName(p))) {
        const status = await withTimeout(availability(p), SUBTITLES.localTranslateTimeoutMs, '本地翻译');
        if (status === 'unavailable') throw new LocalTranslateError('unsupported', `Chrome 的本地翻译不支持 ${pairName(p)}`);
        if (status !== 'available') throw new LocalTranslateError('need_download', `还没下载 ${pairName(p)} 的语言包`);
      }
      try {
        const s = await withTimeout(session(p), SUBTITLES.localTranslateTimeoutMs, '本地翻译');
        return await withTimeout(s.translate(text), SUBTITLES.localTranslateTimeoutMs, '本地翻译');
      } catch (e) {
        sessions.delete(pairName(p));
        if (e instanceof LocalTranslateError) throw e;
        throw new LocalTranslateError('failed', `本地翻译出错：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    async prepare(pairs) {
      const results = await Promise.allSettled(pairs.map((p) => withTimeout(session(p), SUBTITLES.localPrepareTimeoutMs, '语言包下载')));
      const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [pairName(pairs[i]!)] : []));
      return { ready: results.length - failed.length, failed };
    },
  };
}
