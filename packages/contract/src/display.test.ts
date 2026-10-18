import { describe, expect, it } from 'vitest';
import { formatClock, formatDate, formatDateTime, formatPickupNo, formatPrice, formatTable } from './display.ts';
import { maskPhone, parseRM } from './member.ts';

describe('金额输入解析（老板端充值/调整）', () => {
  it.each([['100', 10000], ['99.9', 9990], ['12.50', 1250], ['0.05', 5], [' 8 ', 800]])('%s → %i 仙', (s, sen) => {
    expect(parseRM(s)).toBe(sen);
  });
  it.each(['', 'abc', '1.234', '-5', '1,000', 'RM5'])('非法：%j', (s) => expect(parseRM(s)).toBeNull());
  it('调整允许负数', () => expect(parseRM('-12.5', true)).toBe(-1250));
});

describe('其他显示', () => {
  it('取餐号三位，缺值 ---', () => {
    expect(formatPickupNo(7)).toBe('007');
    expect(formatPickupNo(null)).toBe('---');
  });
  it('手机号打码', () => {
    expect(maskPhone('0123456789')).toBe('012****789');
    expect(maskPhone(null)).toBeNull();
  });
});

describe('空值兜底：永远不出现 undefined / Invalid Date', () => {
  it.each([undefined, null, '', '  ', 'undefined', 'null', 'NaN'])('桌号 %j → 桌 —', (v) => {
    expect(formatTable(v as string | null | undefined)).toBe('桌 —');
  });
  it('正常桌号', () => {
    expect(formatTable(12)).toBe('桌 12');
    expect(formatTable('A3')).toBe('桌 A3');
  });
  it.each([undefined, null, '', 'not-a-date', Number.NaN])('时间 %j → --:--', (v) => {
    expect(formatClock(v as string | null | undefined, 'Asia/Kuala_Lumpur')).toBe('--:--');
  });
  it('日期按门店时区：UTC 10-16 16:37 = 吉隆坡 10-17 00:37（不是 10-16）', () => {
    expect(formatDateTime('2026-10-16T16:37:00Z', 'Asia/Kuala_Lumpur')).toBe('2026-10-17 00:37');
    expect(formatDateTime('2026-10-16T16:37:00Z', 'Asia/Kuala_Lumpur', true)).toBe('10-17 00:37');
    expect(formatDate(null, 'Asia/Kuala_Lumpur')).toBe('----');
  });
  it('按门店时区显示（UTC 04:05 = 吉隆坡 12:05）', () => {
    expect(formatClock('2026-10-16T04:05:00Z', 'Asia/Kuala_Lumpur')).toBe('12:05');
  });
});

describe('价格显示与菜单原文写法一致', () => {
  it.each([
    [4800, '48'], [1990, '19.9'], [990, '9.9'], [290, '2.9'], [150, '1.5'], [1205, '12.05'], [-50, '-0.5'], [-1990, '-19.9'],
  ])('%i 仙 → %s', (sen, text) => {
    expect(formatPrice(sen)).toBe(text);
  });
  it.each([null, undefined, Number.NaN, 19.9])('非法值 %j → —', (v) => {
    expect(formatPrice(v as number | null | undefined)).toBe('—');
  });
});
