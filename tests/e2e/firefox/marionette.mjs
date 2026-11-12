// @ts-check
// 驱动 Firefox 的最小客户端：Firefox 自带的 Marionette 协议（geckodriver 底下用的就是它），不需要另装驱动程序。
// Playwright 驱动的 Firefox 打不开 moz-extension:// 页面（导航不触发 load），所以 Firefox 的 e2e 走这条路（DECISIONS §69）。
// 协议：TCP 上的 "长度:JSON"；命令 [0, id, 名字, 参数]，应答 [1, id, 错误, 结果]。
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class Marionette {
  /** @param {net.Socket} sock */
  constructor(sock) {
    this.sock = sock;
    this.nextId = 0;
    /** @type {Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>} */
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    /** @type {((m: any) => void) | undefined} */
    this.onHello = undefined;
    sock.on('data', (d) => this.onData(d));
    sock.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Marionette 连接断开了'));
      this.pending.clear();
    });
  }

  /** 连上 Firefox 的 Marionette 端口（Firefox 启动需要几秒，连不上就等等再试） @param {number} port */
  static async connect(port, timeoutMs = 60_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await new Promise((resolve, reject) => {
          const sock = net.connect(port, '127.0.0.1');
          const m = new Marionette(sock);
          m.onHello = () => resolve(m);
          sock.once('error', reject);
        });
      } catch (e) {
        if (Date.now() > end) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  /** @param {Buffer} d */
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const colon = this.buf.indexOf(58);
      if (colon < 0) return;
      const len = Number(this.buf.subarray(0, colon).toString());
      if (this.buf.length < colon + 1 + len) return;
      const msg = JSON.parse(this.buf.subarray(colon + 1, colon + 1 + len).toString());
      this.buf = this.buf.subarray(colon + 1 + len);
      if (!Array.isArray(msg)) {
        this.onHello?.(msg);
        this.onHello = undefined;
        continue;
      }
      const [, id, err, result] = msg;
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      if (err) p.reject(Object.assign(new Error(`${err.error}: ${err.message}`), { data: err }));
      else p.resolve(result);
    }
  }

  /** @param {string} name @param {Record<string, unknown>} [params] @returns {Promise<any>} */
  send(name, params = {}) {
    const id = ++this.nextId;
    const s = Buffer.from(JSON.stringify([0, id, name, params]));
    this.sock.write(`${s.length}:`);
    this.sock.write(s);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    this.sock.destroy();
  }
}

/**
 * 启动一个全新配置的无头 Firefox，打开 Marionette。
 * MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1：允许自动化打开、操作 moz-extension:// 页面（Firefox 默认不让远程协议碰特权页面）。
 * @param {{ binary: string; profileDir: string; port: number; prefs: Record<string, string | number | boolean> }} o
 */
export function launchFirefox(o) {
  mkdirSync(o.profileDir, { recursive: true });
  const prefs = { ...o.prefs, 'marionette.port': o.port };
  writeFileSync(join(o.profileDir, 'user.js'), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n');
  const proc = spawn(o.binary, ['--headless', '--marionette', '--no-remote', '--profile', o.profileDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1', MOZ_CRASHREPORTER_DISABLE: '1' },
  });
  /** @type {string[]} */
  const log = [];
  const take = (/** @type {Buffer} */ d) => log.push(...d.toString().split('\n').filter(Boolean));
  proc.stdout.on('data', take);
  proc.stderr.on('data', take);
  return { proc, log };
}

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

/** 常用操作（都在当前切到的标签页里） */
export class Browser {
  /** @param {Marionette} m */
  constructor(m) {
    this.m = m;
  }

  async start() {
    await this.m.send('WebDriver:NewSession', { capabilities: { alwaysMatch: { 'moz:webdriverClick': true } } });
    await this.m.send('WebDriver:SetTimeouts', { script: 60_000, pageLoad: 60_000, implicit: 0 });
  }

  /** 以"临时附加组件"装上一个目录（和 about:debugging 的"临时载入附加组件"同一条路） @param {string} path */
  async installTemporary(path) {
    return (await this.m.send('Addon:Install', { path, temporary: true })).value;
  }

  /** @returns {Promise<string[]>} */
  async handles() {
    return /** @type {any} */ (await this.m.send('WebDriver:GetWindowHandles')) ?? [];
  }

  /** 切到某个标签页。focus=false：只让后面的命令作用在它上面，不把它变成前台标签页 @param {string} handle */
  async switchTo(handle, focus = false) {
    await this.m.send('WebDriver:SwitchToWindow', { handle, focus });
  }

  /** 新开一个后台标签页并切过去 @returns {Promise<string>} */
  async newTab() {
    const r = await this.m.send('WebDriver:NewWindow', { type: 'tab', focus: false });
    await this.switchTo(r.handle);
    return r.handle;
  }

  /** @returns {Promise<string>} */
  async url() {
    return (await this.m.send('WebDriver:GetCurrentURL')).value;
  }

  /** @param {string} url */
  async goto(url) {
    await this.m.send('WebDriver:Navigate', { url });
  }

  /** 在页面里同步执行（函数体写成字符串，参数经 arguments 传入） @param {string} body @param {unknown[]} [args] */
  async exec(body, args = []) {
    return (await this.m.send('WebDriver:ExecuteScript', { script: body, args })).value;
  }

  /** 在页面里执行一个异步函数：body 里可以 await，return 的值传回来 @param {string} body @param {unknown[]} [args] */
  async run(body, args = []) {
    const script = `const __done = arguments[arguments.length - 1]; const __args = Array.from(arguments).slice(0, -1);
      (async (...args) => { ${body} })(...__args).then((v) => __done({ ok: true, v }), (e) => __done({ ok: false, e: String(e && e.stack || e) }));`;
    const r = (await this.m.send('WebDriver:ExecuteAsyncScript', { script, args })).value;
    if (!r?.ok) throw new Error(`页面脚本出错：${r?.e}`);
    return r.v;
  }

  /** 等页面里的条件成立（body 是返回真假的表达式或函数体） @param {string} body @param {{ timeout?: number; args?: unknown[]; what?: string }} [o] */
  async waitFor(body, o = {}) {
    const end = Date.now() + (o.timeout ?? 15_000);
    let last;
    for (;;) {
      try {
        last = await this.exec(body.includes('return') ? body : `return (${body});`, o.args ?? []);
        if (last) return last;
      } catch (e) {
        last = e;
      }
      if (Date.now() > end) throw new Error(`等不到：${o.what ?? body}（最后一次：${last instanceof Error ? last.message : JSON.stringify(last)}）`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** 真的点一下（Firefox 产生可信的点击，带用户操作标记）。元素要在可见区域里，必要时先滚过去 @param {string} css */
  async click(css) {
    const el = await this.m.send('WebDriver:FindElement', { using: 'css selector', value: css });
    await this.m.send('WebDriver:ElementClick', { id: el.value?.[ELEMENT] ?? el[ELEMENT] ?? el.value });
  }

  /** 往输入框里打字（逐键输入，页面收到 input 事件） @param {string} css @param {string} text */
  async type(css, text) {
    const el = await this.m.send('WebDriver:FindElement', { using: 'css selector', value: css });
    const id = el.value?.[ELEMENT] ?? el[ELEMENT] ?? el.value;
    await this.m.send('WebDriver:ElementClear', { id });
    await this.m.send('WebDriver:ElementSendKeys', { id, text });
  }

  /** 页面截图存成 PNG @param {string} path */
  async screenshot(path) {
    const r = await this.m.send('WebDriver:TakeScreenshot', { full: true });
    writeFileSync(path, Buffer.from(r.value, 'base64'));
  }

  /** 在浏览器自身的界面上真的点一下（工具栏按钮之类），带用户操作标记 @param {string} css */
  async chromeClick(css) {
    await this.m.send('Marionette:SetContext', { value: 'chrome' });
    try {
      const el = await this.m.send('WebDriver:FindElement', { using: 'css selector', value: css });
      await this.m.send('WebDriver:ElementClick', { id: el.value?.[ELEMENT] ?? el[ELEMENT] ?? el.value });
    } finally {
      await this.m.send('Marionette:SetContext', { value: 'content' });
    }
  }

  /** 在浏览器自身（chrome 特权环境）里执行 @param {string} body @param {unknown[]} [args] */
  async chrome(body, args = []) {
    await this.m.send('Marionette:SetContext', { value: 'chrome' });
    try {
      return await this.exec(body, args);
    } finally {
      await this.m.send('Marionette:SetContext', { value: 'content' });
    }
  }
}
