/* ============================================================
   app.js —— 点单页：渲染 / IO横幅卡 / 分类锚点 / 分区色温 /
   加购·算盘珠·水滴飞行 / 结算双变体 / 三档性能
   依赖：window.MENU_DATA（构建时注入）、cart.js
   ============================================================ */
(function () {
  'use strict';
  const M = window.MENU_DATA;
  const HERO_ID = M.brand.hero_dish;
  const dishById = Object.fromEntries(M.dishes.map(d => [d.id, d]));

  /* —— 版本配置（构建时注入 <html data-*>，此处只读） —— */
  const cfg = {
    checkout: document.documentElement.dataset.checkout || 'bar',  // bar | dock
    hero: document.documentElement.dataset.hero === 'on',
    version: document.documentElement.dataset.version || 'v2-ink',
  };

  /* ============ 三档性能 ============ */
  (function initPerf() {
    const p = new URLSearchParams(location.search).get('perf');
    const level = window.xczDecidePerf({ forced: /^(normal|minimal|lite)$/.test(p || '') ? p : null });
    document.documentElement.dataset.perf = level;
    const btn = document.getElementById('perfBadge');
    if (btn) {
      btn.textContent = 'perf: ' + level;
      btn.addEventListener('click', function () {
        const order = ['normal', 'minimal', 'lite'];
        const next = order[(order.indexOf(level) + 1) % 3];
        try { localStorage.setItem('xcz-perf', next); } catch (e) {}
        location.reload();
      });
    }
  })();

  /* ============ 购物车状态 ============ */
  let cart = window.xczCreateCart();
  const priceOf = id => dishById[id].price;
  const $ = s => document.querySelector(s);

  function syncCartUI(fromEl) {
    const n = window.xczTotalQty(cart);
    const sum = window.xczTotalPrice(cart, priceOf);
    // 结算条 V2
    const bar = $('#checkoutBar');
    if (bar && cfg.checkout === 'bar') {
      bar.classList.toggle('has', n > 0);
      const c = bar.querySelector('.cb-count'); if (c) c.textContent = n;
      const t = bar.querySelector('.cb-total b'); if (t) t.textContent = 'RM ' + window.xczFmtRM(sum);
    }
    // Dock V1：徽标 + 迷你结算
    const dock = $('#dock');
    if (dock && cfg.checkout === 'dock') {
      const badge = dock.querySelector('.dock-badge'); if (badge) { badge.textContent = n; badge.classList.toggle('has', n > 0); }
      const mini = dock.querySelector('.dock-checkout');
      if (mini) {
        mini.classList.toggle('has', n > 0);
        const b = mini.querySelector('b'); if (b) b.textContent = 'RM ' + window.xczFmtRM(sum);
      }
    }
    // 所有菜卡上的算盘珠
    document.querySelectorAll('.dish-card').forEach(card => {
      const q = cart[card.dataset.id] || 0;
      const cell = card.querySelector('.dc-qty');
      if (cell) cell.outerHTML = qtyHTML(card.dataset.id, q, dishById[card.dataset.id].price);
    });
  }

  function qtyHTML(id, q, price) {
    if (q <= 0) {
      return '<button class="stamp-add dc-qty" data-add="' + id + '" aria-label="加入 ' + dishById[id].name + '">＋</button>';
    }
    return '<div class="qty dc-qty" data-qty="' + id + '">' +
      '<button class="qty-minus" data-minus="' + id + '" aria-label="减少">−</button>' +
      '<span class="qty-n">' + q + '</span>' +
      '<button class="qty-plus" data-plus="' + id + '" aria-label="增加">＋</button></div>';
  }

  /* ============ 水滴飞行 +1（合成层） ============ */
  function flyDrop(fromEl) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r0 = fromEl.getBoundingClientRect();
    let target = document.querySelector('#checkoutBar .cb-cart') || document.querySelector('#dock .dock-item.cart-tab') || document.body;
    const r1 = target.getBoundingClientRect();
    const d = document.createElement('div');
    d.className = 'fly-drop';
    d.style.left = (r0.left + r0.width / 2 - 9) + 'px';
    d.style.top = (r0.top + r0.height / 2 - 9) + 'px';
    d.style.setProperty('--fx', (r1.left + r1.width / 2 - r0.left - r0.width / 2) + 'px');
    d.style.setProperty('--fy', (r1.top + r1.height / 2 - r0.top - r0.height / 2) + 'px');
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 680);
  }

  /* ============ 渲染菜单 ============ */
  function render() {
    // 门店区双模态
    const heroHead = document.querySelector('.shop-head.hero-head');
    const plainHead = document.querySelector('.shop-head.plain-head');
    if (cfg.hero) { if (plainHead) plainHead.remove(); } else { if (heroHead) heroHead.remove(); }

    // 菜单列表
    const list = $('#menuList');
    list.innerHTML = M.categories.map(function (cat) {
      const ds = M.dishes.filter(d => d.id[0] === cat.id);
      const cards = ds.map(function (d) {
        const sold = d.sold_out;
        const qtyPart = sold
          ? '<span class="sold-out-tag">今日售罄</span>'
          : qtyHTML(d.id, cart[d.id] || 0, d.price);
        const heroTag = (d.id === HERO_ID) ? '<span class="dc-tag">头牌</span>' : '';
        const tag2 = d.tag ? '<span class="dc-tag">' + d.tag + '</span>' : '';
        return '<article class="dish-card' + (sold ? ' sold-out' : '') + '" data-id="' + d.id + '" data-href="detail.html?id=' + d.id + '">' +
          '<div class="dc-thumb" data-macaron="' + window.xczMacaronIndex(d.id) + '"><span class="dc-char">' + d.char + '</span></div>' +
          '<div class="dc-main">' +
            '<h3 class="dc-name">' + d.name + heroTag + tag2 + '</h3>' +
            '<p class="dc-copy">' + d.list + '</p>' +
            '<div class="dc-bottom"><span class="dc-price"><small>RM</small>' + window.xczFmtRM(d.price) + '</span>' + qtyPart + '</div>' +
          '</div></article>';
      }).join('');
      return '<section class="cat-block" data-cat="' + cat.id + '" data-zone="' + cat.zone + '" id="cat-' + cat.id + '">' +
        '<div class="cat-head"><h2>' + cat.name + '</h2><span class="en-cap">' + cat.en + '</span><hr class="gold-rule"></div>' +
        cards + '</section>';
    }).join('');

    // 分类条
    $('#catBar').innerHTML = M.categories.map(function (cat, i) {
      return '<button class="cat-pill' + (i === 0 ? ' on' : '') + '" data-goto="cat-' + cat.id + '">' + cat.name + '</button>';
    }).join('');

    // 横幅卡（heroDish）
    const hero = dishById[HERO_ID];
    const bc = $('#bannerCard');
    bc.innerHTML = '<div class="bc-thumb">' + hero.char + '</div>' +
      '<div class="bc-info"><b>' + hero.name + '</b><span>全场头牌 · 每日现杀</span></div>' +
      '<div class="bc-price"><small style="font-size:10px">RM </small>' + window.xczFmtRM(hero.price) + '</div>' +
      '<button class="bc-go" data-goto-detail="' + HERO_ID + '">去看看</button>';
  }

  /* ============ 事件委托：加购 / 减购 / 跳详情 ============ */
  document.addEventListener('click', function (e) {
    const t = e.target.closest('[data-add],[data-plus],[data-minus],[data-goto],[data-goto-detail],.dish-card');
    if (!t) return;
    if (t.dataset.add) {
      e.stopPropagation();
      cart = window.xczChangeQty(cart, t.dataset.add, +1);
      flyDrop(t); syncCartUI(); stampPress(t);
    } else if (t.dataset.plus) {
      e.stopPropagation();
      cart = window.xczChangeQty(cart, t.dataset.plus, +1);
      flyDrop(t); syncCartUI();
    } else if (t.dataset.minus) {
      e.stopPropagation();
      cart = window.xczChangeQty(cart, t.dataset.minus, -1);
      syncCartUI();
    } else if (t.dataset.goto) {
      e.stopPropagation();
      document.getElementById(t.dataset.goto).scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (t.dataset.gotoDetail) {
      e.stopPropagation();
      location.href = 'detail.html?id=' + t.dataset.gotoDetail;
    } else if (t.classList.contains('dish-card')) {
      location.href = t.dataset.href;
    }
  });
  /* 落印弹跳：加号按下时 scale 弹跳 */
  function stampPress(el) {
    el.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(0.92)' }, { transform: 'scale(1)' }],
      { duration: 180, easing: 'ease-out' }
    );
  }

  /* ============ IO ①：横幅卡落下/收起 ============ */
  function initBannerIO() {
    const head = document.querySelector('.shop-head');  // 无图态或大画态均占顶部
    const card = $('#bannerCard');
    if (!head || !card) return;
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          card.classList.remove('show'); card.classList.add('fold');
        } else if (en.boundingClientRect.top < 0) {  // 头部越过视口顶 → 落下横幅卡
          card.classList.remove('fold'); card.classList.add('show');
        }
      });
    }, { rootMargin: '0px 0px -85% 0px', threshold: 0 });
    io.observe(head);
  }

  /* ============ IO ②：分区色温联动（body[data-zone]，2.4s CSS 过渡） ============ */
  function initZoneIO() {
    const blocks = document.querySelectorAll('.cat-block');
    if (!blocks.length || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          document.body.dataset.zone = en.target.dataset.zone;
          syncCatPills(en.target.dataset.cat);
        }
      });
    }, { rootMargin: '-42% 0px -42% 0px', threshold: 0 });
    blocks.forEach(b => io.observe(b));
  }
  function syncCatPills(catId) {
    document.querySelectorAll('.cat-pill').forEach(p => {
      p.classList.toggle('on', p.dataset.goto === 'cat-' + catId);
    });
  }

  /* ============ 启动 ============ */
  render();
  initBannerIO();
  initZoneIO();
  syncCartUI();
})();
