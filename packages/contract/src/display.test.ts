import { describe, expect, it } from 'vitest';
import { formatClock, formatClockSec, formatDate, formatDateTime, formatMoney, formatPickupNo, formatPrice, formatTable } from './display.ts';
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

describe('账单金额固定两位小数（全店账单统一）', () => {
  // 菜单价可以写 48 / 19.9，因为顾客看的是「这道菜多少钱」；
  // 但账单、日结单、数据看板、储值流水是一列数字叠在一起对账用的，
  // 参差不齐（1739.6 / 48 / 2）既难对齐，也容易被当成打错字。
  it.each([
    [4800, '48.00'], [1990, '19.90'], [990, '9.90'], [200, '2.00'], [173960, '1739.60'], [5, '0.05'], [0, '0.00'],
    [-50, '-0.50'], [-1990, '-19.90'],
  ])('%i 仙 → %s', (sen, text) => {
    expect(formatMoney(sen)).toBe(text);
  });
  it.each([null, undefined, Number.NaN, 19.9])('非法值 %j → —', (v) => {
    expect(formatMoney(v as number | null | undefined)).toBe('—');
  });
  it('同一批数字用两种写法时，账单那种一定宽度一致', () => {
    // 这正是数据看板之前的毛病：1739.6 / 48 / 2 三个数右对齐后还是错位的
    const board = [173960, 4800, 200].map(formatMoney);
    expect(board).toEqual(['1739.60', '48.00', '2.00']);
    expect(new Set(board.map((s) => s.split('.')[1]!.length))).toEqual(new Set([2]));
  });
});

describe('打印记录的时分秒走门店时区（P1-5）', () => {
  // 服务端 print_jobs.at 存的是 new Date().toISOString()，是 UTC。
  // 老板端原来写 at.slice(11,19) 直接截取，等于按 UTC 显示——吉隆坡差 8 小时，
  // 晚上七点打的单显示成上午十一点，对不上「刚才那单」。
  const tz = 'Asia/Kuala_Lumpur';
  it('UTC 19:42:10 → 吉隆坡 03:42:10（跨日也照样对）', () => {
    // 2026-10-25T19:42:10Z = 吉隆坡 10-26 03:42:10
    expect(formatClockSec('2026-10-25T19:42:10.000Z', tz)).toBe('03:42:10');
  });
  it('晚高峰 11:30:00Z → 19:30:00（晚上的单不能显示成上午）', () => {
    expect(formatClockSec('2026-10-25T11:30:00.000Z', tz)).toBe('19:30:00');
  });
  it('缺值 / 脏值不炸，给占位', () => {
    expect(formatClockSec(null, tz)).toBe('--:--:--');
    expect(formatClockSec('', tz)).toBe('--:--:--');
    expect(formatClockSec('not a date', tz)).toBe('--:--:--');
  });
});
