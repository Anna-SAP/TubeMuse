// @ts-check
// 发布工作流用（DECISIONS §70）：把仓库 Secret CRX_PRIVATE_KEY（你电脑上 local/extension-key.pem 的全文）写成构建要的两个文件：
//   local/extension-key.pem  给 .crx 签名
//   local/manifest-key.txt   公钥，写进 manifest 的 key，固定扩展 ID
// 两个文件来自同一把私钥，所以 .crx 和 .zip 装上后的扩展 ID 一样，也就是你本机 npm run setup 得到的那个，
// Google Cloud 里登记的授权回跳地址 https://<扩展ID>.chromiumapp.org/ 照样能用。
// 私钥的内容不打印、不写进别的地方；文件只在这台 runner 上，job 结束就没了。
import { createPrivateKey } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestKeyOf } from './crx.mjs';
import { extensionIdFromPublicKey } from './gen-key.mjs';

export const SECRET_NAME = 'CRX_PRIVATE_KEY';

/**
 * 校验 Secret 的内容，换成两个文件要写的东西。内容不对时抛错，说明哪里不对（不回显内容）。
 * @param {string | undefined} raw
 * @returns {{ pem: string; manifestKey: string; extensionId: string }}
 */
export function signingKeyFromSecret(raw) {
  // 从 Windows 上复制的会带 \r\n；前后多出来的空行无所谓
  const text = (raw ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) {
    throw new Error(
      `仓库还没有配置 Secret ${SECRET_NAME}：没有它就签不出扩展 ID 和你本机一样的 .crx / .zip。` +
        `到 GitHub 仓库 Settings → Secrets and variables → Actions → New repository secret，名字填 ${SECRET_NAME}，` +
        '值粘贴你电脑上 TubeMuse 文件夹里 local/extension-key.pem 的全文（从 -----BEGIN PRIVATE KEY----- 到 -----END PRIVATE KEY-----）。',
    );
  }
  if (!text.includes('-----BEGIN')) {
    const looksPublic = /^[A-Za-z0-9+/=\s]+$/.test(text) && text.replace(/\s/g, '').startsWith('MII');
    throw new Error(
      looksPublic
        ? `Secret ${SECRET_NAME} 里像是公钥（local/manifest-key.txt 的内容）。要填的是私钥：local/extension-key.pem 的全文，以 -----BEGIN PRIVATE KEY----- 开头。`
        : `Secret ${SECRET_NAME} 不是 PEM 格式的私钥：要粘贴 local/extension-key.pem 的全文，以 -----BEGIN PRIVATE KEY----- 开头、-----END PRIVATE KEY----- 结尾。`,
    );
  }
  if (/BEGIN (?:RSA )?PUBLIC KEY/.test(text)) throw new Error(`Secret ${SECRET_NAME} 里是公钥，要填的是私钥 local/extension-key.pem。`);
  let key;
  try {
    key = createPrivateKey(text);
  } catch {
    throw new Error(`Secret ${SECRET_NAME} 读不出私钥（内容可能复制得不完整）：重新复制 local/extension-key.pem 的全文再保存一次。`);
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error(`Secret ${SECRET_NAME} 里是 ${key.asymmetricKeyType} 私钥，Chrome 扩展要的是 RSA 私钥（npm run setup 生成的就是）。`);
  const pem = /** @type {string} */ (key.export({ type: 'pkcs8', format: 'pem' }));
  const manifestKey = manifestKeyOf(pem);
  return { pem, manifestKey, extensionId: extensionIdFromPublicKey(manifestKey) };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pemPath = join(root, 'local', 'extension-key.pem');
  const pubPath = join(root, 'local', 'manifest-key.txt');
  let key;
  try {
    key = signingKeyFromSecret(process.env[SECRET_NAME]);
  } catch (e) {
    const msg = /** @type {Error} */ (e).message;
    console.error(`::error::${msg}`);
    // 运行摘要里也写一份：在 Actions 页面点开这次运行第一眼就能看到要做什么
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 没有发布：签名密钥没有准备好\n\n${msg}\n\n配好以后，在 Actions → Release 里点 **Run workflow**（分支选 main）发布当前的 main，或者对这次失败的运行点 **Re-run jobs**。\n`);
    process.exit(1);
  }
  // 本机上误跑时不覆盖已有的密钥（覆盖会改变扩展 ID）
  if (existsSync(pubPath) && readFileSync(pubPath, 'utf8').trim() !== key.manifestKey) {
    console.error(`::error::local/manifest-key.txt 已经存在，而且和 Secret ${SECRET_NAME} 不是同一把密钥：不覆盖。这个脚本只给发布工作流用。`);
    process.exit(1);
  }
  mkdirSync(dirname(pemPath), { recursive: true });
  writeFileSync(pemPath, key.pem, { mode: 0o600 });
  writeFileSync(pubPath, key.manifestKey + '\n');
  console.log(`已从 Secret ${SECRET_NAME} 载入签名密钥。Chrome 扩展 ID：${key.extensionId}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
