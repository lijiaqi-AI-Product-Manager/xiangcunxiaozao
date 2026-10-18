import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@pkg/contract': resolve(root, 'packages/contract/src/index.ts'),
      '@pkg/ui-kit': resolve(root, 'packages/ui-kit/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    env: loadEnv('', root, ''),
  },
});
