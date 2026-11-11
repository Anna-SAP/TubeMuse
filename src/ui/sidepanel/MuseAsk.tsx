// 「问 muse」（2026-11-11 新增，见 DECISIONS §60、§62）：顶部的按钮和它展开的面板。
// 点按钮的那一刻"冻结"当前标签页这条视频的播放位置（只是记下来，不暂停视频），生成一段咨询包文字；
// 你写下问题，"生成"更新这段文字、"复制"拷走、"打开 muse.ai"去粘贴。
// 这里不调大模型，也不向 Muse 发任何东西：咨询包只是一段文字，粘贴和发送都由你来。

import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { MUSE } from '../../config/defaults';
import { MUSE_CHAT_URL } from '../../config/endpoints';
import { MUSE_NONE, MUSE_NO_CAPTIONS, MUSE_SITE_LABELS, buildMusePackage, museChapterText, musePosition, type MusePackage } from '../../core/muse';
import { freezeMuse, museSecrets, type MuseFreeze } from '../../services/muse-service';
import { stores } from '../../services/repo';
import { appCtx, useStore } from '../shared/app';
import { Spinner } from '../shared/components';

/** 生成好的咨询包，连同生成时用的问题（问题改了就知道它过时了） */
type Generated = MusePackage & { question: string };

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (at: number) => {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** 面板里"上下文"一行：这次用的是哪一种 */
function contextSummary(f: MuseFreeze, p: MusePackage): string {
  const cut = p.truncated ? '，太长，已截断并在咨询包里注明' : '';
  const c = f.captions;
  if (p.context === 'captions' && c) {
    return `前后 ${MUSE.windowSec} 秒的${c.source === 'youtube-cc' ? `字幕（YouTube 字幕${c.label ? ` · ${c.label}` : ''}）` : '转写（TubeMuse 自动字幕）'}，${c.cues.length} 句${cut}`;
  }
  if (p.context === 'captions') return `前后 ${MUSE.windowSec} 秒的字幕 / 转写${cut}`;
  if (p.context === 'no-captions') return MUSE_NO_CAPTIONS;
  if (p.context === 'body') return `${f.snapshot.site === 'douyin' ? '这条视频的描述' : f.snapshot.site === 'xhs' ? '这篇笔记的正文' : '这条帖子的正文'}${cut}`;
  if (p.context === 'title') return '只有标题（没有字幕 / 转写，也没有正文 / 描述）';
  return MUSE_NONE;
}

/** 顶部的「问 muse」按钮，和它展开的面板（没打开时是 null） */
export function useMuseAsk(): { button: JSX.Element; panel: JSX.Element | null } {
  const settings = useStore(stores.settings);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [freeze, setFreeze] = useState<MuseFreeze>();
  const [question, setQuestion] = useState('');
  const [pkg, setPkg] = useState<Generated>();
  const [copied, setCopied] = useState<{ ok: boolean; text: string }>();
  const preview = useRef<HTMLTextAreaElement>(null);
  /** 问题输入框里现在的字：冻结要等页面回话，回来时用的是你这时已经写下的 */
  const asked = useRef('');

  const build = async (f: MuseFreeze, q: string): Promise<Generated> => ({
    ...buildMusePackage({
      snapshot: f.snapshot,
      ...(f.captions ? { captions: f.captions } : {}),
      ...(f.description ? { description: f.description } : {}),
      question: q,
      secrets: await museSecrets(appCtx()),
    }),
    question: q,
  });

  const generate = async (f: MuseFreeze, q: string): Promise<Generated> => {
    const made = await build(f, q);
    setPkg(made);
    setCopied(undefined);
    return made;
  };

  /** 冻结：记下当前标签页这条视频此刻的播放位置（不暂停视频），顺手生成一版咨询包 */
  const freezeNow = async () => {
    setOpen(true);
    setBusy(true);
    setError(undefined);
    setCopied(undefined);
    try {
      const w = await chrome.windows.getCurrent();
      const [tab] = await chrome.tabs.query({ active: true, windowId: w.id });
      const tabId = tab?.id;
      const fetchCaptions = (await stores.settings.read(appCtx().kv)).muse.fetchCaptions;
      const r = await freezeMuse(appCtx(), (msg) => (tabId === undefined ? Promise.resolve(undefined) : chrome.tabs.sendMessage(tabId, msg)), { fetchCaptions });
      if (!r.ok) {
        // 这次没冻结成：上一次的咨询包不留着，免得把别的视频的内容当成这一次的
        setFreeze(undefined);
        setPkg(undefined);
        return setError(r.message);
      }
      // 快照和按它拼的咨询包一起换上：分两步的话，中间那一下界面上是"新的快照 + 上一次的咨询包"，对不上
      const made = await build(r.freeze, asked.current);
      setFreeze(r.freeze);
      setPkg(made);
    } catch (e) {
      setFreeze(undefined);
      setPkg(undefined);
      setError(`没能冻结：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  /** 复制的总是按现在的问题生成的那一版：问题改过就先更新再复制 */
  const copy = async () => {
    if (!freeze) return;
    const made = pkg && pkg.question === question ? pkg : await generate(freeze, question);
    try {
      await navigator.clipboard.writeText(made.text);
      setCopied({ ok: true, text: '已复制：到 Muse 的输入框里粘贴' });
    } catch {
      // 剪贴板接口被拒（例如侧边栏没有焦点）：选中整段，用浏览器自带的复制
      const el = preview.current;
      el?.focus();
      el?.select();
      const done = !!el && document.execCommand('copy');
      setCopied(done ? { ok: true, text: '已复制：到 Muse 的输入框里粘贴' } : { ok: false, text: '没能自动复制：下面的文字已全选，按 Ctrl+C（Mac 上是 ⌘C）复制' });
    }
  };

  const setFetchCaptions = (on: boolean) => void stores.settings.update(appCtx().kv, appCtx().locker, (s) => ({ ...s, muse: { ...s.muse, fetchCaptions: on } }));

  const button = (
    <button
      class={`btn small muse-btn${open ? ' on' : ''}`}
      data-testid="muse-ask"
      disabled={busy}
      title="冻结当前视频此刻的播放位置（只是记下来，不暂停视频），生成一段可以粘贴到 Muse 聊天里的咨询包。再点一次重新冻结"
      onClick={() => void freezeNow()}
    >
      问 muse
    </button>
  );
  if (!open) return { button, panel: null };

  const s = freeze?.snapshot;
  const stale = !!pkg && pkg.question !== question;
  const youtube = s?.site === 'youtube';
  const notes = [
    ...(freeze?.notes ?? []),
    ...(s?.site === 'xhs' ? ['小红书的链接没有带 xsec_token（那是令牌，不进咨询包）：从外面打开这个链接时，小红书可能要求登录'] : []),
    ...(pkg?.redacted ? ['有内容看起来像 Key / 令牌，已换成"[已隐藏]"'] : []),
  ];
  const panel = (
    <section class="panel muse" data-testid="muse-panel" data-frozen-at={freeze?.at}>
      <div class="row muse-head">
        <h2>问 muse</h2>
        <button class="icon-btn" title="收起（已经冻结的内容还在，再点「问 muse」会重新冻结）" data-testid="muse-close" onClick={() => setOpen(false)}>
          ×
        </button>
      </div>
      {busy && <Spinner label="位置已记下，正在取这个视频的字幕和资料…" />}
      {error && (
        <div class="notice notice-error" role="alert" data-testid="muse-error">
          <div class="notice-body">
            <strong>{error}</strong>
          </div>
        </div>
      )}
      {freeze && s && pkg && (
        <>
          <dl class="kv">
            <dt>平台</dt>
            <dd data-testid="muse-site">{MUSE_SITE_LABELS[s.site]}</dd>
            <dt>标题</dt>
            <dd data-testid="muse-title">{s.title ?? MUSE_NONE}</dd>
            <dt>作者</dt>
            <dd data-testid="muse-author">{s.author ?? MUSE_NONE}</dd>
            <dt>冻结位置</dt>
            <dd class="num-inline" data-testid="muse-position">
              {musePosition(s.position, s.duration)}
              <span class="muted small">（{clock(freeze.at)} 冻结，视频没有暂停）</span>
            </dd>
            {youtube && (
              <>
                <dt>章节</dt>
                <dd data-testid="muse-chapters">{museChapterText(freeze.description, s.position)}</dd>
                <dt>简介</dt>
                <dd data-testid="muse-description">
                  {freeze.description ? `已带上${pkg.descriptionTruncated ? `（太长，只放了开头 ${MUSE.descriptionMaxChars} 字，咨询包里已注明）` : ''}` : MUSE_NONE}
                </dd>
              </>
            )}
            <dt>上下文</dt>
            <dd data-testid="muse-context">{contextSummary(freeze, pkg)}</dd>
          </dl>
          {notes.map((n) => (
            <p class="muted small" data-testid="muse-note">
              {n}
            </p>
          ))}
          <label class="field">
            <span>我的问题</span>
            <textarea
              class="input"
              rows={3}
              data-testid="muse-question"
              placeholder="想问 Muse 什么？原话会写进咨询包"
              value={question}
              onInput={(e) => {
                asked.current = e.currentTarget.value;
                setQuestion(e.currentTarget.value);
              }}
            />
          </label>
          <div class="row wrap">
            <button class="btn primary" data-testid="muse-generate" disabled={busy} onClick={() => void generate(freeze, question)}>
              生成
            </button>
            <button class="btn" data-testid="muse-copy" disabled={busy} onClick={() => void copy()}>
              复制
            </button>
            <button class="btn" data-testid="muse-open" title="在新标签页打开 muse.ai；咨询包要你自己粘贴" onClick={() => void chrome.tabs.create({ url: MUSE_CHAT_URL })}>
              打开 muse.ai
            </button>
          </div>
          {copied && (
            <p class={`small${copied.ok ? '' : ' warn-text'}`} role="status" data-testid="muse-copied">
              {copied.text}
            </p>
          )}
          {stale && (
            <p class="small warn-text" data-testid="muse-stale">
              问题改过了：点"生成"更新下面这段文字（点"复制"会先更新再复制）。
            </p>
          )}
          {!pkg.question.trim() && !stale && <p class="muted small">还没写问题：咨询包里"我的问题"一项是「{MUSE_NONE}」。写好后点"生成"。</p>}
          <textarea class="input muse-package" readOnly rows={12} aria-label="咨询包" data-testid="muse-package" ref={preview} value={pkg.text} />
        </>
      )}
      {settings && (
        <label class="inline muse-option">
          <input type="checkbox" data-testid="muse-fetch-captions" checked={settings.muse.fetchCaptions} onChange={(e) => setFetchCaptions(e.currentTarget.checked)} />
          <span>
            YouTube：点「问 muse」时自动取视频自带的字幕（只取位置前后要用的那一种语言；原生字幕关着时，播放器的字幕会闪一下）。关掉后只用已经读到的字幕。
          </span>
        </label>
      )}
      <p class="muted small">
        咨询包只是一段文字：TubeMuse 不会把它发给 Muse 或任何地方，也不调大模型；粘贴和发送都由你来。里面只有当前这条视频 / 帖子的信息。YouTube 的作者、简介和章节来自官方接口（本机没记着这个视频时查一次，1
        unit）。
      </p>
    </section>
  );
  return { button, panel };
}
