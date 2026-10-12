import { Router } from 'express';

export const VERSION = '0.1.0';

/** 健康检查：Zeabur/监控探活用，同时顺带验证数据库真的能响应 */
export default function healthRoutes(): Router {
  const r = Router();
  const startedAt = Date.now();

  r.get('/healthz', (req, res) => {
    const db = (req.app as unknown as { locals: { dbCheck?: () => boolean } }).locals?.dbCheck;
    res.json({
      ok: true,
      service: 'xiangcunxiaozao',
      version: VERSION,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      db: typeof db === 'function' && db() ? 'up' : 'unknown',
      now: new Date().toISOString(),
    });
  });

  return r;
}
