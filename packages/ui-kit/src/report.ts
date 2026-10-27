/**
 * 前端错误上报（P3-8）。
 *
 * 原则：
 * 1. **绝不因为上报而影响顾客**——所有调用都自己 try/catch，网络挂了就丢掉，
 *    不重试、不排队、不占带宽。上报是锦上添花，点单才是正事。
 * 2. **同一个错误只报一次**——React 一次渲染出错会连报几十条同样的，
 *    按「message + source + lineno」去重，这一轮页面生命周期内只发第一次。
 * 3. **不报无意义的噪音**——用户主动取消请求（AbortError）、脚本被扩展拦截、
 *    网络断了，这些不是 bug，报上来只会淹没有用信息。
 * 4. **不收集个人信息**——不带手机号、会员号，只有 UA 和页面路径。
 */

interface Report {
  app: 'customer' | 'admin';
  message: string;
  source?: string | null;
  lineno?: number | null;
  colno?: number | null;
  stack?: string | null;
  url?: string | null;
}

const seen = new Set<string>();

/** 这些错误不算 bug：网络断、被中止、扩展注入、跨域脚本没加载出来 */
function ignorable(message: string): boolean {
  if (!message) return true;
  return (
    /AbortError|The user aborted a request/i.test(message) ||
    /NetworkError|Failed to fetch|Load failed|网络连接/i.test(message) ||
    /ResizeObserver loop/i.test(message) ||
    /Script error\.?$/i.test(message) || // 跨域脚本：浏览器不给详情，报了也没用
    /chrome-extension|moz-extension|safari-extension/i.test(message) ||
    /vibrate/i.test(message)
  );
}

function send(r: Report): void {
  const key = `${r.message}|${r.source ?? ''}|${r.lineno ?? ''}`;
  if (ignorable(r.message) || seen.has(key)) return;
  seen.add(key);
  try {
    // keepalive：顾客点完单就关页面，普通请求会被掐掉
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(r),
      keepalive: true,
    }).catch(() => { /* 上报失败就算了，绝不能冒泡 */ });
  } catch {
    /* 同上 */
  }
}

/** 在应用入口调用一次 */
export function installErrorReporting(app: 'customer' | 'admin'): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('error', (e) => {
    // 资源加载失败（img/script 404）也会走到这里，但没有 error 对象，跳过
    const err = e.error as Error | undefined;
    send({
      app,
      message: err?.message ?? e.message ?? '未知错误',
      source: e.filename || null,
      lineno: e.lineno || null,
      colno: e.colno || null,
      stack: err?.stack ? err.stack.split('\n').slice(0, 6).join('\n') : null,
      url: location.pathname + location.hash,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { message?: string; stack?: string } | string | null;
    const message = typeof reason === 'string' ? reason : reason?.message ?? '未处理的 Promise 错误';
    send({
      app,
      message,
      stack: typeof reason === 'object' && reason?.stack ? reason.stack.split('\n').slice(0, 6).join('\n') : null,
      url: location.pathname + location.hash,
    });
  });
}
