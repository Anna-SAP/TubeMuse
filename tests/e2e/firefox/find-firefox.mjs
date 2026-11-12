// @ts-check
// 找一个 Firefox 来跑 Firefox 的 e2e：环境变量 FIREFOX_BIN 优先，其次是常见安装位置（CI 把 Firefox 解压在 .cache/firefox/）。
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** @param {string} root 仓库根目录 @returns {string | undefined} */
export function findFirefox(root) {
  const env = process.env.FIREFOX_BIN;
  if (env) return existsSync(env) ? env : undefined;
  const candidates =
    process.platform === 'win32'
      ? ['C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'C:\\Program Files\\Firefox Beta\\firefox.exe', 'C:\\Program Files\\Firefox Developer Edition\\firefox.exe', 'C:\\Program Files\\Firefox Nightly\\firefox.exe']
      : process.platform === 'darwin'
        ? ['/Applications/Firefox.app/Contents/MacOS/firefox', '/Applications/Firefox Beta.app/Contents/MacOS/firefox', '/Applications/Firefox Nightly.app/Contents/MacOS/firefox']
        : [join(root, '.cache', 'firefox', 'firefox', 'firefox'), '/usr/bin/firefox', '/usr/local/bin/firefox'];
  return candidates.find((p) => existsSync(p));
}
