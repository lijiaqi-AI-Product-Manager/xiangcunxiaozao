// 41号两页小样的交互（设计资产，不进生产）。所有动画只改 transform / opacity；档位看 html[data-tier]：
// normal 全开 / minimal 去掉常驻漂移和视差 / lite 再去掉毛玻璃、氛围色、涟漪、渐显 / static =「减弱动态效果」全部静止
(function () {
  const root = document.documentElement;
  const tier = () => root.dataset.tier;
  const moving = () => tier() !== 'static';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // 首秒实测帧率 < 45 自动降一档（38号 4.2 性能分档；用 ?tier= 强制时不降）
  if (!root.dataset.forced && (tier() === 'normal' || tier() === 'minimal')) {
    let frames = 0;
    const t0 = performance.now();
    const tick = (t) => {
      frames++;
      if (t - t0 < 1000) return requestAnimationFrame(tick);
      if (frames < 45) root.dataset.tier = tier() === 'normal' ? 'minimal' : 'lite';
    };
    requestAnimationFrame(tick);
  }

  // 首次进入：分组依次淡入，只播一次
  $$('.reveal').forEach((el, i) => setTimeout(() => el.classList.add('in'), moving() ? 60 * i : 0));

  // 购物车金额（示意状态，同一份数据）
  const money = (sen) => `RM ${sen / 100}`;
  let count = Number($('[data-count]')?.textContent || 0);
  let total = $$('[data-uid]').reduce((n, row) => n + Number(row.querySelector('.qty')?.dataset.qty || 0) * Number(row.dataset.price || 0), 0);
  const pop = () => $$('[data-count]').forEach((b) => {
    b.classList.remove('pop');
    void b.offsetWidth; // 重新触发角标弹跳
    b.classList.add('pop');
    setTimeout(() => b.classList.remove('pop'), 1500); // 喜茶：1.5 秒后回到静默态
  });
  // 51号：水滴落进购物车时，落点一团柔光扩散（49号的斜向扫光已废止）
  const landGlow = (x, y) => {
    const g = document.createElement('span');
    g.className = 'land-glow';
    g.style.left = `${x}px`;
    g.style.top = `${y}px`;
    document.body.appendChild(g);
    g.animate([{ transform: 'scale(0)', opacity: 0.35 }, { transform: 'scale(1.4)', opacity: 0 }], { duration: 500, easing: 'cubic-bezier(.2,.7,.3,1)' }).finished.then(() => g.remove());
  };
  // 金额马上变；角标弹跳等水滴落到购物车那一下（没有水滴时马上弹）
  const syncCart = (popNow = true) => {
    $$('[data-count]').forEach((b) => (b.textContent = count));
    $$('[data-total]').forEach((t) => (t.textContent = money(total)));
    if (popNow) pop();
  };

  // 47号附加：水滴 blob「+1」——落印后从加号挤出（压扁 → 回弹）、沿弧线飞向购物车角标（横向、纵向分开缓动 = 抛物线）、落下压扁消失。
  // 三层元素各管一件事：外层横移、中层上抛下落、里层水滴形变；全部是 transform / opacity
  const flyBlob = (btn) => {
    const target = $$('[data-count]').find((b) => b.getBoundingClientRect().width > 0);
    if (!target || !moving() || !document.body.animate) return false;
    const a = btn.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2 - 4;
    const dx = t.left + t.width / 2 - x0, dy = t.top + t.height / 2 - y0;
    const el = document.createElement('span');
    el.className = 'blob';
    el.innerHTML = '<i><b>+1</b></i>';
    document.body.appendChild(el);
    const mid = el.firstChild, drop = mid.firstChild;
    const timing = { duration: 720, delay: 140, fill: 'both' };
    el.animate([{ transform: `translate(${x0}px,${y0}px)` }, { transform: `translate(${x0 + dx}px,${y0}px)` }], { ...timing, easing: 'cubic-bezier(.45,0,.7,1)' });
    mid.animate([
      { transform: 'translateY(0)', easing: 'cubic-bezier(.2,.75,.4,1)' },
      { transform: 'translateY(-64px)', offset: 0.36, easing: 'cubic-bezier(.6,0,.85,.55)' },
      { transform: `translateY(${dy}px)` },
    ], timing);
    drop.animate([
      { transform: 'scale(.3)', opacity: 0 },
      { transform: 'scale(1.28,.78)', opacity: 1, offset: 0.12 },
      { transform: 'scale(.9,1.12)', opacity: 1, offset: 0.24 },
      { transform: 'scale(1)', opacity: 1, offset: 0.36 },
      // 48号抛光③：下落途中拉成 (1.15, .85) 的拖尾形，快到购物车前收回圆
      { transform: 'scale(1.15,.85)', opacity: 1, offset: 0.52 },
      { transform: 'scale(1.15,.85)', opacity: 1, offset: 0.78 },
      { transform: 'scale(1)', opacity: 1, offset: 0.86 },
      { transform: 'scale(1.32,.68)', opacity: 1, offset: 0.93 },
      { transform: 'scale(.4)', opacity: 0 },
    ], timing).finished.then(() => { el.remove(); pop(); landGlow(x0 + dx, y0 + dy); });
    return true;
  };

  const setQty = (row, q) => {
    const box = row.querySelector('.qty');
    const name = row.querySelector('.t')?.textContent || row.querySelector('.add')?.getAttribute('aria-label')?.replace(/^加购 /, '') || '';
    box.dataset.qty = q;
    box.classList.toggle('on', q > 0); // 算盘珠：有数量时减号、数字、加号装进同一个容器
    // 49号⑤：减号、数字、容器一开始就在，这里只切显示，不再临时插元素
    let minus = box.querySelector('.minus');
    let num = box.querySelector('b');
    if (!minus) { box.insertAdjacentHTML('afterbegin', `<button class="btn-round minus press" aria-label="减少 ${name}" hidden><span class="g" aria-hidden="true">−</span></button><b hidden></b>`); minus = box.querySelector('.minus'); num = box.querySelector('b'); }
    minus.hidden = q === 0;
    num.hidden = q === 0;
    num.textContent = q;
  };
  document.addEventListener('click', (e) => {
    const add = e.target.closest('.add');
    const minus = e.target.closest('.minus');
    const row = (add || minus)?.closest('[data-uid]');
    if (!row) return;
    const q = Number(row.querySelector('.qty').dataset.qty);
    const price = Number(row.dataset.price);
    if (add) { setQty(row, q + 1); count++; total += price; syncCart(!flyBlob(add)); } // 53号：加号不再单独落印，点按印章全页统一
    else if (q > 0) { setQty(row, q - 1); count--; total -= price; syncCart(); }
  });

  // 47号组件 6：Dock 选中态 = 一个浅色药丸滑到被点的页签（180ms，只动 transform；药丸宽度开页时定一次）
  $$('.dock').forEach((dock) => {
    const pill = $('.dock-pill', dock);
    if (!pill) return;
    const inset = dock.classList.contains('v1') ? 2 : 6;
    const place = (tab) => { pill.style.width = `${tab.offsetWidth - inset * 2}px`; pill.style.transform = `translateX(${tab.offsetLeft + inset}px)`; };
    pill.style.transition = 'none';
    place($('.tab.on', dock));
    void pill.offsetWidth;
    pill.style.transition = '';
    dock.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      $$('.tab', dock).forEach((t) => { t.classList.toggle('on', t === tab); if (t === tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
      place(tab);
    });
  });

  // 53号（高斯）：手指 / 鼠标点到哪里，哪里就盖一枚红色「湘」字小印（像录屏时的触点白点）——全页统一，替代原来的加号落印和触摸涟漪光。
  // 印盖下去 → 停一下 → 淡掉（0.7 秒，只动 transform / opacity）；减弱动态效果下不动，只是出现一下再消失
  document.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return; // 只认主键 / 手指
    const s = document.createElement('span');
    s.className = 'seal tap-seal';
    s.setAttribute('aria-hidden', 'true');
    s.textContent = document.body.dataset.seal || '';
    s.style.left = `${e.clientX}px`;
    s.style.top = `${e.clientY}px`;
    document.body.appendChild(s);
    if (moving() && s.animate) {
      s.animate([
        { transform: 'translate(-50%,-50%) scale(1.45) rotate(-20deg)', opacity: 0 },
        { transform: 'translate(-50%,-50%) scale(1) rotate(-8deg)', opacity: 0.92, offset: 0.2, easing: 'linear' },
        { transform: 'translate(-50%,-50%) scale(1) rotate(-8deg)', opacity: 0.92, offset: 0.55 },
        { transform: 'translate(-50%,-50%) scale(1) rotate(-8deg)', opacity: 0 },
      ], { duration: 700, easing: 'cubic-bezier(.2,.9,.3,1.2)' }).finished.then(() => s.remove());
    } else {
      s.style.opacity = '0.92';
      setTimeout(() => s.remove(), 450);
    }
  }, { passive: true });

  // 分类氛围色：滑到饮品区，背景层 2.4 秒过渡到淡绿（只动背景层；lite 档第一个砍）
  if (tier() !== 'lite' && 'IntersectionObserver' in window) {
    const seen = new Set();
    const io = new IntersectionObserver((list) => {
      list.forEach((en) => (en.isIntersecting ? seen.add(en.target) : seen.delete(en.target)));
      const on = seen.size > 0;
      if (on === document.body.classList.contains('drinks')) return;
      // 47号 G1：只有屏幕里的菜卡跑 2.4 秒过渡，屏幕外的直接换（免得留下看不见、却占主线程的动画）
      const off = $$('.card').filter((c) => { const r = c.getBoundingClientRect(); return r.bottom < 0 || r.top > innerHeight; });
      off.forEach((c) => c.classList.add('still'));
      document.body.classList.toggle('drinks', on);
      requestAnimationFrame(() => requestAnimationFrame(() => off.forEach((c) => c.classList.remove('still'))));
    }, { rootMargin: '-45% 0px -45% 0px' });
    $$('[data-drink]').forEach((g) => io.observe(g));
  }

  // 48号大画态 C 方案：触发线（240px）滑出屏幕顶部 = 收起成「今日招牌」横幅卡；滑回来再展开。用 IntersectionObserver，不在滚动里算
  const line = $('.hero-line');
  if (line && 'IntersectionObserver' in window) {
    const today = $('.today');
    new IntersectionObserver(([en]) => {
      const collapsed = !en.isIntersecting && en.boundingClientRect.top < 0;
      document.body.classList.toggle('collapsed', collapsed);
      if (today) today.inert = !collapsed; // 没收起时横幅卡在屏幕外，点不到、键盘也跳过
    }).observe(line);
  }

  // 53号大画态多张：看哪张，小点和收起后的「今日招牌」横幅卡就跟着换（IntersectionObserver，不在滚动里算）
  const track = $('.hero-track');
  if (track && 'IntersectionObserver' in window) {
    const slides = $$('.hero-slide', track);
    const dots = $$('.hero-dots i');
    const today = $('.today');
    const show = (i) => {
      dots.forEach((d, k) => d.classList.toggle('on', k === i));
      const s = slides[i];
      if (!today || !s) return;
      const name = $('.today-name', today); if (name) name.textContent = s.dataset.name;
      const price = $('.today-anchor b, .today .price', today); if (price) price.textContent = s.dataset.price;
      const go = $('.today-go', today); if (go) go.setAttribute('href', s.dataset.href);
      const img = $('.today-img img', today), src = $('.hero-img img', s); if (img && src) img.src = src.src;
    };
    const io = new IntersectionObserver((list) => list.forEach((en) => { if (en.isIntersecting) show(slides.indexOf(en.target)); }), { root: track, threshold: 0.6 });
    slides.forEach((s) => io.observe(s));
  }

  // 视差：墨晕层 0.3 倍、详情大图 0.5 倍（只在 normal 档；只改 transform）
  const ink = $('.ink');
  const hero = $('.hero-img');
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (tier() !== 'normal' || ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      if (ink) ink.style.transform = `translate3d(0,${-y * 0.3}px,0)`;
      if (hero) hero.style.transform = `translate3d(0,${y * 0.5}px,0)`;
      ticking = false;
    });
  }, { passive: true });

  // 墨迹渐显：一句一句从浅变深（Gemini 流式字）
  const reveal = (el) => $$('.ink-line', el).forEach((s, i) => setTimeout(() => s.classList.add('in'), moving() ? i * 90 : 0));
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((list) => list.forEach((en) => { if (en.isIntersecting) { reveal(en.target); io.unobserve(en.target); } }), { threshold: 0.2 });
    $$('.sec p').forEach((p) => io.observe(p));
  }

  // 拆开看看舞台：从下方升起，食材层错峰 120ms；合拢倒序收回
  const stage = $('.stage');
  const scrim = $('.scrim');
  const openStage = (open) => {
    if (!stage) return;
    stage.classList.toggle('open', open);
    scrim.classList.toggle('on', open);
    stage.setAttribute('aria-hidden', String(!open));
    stage.inert = !open; // 合拢时在屏幕外，点不到、键盘也跳过（48号起不用 visibility）
    if (open) reveal(stage);
  };
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-stage]')) openStage(true);
    if (e.target.closest('[data-close-stage]')) openStage(false);
  });
})();
