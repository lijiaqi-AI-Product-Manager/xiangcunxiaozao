import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function bearer(req: Request): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

export interface Auth {
  admin: (req: Request, res: Response, next: NextFunction) => void;
  kitchen: (req: Request, res: Response, next: NextFunction) => void;
  any: (req: Request, res: Response, next: NextFunction) => void;
}

/** 令牌鉴权工厂：admin=老板后台，kitchen=后厨页（支持 ?token= 方便平板收藏夹直开） */
export function makeAuth(adminToken: string, kitchenToken: string): Auth {
  const okAdmin = (req: Request) => {
    const t = bearer(req);
    return t.length > 0 && safeEqual(t, adminToken);
  };
  const okKitchen = (req: Request) => {
    const t = bearer(req) || String(req.query.token ?? '');
    return t.length > 0 && safeEqual(t, kitchenToken);
  };
  return {
    admin(req, res, next) {
      if (!okAdmin(req)) {
        res.status(401).json({ error: '管理员令牌错误' });
        return;
      }
      next();
    },
    kitchen(req, res, next) {
      if (!okKitchen(req)) {
        res.status(401).json({ error: '后厨令牌错误' });
        return;
      }
      next();
    },
    any(req, res, next) {
      if (!okAdmin(req) && !okKitchen(req)) {
        res.status(401).json({ error: '令牌错误' });
        return;
      }
      next();
    },
  };
}
