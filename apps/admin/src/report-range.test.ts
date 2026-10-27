import { describe, expect, it } from 'vitest';
import { presetRange } from './report-range.ts';

// 马来西亚没有夏令时，整年 UTC+8，算时间可以直接减 8 小时验证
const MY = 'Asia/Kuala_Lumpur';
const at = (iso: string) => new Date(iso);

describe('日结单常用时间段', () => {
  it('今天：00:00 到明天 00:00，且不带班次', () => {
    const r = presetRange('today', at('2026-10-26T02:55:00+08:00'), MY);
    expect(r).toEqual({ from: '2026-10-26T00:00', to: '2026-10-27T00:00', shift: '' });
  });

  it('昨天：昨天 00:00 到今天 00:00，且不带班次', () => {
    const r = presetRange('yesterday', at('2026-10-26T02:55:00+08:00'), MY);
    expect(r).toEqual({ from: '2026-10-25T00:00', to: '2026-10-26T00:00', shift: '' });
  });

  // ── 「刚收的晚市」这组用例的共同前提 ──
  // 无论现在是几点，只要「这张单属于今天、而且已经发生」，点下去就必须看得到它。
  // 这一条踩过两次：营业中漏了今晚的单，白天漏了白天这一单。
  // 现在窗口统一是「这一班 17:00 开门 → 此刻」。

  it('凌晨 2:55 收档：昨天 17:00 → 今天 02:56，能圈到凌晨的尾单', () => {
    const r = presetRange('lastShift', at('2026-10-26T02:55:00+08:00'), MY);
    expect(r.from).toBe('2026-10-25T17:00');
    expect(r.to).toBe('2026-10-26T02:56');
    expect(r.shift).toBe('晚市');
  });

  it('白天 11:20：昨天 17:00 → 今天 11:21，白天这一单也在窗口里（营业日按自然日算）', () => {
    const r = presetRange('lastShift', at('2026-10-27T11:20:00+08:00'), MY);
    expect(r.from).toBe('2026-10-26T17:00');
    expect(r.to).toBe('2026-10-27T11:21');
  });

  it('营业中 18:21:30：今天 17:00 → 18:22，今晚刚下的单必须算进来', () => {
    const r = presetRange('lastShift', at('2026-10-26T18:21:30+08:00'), MY);
    expect(r.from).toBe('2026-10-26T17:00');
    expect(r.to).toBe('2026-10-26T18:22');
    expect(r.shift).toBe('晚市');
  });

  it('刚开门 17:05：结束点不会早于开始点', () => {
    const r = presetRange('lastShift', at('2026-10-26T17:05:00+08:00'), MY);
    expect(r.from).toBe('2026-10-26T17:00');
    expect(r.to).toBe('2026-10-26T17:06');
  });

  it('23:59:30：跨到次日 00:00，不会写出 24:00 这种非法时刻', () => {
    expect(presetRange('lastShift', at('2026-10-26T23:59:30+08:00'), MY).to).toBe('2026-10-27T00:00');
  });

  it('17:59:30：分钟进位不会写成 17:60', () => {
    expect(presetRange('lastShift', at('2026-10-26T17:59:30+08:00'), MY).to).toBe('2026-10-26T18:00');
  });

  it('早上 09:00（白天开头）：仍然是昨天 17:00 起，不是今天 00:00 起', () => {
    const r = presetRange('lastShift', at('2026-10-27T09:00:00+08:00'), MY);
    expect(r.from).toBe('2026-10-26T17:00');
    expect(r.to).toBe('2026-10-27T09:01');
  });

  // ── 「下一班」：还没开始的那一段 ──
  it('白天 14:00 点「下一班」：今晚 17:00 → 明天 02:00', () => {
    const r = presetRange('shift', at('2026-10-26T14:00:00+08:00'), MY);
    expect(r.from).toBe('2026-10-26T17:00');
    expect(r.to).toBe('2026-10-27T02:00');
    expect(r.shift).toBe('晚市');
  });

  it('营业中 18:21 点「下一班」：明晚 17:00，不会指回已经过去的今晚', () => {
    const r = presetRange('shift', at('2026-10-26T18:21:00+08:00'), MY);
    expect(r.from).toBe('2026-10-27T17:00');
    expect(r.to).toBe('2026-10-28T02:00');
  });

  it('凌晨 2:55 点「下一班」：今晚 17:00（不是已经过去的昨天）', () => {
    const r = presetRange('shift', at('2026-10-26T02:55:00+08:00'), MY);
    expect(r.from).toBe('2026-10-26T17:00');
  });

  it('跨月边界：11 月 1 日凌晨 1:30，这一班是 10 月 31 日开的', () => {
    const r = presetRange('lastShift', at('2026-11-01T01:30:00+08:00'), MY);
    expect(r.from).toBe('2026-10-31T17:00');
    expect(r.to).toBe('2026-11-01T01:31');
  });

  it('跨年边界：1 月 1 日凌晨，这一班是 12 月 31 日开的', () => {
    const r = presetRange('lastShift', at('2027-01-01T00:30:00+08:00'), MY);
    expect(r.from).toBe('2026-12-31T17:00');
    expect(r.to).toBe('2027-01-01T00:31');
  });

  it('一天 24 个整点：窗口都包含「此刻」，且不把未来算进来', () => {
    // 老板点下去看到的那一页，必须覆盖「到现在为止」这一整段。
    // 这条不变量比逐个时刻断言更硬——以后改时间规则，只要这条不过就是错的。
    for (let h = 0; h < 24; h++) {
      const nowStr = `2026-10-27T${String(h).padStart(2, '0')}:30:00+08:00`;
      const r = presetRange('lastShift', at(nowStr), MY);
      expect(r.from < r.to, `${h} 点：开始必须早于结束`).toBe(true);
      const to = new Date(`${r.to}:00+08:00`);
      const now = at(nowStr);
      expect(to.getTime(), `${h} 点：结束点必须越过此刻`).toBeGreaterThan(now.getTime());
      expect(to.getTime() - now.getTime(), `${h} 点：结束点不该跑到未来`).toBeLessThanOrEqual(60_000);
    }
  });
});
