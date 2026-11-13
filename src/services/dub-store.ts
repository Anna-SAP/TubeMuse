// 中文配音的音频文件（DECISIONS §73）：存在扩展自己的 IndexedDB 里（文件大，不放 chrome.storage.local）。
// 只有扩展自己的页面（侧边栏、设置页）和后台能打开它；注入网页的脚本用的是网页自己的存储，碰不到这里。
// 视频与文件的对应关系、偏移在 chrome.storage.local 的 dubs 键（stores.dubs），随导出、清空一起处理。

export interface DubAudioStore {
  put(id: string, blob: Blob): Promise<void>;
  get(id: string): Promise<Blob | undefined>;
  delete(id: string): Promise<void>;
  keys(): Promise<string[]>;
  /** 全部删除（清空全部数据时） */
  clear(): Promise<void>;
}

const DB_NAME = 'tubemuse-dub';
const STORE = 'audio';

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 出错'));
  });
}

/** 生产：扩展 origin 下的 IndexedDB（有 unlimitedStorage，不受配额限制、不会被浏览器自动清掉） */
export function indexedDbDubStore(factory: IDBFactory = indexedDB): DubAudioStore {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // 别的页面要删库（清空全部数据）时让开，下次再用时重新打开
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
      req.onerror = () => {
        opening = undefined;
        reject(req.error ?? new Error('打不开本机的配音存储（IndexedDB）'));
      };
      req.onblocked = () => undefined;
    }));
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    const t = db.transaction(STORE, mode);
    const result = promisify(fn(t.objectStore(STORE)));
    await new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('IndexedDB 出错'));
      t.onabort = () => reject(t.error ?? new Error('IndexedDB 写入被中止（可能是磁盘空间不够）'));
    });
    return result;
  };
  return {
    async put(id, blob) {
      await tx('readwrite', (s) => s.put(blob, id));
    },
    async get(id) {
      const v = await tx('readonly', (s) => s.get(id));
      return v instanceof Blob ? v : undefined;
    },
    async delete(id) {
      await tx('readwrite', (s) => s.delete(id));
    },
    async keys() {
      return (await tx('readonly', (s) => s.getAllKeys())).map(String);
    },
    async clear() {
      await tx('readwrite', (s) => s.clear());
    },
  };
}

/** 单测用 */
export function memoryDubStore(): DubAudioStore & { data: Map<string, Blob> } {
  const data = new Map<string, Blob>();
  return {
    data,
    async put(id, blob) {
      data.set(id, blob);
    },
    async get(id) {
      return data.get(id);
    },
    async delete(id) {
      data.delete(id);
    },
    async keys() {
      return [...data.keys()];
    },
    async clear() {
      data.clear();
    },
  };
}
