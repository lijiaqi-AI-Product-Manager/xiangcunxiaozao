import { useEffect, useState } from 'react';
import { ADDRESS_MAX, normalizeStoreInfo, STORE_INFO_FIELDS, STORE_INFO_LABEL, StoreInfo, type StoreInfo as StoreInfoT } from '@pkg/contract';
import { adminGet, adminPost } from './api.ts';

/**
 * 58号 任务4 门店信息：地址 / 电话 / 营业时间 / WhatsApp。顾客端「我的」页门店小卡和功能格副字直接读这里。
 * 没填的那一行顾客看不到（不显示「待提供」）；四项都空，门店小卡整张不显示。
 */
const HINT: Record<keyof StoreInfoT, string> = {
  address: `最多 ${ADDRESS_MAX} 字`,
  phone: '可带空格、横杠，如 03-xxxx xxxx',
  hours: '可分段，用逗号隔开，如 11:00-15:00, 17:00-22:00；跨夜照写 17:00-02:00',
  whatsapp: '要带国家区号，以 + 开头；顾客点一下直接打开聊天',
};

// 和顾客端门店小卡的排列一致：营业时间、电话、WhatsApp 两两一行，地址最后占整行
const PREVIEW_ORDER: (keyof StoreInfoT)[] = ['hours', 'phone', 'whatsapp', 'address'];
const empty = (v: StoreInfoT) => STORE_INFO_FIELDS.every((k) => v[k] === null);
const toForm = (v: StoreInfoT) => Object.fromEntries(STORE_INFO_FIELDS.map((k) => [k, v[k] ?? ''])) as Record<keyof StoreInfoT, string>;

export function StoreInfoPage() {
  const [saved, setSaved] = useState<StoreInfoT | null>(null);
  const [form, setForm] = useState<Record<keyof StoreInfoT, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    // 只认最后一次加载的结果：开发模式下页面会挂载两次、发两次请求，晚到的那次不能把已经在填的表单冲掉
    let alive = true;
    adminGet('/api/admin/store-info', (v) => StoreInfo.parse(v))
      .then((v) => { if (alive) { setSaved(v); setForm(toForm(v)); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : '加载失败'); });
    return () => { alive = false; };
  }, []);
  if (!form || !saved) return <div className="panel"><p className={error ? 'form-error' : 'muted'}>{error ?? '加载中…'}</p></div>;

  // 先在本地按同一套规则检查，错了当场说，不用等服务器
  const check = normalizeStoreInfo(form);
  const dirty = STORE_INFO_FIELDS.some((k) => form[k] !== (saved[k] ?? ''));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!check.ok) { setError(check.message); return; }
    setBusy(true);
    setError(null);
    try {
      const v = await adminPost('/api/admin/store-info', form, (x) => StoreInfo.parse(x));
      setSaved(v);
      setForm(toForm(v));
      setOk(true);
      setTimeout(() => setOk(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };
  const preview = check.ok ? check.value : saved;
  return (
    <div className="store-info">
      <form className="panel store-info-form" onSubmit={(e) => void submit(e)} aria-label="门店信息">
        {STORE_INFO_FIELDS.map((k) => (
          <label key={k} className="field">
            <span>{STORE_INFO_LABEL[k]}</span>
            <input
              aria-label={STORE_INFO_LABEL[k]}
              aria-describedby={`hint-${k}`}
              value={form[k]}
              // 函数式更新：连续改几个框、页面还没来得及重画时，后一下不会拿旧表单把前一下盖掉
              onChange={(e) => { const v = e.target.value; setForm((f) => (f ? { ...f, [k]: v } : f)); setError(null); }}
              inputMode={k === 'phone' || k === 'whatsapp' ? 'tel' : undefined}
              maxLength={k === 'address' ? ADDRESS_MAX + 20 : 80}
            />
            <span className="muted small" id={`hint-${k}`}>{HINT[k]}；不填 = 顾客端不显示这一行</span>
          </label>
        ))}
        {error && <p className="form-error" role="alert">{error}</p>}
        {ok && <p className="form-ok" role="status">已保存，顾客端刷新后就能看到</p>}
        {/* 没改动时也能点（再存一次无害），不让老板面对一个不知道为什么点不动的按钮 */}
        <button className="btn primary" disabled={busy}>{busy ? '保存中…' : dirty ? '保存' : '保存（未改动）'}</button>
        <p className="muted small">这里的营业时间只是给顾客看的文字；几点开始、几点停止接单，在「实时订单」页顶上的营业状态里设。</p>
      </form>
      <section className="panel store-info-preview" aria-label="顾客端预览">
        <h2>顾客端会看到</h2>
        {empty(preview)
          ? <p className="muted">四项都没填：「我的」页不显示门店小卡。</p>
          : (
            <dl>
              {PREVIEW_ORDER.filter((k) => preview[k]).map((k) => (
                <div key={k}><dt>{STORE_INFO_LABEL[k]}</dt><dd>{preview[k]}</dd></div>
              ))}
            </dl>
          )}
        {!check.ok && <p className="muted small">（输入还没改对，预览先显示已保存的内容）</p>}
      </section>
    </div>
  );
}
