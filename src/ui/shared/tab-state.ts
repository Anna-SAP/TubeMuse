// 侧边栏跟踪本窗口的当前标签页：向它的内容脚本要状态，并接收脚本主动推送的变化（只在本扩展内部传递）。

import { useEffect, useState } from 'preact/hooks';

/**
 * getType：向内容脚本要状态的消息类型；pushType：内容脚本主动推送的消息类型。
 * pollMs：额外每隔这么久再问一次（推送里不含的、一直在变的字段，例如播放位置）。
 * state 为 null 表示当前标签页没有这个内容脚本（不是 YouTube 页面，或页面在扩展安装前打开）。
 */
export function useActiveTabState<T>(getType: string, pushType: string, pollMs?: number): { tabId?: number; state?: T | null } {
  const [tabId, setTabId] = useState<number>();
  const [state, setState] = useState<T | null>();
  useEffect(() => {
    let windowId: number | undefined;
    let current: number | undefined;
    const ask = (id: number | undefined) => {
      current = id;
      setTabId(id);
      if (id === undefined) return setState(null);
      chrome.tabs.sendMessage(id, { type: getType }).then(
        (s: T | undefined) => current === id && setState(s ?? null),
        () => current === id && setState(null),
      );
    };
    const onActivated = (info: chrome.tabs.OnActivatedInfo) => info.windowId === windowId && ask(info.tabId);
    const onUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (tab.active && tab.windowId === windowId && (change.status === 'complete' || change.url)) ask(id);
    };
    const onMessage = (msg: unknown, sender: chrome.runtime.MessageSender) => {
      const m = msg as { type?: string; state?: T };
      if (m?.type === pushType && sender.tab?.id === current && m.state) setState(m.state);
      return false;
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.runtime.onMessage.addListener(onMessage);
    void chrome.windows.getCurrent().then(async (w) => {
      windowId = w.id;
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      ask(tab?.id);
    });
    const poll = pollMs ? setInterval(() => current !== undefined && ask(current), pollMs) : undefined;
    return () => {
      if (poll) clearInterval(poll);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, [getType, pushType, pollMs]);
  return { ...(tabId !== undefined ? { tabId } : {}), state };
}
