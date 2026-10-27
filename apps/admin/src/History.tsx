/**
 * 历史订单（P2-5）
 *
 * 老板的用法：「上周三 8 号桌那桌吃了什么？」「上个月剁椒鱼卖了多少份？」
 *
 * 设计上只放三个输入：日期段、关键词、状态。再多一个筛选项，老板就要开始想「这个填什么」。
 * 关键词故意不告诉他要填哪个字段——桌号、取餐号、菜名、单号，后端全试一遍，
 * 他只要记得「桌上有 8 这个字」就能找到。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  formatClock, formatMoney, formatPickupNo, formatTable, orderSearchPageSize,
  ORDER_STATUS_LABEL, OrderSearchResult, REFUND_STATE_LABEL, type Order as OrderT, type OrderStatus,
} from '@pkg/contract';
import config from 'virtual:brand';
import { adminGet } from './api.ts';
import { addDays, todayLocal as todayLocalOf } from './date-local.ts';

const { brand } = config;
const money = (sen: number) => `${brand.currency.symbol} ${formatMoney(sen)}`;
const payLabel = (key: string) => brand.paymentMethods.find((m) => m.key === key)?.label ?? key;
const PAGE = orderSearchPageSize;

const STATUS_TABS: { value: OrderStatus | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待制作' },
  { value: 'cooking', label: '制作中' },
  { value: 'done', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
];

export function HistoryPage() {
  // 默认最近 7 天，和后端不给参数时的默认值一致——前端显示的日期要能解释后端给出的结果
  const [from, setFrom] = useState(() => addDays(todayLocalOf(new Date(), brand.timezone), -6));
  const [to, setTo] = useState(() => todayLocalOf(new Date(), brand.timezone));
  const [q, setQ] = useState('');
  /** 真正发给服务器的关键词：打字时不要每敲一个字就查一次，按回车或点「查」才发 */
  const [applied, setApplied] = useState('');
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<OrderSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // 结束日期是「含」的那一天：老板选 10-25 到 10-25，意思是那一天，不是 0 小时
      const url = `/api/admin/orders/search?from=${encodeURIComponent(from)}&to=${encodeURIComponent(addDays(to, 1))}`
        + `&q=${encodeURIComponent(applied)}&status=${status}&limit=${PAGE}&offset=${page * PAGE}`;
      setData(await adminGet(url, (v) => OrderSearchResult.parse(v)));
    } catch (e) {
      setError(e instanceof Error ? e.message : '查询失败');
    } finally {
      setBusy(false);
    }
  }, [from, to, applied, status, page]);

  useEffect(() => { void load(); }, [load]);

  /** 换条件就回到第一页：否则在第 5 页上改条件，可能直接看到「没有更多了」 */
  const refilter = (fn: () => void) => { fn(); setPage(0); };

  const quick = (kind: 'today' | 'week' | 'month') => refilter(() => {
    const t = todayLocalOf(new Date(), brand.timezone);
    if (kind === 'today') { setFrom(t); setTo(t); }
    else if (kind === 'week') { setFrom(addDays(t, -6)); setTo(t); }
    else { setFrom(addDays(t, -29)); setTo(t); }
  });

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  const hint = useMemo(() => {
    if (!data) return '';
    if (data.total === 0) return '';
    return `共 ${data.total} 单，第 ${page + 1} / ${pages} 页`;
  }, [data, page, pages]);

  return (
    <div className="history">
      <div className="panel toolbar no-print">
        <label>
          <span className="muted small">从</span>
          <input type="date" value={from} max={to} onChange={(e) => refilter(() => setFrom(e.target.value))} />
        </label>
        <label>
          <span className="muted small">到</span>
          <input type="date" value={to} min={from} onChange={(e) => refilter(() => setTo(e.target.value))} />
        </label>
        <button className="btn" onClick={() => quick('today')}>今天</button>
        <button className="btn" onClick={() => quick('week')}>最近 7 天</button>
        <button className="btn" onClick={() => quick('month')}>最近 30 天</button>
        <form
          className="history-search"
          onSubmit={(e) => { e.preventDefault(); refilter(() => setApplied(q.trim())); }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="桌号 / 取餐号 / 菜名 / 单号"
            aria-label="搜索订单"
            maxLength={40}
          />
          <button className="btn primary" disabled={busy}>{busy ? '查…' : '查'}</button>
          {applied && (
            <button type="button" className="btn" onClick={() => refilter(() => { setQ(''); setApplied(''); })}>
              清空
            </button>
          )}
        </form>
      </div>

      <div className="panel toolbar no-print history-tabs">
        <div className="chips" role="group" aria-label="按状态筛选">
          {STATUS_TABS.map((s) => (
            <button
              key={s.value}
              className={status === s.value ? 'chip on' : 'chip'}
              aria-pressed={status === s.value}
              onClick={() => refilter(() => setStatus(s.value))}
            >{s.label}</button>
          ))}
        </div>
        {hint && <span className="muted small">{hint}</span>}
      </div>

      {error && <div className="panel crash" role="alert"><h2>没能查出来</h2><p className="muted">{error}</p><button className="btn" onClick={() => void load()}>重试</button></div>}
      {!data && !error && <div className="panel"><p className="muted">正在翻账…</p></div>}

      {data && (
        <>
          {/* 这三个数字是老板搜完之后第一眼想知道的：查的是哪一段、多少单、一共多少钱 */}
          <div className="panel history-sum">
            <div>
              <p className="stat-label">查询时间段</p>
              <p className="stat-mid">{data.rangeText}</p>
            </div>
            <div>
              <p className="stat-label">有效营收</p>
              <p className="stat-mid">{money(data.sumSen)}</p>
            </div>
            <div>
              <p className="stat-label">已退款</p>
              <p className="stat-mid">{data.refundSen ? `−${money(data.refundSen)}` : money(0)}</p>
            </div>
          </div>

          {data.dishes.length > 0 && (
            <div className="panel history-dishes">
              <p className="muted small">这段时间卖出去了什么（已扣除退掉的份数）</p>
              <div className="chips">
                {data.dishes.map((d) => (
                  <span key={d.name} className="dish-chip">{d.name}<b>{d.qty}</b></span>
                ))}
              </div>
            </div>
          )}

          {data.orders.length === 0 ? (
            <div className="panel empty-history">
              <h2>没有找到订单</h2>
              <p className="muted">
                {applied || status !== 'all'
                  ? '换个关键词试试，或者把时间范围放宽一点。'
                  : '这段时间没有订单。' }
              </p>
              {applied && (
                <p className="muted small">
                  现在搜的是「{applied}」，只在这段时间里找。桌号记不清就只填一个数字试试。
                </p>
              )}
            </div>
          ) : (
            <ul className="hist-list">
              {data.orders.map((o) => <HistoryRow key={o.id} order={o} />)}
            </ul>
          )}

          {pages > 1 && (
            <div className="panel toolbar no-print pager">
              <button className="btn" disabled={page === 0 || busy} onClick={() => setPage((p) => Math.max(0, p - 1))}>上一页</button>
              <span className="muted small">第 {page + 1} / {pages} 页</span>
              <button className="btn" disabled={page + 1 >= pages || busy} onClick={() => setPage((p) => p + 1)}>下一页</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 一条历史订单：收起时只看到「哪桌、几点、多少钱」，点开才是明细 */
function HistoryRow({ order }: { order: OrderT }) {
  const [open, setOpen] = useState(false);
  const refunded = order.refunds.reduce((n, r) => n + r.qty, 0);
  return (
    <li className={open ? 'hist-item open' : 'hist-item'}>
      <button className="hist-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="hist-when">
          {order.businessDate.slice(5)} {formatClock(order.createdAt, brand.timezone)}
        </span>
        <span className="hist-no">{formatPickupNo(order.pickupNo)}</span>
        <span className="hist-table">{formatTable(order.tableNo)}</span>
        <span className="hist-items muted">{order.items.map((i) => `${i.name}×${i.qty}`).join('、')}</span>
        <span className={order.status === 'cancelled' ? 'hist-sum void' : 'hist-sum'}>
          {order.status === 'cancelled' ? '已取消' : money(order.totalSen)}
        </span>
        {order.refundState !== 'none' && <span className="refund-badge">{REFUND_STATE_LABEL[order.refundState]}</span>}
        <span className="hist-caret" aria-hidden="true">{open ? '收起' : '明细'}</span>
      </button>
      {open && (
        <div className="hist-body">
          <p className="muted small">
            {ORDER_STATUS_LABEL[order.status]} · {payLabel(order.paymentMethod)}
            {order.storedSen > 0 && order.otherSen > 0 && `（储值 ${money(order.storedSen)} + ${money(order.otherSen)}）`}
            {order.cancelReason && ` · 取消原因：${order.cancelReason}`}
          </p>
          <ul>
            {order.items.map((i) => (
              <li key={i.line}>
                <span>
                  {i.code} {i.name}
                  {i.spice && <em className="item-spice">{i.spice}</em>}
                  {i.refundedQty > 0 && <em className="refunded"> 已退 {i.refundedQty}</em>}
                  {i.note && <span className="item-note"> · {i.note}</span>}
                </span>
                <span>{money(i.priceSen)} × {i.qty}</span>
              </li>
            ))}
          </ul>
          {order.note && <p className="note">备注：{order.note}</p>}
          {order.refunds.length > 0 && (
            <div className="hist-refunds">
              <p className="muted small">退款记录（共 {refunded} 份，{money(order.refundedSen)}）</p>
              {order.refunds.map((r) => (
                <p key={r.id} className="muted small">
                  {formatClock(r.at, brand.timezone)} {r.name} ×{r.qty} {money(r.amountSen)} · {r.reason}
                  {r.storedSen > 0 && `（退回储值 ${money(r.storedSen)}）`}
                  {r.counterSen > 0 && `（柜台退 ${money(r.counterSen)}）`}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
