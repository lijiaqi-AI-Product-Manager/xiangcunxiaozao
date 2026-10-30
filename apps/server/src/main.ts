/**
 * 唯一启动入口（本地开发和正式部署共用）。
 *
 * 以前有两个入口：main.ts（本地）和 main-zeabur.ts（线上）。两份代码对账频率不一样、线上多跑老数据迁移，
 * 导致「本地测不出线上的问题」。现在合并成一个，用环境变量控制差异：
 *   LEGACY_DB_PATH      指向老库时执行老数据迁移（幂等，跑过即跳过）
 *   SERVE_STATIC=1      同一个服务同时给出网页（/ 顾客端，/admin/ 老板端）
 *   ADMIN_TOKEN         老系统的环境变量名，没设 ADMIN_PASSWORD 时自动兜底
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { sweepCarts } from './auth.ts';
import { scheduleBackups } from './backup.ts';
import { openDb } from './db.ts';
import { migrateLegacy } from './migrate-legacy.ts';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`缺少环境变量 ${k}（见根目录 .env）`);
  return v;
};

// 老系统环境变量兜底：Zeabur 面板上配的叫 ADMIN_TOKEN
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
try {
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
} catch (e: unknown) {
  // 迁移失败不能拦住开店：老库可能本身有问题，但新库是好的，照常营业
  console.error('[老系统迁移] 失败，已跳过，服务继续启动：', e instanceof Error ? e.message : e);
}

const { app, members, auth } = createApp(db, brandDir, { adminPassword: need('ADMIN_PASSWORD'), uploadDir });

// ---------- 旧网址兼容（桌上已印的二维码 / 老板收藏夹） ----------
app.get('/t/:table', (c) => c.redirect(`/?table=${c.req.param('table')}`, 302));
app.get('/admin.html', (c) => c.redirect('/admin/', 302));
app.get('/kitchen.html', (c) => c.redirect('/admin/', 302));

// ---------- 每天对账：启动时检查一次，之后每小时检查一次，距上次满 20 小时才真跑 ----------
// 对账要扫全部会员和全部流水，是同步 SQLite 操作。以前线上版每个小时无条件跑一遍，
// 会员多了会明显卡顿；而且没有 try/catch，抛异常会把整个进程带走、全店点不了单。
const reconcileNightly = () => {
  try {
    const last = members.lastReconcile();
    const now = new Date();
    const hoursSince = last ? (now.getTime() - new Date(last.at).getTime()) / 3600000 : Infinity;
    if (hoursSince < 20) return;
    const run = members.reconcile();
    if (run.mismatches.length) {
      console.error(`对账发现不一致：${run.mismatches.length} 处，请到老板端「会员管理」核对`);
      console.error(`不一致会员：${run.mismatches.map((m) => m.memberNo).join('、')}`);
    } else {
      console.log(`对账完成：${run.checked} 位会员，全部一致`);
    }
  } catch (e: unknown) {
    console.error('[对账] 执行失败，本轮跳过：', e instanceof Error ? e.message : e);
  }
};
reconcileNightly();
setInterval(reconcileNightly, 3600000);

// ---------- 每天打扫一次数据库（P1-8） ----------
// 过期登录会话、早就没锁的失败计数、用完的一次性推送票、空购物车——
// 这些表从来没人清，跑一年就是几万行。清的全是「确定已经没用」的行，
// 有菜的购物车一行都不动（顾客回来菜还在）。
// 独立 try/catch：打扫失败绝不能影响营业。
const sweepDaily = () => {
  try {
    const r = auth.sweep();
    const carts = sweepCarts(db, () => new Date());
    const total = r.sessions + r.attempts + r.tickets + carts;
    if (total > 0) console.log(`日常清理：会话 ${r.sessions} / 登录记录 ${r.attempts} / 推送票 ${r.tickets} / 空车 ${carts}`);
  } catch (e: unknown) {
    console.error('[清理] 执行失败，本轮跳过：', e instanceof Error ? e.message : e);
  }
};
sweepDaily();
setInterval(sweepDaily, 24 * 3600000);

const port = Number(process.env.API_PORT ?? 8787);

// 未知的 /api/* 一律 JSON 404：开启静态托管后，下面的 SPA 兜底会把不存在的接口也回成 HTML，
// 前端 fetch 拿到 200 的网页再去 res.json()，错误会变得很难查。
app.all('/api/*', (c) => c.json({ error: 'not_found', message: '接口不存在' }, 404));

// ---------- 静态文件（SERVE_STATIC=1 时） ----------
if (process.env.SERVE_STATIC === '1') {
  const page = (dir: string, prefix: string) => serveStatic({
    root: relative(process.cwd(), resolve(repoRoot, dir)),
    rewriteRequestPath: (p) => p.slice(prefix.length) || '/',
  });
  app.get('/admin', (c) => c.redirect('/admin/'));
  app.use('/admin/*', page('apps/admin/dist', '/admin'));
  app.use('/*', page('apps/customer/dist', ''));
  // SPA 兜底：静态文件没接住的 GET 一律回顾客端首页（老系统就是这个行为，桌上旧二维码才不会 404）
  const indexPath = resolve(repoRoot, 'apps/customer/dist/index.html');
  if (existsSync(indexPath)) {
    const indexHtml = readFileSync(indexPath);
    app.get('*', (c) => new Response(indexHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  }
}

// 备份保留策略按门店时区分日：用 UTC 分日的话，吉隆坡凌晨 0~8 点的快照会被归到「昨天」
const brandTz = (JSON.parse(readFileSync(join(brandDir, 'brand.json'), 'utf8')) as { timezone: string }).timezone;
const backupTimer = scheduleBackups(db, resolve(repoRoot, need('BACKUP_DIR')), Number(process.env.BACKUP_EVERY_MINUTES ?? 10), (m) => console.log(m), brandTz);

const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => console.log(`后端已启动：http://127.0.0.1:${port}`));

// ---------- 进程兜底 ----------
// 未处理的 Promise 错误：记录，但不退出——营业中因为一个上传失败就整店停单不值得。
process.on('unhandledRejection', (e) => {
  console.error('[未处理的 Promise 错误]', e);
});

let closing = false;
function shutdown(reason: string) {
  if (closing) return;
  closing = true;
  console.log(`[退出] 收到 ${reason}，正在安全关闭…`);
  clearInterval(backupTimer);
  try { server.close(); } catch { /* 已经关了 */ }
  // 关库前把 WAL 刷回主库，避免容器被强杀后留下未合并的 WAL
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* 尽力而为 */ }
  try { db.close(); } catch { /* 已经关了 */ }
  setTimeout(() => process.exit(0), 500);
}

// 未捕获异常：进程状态可能已经不可靠，记录后优雅关闭，交给 Docker / 进程管理器重启。
process.on('uncaughtException', (e) => {
  console.error('[未捕获异常] 即将关闭进程，由守护进程重启', e);
  shutdown('uncaughtException');
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => shutdown(sig));
}
