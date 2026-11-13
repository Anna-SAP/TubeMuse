// 运行时依赖集中注入：页面里用真实实现，单测里换成内存存储 + mock fetch。

import { ENDPOINTS, type Endpoints } from '../config/endpoints';
import { chromeAuth, type AuthProvider } from './auth';
import { chromeLocalTranslator, type LocalTranslator } from './local-translator';
import { chromeKV, webLocker, type KV, type Locker } from './storage';
import { indexedDbDubStore, type DubAudioStore } from './dub-store';

export interface AppContext {
  kv: KV;
  locker: Locker;
  http: typeof fetch;
  now: () => number;
  auth: AuthProvider;
  endpoints: Endpoints;
  timeZone: string;
  /** Chrome 自带的本地翻译；浏览器不支持时为空 */
  translator?: LocalTranslator;
  /** 中文配音的音频文件（扩展自己的 IndexedDB，DECISIONS §74）；没有 IndexedDB 的环境为空 */
  dubAudio?: DubAudioStore;
}

export function createBrowserContext(): AppContext {
  const kv = chromeKV();
  const locker = webLocker();
  const translator = chromeLocalTranslator();
  return {
    kv,
    locker,
    // 包一层，避免把未绑定的 window.fetch 交给 SDK 导致 "Illegal invocation"
    http: (input, init) => fetch(input, init),
    now: () => Date.now(),
    auth: chromeAuth(kv, locker),
    endpoints: ENDPOINTS,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    ...(translator ? { translator } : {}),
    ...(typeof indexedDB !== 'undefined' ? { dubAudio: indexedDbDubStore() } : {}),
  };
}

/** 带时区偏移的本地时间 ISO 串，例如 2026-10-24T10:00:00+08:00（告诉 LLM"现在"是什么时候） */
export function localIso(at: number): string {
  const d = new Date(at);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}
