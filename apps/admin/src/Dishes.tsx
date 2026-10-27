import { useEffect, useMemo, useRef, useState } from 'react';
import { AdminDish, DISH_STATE_LABEL, formatPrice, parseRM, TODAY_MAX, TodaySignature, type AdminDish as AdminDishT, type DishState } from '@pkg/contract';
import { DishImage } from '@pkg/ui-kit';
import config from 'virtual:brand';
import { z } from 'zod';
import { adminGet, adminPost, adminUpload } from './api.ts';
import { askConfirm } from './Confirm.tsx';
import { compressImage, kb } from './compress.ts';

const { brand } = config;
const money = (sen: number | null) => `${brand.currency.symbol} ${formatPrice(sen)}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : '操作失败');
const DISASSEMBLY_LABEL = { 'dual-image': '双图法', annotation: '标注层', none: '—' } as const;

/** 菜品管理：上下架、改价、上传图片。每次改动服务器都会留痕（谁、何时、从多少改到多少） */
export function DishesPage() {
  const [dishes, setDishes] = useState<AdminDishT[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');
  const [onlyOff, setOnlyOff] = useState(false);

  const [today, setToday] = useState<string[] | null>(null);
  /** 批量：勾中的 uid。筛选条件变了不清空——老板可能先勾一批再换个分类接着勾 */
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  /** 批量改完的那句话。勾选一清空批量条就没了，这句话得留在外面，否则老板看不到「到底改了没有」 */
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);

  useEffect(() => {
    adminGet('/api/admin/dishes', (v) => z.array(AdminDish).parse(v)).then(setDishes).catch((e: unknown) => setError(errText(e)));
    adminGet('/api/admin/today', (v) => TodaySignature.parse(v)).then((t) => setToday(t.dishes)).catch((e: unknown) => setError(errText(e)));
  }, []);
  const replace = (d: AdminDishT) => setDishes((list) => (list ?? []).map((x) => (x.uid === d.uid ? d : x)));

  const shown = useMemo(() => {
    const rank = new Map(brand.categoryOrder.map((k, i) => [k, i]));
    return (dishes ?? [])
      .filter((d) => (cat === 'all' || d.categoryKey === cat) && (!onlyOff || (d.sellable && d.state !== 'on')) &&(!q.trim() || d.name.includes(q.trim()) || d.code.includes(q.trim().toUpperCase())))
      .sort((a, b) => (rank.get(a.categoryKey) ?? 99) - (rank.get(b.categoryKey) ?? 99));
  }, [dishes, cat, q, onlyOff]);

  if (error) return <div className="panel crash" role="alert"><h2>菜品没能加载</h2><p className="muted">{error}</p></div>;
  if (!dishes) return <div className="panel"><p className="muted">加载中…</p></div>;
  const offCount = dishes.filter((d) => d.sellable && d.state !== 'on').length;

  // 勾选只对「当前列表里看得见的菜」生效：全选不该悄悄把筛选掉的菜也勾上，
  // 否则老板筛着「凉菜」点了全选，结果把整个菜单都下架了。
  const pickable = shown.filter((d) => d.sellable).map((d) => d.uid);
  const pickedHere = pickable.filter((u) => picked.has(u));
  const allPicked = pickable.length > 0 && pickedHere.length === pickable.length;
  const toggle = (uid: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(uid)) next.delete(uid); else next.add(uid);
    return next;
  });
  const toggleAll = () => setPicked((prev) => {
    const next = new Set(prev);
    if (allPicked) pickable.forEach((u) => next.delete(u));
    else pickable.forEach((u) => next.add(u));
    return next;
  });

  return (
    <>
    <TodayPanel dishes={dishes} today={today} onChange={setToday} />
    <div className="panel">
      <div className="toolbar dish-filters">
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="按分类筛选">
          <option value="all">全部分类</option>
          {brand.categoryOrder.map((k) => <option key={k} value={k}>{brand.categoryNames[k] ?? k}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="菜名或编号" aria-label="搜索菜品" />
        <label className="check"><input type="checkbox" checked={onlyOff} onChange={(e) => setOnlyOff(e.target.checked)} /> 只看售罄 / 下架（{offCount}）</label>
        <span className="muted small">共 {dishes.length} 项 · 改价只影响之后的新订单</span>
      </div>
      {pickedHere.length > 0 && (
        <BulkBar
          count={pickedHere.length}
          total={pickable.length}
          onClear={() => setPicked(new Set())}
          onDone={(list, text) => { setDishes(list); setPicked(new Set()); setBulkMsg(text); }}
          uids={pickedHere}
        />
      )}
      {bulkMsg && pickedHere.length === 0 && (
        <p className="bulk-done" role="status">
          {bulkMsg}
          <button className="btn" onClick={() => setBulkMsg(null)} aria-label="关掉这条提示">知道了</button>
        </p>
      )}
      <p className="muted small bulk-hint">
        <label className="check">
          <input type="checkbox" checked={allPicked} onChange={toggleAll} aria-label="全选当前列表" disabled={pickable.length === 0} />
          全选当前列表（{pickable.length} 道可售）
        </label>
        {' '}勾几道菜可以一次性上下架，不用一道一道点。
      </p>
      <div className="table-wrap">
        <table className="dish-table">
          <thead>
            <tr><th className="pick-col">选</th><th>图片</th><th>编号</th><th>菜名</th><th className="num">价格</th><th>分类</th><th>状态</th><th>拆开看看</th><th /></tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <DishRow key={d.uid} dish={d} onChange={replace} today={today} onToday={setToday}
                picked={picked.has(d.uid)} onPick={() => toggle(d.uid)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
    </>
  );
}

/**
 * 54号 §2.2 今日招牌：挑哪几道菜上顾客端点单页顶部的大画（最多 5 道，按这里的顺序左右滑）；收起后的「今日招牌」横幅卡同源。
 * 图、菜名、价格都跟着菜单走，这里只排顺序。
 */
function TodayPanel({ dishes, today, onChange }: { dishes: AdminDishT[]; today: string[] | null; onChange: (ids: string[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (today === null) return null;
  const save = async (ids: string[]) => {
    setBusy(true);
    setError(null);
    try {
      onChange((await adminPost('/api/admin/today', { dishes: ids }, (v) => TodaySignature.parse(v))).dishes);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const move = (i: number, d: number) => { const ids = [...today]; [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!]; void save(ids); };
  return (
    <div className="panel today-panel">
      <h2>今日招牌 <span className="muted small">顾客端点单页顶部的大画，按顺序左右滑；最多 {TODAY_MAX} 道。在下面菜品表里点「设为今日招牌」添加。</span></h2>
      {today.length === 0 && <p className="muted">还没有设置：顾客端顶部只显示门店信息，不出大画。</p>}
      <ol className="today-list">
        {today.map((id, i) => {
          const d = dishes.find((x) => x.uid === id);
          return (
            <li key={id}>
              <span className="today-no">{i + 1}</span>
              <span>{d ? `${d.code ? `${d.code} ` : ''}${d.name} · ${money(d.priceSen)}` : id}</span>
              {d && d.state !== 'on' && <span className="tag">{DISH_STATE_LABEL[d.state]}，顾客端暂不显示</span>}
              <span className="img-actions">
                <button className="btn" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`把「${d?.name ?? id}」往前挪`}>上移</button>
                <button className="btn" disabled={busy || i === today.length - 1} onClick={() => move(i, 1)} aria-label={`把「${d?.name ?? id}」往后挪`}>下移</button>
                <button className="btn danger" disabled={busy} onClick={() => void save(today.filter((x) => x !== id))} aria-label={`把「${d?.name ?? id}」移出今日招牌`}>移出</button>
              </span>
            </li>
          );
        })}
      </ol>
      {error && <p className="row-error" role="alert">{error}</p>}
    </div>
  );
}

/**
 * 批量操作条：勾了菜才出现。
 *
 * 为什么只做「改状态」不做「批量改价」：状态是开关，一整类菜一起关掉是很自然的操作；
 * 价格是一道菜一个数，批量改价要么得填「统一改成多少」（把贵菜贱卖），
 * 要么得填「都涨 10%」（贴纸价不是这么定的）。做不好不如不做。
 */
function BulkBar({ uids, count, total, onClear, onDone }: {
  uids: string[]; count: number; total: number;
  onClear: () => void; onDone: (list: AdminDishT[], text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = async (state: DishState) => {
    setError(null); setMsg(null);
    setBusy(true);
    try {
      const r = await adminPost('/api/admin/dishes/bulk-state', { uids, state },
        (v) => z.object({ dishes: z.array(AdminDish), changed: z.number(), skipped: z.number() }).parse(v));
      const text = r.changed === 0
        ? `这 ${count} 道菜本来就是「${DISH_STATE_LABEL[state]}」，没有改动。`
        : `${r.changed} 道菜已改成「${DISH_STATE_LABEL[state]}」${r.skipped ? `，另有 ${r.skipped} 道不参与（配送费这类）已跳过` : ''}。`;
      onDone(r.dishes, text);
      setMsg(text);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bulk-bar" role="region" aria-label="批量操作">
      <strong>已选 {count} 道</strong>
      <span className="muted small">（当前列表共 {total} 道可售）</span>
      <span className="bulk-actions">
        {(['on', 'soldout', 'off'] as const).map((s) => (
          <button key={s} className="btn" disabled={busy} onClick={() => void apply(s)}>全部改成{DISH_STATE_LABEL[s]}</button>
        ))}
        <button className="btn" disabled={busy} onClick={onClear}>取消选择</button>
      </span>
      {msg && <span className="bulk-msg" role="status">{msg}</span>}
      {error && <span className="bulk-msg alert" role="alert">{error}</span>}
    </div>
  );
}

function DishRow({ dish, onChange, today, onToday, picked, onPick }: {
  dish: AdminDishT; onChange: (d: AdminDishT) => void; today: string[] | null; onToday: (ids: string[]) => void;
  picked: boolean; onPick: () => void;
}) {
  const [price, setPrice] = useState(formatPrice(dish.priceSen));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const { sellable } = dish;

  const run = async (p: Promise<AdminDishT>) => {
    setBusy(true);
    setError(null);
    try {
      const d = await p;
      onChange(d);
      setPrice(formatPrice(d.priceSen));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const savePrice = async () => {
    const sen = parseRM(price);
    if (sen === null || sen <= 0) { setError('价格格式不对，例如 25 或 9.9'); return; }
    if (sen === dish.priceSen) return;
    const ok = await askConfirm({ title: `确认改价？`, detail: `「${dish.name}」从 ${money(dish.priceSen)} 改成 ${money(sen)}。改完顾客端立刻生效，并记入改动日志。`, confirmText: '确认改价' });
    if (!ok) return;
    void run(adminPost(`/api/admin/dishes/${dish.uid}/price`, { priceSen: sen }, (v) => AdminDish.parse(v)));
  };
  const setState = (state: DishState) => {
    if (state === dish.state) return;
    void run(adminPost(`/api/admin/dishes/${dish.uid}/state`, { state }, (v) => AdminDish.parse(v)));
  };
  // P3 第④项：先在浏览器里压到 300KB 以内再上传，并告诉老板压了多少。
  // 同一张图顺手压一张小图（点单页 64×64 小格子用）一起传——**老板只传一次，两处都有图**。
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (file.current) file.current.value = '';
    setNote(null);
    const c = await compressImage(f);
    await run(adminUpload(`/api/admin/dishes/${dish.uid}/image`, c.file, (v) => AdminDish.parse(v), c.thumbFile));
    setNote(c.changed ? `图片已压缩：${kb(c.before)} → ${kb(c.after)}` : null);
  };
  const toToday = async () => {
    if (!today) return;
    setBusy(true);
    setError(null);
    try {
      onToday((await adminPost('/api/admin/today', { dishes: [...today, dish.uid] }, (v) => TodaySignature.parse(v))).dishes);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  // 34号 A：传错图的退路。删掉后回到「成品图上线中」占位（导入单里有图就回到那张），改动日志记下删的是哪张
  const clearImage = async () => {
    const ok = await askConfirm({ title: '确认删除这张图？', detail: `「${dish.name}」会恢复成「成品图上线中」占位。删除会记入改动日志。`, confirmText: '删除图片', danger: true });
    if (!ok) return;
    void run(adminPost(`/api/admin/dishes/${dish.uid}/image/clear`, {}, (v) => AdminDish.parse(v)));
  };

  return (
    <>
      <tr className={`${dish.state === 'on' ? '' : 'off'} ${picked ? 'picked' : ''}`.trim()}>
        <td className="pick-col">
          {sellable
            ? <input type="checkbox" checked={picked} onChange={onPick} aria-label={`选中 ${dish.name}`} />
            : <span className="muted small" aria-hidden="true">—</span>}
        </td>
        <td className="thumb"><DishImage src={dish.images.closed} name={dish.name} showName={false} caption="无图" /></td>
        <td>{dish.code || '—'}</td>
        <td>{dish.name}{dish.pending.length > 0 && <span className="tag">待高斯</span>}</td>
        <td className="num">
          {sellable ? (
            <span className="price-edit">
              <input value={price} onChange={(e) => setPrice(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void savePrice(); }} inputMode="decimal" aria-label={`${dish.name} 价格`} />
              {price !== formatPrice(dish.priceSen) && <button className="btn" disabled={busy} onClick={() => void savePrice()}>保存</button>}
            </span>
          ) : money(dish.priceSen)}
          {dish.basePriceSen !== null && dish.priceSen !== dish.basePriceSen && <span className="muted small"> 菜单原价 {formatPrice(dish.basePriceSen)}</span>}
        </td>
        <td>{brand.categoryNames[dish.categoryKey] ?? dish.categoryKey}</td>
        <td>
          {/* 28号 #5：在售 / 今日售罄（次日自动恢复）/ 下架，一键切换 */}
          {sellable ? (
            <span className="seg" role="group" aria-label={`${dish.name} 状态`}>
              {(['on', 'soldout', 'off'] as const).map((s) => (
                <button key={s} data-state={s} className="seg-btn" aria-pressed={dish.state === s} disabled={busy} onClick={() => setState(s)}>
                  {DISH_STATE_LABEL[s]}
                </button>
              ))}
            </span>
          ) : <span className="muted small">本期不在店内售卖</span>}
        </td>
        <td>{DISASSEMBLY_LABEL[dish.disassembly]}</td>
        <td>
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void onFile(e.target.files?.[0])} aria-label={`上传 ${dish.name} 图片`} />
          <span className="img-actions">
            <button className="btn" disabled={busy} onClick={() => file.current?.click()}>{dish.images.closed ? '换图' : '上传图片'}</button>
            {dish.imageUploaded && <button className="btn danger" disabled={busy} onClick={() => void clearImage()} aria-label={`删除 ${dish.name} 图片`}>删除图片</button>}
            {sellable && today && (
              today.includes(dish.uid)
                ? <span className="tag">今日招牌 {today.indexOf(dish.uid) + 1}</span>
                : <button className="btn" disabled={busy || today.length >= TODAY_MAX} onClick={() => void toToday()} aria-label={`把 ${dish.name} 设为今日招牌`}>设为今日招牌</button>
            )}
          </span>
        </td>
      </tr>
      {error && <tr className="row-error"><td colSpan={9} role="alert">「{dish.name}」：{error}</td></tr>}
      {note && !error && <tr className="row-note"><td colSpan={9} role="status">「{dish.name}」{note}</td></tr>}
    </>
  );
}
