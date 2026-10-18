// 54号 第二批：取餐 / 会员 / 我的（主程序新做），以及结算页（表里没列，按同一套设计语言推导）
// 同一套语言：宣纸底 + 墨晕 / 纸白轻透面板 / 马善政标题 / 朱砂印点缀 / 大圆角 / 触控 44px；数字英文走衬线
import { useEffect, useRef, useState } from 'react';
import {
  formatClock, formatDateTime, formatHours, formatPickupNo, formatPrice, formatTable, LEDGER_TYPE_LABEL, ORDER_STATUS_LABEL,
  paymentText, REFUND_STATE_LABEL, STORE_INFO_LABEL, telLink, whatsappLink,
  type Faq, type Order, type OrderStatus,
} from '@pkg/contract';
import { safeStorage, Seal } from '@pkg/ui-kit';
import { submitOrder, useFaq, useMyOrders, useStoreInfo, useStoreStatus, type CartApi, type MemberApi } from './api.ts';
import { brand, FINISHED, go, LOGO_SEAL, money, payLabel } from './common.tsx';
import { moving } from './fx.ts';
import { ClosedNotice } from './Order.tsx';
import { EmptyState, EN, FitText, Icon, Loaded, PanelTitle, type IconName } from './ui.tsx';

/* ---------------- 结算：核对菜品 → 桌号与备注 → 付款方式（23号 §3.3） ---------------- */

export function CheckoutPage({ cart, member, table, setTable, onDone }: { cart: CartApi; member: MemberApi; table: string; setTable: (t: string) => void; onDone: () => void }) {
  const [spice, setSpice] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<string | null>(null);
  const [useStored, setUseStored] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status] = useStoreStatus();
  const closed = status.state === 'ok' && !status.data.open;
  const c = cart.cart;

  if (!c) return <p className="muted center">加载中…</p>;
  if (c.count === 0) {
    return (
      <EmptyState title="购物车是空的">
        <button className="btn" onClick={() => go('order')}>去点单</button>
      </EmptyState>
    );
  }

  // 24号 #5：辣度五按钮写进备注，数据结构不变
  const fullNote = [spice ? `辣度：${spice}` : '', note.trim()].filter(Boolean).join('；');
  // 28号 §三-1 混合支付：余额不够整单时，可以「储值先付 X，剩下 Y 用其他方式」
  const balance = member.detail?.member.balanceSen ?? null;
  const canMix = balance !== null && balance > 0 && balance < c.totalSen;
  const picked = brand.paymentMethods.find((m) => m.key === method);
  const mixing = canMix && useStored && Boolean(picked && !picked.requiresMember);
  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      safeStorage.set('last-table', table.trim());
      await submitOrder({ cartId: c.id, tableNo: table, paymentMethod: method ?? '', note: fullNote, useStoredValue: mixing });
      if (picked?.requiresMember || mixing) void member.refresh();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : '下单失败，请重试');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="checkout">
      <header className="pagehead">
        <button className="circle-btn glass press" aria-label="继续点单" onClick={() => go('order')}><Icon name="back" ink /></button>
        <h1 className="brush-title">确认订单</h1>
        {FINISHED && EN.sections.checkout && <span className="en head-en" aria-hidden="true">{EN.sections.checkout}</span>}
      </header>

      <section className="panel glass">
        <PanelTitle><span className="step-no" aria-hidden="true">01</span>核对菜品</PanelTitle>
        <ul className="receipt">
          {c.lines.map((l) => (
            <li key={l.dishUid}>
              <span className="r-name"><FitText text={l.name} max={17} min={14} /><em> × {l.qty}</em></span>
              <span className="price">{money(l.subtotalSen)}</span>
            </li>
          ))}
          <li className="receipt-total"><span>合计</span><span className="price">{money(c.totalSen)}</span></li>
        </ul>
      </section>

      <section className="panel glass">
        <PanelTitle><span className="step-no" aria-hidden="true">02</span>桌号与备注</PanelTitle>
        <label className="field">
          <span className="field-label">桌号<em className="req">必填</em></span>
          <input value={table} onChange={(e) => setTable(e.target.value)} inputMode="text" maxLength={10} placeholder="例如 12" />
        </label>
        <div className="field">
          <span className="field-label">辣度（可选，会写进备注）</span>
          <div className="chips">
            {brand.spiceOptions.map((s) => (
              <button key={s} className={spice === s ? 'chip on' : 'chip'} aria-pressed={spice === s} onClick={() => setSpice(spice === s ? null : s)}>{s}</button>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="field-label">备注（可选）</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} rows={2} placeholder="例如：不要香菜" />
        </label>
        {fullNote && <p className="muted small note-preview">备注将写入：{fullNote}</p>}
      </section>

      <section className="panel glass">
        <PanelTitle><span className="step-no" aria-hidden="true">03</span>付款方式<em className="req">必选</em></PanelTitle>
        {canMix && (
          <label className={useStored ? 'mix on' : 'mix'}>
            <input type="checkbox" checked={useStored} onChange={(e) => { setUseStored(e.target.checked); if (picked?.requiresMember) setMethod(null); }} />
            <span>先用储值余额付 {money(balance)}，剩下 {money(c.totalSen - balance)} 用下面选的方式付</span>
          </label>
        )}
        {mixing && <p className="split" role="status">本单：储值 {money(balance)} + {picked!.label} {money(c.totalSen - balance!)}</p>}
        <div className="pay">
          {brand.paymentMethods.map((m) => {
            const short = m.requiresMember && balance !== null && balance < c.totalSen;
            return (
              <label key={m.key} className={short ? 'pay-opt disabled' : method === m.key ? 'pay-opt on' : 'pay-opt'}>
                <input type="radio" name="pay" value={m.key} disabled={short} checked={method === m.key} onChange={() => setMethod(m.key)} />
                <span className="pay-name">{m.label}</span>
                {m.requiresMember && balance !== null && <span className="muted small">{short ? `余额不足（${money(balance)}）` : `余额 ${money(balance)}`}</span>}
                {m.requiresMember && balance === null && <span className="muted small">需登录会员</span>}
              </label>
            );
          })}
        </div>
        {method && brand.paymentMethods.find((m) => m.key === method)?.requiresMember && !member.detail && (
          <div className="inline-login">
            <p className="muted small">储值支付需要先登录会员：</p>
            <MemberLogin member={member} compact />
          </div>
        )}
      </section>

      {status.state === 'ok' && <div className="closed-wrap"><ClosedNotice status={status.data} /></div>}
      {error && <p className="form-error checkout-error" role="alert">{error}</p>}
      <div className="submit-wrap">
        <button className="btn block big" disabled={sending || closed} onClick={() => void submit()}>
          {closed ? '暂不接单' : sending ? '提交中…' : `提交订单 · ${money(c.totalSen)}`}
        </button>
      </div>
    </div>
  );
}

/* ---------------- 取餐：三重编码（大字取餐号 + 兜底数字 + 语音播报状态）+ 三段进度 + 翻牌 ---------------- */

const STEPS = ['已下单', '制作中', '请取餐'] as const;
const STEP_OF: Record<OrderStatus, number> = { pending: 0, cooking: 1, done: 2, cancelled: -1 };
const STATUS_ICON: Record<OrderStatus, IconName> = { pending: 'receipt', cooking: 'bowl', done: 'pickup', cancelled: 'receipt' };

export function PickupPage({ deviceId, onBuyAgain }: { deviceId: string | null; onBuyAgain: (id: string) => void }) {
  const [orders, retry] = useMyOrders(deviceId);
  if (!deviceId) return <p className="muted center">加载中…</p>;
  return (
    <div className="pickup">
      <header className="pagehead"><h1 className="brush-title">取餐</h1></header>
      <Loaded load={orders} retry={retry}>
        {(list) => {
          if (list.length === 0) return <EmptyState title="还没有订单"><p className="muted">下单后，取餐号会显示在这里。</p></EmptyState>;
          const [latest, ...rest] = list;
          return (
            <>
              <Ticket order={latest!} />
              {rest.length > 0 && <OrderList title="更早的订单" orders={rest} onBuyAgain={onBuyAgain} />}
            </>
          );
        }}
      </Loaded>
    </div>
  );
}

/** 叫号语音：顾客点一下才开（浏览器要求有一次点按才能出声）；状态变成「请取餐」时念一遍取餐号 */
function useVoice(order: Order) {
  const [on, setOn] = useState(() => safeStorage.get('pickup-voice') === '1');
  const said = useRef<string | null>(null);
  const can = typeof window !== 'undefined' && 'speechSynthesis' in window;
  useEffect(() => {
    if (!on || !can || order.status !== 'done' || said.current === order.id) return;
    said.current = order.id;
    const u = new SpeechSynthesisUtterance(`取餐号 ${[...formatPickupNo(order.pickupNo)].join(' ')}，请取餐`);
    u.lang = brand.locale;
    window.speechSynthesis.speak(u);
  }, [on, can, order.status, order.id, order.pickupNo]);
  const toggle = () => {
    const next = !on;
    setOn(next);
    safeStorage.set('pickup-voice', next ? '1' : '0');
    if (next && can) window.speechSynthesis.speak(new SpeechSynthesisUtterance('')); // 这一下点按同时解锁出声
  };
  return { on, can, toggle };
}

function Ticket({ order }: { order: Order }) {
  const step = STEP_OF[order.status];
  const voice = useVoice(order);
  const no = formatPickupNo(order.pickupNo);
  return (
    <section className={`panel glass ticket status-${order.status}`} aria-label={`取餐号 ${no}`}>
      <p className="ticket-label brush-title">取餐号</p>
      {/* 翻牌：状态一变，号码牌绕横轴翻一下（只动 transform） */}
      <div className="flip-card" key={order.status}>
        <p className="hero-no">{no}</p>
      </div>
      <p className="ticket-fallback" aria-hidden="true">No. {no}</p>
      <p className="ticket-status" aria-live="polite">
        <Icon name={STATUS_ICON[order.status]} ink />
        <span className="hero-status">{ORDER_STATUS_LABEL[order.status]}</span>
      </p>
      {step >= 0 && (
        <ol className="progress" aria-label="进度">
          {STEPS.map((s, i) => (
            <li key={s} className={i < step ? 'done' : i === step ? 'now' : ''} aria-current={i === step ? 'step' : undefined}>
              <i aria-hidden="true" /><span>{s}</span>
            </li>
          ))}
        </ol>
      )}
      {order.etaMinutes !== null && <p className="eta muted">预计约 <b>{order.etaMinutes}</b> 分钟</p>}
      {order.status === 'cancelled' && order.cancelReason && <p className="muted">原因：{order.cancelReason}</p>}
      {order.status === 'cancelled' && order.storedSen > 0 && <p className="refund">储值 {money(order.storedSen)} 已原路退回会员余额</p>}
      {order.refundState !== 'none' && <p className="refund">{REFUND_STATE_LABEL[order.refundState]}：已退 {money(order.refundedSen)}</p>}
      <p className="ticket-meta">
        <span className="meta-chip">{formatTable(order.tableNo)}</span>
        <span className="meta-chip">{formatClock(order.createdAt, brand.timezone)} 下单</span>
        <span className="meta-chip">{paymentText(order, payLabel, money)}</span>
      </p>
      {order.note && <p className="ticket-note muted small">备注：{order.note}</p>}
      <ul className="receipt">
        {order.items.map((i) => (
          <li key={i.line}>
            <span className="r-name"><FitText text={i.name} max={17} min={14} /><em> × {i.qty}</em>{i.refundedQty > 0 && <em className="refunded"> 已退 {i.refundedQty} 份</em>}</span>
            <span className="price">{money(i.priceSen * i.qty)}</span>
          </li>
        ))}
        <li className="receipt-total"><span>合计</span><span className="price">{money(order.totalSen)}</span></li>
        {order.refunds.map((r) => (
          <li key={r.id} className="receipt-refund">
            <span>退「{r.name}」×{r.qty}（{r.reason}）{r.storedSen > 0 ? ' · 已退回储值' : ''}{r.counterSen > 0 ? ' · 请到柜台领取' : ''}</span>
            <span>−{formatPrice(r.amountSen)}</span>
          </li>
        ))}
      </ul>
      {voice.can && order.status !== 'cancelled' && (
        <button className={voice.on ? 'voice-btn on' : 'voice-btn'} aria-pressed={voice.on} onClick={voice.toggle}>
          <Icon name="speaker" ink />{voice.on ? '叫号语音已开' : '开启叫号语音'}
        </button>
      )}
    </section>
  );
}

function OrderList({ title, orders, onBuyAgain, id }: { title: string; orders: Order[]; onBuyAgain: (id: string) => void; id?: string }) {
  return (
    <section className="panel glass" id={id}>
      <PanelTitle>{title}</PanelTitle>
      <ul className="orders">
        {orders.map((o) => (
          <li key={o.id} className={`order-row status-${o.status}`}>
            <span className="order-no">{formatPickupNo(o.pickupNo)}</span>
            <div className="order-body">
              <p className="order-when">{o.businessDate.slice(5)} {formatClock(o.createdAt, brand.timezone)} · <span className="st">{ORDER_STATUS_LABEL[o.status]}</span></p>
              <p className="muted small">{o.items.map((i) => `${i.name}×${i.qty}`).join('、')}</p>
            </div>
            <button className="btn ghost" onClick={() => onBuyAgain(o.id)}>再来一单</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------- 会员 ---------------- */

export function MemberLogin({ member, compact = false }: { member: MemberApi; compact?: boolean }) {
  const [no, setNo] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await member.login(no.trim(), pin);
      setPin('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={compact ? 'member-login compact' : 'member-login'} onSubmit={(e) => void submit(e)} aria-label="会员登录">
      <label className="field">
        <span className="field-label">会员号</span>
        <input value={no} onChange={(e) => setNo(e.target.value)} inputMode="numeric" autoComplete="username" placeholder="例如 100001" />
      </label>
      <label className="field">
        <span className="field-label">4 位密码</span>
        <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} type="password" inputMode="numeric" autoComplete="current-password" />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn block" disabled={busy || !no.trim() || pin.length !== 4}>{busy ? '登录中…' : '登录会员'}</button>
    </form>
  );
}

/** 储值规则：只用批准过的文案（问答里关于会员、储值的条目 + 「充值和调整请到柜台办理」），不另编 */
function useStoredValueRules() {
  const [faq] = useFaq();
  if (faq.state !== 'ok') return [];
  return faq.data.boards.flatMap((b) => b.items).filter((it) => /会员|储值/.test(it.q));
}

export function MemberPage({ member }: { member: MemberApi }) {
  useEffect(() => { void member.refresh(); }, []); // 每次进入会员页拉一次最新余额
  const rules = useStoredValueRules();
  const [all, setAll] = useState(false);
  if (member.loading) return <p className="muted center">加载中…</p>;
  if (!member.detail) {
    return (
      <div className="member">
        <header className="pagehead"><h1 className="brush-title">会员</h1></header>
        {/* 56号 高斯：登录页要高级——黑金卡浮在宣纸水墨上；「登录会员」黑条金字 */}
        <section className="panel login-card bk">
          {FINISHED && <span className="bk-wm" aria-hidden="true">{brand.watermark}</span>}
          <PanelTitle>会员登录</PanelTitle>
          <MemberLogin member={member} />
          <p className="small login-note">还没有会员卡？请到柜台办理。</p>
        </section>
        <Rules rules={rules} />
      </div>
    );
  }
  const { member: m, ledger } = member.detail;
  const shown = all ? ledger : ledger.slice(0, 3);
  return (
    <div className="member">
      <header className="pagehead"><h1 className="brush-title">会员</h1></header>
      <MemberCard memberNo={m.memberNo} phone={m.phone} balanceSen={m.balanceSen} />
      <Rules rules={rules} />
      <section className="panel glass">
        <PanelTitle>消费记录</PanelTitle>
        {ledger.length === 0 && <p className="muted">还没有记录。</p>}
        <ul className="ledger">
          {shown.map((l) => (
            <li key={l.id}>
              <div className="ledger-main">
                <strong className="brush-title">{LEDGER_TYPE_LABEL[l.type]}</strong>
                <span className="muted small">{formatDateTime(l.at, brand.timezone, true)}</span>
                {l.note && <p className="muted small">{l.note}</p>}
              </div>
              <div className="ledger-amt">
                <span className={l.amountSen > 0 ? 'plus' : 'minus'}>{l.amountSen > 0 ? '+' : ''}{formatPrice(l.amountSen)}</span>
                <span className="muted small">余额 {formatPrice(l.balanceAfterSen)}</span>
              </div>
            </li>
          ))}
        </ul>
        {ledger.length > 3 && (
          <button className="more-btn" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? '收起' : `查看全部 ${ledger.length} 条`}<span className="ring-arrow"><Icon name="arrow" ink /></span>
          </button>
        )}
      </section>
      <div className="logout-wrap"><button className="btn gold-ghost block" onClick={() => void member.logout()}>退出会员登录</button></div>
    </div>
  );
}

/** 会员卡色板：等级功能还没有，先用黑金；地址加 ?card=earth|gold|platinum 预览土黄金 / 黄金 / 铂金（给高斯挑） */
const CARD_TONE = (() => {
  const q = new URLSearchParams(location.search).get('card');
  return q === 'earth' || q === 'gold' || q === 'platinum' ? q : 'black';
})();

/**
 * 56号 会员卡：和大画态那张卡同一套语言（竖排 SIGNATURE + 竖排书法水印 + 圆戳），做成信用卡比例的黑金卡面，
 * 底纹叠宣纸纤维 + 一抹远山（古风）；只用已有的字：储值余额、会员号、手机号（打码）、店名
 */
function MemberCard({ memberNo, phone, balanceSen }: { memberNo: string; phone: string | null; balanceSen: number }) {
  return (
    <section className={`member-card tone-${CARD_TONE}`} aria-label="会员卡">
      {FINISHED && <><i className="mc-ink" aria-hidden="true" /><i className="mc-tex" aria-hidden="true" /></>}
      {FINISHED && EN.sections.signature && <span className="en mc-sig" aria-hidden="true">{EN.sections.signature}</span>}
      {FINISHED && <span className="mc-wm" aria-hidden="true">{brand.watermark}</span>}
      {LOGO_SEAL && <Seal char={LOGO_SEAL} size="lg" />}
      <div className="mc-main">
        <p className="mc-label brush-title">储值余额</p>
        <p className="balance" key={balanceSen}>{money(balanceSen)}</p>
      </div>
      <div className="mc-foot">
        <p className="mc-no">会员号 <b>{memberNo}</b>{phone && <> · {phone}</>}</p>
        <p className="mc-brand brush-title">{brand.shortName}</p>
      </div>
    </section>
  );
}

function Rules({ rules }: { rules: { q: string; a: string }[] }) {
  return (
    <section className="panel glass paper rules">
      <PanelTitle>储值规则</PanelTitle>
      {rules.map((r) => <p key={r.q} className="rule-text">{r.a}</p>)}
      <p className="rule-text">充值和调整请到柜台办理，这里只能查看。</p>
    </section>
  );
}

/* ---------------- 我的：深墨绿顶卡 + 莫兰迪 2×2 功能区（38号：判死表单化设置列表） ---------------- */

export function MePage({ deviceId, member, onBuyAgain }: { deviceId: string | null; member: MemberApi; onBuyAgain: (id: string) => void }) {
  const [faq, retryFaq] = useFaq();
  const [orders] = useMyOrders(deviceId);
  const [status] = useStoreStatus();
  const [info] = useStoreInfo();
  // 58号：门店信息从老板端读；营业时间没单独填时用接单时间段兜底。没填的那一行不显示，全空整张卡不显示（不再写「待提供」）
  const i = info.state === 'ok' ? info.data : null;
  const hours = i?.hours ?? (status.state === 'ok' ? formatHours(status.data, null) : null);
  const facts = i ? [
    { k: 'hours', v: hours, href: null },
    { k: 'phone', v: i.phone, href: telLink(i.phone) },
    { k: 'whatsapp', v: i.whatsapp, href: whatsappLink(i.whatsapp) },
    { k: 'address', v: i.address, href: null },
  ].filter((f): f is { k: 'hours' | 'phone' | 'whatsapp' | 'address'; v: string; href: string | null } => Boolean(f.v)) : [];
  const m = member.detail?.member;
  const orderCount = orders.state === 'ok' ? orders.data.length : null;
  // 2×2 功能区是这一页的目录：点一下滑到对应那一块（不用 # 链接，# 是页面路由）
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: moving() ? 'smooth' : 'auto', block: 'start' });
  const tiles: { id: string; label: string; sub: string; icon: IconName; tone: string; onClick: () => void }[] = [
    { id: 'me-orders', label: '我的订单', sub: orderCount === null ? '加载中' : `${orderCount} 单`, icon: 'receipt', tone: 'paper', onClick: () => jump('me-orders') },
    ...(facts.length ? [{ id: 'me-store', label: '门店信息', sub: hours ?? facts[0]!.v, icon: 'shop' as IconName, tone: 'camel', onClick: () => jump('me-store') }] : []),
    { id: 'member', label: '会员储值', sub: m ? money(m.balanceSen) : '登录查看', icon: 'member', tone: 'black', onClick: () => go('member') },
    { id: 'me-faq', label: '常见问题', sub: faq.state === 'ok' ? `${faq.data.boards.reduce((n, b) => n + b.items.length, 0)} 条` : '', icon: 'book', tone: 'ochre', onClick: () => jump('me-faq') },
  ];
  return (
    <div className="me">
      {/* 27号 #5：共用手机（同学拼桌）很常见，会员状态和「退出会员登录」放第一屏 */}
      <section className="me-card bk" aria-label="会员状态">
        {FINISHED && <span className="me-wm" aria-hidden="true">{brand.watermark}</span>}
        {m ? (
          <>
            <div className="me-who">
              <h2 className="brush-title">会员 {m.memberNo}</h2>
              <p className="me-sub">储值余额 <b>{money(m.balanceSen)}</b></p>
            </div>
            <button className="btn bk-btn" onClick={() => void member.logout()}>退出会员登录</button>
          </>
        ) : (
          <>
            <div className="me-who">
              <h2 className="brush-title">未登录会员</h2>
              <p className="me-sub">登录后可查余额、用储值支付</p>
            </div>
            <button className="btn bk-btn" onClick={() => go('member')}>登录会员</button>
          </>
        )}
      </section>

      <nav className="me-grid" aria-label="我的">
        {tiles.map((t) => (
          <button key={t.id} className={`me-tile tone-${t.tone} press`} onClick={t.onClick}>
            <span className="tile-ico"><Icon name={t.icon} ink /></span>
            <span className="tile-label brush-title">{t.label}</span>
            <span className="tile-sub">{t.sub}</span>
          </button>
        ))}
      </nav>

      {/* 加载中不能显示「还没有订单」——那是错误信息，会让顾客以为单丢了 */}
      {orders.state === 'ok' && orders.data.length > 0
        ? <OrderList title="我的订单" id="me-orders" orders={orders.data.slice(0, 5)} onBuyAgain={onBuyAgain} />
        : (
          <section className="panel glass" id="me-orders">
            <PanelTitle>我的订单</PanelTitle>
            <p className="muted">
              {orders.state === 'loading' || !deviceId ? '加载中…' : orders.state === 'error' ? `没能加载：${orders.message}` : '还没有订单。'}
            </p>
          </section>
        )}

      {facts.length > 0 && (
        <section className="panel glass" id="me-store">
          <PanelTitle en={EN.sections.store}>门店信息</PanelTitle>
          <div className="store-facts">
            {facts.map((f, n) => {
              // 地址排最后、占整行；其余两两一行，单出来的那项也占整行，两列不留半格空
              const short = facts.length - (i?.address ? 1 : 0);
              const wide = f.k === 'address' || (n === short - 1 && short % 2 === 1);
              const body = <><span className="fact-k brush-title">{STORE_INFO_LABEL[f.k]}</span><span className="fact-v">{f.v}</span></>;
              return f.href
                ? <a key={f.k} className={wide ? 'fact wide press' : 'fact press'} href={f.href} target={f.k === 'whatsapp' ? '_blank' : undefined} rel="noreferrer">{body}</a>
                : <div key={f.k} className={wide ? 'fact wide' : 'fact'}>{body}</div>;
            })}
          </div>
        </section>
      )}

      <div id="me-faq">
        <Loaded load={faq} retry={retryFaq}>{(f) => <FaqView faq={f} />}</Loaded>
      </div>
    </div>
  );
}

function FaqView({ faq }: { faq: Faq }) {
  return (
    <>
      {faq.boards.map((b, i) => (
        <section key={b.title} className="panel glass">
          <PanelTitle en={i === 0 ? EN.sections.faq : undefined}>{b.title}</PanelTitle>
          {b.items.map((it) => (
            <details key={it.q} className="faq">
              <summary><span>{it.q}</span><span className="ring-arrow"><Icon name="arrow" ink /></span></summary>
              <p>{it.a}</p>
            </details>
          ))}
        </section>
      ))}
    </>
  );
}
