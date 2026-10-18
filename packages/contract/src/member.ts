import { z } from 'zod';

/** 会员与储值流水（21号 §4：余额只减不删，每笔变动必有流水；充值和调整只有老板端能做） */

export const LedgerType = z.enum(['recharge', 'consume', 'adjust', 'refund', 'import']);
export type LedgerType = z.infer<typeof LedgerType>;

export const LEDGER_TYPE_LABEL: Record<LedgerType, string> = {
  recharge: '充值',
  consume: '消费',
  adjust: '调整',
  refund: '退款',
  import: '迁移导入',
};

export const LedgerEntry = z.object({
  id: z.number().int(),
  at: z.string(),
  type: LedgerType,
  amountSen: z.number().int(),
  balanceAfterSen: z.number().int(),
  operator: z.string(),
  note: z.string().nullable(),
  orderId: z.string().nullable(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const Member = z.object({
  id: z.string(),
  memberNo: z.string(),
  phone: z.string().nullable(), // 顾客端拿到的是打码后的
  balanceSen: z.number().int(),
  createdAt: z.string(),
  locked: z.boolean(), // 密码是否因连错被锁
});
export type Member = z.infer<typeof Member>;

export const MemberDetail = z.object({ member: Member, ledger: z.array(LedgerEntry) });
export type MemberDetail = z.infer<typeof MemberDetail>;

export const ReconcileRun = z.object({
  at: z.string(),
  checked: z.number().int(),
  mismatches: z.array(z.object({ memberNo: z.string(), balanceSen: z.number().int(), ledgerSumSen: z.number().int() })),
});
export type ReconcileRun = z.infer<typeof ReconcileRun>;

/** 「100」「99.9」「12.50」→ 仙；格式不对返回 null。负号可选（老板调整余额用） */
export function parseRM(text: string, allowNegative = false): number | null {
  const s = text.trim();
  const m = s.match(allowNegative ? /^(-)?(\d+)(?:\.(\d{1,2}))?$/ : /^()(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const sen = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0);
  return m[1] ? -sen : sen;
}

/** 手机号打码：0123456789 → 012****789 */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return phone.length <= 6 ? '****' : `${phone.slice(0, 3)}****${phone.slice(-3)}`;
}
