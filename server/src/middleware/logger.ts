import type { NextFunction, Request, Response } from 'express';
import { klNowLabel } from '../utils/time.js';

/** 结构化请求日志：Zeabur 控制台直接可读，也是事后对账排错的依据 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        kl: klNowLabel(),
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Date.now() - start,
        ip: req.ip,
      })
    );
  });
  next();
}
