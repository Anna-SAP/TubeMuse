import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { authProblem, type AuthStatus } from '../../services/auth';
import { stores } from '../../services/repo';
import type { AppError } from '../../services/errors';
import { attemptView } from '../../services/auth-service';
import { appCtx, asAppError, requestYouTubeConnect, useQuota, useStore, useLlmSpend, useSubtitleSpend, useXSpend } from '../shared/app';
import { AuthAttemptNote, ErrorBox, Notice, QuotaMeter, QuotaWarning } from '../shared/components';
import { ChangesView } from './ChangesView';
import { FindView } from './FindView';
import { ProfileView } from './ProfileView';
import { RecordsView } from './RecordsView';
import { DiscoverView } from './DiscoverView';
import { DoubanView } from './DoubanView';
import { SubtitlesView } from './SubtitlesView';
import { ClipsView } from './ClipsView';
import { XhsView } from './XhsView';
import { EmailView } from './EmailView';
import { XyzView } from './XyzView';
import { DubPrompt, DubView } from './DubView';
import { StoryView } from './StoryView';
import { STORY_REQUEST_FRESH_MS, STORY_REQUEST_KEY, type StoryRequest } from './story-page';
import { ReminderBanner } from './ReminderBanner';
import { HostAccessBanner } from '../shared/host-access';
import { useMuseAsk } from './MuseAsk';
import { runScheduledJobs } from '../../services/summary-service';
import { normalizeZoom } from '../../core/zoom';
import { cssZoomOf } from '../shared/css-zoom';
import { applyZoom, useZoom, ZoomControl } from './zoom';

type Tab = 'find' | 'discover' | 'story' | 'douban' | 'xhs' | 'xyz' | 'email' | 'subtitles' | 'dub' | 'clips' | 'records' | 'profile' | 'changes';

function SetupBanner() {
  const ctx = appCtx();
  const settings = useStore(stores.settings);
  const secrets = useStore(stores.secrets);
  const ytAuth = useStore(stores.youtubeAuth);
  const attempt = useStore(stores.authAttempt);
  const [auth, setAuth] = useState<AuthStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError>();
  useEffect(() => {
    void ctx.auth.status().then(setAuth);
  }, [secrets, ytAuth]);
  if (!settings || !secrets || !auth) return null;
  // 要做的是填 / 改 Client Secret（刷新令牌还在，或还没填就没法重新授权）：直接去设置页，而不是弹授权窗口
  const needsSecret = ytAuth?.renewFix === 'secret' || !secrets.googleClientSecret;
  // 就地重新授权（后台弹出 Google 登录窗口、保存令牌），不用跳去设置页；授权成功后横幅随存储变化自动消失
  const reauth = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await requestYouTubeConnect();
    } catch (e) {
      setError(await asAppError(e));
    } finally {
      setBusy(false);
    }
  };
  const fixButton = needsSecret ? (
    <button class="btn link small" onClick={() => chrome.runtime.openOptionsPage()}>
      打开设置填 Client Secret
    </button>
  ) : (
    <button class="btn link small" disabled={busy || attemptView(attempt, Date.now()).state === 'pending'} onClick={() => void reauth()}>
      重新授权
    </button>
  );
  if (auth === 'expired') {
    const problem = authProblem(ytAuth);
    return (
      <>
        <Notice kind="warn">
          YouTube 授权已过期，自动续期没有成功。
          {fixButton}
          {problem && <div class="muted small" data-testid="renew-reason">原因：{problem}</div>}
        </Notice>
        <AuthAttemptNote attempt={attempt} hideFailure={!!error} />
        {error && <ErrorBox error={error} onClose={() => setError(undefined)} />}
      </>
    );
  }
  if (auth === 'connected' && ytAuth && !ytAuth.refreshToken) {
    // 旧版授权（升级前连接的）：现在还能用，但过期后续不上——提前说，免得到时候又看到"已过期"
    return (
      <>
        <Notice kind="warn">
          <span data-testid="legacy-auth">
            YouTube 授权是旧版：访问令牌过期后不能自动续期。{needsSecret ? '在设置页填好 OAuth Client Secret 后重新授权一次，之后会一直自动续期。' : '点"重新授权"一次，之后会一直自动续期。'}
          </span>
          {fixButton}
        </Notice>
        <AuthAttemptNote attempt={attempt} hideFailure={!!error} />
        {error && <ErrorBox error={error} onClose={() => setError(undefined)} />}
      </>
    );
  }
  const provider = settings.llm.provider;
  const hasKey = provider === 'anthropic' ? !!secrets.anthropicApiKey : !!secrets.openaiApiKey;
  const items: string[] = [];
  if (!hasKey) items.push(`填写 ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API Key`);
  if (auth === 'not_configured') items.push('配置 Google OAuth 客户端');
  else if (auth === 'disconnected') items.push(secrets.googleClientSecret ? '连接 YouTube 账号' : '填写 Google OAuth Client Secret 并连接 YouTube 账号');
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

/**
 * 导航栏固定（图钉）：吸附在头部下方。头部本身也是吸顶的，高度会变（配额条数、窗口宽度），
 * 所以用 ResizeObserver 量出来写进 CSS 变量 --top-h。导航栏原位置滚出视野、真正吸附住时加一道分隔阴影；
 * scroll-padding-top 让页面内的跳转定位、键盘聚焦不被头部和导航栏挡住。
 */
function usePinnedNav(pinned: boolean, zoom: number) {
  const header = useRef<HTMLElement>(null);
  const nav = useRef<HTMLElement>(null);
  /** 导航栏原来的位置（紧贴在它前面的空元素）：它滚到头部下沿之上，就说明导航栏吸附住了 */
  const anchor = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const update = () => {
      // 用 getBoundingClientRect 的小数高度：offsetHeight 取整，会让没滚动时也误判为"吸附住"
      const headerH = header.current?.getBoundingClientRect().height ?? 0;
      const navH = pinned ? (nav.current?.getBoundingClientRect().height ?? 0) : 0;
      // 量出来的是缩放之后的视口像素，写回 CSS 的长度是缩放之前的（侧边栏缩放，DECISIONS §80）：除以缩放倍数
      const z = cssZoomOf(header.current);
      root.style.setProperty('--top-h', `${headerH / z}px`);
      // 固定着的导航栏有多高（没固定时 0）：配音页的差距读数吸在它下面（DECISIONS §78）
      root.style.setProperty('--nav-h', `${navH / z}px`);
      root.style.scrollPaddingTop = `${(headerH + navH) / z}px`;
      setStuck(pinned && !!anchor.current && anchor.current.getBoundingClientRect().top < headerH - 0.5);
    };
    const ro = new ResizeObserver(update);
    if (header.current) ro.observe(header.current);
    if (nav.current) ro.observe(nav.current);
    window.addEventListener('scroll', update, { passive: true });
    update();
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', update);
    };
    // 缩放变了也重新量一次：头部的高度（缩放前的像素）可能因为重新折行而变
  }, [pinned, zoom]);
  /** 固定并吸附着时切换标签页：回到新页面的开头（紧贴导航栏下方），而不是停在上一页滚到的位置 */
  const toContentTop = () => {
    if (!stuck || !anchor.current || !header.current) return;
    window.scrollTo({ top: anchor.current.getBoundingClientRect().top + window.scrollY - header.current.getBoundingClientRect().height });
  };
  return { header, nav, anchor, stuck, toContentTop };
}

/**
 * 右键菜单「TubeMuse：讲讲这个故事」/ 快捷键：后台先打开侧边栏、再在 chrome.storage.session 里留话（读哪个标签页）。
 * 侧边栏打开时、或开着时收到留话，切到「故事」页去读那个标签页；读了就删掉这条留话
 */
function useStoryRequest(onRequest: (r: StoryRequest) => void) {
  useEffect(() => {
    const session = chrome.storage.session;
    if (!session) return;
    const take = (v: unknown) => {
      const r = v as StoryRequest | undefined;
      if (!r || typeof r.tabId !== 'number' || typeof r.at !== 'number') return;
      void session.remove(STORY_REQUEST_KEY);
      if (Date.now() - r.at <= STORY_REQUEST_FRESH_MS) onRequest(r);
    };
    void session.get(STORY_REQUEST_KEY).then((all) => take(all[STORY_REQUEST_KEY]), () => undefined);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[STORY_REQUEST_KEY]?.newValue) take(changes[STORY_REQUEST_KEY].newValue);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
}

function PinIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 3h8" />
      <path d="M10 3v6l-3 4h10l-3-4V3" fill={on ? 'currentColor' : 'none'} />
      <path d="M12 13v8" />
    </svg>
  );
}

function App({ initialZoom }: { initialZoom: number }) {
  const [tab, setTab] = useState<Tab>('find');
  const [prefill, setPrefill] = useState<{ text: string; n: number; autoSubmit?: boolean }>();
  const [storyRequest, setStoryRequest] = useState<{ tabId: number; n: number }>();
  const quota = useQuota();
  const x = useXSpend();
  const sub = useSubtitleSpend();
  const llm = useLlmSpend();
  const settings = useStore(stores.settings);
  const pinned = settings?.ui.pinNav ?? false;
  const zoom = useZoom(settings?.ui.zoom, initialZoom);
  const pin = usePinnedNav(pinned, zoom.zoom);
  const muse = useMuseAsk();
  const togglePin = () => void stores.settings.update(appCtx().kv, appCtx().locker, (s) => ({ ...s, ui: { ...s.ui, pinNav: !s.ui.pinNav } }));
  const go = (id: Tab) => {
    pin.toContentTop();
    setTab(id);
  };
  useStoryRequest((r) => {
    setStoryRequest({ tabId: r.tabId, n: Date.now() });
    go('story');
  });
  // 打开侧边栏时顺带跑一次例行任务（补元数据、补算总结、评估提醒）；与后台互斥，不会重复执行
  useEffect(() => {
    void runScheduledJobs(appCtx()).catch(() => undefined);
  }, []);
  return (
    <div class="app">
      <header class="top" ref={pin.header}>
        <div class="brand-col">
          <div class="brand">
            <img src="icons/icon-32.png" alt="" width={18} height={18} />
            TubeMuse
          </div>
          <ZoomControl state={zoom} />
        </div>
        <QuotaMeter snap={quota} x={x} sub={sub} llm={llm} />
        {muse.button}
        <button class="icon-btn" title="设置" onClick={() => chrome.runtime.openOptionsPage()}>
          ⚙
        </button>
      </header>
      {muse.panel}
      <HostAccessBanner />
      <SetupBanner />
      <ReminderBanner
        onUseUtterance={(text) => {
          setPrefill({ text, n: Date.now() });
          go('find');
        }}
      />
      <DubPrompt hidden={tab === 'dub'} onOpen={() => go('dub')} />
      <QuotaWarning snap={quota} />
      <div ref={pin.anchor} />
      <nav class={`tabs${pinned ? ' pinned' : ''}${pin.stuck ? ' stuck' : ''}`} ref={pin.nav} data-testid="nav">
        <div class="tab-list" role="tablist">
          {(
            [
              ['find', '找片'],
              ['discover', '发现'],
              ['story', '故事'],
              ['douban', '豆瓣'],
              ['xhs', '小红书'],
              ['xyz', '小宇宙'],
              ['email', 'eMails'],
              ['subtitles', '字幕'],
              ['dub', '配音'],
              ['clips', '片段'],
              ['records', '记录'],
              ['profile', '画像'],
              ['changes', '改进记录'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button role="tab" aria-selected={tab === id} class={`tab${tab === id ? ' on' : ''}`} onClick={() => go(id)}>
              {label}
            </button>
          ))}
        </div>
        <button
          class={`icon-btn pin-btn${pinned ? ' on' : ''}`}
          aria-pressed={pinned}
          title={pinned ? '取消固定：导航栏随页面滚动' : '固定导航栏：往下滚动时保持可见'}
          data-testid="pin-nav"
          onClick={togglePin}
        >
          <PinIcon on={pinned} />
        </button>
      </nav>
      <main>
        <div hidden={tab !== 'find'}>
          <FindView quota={quota} {...(prefill ? { prefill } : {})} />
        </div>
        {tab === 'discover' && (
          <DiscoverView
            onSearch={(text) => {
              setPrefill({ text, n: Date.now(), autoSubmit: true });
              go('find');
            }}
          />
        )}
        <div hidden={tab !== 'story'}>
          <StoryView request={storyRequest} />
        </div>
        {tab === 'douban' && <DoubanView />}
        {tab === 'xhs' && <XhsView />}
        {tab === 'xyz' && <XyzView />}
        {tab === 'email' && <EmailView />}
        {tab === 'subtitles' && <SubtitlesView />}
        {tab === 'dub' && <DubView />}
        {tab === 'clips' && <ClipsView />}
        {tab === 'records' && <RecordsView />}
        {tab === 'profile' && <ProfileView />}
        {tab === 'changes' && <ChangesView />}
      </main>
    </div>
  );
}

// 先读出存下的缩放档位、用上，再画页面：免得每次打开先按 100% 闪一下再跳到你选的大小。读不到就按 100% 画
void stores.settings
  .read(appCtx().kv)
  .then(
    (s) => normalizeZoom(s.ui.zoom),
    () => normalizeZoom(undefined),
  )
  .then((zoom) => {
    applyZoom(zoom);
    render(<App initialZoom={zoom} />, document.getElementById('app')!);
  });
