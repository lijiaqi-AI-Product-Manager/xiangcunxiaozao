import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/base.css';
import './styles/order.css';
import './styles/detail.css';
import './styles/pages.css';

const start = () => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 58号 演示版（scripts/build-demo.ts）：先装好浏览器内的模拟接口再渲染；正式构建这段是死代码，demo.ts 不会被打包
if (import.meta.env.VITE_DEMO) void import('./demo.ts').then((m) => m.installDemo()).then(start);
else start();
