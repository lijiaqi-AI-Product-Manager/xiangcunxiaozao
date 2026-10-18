import { useEffect, useState } from 'react';
import {
  formatClock, formatDateTime, formatPickupNo, formatPrice, formatTable, NEXT_STATUS, Order, ORDER_STATUS_LABEL, paymentText, ReconcileRun,
  REFUND_STATE_LABEL, StoreStatus,
  type Order as OrderT, type OrderStatus, type ReconcileRun as ReconcileRunT, type StoreStatus as StoreStatusT,
} from '@pkg/contract';
import { fetchJson, postJson } from '@pkg/ui-kit';
import config from 'virtual:brand';
import { z } from 'zod';
import { DashboardPage } from './Dashboard.tsx';
import { DishesPage } from './Dishes.tsx';
import { adminGet, adminPost, getToken, login, setToken, setUnauthorizedHandler, useLiveOrders, WaitSettings } from './api.ts';
import { chimeReady, playChime, unlockChime } from './chime.ts';
import { MembersPage } from './Members.tsx';
import { CounterRefundsPanel, RefundBox } from './Refunds.tsx';
import { StoreInfoPage } from './StoreInfo.tsx';

const { brand } = config;
const money = (sen: number | null | undefined) => `${brand.currency.symbol} ${formatPrice(sen)}`;
const payLabel = (key: string) => brand.paymentMethods.find((m) => m.key === key)?.label ?? key;

const MODULES = [
  { key: 'orders', label: '实时订单', todo: '' },
  { key: 'dishes', label: '菜品管理', todo: '' },
  { key: 'members', label: '会员管理', todo: '' },
  { key: 'dashboard', label: '数据看板', todo: '' },
  { key: 'store', label: '门店信息', todo: '' },
  { key: 'import', label: '会员导入', todo: '老系统会员数据导入：先试跑出报告，确认后再正式导入。等老系统导出样例到位后开发。' },
] as const;
type Key = (typeof MODULES)[number]['key'];

const readKey = (): Key => {
  const h = location.hash.slice(1);
  return MODULES.some((m) => m.key === h) ? (h as Key) : 'orders';
};

export function App() {
  const [authed, setAuthed] = useState(() => Boolean(getToken()));
  useEffect(() => setUnauthorizedHandler(() => setAuthed(false)), []);
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Shell onLogout={() => { void postJson('/api/admin/logout', {}, () => null, getToken()).catch(() => {}); setToken(null); setAuthed(false); }} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel login" onSubmit={(e) => void submit(e)}>
      <h1>{brand.shortName}<span>经营后台</span></h1>
      <label className="field">
        <span>老板密码</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy || !password}>{busy ? '登录中…' : '登录'}</button>
    </form>
  );
}

/** 27号 #9：对账不一致时，老板端任何页面顶部都显示横幅，并在「开始接单」旁亮红点 */
function useReconcileAlert() {
  const [last, setLast] = useState<ReconcileRunT | null>(null);
  useEffect(() => {
    const load = () => void adminGet('/api/admin/reconcile', (v) => z.object({ last: ReconcileRun.nullable() }).parse(v).last).then(setLast).catch(() => {});
    load();
    const t = setInterval(load, 5 * 60000);
    window.addEventListener('reconcile-changed', load);
    return () => { clearInterval(t); window.removeEventListener('reconcile-changed', load); };
  }, []);
  return last && last.mismatches.length > 0 ? last : null;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const [key, setKey] = useState<Key>(readKey);
  const alert = useReconcileAlert();
  useEffect(() => {
    const on = () => setKey(readKey());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const mod = MODULES.find((m) => m.key === key)!;
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">{brand.shortName}<span>经营后台</span></div>
        <nav>
          {MODULES.map((m) => (
            <a key={m.key} href={`#${m.key}`} className={m.key === key ? 'nav active' : 'nav'}>
              {m.label}{m.key === 'members' && alert && <span className="dot" aria-label="对账异常" />}
            </a>
          ))}
        </nav>
        <button className="link logout" onClick={onLogout}>退出登录</button>
      </aside>
      <main className="main">
        {alert && (
          <div className="global-alert no-print" role="alert">
            <strong>对账发现 {alert.mismatches.length} 处不一致</strong>
            <span>会员 {alert.mismatches.map((m) => m.memberNo).join('、')} 的余额与流水合计对不上（{formatDateTime(alert.at, brand.timezone)}），请立刻核查。</span>
            <a href="#members">去会员管理 →</a>
          </div>
        )}
        <h1 className="no-print">{mod.label}</h1>
        {key === 'orders' && <OrdersBoard reconcileAlert={Boolean(alert)} />}
        {key === 'dishes' && <DishesPage />}
        {key === 'members' && <MembersPage />}
        {key === 'dashboard' && <DashboardPage />}
        {key === 'store' && <StoreInfoPage />}
        {mod.todo && <div className="panel"><p className="muted">{mod.todo}</p></div>}
      </main>
    </div>
  );
}

/* ---------------- 实时订单 ---------------- */

const COLUMNS: { status: OrderStatus; title: string }[] = [
  { status: 'pending', title: '新单' },
  { status: 'cooking', title: '制作中' },
  { status: 'done', title: '已完成' },
];

function OrdersBoard({ reconcileAlert }: { reconcileAlert: boolean }) {
  const [started, setStarted] = useState(chimeReady);
  const [flash, setFlash] = useState<string | null>(null);
  const live = useLiveOrders((o) => {
    playChime();
    setFlash(o.id);
    setTimeout(() => setFlash((f) => (f === o.id ? null : f)), 6000);
  });

  const start = async () => setStarted(await unlockChime());
  const cancelled = (live.orders ?? []).filter((o) => o.status === 'cancelled');
  const autoCount = cancelled.filter((o) => o.autoCancelled).length;

  return (
    <>
      <div className="toolbar">
        <span className="with-dot">
          {started
            ? <span className="pill on">● 接单中 · 新单会响铃</span>
            : <button className="btn primary big" onClick={() => void start()}>开始接单（点一下开启新单提示音）</button>}
          {reconcileAlert && <a className="dot" href="#members" title="对账发现不一致，点此查看" aria-label="对账异常，去会员管理" />}
        </span>
        <span className={`pill ${live.state}`}>
          {live.state === 'live' ? '实时连接正常' : live.state === 'connecting' ? '正在连接…' : '连接中断，正在自动重连…'}
        </span>
      </div>
      <StorePanel />
      {live.error && <div className="panel crash" role="alert"><p>{live.error}</p></div>}
      <WaitPanel version={(live.orders ?? []).map((o) => o.id + o.status).join()} />
      <CounterRefundsPanel version={(live.orders ?? []).map((o) => `${o.id}${o.status}${o.refunds.length}`).join()} />
      {!live.orders ? (
        <div className="panel"><p className="muted">加载中…</p></div>
      ) : (
        <div className="board">
          {COLUMNS.map((col) => {
            const list = live.orders!.filter((o) => o.status === col.status);
            return (
              <section key={col.status} className="column" aria-label={col.title}>
                <h2>{col.title}<span className="count">{list.length}</span></h2>
                {list.length === 0 && <p className="muted small">暂无</p>}
                {list.map((o) => <OrderCard key={o.id} order={o} flash={flash === o.id} onChange={live.replace} />)}
              </section>
            );
          })}
        </div>
      )}
      {cancelled.length > 0 && (
        <details className="panel cancelled">
          <summary>
            已取消 {cancelled.length} 单
            {autoCount > 0 && <span className="auto-badge">其中 {autoCount} 单系统自动取消</span>}
          </summary>
          {/* 上轮裁决 #8：全部菜品退完后系统自动取消的单，和店员手动取消的单要一眼分得开 */}
          {cancelled.map((o) => (
            <p key={o.id} className={o.autoCancelled ? 'cancel-row auto' : 'cancel-row muted'}>
              {o.autoCancelled && <span className="auto-badge">系统自动取消</span>}
              {formatPickupNo(o.pickupNo)} · {formatTable(o.tableNo)} · 原因：{o.cancelReason ?? '—'}
            </p>
          ))}
        </details>
      )}
    </>
  );
}

const ACTION_LABEL: Partial<Record<OrderStatus, string>> = { cooking: '开始制作', done: '完成', cancelled: '取消' };
const CANCEL_REASONS = ['客人取消', '菜品售罄', '重复下单'];

function OrderCard({ order, flash, onChange }: { order: OrderT; flash: boolean; onChange: (o: OrderT) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [reason, setReason] = useState('');
  const storedLeft = order.storedSen - order.refunds.reduce((n, r) => n + r.storedSen, 0);
  const otherLeft = order.otherSen - order.refunds.reduce((n, r) => n + r.counterSen, 0);
  const move = async (to: OrderStatus) => {
    if (to === 'cancelled' && !reason.trim()) { setError('请先写取消原因'); return; }
    setBusy(true);
    setError(null);
    try {
      onChange(await adminPost(`/api/admin/orders/${order.id}/status`, { to, reason: to === 'cancelled' ? reason : null }, (v) => Order.parse(v)));
      setCancelling(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={flash ? 'ticket flash' : 'ticket'}>
      <header>
        <span className="ticket-no">{formatPickupNo(order.pickupNo)}</span>
        <span className="ticket-meta">
          <strong>{formatTable(order.tableNo)}</strong>
          <span className="muted">{formatClock(order.createdAt, brand.timezone)} · {paymentText(order, payLabel, money)}</span>
        </span>
        {order.refundState !== 'none' && <span className="refund-badge">{REFUND_STATE_LABEL[order.refundState]}</span>}
      </header>
      <ul>
        {order.items.map((i) => (
          <li key={i.line}>
            <span>{i.code} {i.name}{i.refundedQty > 0 && <em className="refunded"> 已退 {i.refundedQty}</em>}</span>
            <span>× {i.qty}</span>
          </li>
        ))}
      </ul>
      {order.note && <p className="note">备注：{order.note}</p>}
      {order.refundedSen > 0 && <p className="muted small">已退款 {money(order.refundedSen)}</p>}
      <footer>
        <span className="muted">{money(order.totalSen)}</span>
        {!cancelling && !refunding && (
          <span className="actions">
            {order.status !== 'cancelled' && order.refundState !== 'full' && (
              <button className="btn" disabled={busy} onClick={() => { setRefunding(true); setError(null); }}>退款</button>
            )}
            {NEXT_STATUS[order.status].map((to) => (
              <button key={to} className={to === 'cancelled' ? 'btn' : 'btn primary'} disabled={busy}
                onClick={() => (to === 'cancelled' ? (setCancelling(true), setError(null)) : void move(to))}>
                {ACTION_LABEL[to]}
              </button>
            ))}
          </span>
        )}
      </footer>
      {refunding && <RefundBox order={order} onDone={onChange} onClose={() => setRefunding(false)} />}
      {cancelling && (
        <div className="cancel-box" role="group" aria-label={`取消 ${formatPickupNo(order.pickupNo)} 号单`}>
          <div className="chips">
            {CANCEL_REASONS.map((r) => (
              <button key={r} className={reason === r ? 'chip on' : 'chip'} aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>
            ))}
          </div>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="或者自己写原因" aria-label="取消原因" />
          {storedLeft > 0 && <p className="muted small">储值部分：取消后 {money(storedLeft)} 会自动退回会员余额。</p>}
          {otherLeft > 0 && <p className="muted small">{payLabel(order.paymentMethod)}部分 {money(otherLeft)} 会进「待柜台退还」，未收款可在那里标记无需退。</p>}
          <span className="actions">
            <button className="btn" onClick={() => { setCancelling(false); setReason(''); setError(null); }}>返回</button>
            <button className="btn danger" disabled={busy || !reason.trim()} onClick={() => void move('cancelled')}>确认取消</button>
          </span>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <span className="sr">{ORDER_STATUS_LABEL[order.status]}</span>
    </article>
  );
}

/** 营业状态：暂停/恢复接单（24号 #10），营业时间（支持跨夜，如 17:00–02:00） */
function StorePanel() {
  const [s, setS] = useState<StoreStatusT | null>(null);
  const [openAt, setOpenAt] = useState('');
  const [closeAt, setCloseAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const apply = (p: Promise<StoreStatusT>) =>
    p.then((v) => { setS(v); setOpenAt(v.openAt ?? ''); setCloseAt(v.closeAt ?? ''); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '保存失败'));
  useEffect(() => {
    void apply(fetchJson('/api/store/status', (v) => StoreStatus.parse(v)));
    const t = setInterval(() => void fetchJson('/api/store/status', (v) => StoreStatus.parse(v)).then(setS).catch(() => {}), 60000);
    return () => clearInterval(t);
  }, []);
  if (!s) return null;
  const save = (body: Record<string, unknown>) => void apply(adminPost('/api/admin/store', body, (v) => StoreStatus.parse(v)));
  const label = s.open ? '营业中 · 正在接单' : s.reason === 'paused' ? '已暂停接单' : `已打烊（营业时间 ${s.openAt}–${s.closeAt}）`;
  return (
    <div className={s.open ? 'panel store' : 'panel store closed'}>
      <strong className="store-state" role="status">{label}</strong>
      {s.reason === 'paused'
        ? <button className="btn primary" onClick={() => save({ paused: false })}>恢复接单</button>
        : <button className="btn" onClick={() => { if (window.confirm('确认暂停接单？顾客将无法下单，直到你点「恢复接单」。')) save({ paused: true }); }}>暂停接单</button>}
      <label>营业时间 <input type="time" value={openAt} onChange={(e) => setOpenAt(e.target.value)} aria-label="开门时间" /> –
        <input type="time" value={closeAt} onChange={(e) => setCloseAt(e.target.value)} aria-label="打烊时间" />
        <button className="btn" onClick={() => save({ openAt, closeAt })}>保存</button>
      </label>
      <span className="muted small">两个都不填 = 不按时间限制；打烊后顾客端停止接单</span>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

/** version：订单列表的「指纹」，有新单或状态变化就变，面板随之刷新顾客看到的等待时长 */
function WaitPanel({ version }: { version: string }) {
  const [s, setS] = useState<WaitSettings | null>(null);
  const [mpo, setMpo] = useState('');
  const [manual, setManual] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = (p: Promise<WaitSettings>) =>
    p.then((v) => { setS(v); setMpo(String(v.minutesPerOrder)); setManual(v.manualMinutes === null ? '' : String(v.manualMinutes)); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '保存失败'));
  useEffect(() => { void load(adminGet('/api/admin/wait', (v) => WaitSettings.parse(v))); }, []);
  // 只刷新显示的数字，不动老板正在输入的框
  useEffect(() => {
    void adminGet('/api/admin/wait', (v) => WaitSettings.parse(v)).then(setS).catch(() => {});
  }, [version]);
  const save = (body: Record<string, unknown>) => void load(adminPost('/api/admin/wait', body, (v) => WaitSettings.parse(v)));
  if (!s) return null;
  return (
    <div className="panel wait">
      <div>
        <span className="muted">顾客看到的等待时长</span>
        <strong className="wait-now">约 {s.current.minutes} 分钟</strong>
        <span className="muted">{s.current.source === 'manual' ? '（手动设置）' : `（自动：前面 ${s.current.queue} 单）`}</span>
      </div>
      <label>每单平均 <input type="number" min={1} max={120} value={mpo} onChange={(e) => setMpo(e.target.value)} /> 分钟
        <button className="btn" onClick={() => save({ minutesPerOrder: Number(mpo) })}>保存</button>
      </label>
      <label>手动覆盖 <input type="number" min={0} max={300} value={manual} placeholder="自动" onChange={(e) => setManual(e.target.value)} /> 分钟
        <button className="btn" onClick={() => save({ manualMinutes: manual === '' ? null : Number(manual) })}>{manual === '' ? '恢复自动' : '设置'}</button>
      </label>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
