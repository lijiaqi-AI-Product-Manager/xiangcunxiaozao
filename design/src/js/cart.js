/* ============================================================
   cart.js —— 购物车纯逻辑（无 DOM，可单元测试）
   ============================================================ */

/** 创建空购物车 */
function createCart() {
  return Object.create(null); // id -> qty
}

/** 增减数量（delta 可为负），数量归零自动清除条目 */
function changeQty(cart, id, delta) {
  const next = Object.assign(Object.create(null), cart);
  const q = (next[id] || 0) + delta;
  if (q <= 0) delete next[id];
  else next[id] = q;
  return next;
}

/** 总件数 */
function totalQty(cart) {
  let n = 0;
  for (const k in cart) n += cart[k];
  return n;
}

/** 总金额（priceOf: id -> RM 数字） */
function totalPrice(cart, priceOf) {
  let sum = 0;
  for (const k in cart) sum += cart[k] * priceOf(k);
  return Math.round(sum * 100) / 100;
}

/** 金额格式化：RM 12 / RM 9.9（整数不带小数） */
function fmtRM(v) {
  return Number.isInteger(v) ? String(v) : String(v);
}

/** 马卡龙底色索引：按菜品编号哈希，同菜永远同色（0-3） */
function macaronIndex(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 4;
}

/** 三档性能判定：手动参数 > localStorage > 自动（内存/核数） */
function decidePerf(opts) {
  const o = opts || {};
  if (o.forced) return o.forced;                 // ?perf=lite 手动
  try {
    const saved = localStorage.getItem('xcz-perf');
    if (saved === 'normal' || saved === 'minimal' || saved === 'lite') return saved;
  } catch (e) { /* 隐私模式 */ }
  const nav = o.nav || (typeof navigator !== 'undefined' ? navigator : {});
  const mem = nav.deviceMemory || 8;
  const cores = nav.hardwareConcurrency || 8;
  if (mem <= 2 || cores <= 2) return 'lite';
  if (mem < 4 || cores <= 4) return 'minimal';
  return 'normal';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createCart, changeQty, totalQty, totalPrice, fmtRM, macaronIndex, decidePerf };
}
