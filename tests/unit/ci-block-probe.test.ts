import { expect, it } from 'vitest';

// 临时探针：确认 verify 失败时 main 拒绝合并。这个文件不进 main，PR 关闭时随分支删除。
it('故意失败，确认 CI 红时合并被挡住', () => {
  expect(1).toBe(2);
});
