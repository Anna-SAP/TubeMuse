// @ts-check
// Firefox 版签名流程的端到端测试（DECISIONS §71），不连真的 Mozilla：本机起一个按 AMO v5 接口行事的假服务，
// 让 scripts/sign-firefox.mjs 带着真的 web-ext（tools/amo）把整条路走一遍：
//   上传 → 等校验 → 提交版本（带给审核员的说明）→ 上传源码包 → 等签名 → 下载签好的文件 → 核对 → 存成 -signed.xpi
// 并核对：每个请求都带着用 AMO_JWT_SECRET 签的 JWT（iss = AMO_JWT_ISSUER）；凭据不出现在命令行和输出里；
// 交上去的是 dist-firefox/ 的内容和这个提交的源码；校验不过、签好的文件被改过、缺凭据时都会失败并说明原因。
// 需要 npm ci --prefix tools/amo。会构建一次 Firefox 版（dist-firefox/ 与 release/ 下一个测试版本号的 .xpi，结束时删掉）。
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIREFOX_ADDON_ID } from '../../scripts/firefox.mjs';
import { listZipEntries, readZipEntry, zipDirectory } from '../../scripts/zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = '0.1.0.65000';
const ISSUER = 'user:12345:67';
const SECRET = 'mock-amo-secret-0123456789abcdef0123456789abcdef0123456789abcdef';
const unsignedPath = join(root, 'release', `tubemuse-${VERSION}-firefox.xpi`);
const signedOut = join(root, 'release', `tubemuse-${VERSION}-firefox-signed.xpi`);

let failures = 0;
/** @param {boolean} cond @param {string} msg */
function check(cond, msg) {
  console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`);
  if (!cond) failures++;
}

if (!existsSync(join(root, 'tools', 'amo', 'node_modules', 'web-ext'))) {
  console.error('✘ 没有装 web-ext：先运行 npm ci --prefix tools/amo');
  process.exit(2);
}

// ── 构建一个测试版本号的 Firefox 版 ──
const build = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs'), '--firefox', `--version=${VERSION}`], { cwd: root, encoding: 'utf8' });
if (build.status !== 0) {
  console.error(build.stdout, build.stderr);
  process.exit(1);
}

/** 校验 AMO 的 JWT：HS256、iss 对、没过期 @param {string | undefined} header */
function jwtOk(header) {
  const m = /^JWT ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(header ?? '');
  if (!m) return false;
  const [, h, p, sig] = /** @type {[string, string, string, string]} */ (/** @type {unknown} */ (m));
  const expected = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  if (expected !== sig) return false;
  const head = JSON.parse(Buffer.from(h, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  return head.alg === 'HS256' && payload.iss === ISSUER && payload.exp > Date.now() / 1000;
}

/**
 * 一次运行：起假 AMO，跑 sign-firefox.mjs，返回结果。
 * @param {{ valid?: boolean; tamper?: boolean; env?: Record<string, string> }} mode
 */
async function runOnce(mode) {
  /** @type {{ method: string; path: string; authOk: boolean }[]} */
  const requests = [];
  /** @type {{ upload?: Buffer; uploadName?: string; channel?: string; submit?: any; source?: Buffer; sourceName?: string }} */
  const got = {};
  let signed = Buffer.alloc(0);
  let polls = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const authOk = jwtOk(req.headers.authorization);
    requests.push({ method: req.method ?? '', path, authOk });
    /** @param {number} status @param {unknown} data */
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (!authOk) return json(401, { detail: 'bad jwt' });
    const form = () => new Request('http://x', { method: 'POST', headers: { 'content-type': String(req.headers['content-type']) }, body }).formData();
    const base = '/api/v5/addons/';
    if (req.method === 'POST' && path === `${base}upload/`) {
      const fd = await form();
      const file = /** @type {File} */ (fd.get('upload'));
      got.upload = Buffer.from(await file.arrayBuffer());
      got.uploadName = file.name;
      got.channel = String(fd.get('channel'));
      return json(201, { uuid: 'u-1' });
    }
    if (req.method === 'GET' && path === `${base}upload/u-1/`) {
      // 第一次还没处理完，第二次给结果：web-ext 要会等
      polls++;
      if (polls < 2) return json(200, { uuid: 'u-1', processed: false });
      return json(200, { uuid: 'u-1', processed: true, valid: mode.valid !== false, validation: mode.valid === false ? { messages: [{ type: 'error', message: 'mock validation error' }] } : {} });
    }
    if (req.method === 'PUT' && path === `${base}addon/${FIREFOX_ADDON_ID}/`) {
      got.submit = JSON.parse(body.toString());
      return json(200, { guid: FIREFOX_ADDON_ID, version: { id: 42, edit_url: 'http://127.0.0.1/edit/42' } });
    }
    if (req.method === 'PATCH' && path === `${base}addon/${FIREFOX_ADDON_ID}/versions/42/`) {
      const file = /** @type {File} */ ((await form()).get('source'));
      got.source = Buffer.from(await file.arrayBuffer());
      got.sourceName = file.name;
      return json(200, { id: 42 });
    }
    if (req.method === 'GET' && path === `${base}addon/${FIREFOX_ADDON_ID}/versions/42/`) {
      // "签名"：把上传的包原样拆开，加上 META-INF 签名文件再打包（tamper 时顺手改一个文件，核对应该发现）
      if (!got.upload) return json(500, { detail: 'mock: 没收到上传的包' });
      const dir = mkdtempSync(join(tmpdir(), 'tubemuse-mock-sign-'));
      try {
        const up = /** @type {Buffer} */ (got.upload);
        for (const name of listZipEntries(up).filter((n) => !n.endsWith('/'))) {
          mkdirSync(dirname(join(dir, 'x', name)), { recursive: true });
          writeFileSync(join(dir, 'x', name), /** @type {Buffer} */ (readZipEntry(up, name)));
        }
        mkdirSync(join(dir, 'x', 'META-INF'), { recursive: true });
        for (const f of ['manifest.mf', 'mozilla.sf', 'mozilla.rsa', 'cose.manifest', 'cose.sig']) writeFileSync(join(dir, 'x', 'META-INF', f), `mock ${f}`);
        if (mode.tamper) writeFileSync(join(dir, 'x', 'background.js'), '/* changed */');
        zipDirectory(join(dir, 'x'), join(dir, 'signed.xpi'));
        signed = readFileSync(join(dir, 'signed.xpi'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return json(200, { id: 42, file: { status: 'public', url: `http://127.0.0.1:${port()}/downloads/file/1/tubemuse-${VERSION}.xpi` } });
    }
    if (req.method === 'GET' && path === `/downloads/file/1/tubemuse-${VERSION}.xpi`) {
      res.writeHead(200, { 'content-type': 'application/x-xpinstall' });
      return res.end(signed);
    }
    return json(404, { detail: `mock: no route ${req.method} ${path}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  function port() {
    const a = server.address();
    return a && typeof a === 'object' ? a.port : 0;
  }
  rmSync(signedOut, { force: true });
  const summaryFile = join(mkdtempSync(join(tmpdir(), 'tubemuse-sign-summary-')), 'summary.md');
  // 子进程要异步跑：假 AMO 在这个进程里，同步等待会让它没法应答
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'sign-firefox.mjs'), `--version=${VERSION}`], {
      cwd: root,
      env: {
        ...process.env,
        AMO_JWT_ISSUER: ISSUER,
        AMO_JWT_SECRET: SECRET,
        TUBEMUSE_AMO_BASE_URL: `http://127.0.0.1:${port()}/api/v5/`,
        GITHUB_STEP_SUMMARY: summaryFile,
        ...mode.env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
  server.close();
  const summary = existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '';
  rmSync(dirname(summaryFile), { recursive: true, force: true });
  return { run, requests, got, summary, output: `${run.stdout}\n${run.stderr}` };
}

try {
  console.log('\n[签好名：整条路走通]');
  const ok = await runOnce({});
  check(ok.run.status === 0, `sign-firefox.mjs 成功退出${ok.run.status === 0 ? '' : `（${ok.run.status}）：${ok.output.slice(-1500)}`}`);
  check(ok.requests.length > 0 && ok.requests.every((r) => r.authOk), `每个请求都带着用 AMO_JWT_SECRET 签的 JWT（iss = AMO_JWT_ISSUER），共 ${ok.requests.length} 个`);
  check(ok.got.channel === 'unlisted', '自行分发（unlisted）：不公开上架');
  const up = ok.got.upload ?? Buffer.alloc(0);
  const ours = readFileSync(unsignedPath);
  const upNames = listZipEntries(up).filter((n) => !n.endsWith('/')).sort();
  const ourNames = listZipEntries(ours).filter((n) => !n.endsWith('/')).sort();
  check(
    JSON.stringify(upNames) === JSON.stringify(ourNames) && ourNames.every((n) => /** @type {Buffer} */ (readZipEntry(up, n)).equals(/** @type {Buffer} */ (readZipEntry(ours, n)))),
    `交给 Mozilla 的就是 dist-firefox/ 的内容（${upNames.length} 个文件，与 release/ 里的 .xpi 逐个相同）`,
  );
  check(ok.got.submit?.version?.upload === 'u-1', '提交版本时用的是刚上传的那个包');
  check(String(ok.got.submit?.version?.approval_notes).includes(`node scripts/build.mjs --firefox --version=${VERSION}`), '给审核员的说明里有从源码构建的命令');
  const src = ok.got.source ?? Buffer.alloc(0);
  const srcNames = src.length ? listZipEntries(src) : [];
  check(srcNames.includes('package.json') && srcNames.includes('scripts/build.mjs') && srcNames.includes('src/background.ts') && !srcNames.some((n) => n.startsWith('local/') || n.startsWith('node_modules/')), `附上了这个提交的源码（${srcNames.length} 个条目，含 package.json、scripts/build.mjs、src/；不含 local/、node_modules/）`);
  check(existsSync(signedOut), `存成了 release/tubemuse-${VERSION}-firefox-signed.xpi`);
  check(!existsSync(join(root, 'dist-firefox', '.amo-upload-uuid')) && !existsSync(join(root, 'dist-firefox', '.web-extension-id')), 'web-ext 的上传记录没有留在 dist-firefox/ 里（下一次一定重新上传）');
  if (existsSync(signedOut)) check(listZipEntries(readFileSync(signedOut)).includes('META-INF/cose.sig'), '存下的是签好的那个（带 META-INF 签名文件）');
  check(ok.summary.includes('已由 Mozilla 签名'), '运行摘要里写明已签名');
  check(!ok.output.includes(SECRET) && !ok.summary.includes(SECRET), '输出和运行摘要里没有 AMO_JWT_SECRET');

  console.log('\n[签好的文件被改过：核对发现，不上传]');
  const bad = await runOnce({ tamper: true });
  check(bad.run.status !== 0 && /签好的文件没通过核对/.test(bad.output) && /background\.js/.test(bad.output), '签好的文件和我们打的不一样时失败，并说出是哪个文件');
  check(!existsSync(signedOut), '没有存下这个文件');

  console.log('\n[Mozilla 的校验没通过]');
  const invalid = await runOnce({ valid: false });
  check(invalid.run.status !== 0 && /mock validation error/.test(invalid.output) && /校验没通过/.test(invalid.output), '失败，输出里有 Mozilla 列出的问题和下一步怎么办');
  check(invalid.summary.includes('Firefox 版没有签名成功'), '运行摘要里写明没有签名成功');

  console.log('\n[没配凭据]');
  const nocred = await runOnce({ env: { AMO_JWT_SECRET: '' } });
  check(nocred.run.status !== 0 && /AMO_JWT_SECRET/.test(nocred.output) && nocred.requests.length === 0, '不发任何请求，说明要配哪个 Secret');

  console.log('\n[测试入口只许指向本机]');
  const outside = await runOnce({ env: { TUBEMUSE_AMO_BASE_URL: 'https://example.com/api/v5/' } });
  check(outside.run.status !== 0 && /只能指向本机/.test(outside.output) && outside.requests.length === 0, '指向别处时直接拒绝，凭据不会被发出去');
} catch (e) {
  failures++;
  console.error('✘ 签名流程测试异常：', e);
} finally {
  rmSync(unsignedPath, { force: true });
  rmSync(signedOut, { force: true });
}
console.log(failures ? `\n✘ Firefox 签名流程测试失败 ${failures} 项` : '\n✔ Firefox 签名流程测试通过（假 AMO，真 web-ext）');
process.exit(failures ? 1 : 0);
