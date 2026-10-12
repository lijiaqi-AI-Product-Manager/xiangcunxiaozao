import fs from 'node:fs';
import express from 'express';
import type { Express } from 'express';
import type { AppDeps } from './types.js';
import { requestLogger } from './middleware/logger.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import dishesRoutes from './routes/dishes.js';
import ordersRoutes from './routes/orders.js';
import reportsRoutes from './routes/reports.js';
import healthRoutes, { VERSION } from './routes/health.js';

/**
 * 组装 Express 应用（依赖全部注入，测试可直接构造）。
 * 端口监听、备份调度、优雅退出在 index.ts。
 */
export function buildApp(deps: AppDeps): Express {
  const app = express();
  const webDir = process.env.WEB_DIR ?? 'web';

  app.set('trust proxy', 1); // Zeabur 反代后面拿真实 IP
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(requestLogger);

  // 限流：全局兜底 + 下单单独收紧
  const globalRL = createRateLimiter({ windowMs: 60_000, max: deps.limits?.globalPerMin ?? 300 });
  const orderRL = createRateLimiter({ windowMs: 60_000, max: deps.limits?.orderPerMin ?? 20 });
  app.use('/api', globalRL);

  app.use('/api/dishes', dishesRoutes(deps));
  app.use('/api/orders', orderRL, ordersRoutes(deps));
  app.use('/api/reports', reportsRoutes(deps));
  app.use('/', healthRoutes());

  // 顺带让 /healthz 能真查数据库
  app.locals.dbCheck = () => {
    try {
      deps.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  };

  // 前端静态资源（顾客点单页 / 后厨页 / 老板后台，D3 起陆续入驻 web/）
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir, { maxAge: '1h', extensions: ['html'], index: 'index.html' }));
    // SPA 兜底：非 /api 非 /healthz 的 GET 都回首页（二维码路由 /t/12 等用）
    app.get(/^(?!\/api|\/healthz).*/, (_req, res) => {
      res.sendFile(`${webDir}/index.html`);
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export { VERSION };
