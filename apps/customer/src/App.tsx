import { useEffect, useState } from 'react';
import { safeStorage, Watermark } from '@pkg/ui-kit';
import { useCart, useMember } from './api.ts';
import { brand, FINISHED, go, LOGO_SEAL } from './common.tsx';
import { DishDetail } from './DishDetail.tsx';
import { installTapSeal, watchFrameRate } from './fx.ts';
import { OrderPage } from './Order.tsx';
import { CheckoutPage, MemberPage, MePage, PickupPage } from './Pages.tsx';
import { Atmosphere, Dock, Float, IconDefs, type TabKey } from './ui.tsx';

// 23号 §3.1 / 24号：底部四个页签，首页内容并入点单页顶部；结算和菜品详情是点单下的页面，不是页签
const TABS = [
  { key: 'order', label: '点单' },
  { key: 'pickup', label: '取餐' },
  { key: 'member', label: '会员' },
  { key: 'me', label: '我的' },
] as const;
type Route = (typeof TABS)[number]['key'] | 'checkout' | `dish/${string}`;

const readRoute = (): Route => {
  const h = location.hash.slice(1);
  if (h.startsWith('dish/') && h.length > 5) return h as Route;
  return h === 'checkout' || TABS.some((t) => t.key === h) ? (h as Route) : 'order';
};

// 桌上二维码带桌号（22号批准），例如 ?table=12；也记住上次填的，顾客仍可修改
const initialTable = () => new URLSearchParams(location.search).get('table') ?? safeStorage.get('last-table') ?? '';

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [toast, setToast] = useState<string | null>(null);
  const [table, setTable] = useState(initialTable);
  const cart = useCart();
  const member = useMember();

  useEffect(() => {
    const on = () => setRoute(readRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => { if (cart.error) setToast(cart.error); }, [cart.error]);
  // 首秒帧率太低自动降档；点哪里盖一枚圆戳（成品态才有，骨架态没有任何品牌元素）
  useEffect(() => {
    watchFrameRate();
    return LOGO_SEAL ? installTapSeal(LOGO_SEAL) : undefined;
  }, []);

  const buyAgain = async (orderId: string) => {
    try {
      const skipped = await cart.buyAgain(orderId);
      setToast(skipped.length ? `已加入购物车；以下菜品已下架未加入：${skipped.join('、')}` : '已把上一单加入购物车');
      go('order');
    } catch (e) {
      setToast(e instanceof Error ? e.message : '没能加入购物车');
    }
  };

  const activeTab = route === 'checkout' || route.startsWith('dish/') ? 'order' : route;
  return (
    <>
      <IconDefs />
      <Atmosphere />
      <div className="app">
        {/* 四页切换只淡入（不推挤位移） */}
        <main key={route.startsWith('dish/') || route === 'checkout' ? route : activeTab} className="page-in">
          {route === 'order' && <OrderPage cart={cart} table={table} />}
          {route.startsWith('dish/') && <DishDetail uid={route.slice(5)} cart={cart} />}
          {route === 'checkout' && (
            <CheckoutPage cart={cart} member={member} table={table} setTable={setTable} onDone={() => { void cart.afterSubmit(); go('pickup'); }} />
          )}
          {route === 'pickup' && <PickupPage deviceId={cart.cart?.id ?? null} onBuyAgain={buyAgain} />}
          {route === 'member' && <MemberPage member={member} />}
          {route === 'me' && <MePage deviceId={cart.cart?.id ?? null} member={member} onBuyAgain={buyAgain} />}
        </main>
      </div>
      {FINISHED && <Watermark text={brand.watermark} />}
      <Float>
        {toast && <div className="toast" role="status">{toast}</div>}
        {/* 浮动胶囊墨玻璃 Dock + 药丸选中态（47号组件 5/6）；四页切换只淡入 */}
        <Dock active={activeTab as TabKey} />
      </Float>
    </>
  );
}
