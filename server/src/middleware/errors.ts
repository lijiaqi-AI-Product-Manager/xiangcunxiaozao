import type { NextFunction, Request, Response } from 'express';

/** 业务异常：带 HTTP 状态码，错误信息可直接给用户看 */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: '接口不存在' });
}

/** 兜底错误处理：业务异常透传，未知异常只报“服务器开小差”，不泄露内部细节 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('[UNCAUGHT]', err);
  res.status(500).json({ error: '服务器开小差了，请稍后再试' });
}
