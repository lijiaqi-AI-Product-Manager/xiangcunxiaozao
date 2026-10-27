/**
 * 页内二次确认（替代 window.confirm）。
 *
 * 为什么不能用原生 confirm：在 iPad Safari、以及「添加到主屏幕」后的 WebView 里，
 * 原生 confirm 有概率直接返回 true 而不显示任何对话框。顾客点「改桌号」，
 * 界面上什么都没弹，桌号却已经被改掉了——菜就送到别的桌去了。
 * 这是会直接影响上菜的事，不能用原生控件赌。
 *
 * 用法（和 confirm 一样顺）：
 *   if (!(await askConfirm({ title: '确定要改桌号吗？' }))) return;
 *
 * 和老板端 Confirm.tsx 一个思路（imperative 容器 + Promise），
 * 但文案风格按顾客端来：不出现「操作」「确认执行」这类后台词。
 */
import { useEffect, useRef, useState } from 'react';

export interface AskOptions {
  title: string;
  /** 补充说明，比如「菜做好会送到新桌号」 */
  detail?: string;
  /** 确认按钮文字，默认「确定」 */
  confirmText?: string;
  cancelText?: string;
}

type Pending = AskOptions & { resolve: (ok: boolean) => void };

let push: ((p: Pending) => void) | null = null;

export function askConfirm(options: AskOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (!push) {
      // 容器还没挂上（理论上不会）：退化成原生，至少不会静默放行
      resolve(window.confirm(options.detail ? `${options.title}\n${options.detail}` : options.title));
      return;
    }
    push({ ...options, resolve });
  });
}

/** 挂在顾客端最外层一次即可 */
export function AskHost() {
  const [queue, setQueue] = useState<Pending[]>([]);
  const okRef = useRef<HTMLButtonElement | null>(null);
  const head = queue[0];

  useEffect(() => {
    push = (p) => setQueue((q) => [...q, p]);
    return () => { push = null; };
  }, []);

  useEffect(() => {
    if (!head) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // close 只依赖 head，每次渲染重建即可
  });

  const close = (ok: boolean) => {
    head?.resolve(ok);
    setQueue((q) => q.slice(1));
  };

  if (!head) return null;
  return (
    <div className="ask-mask" role="presentation" onClick={() => close(false)}>
      <div
        className="ask-box"
        role="dialog"
        aria-modal="true"
        aria-label={head.title}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="ask-title">{head.title}</p>
        {head.detail && <p className="ask-detail">{head.detail}</p>}
        <div className="ask-actions">
          <button type="button" className="btn-ghost" onClick={() => close(false)}>{head.cancelText ?? '取消'}</button>
          <button type="button" className="btn-solid" ref={okRef} onClick={() => close(true)}>{head.confirmText ?? '确定'}</button>
        </div>
      </div>
    </div>
  );
}
