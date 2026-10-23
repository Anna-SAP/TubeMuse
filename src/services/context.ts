// 运行时依赖集中注入：页面里用真实实现，单测里换成内存存储 + mock fetch。

import { ENDPOINTS, type Endpoints } from '../config/endpoints';
import { chromeAuth, type AuthProvider } from './auth';
import { chromeKV, webLocker, type KV, type Locker } from './storage';

export interface AppContext {
  kv: KV;
  locker: Locker;
  http: typeof fetch;
  now: () => number;
  auth: AuthProvider;
  endpoints: Endpoints;
  timeZone: string;
}

export function createBrowserContext(): AppContext {
  return {
    kv: chromeKV(),
    locker: webLocker(),
    // 包一层，避免把未绑定的 window.fetch 交给 SDK 导致 "Illegal invocation"
    http: (input, init) => fetch(input, init),
    now: () => Date.now(),
    auth: chromeAuth(),
    endpoints: ENDPOINTS,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
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
