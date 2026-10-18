// 自托管字体的字重设置（41号 pinWeight / 47号 B2 weightRange）：二选一，范围要从小到大
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Brand } from './brand.ts';

const real = JSON.parse(readFileSync(resolve('brands', process.env.BRAND!, 'brand.json'), 'utf8'));
const withLatin = (latinFont: object) => Brand.safeParse({ ...real, latinFont: { family: 'X', file: 'fonts/x.woff2', source: 'fonts/source/x.ttf', ...latinFont } });

describe('英文装饰字体字重', () => {
  it('品牌配置里的英文字体保留 400–700 两档字重', () => {
    expect(Brand.parse(real).latinFont?.weightRange).toEqual([400, 700]);
  });
  it('只固定一个字重、只给一段范围、都不写，都合法', () => {
    expect(withLatin({ pinWeight: 600 }).success).toBe(true);
    expect(withLatin({ weightRange: [400, 700] }).success).toBe(true);
    expect(withLatin({}).success).toBe(true);
  });
  it('两个同时写、范围倒过来、超出 100–900，都拦住', () => {
    expect(withLatin({ pinWeight: 600, weightRange: [400, 700] }).success).toBe(false);
    expect(withLatin({ weightRange: [700, 400] }).success).toBe(false);
    expect(withLatin({ weightRange: [50, 700] }).success).toBe(false);
  });
});
