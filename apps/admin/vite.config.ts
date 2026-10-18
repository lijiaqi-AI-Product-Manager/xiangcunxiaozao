import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, mergeConfig } from 'vite';
import { brandPlugin, sharedConfig } from '../../packages/ui-kit/src/vite-brand.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..');

export default mergeConfig(sharedConfig(repoRoot), defineConfig({
  // 正式部署时老板端挂在 /admin/ 下（和顾客端同一个域名）；开发和测试仍在根路径
  base: process.env.ADMIN_BASE ?? '/',
  plugins: [react(), brandPlugin(repoRoot, 'admin', '经营后台')],
}));
