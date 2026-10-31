import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { AuthStatus } from '../../services/auth';
import { stores } from '../../services/repo';
import type { AppError } from '../../services/errors';
import { appCtx, asAppError, useQuota, useStore, useSubtitleSpend, useXSpend } from '../shared/app';
import { ErrorBox, Notice, QuotaMeter, QuotaWarning } from '../shared/components';
import { ChangesView } from './ChangesView';
import { FindView } from './FindView';
import { ProfileView } from './ProfileView';
import { RecordsView } from './RecordsView';
import { DiscoverView } from './DiscoverView';
import { DoubanView } from './DoubanView';
import { SubtitlesView } from './SubtitlesView';
import { ReminderBanner } from './ReminderBanner';
import { runScheduledJobs } from '../../services/summary-service';

type Tab = 'find' | 'discover' | 'douban' | 'subtitles' | 'records' | 'profile' | 'changes';

function SetupBanner() {
  const ctx = appCtx();
  const settings = useStore(stores.settings);
  const secrets = useStore(stores.secrets);
  const ytAuth = useStore(stores.youtubeAuth);
  const [auth, setAuth] = useState<AuthStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError>();
  useEffect(() => {
    void ctx.auth.status().then(setAuth);
  }, [secrets, ytAuth]);
  if (!settings || !secrets || !auth) return null;
  if (auth === 'expired') {
    // 静默续期失败：就地重新授权（弹出 Google 登录窗口），不用跳去设置页
    const reauth = async () => {
      setBusy(true);
      setError(undefined);
      try {
        await ctx.auth.getToken(true);
      } catch (e) {
        setError(await asAppError(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <>
        <Notice kind="warn">
          YouTube 授权已过期，自动续期没有成功。
          <button class="btn link small" disabled={busy} onClick={() => void reauth()}>
            重新授权
          </button>
        </Notice>
        {error && <ErrorBox error={error} onClose={() => setError(undefined)} />}
      </>
    );
  }
  const provider = settings.llm.provider;
  const hasKey = provider === 'anthropic' ? !!secrets.anthropicApiKey : !!secrets.openaiApiKey;
  const items: string[] = [];
  if (!hasKey) items.push(`填写 ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API Key`);
  if (auth === 'not_configured') items.push('配置 Google OAuth 客户端');
  else if (auth === 'disconnected') items.push('连接 YouTube 账号');
  if (!items.length) return null;
  return (
    <Notice kind="warn">
      还差一步：{items.join('、')}。
      <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
        打开设置
      </button>
    </Notice>
  );
}

function App() {
  const [tab, setTab] = useState<Tab>('find');
  const [prefill, setPrefill] = useState<{ text: string; n: number; autoSubmit?: boolean }>();
  const quota = useQuota();
  const x = useXSpend();
  const sub = useSubtitleSpend();
  // 打开侧边栏时顺带跑一次例行任务（补元数据、补算总结、评估提醒）；与后台互斥，不会重复执行
  useEffect(() => {
    void runScheduledJobs(appCtx()).catch(() => undefined);
  }, []);
  return (
    <div class="app">
      <header class="top">
        <div class="brand">
          <img src="icons/icon-32.png" alt="" width={18} height={18} />
          TubeMuse
        </div>
        <QuotaMeter snap={quota} x={x} sub={sub} />
        <button class="icon-btn" title="设置" onClick={() => chrome.runtime.openOptionsPage()}>
          ⚙
        </button>
      </header>
      <SetupBanner />
      <ReminderBanner
        onUseUtterance={(text) => {
          setPrefill({ text, n: Date.now() });
          setTab('find');
        }}
      />
      <QuotaWarning snap={quota} />
      <nav class="tabs" role="tablist">
        {(
          [
            ['find', '找片'],
            ['discover', '发现'],
            ['douban', '豆瓣'],
            ['subtitles', '字幕'],
            ['records', '记录'],
            ['profile', '画像'],
            ['changes', '改进记录'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button role="tab" aria-selected={tab === id} class={`tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      <main>
        <div hidden={tab !== 'find'}>
          <FindView quota={quota} {...(prefill ? { prefill } : {})} />
        </div>
        {tab === 'discover' && (
          <DiscoverView
            onSearch={(text) => {
              setPrefill({ text, n: Date.now(), autoSubmit: true });
              setTab('find');
            }}
          />
        )}
        {tab === 'douban' && <DoubanView />}
        {tab === 'subtitles' && <SubtitlesView />}
        {tab === 'records' && <RecordsView />}
        {tab === 'profile' && <ProfileView />}
        {tab === 'changes' && <ChangesView />}
      </main>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
