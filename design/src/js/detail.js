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
