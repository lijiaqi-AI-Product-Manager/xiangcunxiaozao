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


;try{ if (typeof window!=='undefined'){ const m={createCart,changeQty,totalQty,totalPrice,fmtRM,macaronIndex,decidePerf}; for(const k in m){ if(!window['xcz'+k[0].toUpperCase()+k.slice(1)]) window['xcz'+k[0].toUpperCase()+k.slice(1)]=m[k]; } } }catch(e){}

/* ============================================================
   detail.js —— 菜品详情页：按 ?id= 渲染五层内容 + 加购
   ============================================================ */
(function () {
  'use strict';
  const M = window.MENU_DATA;
  const dishById = Object.fromEntries(M.dishes.map(d => [d.id, d]));
  const id = new URLSearchParams(location.search).get('id') || M.brand.hero_dish;
  const d = dishById[id];
  if (!d) { location.replace('index.html'); return; }

  /* 三档 */
  (function () {
    const p = new URLSearchParams(location.search).get('perf');
    document.documentElement.dataset.perf = window.xczDecidePerf({ forced: /^(normal|minimal|lite)$/.test(p || '') ? p : null });
  })();

  let cart = window.xczCreateCart();
  const $ = s => document.querySelector(s);

  function qtyHTML() {
    const q = cart[d.id] || 0;
    if (q <= 0) return '<button class="stamp-add dt-qty" data-add>加入</button>';
    return '<div class="qty dt-qty">' +
      '<button class="qty-minus" data-minus>−</button><span class="qty-n">' + q + '</span>' +
      '<button class="qty-plus" data-plus>＋</button></div>';
  }
  function sync() {
    const n = window.xczTotalQty(cart);
    const sum = window.xczTotalPrice(cart, k => dishById[k].price);
    document.querySelector('.dt-bar .dt-qty').outerHTML = qtyHTML();
    const p = document.querySelector('.dt-bar .dt-bar-price');
    p.innerHTML = '<small>' + (n > 0 ? '已加 ' + n + ' 件' : '湘灶价') + '</small>RM ' + window.xczFmtRM(sum > 0 ? sum : d.price);
  }

  document.addEventListener('click', function (e) {
    const t = e.target;
    if (t.closest('[data-add]')) { cart = window.xczChangeQty(cart, d.id, +1); sync(); }
    else if (t.closest('[data-plus]')) { cart = window.xczChangeQty(cart, d.id, +1); sync(); }
    else if (t.closest('[data-minus]')) { cart = window.xczChangeQty(cart, d.id, -1); sync(); }
    else if (t.closest('.dt-back')) { history.length > 1 ? history.back() : (location.href = 'index.html'); }
  });

  /* —— 填充五层内容 —— */
  document.title = d.name + ' · 湘村小灶';
  $('#dtName').textContent = d.name;
  $('#dtEn').textContent = d.en || d.pinyin || '';
  $('#dtIntro').textContent = d.intro;
  $('#dtOrigin').textContent = d.origin;
  $('#dtRoad').textContent = d.road;
  $('#dtChar').textContent = d.char;
  $('#dtCraft').innerHTML = d.craft.map(function (s, i) {
    return '<li><b>0' + (i + 1) + '</b><span>' + s + '</span></li>';
  }).join('');
  $('#dtIng').innerHTML = d.ingredients.map(function (x) {
    return '<div class="dt-ing-card"><span class="dt-ing-name">' + x.n + '</span><span class="dt-ing-why">' + x.w + '</span></div>';
  }).join('');
  document.body.dataset.zone = d.zone;
  sync();
})();
