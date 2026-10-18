// 点单页（54号：小样大画态全参数进主程序）
// 进店 = 今日招牌大画（真堆叠，左右滑）+ 浮在上面的门店框 → 滑过 240px 触发线收成「今日招牌」横幅卡 → 分类条 + 水墨印基底列表 → 去结算托盘（有菜才出现）
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { formatTable, type Cart, type Dish, type Menu, type StoreStatus as StoreStatusT } from '@pkg/contract';
import { Seal } from '@pkg/ui-kit';
import { useMenu, useStoreStatus, useToday, useWait, type CartApi } from './api.ts';
import { brand, FINISHED, go, listMemory, LOGO_SEAL, money, openDish, SEAL } from './common.tsx';
import { peekRoom, pose, rubber, settle, transformOf } from './deck.ts';
import { landGlow, moving, tier } from './fx.ts';
import { thumbChars } from './thumb.ts';
import { EN, FitText, Float, HeroImg, Icon, Loaded, offscreen, Qty, Thumb, type Style } from './ui.tsx';

const HERO_LINE = 240; // 48号 C 方案触发线（参数不变）
const COLLAPSE_SHIFT = 102; // 收起后分类条往下让出横幅卡的高度
const JUMP_GAP = 8; // 点分类跳过去时，分组标题离分类条下沿多远
const BACK = 'cubic-bezier(.34,1.56,.64,1)'; // ease-out-back（49号 / 54号复用）

export function OrderPage({ cart, table }: { cart: CartApi; table: string }) {
  const [menu, retry] = useMenu();
  const [today] = useToday();
  const [sheet, setSheet] = useState(false);
  return (
    <>
      <Loaded load={menu} retry={retry}>
        {(m) => <MenuView menu={m} todayIds={today.state === 'ok' ? today.data.dishes : []} table={table} cart={cart} />}
      </Loaded>
      <Float>
        <CartBar cart={cart.cart} onOpen={() => setSheet(true)} />
        {sheet && cart.cart && <CartSheet cart={cart.cart} api={cart} onClose={() => setSheet(false)} />}
      </Float>
    </>
  );
}

/* ---------------- 门店框 ---------------- */

function StoreCard({ table, big }: { table: string; big: boolean }) {
  const [wait] = useWait();
  const [status] = useStoreStatus();
  const open = status.state !== 'ok' || status.data.open;
  return (
    <header className="store glass">
      {FINISHED && <span className="store-wm" aria-hidden="true">{brand.watermark}</span>}
      <div className="store-row">
        {LOGO_SEAL && <Seal char={LOGO_SEAL} size={big ? 'lg' : 'sm'} />}
        <span className="store-name">{brand.shortName}</span>
        <span className="chip-table">{formatTable(table)}</span>
        {wait.state === 'ok' && open && <span className="wait" aria-live="polite">当前等待约<b>{wait.data.minutes} 分钟</b></span>}
      </div>
      {brand.trustLine.length > 0 && (
        <p className="trust">{brand.trustLine.map((t, i) => <span key={t}>{i > 0 && <i className="dot-seal" aria-hidden="true" />}{t}</span>)}</p>
      )}
    </header>
  );
}

/** 不营业时的提示（23号 validStore：扫码先看营业状态；打烊显示营业时间、停止接单） */
export function ClosedNotice({ status }: { status: StoreStatusT }) {
  if (status.open) return null;
  return (
    <div className="closed-notice" role="alert">
      {status.reason === 'paused'
        ? <><strong>本店暂停接单</strong><span>请稍后再来，菜单可以先看看。</span></>
        : <><strong>本店已打烊</strong><span>{status.openAt && status.closeAt && `营业时间 ${status.openAt}–${status.closeAt}，`}菜单可以先看看。</span></>}
    </div>
  );
}

function StoreClosed() {
  const [status] = useStoreStatus();
  if (status.state !== 'ok' || status.data.open) return null;
  return <div className="closed-wrap"><ClosedNotice status={status.data} /></div>;
}

/* ---------------- 菜单 ---------------- */

interface Group { key: string; name: string; en: string; dishes: Dish[] }

function MenuView({ menu, todayIds, table, cart }: { menu: Menu; todayIds: string[]; table: string; cart: CartApi }) {
  const groups = useMemo<Group[]>(
    () => menu.categories
      .map((c) => ({ key: c.key, name: c.name, en: brand.englishLabels.categories[c.key] ?? '', dishes: menu.dishes.filter((d) => d.categoryKey === c.key) }))
      .filter((g) => g.dishes.length > 0),
    [menu],
  );
  const chars = useMemo(() => thumbChars(groups), [groups]);
  // 今日招牌：老板端挑的菜，按顺序；今日售罄的不上大画
  const heroes = useMemo(() => todayIds.map((id) => menu.dishes.find((d) => d.uid === id)).filter((d): d is Dish => Boolean(d && !d.soldOut)), [menu, todayIds]);
  const [index, setIndex] = useState(0);
  const hero = heroes[Math.min(index, heroes.length - 1)];

  const [lineOut, setLineOut] = useState(false); // 触发线滑出屏幕顶部 = 收起
  const collapsed = heroes.length > 0 && lineOut;
  const [active, setActive] = useState('all');
  const lock = useRef<string | null>(null); // 点分类后的那一段滚动里，高亮锁在目标上，不跟着中途经过的分组跳
  const catsWrap = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLElement>(null);
  const end = useRef<HTMLDivElement>(null);

  // 收起态：body.collapsed 控制横幅卡、分类条让位、纸色垫底（样式里只动 transform / opacity）
  useEffect(() => {
    document.body.classList.toggle('collapsed', collapsed);
    return () => document.body.classList.remove('collapsed');
  }, [collapsed]);
  useEffect(() => {
    const el = line.current;
    if (!el || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(([en]) => { if (en) setLineOut(!en.isIntersecting && en.boundingClientRect.top < 0); });
    io.observe(el);
    return () => io.disconnect();
  }, [heroes.length]);
  /** 吸顶后分类条下沿（收起态多让 102px） */
  const catsBottom = useCallback((isCollapsed: boolean) => {
    const w = catsWrap.current;
    if (!w) return 0;
    return parseFloat(getComputedStyle(w).top) + w.offsetHeight + (isCollapsed ? COLLAPSE_SHIFT : 0);
  }, []);
  /** 分类条此刻的下沿——按收起 / 展开的终点算（让位过渡途中不跟着抖）；还没吸顶时就是它在页面里的原位 */
  const catsLine = useCallback(() => {
    const w = catsWrap.current;
    if (!w) return 0;
    const shift = new DOMMatrixReadOnly(getComputedStyle(w).transform).m42;
    return w.getBoundingClientRect().bottom - shift + (document.body.classList.contains('collapsed') ? COLLAPSE_SHIFT : 0);
  }, []);

  // 滚动联动高亮：分类条下沿下面那条线压着哪一组，就亮哪一组；还没到第一组 = 全部。
  // 分类条收起时会往下让 102px、吸顶前还在页面里随内容走，所以每帧按它的实际位置算（一帧最多读十几个位置，很轻）
  useEffect(() => {
    const sections = [...document.querySelectorAll<HTMLElement>('.grp[data-key]')];
    let raf = 0;
    const update = () => {
      raf = 0;
      if (lock.current) return;
      const y = catsLine() + JUMP_GAP + 4;
      let key = 'all';
      // 页面最顶上 = 「全部」（第一组本来就紧贴在分类条下面，不能算成已经翻到第一组）
      if (window.scrollY >= 4) for (const s of sections) { if (s.getBoundingClientRect().top <= y) key = s.dataset.key!; else break; }
      setActive(key);
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(update); };
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('menu-spy', on);
    on();
    return () => { window.removeEventListener('scroll', on); window.removeEventListener('menu-spy', on); cancelAnimationFrame(raf); };
  }, [groups, collapsed, catsLine]);

  // 滑到饮品区，背景层 2.4 秒过渡到青绿（lite 档第一个砍）；屏幕外的菜卡直接换光，不留看不见的过渡
  useEffect(() => {
    if (tier() === 'lite' || !('IntersectionObserver' in window)) return;
    const seen = new Set<Element>();
    const io = new IntersectionObserver((list) => {
      list.forEach((en) => (en.isIntersecting ? seen.add(en.target) : seen.delete(en.target)));
      const on = seen.size > 0;
      if (on === document.body.classList.contains('drinks')) return;
      const off = [...document.querySelectorAll('.card')].filter(offscreen);
      off.forEach((c) => c.classList.add('still'));
      document.body.classList.toggle('drinks', on);
      requestAnimationFrame(() => requestAnimationFrame(() => off.forEach((c) => c.classList.remove('still'))));
    }, { rootMargin: '-45% 0px -45% 0px' });
    document.querySelectorAll('.grp[data-drink]').forEach((g) => io.observe(g));
    return () => { io.disconnect(); document.body.classList.remove('drinks'); };
  }, [groups]);

  // 首次进入：分组依次淡入（只播一次）
  useEffect(() => {
    document.querySelectorAll('.reveal').forEach((el, i) => setTimeout(() => el.classList.add('in'), moving() ? 60 * i : 0));
  }, []);

  // 最后一组下面补够高度：每个分类都能被点到正好贴在分类条下面
  useLayoutEffect(() => {
    const fit = () => {
      const last = document.querySelector<HTMLElement>('.grp[data-key]:last-of-type');
      const app = document.querySelector<HTMLElement>('.app');
      if (!last || !end.current || !app) return;
      const pad = parseFloat(getComputedStyle(app).paddingBottom) || 0;
      end.current.style.height = `${Math.max(0, window.innerHeight - catsBottom(heroes.length > 0) - JUMP_GAP - last.offsetHeight - pad)}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [groups, heroes.length, catsBottom]);

  // 从详情页返回：菜单渲染完再滚回进去之前的位置（只恢复一次）
  useLayoutEffect(() => {
    if (!listMemory.restore) return;
    listMemory.restore = false;
    window.scrollTo({ top: listMemory.scrollY });
  }, []);

  const pick = (key: string) => {
    const smooth = tier() === 'normal' || tier() === 'minimal';
    lock.current = key;
    setActive(key);
    let top = 0;
    if (key !== 'all') {
      const sec = document.querySelector<HTMLElement>(`.grp[data-key="${key}"]`);
      if (!sec) return;
      const abs = sec.getBoundingClientRect().top + window.scrollY;
      top = Math.max(0, abs - catsBottom(heroes.length > 0) - JUMP_GAP);
      // 第一组离大画太近：按收起态算出来的位置还没过 240px 触发线（这时分类条也还没吸顶）。
      // 那就停在触发线前一点——不收起，分类条在原位，第一组标题正好贴在它下面 8px
      if (heroes.length > 0 && top <= HERO_LINE) top = HERO_LINE - 1;
    }
    window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
    // 滚动停下来再交还给滚动联动（有 scrollend 用 scrollend，没有就按时间兜底）
    let done = false;
    const release = () => { if (done) return; done = true; lock.current = null; window.removeEventListener('scrollend', release); window.dispatchEvent(new Event('menu-spy')); };
    window.addEventListener('scrollend', release, { once: true });
    setTimeout(release, smooth ? 1200 : 120);
  };

  const sig = new Set(brand.signatureCategories);
  const drinks = new Set(brand.drinkCategories);
  return (
    <>
      {heroes.length > 0 ? (
        <>
          <HeroDeck dishes={heroes} store={<StoreCard table={table} big />} onIndex={setIndex} />
          <i className="hero-line" style={{ top: HERO_LINE }} ref={line} aria-hidden="true" />
          <i className="today-scrim" aria-hidden="true" />
          {hero && <TodayBanner dish={hero} collapsed={collapsed} />}
        </>
      ) : <StoreCard table={table} big={false} />}
      <StoreClosed />
      <div className="cats-wrap" ref={catsWrap}>
        <CategoryBar items={[{ key: 'all', name: '全部' }, ...groups]} active={active} onPick={pick} />
      </div>
      {groups.map((g) => (
        <section key={g.key} className="grp reveal" data-key={g.key} data-drink={drinks.has(g.key) ? '1' : undefined} aria-label={g.name}>
          <div className="grp-head">
            <h2>{g.name}</h2>
            {SEAL && <span className="sq-seal" style={{ width: 16, height: 16, fontSize: 10 }} aria-hidden="true">{SEAL}</span>}
            {FINISHED && g.en && <span className="en" aria-hidden="true">{g.en}</span>}
            <i className="rule" aria-hidden="true" />
            <span className="count">{g.dishes.length} 道</span>
          </div>
          <div className="card glass">
            {g.dishes.map((d) => <DishRow key={d.uid} dish={d} sig={sig.has(g.key)} char={chars.get(d.uid) ?? ''} qty={cart.qtyOf(d.uid)} onChange={(delta) => void cart.change(d.uid, delta)} />)}
          </div>
        </section>
      ))}
      <div className="menu-end" ref={end} aria-hidden="true" />
    </>
  );
}

function DishRow({ dish, sig, char, qty, onChange }: { dish: Dish; sig: boolean; char: string; qty: number; onChange: (delta: number) => void }) {
  const open = (e: { preventDefault: () => void }) => { e.preventDefault(); openDish(dish.uid); };
  return (
    <article className={`dish${sig ? ' sig' : ''}${dish.soldOut ? ' sold-out' : ''}`} aria-label={dish.soldOut ? `${dish.name}，今日售罄` : undefined}>
      <a href={`#dish/${dish.uid}`} className="thumb-link" tabIndex={-1} aria-hidden="true" onClick={open}><Thumb dish={dish} char={char} /></a>
      {dish.soldOut && <span className="soldout-tag">今日售罄</span>}
      <div className="row-body">
        <h3 className="row-name dish-name"><a href={`#dish/${dish.uid}`} onClick={open}><FitText text={dish.name} max={18} min={14} /></a></h3>
        {dish.hook && <p className="row-hook dish-hook">{dish.hook}</p>}
        <p className="price dish-price">{money(dish.priceSen)}{dish.unit && <small> /{dish.unit}</small>}</p>
      </div>
      {/* 28号 #5：售罄的菜照常显示、置灰、不能加购 */}
      {dish.soldOut ? <span className="soldout-note">今日售罄</span> : <Qty name={dish.name} qty={qty} onChange={onChange} />}
    </article>
  );
}

/* ---------------- 分类条：点击 = 滚动定位到那一组；滚动时高亮跟着走；右边圆环箭头 = 展开全部分类 ---------------- */

function CategoryBar({ items, active, onPick }: { items: { key: string; name: string }[]; active: string; onPick: (k: string) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<'closed' | 'open' | 'closing'>('closed');
  const [atStart, setAtStart] = useState(true);
  const [instant, setInstant] = useState(false);
  const measure = () => setAtStart((bar.current?.scrollLeft ?? 0) < 4);
  // 选中的分类自动滑进可视区（只横向滑分类条本身，不碰页面的竖向滚动）：左边让出渐隐 32px，右边让出「全部分类」按钮 100px
  useEffect(() => {
    const b = bar.current;
    const el = b?.querySelector<HTMLElement>(`[data-key="${active}"]`);
    if (!b || !el) return;
    const left = el.offsetLeft - b.scrollLeft, right = b.clientWidth - (left + el.offsetWidth);
    if (left < 32) b.scrollLeft = Math.max(0, el.offsetLeft - 32);
    else if (right < 100) b.scrollLeft = el.offsetLeft + el.offsetWidth - b.clientWidth + 100;
    measure();
  }, [active]);
  const close = () => setPanel(moving() ? 'closing' : 'closed');
  // 展开着的时候，点面板外面任何地方就收起（不挡着下面的菜）
  useEffect(() => {
    if (panel !== 'open') return;
    const on = (e: PointerEvent) => { if (!(e.target as Element).closest('.cats-wrap')) setPanel(moving() ? 'closing' : 'closed'); };
    document.addEventListener('pointerdown', on);
    return () => document.removeEventListener('pointerdown', on);
  }, [panel]);
  const pick = (k: string) => {
    // 手点的那一下立刻亮（0.2s）；滚动带出来的高亮才走 2.4s 缓动
    setInstant(true);
    setTimeout(() => setInstant(false), 400);
    if (panel === 'open') close();
    onPick(k);
  };
  return (
    <>
      <div className={`catbar${atStart ? '' : ' fade-left'}${instant ? ' instant' : ''}`} role="tablist" aria-label="菜品分类" ref={bar} onScroll={measure}>
        {items.map((c) => (
          <button key={c.key} data-key={c.key} role="tab" aria-selected={active === c.key} className="cat" onClick={() => pick(c.key)}>
            <span className="cat-t">{c.name}</span>
            <span className="cat-on" aria-hidden="true"><span className="cat-t">{c.name}</span></span>
          </button>
        ))}
      </div>
      <button className="cat-more" aria-expanded={panel === 'open'} aria-label="全部分类" onClick={() => (panel === 'open' ? close() : setPanel('open'))}>
        <span className="ring-arrow"><Icon name="arrow" ink /></span>
      </button>
      {panel !== 'closed' && (
        <div className={`cat-panel glass${panel === 'closing' ? ' closing' : ''}`} role="group" aria-label="全部分类" onAnimationEnd={() => panel === 'closing' && setPanel('closed')}>
          {items.map((c) => (
            <button key={c.key} className={active === c.key ? 'chip on' : 'chip'} aria-pressed={active === c.key} onClick={() => pick(c.key)}>{c.name}</button>
          ))}
        </div>
      )}
    </>
  );
}

/* ---------------- 54号 问题三：真堆叠大画 ---------------- */

function HeroDeck({ dishes, store, onIndex }: { dishes: Dish[]; store: React.ReactNode; onIndex: (i: number) => void }) {
  const n = dishes.length;
  const deck = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLElement | null)[]>([]);
  const [index, setIndex] = useState(0);
  const s = useRef({ index: 0, p: 0, down: false, dragging: false, x0: 0, y0: 0, dx: 0, lastX: 0, lastT: 0, v: 0, moved: false, raf: 0, anims: [] as Animation[] });

  const width = () => cards.current[0]?.offsetWidth ?? 300;
  /** 同一个进度 p 摆好所有卡（拖动时每帧调一次）：上面那张走多少，下面的就补多少 */
  const apply = useCallback((p: number) => {
    const w = width();
    cards.current.forEach((el, k) => {
      if (!el) return;
      const c = pose(k, p, w);
      el.style.transform = transformOf(c);
      el.style.opacity = String(c.opacity);
      el.style.zIndex = String(c.z);
      const shade = el.querySelector<HTMLElement>('.shade');
      if (shade) shade.style.opacity = String(c.shade);
    });
  }, []);

  useLayoutEffect(() => {
    apply(s.current.p);
    const on = () => apply(s.current.p);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [apply, n]);

  /** 松手：从当前进度动画到目标那张（0.42s ease-out-back，合成层）；减弱动态效果 = 直接淡切 */
  const goTo = useCallback((to: number) => {
    const st = s.current;
    st.anims.forEach((a) => a.finish());
    const from = st.p, w = width();
    st.p = to;
    st.index = to;
    apply(to);
    cards.current.forEach((el, k) => {
      if (!el) return;
      el.classList.toggle('front', k === to);
      el.setAttribute('aria-hidden', String(k !== to));
      if (typeof el.animate !== 'function') return;
      const a = pose(k, from, w), b = pose(k, to, w);
      if (tier() === 'static') {
        if (k === to && from !== to) st.anims.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' }));
        return;
      }
      st.anims.push(el.animate([{ transform: transformOf(a), opacity: a.opacity }, { transform: transformOf(b), opacity: b.opacity }], { duration: 420, easing: BACK }));
      const shade = el.querySelector<HTMLElement>('.shade');
      if (shade) st.anims.push(shade.animate([{ opacity: a.shade }, { opacity: b.shade }], { duration: 420, easing: 'ease-out' }));
    });
    st.anims = st.anims.slice(-12);
    setIndex(to);
    onIndex(to);
  }, [apply, onIndex]);

  const down = (e: RPointerEvent) => {
    if (e.button > 0 || n < 2) return;
    const st = s.current;
    st.anims.forEach((a) => a.finish());
    Object.assign(st, { down: true, dragging: false, moved: false, x0: e.clientX, y0: e.clientY, dx: 0, lastX: e.clientX, lastT: e.timeStamp, v: 0 });
  };
  const move = (e: RPointerEvent) => {
    const st = s.current;
    if (!st.down) return;
    const dx = e.clientX - st.x0, dy = e.clientY - st.y0;
    if (!st.dragging) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { st.down = false; return; } // 是上下翻页，交给页面滚动
      if (Math.abs(dx) < 8) return;
      st.dragging = true;
      st.moved = true;
      deck.current?.setPointerCapture(e.pointerId);
      deck.current?.classList.add('dragging');
    }
    const dt = Math.max(1, e.timeStamp - st.lastT);
    st.v = 0.7 * ((e.clientX - st.lastX) / dt) + 0.3 * st.v;
    st.lastX = e.clientX;
    st.lastT = e.timeStamp;
    st.dx = dx;
    st.p = rubber(st.index - dx / width(), n);
    if (!st.raf) st.raf = requestAnimationFrame(() => { st.raf = 0; apply(st.p); });
  };
  const up = (e: RPointerEvent) => {
    const st = s.current;
    if (!st.down) return;
    st.down = false;
    deck.current?.classList.remove('dragging');
    if (!st.dragging) return;
    st.dragging = false;
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
    if (deck.current?.hasPointerCapture(e.pointerId)) deck.current.releasePointerCapture(e.pointerId);
    goTo(e.type === 'pointercancel' ? st.index : settle(st.index, st.dx, st.v, width(), n));
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' && index < n - 1) { e.preventDefault(); goTo(index + 1); }
    if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); goTo(index - 1); }
  };

  return (
    <div
      className="deck"
      data-depth={Math.min(n, 3)}
      ref={deck}
      style={{ '--peek-room': `${peekRoom(n)}px` } as Style}
      role="region"
      aria-roledescription="carousel"
      aria-label="今日招牌"
      tabIndex={n > 1 ? 0 : -1}
      onKeyDown={key}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onClickCapture={(e) => { if (s.current.moved) { e.preventDefault(); e.stopPropagation(); s.current.moved = false; } }}
    >
      {dishes.map((d, k) => (
        <article
          key={d.uid}
          ref={(el) => { cards.current[k] = el; }}
          className={k === index ? 'deck-card front' : 'deck-card'}
          aria-roledescription="slide"
          aria-label={`${k + 1} / ${n}：${d.name}`}
          aria-hidden={k !== index}
        >
          <HeroImg dish={d} />
          <i className="hero-spot" aria-hidden="true" />
          {FINISHED && <i className="hero-paper" aria-hidden="true" />}
          {FINISHED && <span className="hero-wm" aria-hidden="true">{brand.watermark}</span>}
          {FINISHED && EN.sections.signature && <span className="en sig-v" aria-hidden="true">{EN.sections.signature}</span>}
          <a className="price-anchor" href={`#dish/${d.uid}`} draggable={false} onClick={(e) => { e.preventDefault(); openDish(d.uid); }} tabIndex={k === index ? 0 : -1}>
            <span className="pa-name"><FitText text={d.name} max={18} min={14} /></span><b>{money(d.priceSen)}</b>
          </a>
          <i className="shade" aria-hidden="true" />
        </article>
      ))}
      <div className="deck-store">{store}</div>
      {n > 1 && <div className="deck-dots" aria-hidden="true">{dishes.map((d, k) => <i key={d.uid} className={k === index ? 'on' : undefined} />)}</div>}
    </div>
  );
}

/** 收起后的「今日招牌」横幅卡：跟着大画当前那张换（菜名、价格、直达）；没收起时在屏幕外，用 inert 挡住点按和键盘 */
function TodayBanner({ dish, collapsed }: { dish: Dish; collapsed: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (ref.current) ref.current.inert = !collapsed; }, [collapsed]);
  const img = dish.images.closed;
  const goDish = (e: { preventDefault: () => void }) => { e.preventDefault(); openDish(dish.uid); };
  const label = <span className="today-label">今日招牌{FINISHED && EN.sections.signature && <span className="en" aria-hidden="true">{EN.sections.signature}</span>}</span>;
  return (
    <aside className={img ? 'today glass has-img' : 'today glass'} aria-label="今日招牌" ref={ref}>
      {img ? (
        <>
          <span className="today-img"><img src={img} alt="" /></span>
          <span className="today-txt">{label}<span className="today-name"><FitText text={dish.name} max={21} min={16} /></span><span className="price">{money(dish.priceSen)}</span></span>
          <a className="gilt press today-go" href={`#dish/${dish.uid}`} onClick={goDish}>直达</a>
        </>
      ) : (
        <>
          <i className="today-mark" aria-hidden="true" />
          <span className="today-txt">{label}<span className="today-name"><FitText text={dish.name} max={28} min={17} /></span></span>
          <span className="today-anchor"><b>{money(dish.priceSen)}</b><a className="gilt press today-go" href={`#dish/${dish.uid}`} onClick={goDish}>直达</a></span>
        </>
      )}
    </aside>
  );
}

/* ---------------- 54号 问题四：去结算托盘生灭——0 道菜不渲染；首菜弹入；清空隐去；可无限循环、不残留 ---------------- */

const ENTER: Keyframe[] = [{ transform: 'translateY(12px) scale(.92)', opacity: 0 }, { transform: 'none', opacity: 1 }];
const EXIT: Keyframe[] = [{ transform: 'none', opacity: 1 }, { transform: 'translateY(10px) scale(.94)', opacity: 0 }];

function CartBar({ cart, onOpen }: { cart: Cart | null; onOpen: () => void }) {
  const count = cart?.count ?? 0;
  const [mounted, setMounted] = useState(count > 0);
  const el = useRef<HTMLDivElement>(null);
  const anim = useRef<Animation | null>(null);
  // 隐去的那 0.26 秒里还显示最后的数量和金额，不跳成 0
  const last = useRef({ count: 0, total: 0 });
  if (count > 0 && cart) last.current = { count, total: cart.totalSen };

  useEffect(() => { if (count > 0) setMounted(true); }, [count]);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const animated = moving() && typeof node.animate === 'function';
    if (count > 0 && node.dataset.state !== 'in') {
      anim.current?.cancel();
      node.dataset.state = 'in';
      if (!animated) return;
      anim.current = node.animate(ENTER, { duration: 360, easing: BACK });
      node.querySelector('.sum')?.animate([{ transform: 'translateY(70%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 360, delay: 90, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' });
      // 落点柔光扫一次（51号）
      anim.current.finished.then(() => {
        const b = node.querySelector('.badge')?.getBoundingClientRect();
        if (b && node.dataset.state === 'in') landGlow(b.left + b.width / 2, b.top + b.height / 2);
      }, () => {});
    } else if (count === 0 && node.dataset.state === 'in') {
      node.dataset.state = 'out';
      anim.current?.cancel();
      if (!animated) { setMounted(false); return; }
      const a = node.animate(EXIT, { duration: 260, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
      anim.current = a;
      a.finished.then(() => { if (node.dataset.state === 'out') setMounted(false); }, () => {});
    }
  }, [count, mounted]);

  if (!mounted) return null;
  return (
    <div className="cartbar tray" ref={el} style={count === 0 ? { pointerEvents: 'none' } : undefined}>
      <button className="cartbar-summary" onClick={onOpen} aria-label="查看购物车">
        <span className="badge cartbar-badge" data-count>{last.current.count}</span>
        <span className="sum cartbar-total" data-total>{money(last.current.total)}</span>
      </button>
      <button className="gilt press cartbar-go" onClick={() => go('checkout')}>去结算</button>
    </div>
  );
}

function CartSheet({ cart, api, onClose }: { cart: Cart; api: CartApi; onClose: () => void }) {
  useEffect(() => { if (cart.count === 0) onClose(); }, [cart.count, onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet glass" role="dialog" aria-label="购物车" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2 className="brush-title">购物车</h2>
          <button className="link" onClick={() => void api.clear()}>清空</button>
        </header>
        <ul className="lines">
          {cart.lines.map((l) => (
            <li key={l.dishUid} className={l.available ? 'line' : 'line gone'}>
              <div className="line-name brush">
                <FitText text={l.name} max={18} min={14} />
                {!l.available && <span className="tag">{l.unavailableReason === 'soldout' ? '今日售罄' : '已下架'}</span>}
              </div>
              <div className="line-right">
                <span className="price">{money(l.subtotalSen)}</span>
                {l.available
                  ? <Qty name={l.name} qty={l.qty} onChange={(d) => void api.change(l.dishUid, d)} />
                  : <button className="link" onClick={() => void api.remove(l.dishUid)}>移除</button>}
              </div>
            </li>
          ))}
        </ul>
        <button className="gilt press sheet-go" onClick={() => go('checkout')}>去结算 · {money(cart.totalSen)}</button>
      </section>
    </div>
  );
}
