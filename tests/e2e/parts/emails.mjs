// @ts-check
// eMails：在仿 Gmail 页面上列出文章、评估、收藏、总体结论，以及这一页的红线。
import { join } from 'node:path';
import { check, MOCK, shots } from '../harness.mjs';

/** @param {import('../harness.mjs').Harness} t */
export async function emails(t) {
  const { context, options, requests, consoleErrors } = t;
  const panel = await t.openPanel();

  // ───────────────────────── eMails ─────────────────────────
  console.log('\n[eMails：不在 Gmail 时说明怎么开始；打开邮件才列出文章，换邮件网址不变也跟得上]');
  await panel.bringToFront();
  await panel.getByRole('tab', { name: 'eMails' }).click();
  await panel.getByTestId('email-no-script').waitFor({ timeout: 5000 });
  check(((await panel.getByTestId('email-no-script').textContent()) ?? '').includes('当前标签页不是 Gmail'), '当前标签页不是 Gmail：说明怎么开始，并提示页面可能要刷新');
  const emailReqStart = requests.length;
  const llmCount = () => requests.filter((r) => r.path === '/anthropic/v1/messages').length;
  const llmAtStart = llmCount();
  const [gmail] = await Promise.all([context.waitForEvent('page'), panel.evaluate((url) => /** @type {any} */ (globalThis).chrome.tabs.create({ url, active: true }), `${MOCK}/gmail/mail`)]);
  gmail.on('pageerror', (e) => consoleErrors.push(`gmail pageerror: ${e.message}`));
  gmail.on('console', (m) => m.type() === 'error' && consoleErrors.push(`gmail: ${m.text()}`));
  await gmail.waitForLoadState('load');
  await panel.getByTestId('email-no-mail').waitFor({ timeout: 8000 });
  check(true, '打开了 Gmail 但还没点开邮件：说明要先打开一封（藏在页面里的上一封不算）');
  await gmail.evaluate(() => /** @type {any} */ (globalThis).openMail('digest'));
  await gmail.evaluate(() => /** @type {any} */ (globalThis).watchPage());
  const gmailUrl = gmail.url();
  await panel.getByTestId('email-found').filter({ hasText: '找到 5 篇文章' }).waitFor({ timeout: 8000 });
  const found = (await panel.getByTestId('email-found').textContent()) ?? '';
  check(found.includes('Medium Daily Digest'), `列出当前邮件：${found}`);
  const titles = await panel.getByTestId('email-title').allTextContents();
  check(titles[0]?.includes('A Postmortem of Our Two-Year Postgres Migration Across 40 Nodes') === true, '标题被邮件截断时显示配图 alt 里的完整标题');
  check(!titles.some((t) => t.includes('Hidden')), '藏在页面里的上一封邮件不会被读到');
  check(titles.length === 5 && !titles.some((t) => /Control your|Read from|Unsubscribe|Stories for/.test(t)), '页头、页脚、退订链接都不算文章');
  const firstCard = ((await panel.getByTestId('email-item').first().textContent()) ?? '');
  check(['Ada Writer', 'Systems Weekly', '14 分钟', '1,300 掌声', '25 回应', '会员文章', 'Three outages'].every((t) => firstCard.includes(t)), `卡片上有作者、刊物、阅读时长、互动数和摘要：${firstCard.slice(0, 120)}`);
  const firstHref = (await panel.getByTestId('email-title').first().getAttribute('href')) ?? '';
  check(firstHref === 'https://medium.com/@writer/postmortem-abc123', `链接去掉了带收件人信息的 source 参数：${firstHref}`);
  check(llmCount() === llmAtStart, '只是打开邮件：什么都没有发给大模型');
  check(((await panel.getByTestId('email-disclosure').textContent()) ?? '').includes('发给 Anthropic'), '说明点"评估"后发什么、发给谁，以及大模型没有读正文');

  console.log('\n[eMails：评估 → 分数与理由，按分数排序、筛选]');
  await panel.getByTestId('email-evaluate').click();
  await panel.getByTestId('email-score').nth(4).waitFor({ timeout: 8000 });
  await panel.getByTestId('email-result').waitFor({ timeout: 5000 });
  const scored = await panel.getByTestId('email-score').allTextContents();
  check(JSON.stringify(scored) === JSON.stringify(['9', '8', '5', '2', '0']), `按分数从高到低：${scored.join(' ')}`);
  check(((await panel.getByTestId('email-reason').first().textContent()) ?? '').includes('一手数据'), '每篇都有简短理由');
  check(((await panel.getByTestId('email-result').textContent()) ?? '').includes('评完 5 篇'), '说明这次评了几篇、用的模型和大约花了多少');
  const [emailCall, verdictCall] = requests.filter((r) => r.path === '/anthropic/v1/messages').slice(-2);
  check(llmCount() === llmAtStart + 2 && emailCall.body.includes('Testing Agents With Replayed Traces'), '评估发了一次评分请求，带着文章标题');
  check(verdictCall.body.includes('汇总邮件总评员') && verdictCall.body.includes('有具体的一手数据'), '评完再发一次总体结论，带着分数和理由');
  const emailLeaks = ['source=', 'https://', 'noreply@medium.com', 'Medium Daily Digest', 'Ada Writer in Systems Weekly', 'Test Reader', 'test.reader@example.com', 'Stories for', 'e2e-unsubscribe-token', 'Lunch on Friday'].filter((t) => emailCall.body.includes(t) || verdictCall.body.includes(t));
  check(emailLeaks.length === 0, `发给大模型的整个请求体不含链接、邮件主题、发件人和收件人${emailLeaks.length ? `，却出现了：${emailLeaks.join('、')}` : ''}`);
  check(!verdictCall.body.includes('Ada Writer') && !verdictCall.body.includes('Three outages'), '写总体结论时不再发作者和摘要');
  check(((await panel.getByTestId('email-verdict-headline').textContent()) ?? '').includes('这 5 篇里有 2 篇值得精读'), '评完显示总体结论：一句话概括');
  check(((await panel.getByTestId('email-verdict-summary').textContent()) ?? '').includes('实战复盘'), '总体结论有大模型写的整体质量概述');
  check((await panel.getByTestId('email-verdict-why').count()) === 0, '有值得精读的文章时不解释"为什么没有"');
  const bands = panel.getByTestId('email-bands');
  check(((await bands.textContent()) ?? '').includes('值得精读 2') && ((await bands.textContent()) ?? '').includes('一般 1') && ((await bands.textContent()) ?? '').includes('建议跳过 2'), `按分档计数：${await bands.textContent()}`);
  await bands.getByRole('button', { name: /建议跳过/ }).click();
  check((await panel.getByTestId('email-item').count()) === 2 && (await panel.getByTestId('email-item').first().getAttribute('data-band')) === 'skip', '筛选"建议跳过"：只看低分');
  await bands.getByRole('button', { name: /全部/ }).click();
  await panel.screenshot({ path: join(shots, '30-emails-scored.png'), fullPage: true });

  console.log('\n[eMails：一键收藏、打标签，收藏页筛选、移出可撤销]');
  await panel.getByTestId('email-save').first().click();
  await panel.getByTestId('email-unsave').first().waitFor({ timeout: 5000 });
  const emailStored = () => panel.evaluate(async () => (await /** @type {any} */ (globalThis).chrome.storage.local.get('emailSaved')).emailSaved ?? { articles: {} });
  const savedArticle = Object.values((await emailStored()).articles)[0];
  check(/** @type {any} */ (savedArticle)?.score === 9 && /** @type {any} */ (savedArticle)?.url === 'https://medium.com/@writer/postmortem-abc123', '收藏时带上分数与理由，存的是干净的链接');
  const tagBox = panel.getByTestId('email-item').first().getByRole('textbox', { name: '加标签' });
  await tagBox.fill('数据库, 长文');
  await tagBox.press('Enter');
  await panel.getByTestId('email-item').first().getByText('#长文').waitFor({ timeout: 5000 });
  await panel.getByTestId('email-mode-saved').click();
  check((await panel.getByTestId('email-saved-item').count()) === 1, '收藏页列出这篇');
  check(((await panel.getByTestId('email-tag-filter').textContent()) ?? '').includes('#数据库'), '标签筛选条与小红书同一套');
  await panel.getByTestId('email-remove').click();
  await panel.getByTestId('email-saved-empty').waitFor({ timeout: 5000 });
  await panel.getByTestId('email-undo').click();
  await panel.getByTestId('email-saved-item').waitFor({ timeout: 5000 });
  check(/** @type {any} */ (Object.values((await emailStored()).articles)[0])?.tags?.length === 2, '移出后撤销：标签还在');
  await panel.getByTestId('email-mode-mail').click();

  console.log('\n[eMails：换邮件、普通邮件、被截断、读不到正文]');
  await gmail.evaluate(() => /** @type {any} */ (globalThis).openMail('digest2'));
  await panel.getByTestId('email-found').filter({ hasText: '找到 2 篇文章' }).waitFor({ timeout: 8000 });
  check(gmail.url() === gmailUrl, '换邮件时网址没有变（分栏阅读），侧边栏照样跟上');
  check((await panel.getByTestId('email-score').count()) === 1 && ((await panel.getByTestId('email-evaluate').textContent()) ?? '').includes('评估剩下的 1 篇'), '上一封评过的文章直接显示分数，只需要评新的那篇');
  check((await panel.getByTestId('email-verdict').count()) === 0, '还有没评的文章、也没有结论时不下总体结论');
  await panel.getByTestId('email-evaluate').click();
  await panel.getByTestId('email-score').nth(1).waitFor({ timeout: 8000 });
  await panel.getByTestId('email-result').filter({ hasText: '评完 1 篇' }).waitFor({ timeout: 8000 });
  const [secondCall, secondVerdict] = requests.filter((r) => r.path === '/anthropic/v1/messages').slice(-2);
  check(llmCount() === llmAtStart + 4 && secondCall.body.includes('Benchmark') && !secondCall.body.includes('Postmortem'), '第二次只发新的那篇，评过的不再花钱');
  check(secondVerdict.body.includes('Benchmark') && secondVerdict.body.includes('Postmortem'), '总体结论覆盖这封邮件的全部文章，包括之前评过的');

  console.log('\n[eMails：文章都评过、一篇精读都没有时的总体结论]');
  await gmail.evaluate(() => /** @type {any} */ (globalThis).openMail('weak'));
  await panel.getByTestId('email-found').filter({ hasText: '找到 3 篇文章' }).waitFor({ timeout: 8000 });
  await panel.getByTestId('email-verdict').waitFor({ timeout: 5000 });
  check(llmCount() === llmAtStart + 4, '换到都评过的邮件：什么都没有发给大模型');
  check(((await panel.getByTestId('email-verdict-headline').textContent()) ?? '').includes('这 3 篇里没有值得精读的'), '没有大模型也说得清：一篇值得精读的都没有');
  check(((await panel.getByTestId('email-verdict-facts').textContent()) ?? '').includes('离精读线（7 分）还差 2 分'), `本地算出的原因：${await panel.getByTestId('email-verdict-facts').textContent()}`);
  const weakBands = panel.getByTestId('email-bands');
  await weakBands.getByRole('button', { name: /值得精读/ }).click();
  check(((await panel.getByTestId('email-band-empty').textContent()) ?? '').includes('原因见上面的总体结论'), '"值得精读 0"这一档不再只说"这一档没有文章"');
  await panel.getByTestId('email-conclude').click();
  await panel.getByTestId('email-verdict-why').waitFor({ timeout: 8000 });
  check(llmCount() === llmAtStart + 5, '点"生成总体结论"只发一次请求，不重新打分');
  check(((await panel.getByTestId('email-verdict-why').textContent()) ?? '').includes('都没有一手经验或数据'), '解释为什么一篇都不值得精读');
  check((await panel.getByTestId('email-conclude').count()) === 0, '写好之后不再显示"生成总体结论"');
  await panel.screenshot({ path: join(shots, '31-emails-verdict-none.png'), fullPage: true });
  await weakBands.getByRole('button', { name: /全部/ }).click();
  await gmail.evaluate(() => /** @type {any} */ (globalThis).openMail('personal'));
  await panel.getByTestId('email-no-articles').waitFor({ timeout: 8000 });
  check(((await panel.getByTestId('email-no-articles').textContent()) ?? '').includes('没有发给大模型') && (await panel.getByTestId('email-evaluate').count()) === 0, '普通邮件：说明不像文章汇总，没有"评估"按钮');
  await gmail.evaluate(() => /** @type {any} */ (globalThis).openMail('clipped'));
  await panel.getByTestId('email-clipped').waitFor({ timeout: 8000 });
  check(true, 'Gmail 截断了邮件：说明后面的文章读不到');
  await gmail.evaluate(() => /** @type {any} */ (globalThis).openMail('broken'));
  await panel.getByTestId('email-unreadable').waitFor({ timeout: 8000 });
  check(((await panel.getByTestId('email-unreadable').textContent()) ?? '').includes('Gmail 可能改版了'), '读不到正文：说明可能是 Gmail 改版，不静默');

  console.log('\n[eMails：红线]');
  const gmailMutationsBefore = await gmail.evaluate(() => /** @type {any} */ (globalThis).__clicks);
  check(gmailMutationsBefore === 0, 'TubeMuse 没有点击 Gmail 页面上的任何东西');
  await gmail.evaluate(() => /** @type {any} */ (globalThis).openMail('digest'));
  await gmail.evaluate(() => /** @type {any} */ (globalThis).watchPage());
  await panel.getByTestId('email-found').filter({ hasText: '找到 5 篇文章' }).waitFor({ timeout: 8000 });
  await panel.waitForTimeout(2000);
  check((await gmail.evaluate(() => /** @type {any} */ (globalThis).__mutations)) === 0, 'TubeMuse 读邮件时没有改动 Gmail 页面（DOM 没有任何变化）');
  const emailReqs = requests.slice(emailReqStart);
  const gmailPageReqs = emailReqs.filter((r) => String(r.headers.referer ?? '').startsWith(`${MOCK}/gmail/`));
  check(
    gmailPageReqs.every((r) => r.method === 'GET' && (r.path.startsWith('/gmail/') || r.path === '/favicon.ico')),
    `Gmail 页面上 TubeMuse 没有发出任何请求（只有你打开的页面本身）${gmailPageReqs.length ? `：${gmailPageReqs.map((r) => r.path).join(', ')}` : ''}`,
  );
  check(emailReqs.every((r) => !JSON.stringify(r).includes('e2e-private-mail-text')), '普通邮件的内容没有发到任何地方');
  await options.getByTestId('email-enabled').uncheck();
  await panel.getByText('eMails 已在设置里关闭').waitFor({ timeout: 5000 });
  check(true, '在设置里关掉 eMails：这一页说明已关闭，不再读邮件');
  await options.getByTestId('email-enabled').check();
  await gmail.close();
  await panel.bringToFront();
}
