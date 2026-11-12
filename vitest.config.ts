import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .mjs：测试构建 / 发布脚本（scripts/*.mjs）的单测，由 tsconfig.scripts.json 做类型检查
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.mjs'],
    environment: 'node',
    setupFiles: ['tests/unit/setup.ts'],
  },
});
