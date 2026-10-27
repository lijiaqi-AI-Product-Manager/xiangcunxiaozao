/**
 * 加菜（P2-6）
 *
 * 顾客吃到一半想再加一瓶柠檬茶。以前只能重新下一单——桌上多一个取餐号，
 * 结账要合并两张单，后厨也得多看一张票。
 *
 * 现在的流程刻意做得很短：从取餐页点「加菜」→ 直接进入点单页挑菜 → 购物车右下角出现
 * 「给 018 加菜」→ 确认。**不再问桌号、不再问付款方式**——那些都沿用原单，
 * 多问一句就多一个填错的机会，而这本来就不是顾客要做决定的事。
 */
import { useState } from 'react';
import { formatMoney, formatPickupNo, type Order as OrderT } from '@pkg/contract';
import { newRequestId, safeStorage } from '@pkg/ui-kit';
import config from 'virtual:brand';
import { addDishes } from './api.ts';

const { brand } = config;
const money = (sen: number) => `${brand.currency.symbol} ${formatMoney(sen)}`;
const payLabel = (key: string) => brand.paymentMethods.find((m) => m.key === key)?.label ?? key;

/** 当前正在给哪张单加菜（躺在 sessionStorage 里：刷新页面不该丢掉这个状态） */
const KEY = 'adding-to';
export const addingTarget = (): number | null => {
  const v = Number(safeStorage.get(KEY));
  return Number.isInteger(v) && v > 0 ? v : null;
};
export const setAddingTarget = (pickupNo: number | null) => {
  if (pickupNo === null) safeStorage.remove(KEY);
  else safeStorage.set(KEY, String(pickupNo));
};

/**
 * 「给 018 加菜」确认条。挂在点单页底部、购物车上方，只在这张单还没做完时出现。
 *
 * 为什么要有这一条：顾客点「加菜」之后进点单页，如果什么都不显示，
 * 他会以为自己又下了新的一单（而且很可能真的按「去结算」再下一单）。
 */
export function AddToBar({ target, order, onDone, onCancel }: {
  target: number;
  order: OrderT | null;
  onDone: (o: OrderT) => void;
  onCancel: () => void;
}) {
  return (
    <div className="addto-bar" role="status">
      <div>
        <strong>正在给 {formatPickupNo(target)} 号加菜</strong>
        <p className="muted small">
          {order ? `桌号 ${order.tableNo} · 付款方式沿用原单（${payLabel(order.paymentMethod)}）` : '挑好菜后点左下角「加菜」确认'}
        </p>
      </div>
      <button className="btn ghost" onClick={onCancel}>不加了</button>
    </div>
  );
}

/**
 * 加菜确认：把购物车里的东西挂到 target 那张单后面。
 *
 * 用幂等编号：手抖点两下、网络重试都只加一次。requestId 在组件挂载时生成一次，
 * 失败重试时复用同一个——这正是「顾客看到网络错误又点了一次」那个场景。
 */
export function useAddDishes(target: number | null, onDone: (o: OrderT) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rid, setRid] = useState(newRequestId);

  const submit = async (cartId: string) => {
    if (target === null) return;
    setBusy(true);
    setError(null);
    try {
      const o = await addDishes({ pickupNo: target, cartId, note: '', requestId: rid });
      setRid(newRequestId()); // 下一次加菜换一个编号
      onDone(o);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加菜没能提交，请再试一次');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit, clearError: () => setError(null) };
}

/**
 * 加菜成功后的小票式反馈：告诉顾客「加上了、号没变、这一桌现在一共多少」。
 *
 * @param floating 不在取餐页时用浮层（贴顶）。取餐页里由页面自己给个位置，
 * 不然这条回执会压住号码牌——顾客切回来就是为了看那个号。
 */
export function AddedNotice({ order, onClose, floating = false }: { order: OrderT; onClose: () => void; floating?: boolean }) {
  return (
    <div className={`panel glass added-notice${floating ? ' floating' : ''}`} role="status">
      <p className="added-title"><strong>加菜成功</strong> · 取餐号还是 {formatPickupNo(order.pickupNo)}</p>
      <p className="muted small">
        这次加了 {order.items.map((i) => `${i.name}×${i.qty}`).join('、')}（{money(order.totalSen)}）。
        这一桌现在一共 {money(order.groupTotalSen)}。
      </p>
      <button className="btn block" onClick={onClose}>知道了</button>
    </div>
  );
}

/** 给「我的订单」用：一单是不是还能加菜（没做完、没取消） */
export const canAddDishes = (o: OrderT): boolean => o.status === 'pending' || o.status === 'cooking';
