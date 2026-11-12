// CI 把 e2e 分成几组并行跑（DECISIONS §61）。分组表在 tests/e2e/shards.json，CI 的 matrix 是另外手写的一份：
// 两边对不上时，漏掉的那一组在 CI 上不会跑，也不会报错。这里守着这件事，以及"每一部分恰好属于一组"。
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import shards from '../e2e/shards.json';

const root = new URL('../../', import.meta.url);
const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
const parts = readdirSync(new URL('tests/e2e/parts/', root))
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => f.replace(/\.mjs$/, ''))
  .sort();
const groups: Record<string, string[]> = shards;

describe('e2e 分组与 CI 一致', () => {
  it('CI 的 matrix 列出了 shards.json 里的每一组，不多不少', () => {
    const matrix = /^\s*shard:\s*\[([^\]]*)\]\s*$/m.exec(ci)?.[1]?.split(',').map((s) => s.trim());
    expect(matrix).toEqual(Object.keys(groups));
  });

  it('CI 的每个 e2e job 只跑自己那一组', () => {
    expect(ci).toContain('node tests/e2e/run-e2e.mjs --shard=${{ matrix.shard }}');
  });

  it('parts/ 下的每一部分恰好属于一组：不漏跑，也不重复跑', () => {
    expect(Object.values(groups).flat().sort()).toEqual(parts);
  });

  it('settings 排在所在那一组的最后，而且前面还有别的部分', () => {
    const group = Object.values(groups).find((g) => g.includes('settings'));
    // 它会重启浏览器，之后这一组的页面都关了
    expect(group?.at(-1)).toBe('settings');
    // 它比较的是"点之前存储里的设置"：全新的浏览器里设置还没写进过存储，第一个勾选框会报"复原不了"
    expect(group?.length).toBeGreaterThan(1);
  });

  it('verify 仍是汇总结果的那个 job，前面的 job 失败或取消时也会跑', () => {
    const verify = ci.slice(ci.indexOf('\n  verify:'));
    expect(verify).toMatch(/needs: \[gate, checks, e2e, firefox\]/);
    expect(verify).toMatch(/if: \$\{\{ always\(\) \}\}/);
  });

  it('Firefox 版（DECISIONS §69）：有自己的 job 跑 npm run e2e:firefox，verify 要它也通过才算过', () => {
    const job = ci.slice(ci.indexOf('\n  firefox:'), ci.indexOf('\n  verify:'));
    expect(job).toContain('run: npm run e2e:firefox');
    const verify = ci.slice(ci.indexOf('\n  verify:'));
    expect(verify).toContain('[ "$FIREFOX" = "success" ]');
    expect(verify).toContain("needs.firefox.result == 'success'");
  });
});
