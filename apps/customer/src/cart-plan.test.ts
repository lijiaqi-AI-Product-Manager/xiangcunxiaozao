import { describe, expect, it } from 'vitest';
import { planChange, type PlanLine } from './cart-plan.ts';

const line = (id: string, dishUid: string, qty: number): PlanLine => ({ id, dishUid, qty });

describe('planChange：菜单页「+」到底发什么请求', () => {
  /**
   * 这一条对应一个真实事故：原来空车时返回 null，顾客点第一次「+」毫无反应，
   * 菜单页和详情页共用这个函数，等于整站点不了单。
   */
  it('购物车里还没有这道菜时，「+」必须把它加进去（不是什么都不做）', () => {
    expect(planChange([], 'l01', 1)).toEqual({ kind: 'addDish', dishUid: 'l01', qty: 1 });
    expect(planChange([line('a', 'c04', 2)], 'l01', 1)).toEqual({ kind: 'addDish', dishUid: 'l01', qty: 1 });
  });

  it('没有这道菜时点「−」不做任何事（本来就没有，不该报错也不该加）', () => {
    expect(planChange([], 'l01', -1)).toEqual({ kind: 'none' });
    expect(planChange([line('a', 'c04', 2)], 'l01', -1)).toEqual({ kind: 'none' });
  });

  it('已有那行时改这一行的数量', () => {
    const lines = [line('a', 'l01', 2)];
    expect(planChange(lines, 'l01', 1)).toEqual({ kind: 'setLine', lineId: 'a', qty: 3 });
    expect(planChange(lines, 'l01', -1)).toEqual({ kind: 'setLine', lineId: 'a', qty: 1 });
  });

  it('减到 0 也是 setLine 0 —— 服务端按「数量 0 就删这一行」处理', () => {
    expect(planChange([line('a', 'l01', 1)], 'l01', -1)).toEqual({ kind: 'setLine', lineId: 'a', qty: 0 });
  });

  it('同菜多行（不同辣度）时动数量最多的那一行，不会改错辣度', () => {
    const lines = [line('a', 'c04', 1), line('b', 'c04', 3)];
    expect(planChange(lines, 'c04', 1)).toEqual({ kind: 'setLine', lineId: 'b', qty: 4 });
  });

  it('数量封顶 99、封底 0，不会发出负数或三位数', () => {
    expect(planChange([line('a', 'l01', 99)], 'l01', 1)).toEqual({ kind: 'setLine', lineId: 'a', qty: 99 });
    expect(planChange([line('a', 'l01', 0)], 'l01', -1)).toEqual({ kind: 'setLine', lineId: 'a', qty: 0 });
  });

  it('空车时加多份也是加进去（不是加 0）', () => {
    expect(planChange([], 'l01', 3)).toEqual({ kind: 'addDish', dishUid: 'l01', qty: 3 });
  });
});
