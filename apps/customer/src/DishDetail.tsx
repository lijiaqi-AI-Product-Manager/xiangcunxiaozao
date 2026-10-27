// 菜品详情页（21号 §3.1 / 09号 §五 / 41号批准规格；54号：小样定稿进主程序）
// 顺序：大图位（实物图 / 水墨占位 + 云斑）→ 标题组（英文 + 书法菜名 + 一笔浓墨 + 方印 + 价格 + 一句话）→ 详细介绍 → 源流 → 工序 → 风味之路 → 落款 → 底部加购
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { flavorRouteLabel, takeApartView, type Dish, type TakeApartView } from '@pkg/contract';
import { DishImage, Seal } from '@pkg/ui-kit';
import { useMenu, type CartApi } from './api.ts';
import { backToList, brand, FINISHED, go, LOGO_SEAL, money, SEAL } from './common.tsx';
import { tier } from './fx.ts';
import { EN, EmptyState, FitText, Float, HeroImg, Icon, InkText, Loaded, Qty, SecHead } from './ui.tsx';

/** 54号 问题五：标题组三个变体，交高斯定夺（?lockup=1|2|3；默认 1 = 侧边瘦身，主推） */
const LOCKUP = (() => {
  const q = new URLSearchParams(location.search).get('lockup');
  return q === '2' || q === '3' ? q : '1';
})();

export function DishDetail({ uid, cart }: { uid: string; cart: CartApi }) {
  const [menu, retry] = useMenu();
  return (
    <Loaded load={menu} retry={retry}>
      {(m) => {
        const dish = m.dishes.find((d) => d.uid === uid);
        if (!dish) {
          return (
            <EmptyState title="没有找到这道菜">
              <p className="muted">可能已经下架了。</p>
              <button className="btn" onClick={() => go('order')}>回到菜单</button>
            </EmptyState>
          );
        }
        const category = m.categories.find((c) => c.key === dish.categoryKey)?.name ?? null;
        // 按菜区分组件：从一道菜跳到另一道菜时，「拆开看看」回到合拢状态，不沿用上一道菜的展开
        return <Detail key={dish.uid} dish={dish} category={category} cart={cart} />;
      }}
    </Loaded>
  );
}

function Detail({ dish, category, cart }: { dish: Dish; category: string | null; cart: CartApi }) {
  const hasCopy = Boolean(dish.intro || dish.origin || dish.steps.length || dish.ingredients.length);
  // 34号 B：主食这类本来就不需要介绍的，只显示图、菜名、价格，不写「整理中」（那是不会兑现的承诺）
  const plain = brand.plainDetailCategories.includes(dish.categoryKey);
  const route = flavorRouteLabel(dish.flavorRoute);
  const view = takeApartView(dish);
  const [open, setOpen] = useState(false);
  const hero = useRef<HTMLDivElement>(null);
  const en = EN.categories[dish.categoryKey] ?? '';

  // 视差：详情大图 0.5 倍（只在 normal 档；只改 transform）
  useEffect(() => {
    let ticking = false;
    const on = () => {
      if (tier() !== 'normal' || ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const img = hero.current?.querySelector<HTMLElement>('.hero-img');
        if (img) img.style.transform = `translate3d(0,${window.scrollY * 0.5}px,0)`;
        ticking = false;
      });
    };
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  return (
    <article className="detail" aria-label={dish.name}>
      <div className={dish.soldOut ? 'detail-hero sold-out' : 'detail-hero'} ref={hero}>
        {/* 详情页大图位：和点单页小格子是同一张图（老板传一次，两处都有）。首屏元素，立刻加载 */}
        <HeroImg dish={dish} cloud eager />
        <div className="top-btns">
          <button className="circle-btn glass press" aria-label="返回菜单" onClick={backToList}><Icon name="back" ink /></button>
          <span className="code-chip glass">{category}{dish.code && <> · <span className="detail-code">{dish.code}</span></>}</span>
        </div>
        {dish.soldOut && <span className="soldout-tag">今日售罄</span>}
        {/* 没有任何可拆的内容（批准稿没写食材、图也没到）就不放按钮，免得点开是空的 */}
        {view && (
          <div className="xbtn-wrap">
            <button className="xbtn press" aria-expanded={open} aria-controls={`takeapart-${dish.uid}`} onClick={() => setOpen(true)}>
              拆开看看<small>{dish.ingredients.length > 0 ? `${dish.ingredients.length} 样食材` : '看看里面有什么'}</small>
            </button>
            {FINISHED && EN.sections.takeApart && <span className="en" aria-hidden="true">{EN.sections.takeApart}</span>}
          </div>
        )}
      </div>

      <div className="dsheet">
        <header className={`d-head lockup-v${LOCKUP}`}>
          {FINISHED && en && <span className="en lockup-en" aria-hidden="true">{en}</span>}
          <div className="d-head-main">
            <div className="lockup-main">
              <h1 className="d-title detail-name"><FitText text={dish.name} max={34} min={22} /></h1>
              {FINISHED && <i className="lockup-stroke" aria-hidden="true" />}
              {SEAL && <span className="sq-seal" style={{ width: 30, height: 30, fontSize: 19 }} aria-hidden="true">{SEAL}</span>}
            </div>
            <p className="d-price detail-price">{money(dish.priceSen)}{dish.unit && <span className="dish-unit"> / {dish.unit}</span>}</p>
            {dish.hook && <p className="d-hook detail-hook">{dish.hook}</p>}
          </div>
        </header>

        {/* 不拆开看看的菜（饮品、主食）没有展开层，食材档案单独成一块 */}
        {dish.disassembly === 'none' && dish.ingredients.length > 0 && (
          <section className="sec">
            <SecHead zh="食材档案" en={EN.sections.ingredients} />
            <ul className="ingredients">
              {dish.ingredients.map((i) => <li key={i.name}><strong>{i.name}</strong>{i.note && <p>{i.note}</p>}</li>)}
            </ul>
          </section>
        )}

        {dish.intro && (
          <section className="sec">
            <SecHead zh="详细介绍" en={EN.sections.intro} />
            <InkText text={dish.intro} />
          </section>
        )}

        {dish.origin && (
          <section className="sec paper">
            <SecHead zh="源流" en={EN.sections.origin} />
            <InkText text={dish.origin} />
          </section>
        )}

        {dish.steps.length > 0 && (
          <section className="sec">
            <SecHead zh={`工序${dish.steps.length === 3 ? '三步' : ''}`} en={EN.sections.steps} />
            <ol className="steps">
              {dish.steps.map((s, i) => <li key={s} className="step"><b aria-hidden="true">{String(i + 1).padStart(2, '0')}</b><span>{s}</span></li>)}
            </ol>
          </section>
        )}

        {route && (
          <section className="sec">
            <SecHead zh="风味之路" en={EN.sections.flavorRoute} />
            <div className="route">
              <span className="route-tag glass">{route}</span>
              {SEAL && <span className="sq-seal" style={{ width: 30, height: 30, fontSize: 19 }} aria-hidden="true">{SEAL}</span>}
            </div>
          </section>
        )}

        {/* 批准稿里还没写文案的菜：只说「在整理」，不编任何介绍 */}
        {!hasCopy && !plain && <section className="pending-copy glass"><p className="muted">这道菜的详细介绍正在整理中。</p></section>}

        {/* 落款：一枚中号圆戳 + 店名 */}
        {LOGO_SEAL && <footer className="colophon" aria-hidden="true"><span>{brand.shortName}</span><Seal char={LOGO_SEAL} size="md" /></footer>}
        <div style={{ height: 40 }} />
      </div>

      <Float>
        {view && <TakeApart dish={dish} view={view} open={open} onClose={() => setOpen(false)} />}
        <DetailBar dish={dish} cart={cart} />
      </Float>
    </article>
  );
}

/**
 * 拆开看看（24号 #15 双轨）：舞台从下方升起盖住大图。
 * - S 级双图法：显示 9:16 分解图；B 级标注层：在合拢图上标出每样食材的位置；
 * - 图或坐标还没到位时，统一退回「食材层」：食材逐层从下往上升起（09号 §五.1，错峰 120ms），合拢时倒序收回。
 */
function TakeApart({ dish, view, open, onClose }: { dish: Dish; view: TakeApartView; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (ref.current) ref.current.inert = !open; }, [open]);
  const exploded = view === 'exploded' ? dish.images.exploded : null;
  const pins = view === 'pins';
  const n = dish.ingredients.length;
  const pending = dish.disassembly === 'dual-image' ? '分解图上线中' : '标注图上线中';
  return (
    <>
      <div className={open ? 'scrim on' : 'scrim'} onClick={onClose} aria-hidden="true" />
      <section id={`takeapart-${dish.uid}`} ref={ref} className={open ? 'explode open' : 'explode'} style={{ '--n': n } as CSSProperties} aria-label="拆开看看" aria-hidden={!open}>
        <div className="stage-head">
          <h3 className="brush-title">拆开看看</h3>
          {FINISHED && <span className="en" aria-hidden="true">{EN.sections.takeApart} · {n}</span>}
          <button className="pill-btn glass press" aria-expanded={open} aria-controls={`takeapart-${dish.uid}`} onClick={onClose}>合拢<Icon name="arrow" ink /></button>
        </div>
        <div className="explode-inner">
          {exploded && <div className="explode-img"><DishImage src={exploded} name={`${dish.name} 分解图`} ratio="9 / 16" /></div>}
          {pins && (
            <div className="pinned">
              <DishImage src={dish.images.closed} name={dish.name} />
              {dish.annotations.map((a, i) => (
                <span key={a.ingredient} className="pin" style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%`, '--i': i } as CSSProperties}>{a.ingredient}</span>
              ))}
            </div>
          )}
          {n > 0 ? (
            <ol className="layers">
              {dish.ingredients.map((ing, i) => (
                <li key={ing.name} className="layer" style={{ '--i': i, '--r': n - 1 - i } as CSSProperties}>
                  <span className="layer-pic" aria-hidden="true">{FINISHED ? ing.name : ''}</span>
                  <div>
                    <strong className="layer-name brush">{ing.name}</strong>
                    {ing.note && <p className="layer-note">{ing.note}</p>}
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="muted">食材档案整理中。</p>}
          {!exploded && !pins && <p className="muted small explode-caption">{pending}，先看食材清单</p>}
        </div>
      </section>
    </>
  );
}

function DetailBar({ dish, cart }: { dish: Dish; cart: CartApi }) {
  const qty = cart.qtyOf(dish.uid);
  const count = cart.cart?.count ?? 0;
  return (
    <div className="dbar glass blur">
      <span className="price detailbar-price">{money(dish.priceSen)}</span>
      {dish.soldOut
        ? <span className="soldout-note">今日售罄</span>
        : !dish.orderable
          ? <span className="soldout-note">暂不可点</span>
          : <Qty name={dish.name} qty={qty} onChange={(d) => void cart.change(dish.uid, d)} />}
      {count > 0 && <button className="gilt press cartbar-go" onClick={() => go('checkout')}>去结算 · <span data-count>{count}</span></button>}
    </div>
  );
}
