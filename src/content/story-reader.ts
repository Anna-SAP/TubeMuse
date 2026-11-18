// 「故事」的页面读取函数（2026-11-18 新增，见 DECISIONS §88）。
// 不是常驻的内容脚本：只在你点「读这个页面」（或在页面上右键 →「TubeMuse：讲讲这个故事」、按快捷键）的那一刻，
// 由侧边栏用 chrome.scripting.executeScript 把这个函数放进当前标签页跑一次（扩展自己的隔离环境），读完把结果交回、不留下任何东西。
//
// 读什么：
// - X 帖子页（<X 网页版>/<用户>/status/<ID>）：只读这一条帖子（主帖）和它引用的那一条的作者、正文、发布时间、页面上显示的互动数据、
//   媒体类型（视频 / 图片的替代文字）、链接卡片；回复、信息流里的别的帖子、评论都不读（2026-11-18 用户批准，DECISIONS §88）。
// - 别的网页（新闻、博客、论坛……）：页面自己声明的元数据（标题、作者、发布时间、简介、站点名）和正文段落，最多 maxTextChars 个字。
// - 你在页面上选中的文字（如果有）。
// 不读：Cookie、本地存储、表单、页面脚本的变量；YouTube、小红书、Gmail、Instagram、抖音、B 站、小宇宙、酷播、优酷这些各有约定的站
// （skip 里的网址开头），一个字都不读，直接返回 skipped。
//
// 红线（构建时检查，scripts/build.mjs）：不发任何网络请求、不往页面写任何东西（不插元素、不改文字、不改属性）、不点击、不模拟事件、
// 不碰 Cookie / 页面存储、不用扩展接口、不跳转。
//
// 注意：executeScript 只把函数本身的源码送进页面，所以函数必须自给自足——不能用外面的 import、常量或辅助函数（单测检查）。

export interface StoryReaderConfig {
  /** 不读的网站（各有约定）：网址开头 */
  skip: readonly string[];
  /** X 网页版的网址开头（帖子页是 <开头><用户>/status/<ID>） */
  xPages: readonly string[];
  /** 正文最多读多少个字 */
  maxTextChars: number;
  /** 一条帖子的正文最多读多少个字 */
  maxPostChars: number;
  /** 选中的文字最多读多少个字 */
  maxSelectionChars: number;
}

/** 页面上读到的一条 X 帖子（原样，未校验；校验在 core/story.ts 的 sanitizeStoryRead） */
export interface StoryXPostRead {
  name?: string;
  handle?: string;
  text: string;
  /** <time datetime>，ISO */
  time?: string;
  /** 页面上显示的时间文字（"上午5:55 · 2026年11月18日"） */
  timeLabel?: string;
  url?: string;
  /** 页面上显示的互动数据（按钮组的无障碍标签，原样） */
  metrics?: string;
  /** "video"、"photo"、"photo:替代文字"、"gif" */
  media: string[];
}

export type StoryPageRead =
  | { kind: 'skipped'; url: string }
  | { kind: 'x-nopost'; url: string }
  | {
      kind: 'x';
      url: string;
      docTitle: string;
      statusId: string;
      user: string;
      post?: StoryXPostRead;
      quoted?: StoryXPostRead;
      card?: { text: string; url?: string };
      selection?: string;
    }
  | {
      kind: 'page';
      url: string;
      canonical?: string;
      docTitle: string;
      title?: string;
      siteName?: string;
      authors: string[];
      published?: string;
      modified?: string;
      description?: string;
      lang?: string;
      /** JSON-LD 里声明的类型（NewsArticle、BlogPosting…） */
      ldType?: string;
      text: string;
      truncated: boolean;
      selection?: string;
    };

/** 在页面里跑的函数：自给自足，只读不写 */
export function readStoryPage(cfg: StoryReaderConfig): StoryPageRead {
  const href = location.href;
  if (cfg.skip.some((p) => href.startsWith(p))) return { kind: 'skipped', url: href };

  /** 翻译类扩展插进页面的译文（例如沉浸式翻译）：不是原文，不读 */
  const INSERTED = '[class*="immersive-translate-target"],[data-immersive-translate-translation-element-mark],[class*="translate-target-wrapper"]';
  const squash = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
  const cap = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);
  const visible = (el: Element): boolean => {
    const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
    return typeof check === 'function' ? check.call(el) : true;
  };
  /** 一段元素里的文字（含表情图片的替代文字），保留换行；跳过藏起来的、翻译扩展插进来的 */
  const textOf = (root: Element): string => {
    let out = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT;
        const el = n as Element;
        if (/^(?:STYLE|SCRIPT|NOSCRIPT|TEMPLATE)$/.test(el.tagName) || el.matches(INSERTED) || !visible(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue ?? '';
      else if ((n as Element).tagName === 'IMG') out += (n as HTMLImageElement).alt ?? '';
      else if ((n as Element).tagName === 'BR') out += '\n';
    }
    return out
      .replace(/[ \t\f\v ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };
  const selectionText = (): string | undefined => {
    const s = squash(String(window.getSelection?.() ?? ''));
    return s ? cap(s, cfg.maxSelectionChars) : undefined;
  };

  // ── X 帖子页 ──
  const xPrefix = cfg.xPages.find((p) => href.startsWith(p));
  if (xPrefix) {
    const m = /^([A-Za-z0-9_]{1,30})\/status\/(\d{5,25})(?:[/?#]|$)/.exec(href.slice(xPrefix.length));
    if (!m) return { kind: 'x-nopost', url: href };
    const user = m[1]!;
    const id = m[2]!;
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
    // 主帖：包着发布时间的链接指向这条帖子（回复、上文里的帖子各有自己的链接）
    const article = articles.find((a) => a.querySelector(`a[href*="/status/${id}"] time`)) ?? articles.find((a) => a.querySelector(`a[href*="/status/${id}"]`));
    const base = { kind: 'x' as const, url: href, docTitle: document.title, statusId: id, user };
    const selection = selectionText();
    if (!article) return { ...base, ...(selection ? { selection } : {}) };
    const quote = [...article.querySelectorAll('div[role="link"]')].find((d) => d.querySelector('[data-testid="User-Name"]'));
    const outside = (el: Element): boolean => !quote || !quote.contains(el);
    const nameOf = (scope: Element, keep: (el: Element) => boolean): { name?: string; handle?: string } => {
      const box = [...scope.querySelectorAll('[data-testid="User-Name"]')].find(keep);
      if (!box) return {};
      const parts: string[] = [];
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement?.closest('time')) continue;
        const t = squash(n.nodeValue);
        if (t && t !== '·') parts.push(t);
      }
      const handle = parts.find((p) => /^@\w{1,30}$/.test(p));
      const name = parts.find((p) => !p.startsWith('@'));
      return { ...(name ? { name } : {}), ...(handle ? { handle } : {}) };
    };
    const mediaOf = (scope: Element, keep: (el: Element) => boolean): string[] => {
      const media: string[] = [];
      for (const v of scope.querySelectorAll('[data-testid="videoPlayer"]')) if (keep(v)) media.push(v.querySelector('video[loop]') ? 'gif' : 'video');
      for (const p of scope.querySelectorAll('[data-testid="tweetPhoto"]')) {
        if (!keep(p) || p.querySelector('[data-testid="videoPlayer"]')) continue;
        const alt = squash(p.querySelector('img')?.getAttribute('alt'));
        media.push(alt && !/^(image|图像|图片)$/i.test(alt) ? `photo:${cap(alt, 300)}` : 'photo');
      }
      return media.slice(0, 8);
    };
    const firstText = (scope: Element, keep: (el: Element) => boolean): string => {
      const el = [...scope.querySelectorAll('[data-testid="tweetText"]')].find(keep);
      return el ? cap(textOf(el), cfg.maxPostChars) : '';
    };
    const ownTime = article.querySelector(`a[href*="/status/${id}"] time`);
    const groups = [...article.querySelectorAll('[role="group"][aria-label]')].filter(outside);
    const metricLabels = ['reply', 'retweet', 'like', 'bookmark']
      .map((k) => [...article.querySelectorAll(`[data-testid="${k}"]`)].find(outside)?.getAttribute('aria-label'))
      .filter((s): s is string => !!s);
    const views = [...article.querySelectorAll(`a[href*="/status/${id}/analytics"]`)].map((a) => squash(a.getAttribute('aria-label') || a.textContent)).find((s) => !!s);
    const metrics = squash(groups[groups.length - 1]?.getAttribute('aria-label')) || [...metricLabels, ...(views ? [views] : [])].map(squash).join('；');
    const post: StoryXPostRead = {
      ...nameOf(article, outside),
      text: firstText(article, outside),
      ...(ownTime?.getAttribute('datetime') ? { time: ownTime.getAttribute('datetime')! } : {}),
      ...(squash(ownTime?.textContent) ? { timeLabel: squash(ownTime?.textContent) } : {}),
      url: href.split(/[?#]/)[0]!,
      ...(metrics ? { metrics: cap(metrics, 400) } : {}),
      media: mediaOf(article, outside),
    };
    let quoted: StoryXPostRead | undefined;
    if (quote) {
      const inside = (): boolean => true;
      const qTime = quote.querySelector('time');
      const qLink = [...quote.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')].map((a) => a.href).find((u) => !u.includes(`/status/${id}`));
      quoted = {
        ...nameOf(quote, inside),
        text: firstText(quote, inside),
        ...(qTime?.getAttribute('datetime') ? { time: qTime.getAttribute('datetime')! } : {}),
        ...(squash(qTime?.textContent) ? { timeLabel: squash(qTime?.textContent) } : {}),
        ...(qLink ? { url: qLink.split(/[?#]/)[0]! } : {}),
        media: mediaOf(quote, inside),
      };
    }
    const cardEl = [...article.querySelectorAll('[data-testid="card.wrapper"]')].find(outside);
    const cardText = cardEl ? cap(squash(textOf(cardEl)), 400) : '';
    const cardUrl = cardEl?.querySelector<HTMLAnchorElement>('a[href]')?.href;
    return {
      ...base,
      post,
      ...(quoted ? { quoted } : {}),
      ...(cardText ? { card: { text: cardText, ...(cardUrl ? { url: cardUrl } : {}) } } : {}),
      ...(selection ? { selection } : {}),
    };
  }

  // ── 别的网页：元数据 + 正文 ──
  const meta = (...sels: string[]): string | undefined => {
    for (const sel of sels) {
      const v = squash(document.querySelector(sel)?.getAttribute('content'));
      if (v) return v;
    }
    return undefined;
  };
  type Ld = Record<string, unknown>;
  const lds: Ld[] = [];
  const pushLd = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(pushLd);
    else if (v && typeof v === 'object') {
      lds.push(v as Ld);
      if (Array.isArray((v as Ld)['@graph'])) pushLd((v as Ld)['@graph']);
    }
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      pushLd(JSON.parse(s.textContent ?? ''));
    } catch {
      // 页面自己写坏的 JSON-LD：跳过
    }
  }
  const typeOf = (o: Ld): string => (Array.isArray(o['@type']) ? (o['@type'] as unknown[]).join(',') : String(o['@type'] ?? ''));
  const ld = lds.find((o) => /Article|Posting|Report|NewsArticle/i.test(typeOf(o)));
  const ldStr = (k: string): string | undefined => {
    const v = ld?.[k];
    return typeof v === 'string' && squash(v) ? squash(v) : undefined;
  };
  const ldAuthors = (): string[] => {
    const a = ld?.['author'];
    const list = Array.isArray(a) ? a : a ? [a] : [];
    return list.map((x) => squash(typeof x === 'string' ? x : x && typeof x === 'object' ? String((x as Ld)['name'] ?? '') : '')).filter((x) => !!x);
  };
  const metaAuthor = meta('meta[name="author"]', 'meta[property="article:author"]:not([content^="http"])', 'meta[name="parsely-author"]', 'meta[name="sailthru.author"]', 'meta[name="byl"]');
  const authors = [...new Set([...ldAuthors(), ...(metaAuthor ? [metaAuthor.replace(/^By\s+/i, '')] : [])])].slice(0, 6);
  const timeEl = document.querySelector('article time[datetime], time[pubdate][datetime], [itemprop="datePublished"][datetime]');
  const published =
    ldStr('datePublished') ??
    meta('meta[property="article:published_time"]', 'meta[name="article:published_time"]', 'meta[itemprop="datePublished"]', 'meta[name="pubdate"]', 'meta[name="publishdate"]', 'meta[name="publish-date"]', 'meta[name="date"]', 'meta[name="parsely-pub-date"]', 'meta[name="DC.date.issued"]') ??
    (squash(timeEl?.getAttribute('datetime')) || undefined);
  const modified = ldStr('dateModified') ?? meta('meta[property="article:modified_time"]', 'meta[name="article:modified_time"]', 'meta[itemprop="dateModified"]');
  const h1 = squash(document.querySelector('article h1, main h1, h1')?.textContent);
  const title = meta('meta[property="og:title"]', 'meta[name="twitter:title"]') ?? ldStr('headline') ?? (h1 || undefined);
  const publisher = ld?.['publisher'];
  const siteName =
    meta('meta[property="og:site_name"]', 'meta[name="application-name"]') ??
    (publisher && typeof publisher === 'object' && squash(String((publisher as Ld)['name'] ?? '')) ? squash(String((publisher as Ld)['name'])) : undefined);
  const description = meta('meta[property="og:description"]', 'meta[name="description"]', 'meta[name="twitter:description"]');
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || meta('meta[property="og:url"]');

  // 正文：在几个候选容器里挑段落文字最多的那个，按文档顺序读标题、段落、列表项、引文
  const BLOCKS = 'h1,h2,h3,h4,p,li,blockquote,pre,figcaption,dd';
  const SKIP = 'nav,header,footer,aside,form,button,[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"],[aria-hidden="true"]';
  const paraLen = (root: Element): number => [...root.querySelectorAll('p')].reduce((n, p) => n + (p.closest(SKIP) && !root.matches(SKIP) ? 0 : squash(p.textContent).length), 0);
  const candidates = [...document.querySelectorAll('[itemprop="articleBody"], article, main, [role="main"]')];
  let container: Element = document.body ?? document.documentElement;
  let best = 0;
  for (const c of candidates) {
    const n = paraLen(c);
    if (n > best) {
      best = n;
      container = c;
    }
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  let truncated = false;
  for (const el of container.querySelectorAll(BLOCKS)) {
    if (el.querySelector(BLOCKS) || el.closest(SKIP) || el.closest(INSERTED) || !visible(el)) continue;
    const t = squash(textOf(el));
    if (t.length < 2 || seen.has(t) || (el.tagName === 'LI' && t.length < 3)) continue;
    seen.add(t);
    if (total + t.length > cfg.maxTextChars) {
      lines.push(cap(t, Math.max(0, cfg.maxTextChars - total)));
      truncated = true;
      break;
    }
    lines.push(t);
    total += t.length + 1;
  }
  let text = lines.join('\n').trim();
  const ldBody = ldStr('articleBody');
  if (ldBody && ldBody.length > text.length) {
    truncated = ldBody.length > cfg.maxTextChars;
    text = cap(ldBody, cfg.maxTextChars);
  }
  const selection = selectionText();
  const lang = squash(document.documentElement.getAttribute('lang'));
  return {
    kind: 'page',
    url: href,
    ...(canonical ? { canonical } : {}),
    docTitle: squash(document.title),
    ...(title ? { title } : {}),
    ...(siteName ? { siteName } : {}),
    authors,
    ...(published ? { published } : {}),
    ...(modified ? { modified } : {}),
    ...(description ? { description: cap(description, 1000) } : {}),
    ...(lang ? { lang } : {}),
    ...(ld ? { ldType: cap(typeOf(ld), 80) } : {}),
    text,
    truncated,
    ...(selection ? { selection } : {}),
  };
}
