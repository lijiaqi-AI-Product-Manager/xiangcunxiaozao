import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRM, parsePriceToCents } from '../src/utils/money.js';

test('金额展示：整数分 → RM 串', () => {
  assert.equal(formatRM(0), 'RM 0.00');
  assert.equal(formatRM(5), 'RM 0.05');
  assert.equal(formatRM(1850), 'RM 18.50');
  assert.equal(formatRM(100000), 'RM 1,000.00');
});

test('金额展示：非法输入直接拒绝', () => {
  assert.throws(() => formatRM(-1));
  assert.throws(() => formatRM(18.5)); // 浮点分绝不入账
  assert.throws(() => formatRM(NaN));
});

test('价格解析：字符串 / 数字 / RM 前缀', () => {
  assert.equal(parsePriceToCents('18.5'), 1850);
  assert.equal(parsePriceToCents('18.55'), 1855);
  assert.equal(parsePriceToCents('18'), 1800);
  assert.equal(parsePriceToCents(18.5), 1850);
  assert.equal(parsePriceToCents('RM 18.5'), 1850);
  assert.equal(parsePriceToCents('0'), 0);
});

test('价格解析：畸形输入拒绝', () => {
  assert.throws(() => parsePriceToCents('18.'));
  assert.throws(() => parsePriceToCents('18.555'));
  assert.throws(() => parsePriceToCents('-5'));
  assert.throws(() => parsePriceToCents('abc'));
  assert.throws(() => parsePriceToCents(null));
});

test('浮点精度红线：0.1+0.2 类场景必须精确到分', () => {
  const a = parsePriceToCents('10.10');
  const b = parsePriceToCents('10.20');
  assert.equal(a + b, 2030);
  assert.equal(formatRM(a + b), 'RM 20.30');
});
