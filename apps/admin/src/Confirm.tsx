/**
 * 二次确认弹窗（替代 window.confirm）。
 *
 * 为什么不用 window.confirm：
 * 在 iPad Safari 上、以及「添加到主屏幕」后以 WebView 打开时，原生 confirm 有概率直接返回 true
 * 而不显示对话框。也就是说：退款、改价、充值这些危险操作，老板以为自己点过一次就确认了，
 * 实际上根本没确认过。这是钱的安全问题，不能用原生控件赌。
 *
 * 用法（Promise 化，写起来和 confirm 一样顺）：
 *   const ok = await askConfirm({ title: '确认退款？', detail: '...', danger: true });
 *   if (!ok) return;
 *
 * 实现说明：这里用一个极简的 imperative 容器，避免给每个页面都加一层 state。
 * 弹窗出现时焦点自动落在「取消」上（危险操作不默认确认），Esc 等同取消。
 */
import { useEffect, useRef, useState } from 'react';

export interface ConfirmOptions {
  title: string;
  /** 补充说明，比如「本次退储值 RM 20、退现金 RM 28」 */
  detail?: string;
  /** 确认按钮文字，默认「确认」 */
  confirmText?: string;
  /** 取消按钮文字，默认「取消」 */
  cancelText?: string;
  /** 危险操作（退款、取消订单）：确认按钮变红，焦点默认落在取消上 */
  danger?: boolean;
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

let push: ((p: Pending) => void) | null = null;
/**
 * Container 还没挂上时先排队。绝不能退化成 window.confirm：
 * 它在 iPad / WebView 里可能不弹就直接返回 true，等于把退款、改价默默执行掉。
 * 等 Container 挂载后把队列灌进去（正常时序下队列是空的）。
 */
let waiting: Pending[] = [];

/** 弹一个确认框，返回用户是否点了确认 */
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const p: Pending = { ...options, resolve };
    if (push) push(p);
    else waiting.push(p);
  });
}

/** 挂在 App 最外层一次即可 */
export function ConfirmHost() {
  const [queue, setQueue] = useState<Pending[]>([]);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const head = queue[0];

  useEffect(() => {
    push = (p) => setQueue((q) => [...q, p]);
    if (waiting.length > 0) {
      const pending = waiting;
      waiting = [];
      setQueue((q) => [...q, ...pending]);
    }
    return () => { push = null; };
  }, []);

  useEffect(() => {
    if (!head) return;
    // 危险操作默认焦点在「取消」：手快按下回车也不会误确认
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Enter' && !head.danger) { e.preventDefault(); close(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [head]);

  const close = (ok: boolean) => {
    setQueue((q) => {
      const [first, ...rest] = q;
      first?.resolve(ok);
      return rest;
    });
  };

  if (!head) return null;
  return (
    <div className="confirm-mask" role="presentation" onClick={() => close(false)}>
      <div
        className={head.danger ? 'confirm-box danger' : 'confirm-box'}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title">{head.title}</h2>
        {head.detail && <p className="confirm-detail">{head.detail}</p>}
        <div className="confirm-actions">
          <button ref={cancelRef} className="btn" onClick={() => close(false)}>{head.cancelText ?? '取消'}</button>
          <button className={head.danger ? 'btn danger solid' : 'btn primary'} onClick={() => close(true)}>
            {head.confirmText ?? '确认'}
          </button>
        </div>
      </div>
    </div>
  );
}
