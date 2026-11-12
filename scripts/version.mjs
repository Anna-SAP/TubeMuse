// @ts-check
// 扩展的版本号（DECISIONS §70）：构建脚本、打包脚本、发布工作流共用。

/**
 * Chrome 与 Firefox 都接受的 manifest 版本号：1–4 段用点隔开的整数，每段 0–65535，不带前导 0。
 * @param {string} v
 */
export function isManifestVersion(v) {
  const parts = v.split('.');
  return parts.length <= 4 && parts.every((p) => /^(0|[1-9]\d{0,4})$/.test(p) && Number(p) <= 65535);
}

/**
 * 发布用的版本号：package.json 的版本（三段）后面接一段构建号（main 上的提交数，只增不减），
 * 例如 0.1.0 + 137 → 0.1.0.137。Chrome 只肯用更高的版本覆盖已装的 .crx，所以每次发布都必须比上一次高。
 * @param {string} base package.json 的 version
 * @param {number} build 构建号
 */
export function releaseVersion(base, build) {
  if (!/^\d+\.\d+\.\d+$/.test(base)) throw new Error(`package.json 的版本号 ${base} 要是三段（例如 0.1.0），发布时第四段留给构建号`);
  if (!Number.isInteger(build) || build < 1) throw new Error(`构建号 ${build} 要是正整数`);
  const v = `${base}.${build}`;
  if (!isManifestVersion(v)) throw new Error(`发布版本号 ${v} 不能用作扩展版本（每段 0–65535，不带前导 0）`);
  return v;
}
