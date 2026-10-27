import { useEffect, useState } from 'react';
import { CounterRefund, formatDateTime, formatPickupNo, formatMoney, formatTable, Order, type CounterRefund as CounterRefundT, type Order as OrderT } from '@pkg/contract';
import config from 'virtual:brand';
import { z } from 'zod';
import { adminGet, adminPost } from './api.ts';
import { askConfirm } from './Confirm.tsx';

const { brand } = config;
const money = (sen: number) => `${brand.currency.symbol} ${formatMoney(sen)}`;
const payLabel = (key: string) => brand.paymentMethods.find((m) => m.key === key)?.label ?? key;
const REASONS = ['菜品问题', '上错菜', '客人退菜'];

function newRequestId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * 按菜品行部分退款（28号 §三-2/3）：每行选退几份（不能超过还剩的份数），写原因，二次确认。
 * 预览里写清楚：多少原路退回储值、多少要在柜台退还。
 */
export function RefundBox({ order, onDone, onClose }: { order: OrderT; onDone: (o: OrderT) => void; onClose: () => void }) {
  const [qty, setQty] = useState<Record<number, number>>({});
  const [reason, setReason] = useState('');
  const [requestId] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const storedLeft = order.storedSen - order.refunds.reduce((n, r) => n + r.storedSen, 0);
  const amount = order.items.reduce((n, i) => n + i.priceSen * (qty[i.line] ?? 0), 0);
  const toStored = Math.min(amount, Math.max(0, storedLeft));
  const toCounter = amount - toStored;

  const submit = async () => {
    if (amount === 0) { setError('请选择要退的菜品和份数'); return; }
    if (!reason.trim()) { setError('请写退款原因'); return; }
    const parts = [toStored > 0 ? `原路退回储值 ${money(toStored)}` : '', toCounter > 0 ? `柜台退还 ${money(toCounter)}` : ''].filter(Boolean).join('，');
    const ok = await askConfirm({
      title: `确认给 ${formatPickupNo(order.pickupNo)} 号单退款 ${money(amount)}？`,
      detail: `${parts}\n原因：${reason.trim()}`,
      confirmText: '确认退款', danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const lines = Object.entries(qty).filter(([, q]) => q > 0).map(([line, q]) => ({ line: Number(line), qty: q }));
      onDone(await adminPost(`/api/admin/orders/${order.id}/refund`, { lines, reason, requestId }, (v) => Order.parse(v)));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '退款失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="refund-box" role="group" aria-label={`${formatPickupNo(order.pickupNo)} 号单退款`}>
      <ul>
        {order.items.map((i) => {
          const left = i.qty - i.refundedQty;
          const q = qty[i.line] ?? 0;
          return (
            <li key={i.line}>
              <span>{i.name}<span className="muted small"> 下单 {i.qty}{i.refundedQty ? ` · 已退 ${i.refundedQty}` : ''}</span></span>
              <span className="mini-stepper">
                <button className="btn" disabled={q === 0} onClick={() => setQty({ ...qty, [i.line]: q - 1 })} aria-label={`少退一份 ${i.name}`}>−</button>
                <span aria-label={`${i.name} 退 ${q} 份`}>{q}</span>
                <button className="btn" disabled={q >= left} onClick={() => setQty({ ...qty, [i.line]: q + 1 })} aria-label={`多退一份 ${i.name}`}>+</button>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="chips">
        {REASONS.map((r) => <button key={r} className={reason === r ? 'chip on' : 'chip'} aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>)}
      </div>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="或者自己写原因" aria-label="退款原因" />
      {amount > 0 && (
        <p className="small" role="status">
          退款 {money(amount)}{toStored > 0 && `：原路退回储值 ${money(toStored)}`}{toCounter > 0 && `${toStored > 0 ? '，' : '：'}柜台退还 ${money(toCounter)}`}
        </p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <span className="actions">
        <button className="btn" onClick={onClose}>返回</button>
        <button className="btn danger" disabled={busy || amount === 0 || !reason.trim()} onClick={() => void submit()}>确认退款</button>
      </span>
    </div>
  );
}

/** 待柜台退还：非储值部分的退款，老板在柜台把钱退给顾客后点「已退还」；当初没收到钱就点「未收款无需退」 */
export function CounterRefundsPanel({ version }: { version: string }) {
  const [list, setList] = useState<CounterRefundT[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = () => adminGet('/api/admin/counter-refunds', (v) => z.array(CounterRefund).parse(v)).then(setList).catch(() => {});
  useEffect(() => { void load(); }, [version]);
  const resolve = async (id: number, resolution: 'refunded' | 'not-collected') => {
    try {
      await adminPost(`/api/admin/counter-refunds/${id}/resolve`, { resolution }, (v) => CounterRefund.parse(v));
      setError(null);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    }
  };
  if (list.length === 0) return null;
  return (
    <div className="panel counter-refunds" role="region" aria-label="待柜台退还">
      <h2>待柜台退还 <span className="count">{list.length}</span></h2>
      {list.map((c) => (
        <div key={c.id} className="counter-row">
          <span><strong>{formatPickupNo(c.pickupNo)}</strong> · {formatTable(c.tableNo)} · {payLabel(c.method)} <strong className="alert-text">{money(c.amountSen)}</strong></span>
          <span className="muted small">{formatDateTime(c.createdAt, brand.timezone, true)}</span>
          <span className="actions">
            <button className="btn primary" onClick={() => void resolve(c.id, 'refunded')}>已退还</button>
            <button className="btn" onClick={() => void resolve(c.id, 'not-collected')}>未收款，无需退</button>
          </span>
        </div>
      ))}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
