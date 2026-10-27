/**
 * 错误日志：顾客手机 / 老板电脑上「白屏、按钮点不动、闪一下就没了」这类问题，都会落到这里。
 *
 * 为什么要有这一页：
 * 以前顾客在桌边手机上遇到报错，老板完全不知道——客人只会说「你这个小程序不好用」，
 * 人一走现场就没了。现在前端出错会自己上报（同一处错误只存一行、按次数累加），
 * 老板打开这一页就能看到「哪台设备、哪个页面、什么错、发生了几次」，出了问题能当场看。
 *
 * 数据量很小：同一条错误反复发生只是 hits +1，所以不做分页，最多取最近 200 条。
 */
import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '@pkg/contract';
import config from 'virtual:brand';
import { z } from 'zod';
import { adminGet, adminPost } from './api.ts';
import { askConfirm } from './Confirm.tsx';

const { brand } = config;

const ClientError = z.object({
  app: z.string(),
  message: z.string(),
  source: z.string().nullable(),
  lineno: z.number().nullable(),
  stack: z.string().nullable(),
  ua: z.string().nullable(),
  url: z.string().nullable(),
  hits: z.number(),
  first_at: z.string(),
  last_at: z.string(),
});
type ClientError = z.infer<typeof ClientError>;
const ErrorList = z.object({ errors: z.array(ClientError), total: z.number() });

const errText = (e: unknown) => (e instanceof Error ? e.message : '操作失败');
const appLabel = (app: string) => (app === 'admin' ? '老板端' : '顾客端');

/** 把 User-Agent 压成一句人话：老板不关心 Chrome 137.0.7151.xxx，只关心「什么手机」 */
function deviceOf(ua: string | null): string {
  if (!ua) return '未知设备';
  const phone = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? '安卓手机' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : '';
  const browser = /MicroMessenger/.test(ua) ? '微信' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '';
  const model = /Android[^)]*?;\s*([^;)]+?)\s*(?:Build|\))/.exec(ua)?.[1]?.trim();
  return [model || phone, browser].filter(Boolean).join(' · ') || '未知设备';
}

export function ErrorsPage() {
  const [list, setList] = useState<ClientError[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [only, setOnly] = useState<'all' | 'customer' | 'admin'>('all');
  const [copied, setCopied] = useState(false);
  /** 剪贴板不可用时的兜底文本（页面里给一个可全选的框） */
  const [fallbackText, setFallbackText] = useState<string | null>(null);

  const load = useCallback(() => {
    adminGet('/api/admin/client-errors?limit=200', (v) => ErrorList.parse(v))
      .then((d) => { setList(d.errors); setTotal(d.total); setError(null); })
      .catch((e: unknown) => setError(errText(e)));
  }, []);

  useEffect(load, [load]);

  const clear = async () => {
    const ok = await askConfirm({
      title: '清空全部错误日志？',
      detail: `共 ${total} 条记录，清空后无法恢复。已经修好的旧错误会一起消失，之后新发生的错误照常记录。`,
      confirmText: '清空',
      danger: true,
    });
    if (!ok) return;
    try {
      await adminPost('/api/admin/client-errors/clear', {}, (v) => z.object({ ok: z.boolean() }).parse(v));
      load();
    } catch (e) {
      setError(errText(e));
    }
  };

  /** 把当前列表导成纯文本，方便老板直接发微信给维护的人 */
  const copyAll = async () => {
    const rows = shown.map((r) =>
      [
        `[${appLabel(r.app)}] ${r.message}`,
        `位置：${r.source ?? '未知'}${r.lineno ? `:${r.lineno}` : ''}`,
        `次数：${r.hits}　最近：${formatDateTime(r.last_at, brand.timezone)}`,
        `页面：${r.url ?? '未知'}　设备：${r.ua ?? '未知'}`,
        r.stack ? `堆栈：\n${r.stack}` : '',
      ].filter(Boolean).join('\n'),
    );
    const text = rows.length ? rows.join('\n\n---\n\n') : '没有错误记录';
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 非 https 或浏览器不给剪贴板权限时，不能弹 window.prompt：
      // 那个原生框在 iPad / WebView 里常常根本不显示，老板会以为「点了没反应」。
      // 改成页面里给一个可直接全选的文本框，让老板自己复制。
      setFallbackText(text);
    }
  };

  if (error) return <div className="panel crash" role="alert"><h2>错误日志没能加载</h2><p className="muted">{error}</p><button className="btn" onClick={load}>重试</button></div>;
  if (!list) return <div className="panel"><p className="muted">加载中…</p></div>;

  const shown = list.filter((r) => only === 'all' || r.app === only);
  const customerCount = list.filter((r) => r.app === 'customer').length;

  return (
    <>
      <div className="panel toolbar err-toolbar">
        <label>
          <span className="sr">来源</span>
          <select value={only} onChange={(e) => setOnly(e.target.value as typeof only)}>
            <option value="all">全部（{list.length}）</option>
            <option value="customer">顾客端（{customerCount}）</option>
            <option value="admin">老板端（{list.length - customerCount}）</option>
          </select>
        </label>
        <span className="muted small">
          共 {total} 条记录{total > list.length ? `，这里显示最近 ${list.length} 条` : ''}。同一条错误反复发生只累加次数。
        </span>
        <span className="grow" aria-hidden="true" />
        <button className="btn" onClick={load}>刷新</button>
        <button className="btn" onClick={() => void copyAll()} disabled={!shown.length}>
          {copied ? '已复制' : '复制全部'}
        </button>
        <button className="btn danger" onClick={() => void clear()} disabled={!total}>清空日志</button>
      </div>

      {fallbackText !== null && (
        <div className="panel copy-fallback" role="region" aria-label="手动复制错误日志">
          <p className="muted small">浏览器不让自动复制（常见于 http 或平板上），请手动全选下面这段发出去：</p>
          <textarea readOnly value={fallbackText} rows={8} aria-label="错误日志原文" onFocus={(e) => e.currentTarget.select()} />
          <button className="btn" onClick={() => setFallbackText(null)}>收起</button>
        </div>
      )}

      {!list.length && (
        <div className="panel empty-note">
          <p><strong>还没有前端报错。</strong></p>
          <p className="muted small">
            顾客在桌边手机上遇到白屏、按钮点不动、页面闪退这类问题，会自动记到这里——不用等他打电话来问。
            出现问题时，请客人刷新一下页面再试；如果同一句话一直出现，把这一页「复制全部」发给维护的人即可。
          </p>
        </div>
      )}

      {Boolean(list.length) && !shown.length && (
        <div className="panel"><p className="muted">这个来源下没有记录。</p></div>
      )}

      {shown.map((r) => (
        <div className="panel err-card" key={`${r.app}|${r.message}|${r.source ?? ''}|${r.lineno ?? ''}`}>
          <div className="err-head">
            <span className={r.app === 'admin' ? 'tag-admin' : 'tag-customer'}>{appLabel(r.app)}</span>
            <strong className="err-msg">{r.message}</strong>
            <span className="grow" aria-hidden="true" />
            {r.hits > 1 && <span className="err-hits">发生 {r.hits} 次</span>}
          </div>
          <div className="err-meta muted small">
            <span>{formatDateTime(r.last_at, brand.timezone)}</span>
            <span>{deviceOf(r.ua)}</span>
            <span>{r.source ? `${r.source.split('/').pop()}${r.lineno ? `:${r.lineno}` : ''}` : '位置未知'}</span>
          </div>
          {r.url && <div className="err-meta muted small"><span className="ellipsis" title={r.url}>{r.url}</span></div>}
          {r.stack && (
            <details className="err-stack">
              <summary>技术细节</summary>
              <pre>{r.stack}</pre>
            </details>
          )}
        </div>
      ))}
    </>
  );
}
