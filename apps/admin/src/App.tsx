import { useEffect, useState } from 'react';
import {
  formatClock, formatDateTime, formatPickupNo, formatMoney, formatTable, NEXT_STATUS, Order, ORDER_STATUS_LABEL, paymentText, ReconcileRun,
  REFUND_STATE_LABEL, StoreStatus,
  type Order as OrderT, type OrderStatus, type ReconcileRun as ReconcileRunT, type StoreStatus as StoreStatusT,
} from '@pkg/contract';
import { fetchJson, postJson } from '@pkg/ui-kit';
import config from 'virtual:brand';
import { z } from 'zod';
import { askConfirm, ConfirmHost } from './Confirm.tsx';
import { DashboardPage } from './Dashboard.tsx';
import { DishesPage } from './Dishes.tsx';
import { ErrorsPage } from './Errors.tsx';
import { HistoryPage } from './History.tsx';
import { ReportPage } from './Report.tsx';
import { adminGet, adminPost, getToken, login, setToken, setUnauthorizedHandler, useLiveOrders, WaitSettings } from './api.ts';
import { chimeReady, playChime, unlockChime } from './chime.ts';
import { MembersPage } from './Members.tsx';
import { CounterRefundsPanel, RefundBox } from './Refunds.tsx';
import { StoreInfoPage } from './StoreInfo.tsx';
import { PrintersPage } from './Printers.tsx';

const { brand } = config;
const money = (sen: number | null | undefined) => `${brand.currency.symbol} ${formatMoney(sen)}`;
const payLabel = (key: string) => brand.paymentMethods.find((m) => m.key === key)?.label ?? key;

const MODULES = [
  { key: 'orders', label: '实时订单', todo: '' },
  { key: 'history', label: '历史订单', todo: '' },
  { key: 'dishes', label: '菜品管理', todo: '' },
  { key: 'members', label: '会员管理', todo: '' },
  { key: 'dashboard', label: '数据看板', todo: '' },
  { key: 'report', label: '日结单', todo: '' },
  { key: 'store', label: '门店信息', todo: '' },
  { key: 'printers', label: '打印设置', todo: '' },
  { key: 'errors', label: '错误日志', todo: '' },
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
  // 确认弹窗的容器挂在最外层：任何页面都能 await askConfirm(...)，不用各自维护 state
  if (!authed) return <><ConfirmHost /><Login onDone={() => setAuthed(true)} /></>;
  return (
    <>
      <ConfirmHost />
      <Shell onLogout={() => { void postJson('/api/admin/logout', {}, () => null, getToken()).catch(() => {}); setToken(null); setAuthed(false); }} />
    </>
  );
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

  // 实时订阅挂在这一层，不在「订单」页签里：
  // 页签是条件渲染，挂在里面的话切到菜品管理时组件卸载、连接被关——新单不响铃、不提示，老板改个价就漏单。
  const [unread, setUnread] = useState(0);
  const [banner, setBanner] = useState<string | null>(null);
  const live = useLiveOrders((o) => {
    playChime();
    setBanner(`${formatPickupNo(o.pickupNo)} · ${formatTable(o.tableNo)} 新单 ${money(o.totalSen)}`);
    setUnread((n) => n + 1);
    window.setTimeout(() => setBanner((b) => (b && b.startsWith(formatPickupNo(o.pickupNo)) ? null : b)), 6000);
  });

  // 切回订单页就把未读数清零
  useEffect(() => { if (key === 'orders') setUnread(0); }, [key]);

  const mod = MODULES.find((m) => m.key === key)!;
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">{brand.shortName}<span>经营后台</span></div>
        <nav>
          {MODULES.map((m) => (
            <a key={m.key} href={`#${m.key}`} className={m.key === key ? 'nav active' : 'nav'}>
              {m.label}
              {m.key === 'members' && alert && <span className="dot" aria-label="对账异常" />}
              {m.key === 'orders' && unread > 0 && <span className="badge-new" aria-label={`${unread} 张新单`}>{unread}</span>}
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
        {/* 不在订单页时来的新单：走一条浮起来的提示条，点一下就回去 */}
        {banner && key !== 'orders' && (
          <a className="new-order-toast" href="#orders" role="status">
            <strong>来新单了</strong> {banner} <span>点此回到订单台 →</span>
          </a>
        )}
        <h1 className="no-print">{mod.label}</h1>
        {key === 'orders' && <OrdersBoard live={live} reconcileAlert={Boolean(alert)} />}
        {key === 'history' && <HistoryPage />}
        {key === 'dishes' && <DishesPage />}
        {key === 'members' && <MembersPage />}
        {key === 'dashboard' && <DashboardPage />}
        {key === 'store' && <StoreInfoPage />}
        {key === 'printers' && <PrintersPage />}
        {key === 'report' && <ReportPage />}
        {key === 'errors' && <ErrorsPage />}
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

function OrdersBoard({ live, reconcileAlert }: { live: ReturnType<typeof useLiveOrders>; reconcileAlert: boolean }) {
  const [started, setStarted] = useState(chimeReady);
  const [flash, setFlash] = useState<string | null>(null);
  // 订阅在 Shell 层，这里只管「闪一下这张新单」；响铃和未读数也在 Shell 层，切走了照样生效
  const lastNew = live.orders && live.orders.length ? live.orders[live.orders.length - 1]!.id : null;
  useEffect(() => {
    if (!lastNew) return;
    setFlash(lastNew);
    const t = window.setTimeout(() => setFlash((f) => (f === lastNew ? null : f)), 6000);
    return () => window.clearTimeout(t);
  }, [lastNew]);

  // 每 30 秒推一次「现在几点」，「已等待」才会往前走。
  // 用 30 秒而不是 1 秒：显示的是分钟，1 秒刷一次只会让整块板子白重渲染。
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const start = async () => setStarted(await unlockChime());
  const cancelled = (live.orders ?? []).filter((o) => o.status === 'cancelled');
  const autoCount = cancelled.filter((o) => o.autoCancelled).length;
  // 部分退款但还在做的单（点得很常见：客人退了其中一个菜，剩下的照做）。
  // 这种单会一直留在「新单/制作中」，不能只在票据里标一下——高峰期卡片一多，
  // 老板会忘了这单已经退过钱，「完成」收钱时少收。所以单独开一块钉在台上方。
  const partial = (live.orders ?? []).filter((o) => o.status !== 'cancelled' && o.refundState === 'partial');

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
                {list.map((o) => <OrderCard key={o.id} order={o} flash={flash === o.id} tick={tick} onChange={live.replace} />)}
              </section>
            );
          })}
        </div>
      )}
      {partial.length > 0 && (
        <div className="panel partial-refunds" role="region" aria-label="部分退款、还没做完的单">
          <h2>部分退款 <span className="count">{partial.length}</span></h2>
          {partial.map((o) => (
            <div key={o.id} className="partial-row">
              <span>
                <strong>{formatPickupNo(o.pickupNo)}</strong> · {formatTable(o.tableNo)} ·{' '}
                {ORDER_STATUS_LABEL[o.status]} · 已退 <strong className="alert-text">{money(o.refundedSen)}</strong>
                {o.refundedSen < o.totalSen && <> · 还需收 <strong>{money(o.totalSen - o.refundedSen)}</strong></>}
              </span>
              <span className="muted small">
                {o.refunds.filter((r) => r.line > 0).map((r) => `${r.name}×${r.qty}（${r.reason}）`).join('、')}
              </span>
            </div>
          ))}
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

/**
 * 这一单等了多久（P2-10）。
 *
 * 高峰期 5 单堆着，老板要知道「哪单快超时」，光看状态不够。
 * 从下单时刻算起，还没做完的单一直走秒；做完/取消的不再计时。
 * 20 分钟变红——那是「这桌客人该催了」的线，比按经验拍一个数字靠谱。
 */
const LATE_AFTER_MS = 20 * 60_000;
function Waited({ order, tick }: { order: OrderT; tick: number }) {
  const finished = order.status === 'done' || order.status === 'cancelled';
  const ms = finished ? 0 : Math.max(0, tick - Date.parse(order.createdAt));
  if (finished) return null;
  const min = Math.floor(ms / 60_000);
  // 不到 1 分钟显示「<1 分钟」：刚下的单说「0 分钟」看着像没算
  const text = min < 1 ? '<1 分钟' : `${min} 分钟`;
  return <span className={ms >= LATE_AFTER_MS ? 'waited late' : 'waited'} title="从下单到现在"><i aria-hidden="true" />已等 {text}</span>;
}
const CANCEL_REASONS = ['客人取消', '菜品售罄', '重复下单'];

function OrderCard({ order, flash, tick, onChange }: { order: OrderT; flash: boolean; tick: number; onChange: (o: OrderT) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [printing, setPrinting] = useState<'receipt' | 'label' | null>(null);
  const [printed, setPrinted] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const storedLeft = order.storedSen - order.refunds.reduce((n, r) => n + r.storedSen, 0);
  const otherLeft = order.otherSen - order.refunds.reduce((n, r) => n + r.counterSen, 0);
  // 纸没出来（打印机没开、卡纸）时用：单已经进了系统，重打一张就行，不用重下
  const reprint = async (target: 'receipt' | 'label') => {
    setPrinting(target);
    setError(null);
    setPrinted(null);
    try {
      const r = await adminPost(`/api/admin/orders/${order.id}/reprint`, { target }, (v) =>
        z.object({ ok: z.boolean(), pages: z.number(), error: z.string().optional() }).parse(v));
      setPrinted(r.ok ? `已送出 ${r.pages} 张` : `没打出来：${r.error ?? '检查打印机'}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '补打失败');
    } finally {
      setPrinting(null);
    }
  };
  const move = async (to: OrderStatus) => {
    if (to === 'cancelled' && !reason.trim()) { setError('请先写取消原因'); return; }
    setBusy(true);
    setError(null);
    try {
      // 带上 version：如果这单在我看到之后被别的设备改过，服务端会拒绝（409），
      // 不会出现「我这边显示已取消、前台那边显示制作中」这种两台设备各说各话的情况
      const updated = await adminPost(
        `/api/admin/orders/${order.id}/status`,
        { to, reason: to === 'cancelled' ? reason : null, version: order.version },
        (v) => Order.parse(v),
      );
      onChange(updated);
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
        {/* 加菜（P2-6）：子单也是完整的一单，会单独进这块板子。
            不标出来的话，同一桌会在「新单」里并排出现两张都是 027 的卡，老板会以为重复下了一单。
            号码用 027+1 表示「027 号单的第 1 次加菜」，和顾客说「再加两个菜」时对得上 */}
        {order.addSeq !== null && <span className="add-badge" title="这一桌在原单上又加了一次菜">加菜 +{order.addSeq}</span>}
        <span className="ticket-meta">
          <strong>{formatTable(order.tableNo)}</strong>
          <span className="muted">{formatClock(order.createdAt, brand.timezone)} · {paymentText(order, payLabel, money)}</span>
        </span>
        <Waited order={order} tick={tick} />
        {order.refundState !== 'none' && <span className="refund-badge">{REFUND_STATE_LABEL[order.refundState]}</span>}
      </header>
      <ul>
        {order.items.map((i) => (
          <li key={i.line}>
            <span>
              {i.code} {i.name}
              {/* 逐菜辣度/备注挂在行上（P1-9）：同菜两行时，这里能分清哪份不辣哪份特辣 */}
              {i.spice && <em className="item-spice">{i.spice}</em>}
              {i.refundedQty > 0 && <em className="refunded"> 已退 {i.refundedQty}</em>}
              {i.note && <span className="item-note"> · {i.note}</span>}
            </span>
            <span>× {i.qty}</span>
          </li>
        ))}
      </ul>
      {order.note && <p className="note">备注：{order.note}</p>}
      {order.refundedSen > 0 && <p className="muted small">已退款 {money(order.refundedSen)}</p>}
      {/* 加菜之后「这一单多少钱」和「这桌一共多少钱」是两个数。
          打卡收钱要按整桌收，所以整桌合计必须写出来，结账时才不会少收。
          判断条件用「整桌合计 ≠ 这张单」，而不是 addCount：
          父子单都会各自进板子，两张卡都需要看到同一桌的总数，说法才一致 */}
      {order.groupTotalSen !== order.totalSen && (
        <p className="add-total muted small">
          这一桌一共 {money(order.groupTotalSen)}（这张单 {money(order.totalSen)}）
        </p>
      )}
      <footer>
        <span className="muted">{money(order.totalSen)}</span>
        {!cancelling && !refunding && (
          <span className="actions">
            <button className="btn" disabled={printing !== null} onClick={() => void reprint('receipt')} title="再打一张小票">
              {printing === 'receipt' ? '打印中…' : '补打小票'}
            </button>
            <button className="btn" disabled={printing !== null} onClick={() => void reprint('label')} title="再打这单所有饮品杯贴">
              {printing === 'label' ? '打印中…' : '补打杯贴'}
            </button>
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
      {printed && <p className="muted small">{printed}</p>}
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
  // 这两个 state 必须放在 `if (!s) return null` 之前：hooks 数量一旦前后不一致，
  // React 会直接抛「Rendered more hooks than during the previous render」，整块面板白屏。
  const [pausing, setPausing] = useState(false);
  const [pauseMin, setPauseMin] = useState('15');
  if (!s) return null;
  const save = (body: Record<string, unknown>) => void apply(adminPost('/api/admin/store', body, (v) => StoreStatus.parse(v)));
  // 暂停时把「预计多久恢复」也说出来（P2-9）：老板自己也要知道什么时候该回来
  const label = s.open
    ? '营业中 · 正在接单'
    : s.reason === 'paused'
      ? (s.pauseMinutes ? `已暂停接单 · 预计 ${s.pauseMinutes} 分钟后恢复` : '已暂停接单')
      : `已打烊（营业时间 ${s.openAt}–${s.closeAt}）`;
  return (
    <div className={s.open ? 'panel store' : 'panel store closed'}>
      <strong className="store-state" role="status">{label}</strong>
      {s.reason === 'paused'
        ? <button className="btn primary" onClick={() => save({ paused: false })}>恢复接单</button>
        : <button className="btn" onClick={() => setPausing(true)}>暂停接单</button>}
      {pausing && (
        // 原来用 window.prompt 让老板填「暂停多久」——浏览器原生弹窗在打印页、手机上都会被拦，
        // 有的浏览器干脆不显示，点一下就什么也没发生。改成页面内小表单，填完直接确认。
        <form
          className="pause-form"
          aria-label="暂停接单"
          onSubmit={(e) => {
            e.preventDefault();
            const mins = Math.round(Number(pauseMin));
            if (!Number.isFinite(mins) || mins <= 0 || mins > 240) {
              setError('暂停分钟数请填 1 到 240 之间的整数');
              return;
            }
            void askConfirm({
              title: '确认暂停接单？',
              detail: `顾客将无法下单，直到你点「恢复接单」。顾客手机上会显示「预计 ${mins} 分钟后恢复」。`,
              confirmText: '暂停接单',
              danger: true,
            }).then((ok) => {
              if (!ok) return;
              setPausing(false);
              setError(null);
              save({ paused: true, pauseMinutes: mins });
            });
          }}
        >
          <label>暂停 <input type="number" min={1} max={240} value={pauseMin} onChange={(e) => setPauseMin(e.target.value)} aria-label="暂停多少分钟" /> 分钟（顾客手机上看得到）</label>
          <button type="submit" className="btn danger">确认暂停</button>
          <button type="button" className="btn" onClick={() => { setPausing(false); setError(null); }}>取消</button>
        </form>
      )}
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
