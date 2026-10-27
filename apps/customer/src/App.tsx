import { useEffect, useMemo, useState } from 'react';
import { safeStorage, Watermark } from '@pkg/ui-kit';
import { Order } from '@pkg/contract';
import { deviceId, useCart, useMember, useMyOrders } from './api.ts';
import { AddedNotice, addingTarget, AddToBar, setAddingTarget } from './AddDishes.tsx';
import { AskHost } from './ask.tsx';
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
const tableFromQr = () => new URLSearchParams(location.search).get('table') || '';
/**
 * 桌号**来自二维码**（P2-2）时算「锁定」：显示成只读胶囊，要改必须点「改桌号」并确认。
 * 为什么：12 和 21 在数字小键盘上挨着，顾客手滑改一下，菜就送到隔壁桌去了，
 * 而这个错后厨和顾客两边都要花时间收拾。扫码进来的桌号基本不会错，就该默认锁住。
 * 上次记住的桌号（last-table）不锁——那是顾客自己填的，可能这次坐的是别的桌。
 */
const initialTable = () => tableFromQr() || safeStorage.get('last-table') || '';

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [toast, setToast] = useState<string | null>(null);
  const [table, setTable] = useState(initialTable);
  // 扫码进来的桌号先锁住（P2-2）
  const [tableLocked, setTableLocked] = useState(() => tableFromQr() !== '');
  const cart = useCart();
  const member = useMember();
  /**
   * 正在给哪个取餐号加菜（P2-6）。
   *
   * 加菜不是新的一单：流程是「取餐页点加菜 → 回点单页挑菜 → 点左下角确认」。
   * 中间那一步用的就是平常的点单页，所以只多记一个「给谁加」的状态，
   * 购物车的逻辑一行都不用改。
   */
  const [addingTo, setAddingTo] = useState<number | null>(addingTarget);
  const [added, setAdded] = useState<Order | null>(null);
  // 加菜时要知道原单的桌号 / 付款方式，好让顾客确认「加在哪一桌、钱怎么付」
  const [mine] = useMyOrders(deviceId());
  const addTarget = useMemo(
    () => (addingTo === null ? null : (mine.state === 'ok' ? mine.data.find((o) => o.pickupNo === addingTo && o.parentOrderId === null) ?? null : null)),
    [addingTo, mine],
  );
  const beginAdd = (pickupNo: number) => {
    setAddingTo(pickupNo);
    setAddingTarget(pickupNo);
    setAdded(null);
    go('order');
  };
  const stopAdd = () => { setAddingTo(null); setAddingTarget(null); };

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
  // 设备号用固定的那一个，跟购物车无关——购物车会被清空、车号会换，但「我的订单」必须一直查得到
  const device = deviceId();
  return (
    <>
      <IconDefs />
      <Atmosphere />
      <AskHost />
      <div className="app">
        {/* 四页切换只淡入（不推挤位移） */}
        <main key={route.startsWith('dish/') || route === 'checkout' ? route : activeTab} className="page-in">
          {route === 'order' && <OrderPage cart={cart} table={table} addingTo={addingTo} />}
          {route.startsWith('dish/') && <DishDetail uid={route.slice(5)} cart={cart} />}
          {route === 'checkout' && (
            <CheckoutPage
              cart={cart} member={member} table={table} setTable={setTable}
              tableLocked={tableLocked} onUnlockTable={() => setTableLocked(false)}
              onDone={async () => { await cart.afterSubmit(); go('pickup'); }}
              addingTo={addingTo}
              onAdded={(o) => { setAdded(o); stopAdd(); go('pickup'); }}
            />
          )}
          {route === 'pickup' && (
            <PickupPage
              deviceId={device}
              onBuyAgain={buyAgain}
              onAddDishes={beginAdd}
              notice={added ? <AddedNotice order={added} onClose={() => setAdded(null)} /> : null}
            />
          )}
          {route === 'member' && <MemberPage member={member} />}
          {route === 'me' && <MePage deviceId={device} member={member} onBuyAgain={buyAgain} onAddDishes={beginAdd} />}
        </main>
      </div>
      {FINISHED && <Watermark text={brand.watermark} />}
      <Float>
        {/* 加菜确认条：只在点单页出现。顾客手上始终知道自己是在给哪一桌加菜、不是新开一单 */}
        {addingTo !== null && route === 'order' && !added && (
          <AddToBar target={addingTo} order={addTarget} onDone={() => {}} onCancel={stopAdd} />
        )}
        {added && route !== 'pickup' && (
          <AddedNotice order={added} floating onClose={() => setAdded(null)} />
        )}
        {toast && <div className="toast" role="status">{toast}</div>}
        {/* 浮动胶囊墨玻璃 Dock + 药丸选中态（47号组件 5/6）；四页切换只淡入 */}
        <Dock active={activeTab as TabKey} />
      </Float>
    </>
  );
}
