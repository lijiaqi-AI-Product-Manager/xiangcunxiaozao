import { useEffect, useState } from 'react';
import { z } from 'zod';
import config from 'virtual:brand';
import { formatClockSec } from '@pkg/contract';
import { adminGet, adminPost } from './api.ts';

/**
 * 打印设置：装机那天把这页打开，就知道机器通不通。
 *
 * 设计原则——**每一行都要说人话**：
 * 不打「ECONNREFUSED 127.0.0.1:9100」，打「小票机：连不上，检查机器电源和网线」。
 * 老板不懂 TCP，但懂「机器没开」。
 */

const Health = z.object({ enabled: z.boolean(), ok: z.boolean(), detail: z.string() });
const JobRow = z.object({
  target: z.string(),
  orderNo: z.string(),
  ok: z.boolean(),
  attempts: z.number(),
  pages: z.number(),
  error: z.string().nullable(),
  at: z.string(),
});
const Printers = z.object({
  receipt: Health.optional(),
  label: Health.optional(),
  encoding: z.string(),
  recent: z.array(JobRow),
});
const JobResult = z.object({ target: z.string(), orderNo: z.string(), ok: z.boolean(), attempts: z.number(), pages: z.number(), error: z.string().optional(), at: z.string() });

type Printers = z.infer<typeof Printers>;
type Target = 'receipt' | 'label';

const { brand } = config;

const TARGET_LABEL: Record<Target, string> = { receipt: '小票机（前台）', label: '标签机（吧台）' };

/**
 * 把技术错误翻成人话。翻译不了的原样显示，至少不给假信息。
 *
 * 顺序有讲究：「连上了但机器没回话」里带着 IP，不能先被别的规则抓走；
 * 「可连通」这种老文案也认得出来——服务端如果还是旧版本，这一句会漏到界面上，
 * 而它恰恰是最误导人的一句（网线通 ≠ 能打纸），必须显式拦住。
 */
function humanError(detail: string): string {
  if (/可连通|可写|在线$/.test(detail) && !/没回话/.test(detail)) return '网线通了（这只是基础检测，能不能出纸请点「打测试页」）';
  if (/缺纸|纸尽|纸将尽|纸快用完/.test(detail)) return detail.replace(/^[\d.]+:\d+\s*/, '');
  if (/盖|盖子/.test(detail)) return detail.replace(/^[\d.]+:\d+\s*/, '');
  if (/没回话/.test(detail)) return '机器没回话：检查电源、纸装好没有、盖子关紧没有';
  if (/ECONNREFUSED/.test(detail)) return '连不上：机器没开机，或者 IP 填错了';
  if (/超时|timeout/i.test(detail)) return '没响应：机器没开机，或者网线松了';
  if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND/.test(detail)) return '网络不通：打印机和电脑不在同一个 Wi-Fi';
  if (/EACCES|EPERM/.test(detail)) return '没权限写这个设备：换一个 USB 口，或者用管理员身份运行';
  if (/ENOENT/.test(detail)) return '找不到设备：USB 线没插好，或者驱动没装';
  if (/断开/.test(detail)) return '机器把连接断了：多半是机器自身报错，看一眼面板上的红灯';
  if (/^[\d.]+:\d+\s/.test(detail)) return `打印机没说清楚出了什么事（${detail}）——先点「打测试页」看纸出不出来`;
  return detail;
}

export function PrintersPage() {
  const [data, setData] = useState<Printers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = () =>
    adminGet('/api/admin/printers', (v) => Printers.parse(v))
      .then((v) => { setData(v); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载失败'));

  useEffect(() => { void load(); }, []);

  const test = async (target: Target) => {
    setBusy(target);
    setError(null);
    setOk(null);
    try {
      const r = await adminPost('/api/admin/printers/test', { target }, (v) => JobResult.parse(v));
      setOk(r.ok ? `${TARGET_LABEL[target]} 已送出 ${r.pages} 张，去机器那边看看纸出来没有` : `${TARGET_LABEL[target]} 没打出来：${humanError(r.error ?? '')}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '测试失败');
    } finally {
      setBusy(null);
    }
  };

  /**
   * 加载中要说清楚在等什么、大概等多久。
   *
   * 打印机没开机时，探测要等到超时才返回（几秒）。只写一行「加载中…」，
   * 老板会以为页面坏了、去刷新，反而更慢。这里把「正在连两台机器」说出来。
   */
  if (!data) {
    return (
      <div className="panel">
        <h2>打印设置</h2>
        {error
          ? <p className="form-error" role="alert">{error}</p>
          : (
            <p className="muted" role="status">
              正在连两台打印机…机器没开机时会多等几秒（等到超时才能确定「连不上」）。
              <button className="btn" style={{ marginLeft: 12 }} onClick={() => void load()}>重新检测</button>
            </p>
          )}
      </div>
    );
  }

  const failed = data.recent.filter((r) => !r.ok);

  return (
    <div className="printers">
      <section className="panel">
        <h2>两台机器</h2>
        <p className="muted small">
          顾客一点「下单」，这两台机器同时出纸：<strong>小票机</strong>打整单明细给收银/顾客，<strong>标签机</strong>只打这单里的饮品，一杯一张贴杯子上。
        </p>
        <ul className="printer-list">
          {(['receipt', 'label'] as Target[]).map((t) => {
            const h = data[t];
            return (
              <li key={t} className={!h ? 'off' : h.ok ? 'on' : 'bad'}>
                <div>
                  <strong>{TARGET_LABEL[t]}</strong>
                  <span className="muted small">
                    {!h || !h.enabled ? '未启用（在服务器的 .env 里打开 PRINT_' + t.toUpperCase() + '_ON）' : humanError(h.detail)}
                  </span>
                </div>
                <button className="btn" disabled={!h?.enabled || busy === t} onClick={() => void test(t)}>
                  {busy === t ? '发送中…' : '打测试页'}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="muted small">汉字编码：{data.encoding.toUpperCase()}（芯烨、佳博、中崎这些国产机型基本都是 GBK；打成乱码就改 .env 里的 PRINT_ENCODING）</p>
        {ok && <p className="form-ok" role="status">{ok}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn" onClick={() => void load()}>重新检测</button>
      </section>

      <section className="panel">
        <h2>最近的打印记录{failed.length > 0 && <span className="count bad-count">{failed.length} 张没出来</span>}</h2>
        {data.recent.length === 0 ? (
          <p className="muted">还没有打印记录。下一单之后这里会逐条出现。</p>
        ) : (
          <table className="recent">
            <thead><tr><th>时间</th><th>机器</th><th>单号</th><th>结果</th></tr></thead>
            <tbody>
              {data.recent.map((r, i) => (
                <tr key={`${r.at}-${i}`} className={r.ok ? '' : 'bad'}>
                  <td>{formatClockSec(r.at, brand.timezone)}</td>
                  <td>{TARGET_LABEL[r.target as Target] ?? r.target}</td>
                  <td>{r.orderNo}</td>
                  <td>
                    {r.ok ? `${r.pages} 张，正常` : `失败 ${r.attempts} 次：${humanError(r.error ?? '')}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {failed.length > 0 && (
          <p className="muted small">
            纸上没出来但单已经进了系统：到「<a href="#orders">实时订单</a>」找到那一单，点「重新打印」补一张就行，不用重下。
          </p>
        )}
      </section>
    </div>
  );
}
