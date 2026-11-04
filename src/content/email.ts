// Gmail 网页版的邮件脚本（2026-11-04 新增，见 DECISIONS §44）。
// 只回答侧边栏 eMails 页的一个问题："现在打开的是哪封邮件、里面有哪些文章"。脚本自己不观察页面、不定时、不主动做任何事：
// 侧边栏没开 eMails 页时，它一个字也不读。
// 红线：不发任何网络请求、不往 Gmail 页面写任何东西（没有按钮、没有标记）、不点击、不碰 Cookie 与本地存储、不用扩展存储；
// 读取的只有打开的这封邮件的主题、发件人名字和正文（不读发件人地址、收件人、邮件列表），构建时检查。

import { EMAIL } from '../config/defaults';
import { EMAIL_MSG, extractArticles, type EmailNode, type EmailTabState } from '../core/email';

/** Gmail 的元素：class 是混淆过的，改版时改这里（读不到时侧边栏会说明，不静默） */
const GMAIL = {
  /** 打开的邮件正文 */
  body: '.a3s',
  subject: 'h2.hP',
  sender: '.gD',
  /** 长邮件底部的"[邮件已截断] 查看完整邮件" */
  clipped: '.iX',
} as const;

const visible = (el: Element): boolean => el.getClientRects().length > 0;
const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

const styleCache = new WeakMap<Element, boolean>();
function isStrong(el: Element): boolean {
  let v = styleCache.get(el);
  if (v === undefined) {
    const s = getComputedStyle(el);
    v = (parseInt(s.fontWeight, 10) || 400) >= 600 || parseFloat(s.fontSize) >= 17;
    styleCache.set(el, v);
  }
  return v;
}

function headingLevel(el: Element): number | undefined {
  const h = el.closest('h1,h2,h3,h4');
  return h ? Number(h.tagName.slice(1)) : undefined;
}

/** 按文档顺序读出正文里看得见的文字与图片 alt（藏起来的预览文字、引用的旧邮件不读） */
function readNodes(bodies: readonly Element[]): EmailNode[] {
  const nodes: EmailNode[] = [];
  for (const body of bodies) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT;
        const el = n as Element;
        if (/^(?:STYLE|SCRIPT|HEAD)$/.test(el.tagName) || el.classList.contains('gmail_quote') || !el.checkVisibility()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n && nodes.length < EMAIL.maxNodes; n = walker.nextNode()) {
      const el = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
      if (!el) continue;
      const text = n.nodeType === Node.ELEMENT_NODE ? clean(el.tagName === 'IMG' ? (el as HTMLImageElement).alt : '') : clean(n.nodeValue);
      if (!text) continue;
      const link = el.closest<HTMLAnchorElement>('a[href]');
      const heading = headingLevel(el);
      nodes.push({
        kind: n.nodeType === Node.ELEMENT_NODE ? 'img' : 'text',
        text,
        ...(link ? { href: link.href } : {}),
        ...(heading ? { heading } : {}),
        ...(n.nodeType === Node.TEXT_NODE && isStrong(el) ? { strong: true } : {}),
      });
    }
  }
  return nodes;
}

let lastKey = '';
let lastState: EmailTabState | undefined;

function readState(): EmailTabState {
  const subjectEl = [...document.querySelectorAll(GMAIL.subject)].find(visible);
  const bodies = [...document.querySelectorAll(GMAIL.body)].filter(visible);
  const subject = clean(subjectEl?.textContent);
  if (!bodies.length) return { page: subject ? 'unreadable' : 'none', ...(subject ? { subject } : {}), articles: [], clipped: false };
  // 侧边栏隔一会儿问一次：这封邮件没变就不重新读（Gmail 分栏阅读时换邮件，网址不变，只能看内容）
  const key = `${subject}\u0000${bodies.length}\u0000${bodies.reduce((n, b) => n + (b.textContent?.length ?? 0), 0)}`;
  if (key === lastKey && lastState) return lastState;
  const sender = clean([...document.querySelectorAll(GMAIL.sender)].find(visible)?.getAttribute('name'));
  lastKey = key;
  lastState = {
    page: 'mail',
    ...(subject ? { subject } : {}),
    ...(sender ? { sender } : {}),
    articles: extractArticles(readNodes(bodies)),
    clipped: [...document.querySelectorAll(GMAIL.clipped)].some(visible),
  };
  return lastState;
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse: (s: EmailTabState) => void) => {
  if ((msg as { type?: string } | undefined)?.type !== EMAIL_MSG.getState) return false;
  sendResponse(readState());
  return false;
});
