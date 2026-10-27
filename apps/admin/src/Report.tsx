/**
 * 日结单 / 交接班报表（P2-4）
 *
 * 老板的用法只有两种：
 *   ① 一天忙完，点「结今天」——一张纸，收了多少、退了多少、储值进出多少，签个字收工；
 *   ② 交接班，选好两个时间点（可以跨零点，比如 17:00 到次日 02:00），打一张交给下一班。
 *
 * 页面上所有数字都来自服务器现算（/api/admin/report），这里不做任何加减乘除，
 * 免得页面上算一遍、纸上一遍，两边对不上。
 */
import { useCallback, useEffect, useState } from 'react';
import { DayReport, formatDateTime, formatMoney, type DayReport as DayReportT } from '@pkg/contract';
import config from 'virtual:brand';
import { adminGet } from './api.ts';
import { addDays, presetRange, todayLocal, type Preset } from './report-range.ts';

const { brand } = config;
// 账单固定两位小数：一列金额叠着看，不补齐小数位会上下对不齐，也容易被当成打错
const money = (sen: number) => `${brand.currency.symbol} ${formatMoney(sen)}`;
const signed = (sen: number) => (sen > 0 ? `+${money(sen)}` : sen < 0 ? `−${money(-sen)}` : money(0));
const payLabel = (key: string) => brand.paymentMethods.find((m) => m.key === key)?.label ?? key;
const errText = (e: unknown) => (e instanceof Error ? e.message : '操作失败');

/** 门店时区的今天 / 加减天数 / 常用时间段的计算都在 ./report-range.ts，那边有单测 */
const plusOneDay = (day: string): string => addDays(day, 1);

export function ReportPage() {
  // 默认结今天：从今天 00:00 到明天 00:00。
  // datetime-local 不认「只有日期」的值，必须写成 YYYY-MM-DDTHH:mm，否则输入框是空的（老板会以为坏了）
  const [from, setFrom] = useState(() => `${todayLocal(new Date(), brand.timezone)}T00:00`);
  const [to, setTo] = useState(() => `${plusOneDay(todayLocal(new Date(), brand.timezone))}T00:00`);
  const [shift, setShift] = useState('');
  const [operator, setOperator] = useState('');
  const [data, setData] = useState<DayReportT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await adminGet(`/api/admin/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, (v) => DayReport.parse(v)));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  /** 常用时间段一键填好：手输日期最容易输错，能少打一次就少错一次 */
  const preset = (kind: Preset) => {
    const r = presetRange(kind, new Date(), brand.timezone);
    setFrom(r.from);
    setTo(r.to);
    // 「今天 / 昨天」是整天不是某一班，一定要清掉班次；
    // 原来只切时间不清班次，点过晚市再点今天，单子上会印着「班次：晚市」却是全天账，交班签字会串账。
    setShift(r.shift);
  };

  return (
    <div className="report">
      <div className="panel toolbar no-print">
        <label>
          <span className="muted small">从</span>
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          <span className="muted small">到</span>
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            // 结束时间永远是「不含」，老板容易以为是包含，写在这里最容易被看见
            title="不含这一刻"
          />
        </label>
        <button className="btn" onClick={() => preset('today')}>今天</button>
        <button className="btn" onClick={() => preset('yesterday')}>昨天</button>
        {/*
          「刚收的晚市」在营业中（17:00 之后）指的是**今晚这一班**，结到此刻为止；
          白天（02:00~17:00）指的才是昨晚那一班。提示文字也跟着说清楚，
          否则老板晚上按下去看见 17:00~18:00 会觉得「怎么不是一整班」。
        */}
        <button className="btn" onClick={() => preset('lastShift')} title="刚收的那一班（营业中就是今晚这一班，结到此刻）">刚收的晚市</button>
        <button className="btn" onClick={() => preset('shift')} title="还没开始的那一班：17:00 到次日 02:00">下一班</button>
        <button className="btn primary" onClick={() => void load()} disabled={busy}>结账</button>
        <button className="btn" onClick={() => window.print()} disabled={!data}>打印 / 存 PDF</button>
      </div>

      <div className="panel toolbar no-print report-meta-input">
        <label>
          <span className="muted small">班次</span>
          <input value={shift} onChange={(e) => setShift(e.target.value)} placeholder="早班 / 晚班（可不填）" maxLength={20} />
        </label>
        <label>
          <span className="muted small">经手人</span>
          <input value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="谁结的账（可不填）" maxLength={20} />
        </label>
      </div>

      {error && <div className="panel crash" role="alert"><h2>日结单没能生成</h2><p className="muted">{error}</p><button className="btn" onClick={() => void load()}>重试</button></div>}
      {!data && !error && <div className="panel"><p className="muted">正在算账…</p></div>}

      {data && (
        <article className="panel slip" aria-label="日结单">
          <header className="slip-head">
            <h2>{brand.shortName} 日结单</h2>
            <p className="slip-range">{data.rangeText}</p>
            <p className="slip-meta">
              {shift && <span>班次：{shift}</span>}
              {operator && <span>经手人：{operator}</span>}
              <span>打印时间：{formatDateTime(data.generatedAt, brand.timezone)}</span>
            </p>
          </header>

          <div className="slip-big">
            <div>
              <p className="stat-label">实收</p>
              <p className="stat-big">{money(data.netSen)}</p>
            </div>
            <div>
              <p className="stat-label">有效订单</p>
              <p className="stat-big">{data.orders}<span> 单</span></p>
            </div>
            <div>
              <p className="stat-label">客单价</p>
              <p className="stat-big">{money(data.avgPerOrderSen)}</p>
            </div>
          </div>

          <section className="slip-sec">
            <h3>收款与退款</h3>
            <table>
              <tbody>
                <tr><th>下单金额</th><td className="num">{money(data.grossSen)}</td></tr>
                <tr><th>退款合计</th><td className="num">{data.refundSen ? `−${money(data.refundSen)}` : money(0)}</td></tr>
                {Boolean(data.refundSen) && (
                  <>
                    <tr className="sub"><th>　其中退回储值卡</th><td className="num">{money(data.refundStoredSen)}</td></tr>
                    <tr className="sub"><th>　其中柜台退现</th><td className="num">{money(data.refundCounterSen)}</td></tr>
                  </>
                )}
                <tr className="total"><th>实收</th><td className="num">{money(data.netSen)}</td></tr>
                {Boolean(data.cancelled) && <tr className="sub"><th>取消未收款的单</th><td className="num">{data.cancelled} 单</td></tr>}
              </tbody>
            </table>
          </section>

          {Boolean(data.byMethod.length) && (
            <section className="slip-sec">
              <h3>按付款方式</h3>
              <table>
                <thead>
                  <tr><th>付款方式</th><th className="num">笔数</th><th className="num">收款</th><th className="num">退款</th><th className="num">净收</th></tr>
                </thead>
                <tbody>
                  {data.byMethod.map((m) => (
                    <tr key={m.method}>
                      <th>{payLabel(m.method)}</th>
                      <td className="num">{m.orders}</td>
                      <td className="num">{money(m.grossSen)}</td>
                      <td className="num">{m.refundSen ? `−${money(m.refundSen)}` : '—'}</td>
                      <td className="num">{money(m.netSen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">混合支付的单会拆成两行：储值部分记在储值，剩下的记在另一种方式。</p>
            </section>
          )}

          <section className="slip-sec">
            <h3>储值变动</h3>
            <table>
              <tbody>
                <tr><th>充值</th><td className="num">{signed(data.stored.rechargeSen)}</td></tr>
                <tr><th>消费</th><td className="num">{signed(data.stored.consumeSen)}</td></tr>
                <tr><th>退回</th><td className="num">{signed(data.stored.refundSen)}</td></tr>
                <tr><th>调整</th><td className="num">{signed(data.stored.adjustSen)}</td></tr>
                {Boolean(data.stored.importSen) && <tr><th>老系统导入</th><td className="num">{signed(data.stored.importSen)}</td></tr>}
                <tr className="total"><th>本班净变动</th><td className="num">{signed(data.stored.netSen)}</td></tr>
                <tr className="sub"><th>此刻全店储值余额</th><td className="num">{money(data.storedBalanceSen)}</td></tr>
              </tbody>
            </table>
          </section>

          {Boolean(data.topDishes.length) && (
            <section className="slip-sec">
              <h3>卖出去了什么</h3>
              <table>
                <thead><tr><th>菜品</th><th className="num">份数</th><th className="num">金额</th></tr></thead>
                <tbody>
                  {data.topDishes.map((d) => (
                    <tr key={d.name}>
                      <th>{d.name}</th>
                      <td className="num">{d.qty}</td>
                      <td className="num">{money(d.netSen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {data.orders === 0 && data.cancelled === 0 && (
            <p className="muted slip-empty">这个时间段没有订单。</p>
          )}

          <footer className="slip-foot">
            <p className="muted small">
              说明：金额已含税；退款按「钱从哪出去」分两栏——退回储值卡的下一单能接着用，柜台退现的需要数现金对账。
              跨班次退款（今天退昨天的单）记在退款发生的那一班。
            </p>
            <div className="sign">
              <span>经手人签字：</span><span className="line" />
              <span>接班签字：</span><span className="line" />
            </div>
          </footer>
        </article>
      )}
    </div>
  );
}
