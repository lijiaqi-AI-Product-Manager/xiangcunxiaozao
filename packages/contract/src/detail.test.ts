// 菜品详情页的两条显示规则：风味之路截括号（30号 §二.1）、「拆开看看」用哪种主视觉 / 何时不放按钮（24号 #15）
import { describe, expect, it } from 'vitest';
import { flavorRouteLabel, takeApartView, type Dish } from './menu.ts';

type Part = Pick<Dish, 'disassembly' | 'images' | 'annotations' | 'ingredients'>;
const dish = (p: Partial<Part>): Part => ({
  disassembly: 'dual-image', images: { closed: null, exploded: null, thumb: null }, annotations: [], ingredients: [], ...p,
});
const ing = [{ name: '牛肉', note: '' }, { name: '花椒', note: '' }];

describe('风味之路：顾客端截到第一个全角（为止', () => {
  it('去掉括号里的制作标注', () => {
    expect(flavorRouteLabel('湖南·长沙（R1 湘江灶台）')).toBe('湖南·长沙');
    expect(flavorRouteLabel('陕西技法×湖南做（R9 油泼之路，跨点标注陕西→湖南）')).toBe('陕西技法×湖南做');
    expect(flavorRouteLabel('重庆→湖南（R8 江湖码头，跨点标注）')).toBe('重庆→湖南');
  });
  it('没有括号原样显示；半角括号不算（规格只认全角）', () => {
    expect(flavorRouteLabel('湖南·长沙')).toBe('湖南·长沙');
    expect(flavorRouteLabel('湖南 (长沙)')).toBe('湖南 (长沙)');
  });
  it('空值、或整条都在括号里 → 不显示风味之路卡', () => {
    expect(flavorRouteLabel(null)).toBeNull();
    expect(flavorRouteLabel('')).toBeNull();
    expect(flavorRouteLabel('（指向本店标记）')).toBeNull();
  });
});

describe('拆开看看：主视觉选择与藏按钮', () => {
  it('S 级：有分解图用分解图，没图但有食材用食材层，都没有就不放按钮', () => {
    expect(takeApartView(dish({ images: { closed: null, exploded: 'assets/x.webp', thumb: null } }))).toBe('exploded');
    expect(takeApartView(dish({ ingredients: ing }))).toBe('layers');
    expect(takeApartView(dish({}))).toBeNull();
  });
  it('B 级：合拢图和坐标都有才标注；缺一样退回食材层', () => {
    const pins = [{ ingredient: '牛肉', x: 0.3, y: 0.4 }];
    expect(takeApartView(dish({ disassembly: 'annotation', images: { closed: 'assets/c.webp', exploded: null, thumb: null }, annotations: pins, ingredients: ing }))).toBe('pins');
    expect(takeApartView(dish({ disassembly: 'annotation', images: { closed: 'assets/c.webp', exploded: null, thumb: null }, ingredients: ing }))).toBe('layers');
    expect(takeApartView(dish({ disassembly: 'annotation', annotations: pins, ingredients: ing }))).toBe('layers');
    expect(takeApartView(dish({ disassembly: 'annotation' }))).toBeNull();
  });
  it('B 级不吃分解图：标注层的菜即使误填了分解图也不按双图法显示', () => {
    expect(takeApartView(dish({ disassembly: 'annotation', images: { closed: null, exploded: 'assets/x.webp', thumb: null }, ingredients: ing }))).toBe('layers');
  });
  it('饮品主食（不做）：有食材也不放按钮', () => {
    expect(takeApartView(dish({ disassembly: 'none', ingredients: ing }))).toBeNull();
  });
});
