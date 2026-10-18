// 缩略图占位字（43号 C2 / 48号裁定）：跳过开头的修饰词；同组撞字取第三个字，再往后找没用过的
import { describe, expect, it } from 'vitest';
import { stripModifier, thumbChars } from './thumb.ts';

let n = 0;
const g = (...names: string[]) => ({ dishes: names.map((name) => ({ uid: `d${n++}`, name })) });

describe('缩略图占位字', () => {
  it('四个字以上、以修饰词开头的，跳过开头两个字', () => {
    expect(stripModifier('招牌跳跳蛙')[0]).toBe('跳');
    expect(stripModifier('湘西土匪鸭')[0]).toBe('土');
    expect(stripModifier('糖醋排骨')[0]).toBe('排');
    expect(stripModifier('招牌菜')[0]).toBe('招'); // 三个字不跳
  });

  it('同一组首字撞了取第三个字；第三个字也用过就往后找', () => {
    n = 0;
    const m = thumbChars([g('金秋土豆烧排骨', '湘西土匪鸭', '土豆丝')]);
    expect(m.get('d0')).toBe('土');
    expect(m.get('d1')).toBe('鸭'); // 去掉「湘西」后是「土匪鸭」，第三个字
    expect([...m.values()]).toHaveLength(new Set(m.values()).size);
  });

  it('不同组之间可以重复', () => {
    n = 0;
    const m = thumbChars([g('土豆丝'), g('土鸡汤')]);
    expect([m.get('d0'), m.get('d1')]).toEqual(['土', '土']);
  });
});
