import { useEffect, useState } from 'react';
import { Dashboard, formatDate, formatMoney, LEDGER_TYPE_LABEL, shiftDay, type Dashboard as DashboardT } from '@pkg/contract';
import config from 'virtual:brand';
import { adminGet } from './api.ts';

const { brand } = config;
const money = (sen: number) => `${brand.currency.symbol} ${formatMoney(sen)}`;
const signed = (sen: number) => (sen > 0 ? `+${money(sen)}` : sen < 0 ? `−${money(-sen)}` : money(0));
const payLabel = (key: string) => brand.paymentMethods.find((m) => m.key === key)?.label ?? key;
const dayLabel = (day: string) => formatDate(`${day}T12:00:00Z`, 'UTC'); // 营业日本身就是门店日历日，按日历显示

/**
 * 数据看板简版（29号 / 31号）：今日营收、订单数、储值变动。表格 + 大数字，不用图表库。
 * 每个数都由服务器从订单、退款、储值流水三本账现算，页面只负责显示。
 */
export function DashboardPage() {
  const [day, setDay] = useState<string | null>(null);
  const [data, setData] = useState<DashboardT | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    adminGet(`/api/admin/dashboard${day ? `?day=${day}` : ''}`, (v) => Dashboard.parse(v))
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '没能加载'));
  }, [day]);

  if (error) return <div className="panel crash" role="alert"><h2>看板没能加载</h2><p className="muted">{error}</p></div>;
  if (!data) return <div className="panel"><p className="muted">加载中…</p></div>;
  const d = data.day;
  const isToday = d.day === data.today;
  const stored = d.stored;
  const storedRows = [
    ['recharge', stored.rechargeSen], ['consume', stored.consumeSen], ['refund', stored.refundSen], ['adjust', stored.adjustSen], ['import', stored.importSen],
  ] as const;

  return (
    <div className="dashboard">
      <div className="toolbar day-nav">
        <button className="btn" onClick={() => setDay(shiftDay(d.day, -1))}>‹ 前一天</button>
        <strong aria-live="polite">{dayLabel(d.day)}{isToday ? '（今天）' : ''}</strong>
        <button className="btn" disabled={isToday} onClick={() => setDay(shiftDay(d.day, 1))}>后一天 ›</button>
        {!isToday && <button className="btn" onClick={() => setDay(null)}>回到今天</button>}
      </div>

      <div className="stats">
        <section className="panel stat" aria-label="实收营收">
          <p className="stat-label">实收营收</p>
          <p className="stat-big">{money(d.netSen)}</p>
          <p className="muted small">下单 {money(d.grossSen)} − 退款 {money(d.refundSen)}</p>
        </section>
        <section className="panel stat" aria-label="有效订单">
          <p className="stat-label">有效订单</p>
          <p className="stat-big">{d.orders}<span> 单</span></p>
          <p className="muted small">已取消 {d.cancelled} 单{d.orders > 0 ? ` · 客单价 ${money(Math.round(d.netSen / d.orders))}` : ''}</p>
        </section>
        <section className="panel stat" aria-label="储值净变动">
          <p className="stat-label">储值净变动</p>
          <p className="stat-big">{signed(stored.netSen)}</p>
          <p className="muted small">此刻全店储值余额 {money(data.storedBalanceSen)}</p>
        </section>
      </div>

      <div className="dash-grid">
        <section className="panel">
          <h2>按付款方式</h2>
          {d.byMethod.length === 0 ? <p className="muted">这一天没有有效订单。</p> : (
            <table>
              <thead><tr><th>付款方式</th><th className="num">单数</th><th className="num">下单</th><th className="num">退款</th><th className="num">实收</th></tr></thead>
              <tbody>
                {d.byMethod.map((m) => (
                  <tr key={m.method}><td>{payLabel(m.method)}</td><td className="num">{m.orders}</td><td className="num">{money(m.grossSen)}</td><td className="num">{m.refundSen ? `−${money(m.refundSen)}` : '—'}</td><td className="num"><b>{money(m.netSen)}</b></td></tr>
                ))}
              </tbody>
              <tfoot><tr><td>合计</td><td className="num" /><td className="num">{money(d.grossSen)}</td><td className="num">{d.refundSen ? `−${money(d.refundSen)}` : '—'}</td><td className="num"><b>{money(d.netSen)}</b></td></tr></tfoot>
            </table>
          )}
          <p className="muted small">混合支付的单：储值部分记在「{payLabel(brand.paymentMethods.find((m) => m.requiresMember)?.key ?? '')}」，其余记在另一种方式，两边各算一单，所以单数合计可能大于有效订单数。</p>
        </section>

        <section className="panel">
          <h2>储值变动</h2>
          <table>
            <tbody>
              {storedRows.map(([type, sen]) => <tr key={type}><td>{LEDGER_TYPE_LABEL[type]}</td><td className="num">{signed(sen)}</td></tr>)}
            </tbody>
            <tfoot><tr><td>净变动（{stored.entries} 笔流水）</td><td className="num"><b>{signed(stored.netSen)}</b></td></tr></tfoot>
          </table>
          <p className="muted small">按流水发生的营业日统计。消费和退款来自订单，充值和调整来自会员管理。</p>
        </section>
      </div>

      <section className="panel">
        <h2>近 7 天</h2>
        <table className="week">
          <thead><tr><th>营业日</th><th className="num">有效订单</th><th className="num">实收营收</th><th className="num">储值净变动</th></tr></thead>
          <tbody>
            {[...data.week].reverse().map((w) => (
              <tr key={w.day} className={w.day === d.day ? 'sel' : ''} onClick={() => setDay(w.day === data.today ? null : w.day)}>
                <td>{dayLabel(w.day)}{w.day === data.today ? '（今天）' : ''}</td><td className="num">{w.orders}</td><td className="num">{money(w.netSen)}</td><td className="num">{signed(w.storedNetSen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <details className="panel rules">
        <summary>这些数怎么算的</summary>
        <ul>
          <li>营业日 = 门店时区的日历日（和取餐号每天归零、售罄第二天恢复是同一条线）。订单算在下单那天。</li>
          <li>已取消的单（含店员取消和「全部菜品已退款」自动取消）不算营收、不算有效订单。</li>
          <li>实收营收 = 未取消订单的下单金额 − 这些订单上的按菜品行退款。</li>
          <li>储值净变动 = 当天所有储值流水的合计（充值、消费、退款、调整、迁移导入）；「此刻全店储值余额」是所有会员现在的余额之和，不随所选日期变。</li>
        </ul>
      </details>
    </div>
  );
}
