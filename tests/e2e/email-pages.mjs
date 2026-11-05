// @ts-check
// e2e 用的仿 Gmail 页面（由 mock 服务在 /gmail/ 下提供）。邮件结构照 2026-11-04 读到的真实 Medium Daily Digest；
// 作者、标题、数字都是虚构的，不含任何真实邮件内容。
// - 分栏阅读：换邮件时网址不变（openMail 只换阅读窗格里的内容）
// - 打开过的邮件留在页面里、藏起来（.a3s 不止一份）
// - 正文开头有藏起来的预览文字，链接都带 source 跟踪参数（里面是收件人的用户 ID）
// 页面记下自己的 DOM 变化与点击次数，用来确认 TubeMuse 不写页面、不点按钮。

export const GMAIL_RECIPIENT = 'test.reader@example.com';
const SOURCE = '?source=email-0123456789ab-1793748000000-digest.reader-abc123-def456----0-59--------------------abc---1';

/** @param {string} p */
const href = (p) => `https://medium.com/${p}${SOURCE}`;

/**
 * @typedef {{ author: string; pub?: string; slug: string; title: string; h2?: string; sub: string; min: number; claps?: string; responses?: string; member?: boolean }} Article
 */

/** @type {Article[]} */
export const DIGEST_ARTICLES = [
  { author: 'Ada Writer', pub: 'Systems Weekly', slug: 'postmortem-abc123', title: 'A Postmortem of Our Two-Year Postgres Migration Across 40 Nodes', h2: 'A Postmortem of Our Two-Year Postgres Migration…', sub: 'Three outages and the metrics that…', min: 14, claps: '1.3K', responses: '25', member: true },
  { author: 'Bo Lister', slug: 'best-tools-def456', title: 'The Best AI Tools for 2026 (Number 7 Will Shock You)', sub: 'You will not believe what these do', min: 3, claps: '148' },
  { author: 'Cy Notes', pub: 'AI Notes', slug: 'agent-tests-789abc', title: 'Testing Agents With Replayed Traces', sub: 'What broke when we shipped it', min: 9, claps: '612', responses: '8', member: true },
  { author: 'Di Hype', pub: 'Growth Hacks', slug: 'slop-111aaa', title: 'Stop Using ChatGPT Wrong: 99% of People Have No Idea', sub: 'One weird trick to earn more', min: 2 },
  { author: 'Ed Fair', slug: 'intro-222bbb', title: 'An Introduction to Vector Databases', sub: 'What they are and when to use one', min: 6, claps: '95' },
];

/** 第二封汇总：一篇和第一封重复，一篇是新的 */
export const DIGEST2_ARTICLES = [DIGEST_ARTICLES[0], { author: 'Fay Deep', pub: 'Systems Weekly', slug: 'benchmark-333ccc', title: 'A Benchmark of Five Embedding Stores Under Real Load', sub: 'Numbers from a month of traffic', min: 11, claps: '420', responses: '12' }];

/** 藏在页面里的上一封（Gmail 不把打开过的邮件从页面里拿掉）：不该被读到 */
const HIDDEN_ARTICLES = [
  { author: 'Old Mail', slug: 'hidden-1', title: 'A Hidden Article From An Earlier Mail', sub: 'Should never be listed', min: 1 },
  { author: 'Old Mail', slug: 'hidden-2', title: 'Another Hidden Article From That Mail', sub: 'Should never be listed', min: 1 },
];

/** @param {Article} a */
function articleHtml(a) {
  const url = href(`@writer/${a.slug}`);
  const profile = href('@writer');
  return `<table><tr><td>
    <a href="${profile}"><img alt="${a.author}" width="20" height="20" src="data:,"></a>
    <span style="font-size:13px"><a href="${profile}">${a.author}</a></span>
    ${a.pub ? `<span style="font-size:13px"> in </span><span style="font-size:13px"><a href="${href('some-publication')}">${a.pub}</a></span>` : ''}
    <a href="${url}"><img alt="${a.title}" width="160" height="107" src="data:,"></a>
    <a href="${url}"><h2 style="font-size:20px;font-weight:700">${a.h2 ?? a.title}</h2><h3 style="font-size:16px;font-weight:400">${a.sub}</h3></a>
    ${a.member ? '<img alt="Member-only content" width="15" height="15" src="data:,">' : ''}
    <span style="font-size:13px">${a.min} min read</span>
    ${a.claps ? `<img alt="Claps" width="16" height="16" src="data:,"><span style="font-size:13px">${a.claps}</span>` : ''}
    ${a.responses ? `<img alt="Responses" width="16" height="16" src="data:,"><span style="font-size:13px">${a.responses}</span>` : ''}
  </td></tr></table>`;
}

/** @param {Article[]} articles */
function digestBody(articles) {
  return `<div style="display:none">Preview text: Hidden Preheader Should Not Be Read At All</div>
  <a href="${href('@testreader')}"><img alt="Test Reader" width="32" height="32" src="data:,"></a>
  <div><a href="${href('@testreader')}">Stories for <span style="font-weight:700">Test Reader</span></a></div>
  <a href="https://medium.com/${SOURCE}"><img alt="Medium daily digest" width="600" height="60" src="data:,"></a>
  <p style="font-size:18px;font-weight:700">Today's highlights</p>
  ${articles.map(articleHtml).join('\n')}
  <h2 style="font-weight:400">See more of what you like and less of what you don't.</h2>
  <a style="font-size:16px" href="https://medium.com/me/missioncontrol${SOURCE}">Control your recommendations</a>
  <h2 style="font-size:16px;font-weight:700">Read from anywhere.</h2>
  <a href="https://itunes.apple.com/app/medium-everyones-stories/id828256236?source=x"><img alt="Get Medium on the App Store" width="120" height="40" src="data:,"></a>
  <div style="font-size:13px">Sent by <a href="https://medium.com/${SOURCE}">Medium</a> · 3500 South DuPont Highway
    <a href="https://medium.com/me/notifications/unsubscribe?token=e2e-unsubscribe-token&source=x">Unsubscribe</a>
    <a href="https://help.medium.com/hc/en-us">Help Center</a>
    <a href="https://policy.medium.com/medium-privacy-policy-f03bf92035c9">Privacy Policy</a></div>`;
}

const MAILS = {
  digest: { subject: 'A Postmortem of Our Two-Year Postgres Migration | Ada Writer in Systems Weekly', sender: 'Medium Daily Digest', address: 'noreply@medium.com', body: digestBody(DIGEST_ARTICLES) },
  digest2: { subject: 'A Benchmark of Five Embedding Stores | Fay Deep in Systems Weekly', sender: 'Medium Daily Digest', address: 'noreply@medium.com', body: digestBody(DIGEST2_ARTICLES) },
  /** 第三封：文章都在第一封里评过了，而且一篇精读都没有（你截图里那种情况：有分数，还没有总体结论） */
  weak: { subject: 'The Best AI Tools for 2026 | Bo Lister', sender: 'Medium Daily Digest', address: 'noreply@medium.com', body: digestBody([DIGEST_ARTICLES[1], DIGEST_ARTICLES[3], DIGEST_ARTICLES[4]]) },
  personal: {
    subject: 'Lunch on Friday?',
    sender: 'A Friend',
    address: 'friend@example.com',
    body: '<p>Hi, are we still on for Friday? Here is the place: <a href="https://maps.example.com/place/12">the noodle shop</a>. My private note: e2e-private-mail-text.</p>',
  },
  clipped: { subject: 'A very long digest', sender: 'Medium Daily Digest', address: 'noreply@medium.com', body: digestBody(DIGEST_ARTICLES.slice(0, 2)), clipped: true },
};

/** 没有 .a3s：模拟 Gmail 改版，正文的 class 变了 */
const BROKEN = { subject: 'Gmail changed its markup', sender: 'Someone', address: 'someone@example.com', body: '<p>Body in a container TubeMuse does not know.</p>' };

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>收件箱 - ${GMAIL_RECIPIENT} - Gmail</title>
<style>body{font-family:sans-serif;margin:0;display:flex}#list{width:280px;border-right:1px solid #ddd}#pane{flex:1;padding:12px}</style></head>
<body>
<div id="list" role="main"><table><tr class="zA yO"><td><span class="yP" email="noreply@medium.com">Medium Daily Digest</span></td></tr></table></div>
<div id="pane">
  <div id="previous" style="display:none"><div class="a3s aiL">${digestBody(HIDDEN_ARTICLES)}</div></div>
  <div id="current"></div>
</div>
<script>
  const MAILS = ${JSON.stringify({ ...MAILS, broken: BROKEN })};
  window.__mutations = 0;
  window.__clicks = 0;
  document.addEventListener('click', () => window.__clicks++, true);
  /** 换邮件：网址不变（分栏阅读） */
  window.openMail = (id) => {
    const m = MAILS[id];
    const cls = id === 'broken' ? 'new-body-class' : 'a3s aiL';
    document.getElementById('current').innerHTML =
      '<h2 class="hP"></h2><span class="gD"></span><div class="ii gt"><div class="' + cls + '"></div></div>' + (m.clipped ? '<div class="iX"><a href="#">[邮件已截断] 查看完整邮件</a></div>' : '');
    document.querySelector('h2.hP').textContent = m.subject;
    const s = document.querySelector('.gD');
    s.setAttribute('name', m.sender);
    s.setAttribute('email', m.address);
    s.textContent = m.sender;
    document.querySelector('#current .' + cls.split(' ')[0]).innerHTML = m.body;
  };
  /** 从这里起，页面自己不再改 DOM：有变化就是别人改的 */
  window.watchPage = () => {
    window.__mutations = 0;
    new MutationObserver((list) => (window.__mutations += list.length)).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  };
</script>
</body></html>`;

/** @param {string} path */
export function gmailPage(path) {
  return path === '/gmail/mail' ? PAGE : undefined;
}
