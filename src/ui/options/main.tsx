// 设置页：LLM Key、YouTube 授权、配额与找片偏好、语音、学习开关、自动字幕、数据导出与清空。

import { render } from 'preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { BROWSER_SPEECH_LANGS, DEFAULT_SETTINGS, GOOGLE_OAUTH_SCOPE, SUBTITLE_LANGS, type BrowserSpeechLang, type SubtitleLang } from '../../config/defaults';
import { asrPrice, hourlyEstimateUsd, llmPrice } from '../../core/subtitles';
import { subtitleTranslationModel } from '../../services/subtitle-service';
import { browserSpeechEnv, detectLocal, installLocal, type LocalAvailability } from '../../services/speech';
import { ENDPOINTS } from '../../config/endpoints';
import { oauthClientId, oauthRedirectUrl, type AuthStatus } from '../../services/auth';
import { clearAll, exportAll } from '../../services/data-service';
import type { AppError } from '../../services/errors';
import { isAnthropicWorkspaceId } from '../../services/llm';
import { pingLlm } from '../../services/llm-factory';
import { mutedDaysLeft, reminderActions } from '../../services/reminder-service';
import { reclassifyRecords } from '../../services/watch-service';
import { stores, type Secrets, type Settings } from '../../services/repo';
import { appCtx, asAppError, useQuota, useStore } from '../shared/app';
import { ErrorBox, Notice, QuotaMeter } from '../shared/components';

function Section({ title, children, id }: { title: string; children: ComponentChildren; id?: string }) {
  return (
    <section class="panel" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function NumField({ label, value, min, max, step = 1, onChange, hint }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; hint?: string }) {
  return (
    <label class="field">
      <span>{label}</span>
      <input
        class="input num"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
        }}
      />
      {hint && <span class="muted small">{hint}</span>}
    </label>
  );
}

function KeyField({ label, saved, onSave, onClear, testid }: { label: string; saved: boolean; onSave: (v: string) => void; onClear: () => void; testid: string }) {
  const [draft, setDraft] = useState('');
  return (
    <div class="field">
      <span>{label}</span>
      <div class="row">
        <input
          class="input"
          type="password"
          autocomplete="off"
          data-testid={testid}
          placeholder={saved ? '已保存（出于安全不回显）' : '粘贴 API Key'}
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <button
          class="btn"
          disabled={!draft.trim()}
          onClick={() => {
            onSave(draft.trim());
            setDraft('');
          }}
        >
          保存
        </button>
        {saved && (
          <button class="btn link" onClick={onClear}>
            删除
          </button>
        )}
      </div>
    </div>
  );
}

/** 工作区 ID 不是密钥，保存后照常显示；只有 Key 没绑定工作区时才需要。 */
function WorkspaceField({ saved, onSave, onClear }: { saved?: string; onSave: (v: string) => void; onClear: () => void }) {
  const [draft, setDraft] = useState('');
  const value = draft.trim();
  const invalid = !!value && !isAnthropicWorkspaceId(value);
  return (
    <div class="field">
      <span>Anthropic 工作区 ID（可选）</span>
      <div class="row">
        <input
          class="input"
          autocomplete="off"
          data-testid="anthropic-workspace"
          placeholder={saved ?? 'wrkspc_…'}
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <button
          class="btn"
          disabled={!value || invalid}
          onClick={() => {
            onSave(value);
            setDraft('');
          }}
        >
          保存
        </button>
        {saved && (
          <button class="btn link" onClick={onClear}>
            删除
          </button>
        )}
      </div>
      {invalid && <span class="warn-text small">应以 wrkspc_ 开头，从 Anthropic Console → Settings → Workspaces 的 ID 列整段复制</span>}
      <span class="muted small">
        {saved ? <>已保存：<code>{saved}</code>。</> : null}
        只有报错"Key 没有绑定工作区"时才需要填写；限定到某个工作区的 Key 留空即可。只随请求头发往 {new URL(ENDPOINTS.anthropic).host}。
      </span>
    </div>
  );
}

function App() {
  const ctx = appCtx();
  const settings = useStore(stores.settings);
  const secrets = useStore(stores.secrets);
  const reminder = useStore(stores.reminderState);
  const ytAuth = useStore(stores.youtubeAuth);
  const quota = useQuota();
  const [auth, setAuth] = useState<AuthStatus>();
  const [error, setError] = useState<AppError>();
  const [ok, setOk] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [clearStep, setClearStep] = useState(0);
  const [clearText, setClearText] = useState('');

  const refreshAuth = () => void ctx.auth.status().then(setAuth);
  useEffect(refreshAuth, [ytAuth]);

  if (!settings || !secrets) return null;

  const updateSettings = (fn: (s: Settings) => Settings) => void stores.settings.update(ctx.kv, ctx.locker, fn);
  const updateTracking = (patch: Partial<Settings['tracking']>) =>
    void stores.settings
      .update(ctx.kv, ctx.locker, (s) => ({ ...s, tracking: { ...s.tracking, ...patch } }))
      .then(() => reclassifyRecords(ctx));
  const updateSecrets = (patch: Partial<Secrets>) =>
    void stores.secrets.update(ctx.kv, ctx.locker, (s) => {
      const next = { ...s, ...patch };
      for (const k of Object.keys(next) as (keyof Secrets)[]) if (!next[k]) delete next[k];
      return next;
    });

  const act = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(undefined);
    setOk(undefined);
    try {
      const msg = await fn();
      if (msg) setOk(msg);
    } catch (e) {
      setError(await asAppError(e));
    } finally {
      setBusy(false);
      refreshAuth();
    }
  };

  const extId = chrome.runtime.id;
  const clientId = oauthClientId();
  const redirectUrl = oauthRedirectUrl();
  const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const authText =
    auth === 'not_configured'
      ? '未配置 OAuth 客户端'
      : auth === 'expired'
        ? '授权已过期，自动续期没有成功，请重新授权'
        : auth === 'connected'
          ? ytAuth?.expiresAt && ytAuth.expiresAt > Date.now()
            ? `已连接（访问令牌有效至 ${hhmm(ytAuth.expiresAt)}，过期后自动续期）`
            : '已连接（访问令牌已过期，下次使用时自动续期）'
          : '未连接';
  const provider = settings.llm.provider;

  return (
    <div class="options">
      <header class="top">
        <div class="brand">
          <img src="icons/icon-32.png" alt="" width={20} height={20} /> TubeMuse 设置
        </div>
        <QuotaMeter snap={quota} />
      </header>
      {error && <ErrorBox error={error} onClose={() => setError(undefined)} />}
      {ok && (
        <Notice kind="ok" onClose={() => setOk(undefined)}>
          {ok}
        </Notice>
      )}

      <Section title="1. 大模型（LLM）" id="llm">
        <p class="muted small">用于理解口令、归纳兴趣簇。Key 只保存在本机浏览器，只随请求发往对应服务（{new URL(ENDPOINTS.anthropic).host} / {new URL(ENDPOINTS.openai).host}）。</p>
        <div class="field">
          <span>当前使用</span>
          <div class="row">
            {(['anthropic', 'openai'] as const).map((p) => (
              <label class="inline">
                <input type="radio" name="provider" checked={provider === p} onChange={() => updateSettings((s) => ({ ...s, llm: { ...s.llm, provider: p } }))} />
                {p === 'anthropic' ? 'Anthropic' : 'OpenAI'}
              </label>
            ))}
          </div>
        </div>
        <KeyField label="Anthropic API Key" testid="anthropic-key" saved={!!secrets.anthropicApiKey} onSave={(v) => updateSecrets({ anthropicApiKey: v })} onClear={() => updateSecrets({ anthropicApiKey: '' })} />
        <WorkspaceField saved={secrets.anthropicWorkspaceId} onSave={(v) => updateSecrets({ anthropicWorkspaceId: v })} onClear={() => updateSecrets({ anthropicWorkspaceId: '' })} />
        <label class="field">
          <span>Anthropic 模型名</span>
          <input
            class="input"
            value={settings.llm.models.anthropic}
            onChange={(e) => updateSettings((s) => ({ ...s, llm: { ...s.llm, models: { ...s.llm.models, anthropic: e.currentTarget.value.trim() || DEFAULT_SETTINGS.llm.models.anthropic } } }))}
          />
        </label>
        <KeyField label="OpenAI API Key" testid="openai-key" saved={!!secrets.openaiApiKey} onSave={(v) => updateSecrets({ openaiApiKey: v })} onClear={() => updateSecrets({ openaiApiKey: '' })} />
        <label class="field">
          <span>OpenAI 模型名</span>
          <input
            class="input"
            value={settings.llm.models.openai}
            onChange={(e) => updateSettings((s) => ({ ...s, llm: { ...s.llm, models: { ...s.llm.models, openai: e.currentTarget.value.trim() || DEFAULT_SETTINGS.llm.models.openai } } }))}
          />
        </label>
        <button class="btn" disabled={busy} onClick={() => act(() => pingLlm(ctx))}>
          测试连接（会产生一次极小的真实调用）
        </button>
      </Section>

      <Section title="2. YouTube 账号（只读授权）" id="youtube">
        <dl class="kv">
          <dt>扩展 ID</dt>
          <dd>
            <code data-testid="extension-id">{extId}</code>
          </dd>
          <dt>授权回跳地址</dt>
          <dd>
            <code data-testid="redirect-url">{redirectUrl}</code>
          </dd>
          <dt>OAuth Client ID</dt>
          <dd>{clientId ? <code>{clientId}</code> : <span class="warn-text">未配置（见 README「Google Cloud 配置」）</span>}</dd>
          <dt>申请的权限</dt>
          <dd>
            <code>{GOOGLE_OAUTH_SCOPE}</code>（只读：订阅、喜欢的视频、搜索）
          </dd>
          <dt>状态</dt>
          <dd data-testid="auth-status">{authText}</dd>
        </dl>
        <p class="muted small">
          在 Google Cloud 创建"Web 应用"类型的 OAuth 客户端，"已获授权的重定向 URI"填上面的回跳地址（整段复制，含结尾的 /）。点"连接 YouTube"会弹出 Google 登录窗口，在窗口里登录你加进测试用户的 Google 账号即可，不需要登录浏览器本身。
        </p>
        <div class="row">
          <button class="btn primary" disabled={busy || auth === 'not_configured'} onClick={() => act(async () => (await ctx.auth.getToken(true), 'YouTube 已连接'))}>
            {auth === 'expired' ? '重新授权' : '连接 YouTube'}
          </button>
          {(auth === 'connected' || auth === 'expired') && (
            <button
              class="btn"
              disabled={busy}
              onClick={() =>
                act(async () =>
                  (await ctx.auth.disconnect()).revoked ? '已断开，并已向 Google 吊销访问令牌' : '已断开（本地令牌已删除）。如需彻底撤销，到 Google 账号「第三方应用和服务」里移除 TubeMuse',
                )
              }
            >
              断开
            </button>
          )}
        </div>
      </Section>

      <Section title="3. 配额与找片" id="quota">
        <p class="muted small">
          YouTube 自 2026-06-01 起分桶计配额：search.list 单独计"次数"（默认每天 100 次），其他接口共用 units（默认每天 10,000）。都在美国太平洋时间零点重置。下面的上限请与你 GCP 项目「配额」页面的实际值保持一致。
        </p>
        <div class="grid">
          <NumField label="search 每日次数上限" value={settings.quota.searchDailyCalls} min={1} max={100000} onChange={(v) => updateSettings((s) => ({ ...s, quota: { ...s.quota, searchDailyCalls: v } }))} />
          <NumField label="其他接口每日 units 上限" value={settings.quota.generalDailyUnits} min={1} max={10000000} onChange={(v) => updateSettings((s) => ({ ...s, quota: { ...s.quota, generalDailyUnits: v } }))} />
          <NumField label="单次口令最多 search 次数" value={settings.quota.searchCallsPerQuery} min={1} max={10} onChange={(v) => updateSettings((s) => ({ ...s, quota: { ...s.quota, searchCallsPerQuery: v } }))} />
          <NumField label="单次口令最多 units" value={settings.quota.generalUnitsPerQuery} min={2} max={1000} onChange={(v) => updateSettings((s) => ({ ...s, quota: { ...s.quota, generalUnitsPerQuery: v } }))} />
          <NumField label="提示阈值（已用比例）" value={settings.quota.warnRatio} min={0.1} max={1} step={0.05} onChange={(v) => updateSettings((s) => ({ ...s, quota: { ...s.quota, warnRatio: v } }))} />
          <NumField label="结果缓存（分钟）" value={settings.search.cacheTtlMinutes} min={0} max={1440} onChange={(v) => updateSettings((s) => ({ ...s, search: { ...s.search, cacheTtlMinutes: v } }))} />
          <NumField label="默认显示条数" value={settings.search.defaultResults} min={1} max={50} onChange={(v) => updateSettings((s) => ({ ...s, search: { ...s.search, defaultResults: v } }))} />
          <NumField label="展开后条数" value={settings.search.expandedResults} min={1} max={50} onChange={(v) => updateSettings((s) => ({ ...s, search: { ...s.search, expandedResults: v } }))} />
          <label class="field">
            <span>默认地区（可空）</span>
            <input
              class="input"
              maxLength={2}
              placeholder="如 US、JP；空 = 不限定"
              value={settings.search.regionCode}
              onChange={(e) => {
                const v = e.currentTarget.value.trim().toUpperCase();
                if (!v || /^[A-Z]{2}$/.test(v)) updateSettings((s) => ({ ...s, search: { ...s.search, regionCode: v } }));
              }}
            />
          </label>
          <NumField label="同步「喜欢的视频」条数" value={settings.profile.likedVideosMax} min={50} max={1000} step={50} hint="官方最多返回最近 1000 条" onChange={(v) => updateSettings((s) => ({ ...s, profile: { ...s.profile, likedVideosMax: v } }))} />
        </div>
      </Section>

      <Section title="4. 语音" id="voice">
        <label class="field">
          <span>默认识别语言</span>
          <select class="input" value={settings.voice.lang} onChange={(e) => updateSettings((s) => ({ ...s, voice: { ...s.voice, lang: e.currentTarget.value as Settings['voice']['lang'] } }))}>
            <option value="zh-CN">中文（zh-CN）</option>
            <option value="en-US">English（en-US）</option>
          </select>
        </label>
        <label class="inline">
          <input type="checkbox" checked={settings.voice.preferLocal} onChange={(e) => updateSettings((s) => ({ ...s, voice: { ...s.voice, preferLocal: e.currentTarget.checked } }))} />
          优先本地识别（浏览器支持且已下载语音包时，音频不离开本机；否则使用浏览器的云端语音服务，侧边栏会明示）
        </label>
        <p class="muted small">
          侧边栏无法直接弹出麦克风授权框。第一次使用语音前，请
          <button class="btn link small" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') })}>
            打开麦克风授权页
          </button>
          授权一次。
        </p>
      </Section>

      <Section title="5. 评分学习" id="learning">
        <label class="inline">
          <input type="checkbox" checked={settings.learning.autoAdjustRanking} onChange={(e) => updateSettings((s) => ({ ...s, learning: { ...s.learning, autoAdjustRanking: e.currentTarget.checked } }))} />
          根据评分自动调整排序参数（频道偏好、因子权重、兴趣簇权重）
        </label>
        <label class="inline">
          <input type="checkbox" checked={settings.learning.useUnderstandingCorrections} onChange={(e) => updateSettings((s) => ({ ...s, learning: { ...s.learning, useUnderstandingCorrections: e.currentTarget.checked } }))} />
          解析口令时参考我记下的"理解纠正"
        </label>
      </Section>

      <Section title="6. 观看追踪" id="tracking">
        <label class="inline">
          <input
            type="checkbox"
            data-testid="tracking-enabled"
            checked={settings.tracking.enabled}
            onChange={(e) => updateSettings((s) => ({ ...s, tracking: { ...s.tracking, enabled: e.currentTarget.checked } }))}
          />
          记录我在 YouTube 上真正看了什么（只在 youtube.com 读取播放器状态；暂停、广告、拖动进度条不计；后台标签页的播放计入并标为"后台收听"）
        </label>
        <div class="grid">
          <NumField
            label="瞥一眼：完成率低于（%）"
            value={Math.round(settings.tracking.glanceCompletion * 100)}
            min={0}
            max={100}
            onChange={(v) => updateTracking({ glanceCompletion: v / 100 })}
          />
          <NumField label="瞥一眼：有效观看少于（秒）" value={settings.tracking.glanceSeconds} min={0} max={600} onChange={(v) => updateTracking({ glanceSeconds: v })} />
          <NumField
            label="看完：完成率至少（%）"
            value={Math.round(settings.tracking.completeCompletion * 100)}
            min={1}
            max={100}
            onChange={(v) => updateTracking({ completeCompletion: v / 100 })}
          />
        </div>
        <p class="muted small">改了阈值后，已有记录会按新阈值重新判定。</p>
      </Section>

      <Section title="7. 每日总结与每周自省" id="summary">
        <label class="inline">
          <input type="checkbox" checked={settings.summary.enabled} onChange={(e) => updateSettings((s) => ({ ...s, summary: { ...s.summary, enabled: e.currentTarget.checked } }))} />
          每天自动生成学习总结（今日学了什么 / 值得回看 / 只是路过 / 与近期目标的关联）
        </label>
        <label class="field">
          <span>生成时间（本地时间）</span>
          <input
            class="input num"
            type="time"
            value={settings.summary.time}
            onChange={(e) => {
              const v = e.currentTarget.value;
              if (/^\d{2}:\d{2}$/.test(v)) updateSettings((s) => ({ ...s, summary: { ...s.summary, time: v } }));
            }}
          />
          <span class="muted small">到点时浏览器没开的话，下次打开时补上（最多补 7 天）。</span>
        </label>
        <label class="field">
          <span>近期学习目标（总结会写"与近期目标的关联"）</span>
          <textarea
            class="input"
            rows={3}
            placeholder="例如：这个月把大模型的基本原理补上，能看懂论文里的注意力机制"
            value={settings.summary.goals}
            onChange={(e) => {
              const goals = e.currentTarget.value.slice(0, 500);
              updateSettings((s) => ({ ...s, summary: { ...s.summary, goals } }));
            }}
          />
        </label>
        <label class="inline">
          <input type="checkbox" checked={settings.weekly.enabled} onChange={(e) => updateSettings((s) => ({ ...s, weekly: { ...s.weekly, enabled: e.currentTarget.checked } }))} />
          每周生成自省报告（低分案例的共性 + 本周已自动调整了什么），在每周
          <select
            class="input small"
            value={settings.weekly.weekday}
            onChange={(e) => {
              const weekday = Number(e.currentTarget.value);
              updateSettings((s) => ({ ...s, weekly: { ...s.weekly, weekday } }));
            }}
          >
            {'日一二三四五六'.split('').map((d, i) => (
              <option value={i}>{d}</option>
            ))}
          </select>
          的总结时间
        </label>
      </Section>

      <Section title="8. 导师提醒" id="reminder">
        <label class="inline">
          <input type="checkbox" checked={settings.reminder.enabled} onChange={(e) => updateSettings((s) => ({ ...s, reminder: { ...s.reminder, enabled: e.currentTarget.checked } }))} />
          娱乐过多时在侧边栏顶部轻声提醒（一条可关闭的横幅，附一个具体的学习视频；不弹窗）
        </label>
        <div class="grid">
          <NumField
            label="娱乐占比超过（%）"
            value={Math.round(settings.reminder.entertainmentRatio * 100)}
            min={1}
            max={100}
            onChange={(v) => updateSettings((s) => ({ ...s, reminder: { ...s.reminder, entertainmentRatio: v / 100 } }))}
          />
          <NumField
            label="且学习占比低于（%）"
            value={Math.round(settings.reminder.learningRatio * 100)}
            min={0}
            max={100}
            onChange={(v) => updateSettings((s) => ({ ...s, reminder: { ...s.reminder, learningRatio: v / 100 } }))}
          />
          <NumField label="统计最近几天" value={settings.reminder.windowDays} min={1} max={30} onChange={(v) => updateSettings((s) => ({ ...s, reminder: { ...s.reminder, windowDays: v } }))} />
          <NumField label="两次提醒至少间隔（天）" value={settings.reminder.minGapDays} min={1} max={30} onChange={(v) => updateSettings((s) => ({ ...s, reminder: { ...s.reminder, minGapDays: v } }))} />
          <NumField
            label="观看少于多少分钟不评估"
            value={settings.reminder.minTotalMinutes}
            min={0}
            max={600}
            onChange={(v) => updateSettings((s) => ({ ...s, reminder: { ...s.reminder, minTotalMinutes: v } }))}
          />
        </div>
        {reminder && (reminder.disabled || mutedDaysLeft(reminder, ctx.now()) > 0) && (
          <p class="small">
            {reminder.disabled ? '你选择了"不再提醒"。' : `静音中，还剩 ${mutedDaysLeft(reminder, ctx.now())} 天。`}
            <button class="btn link small" onClick={() => void reminderActions.enable(ctx)}>
              恢复提醒
            </button>
          </p>
        )}
        <p class="muted small">学习/娱乐的判定依据可以在侧边栏"记录"页逐条查看和纠正。</p>
      </Section>

      <Section title="9. X 热点" id="x">
        <p class="muted small">
          用你的兴趣簇关键词检索 X 上最近 24 小时的高互动帖子，整理成每日 5–8 条热点（每条附原文链接，一键转成找片口令）。只读、只用 X 官方 API，永远不会发帖、点赞或关注。
          X 按读到的帖子条数收费（$0.005/条，同一条帖子在同一 UTC 日内重复读取不再收费）。Token 只保存在本机，只随请求发往 <code>{new URL(ENDPOINTS.x).host}</code>。
        </p>
        <label class="inline">
          <input type="checkbox" checked={settings.x.enabled} onChange={(e) => updateSettings((s) => ({ ...s, x: { ...s.x, enabled: e.currentTarget.checked } }))} />
          启用 X 热点
        </label>
        <KeyField label="X Bearer Token（App-only）" testid="x-token" saved={!!secrets.xBearerToken} onSave={(v) => updateSecrets({ xBearerToken: v })} onClear={() => updateSecrets({ xBearerToken: '' })} />
        <div class="grid">
          <NumField
            label="每日预算（美元，按 UTC 日）"
            value={settings.x.dailyBudgetUsd}
            min={0.05}
            max={20}
            step={0.05}
            onChange={(v) => updateSettings((s) => ({ ...s, x: { ...s.x, dailyBudgetUsd: v } }))}
          />
          <NumField label="缓存（小时）" value={settings.x.cacheHours} min={1} max={48} onChange={(v) => updateSettings((s) => ({ ...s, x: { ...s.x, cacheHours: v } }))} />
          <NumField label="最多查几个兴趣主题" value={settings.x.maxTopics} min={1} max={8} onChange={(v) => updateSettings((s) => ({ ...s, x: { ...s.x, maxTopics: v } }))} />
          <NumField
            label="每个主题读几条帖子（10–100）"
            value={settings.x.postsPerTopic}
            min={10}
            max={100}
            hint={`一次刷新最多约 ${(settings.x.maxTopics * settings.x.postsPerTopic * 0.005).toFixed(2)}`}
            onChange={(v) => updateSettings((s) => ({ ...s, x: { ...s.x, postsPerTopic: v } }))}
          />
          <NumField label="每次最少几条热点" value={settings.x.minItems} min={1} max={settings.x.maxItems} onChange={(v) => updateSettings((s) => ({ ...s, x: { ...s.x, minItems: v } }))} />
          <NumField label="每次最多几条热点" value={settings.x.maxItems} min={settings.x.minItems} max={12} onChange={(v) => updateSettings((s) => ({ ...s, x: { ...s.x, maxItems: v } }))} />
        </div>
        <label class="inline">
          <input type="checkbox" checked={settings.x.autoRefresh} onChange={(e) => updateSettings((s) => ({ ...s, x: { ...s.x, autoRefresh: e.currentTarget.checked } }))} />
          打开侧边栏"发现"页、且缓存已过期时自动刷新（会产生费用；关掉后只在你点"刷新"时读取）
        </label>
        <p class="muted small">建议同时在 X 开发者后台设置花费上限，作为双重保险。达到 TubeMuse 的每日预算时会立即停止调用并提示；X 那边返回余额不足或达到上限时，当天也不再尝试。</p>
      </Section>

      <Section title="10. 新博主发现" id="discovery">
        <label class="inline">
          <input type="checkbox" checked={settings.discovery.enabled} onChange={(e) => updateSettings((s) => ({ ...s, discovery: { ...s.discovery, enabled: e.currentTarget.checked } }))} />
          每周推荐值得关注的新博主（在"每周自省"的同一周期里自动运行一次；只推荐，不订阅）
        </label>
        <div class="grid">
          <NumField label="每周最多推荐几个" value={settings.discovery.maxChannels} min={1} max={5} onChange={(v) => updateSettings((s) => ({ ...s, discovery: { ...s.discovery, maxChannels: v } }))} />
          <NumField
            label="每周最多用几次 search"
            value={settings.discovery.weeklySearchCalls}
            min={1}
            max={8}
            onChange={(v) => updateSettings((s) => ({ ...s, discovery: { ...s.discovery, weeklySearchCalls: v } }))}
          />
        </div>
      </Section>

      <Section title="11. 豆瓣评论" id="douban">
        <p class="muted small">
          侧边栏"豆瓣"页读取你订阅的条目的公开评论 RSS。只向 <code>{new URL(ENDPOINTS.douban).host}</code> 发 GET 请求：不登录、不带你的豆瓣 Cookie、不带来源页；海报直接从豆瓣图片服务器加载，被防盗链拒绝时换成本地生成的封面。
        </p>
        <label class="inline">
          <input type="checkbox" checked={settings.douban.enabled} onChange={(e) => updateSettings((s) => ({ ...s, douban: { ...s.douban, enabled: e.currentTarget.checked } }))} />
          启用豆瓣评论
        </label>
        <div class="grid">
          <NumField label="缓存（分钟）" value={settings.douban.cacheMinutes} min={5} max={1440} onChange={(v) => updateSettings((s) => ({ ...s, douban: { ...s.douban, cacheMinutes: v } }))} />
        </div>
        <label class="inline">
          <input type="checkbox" checked={settings.douban.autoRefresh} onChange={(e) => updateSettings((s) => ({ ...s, douban: { ...s.douban, autoRefresh: e.currentTarget.checked } }))} />
          打开"豆瓣"页、且当前条目的缓存已过期时自动读取（关掉后只在你点"刷新"时读取）
        </label>
        <label class="inline">
          <input type="checkbox" checked={settings.douban.followActiveTab} onChange={(e) => updateSettings((s) => ({ ...s, douban: { ...s.douban, followActiveTab: e.currentTarget.checked } }))} />
          跟随当前标签页：浏览 www.douban.com 上的条目或它的评论 RSS 时，"豆瓣"页自动切到该条目（只读标签页地址，不读页面内容，不会自动订阅）
        </label>
      </Section>

      <SubtitleSection settings={settings} hasOpenAiKey={!!secrets.openaiApiKey} update={updateSettings} />

      <Section title="13. 数据" id="data">
        <p class="muted small">所有数据只保存在这个浏览器里。导出文件包含全部本地数据（含观看记录、每日总结、周报、X 热点与花费记录、新博主推荐、豆瓣订阅与读到的评论、自动字幕与字幕花费），但不含 API Key、X Token 与授权令牌（也从不保存任何音频）。</p>
        <div class="row">
          <button
            class="btn"
            onClick={() =>
              act(async () => {
                const file = await exportAll(ctx);
                const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `tubemuse-export-${file.exportedAt.slice(0, 10)}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 5000);
                return '已导出';
              })
            }
          >
            导出全部数据（JSON）
          </button>
          {clearStep === 0 && (
            <button class="btn danger" onClick={() => setClearStep(1)}>
              清空全部数据…
            </button>
          )}
        </div>
        {clearStep === 1 && (
          <div class="danger-zone">
            <p>
              这会删除本机上 TubeMuse 的全部数据（API Key、画像、兴趣簇、评分、改进记录、缓存、配额计数），并删除 YouTube 访问令牌（令牌仍有效时先向 Google 吊销）。<strong>无法恢复。</strong>建议先导出。
            </p>
            <label class="field">
              <span>请输入"清空"二字确认</span>
              <input class="input" value={clearText} onInput={(e) => setClearText(e.currentTarget.value)} />
            </label>
            <div class="row">
              <button
                class="btn danger"
                disabled={clearText.trim() !== '清空'}
                onClick={() =>
                  act(async () => {
                    await clearAll(ctx);
                    setClearStep(0);
                    setClearText('');
                    return '已清空全部数据';
                  })
                }
              >
                确认清空
              </button>
              <button
                class="btn"
                onClick={() => {
                  setClearStep(0);
                  setClearText('');
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section title="网络出口" id="egress">
        <p class="muted small">本扩展只会连接以下地址（由内容安全策略强制限制）：</p>
        <ul class="small">
          <li>
            <code>{ENDPOINTS.youtubeApi}</code>（YouTube Data API v3，只读）
          </li>
          <li>
            <code>{ENDPOINTS.googleOAuthRevoke}</code>（断开时吊销授权）
          </li>
          <li>
            <code>{ENDPOINTS.anthropic}</code> / <code>{ENDPOINTS.openai}</code>（你选定的 LLM）
          </li>
          <li>
            <code>{ENDPOINTS.x}</code>（X 官方 API，只读，填写 Token 后才会连接）
          </li>
          <li>
            <code>{ENDPOINTS.douban}</code>（豆瓣条目评论的公开 RSS，只读，不带 Cookie）
          </li>
          <li>
            <code>https://i.ytimg.com</code>（结果卡缩略图，图片地址来自 API 返回）
          </li>
          <li>
            <code>https://img1–9.doubanio.com</code>（豆瓣条目海报，只作图片加载，地址来自 RSS）
          </li>
        </ul>
        <p class="muted small">Google 登录 / 授权窗口（accounts.google.com）由浏览器自己打开，授权结果回跳到 chromiumapp.org 由浏览器直接截获；云端语音识别由浏览器自己连接 Google 语音服务（侧边栏会明示）。</p>
        <p class="muted small">注入 youtube.com 的观看追踪脚本只读取本地播放器状态（进度、时长、暂停、倍速、是否广告、标签页是否可见），不读取页面内容、不改动页面、不发任何网络请求。</p>
        <p class="muted small">
          注入 youtube.com 的自动字幕脚本在视频播放时拿到这个视频的声音（不下载、不保存）：转写方式是"浏览器识别"时交给浏览器自带的语音识别（装了本地语音包时在本机识别，否则由 Chrome 自己连接 Google 的语音服务）；是"OpenAI"时交给扩展后台发往 <code>{new URL(ENDPOINTS.openai).host}</code>。它在播放器里加一层只读字幕，不改动 YouTube 自己的元素，本身不发任何网络请求。
        </p>
      </Section>
    </div>
  );
}

/** 浏览器本地语音包：查询是否已装；没装时可以点按钮让浏览器下载（只在你点击时下载） */
function LocalSpeechPack({ lang }: { lang: string }) {
  const [state, setState] = useState<LocalAvailability | 'checking'>('checking');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const env = browserSpeechEnv();
  const name = (BROWSER_SPEECH_LANGS as Record<string, string>)[lang] ?? lang;
  useEffect(() => {
    setState('checking');
    void detectLocal(env, lang).then(setState);
  }, [lang]);
  const install = async () => {
    setBusy(true);
    setFailed(false);
    const ok = await installLocal(env, lang);
    setFailed(!ok);
    setState(await detectLocal(env, lang));
    setBusy(false);
  };
  let text: string;
  switch (state) {
    case 'checking':
      text = '正在查询…';
      break;
    case 'available':
      text = `「${name}」本地语音包已安装：在本机识别，声音不离开电脑`;
      break;
    case 'downloadable':
      text = `「${name}」本地语音包还没安装，现在会用 Chrome 云端识别（声音发往 Google）`;
      break;
    case 'downloading':
      text = `「${name}」本地语音包正在下载…`;
      break;
    case 'unavailable':
      text = `这个浏览器没有「${name}」的本地语音包，会用 Chrome 云端识别（声音发往 Google）`;
      break;
    default:
      text = '这个浏览器不支持本地识别，会用 Chrome 云端识别（声音发往 Google）';
  }
  return (
    <div class="field" data-testid="local-speech-pack">
      <span>本地语音包</span>
      <span class="small">{text}</span>
      {state === 'downloadable' && (
        <div class="row">
          <button class="btn" disabled={busy} onClick={() => void install()}>
            {busy ? '下载中…' : `下载「${name}」本地语音包`}
          </button>
          <span class="muted small">由浏览器从 Google 下载一次（约几十 MB），之后识别在本机完成</span>
        </div>
      )}
      {failed && <span class="warn-text small">没能下载本地语音包（浏览器拒绝或网络问题），仍会用 Chrome 云端识别</span>}
    </div>
  );
}

function SubtitleSection({ settings, hasOpenAiKey, update }: { settings: Settings; hasOpenAiKey: boolean; update: (fn: (s: Settings) => Settings) => void }) {
  const s = settings.subtitles;
  const set = (patch: Partial<Settings['subtitles']>) => update((x) => ({ ...x, subtitles: { ...x.subtitles, ...patch } }));
  const { provider, model } = subtitleTranslationModel(settings);
  const fast = DEFAULT_SETTINGS.subtitles.translationModels[provider];
  const openai = s.asrEngine === 'openai';
  const perHour = hourlyEstimateUsd(openai ? s.asrModel : undefined, s.translate ? model : undefined);
  const priceKnown = (!openai || asrPrice(s.asrModel).known) && (!s.translate || llmPrice(model).known);
  const speechLangs = Object.entries(BROWSER_SPEECH_LANGS) as [BrowserSpeechLang, string][];
  const langOptions = Object.entries(SUBTITLE_LANGS) as [SubtitleLang, string][];
  return (
    <Section title="12. 自动字幕" id="subtitles">
      <p class="muted small">
        为没有原生字幕的 YouTube 视频生成双语字幕：播放时把这个视频的声音转成文字（音频不保存），再用你的大模型把每句译成第二语言，叠加显示在播放器里。字幕按视频时间存在本机，回看或拖回去时就是对齐的，也不会再花钱。
      </p>
      <label class="inline">
        <input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} />
        启用自动字幕
      </label>
      <label class="inline">
        <input type="checkbox" checked={s.autoStart} onChange={(e) => set({ autoStart: e.currentTarget.checked })} />
        播放器显示"字幕不可用"时自动开始（关掉后只在你从侧边栏"字幕"页或按 Alt+Shift+S 开启时生成）
      </label>
      <p class="small">
        <strong>转写方式（声音 → 文字）</strong>
      </p>
      <label class="inline">
        <input type="radio" name="asr-engine" checked={!openai} onChange={() => set({ asrEngine: 'browser' })} />
        浏览器识别（免费；边说边出字；只有 Google Chrome 能用）
      </label>
      <label class="inline">
        <input type="radio" name="asr-engine" checked={openai} onChange={() => set({ asrEngine: 'openai' })} />
        OpenAI 转写（{s.asrModel}，约 ${asrPrice(s.asrModel).perMinute}/分钟；需要 OpenAI Key 与预付额度；字幕比说话晚几秒）
      </label>
      {openai && !hasOpenAiKey && <p class="warn-text small">需要 OpenAI API Key（在上面「1. 大模型」填写）：Anthropic 没有语音转文字接口。找片等其他功能可以继续用 Anthropic。</p>}
      {!openai && (
        <>
          <label class="field">
            <span>识别语言</span>
            <select class="input" data-testid="speech-lang" value={s.browserLang} onChange={(e) => set({ browserLang: e.currentTarget.value as BrowserSpeechLang })}>
              {speechLangs.map(([code, name]) => (
                <option value={code}>{name}</option>
              ))}
            </select>
            <span class="muted small">浏览器识别不能自动判断语言。"自动"时按视频的语言（YouTube 数据，每个新视频查一次，1 unit），中文按简体字识别；判断不了时用简体中文。在侧边栏"字幕"页可以给单个视频换语言。</span>
          </label>
          <label class="inline">
            <input type="checkbox" checked={s.browserPreferLocal} onChange={(e) => set({ browserPreferLocal: e.currentTarget.checked })} />
            装了本地语音包时在本机识别（声音不离开电脑）；没装时用 Chrome 云端识别（声音由 Chrome 发往 Google）
          </label>
          {s.browserPreferLocal && <LocalSpeechPack lang={s.browserLang === 'auto' ? 'zh-CN' : s.browserLang} />}
        </>
      )}
      <div class="grid">
        <NumField
          label="每日预算（美元，按本地日）"
          value={s.dailyBudgetUsd}
          min={0.05}
          max={50}
          step={0.05}
          hint={`按当前设置，一小时连续说话的视频约 $${perHour.toFixed(2)}${priceKnown ? '' : '（有模型不在价目表里，按保守单价估算）'}`}
          onChange={(v) => set({ dailyBudgetUsd: v })}
        />
        {openai && (
          <label class="field">
            <span>语音转写模型（OpenAI）</span>
            <input class="input" value={s.asrModel} onChange={(e) => set({ asrModel: e.currentTarget.value.trim() || DEFAULT_SETTINGS.subtitles.asrModel })} />
            <span class="muted small">${asrPrice(s.asrModel).perMinute}/分钟{asrPrice(s.asrModel).known ? '' : '（未知模型，按保守单价估算）'}</span>
          </label>
        )}
      </div>
      <label class="inline">
        <input type="checkbox" checked={s.translate} onChange={(e) => set({ translate: e.currentTarget.checked })} />
        翻译成第二语言（双语字幕）
      </label>
      <div class="grid">
        <label class="field">
          <span>第二行译成</span>
          <select class="input" value={s.targetLang} onChange={(e) => set({ targetLang: e.currentTarget.value as SubtitleLang })}>
            {langOptions.map(([code, name]) => (
              <option value={code}>{name}</option>
            ))}
          </select>
        </label>
        <label class="field">
          <span>原文已是这种语言时改译成</span>
          <select class="input" value={s.altTargetLang} onChange={(e) => set({ altTargetLang: e.currentTarget.value as SubtitleLang })}>
            {langOptions.map(([code, name]) => (
              <option value={code}>{name}</option>
            ))}
          </select>
        </label>
      </div>
      <label class="field">
        <span>字幕翻译模型（{provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}，跟随「1. 大模型」当前选择的提供商）</span>
        <input
          class="input"
          data-testid="subtitle-model"
          placeholder={`留空 = 用 ${settings.llm.models[provider]}`}
          value={s.translationModels[provider]}
          onChange={(e) => set({ translationModels: { ...s.translationModels, [provider]: e.currentTarget.value.trim() } })}
        />
        <span class="muted small">
          当前：{model}（${llmPrice(model).input}/${llmPrice(model).output} 每百万 token 输入/输出{llmPrice(model).known ? '' : '，未知模型按保守单价估算'}）。每句字幕都要调用一次，模型越快字幕出得越早。
          {model !== fast && (
            <>
              {' '}
              <button class="btn link small" onClick={() => set({ translationModels: { ...s.translationModels, [provider]: fast } })}>
                改回默认的 {fast}（更快、更省：一小时约 ${hourlyEstimateUsd(s.asrModel, fast).toFixed(2)}）
              </button>
            </>
          )}
        </span>
      </label>
      <div class="grid">
        <NumField label="字号倍数" value={s.fontScale} min={0.6} max={2} step={0.1} onChange={(v) => set({ fontScale: v })} />
      </div>
      <label class="inline">
        <input type="checkbox" checked={s.showSource} onChange={(e) => set({ showSource: e.currentTarget.checked })} />
        显示原文（关掉后只显示译文；没有译文时仍显示原文）
      </label>
      <p class="muted small">
        浏览器识别：声音交给浏览器自带的语音识别，扩展自己不发送音频。OpenAI 转写：发给 OpenAI 的只有这几秒音频与前几句转写文字（帮助连贯）。发给翻译模型的只有当前这句和前三句的文字与目标语言。都不含视频 ID、标题、频道或你的账号信息。花费在侧边栏顶部"字幕 $"实时显示，到每日预算立即停止并提示。
      </p>
    </Section>
  );
}

render(<App />, document.getElementById('app')!);
