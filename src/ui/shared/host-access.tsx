// Firefox（DECISIONS §69）：MV3 扩展的"访问网站数据"权限你可以在附加组件管理器里收回（Firefox 127 起安装时默认给）。
// 收回后：访问各官方 API 的请求被浏览器挡下、注入网页的脚本不再运行——功能一声不响地坏掉。
// 这里查一下 manifest 里要的网站都还在不在，缺了就写明缺哪些、会影响什么，并给一个"授权"按钮（浏览器会弹窗让你确认）。
// 只在 Firefox 版显示：Chrome 安装时就给了这些权限。

import { useEffect, useState } from 'preact/hooks';
import { IS_FIREFOX } from '../../platform';

/** manifest 里要的全部网站：API 的 host_permissions + 各内容脚本的 matches（去重） */
export function requestedOrigins(manifest: { host_permissions?: string[]; content_scripts?: { matches?: string[] }[] }): string[] {
  return [...new Set([...(manifest.host_permissions ?? []), ...(manifest.content_scripts ?? []).flatMap((c) => c.matches ?? [])])];
}

async function missingOrigins(): Promise<string[]> {
  const all = requestedOrigins(chrome.runtime.getManifest() as Parameters<typeof requestedOrigins>[0]);
  const granted = await Promise.all(all.map((o) => chrome.permissions.contains({ origins: [o] }).catch(() => true)));
  return all.filter((_, i) => !granted[i]);
}

export function HostAccessBanner() {
  const [missing, setMissing] = useState<string[]>([]);
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    if (!IS_FIREFOX) return;
    const check = () => void missingOrigins().then(setMissing, () => setMissing([]));
    check();
    chrome.permissions.onAdded.addListener(check);
    chrome.permissions.onRemoved.addListener(check);
    return () => {
      chrome.permissions.onAdded.removeListener(check);
      chrome.permissions.onRemoved.removeListener(check);
    };
  }, []);
  if (!IS_FIREFOX || !missing.length) return null;
  const hosts = missing.map((o) => o.replace(/^\w+:\/\//, '').replace(/\/\*$/, ''));
  return (
    <div class="notice notice-error" data-testid="host-access">
      <p>
        Firefox 现在不让 TubeMuse 访问这些网站：<strong>{hosts.join('、')}</strong>。缺了它们，对应的功能用不了（官方 API 的请求会被浏览器挡下；YouTube、小红书、Gmail 等页面上的观看记录、字幕、片段录制、收藏不会运行）。
      </p>
      <p class="small">
        <button
          class="btn primary"
          onClick={() => {
            // 必须在点击的这一刻调用（Firefox 只在用户操作时弹授权框）
            chrome.permissions.request({ origins: missing }).then(
              (ok) => setRefused(!ok),
              () => setRefused(true),
            );
          }}
        >
          授权访问这些网站
        </button>
        {refused && <span class="warn-text"> 没有授权：也可以在 about:addons → TubeMuse →「权限」里打开。</span>}
      </p>
    </div>
  );
}
