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

  /**
   * 滑动续期（P1-6）。
   *
   * 原来令牌 12 小时硬过期，而且**过期就会被直接踢掉**——最惨的场景是老板晚上七点半
   * 正在录一个改单理由，屏幕「啪」一下变成登录页，刚打的字全没了。
   *
   * 现在：每次通过验证就顺手把到期时间往后推；只有当「已经过半」时才写库
   * （避免每个请求都写一次 admin_sessions）。也就是说只要还在用，就不会过期；
   * 真的放着不管超过 12 小时才需要重登。
   */
  verifyAndRefresh(token: string | null | undefined): boolean {
    if (!token) return false;
    const hash = sha256(token).toString('hex');
    const r = this.db.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?').get(hash) as { expires_at: string } | undefined;
    if (!r) return false;
    const now = this.clock();
    const exp = new Date(r.expires_at);
    if (exp <= now) {
      // 过期了就顺手删掉，别让表一直长
      this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hash);
      return false;
    }
    const half = SESSION_HOURS * 3600000 / 2;
    if (exp.getTime() - now.getTime() < half) {
      this.db.prepare('UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?')
        .run(new Date(now.getTime() + SESSION_HOURS * 3600000).toISOString(), hash);
    }
    return true;
  }

  /**
   * 一次性推送票据（P3-4）。
   *
   * EventSource 不能带请求头，令牌只能放 URL：`/api/admin/stream?token=xxx`。
   * 而 URL 会进浏览器历史、进反代日志、进老板随手截的图——等于令牌到处留痕。
   * 现在换成：用 header 里的令牌换一张 30 秒、只能用一次的 ticket，
   * 再用 ticket 连推送。日志里留下的是废票，拿到了也没用。
   */
  issueTicket(token: string | null | undefined): string {
    if (!this.verifyAndRefresh(token)) throw new HttpError(401, '请先登录老板端');
    const ticket = randomBytes(24).toString('base64url');
    const now = this.clock();
    this.db.prepare('INSERT INTO admin_tickets (ticket_hash, expires_at) VALUES (?, ?)')
      .run(sha256(ticket).toString('hex'), new Date(now.getTime() + 30_000).toISOString());
    return ticket;
  }

  /** 兑换票据：成功即焚 */
  redeemTicket(ticket: string | null | undefined): boolean {
    if (!ticket) return false;
    const hash = sha256(ticket).toString('hex');
    const r = this.db.prepare('SELECT expires_at FROM admin_tickets WHERE ticket_hash = ?').get(hash) as { expires_at: string } | undefined;
    if (!r) return false;
    this.db.prepare('DELETE FROM admin_tickets WHERE ticket_hash = ?').run(hash); // 一次性：先删再判
    return new Date(r.expires_at) > this.clock();
  }

  /**
   * 清理过期数据（P1-8）。三张表从来没人清，跑一年就是几万行垃圾：
   *   admin_sessions —— 已过期/已登出的令牌
   *   login_attempts —— 早就没锁的计数（留着只会让「还剩几次」算错）
   *   admin_tickets  —— 30 秒就死的一次性票
   * 由 main.ts 每天跑一次，跑挂在 try/catch 里，清不掉不影响营业。
   */
  sweep(): { sessions: number; attempts: number; tickets: number } {
    const now = this.clock().toISOString();
    const sessions = this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now).changes;
    // 没在锁定期、且失败计数是老的（1 小时前建的也算老），一并清掉
    const attempts = this.db.prepare(`DELETE FROM login_attempts
      WHERE (locked_until IS NULL OR locked_until <= ?)`).run(now).changes;
    const tickets = this.db.prepare('DELETE FROM admin_tickets WHERE expires_at <= ?').run(now).changes;
    return { sessions, attempts, tickets };
  }
}

/**
 * 购物车清理（P1-8）。
 *
 * 只清**空车**：下单后 cart_items 会被清空，但 carts 那行还留着，一年下来几千行。
 * 故意不按「多久没动」清有菜的车——顾客把菜加进车、转身接了个电话、
 * 十分钟后回来菜没了，这种「我的购物车自己清空」比表长一万行可怕得多。
 * 空车清掉没有任何副作用：顾客回来时新建一行，id 不变（前端 localStorage 存着）。
 */
export function sweepCarts(db: DB, clock: Clock): number {
  const cutoff = new Date(clock().getTime() - 24 * 3600000).toISOString();
  return db
    .prepare(`DELETE FROM carts WHERE updated_at <= ? AND NOT EXISTS (SELECT 1 FROM cart_items WHERE cart_items.cart_id = carts.id)`)
    .run(cutoff).changes;
}
