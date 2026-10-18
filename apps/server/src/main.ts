import { relative, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { scheduleBackups } from './backup.ts';
import { openDb } from './db.ts';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`缺少环境变量 ${k}（见根目录 .env）`);
  return v;
};

// .env 里的相对路径都以仓库根目录为准
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const db = openDb(resolve(repoRoot, need('DB_PATH')));
const { app, members } = createApp(db, resolve(repoRoot, 'brands', need('BRAND')), {
  adminPassword: need('ADMIN_PASSWORD'),
  uploadDir: resolve(repoRoot, process.env.UPLOAD_DIR ?? './data/uploads'),
});

// 每天对账：启动时检查一次，之后每小时检查一次——距上次对账满 20 小时就再对一次
const reconcileNightly = () => {
  const last = members.lastReconcile();
  const now = new Date();
  const hoursSince = last ? (now.getTime() - new Date(last.at).getTime()) / 3600000 : Infinity;
  if (hoursSince >= 20) {
    const run = members.reconcile();
    console.log(`对账完成：${run.checked} 位会员，${run.mismatches.length} 处不一致`);
  }
};
reconcileNightly();
setInterval(reconcileNightly, 3600000);
const port = Number(process.env.API_PORT ?? 8787);

// 正式部署（SERVE_STATIC=1）：同一个服务同时给出网页——/ 是顾客端，/admin/ 是老板端（都是构建好的静态文件）
if (process.env.SERVE_STATIC === '1') {
  const page = (dir: string, prefix: string) => serveStatic({
    root: relative(process.cwd(), resolve(repoRoot, dir)),
    rewriteRequestPath: (p) => p.slice(prefix.length) || '/',
  });
  app.get('/admin', (c) => c.redirect('/admin/'));
  app.use('/admin/*', page('apps/admin/dist', '/admin'));
  app.use('/*', page('apps/customer/dist', ''));
}

scheduleBackups(db, resolve(repoRoot, need('BACKUP_DIR')), Number(process.env.BACKUP_EVERY_MINUTES ?? 10), (m) => console.log(m));
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => console.log(`后端已启动：http://127.0.0.1:${port}`));
