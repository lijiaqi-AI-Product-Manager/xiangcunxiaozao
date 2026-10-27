import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { installErrorReporting } from '@pkg/ui-kit';
import { App } from './App.tsx';
import './styles/base.css';
import './styles/order.css';
import './styles/detail.css';
import './styles/pages.css';

// 前端错误上报（P3-8）：出问题时老板能说清「哪个页面、哪台手机」，而不是只有一句「打不开」
installErrorReporting('customer');

/**
 * 兜底：任何页面崩溃只显示错误卡片，绝不白屏。
 *
 * 老板端早就有这个（21号 §3.2），顾客端一直没有——顾客扫码进来看到一个白屏，
 * 唯一能做的事就是走人，而老板完全不知道发生了什么。现在两边一致：
 * 出错显示一句人话 + 重新加载按钮，同时错误已经上报到后台。
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel crash" role="alert">
        <h2>页面出了点问题</h2>
        <p className="muted">这不是你的操作问题。点下面的按钮重新加载，购物车里的菜不会丢。</p>
        <button className="btn block big" onClick={() => location.reload()}>重新加载</button>
      </div>
    );
  }
}

const start = () => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </StrictMode>,
);

// 58号 演示版（scripts/build-demo.ts）：先装好浏览器内的模拟接口再渲染；正式构建这段是死代码，demo.ts 不会被打包
if (import.meta.env.VITE_DEMO) void import('./demo.ts').then((m) => m.installDemo()).then(start);
else start();
