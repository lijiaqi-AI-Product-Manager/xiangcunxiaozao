// 生成出来的菜单数据，逐条对照裁决书检查
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Faq, flavorRouteLabel, Menu, takeApartView } from '@pkg/contract';

const menu = Menu.parse(JSON.parse(readFileSync(resolve('brands', process.env.BRAND!, 'menu.json'), 'utf8')));
const byUid = (uid: string) => menu.dishes.find((d) => d.uid === uid);

describe('菜单数据', () => {
  it('11号清单 99 行 + 保留 1 道，编号菜共 100 道', () => {
    expect(menu.dishes.filter((d) => d.code !== '')).toHaveLength(100);
  });
  it('重复编号照写不合并，内部ID各不相同', () => {
    expect(menu.dishes.filter((d) => d.code === 'E11').map((d) => d.uid)).toEqual(['e11a', 'e11b', 'e11c']);
    expect(menu.dishes.filter((d) => d.code === 'C11').map((d) => d.uid)).toEqual(['c11a', 'c11b']);
    expect(menu.dishes.filter((d) => d.code === 'D01').map((d) => d.uid).sort()).toEqual(['d01-can', 'd01-hot']);
    expect(new Set(menu.dishes.map((d) => d.uid)).size).toBe(menu.dishes.length);
  });
  it('菜名与价格以 11号清单为准（22号裁决）', () => {
    expect(byUid('e06')?.name).toBe('湘味油泼牛肉');
    expect(byUid('l01')?.priceSen).toBe(1990);
    expect(byUid('l01')?.pending).toContain('gauss:price');
    expect(byUid('d01-can')?.name).toBe('青岛啤酒（瓶装）');
  });
  it('文案按对照表挂到正确的菜上', () => {
    expect(byUid('xl03')?.hook).toBe('一升的量，西瓜的鲜。');
    expect(byUid('c11a')?.origin).toContain('岳阳');
    expect(byUid('c11b')?.name).toBe('外婆菜炒肉末');
    expect(byUid('v01')?.steps).toHaveLength(3);
    expect(menu.dishes.filter((d) => d.hook !== null)).toHaveLength(48);
  });
  it('「拆开看看」分级：A/B/C 标注层，D/E/V 双图法，饮品不做', () => {
    for (const d of menu.dishes) {
      const want = ['a', 'b', 'c'].includes(d.categoryKey) ? 'annotation' : ['d', 'e', 'v'].includes(d.categoryKey) ? 'dual-image' : 'none';
      expect(d.disassembly, d.uid).toBe(want);
    }
  });
  it('图片路径初始全空', () => {
    expect(menu.dishes.every((d) => d.images.closed === null && d.images.exploded === null)).toBe(true);
  });
  it('25号文案修正已落地（② 详情简介）', () => {
    expect(byUid('b11')?.intro).toContain('油麦菜娇气');
    expect(byUid('c04')?.intro).toContain('不吃香菜可备注去掉');
    expect(byUid('e07')?.intro).not.toContain('死刑');
    expect(byUid('c05')?.hook).toBe('鲜牛肉逆纹切，香菜梗一起爆。'); // 其他层原样不动
  });
  it('问1 定稿：开头「不是。」、步骤顺序正确、结尾「您下单才开始做。」', () => {
    const faq = Faq.parse(JSON.parse(readFileSync(resolve('brands', process.env.BRAND!, 'faq.json'), 'utf8')));
    const a = faq.boards[0]!.items[0]!.a;
    expect(a).toBe('不是。一锅出，鸡蛋炒散先出锅定形，肉片煸出油脂，青椒木耳单独断生，最后猛火合炒三十秒，鸡蛋回锅裹汁出锅。您下单才开始做。');
  });
  it('米饭按份点，配送费不上架', () => {
    expect(byUid('staple-rice')).toMatchObject({ priceSen: 200, unit: '位', orderable: true });
    expect(byUid('delivery-fee-1')?.orderable).toBe(false);
  });
  it('风味之路：顾客端显示里不再出现任何括号或路线号（30号 A 方案），数据原文保留', () => {
    const routes = menu.dishes.filter((d) => d.flavorRoute);
    expect(routes.length).toBeGreaterThan(0);
    for (const d of routes) {
      const label = flavorRouteLabel(d.flavorRoute);
      expect(label, d.uid).toBeTruthy();
      expect(label, d.uid).not.toMatch(/[（）()]|R\d/);
      expect(d.flavorRoute, d.uid).toContain('（'); // 数据层的制作标注没被删
    }
  });
  it('详情页「拆开看看」现状：S 级 10 道食材层 + 17 道不放按钮；饮品主食一律不放', () => {
    const count = (level: string) => {
      const views = menu.dishes.filter((d) => d.disassembly === level).map((d) => takeApartView(d) ?? 'hidden');
      return Object.fromEntries([...new Set(views)].map((v) => [v, views.filter((x) => x === v).length]));
    };
    expect(count('dual-image')).toEqual({ layers: 10, hidden: 17 });
    expect(count('annotation')).toEqual({ layers: 27, hidden: 14 });
    expect(count('none')).toEqual({ hidden: 36 });
  });
  it('套餐只收清单里真正的套餐，清单末尾的「统计」脚注不算套餐', () => {
    expect(menu.bundles.map((b) => b.name)).toEqual(['超值双人餐', '超值四人餐', '套餐一~套餐六']);
  });
});
