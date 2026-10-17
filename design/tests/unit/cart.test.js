/* 单元测试：购物车纯逻辑 / 首字取字 / 三档判定 / 马卡龙哈希
   运行：node --test tests/unit/  */
const test = require('node:test');
const assert = require('node:assert');
const { createCart, changeQty, totalQty, totalPrice, fmtRM, macaronIndex, decidePerf } = require('../../src/js/cart.js');
const menu = require('../../src/menu.json');

test('加购→数量增减→归零清除', () => {
  let c = createCart();
  assert.equal(totalQty(c), 0);
  c = changeQty(c, 'E01', 1);
  assert.equal(c.E01, 1);
  c = changeQty(c, 'E01', 1);
  assert.equal(c.E01, 2);
  c = changeQty(c, 'E01', -1);
  assert.equal(c.E01, 1);
  c = changeQty(c, 'E01', -1);
  assert.equal(c.E01, undefined, '归零后条目应清除');
});

test('多菜合计金额与件数', () => {
  let c = createCart();
  c = changeQty(c, 'E01', 2);   // 48 × 2
  c = changeQty(c, 'S02', 1);   // 3.9 × 1
  const priceOf = id => menu.dishes.find(d => d.id === id).price;
  assert.equal(totalQty(c), 3);
  assert.equal(totalPrice(c, priceOf), 99.9);
});

test('金额格式化：整数无小数、小数保留', () => {
  assert.equal(fmtRM(48), '48');
  assert.equal(fmtRM(9.9), '9.9');
});

test('全菜单首字唯一（红线：缩略图不得重字）', () => {
  const chars = menu.dishes.map(d => d.char);
  assert.equal(new Set(chars).size, chars.length, '存在重复首字：' + chars.join(''));
});

test('48道全量与字段完整性', () => {
  assert.equal(menu.dishes.length, 48);
  for (const d of menu.dishes) {
    assert.ok(d.intro && d.intro.length >= 50 && d.intro.length <= 110, d.id + ' 简介60-100字');
    assert.ok(d.origin && d.origin.length >= 30, d.id + ' 源流缺失');
    assert.ok(d.ingredients.length >= 3, d.id + ' 食材至少3条');
    assert.equal(d.craft.length, 3, d.id + ' 工序三步');
    assert.ok(d.road, d.id + ' 风味之路缺失');
  }
});

test('马卡龙哈希：同菜永远同色，四色均在用', () => {
  assert.equal(macaronIndex('E01'), macaronIndex('E01'));
  const used = new Set(menu.dishes.map(d => macaronIndex(d.id)));
  assert.deepEqual([...used].sort(), [0, 1, 2, 3]);
});

test('三档判定：手动 > 自动（低配机）', () => {
  assert.equal(decidePerf({ forced: 'lite' }), 'lite');
  assert.equal(decidePerf({ forced: 'normal' }), 'normal');
  assert.equal(decidePerf({ nav: { deviceMemory: 2, hardwareConcurrency: 2 } }), 'lite');
  assert.equal(decidePerf({ nav: { deviceMemory: 4, hardwareConcurrency: 4 } }), 'minimal');
  assert.equal(decidePerf({ nav: { deviceMemory: 8, hardwareConcurrency: 8 } }), 'normal');
});

test('heroDish 必须存在于菜单', () => {
  assert.ok(menu.dishes.some(d => d.id === menu.brand.hero_dish));
});
