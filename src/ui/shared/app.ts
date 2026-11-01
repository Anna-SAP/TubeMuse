// 页面共用：运行时上下文单例、存储订阅 hook、错误展示格式。

import { useEffect, useState } from 'preact/hooks';
import { AUTH_CONNECT_MESSAGE, fromAuthReply, type AuthConnectReply } from '../../services/auth-service';
import { createBrowserContext, type AppContext } from '../../services/context';
import { toAppError, type AppError } from '../../services/errors';
import { quotaSnapshot } from '../../services/quota-service';
import { xSpend } from '../../services/hotspot-service';
import { subtitleSpend } from '../../services/subtitle-service';
import type { SubtitleSnapshot } from '../../core/subtitles';
import { stores, type Store } from '../../services/repo';
import type { QuotaSnapshot } from '../../core/quota';

let ctxSingleton: AppContext | undefined;
export function appCtx(): AppContext {
  ctxSingleton ??= createBrowserContext();
  return ctxSingleton;
}

/** 读取某个存储键，并在其他页面（侧边栏/设置页）修改它时自动刷新。store 为空时返回 undefined。 */
export function useStore<T>(store: Store<T> | undefined): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    if (!store) return setValue(undefined);
    let alive = true;
    const load = () => store.read(appCtx().kv).then((v) => alive && setValue(v));
    void load();
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (store.key in changes || Object.keys(changes).length === 0)) void load();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [store]);
  return value;
}

/** 配额快照：账本或设置变化时刷新，并每分钟刷新一次（跨过太平洋时间零点要归零）。 */
export function useQuota(): QuotaSnapshot | undefined {
  const ledger = useStore(stores.quotaLedger);
  const settings = useStore(stores.settings);
  const [tick, setTick] = useState(0);
  const [snap, setSnap] = useState<QuotaSnapshot>();
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    void quotaSnapshot(appCtx()).then(setSnap);
  }, [ledger, settings, tick]);
  return snap;
}

export async function secretsList(): Promise<string[]> {
  const s = await stores.secrets.read(appCtx().kv);
  return [s.anthropicApiKey, s.openaiApiKey, s.xBearerToken].filter((x): x is string => !!x);
}

/** 连接 / 重新授权 YouTube：交给后台打开授权窗口、保存令牌（这个页面中途被关掉也不丢结果）。失败时抛出人话错误 */
export async function requestYouTubeConnect(): Promise<void> {
  fromAuthReply((await chrome.runtime.sendMessage({ type: AUTH_CONNECT_MESSAGE })) as AuthConnectReply | undefined);
}

/** 统一把异常转成可展示的错误（已脱敏） */
export async function asAppError(e: unknown): Promise<AppError> {
  const err = toAppError(e, await secretsList());
  if (err.kind === 'internal') console.warn('[TubeMuse]', err.message);
  return err;
}

/** X 花费快照（只有开启并填写了 Token 时才返回），账本或设置变化时刷新 */
export function useXSpend(): import('../../core/x-budget').XSnapshot | undefined {
  const ledger = useStore(stores.xLedger);
  const settings = useStore(stores.settings);
  const secrets = useStore(stores.secrets);
  const [tick, setTick] = useState(0);
  const [snap, setSnap] = useState<import('../../core/x-budget').XSnapshot>();
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!settings?.x.enabled || !secrets?.xBearerToken) return setSnap(undefined);
    void xSpend(appCtx()).then(setSnap);
  }, [ledger, settings, secrets, tick]);
  return snap;
}

/** 自动字幕花费快照（开启自动字幕时返回），账本或设置变化时刷新 */
export function useSubtitleSpend(): SubtitleSnapshot | undefined {
  const ledger = useStore(stores.subtitleLedger);
  const settings = useStore(stores.settings);
  const [tick, setTick] = useState(0);
  const [snap, setSnap] = useState<SubtitleSnapshot>();
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!settings?.subtitles.enabled) return setSnap(undefined);
    void subtitleSpend(appCtx()).then(setSnap);
  }, [ledger, settings, tick]);
  return snap;
}
