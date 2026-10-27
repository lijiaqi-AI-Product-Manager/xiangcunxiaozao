import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { installErrorReporting } from '@pkg/ui-kit';
import { App } from './App.tsx';
import './styles.css';

// 前端错误上报（P3-8）：报错进后台，老板端「错误日志」页能看到
installErrorReporting('admin');

/** 兜底：任何页面崩溃只显示错误卡片，绝不白屏（21号 §3.2） */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel crash" role="alert">
        <h2>页面出错了</h2>
        <p className="muted">{this.state.error.message}</p>
        <button className="btn" onClick={() => location.reload()}>重新加载</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </StrictMode>,
);
