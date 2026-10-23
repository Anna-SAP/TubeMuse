// 本地存储抽象：生产用 chrome.storage.local（unlimitedStorage），测试用内存实现。
// 跨上下文（侧边栏 / 设置页 / service worker）的读改写用 Web Locks 串行化——它们同属扩展 origin。

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  getAll(): Promise<Record<string, unknown>>;
  clear(): Promise<void>;
}

export interface Locker {
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export function chromeKV(area: chrome.storage.StorageArea = chrome.storage.local): KV {
  return {
    async get<T>(key: string) {
      const r = await area.get(key);
      return r[key] as T | undefined;
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
    async remove(key) {
      await area.remove(key);
    },
    async getAll() {
      return (await area.get(null)) as Record<string, unknown>;
    },
    async clear() {
      await area.clear();
    },
  };
}

export function webLocker(): Locker {
  return {
    withLock: (name, fn) => navigator.locks.request(`tubemuse:${name}`, fn),
  };
}

export function memoryKV(initial: Record<string, unknown> = {}): KV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(structuredClone(initial)));
  return {
    data,
    async get<T>(key: string) {
      const v = data.get(key);
      return v === undefined ? undefined : (structuredClone(v) as T);
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async remove(key) {
      data.delete(key);
    },
    async getAll() {
      return structuredClone(Object.fromEntries(data));
    },
    async clear() {
      data.clear();
    },
  };
}

export function memoryLocker(): Locker {
  const tails = new Map<string, Promise<unknown>>();
  return {
    withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      tails.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    },
  };
}
