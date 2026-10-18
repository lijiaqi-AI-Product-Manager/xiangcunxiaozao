import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { maskPhone, type LedgerEntry, type LedgerType, type Member, type MemberDetail, type ReconcileRun } from '@pkg/contract';
import type { LockoutGuard } from './auth.ts';
import type { DB } from './db.ts';
import { HttpError, type Clock } from './support.ts';

const SESSION_DAYS = 30;
const MAX_TOP_UP_SEN = 1_000_000; // 单笔充值/调整上限 RM 10,000，防止手滑多打几个 0

interface MemberRow {
  id: string; member_no: string; phone: string | null; pin_hash: string | null; balance_sen: number; created_at: string;
}
interface LedgerRow {
  id: number; created_at: string; type: LedgerType; amount_sen: number; balance_after_sen: number;
  operator: string; note: string | null; order_id: string | null;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${scryptSync(pin, salt, 32).toString('base64')}`;
}
function pinMatches(pin: string, stored: string | null): boolean {
  if (!stored) return false;
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  return timingSafeEqual(scryptSync(pin, Buffer.from(salt, 'base64'), 32), Buffer.from(hash, 'base64'));
}
const validPin = (pin: unknown): pin is string => typeof pin === 'string' && /^\d{4}$/.test(pin);

/**
 * 记一笔流水，余额由数据库触发器同步。必须在调用方的事务里执行。
 * 同一个防重码只会入账一次：重复提交时直接返回第一次那笔，不会多记。
 */
export function postLedger(
  db: DB,
  e: { memberId: string; type: LedgerType; amountSen: number; operator: string; note?: string | null; orderId?: string | null; key: string; at: string },
): LedgerRow {
  const existing = db.prepare('SELECT * FROM ledger_entries WHERE idempotency_key = ?').get(e.key) as LedgerRow | undefined;
  if (existing) return existing;
  const balance = db.prepare('SELECT balance_sen FROM members WHERE id = ?').pluck().get(e.memberId) as number | undefined;
  if (balance === undefined) throw new HttpError(404, '找不到这位会员');
  const after = balance + e.amountSen;
  if (after < 0) throw new HttpError(409, `余额不足：当前余额 RM ${(balance / 100).toFixed(2)}`);
  const r = db.prepare(`INSERT INTO ledger_entries (member_id, created_at, type, amount_sen, balance_after_sen, operator, note, order_id, idempotency_key)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(e.memberId, e.at, e.type, e.amountSen, after, e.operator, e.note ?? null, e.orderId ?? null, e.key);
  return db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(r.lastInsertRowid) as LedgerRow;
}

export class MemberService {
  constructor(private db: DB, private guard: LockoutGuard, private clock: Clock) {}

  // ---------- 老板端 ----------

  /** 店内办卡：会员号自动编（100001 起），4 位密码由顾客当面设定 */
  create(input: { phone?: unknown; pin?: unknown }): Member {
    if (!validPin(input.pin)) throw new HttpError(400, '密码需要是 4 位数字');
    const phone = typeof input.phone === 'string' ? input.phone.replace(/[\s-]/g, '') : '';
    if (phone && !/^\+?\d{6,15}$/.test(phone)) throw new HttpError(400, '手机号格式不对');
    if (phone && this.db.prepare('SELECT 1 FROM members WHERE phone = ?').get(phone)) throw new HttpError(409, '这个手机号已经办过会员卡');
    const id = randomUUID();
    this.db.transaction(() => {
      const next = (this.db.prepare("SELECT COALESCE(MAX(CAST(member_no AS INTEGER)), 100000) + 1 FROM members WHERE member_no GLOB '[0-9]*'").pluck().get() as number);
      this.db.prepare('INSERT INTO members (id, member_no, phone, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, String(next), phone || null, hashPin(input.pin as string), this.now());
    })();
    return this.toMember(this.row(id), false);
  }

  search(q: string): Member[] {
    const s = q.trim();
    const rows = (s
      ? this.db.prepare('SELECT * FROM members WHERE member_no LIKE ? OR phone LIKE ? ORDER BY member_no LIMIT 50').all(`${s}%`, `%${s}%`)
      : this.db.prepare('SELECT * FROM members ORDER BY created_at DESC LIMIT 50').all()) as MemberRow[];
    return rows.map((r) => this.toMember(r, false));
  }

  detail(id: string, masked: boolean, limit = 200): MemberDetail {
    const rows = this.db.prepare('SELECT * FROM ledger_entries WHERE member_id = ? ORDER BY id DESC LIMIT ?').all(id, limit) as LedgerRow[];
    return { member: this.toMember(this.row(id), masked), ledger: rows.map(toEntry) };
  }

  /** 充值（只加不减）。requestId 是前端每次打开表单生成的编号：手抖点两下只入账一次 */
  recharge(id: string, input: { amountSen?: unknown; note?: unknown; requestId?: unknown }, operator: string): MemberDetail {
    const amount = this.amount(input.amountSen, false);
    const requestId = this.requestId(input.requestId);
    this.db.transaction(() => {
      this.row(id);
      postLedger(this.db, { memberId: id, type: 'recharge', amountSen: amount, operator, note: str(input.note) || null, key: `recharge:${requestId}`, at: this.now() });
    })();
    return this.detail(id, false);
  }

  /** 余额调整（可加可减），必须写原因——这是改账，留痕最要紧 */
  adjust(id: string, input: { amountSen?: unknown; note?: unknown; requestId?: unknown }, operator: string): MemberDetail {
    const amount = this.amount(input.amountSen, true);
    const note = str(input.note).trim();
    if (!note) throw new HttpError(400, '调整余额必须写原因');
    const requestId = this.requestId(input.requestId);
    this.db.transaction(() => {
      this.row(id);
      postLedger(this.db, { memberId: id, type: 'adjust', amountSen: amount, operator, note, key: `adjust:${requestId}`, at: this.now() });
    })();
    return this.detail(id, false);
  }

  /** 顾客忘了密码：老板当面重设，同时解除锁定 */
  resetPin(id: string, pin: unknown): Member {
    if (!validPin(pin)) throw new HttpError(400, '密码需要是 4 位数字');
    const m = this.row(id);
    this.db.prepare('UPDATE members SET pin_hash = ? WHERE id = ?').run(hashPin(pin), id);
    this.guard.reset(`member:${m.member_no}`);
    return this.toMember(this.row(id), false);
  }

  /** 对账：每位会员的流水合计必须等于当前余额 */
  reconcile(): ReconcileRun {
    const rows = this.db.prepare(`SELECT m.member_no AS memberNo, m.balance_sen AS balanceSen, COALESCE(SUM(l.amount_sen), 0) AS ledgerSumSen
                                  FROM members m LEFT JOIN ledger_entries l ON l.member_id = m.id
                                  GROUP BY m.id`).all() as { memberNo: string; balanceSen: number; ledgerSumSen: number }[];
    const run = { at: this.now(), checked: rows.length, mismatches: rows.filter((r) => r.balanceSen !== r.ledgerSumSen) };
    this.db.prepare('INSERT INTO reconcile_runs (at, checked, mismatches) VALUES (?, ?, ?)').run(run.at, run.checked, JSON.stringify(run.mismatches));
    return run;
  }

  lastReconcile(): ReconcileRun | null {
    const r = this.db.prepare('SELECT at, checked, mismatches FROM reconcile_runs ORDER BY id DESC LIMIT 1').get() as { at: string; checked: number; mismatches: string } | undefined;
    return r ? { at: r.at, checked: r.checked, mismatches: JSON.parse(r.mismatches) as ReconcileRun['mismatches'] } : null;
  }

  // ---------- 顾客端 ----------

  /** 会员号 + 4 位密码登录；连错 5 次锁 15 分钟（24号 #4）。不提示「会员号不存在」，避免被人试出谁是会员 */
  login(memberNo: unknown, pin: unknown): { token: string; member: Member } {
    const no = str(memberNo).trim();
    if (!no || typeof pin !== 'string') throw new HttpError(400, '请输入会员号和 4 位密码');
    const scope = `member:${no}`;
    this.guard.assertNotLocked(scope);
    const m = this.db.prepare('SELECT * FROM members WHERE member_no = ?').get(no) as MemberRow | undefined;
    if (!m || !pinMatches(pin, m.pin_hash)) {
      const left = this.guard.fail(scope);
      throw new HttpError(left === 0 ? 423 : 401, left === 0 ? '密码错误次数过多，已锁定 15 分钟；可到柜台请店员重设密码' : `会员号或密码不对，还可以再试 ${left} 次`);
    }
    this.guard.reset(scope);
    const token = randomBytes(32).toString('base64url');
    const now = this.clock();
    this.db.prepare('INSERT INTO member_sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256hex(token), m.id, now.toISOString(), new Date(now.getTime() + SESSION_DAYS * 86400000).toISOString());
    return { token, member: this.toMember(m, true) };
  }

  /** 令牌 → 会员 ID；无效或过期返回 null */
  memberIdFor(token: string | null | undefined): string | null {
    if (!token) return null;
    const r = this.db.prepare('SELECT member_id, expires_at FROM member_sessions WHERE token_hash = ?').get(sha256hex(token)) as { member_id: string; expires_at: string } | undefined;
    return r && new Date(r.expires_at) > this.clock() ? r.member_id : null;
  }

  logout(token: string | null | undefined) {
    if (token) this.db.prepare('DELETE FROM member_sessions WHERE token_hash = ?').run(sha256hex(token));
  }

  memberNo(id: string): string {
    return this.row(id).member_no;
  }

  // ---------- 内部 ----------

  private amount(v: unknown, allowNegative: boolean): number {
    if (typeof v !== 'number' || !Number.isInteger(v) || v === 0 || (!allowNegative && v < 0) || Math.abs(v) > MAX_TOP_UP_SEN) {
      throw new HttpError(400, allowNegative ? '调整金额需为非零金额，单笔不超过 RM 10,000' : '充值金额需大于 0，单笔不超过 RM 10,000');
    }
    return v;
  }
  private requestId(v: unknown): string {
    const s = str(v);
    if (!/^[\w-]{8,64}$/.test(s)) throw new HttpError(400, '请求编号缺失，请刷新页面后重试');
    return s;
  }
  private row(id: string): MemberRow {
    const r = this.db.prepare('SELECT * FROM members WHERE id = ?').get(id) as MemberRow | undefined;
    if (!r) throw new HttpError(404, '找不到这位会员');
    return r;
  }
  private toMember(r: MemberRow, masked: boolean): Member {
    const lock = this.db.prepare('SELECT locked_until FROM login_attempts WHERE scope = ?').pluck().get(`member:${r.member_no}`) as string | null | undefined;
    return {
      id: r.id, memberNo: r.member_no, phone: masked ? maskPhone(r.phone) : r.phone, balanceSen: r.balance_sen,
      createdAt: r.created_at, locked: Boolean(lock && new Date(lock) > this.clock()),
    };
  }
  private now() {
    return this.clock().toISOString();
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const toEntry = (r: LedgerRow): LedgerEntry => ({
  id: r.id, at: r.created_at, type: r.type, amountSen: r.amount_sen, balanceAfterSen: r.balance_after_sen,
  operator: r.operator, note: r.note, orderId: r.order_id,
});
