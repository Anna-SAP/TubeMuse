// @ts-check
// 生成固定扩展 ID 所需的密钥对，并初始化本地私有配置。
// 公钥写入 manifest 的 "key" 字段，从而让"加载已解压的扩展程序"得到稳定的扩展 ID，
// 这是授权回跳地址 https://<扩展ID>.chromiumapp.org/ 固定不变、能登记到 Google OAuth 客户端的前提。
// 产物全部位于 local/（已被 .gitignore 排除）。已存在时不会覆盖，避免扩展 ID 意外改变。
import { generateKeyPairSync, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const localDir = join(root, 'local');
const pubPath = join(localDir, 'manifest-key.txt');
const privPath = join(localDir, 'extension-key.pem');
const configPath = join(localDir, 'config.json');

/** @param {string} publicKeyB64 */
export function extensionIdFromPublicKey(publicKeyB64) {
  const der = Buffer.from(publicKeyB64, 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  // Chrome 把十六进制的 0-f 映射成字母 a-p
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

/** @param {string} id */
function printIds(id) {
  console.log(`扩展 ID：${id}`);
  console.log(`授权回跳地址：https://${id}.chromiumapp.org/（Google Cloud 里"Web 应用"客户端的"已获授权的重定向 URI"填这个）`);
}

function main() {
  mkdirSync(localDir, { recursive: true });
  if (existsSync(pubPath)) {
    const pub = readFileSync(pubPath, 'utf8').trim();
    console.log('密钥已存在，未重新生成（重新生成会改变扩展 ID，导致 OAuth 客户端失效）。');
    printIds(extensionIdFromPublicKey(pub));
  } else {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });
    const pubB64 = Buffer.from(pubDer).toString('base64');
    writeFileSync(pubPath, pubB64 + '\n');
    writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    console.log('已生成扩展密钥（local/manifest-key.txt、local/extension-key.pem）。');
    printIds(extensionIdFromPublicKey(pubB64));
  }
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({ oauthClientId: '' }, null, 2) + '\n');
    console.log('已创建 local/config.json —— 在 Google Cloud 建好 OAuth 客户端后，把 Client ID 填进 oauthClientId，再运行 npm run build。');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
