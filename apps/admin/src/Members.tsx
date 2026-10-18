import { useEffect, useState } from 'react';
import {
  formatDate, formatDateTime, formatPrice, LEDGER_TYPE_LABEL, Member, MemberDetail, parseRM, ReconcileRun,
  type Member as MemberT, type MemberDetail as MemberDetailT, type ReconcileRun as ReconcileRunT,
} from '@pkg/contract';
import config from 'virtual:brand';
import { z } from 'zod';
import { adminGet, adminPost } from './api.ts';

const { brand } = config;
const money = (sen: number) => `${brand.currency.symbol} ${formatPrice(sen)}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : '操作失败');

/** 防重复提交的请求编号：同一次表单提交即使点两下，服务器也只入账一次。
 *  不用 crypto.randomUUID：平板通过局域网 IP 打开老板端时它不可用 */
function newRequestId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function MembersPage() {
  const [q, setQ] = useState('');
  const [list, setList] = useState<MemberT[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = (text = q) =>
    adminGet(`/api/admin/members?q=${encodeURIComponent(text)}`, (v) => z.array(Member).parse(v))
      .then((l) => { setList(l); setError(null); })
      .catch((e: unknown) => setError(errText(e)));
  useEffect(() => { void search(''); }, []);

  return (
    <>
      <ReconcileBanner />
      <div className="toolbar no-print">
        <form className="search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="会员号或手机号" aria-label="搜索会员" />
          <button className="btn">搜索</button>
        </form>
        <button className="btn primary" onClick={() => setCreating(!creating)}>{creating ? '收起' : '新办会员卡'}</button>
      </div>
      {creating && <NewMember onCreated={(m) => { setCreating(false); setSelected(m.id); void search(''); }} />}
      {error && <div className="panel crash" role="alert"><p>{error}</p></div>}
      <div className="members">
        <div className="panel member-list no-print">
          {list === null ? <p className="muted">加载中…</p> : list.length === 0 ? <p className="muted">没有找到会员。</p> : (
            <table>
              <thead><tr><th>会员号</th><th>手机</th><th className="num">余额</th><th /></tr></thead>
              <tbody>
                {list.map((m) => (
                  <tr key={m.id} className={m.id === selected ? 'sel' : ''} onClick={() => setSelected(m.id)} style={{ cursor: 'pointer' }}>
                    <td>{m.memberNo}</td>
                    <td>{m.phone ?? '—'}</td>
                    <td className="num">{money(m.balanceSen)}</td>
                    <td>{m.locked ? <span className="accent">已锁定</span> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {selected ? <MemberPanel id={selected} onChanged={() => void search()} /> : <div className="panel no-print"><p className="muted">点左侧会员查看详情、充值或调整。</p></div>}
      </div>
    </>
  );
}

function ReconcileBanner() {
  const [last, setLast] = useState<ReconcileRunT | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const parse = (v: unknown) => z.object({ last: ReconcileRun.nullable() }).parse(v).last;
  useEffect(() => { void adminGet('/api/admin/reconcile', parse).then(setLast).catch(() => setLast(null)); }, []);
  const run = async () => {
    setBusy(true);
    try {
      setLast(await adminPost('/api/admin/reconcile', {}, parse));
      window.dispatchEvent(new Event('reconcile-changed')); // 让全局横幅同步刷新
    } finally { setBusy(false); }
  };
  if (last === undefined) return null;
  const bad = last && last.mismatches.length > 0;
  return (
    <div className={bad ? 'panel recon bad no-print' : 'panel recon no-print'} role={bad ? 'alert' : undefined}>
      {!last && <span>还没有对过账。</span>}
      {last && !bad && <span>对账正常：{last.checked} 位会员的流水合计与余额一致（{formatDateTime(last.at, brand.timezone)}）</span>}
      {last && bad && (
        <span>
          对账发现 {last.mismatches.length} 处不一致，请立刻核查：
          {last.mismatches.map((m) => ` 会员 ${m.memberNo} 余额 ${money(m.balanceSen)}，流水合计 ${money(m.ledgerSumSen)}；`)}
        </span>
      )}
      <button className="btn" disabled={busy} onClick={() => void run()}>{busy ? '对账中…' : '立即对账'}</button>
    </div>
  );
}

function NewMember({ onCreated }: { onCreated: (m: MemberT) => void }) {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pin !== pin2) { setError('两次输入的密码不一样'); return; }
    try {
      onCreated(await adminPost('/api/admin/members', { phone, pin }, (v) => Member.parse(v)));
    } catch (err) {
      setError(errText(err));
    }
  };
  const digits = (s: string) => s.replace(/\D/g, '').slice(0, 4);
  return (
    <form className="panel form-row no-print" onSubmit={(e) => void submit(e)} aria-label="新办会员卡">
      <label>手机号（可选）<input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></label>
      <label>顾客设定的 4 位密码<input value={pin} onChange={(e) => setPin(digits(e.target.value))} inputMode="numeric" type="password" /></label>
      <label>再输一次<input value={pin2} onChange={(e) => setPin2(digits(e.target.value))} inputMode="numeric" type="password" /></label>
      <button className="btn primary" disabled={pin.length !== 4}>办卡</button>
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="muted small">会员号由系统自动编号，办好后告诉顾客。储值赠送规则未定，目前只做纯储值。</p>
    </form>
  );
}

function MemberPanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [d, setD] = useState<MemberDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => adminGet(`/api/admin/members/${id}`, (v) => MemberDetail.parse(v)).then(setD).catch((e: unknown) => setError(errText(e)));
  useEffect(() => { setD(null); void load(); }, [id]);
  if (error) return <div className="panel crash" role="alert"><p>{error}</p></div>;
  if (!d) return <div className="panel"><p className="muted">加载中…</p></div>;
  const changed = (next: MemberDetailT) => { setD(next); onChanged(); };
  const { member: m, ledger } = d;
  return (
    <div className="panel member-panel print-area">
      <header className="member-head">
        <div>
          <h2>会员 {m.memberNo}</h2>
          <p className="muted">{m.phone ?? '未留手机号'} · 办卡 {formatDate(m.createdAt, brand.timezone)}{m.locked ? ' · 密码已锁定' : ''}</p>
        </div>
        <div className="member-balance"><span className="muted">余额</span><strong>{money(m.balanceSen)}</strong></div>
      </header>
      <div className="member-actions no-print">
        <MoneyForm key={`r-${m.id}`} title="充值" sign={false} memberNo={m.memberNo} url={`/api/admin/members/${m.id}/recharge`} onDone={changed} />
        <MoneyForm key={`a-${m.id}`} title="余额调整" sign memberNo={m.memberNo} url={`/api/admin/members/${m.id}/adjust`} onDone={changed} />
        <ResetPin id={m.id} onDone={() => void load()} />
      </div>
      <div className="ledger-head">
        <h3>余额流水（只增不删，最近 200 笔）</h3>
        <button className="btn no-print" onClick={() => window.print()}>打印流水</button>
      </div>
      <p className="print-only">{brand.name} · 会员 {m.memberNo} · 余额 {money(m.balanceSen)} · 打印时间 {formatDateTime(new Date(), brand.timezone)}</p>
      <table>
        <thead><tr><th>时间</th><th>类型</th><th className="num">金额</th><th className="num">变动后余额</th><th>操作者</th><th>备注</th></tr></thead>
        <tbody>
          {ledger.map((l) => (
            <tr key={l.id}>
              <td>{formatDateTime(l.at, brand.timezone)}</td>
              <td>{LEDGER_TYPE_LABEL[l.type]}</td>
              <td className={l.amountSen > 0 ? 'num accent' : 'num'}>{l.amountSen > 0 ? '+' : ''}{formatPrice(l.amountSen)}</td>
              <td className="num">{formatPrice(l.balanceAfterSen)}</td>
              <td>{l.operator === 'admin' ? '老板端' : l.operator.startsWith('member:') ? '顾客储值支付' : l.operator}</td>
              <td>{l.note ?? ''}</td>
            </tr>
          ))}
          {ledger.length === 0 && <tr><td colSpan={6} className="muted">还没有流水</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** 充值 / 调整共用表单：提交前二次确认；每次成功后换一个新的请求编号 */
function MoneyForm({ title, sign, memberNo, url, onDone }: { title: string; sign: boolean; memberNo: string; url: string; onDone: (d: MemberDetailT) => void }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [requestId, setRequestId] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const sen = parseRM(amount, sign);
    if (sen === null || sen === 0) { setError(sign ? '请输入金额，例如 20 或 -12.5' : '请输入金额，例如 100 或 50.5'); return; }
    if (sign && !note.trim()) { setError('调整余额必须写原因'); return; }
    const verb = sign ? (sen > 0 ? '增加' : '扣减') : '充值';
    if (!window.confirm(`确认给会员 ${memberNo} ${verb} ${money(Math.abs(sen))}？`)) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await adminPost(url, { amountSen: sen, note, requestId }, (v) => MemberDetail.parse(v)));
      setAmount('');
      setNote('');
      setRequestId(newRequestId());
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="money-form" onSubmit={(e) => void submit(e)} aria-label={title}>
      <h3>{title}</h3>
      <label>金额（RM）<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder={sign ? '如 -12.5' : '如 100'} /></label>
      <label>{sign ? '原因（必填）' : '备注（可选）'}<input value={note} onChange={(e) => setNote(e.target.value)} placeholder={sign ? '如：多充冲回' : '如：柜台现金'} /></label>
      <button className="btn primary" disabled={busy}>{busy ? '提交中…' : title}</button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  );
}

function ResetPin({ id, onDone }: { id: string; onDone: () => void }) {
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await adminPost(`/api/admin/members/${id}/pin`, { pin }, (v) => Member.parse(v));
      setPin('');
      setMsg('密码已重设，锁定已解除');
      onDone();
    } catch (err) {
      setMsg(errText(err));
    }
  };
  return (
    <form className="money-form" onSubmit={(e) => void submit(e)} aria-label="重设密码">
      <h3>重设密码</h3>
      <label>新的 4 位密码<input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" type="password" /></label>
      <button className="btn" disabled={pin.length !== 4}>重设</button>
      {msg && <p className="muted small" role="status">{msg}</p>}
    </form>
  );
}
