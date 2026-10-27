// 54号：小样定稿的组件原样进主程序——图标（面性 + 微立体）、氛围背景层、算盘珠、缩略图、大图、墨迹渐显、区块标题、浮动 Dock
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Dish } from '@pkg/contract';
import { EmptyArt, Seal } from '@pkg/ui-kit';
import type { Load } from './api.ts';
import { brand, FINISHED, LOGO_SEAL, money } from './common.tsx';
import { flyBlob, inkSentences, moving, popBadge, tier } from './fx.ts';
import { splitName } from './thumb.ts';

/* ---------------- 图标：代码画，面性；微立体 = 同色系渐变填充 + 顶部 40% 白高光弧 + 底部同色投影 ---------------- */
const PATHS = {
  order: { f: 'M3 11h18a9 9 0 0 1-18 0Z', s: 'M8 4c1 1 1 2 0 3m4-3c1 1 1 2 0 3m4-3c1 1 1 2 0 3' },
  pickup: { f: 'M12 3a6 6 0 0 0-6 6v3.5L4.2 16h15.6L18 12.5V9a6 6 0 0 0-6-6Zm-2.2 15a2.2 2.2 0 0 0 4.4 0Z' },
  member: { f: 'M3 7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v1H3Zm0 4h18v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Zm3 4v2h5v-2Z' },
  me: { f: 'M12 3.8a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4ZM3.8 20.5c.8-4 4.2-6.5 8.2-6.5s7.4 2.5 8.2 6.5Z' },
  back: { f: 'M10.5 2 4.5 8l6 6 1.4-1.4L7.3 8l4.6-4.6Z' },
  arrow: { f: 'M6 9 1.5 4.5l1-1L6 7l3.5-3.5 1 1Z' },
  bowl: { f: 'M3 11h18a9 9 0 0 1-18 0Z', s: 'M8 4c1 1 1 2 0 3m4-3c1 1 1 2 0 3m4-3c1 1 1 2 0 3' },
  shop: { f: 'M4 4h16l1.5 5a3 3 0 0 1-5.6 1.4A3 3 0 0 1 12 12a3 3 0 0 1-3.9-1.6A3 3 0 0 1 2.5 9ZM4.5 13.5a4.6 4.6 0 0 0 3.6-.9 4.6 4.6 0 0 0 3.9 1 4.6 4.6 0 0 0 3.9-1 4.6 4.6 0 0 0 3.6.9V20H4.5Zm5.5 2.5v4h4v-4Z' },
  book: { f: 'M4 4.5A2.5 2.5 0 0 1 6.5 2H20v16H6.5a1 1 0 0 0 0 2H20v2H6.5A2.5 2.5 0 0 1 4 19.5Zm5 2.5v2h7V7Z' },
  receipt: { f: 'M5 2h14v20l-2.4-1.6L14.3 22 12 20.4 9.7 22l-2.3-1.6L5 22Zm3 5v2h8V7Zm0 4v2h8v-2Zm0 4v2h5v-2Z' },
  speaker: { f: 'M3 9h4l5-4v14l-5-4H3Z', s: 'M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12' },
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, ink = false, className = '' }: { name: IconName; ink?: boolean; className?: string }) {
  const p: { f?: string; s?: string } = PATHS[name];
  const vb = name === 'back' ? 16 : name === 'arrow' ? 12 : 24;
  return (
    <svg viewBox={`0 0 ${vb} ${vb}`} className={`ico${ink ? ' ico-ink' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true">
      {p.f && <path className="f" d={p.f} />}
      {p.s && <path className="s" d={p.s} />}
      {p.f && <path className="hl" d={p.f} />}
    </svg>
  );
}

/** 渐变色标走 token，一页只放一份 */
export function IconDefs() {
  return (
    <svg className="defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="g-on" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: 'var(--ico-on-1)' }} /><stop offset="1" style={{ stopColor: 'var(--ico-on-2)' }} /></linearGradient>
        <linearGradient id="g-ink" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: 'var(--ico-ink-1)' }} /><stop offset="1" style={{ stopColor: 'var(--ico-ink-2)' }} /></linearGradient>
        <linearGradient id="g-hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: 'var(--hl-white)', stopOpacity: 0.4 }} /><stop offset=".4" style={{ stopColor: 'var(--hl-white)', stopOpacity: 0 }} /></linearGradient>
      </defs>
    </svg>
  );
}

/* ---------------- 背景层：纸底 →（饮品区淡绿）→ 呼吸层 → 光源 → 墨晕（暖 / 青交叉淡化）→ 纸纹；墨晕团随页面滚动 ---------------- */
export function Atmosphere() {
  const ink = useRef<HTMLDivElement>(null);
  // 视差：墨晕层 0.3 倍（只在 normal 档；只改 transform）
  useEffect(() => {
    let ticking = false;
    const on = () => {
      if (tier() !== 'normal' || ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        if (ink.current) ink.current.style.transform = `translate3d(0,${-window.scrollY * 0.3}px,0)`;
        ticking = false;
      });
    };
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  if (!FINISHED) return null;
  return (
    <>
      <div className="bg" aria-hidden="true">
        <div className="bg-alt" />
        <div className="breath"><i className="warm" /><i className="cool" /></div>
        <div className="light" /><div className="light alt" />
        <div className="ink" ref={ink}><i className="warm" /><i className="cool" /></div>
        <div className="grain" />
      </div>
      <div className="bloom" aria-hidden="true"><i className="warm" /><i className="cool" /></div>
    </>
  );
}

/* ---------------- 算盘珠（47号组件 1/2）：朱砂印加号 + 一体化浅色容器；减号、数字一开始就在（没加购时隐藏） ---------------- */
export function Qty({ name, qty, onChange }: { name: string; qty: number; onChange: (delta: number) => void }) {
  return (
    <div className={qty ? 'qty on' : 'qty'} data-qty={qty}>
      <span className="abacus" aria-hidden="true" />
      <button className="btn-round minus press" aria-label={`减少 ${name}`} hidden={!qty} onClick={() => onChange(-1)}><span className="g" aria-hidden="true">−</span></button>
      <b hidden={!qty} aria-label={`${name} 已选 ${qty} 份`}>{qty}</b>
      <button
        className="btn-round add"
        aria-label={qty ? `增加 ${name}` : `加购 ${name}`}
        onClick={(e) => { if (!flyBlob(e.currentTarget)) setTimeout(popBadge, 60); onChange(1); }}
      >
        <span className="g" aria-hidden="true">+</span>
      </button>
    </div>
  );
}

/* ---------------- 缩略图：老板传了菜品图就用真图（和详情页大图同一张）；没传的走「水墨意境占位」（首字 + 淡墨痕 + 小方印） ---------------- */
export function Thumb({ dish, char }: { dish: Dish; char: string }) {
  const [failed, setFailed] = useState(false);
  // 优先用小图（200px、十几 KB）；老数据没有小图就退回大图，内容完全一致
  const src = dish.images.thumb ?? dish.images.closed;
  if (src && !failed) {
    return <div className="thumb img"><img src={src} alt={dish.name} loading="lazy" decoding="async" onError={() => setFailed(true)} /></div>;
  }
  return (
    <div className="thumb ph" role="img" aria-label={`${dish.name}，实拍图上线中`}>
      {FINISHED && <><span aria-hidden="true">{char}</span><i className="mini-seal" aria-hidden="true" /></>}
    </div>
  );
}

/**
 * 大图：有图 = 真图 + 径向聚光；没图 = 水墨意境占位（浅墨晕 + 一缕墨痕）。云斑叠在大图与内容之间。
 *
 * `eager`：详情页标题上方那张图是首屏最显眼的元素，必须立刻加载（400ms 内要出现）。
 * 默认 lazy 是给列表、今日招牌大画用的，避免一次请求一百多张图。
 */
export function HeroImg({ dish, cloud = false, src = dish.images.closed, eager = false }: { dish: Dish; cloud?: boolean; src?: string | null; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <div className="hero-img img" role="img" aria-label={dish.name}>
        {/*
          属性名必须全小写 `fetchpriority`：React 18 不认驼峰的 fetchPriority，
          会在控制台刷「React does not recognize the `fetchPriority` prop」并且**不写进 DOM**，
          等于优先级根本没生效（React 19 才支持驼峰写法）。
        */}
        <img
          src={src}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          {...(eager ? { fetchpriority: 'high' } : {})}
          decoding="async"
          onError={() => setFailed(true)}
        />
        {cloud && <i className="cloud" />}
      </div>
    );
  }
  return (
    <div className="hero-img ph" role="img" aria-label={`${dish.name}，成品图上线中`}>
      {cloud && <i className="cloud" />}
      <span className="n" aria-hidden="true">{dish.name}</span>
    </div>
  );
}

/* ---------------- 墨迹渐显：一句一句从浅变深（进入视野时才开始，只播一次） ---------------- */
export function InkText({ text, className, as: Tag = 'p' }: { text: string; className?: string; as?: 'p' | 'span' }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const show = () => el.querySelectorAll('.ink-line').forEach((s, i) => setTimeout(() => s.classList.add('in'), moving() ? i * 90 : 0));
    if (!('IntersectionObserver' in window)) { show(); return; }
    const io = new IntersectionObserver(([en]) => { if (en?.isIntersecting) { show(); io.disconnect(); } }, { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, [text]);
  return (
    <Tag ref={ref as never} className={className}>
      {inkSentences(text).map((t, i) => <span key={i} className="ink-line">{t}</span>)}
    </Tag>
  );
}

/** 47号 B1 区块标题双层（绿茶画册式）：中文大字 / 英文宽体衬线全大写独立一行 / 细金线横贯 */
export function SecHead({ zh, en }: { zh: string; en?: string }) {
  return (
    <div className="sec-head">
      <h2>{zh}</h2>
      {FINISHED && en && <p className="en" aria-hidden="true">{en}</p>}
      <i className="rule" aria-hidden="true" />
    </div>
  );
}

/** 纸白轻透面板的标题行：书法标题 + 金线（新页面用） */
export function PanelTitle({ children, en }: { children: ReactNode; en?: string }) {
  return (
    <div className="panel-title">
      <h2 className="brush-title">{children}</h2>
      {FINISHED && en && <span className="en" aria-hidden="true">{en}</span>}
      <i className="rule" aria-hidden="true" />
    </div>
  );
}

/* ---------------- 56号 菜名一行显示：先降字号（不低于下限）→ 再收字距 → 都不够才两行，并且只断在意思完整的地方 ---------------- */
const fitters = new Map<Element, () => void>();
let fitObserver: ResizeObserver | null = null;
const watchFit = (el: Element, fn: () => void) => {
  fitObserver ??= new ResizeObserver((list) => list.forEach((e) => fitters.get(e.target)?.()));
  fitters.set(el, fn);
  fitObserver.observe(el);
  return () => { fitters.delete(el); fitObserver?.unobserve(el); };
};
// 字体文件到了以后字宽会变，统一重量一次
if (typeof document !== 'undefined') void document.fonts?.ready.then(() => fitters.forEach((f) => f()));

export function FitText({ text, max, min }: { text: string; max: number; min: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [wrap, setWrap] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.classList.remove('fit-wrap');
      el.style.letterSpacing = '';
      let size = max;
      el.style.fontSize = `${size}px`;
      const over = () => el.scrollWidth > el.clientWidth + 0.5;
      while (over() && size > min) el.style.fontSize = `${--size}px`;
      if (over()) el.style.letterSpacing = '0';
      const need = over();
      if (need) el.classList.add('fit-wrap');
      setWrap(need);
    };
    fit();
    return watchFit(el, fit);
  }, [text, max, min]);
  const parts = wrap ? splitName(text) : null;
  return (
    <span ref={ref} className={wrap ? 'fit fit-wrap' : 'fit'}>
      {parts && parts[1] ? <><span className="fit-part">{parts[0]}</span><span className="fit-part">{parts[1]}</span></> : text}
    </span>
  );
}

export const EN = brand.englishLabels;
export const priceText = (d: Pick<Dish, 'priceSen'>) => money(d.priceSen);

/* ---------------- 浮动 Dock（47号组件 5/6）：墨玻璃胶囊；选中 = 一个浅色药丸滑到被点的页签（180ms，只动 transform） ---------------- */
const TABS = [
  { key: 'order', label: '点单' },
  { key: 'pickup', label: '取餐' },
  { key: 'member', label: '会员' },
  { key: 'me', label: '我的' },
] as const;
export type TabKey = (typeof TABS)[number]['key'];
export const TAB_KEYS = TABS.map((t) => t.key) as readonly string[];

export function Dock({ active }: { active: TabKey }) {
  const nav = useRef<HTMLElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const tab = nav.current?.querySelector<HTMLElement>('.tab.on');
      if (!tab || !pill.current) return;
      pill.current.style.width = `${tab.offsetWidth - 12}px`;
      pill.current.style.transform = `translateX(${tab.offsetLeft + 6}px)`;
    };
    place();
    // 第一次定位不要过渡，之后切页签才滑
    requestAnimationFrame(() => pill.current?.classList.add('ready'));
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [active]);
  return (
    <nav className="dock tray" aria-label="主导航" ref={nav}>
      <span className="dock-pill" aria-hidden="true" ref={pill} />
      {TABS.map((t) => (
        <a key={t.key} href={`#${t.key}`} className={t.key === active ? 'tab on' : 'tab'} aria-current={t.key === active ? 'page' : undefined}>
          <Icon name={t.key} />
          <span>{t.label}</span>
        </a>
      ))}
    </nav>
  );
}

/** 加载中 / 出错 / 正常三种情况；出错给重试按钮，绝不白屏 */
export function Loaded<T>({ load, retry, children }: { load: Load<T>; retry: () => void; children: (d: T) => ReactNode }) {
  if (load.state === 'loading') return <p className="muted center">加载中…</p>;
  if (load.state === 'error') {
    return (
      <section className="panel glass error" role="alert">
        <PanelTitle>没能加载出来</PanelTitle>
        <p className="muted">{load.message}</p>
        <button className="btn" onClick={retry}>重试</button>
      </section>
    );
  }
  return <>{children(load.data)}</>;
}

/** 空状态：成品态 = 线稿碗 + 一枚落款圆戳；骨架态 = 只有文字 */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  if (FINISHED) {
    return (
      <EmptyArt title={title}>
        {children}
        {LOGO_SEAL && <Seal char={LOGO_SEAL} size="md" />}
      </EmptyArt>
    );
  }
  return <section className="empty-art"><h2>{title}</h2>{children}</section>;
}

/**
 * 浮在最上面的层（托盘、详情底栏、拆开看看舞台、弹层、提示、导航）：挂到 body 下，层级在大水印（压在面板前面）之上。
 * 页面内容整体在 .app 里（层级 1），大水印 2，这些 19–40
 */
export const Float = ({ children }: { children: ReactNode }) => createPortal(children, document.body);

/** 这一块是不是正在屏幕上（用来只给看得见的东西跑过渡） */
export const offscreen = (el: Element) => { const r = el.getBoundingClientRect(); return r.bottom < 0 || r.top > window.innerHeight; };
export type Style = CSSProperties & Record<`--${string}`, string | number>;
