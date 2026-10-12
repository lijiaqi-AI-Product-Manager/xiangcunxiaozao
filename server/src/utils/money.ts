/**
 * 金额工具 —— 全系统唯一允许做“钱运算”的地方。
 * 红线：一律整数分（sen），任何浮点结果都是 bug。
 */

/** 整数分 → 展示串，如 1850 → "RM 18.50" */
export function formatRM(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`非法金额(分): ${cents}`);
  }
  const rm = Math.floor(cents / 100);
  const sen = cents % 100;
  return `RM ${rm.toLocaleString('en-MY')}.${String(sen).padStart(2, '0')}`;
}

/** 管理端录入价格 → 整数分。接受 "18.5" / "18.55" / 18.5 / "RM 18"；非法抛错 */
export function parsePriceToCents(input: unknown): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error('价格不是有效数字');
    const c = Math.round(input * 100);
    if (c > 10000000) throw new Error('价格超出上限 RM 100,000');
    return c;
  }
  if (typeof input !== 'string') throw new Error('价格不是数字');
  const s = input.trim().replace(/^RM\s*/i, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`价格格式非法: ${input}`);
  const [rm, sen = ''] = s.split('.');
  const cents = Number(rm) * 100 + Number(sen.padEnd(2, '0') || '0');
  if (cents > 10000000) throw new Error('价格超出上限 RM 100,000');
  return cents;
}
