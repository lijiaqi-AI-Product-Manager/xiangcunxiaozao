import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * 端到端验收：真起三个服务（独立的测试数据库、独立端口，不碰开发数据），
 * 用真浏览器走一遍点单闭环，每一步截图存进 docs/screenshots/（25号：P2 起硬要求）。
 */
const root = resolve(import.meta.dirname, '..');

// 每次验收都从空的测试数据库开始（取餐号从 001 起）。
// 只在主进程、服务启动之前清理一次；测试进程也会加载本文件，那时不能删。
if (!process.env.TEST_WORKER_INDEX) {
  for (const f of ['e2e.db', 'e2e.db-wal', 'e2e.db-shm']) rmSync(resolve(root, 'data', f), { force: true });
}

const env = {
  DB_PATH: './data/e2e.db',
  BACKUP_DIR: './data/e2e-backups',
  UPLOAD_DIR: './data/e2e-uploads',
  API_PORT: '8788',
  ADMIN_PASSWORD: 'e2e-test-password', // 仅用于自动测试的一次性数据库
};

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  // 失败时留下操作录像（test-results/，不进 git），偶发失败也能事后复盘
  use: { locale: 'zh-CN', timezoneId: 'Asia/Kuala_Lumpur', trace: 'retain-on-failure' },
  webServer: [
    { command: 'npx tsx --env-file=.env apps/server/src/main.ts', cwd: root, port: 8788, env, reuseExistingServer: false },
    { command: 'npx vite --port 5183 --strictPort', cwd: resolve(root, 'apps/customer'), port: 5183, env, reuseExistingServer: false },
    { command: 'npx vite --port 5184 --strictPort', cwd: resolve(root, 'apps/admin'), port: 5184, env, reuseExistingServer: false },
  ],
});
