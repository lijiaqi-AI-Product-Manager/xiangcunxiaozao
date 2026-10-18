import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DB } from './db.ts';
import { HttpError, type Clock } from './support.ts';

const MAX_FAILS = 5; // 24号 #4：连错 5 次
const LOCK_MINUTES = 15; // 锁 15 分钟
const SESSION_HOURS = 12;

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/**
 * 密码错误计数与锁定。这是账户安全，不属于「下单防御机制」禁令的范围（24号 #4 裁定）。
 * scope 例：admin:<IP>、member:<会员号>
 */
export class LockoutGuard {
  constructor(private db: DB, private clock: Clock) {}

  assertNotLocked(scope: string) {
    const r = this.db.prepare('SELECT locked_until FROM login_attempts WHERE scope = ?').get(scope) as { locked_until: string | null } | undefined;
    if (r?.locked_until && new Date(r.locked_until) > this.clock()) {
      const mins = Math.ceil((new Date(r.locked_until).getTime() - this.clock().getTime()) / 60000);
      throw new HttpError(423, `密码错误次数过多，已锁定，请 ${mins} 分钟后再试`);
    }
  }

  /** 记一次失败；返回还剩几次机会（0 表示刚被锁定） */
  fail(scope: string): number {
    const r = this.db.prepare('SELECT failed, locked_until FROM login_attempts WHERE scope = ?').get(scope) as { failed: number; locked_until: string | null } | undefined;
    const expired = r?.locked_until && new Date(r.locked_until) <= this.clock();
    const failed = (expired ? 0 : r?.failed ?? 0) + 1;
    const lockedUntil = failed >= MAX_FAILS ? new Date(this.clock().getTime() + LOCK_MINUTES * 60000).toISOString() : null;
    this.db.prepare(`INSERT INTO login_attempts (scope, failed, locked_until) VALUES (?, ?, ?)
                     ON CONFLICT (scope) DO UPDATE SET failed = excluded.failed, locked_until = excluded.locked_until`)
      .run(scope, lockedUntil ? 0 : failed, lockedUntil);
    return lockedUntil ? 0 : MAX_FAILS - failed;
  }

  reset(scope: string) {
    this.db.prepare('DELETE FROM login_attempts WHERE scope = ?').run(scope);
  }
}

export class AdminAuth {
  private passwordDigest: Buffer;

  constructor(private db: DB, password: string, private guard: LockoutGuard, private clock: Clock) {
    if (password.length < 8) throw new Error('ADMIN_PASSWORD 至少 8 位（见根目录 .env）');
    this.passwordDigest = sha256(password);
  }

  login(password: unknown, scope: string): string {
    this.guard.assertNotLocked(scope);
    const ok = typeof password === 'string' && timingSafeEqual(sha256(password), this.passwordDigest);
    if (!ok) {
      const left = this.guard.fail(scope);
      throw new HttpError(left === 0 ? 423 : 401, left === 0 ? `密码错误次数过多，已锁定 ${LOCK_MINUTES} 分钟` : `密码不对，还可以再试 ${left} 次`);
    }
    this.guard.reset(scope);
    const token = randomBytes(32).toString('base64url');
    const now = this.clock();
    this.db.prepare('INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token).toString('hex'), now.toISOString(), new Date(now.getTime() + SESSION_HOURS * 3600000).toISOString());
    return token;
  }

  verify(token: string | null | undefined): boolean {
    if (!token) return false;
    const r = this.db.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?').get(sha256(token).toString('hex')) as { expires_at: string } | undefined;
    return Boolean(r && new Date(r.expires_at) > this.clock());
  }

  logout(token: string | null | undefined) {
    if (token) this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token).toString('hex'));
  }
}
