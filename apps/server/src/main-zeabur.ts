/**
 * Zeabur 部署入口（新增文件；Claude 版 main.ts 保持原样不动，本地开发仍用它）。
 * 与 main.ts 的差别只有四件事，全部是「两套系统的接线」：
 *   1. ADMIN_TOKEN（老系统的环境变量名）兜底为 ADMIN_PASSWORD——不改 Zeabur 面板就能登录老板端
 *   2. 启动时执行老系统数据迁移：LEGACY_DB_PATH 指向老库（/data/xcz.db）时搬会员/订单/菜品层，幂等可重跑
 *   3. 旧网址兼容：/t/12（桌上已印的二维码）→ /?table=12；/admin.html、/kitchen.html（老板收藏夹）→ /admin/
 *   4. SPA 兜底：静态文件没接住的 GET 一律回顾客端首页
 * 其余逻辑（建库、对账、静态服务、备份）与 main.ts 完全一致。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { scheduleBackups } from './backup.ts';
import { openDb } from './db.ts';
import { migrateLegacy } from './migrate-legacy.ts';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`缺少环境变量 ${k}（见根目录 .env）`);
  return v;
};

// 老系统环境变量兜底：Zeabur 面板配的是 ADMIN_TOKEN
if (!process.env.ADMIN_PASSWORD && process.env.ADMIN_TOKEN) {
  process.env.ADMIN_PASSWORD = process.env.ADMIN_TOKEN;
  console.log('已用老系统的 ADMIN_TOKEN 作为老板端密码（ADMIN_PASSWORD 未单独设置）');
}

// .env 里的相对路径都以仓库根目录为准
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const brandDir = resolve(repoRoot, 'brands', need('BRAND'));
const uploadDir = resolve(repoRoot, process.env.UPLOAD_DIR ?? './data/uploads');
const db = openDb(resolve(repoRoot, need('DB_PATH')));

// ---------- 老系统数据迁移（幂等：跑过一次即跳过） ----------
const legacyDbPath = process.env.LEGACY_DB_PATH;
if (legacyDbPath && existsSync(legacyDbPath)) {
  const brand = JSON.parse(readFileSync(join(brandDir, 'brand.json'), 'utf8')) as { timezone: string };
  const r = migrateLegacy(db, { legacyDbPath, uploadsDir: uploadDir, brandDir, timeZone: brand.timezone });
  console.log(
    `[老系统迁移] 会员 ${r.members} 位（流水 ${r.ledgerEntries} 条，链断退化为余额入账 ${r.chainBrokenMembers} 位）` +
    `｜订单 ${r.orders} 单 ${r.orderItems} 行｜菜品图 ${r.photosCopied} 张｜改价沿用 ${r.priceOverrides.length} 道` +
    `｜下架 ${r.unlisted.length} 道｜未匹配菜品 ${r.unmatchedLegacyDishes.length} 道`,
  );
  for (const n of r.notes) console.log(`[老系统迁移] ${n}`);
} else {
  console.log('[老系统迁移] 未发现老库（LEGACY_DB_PATH 未设置或文件不存在），跳过');
}

const { app, members } = createApp(db, brandDir, { adminPassword: need('ADMIN_PASSWORD'), uploadDir });

// ---------- 旧网址兼容（桌上二维码 / 老板收藏夹） ----------
app.get('/t/:table', (c) => c.redirect(`/?table=${c.req.param('table')}`, 302));
app.get('/admin.html', (c) => c.redirect('/admin/', 302));
app.get('/kitchen.html', (c) => c.redirect('/admin/', 302));

// 每天对账：启动时检查一次，之后每小时检查一次——距上次对账满 20 小时就再对一次
const reconcileNightly = () => {
  const run = members.reconcile();
  if (run.mismatches.length) {
    console.error(`对账发现不一致：${run.mismatches.length} 处，请到老板端「会员管理」核对`);
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
  app.get('/admin', (c) => c.redirect('/admin/', 302));
  app.use('/admin/*', page('apps/admin/dist', '/admin'));
  app.use('/*', page('apps/customer/dist', ''));
  // SPA 兜底：静态文件没接住的 GET 一律回顾客端首页（老系统就是这个行为）
  const indexHtml = readFileSync(resolve(repoRoot, 'apps/customer/dist/index.html'));
  app.get('*', (c) => new Response(indexHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
}

scheduleBackups(db, resolve(repoRoot, need('BACKUP_DIR')), Number(process.env.BACKUP_EVERY_MINUTES ?? 10), (m) => console.log(m));
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => console.log(`后端已启动：http://127.0.0.1:${port}`));
