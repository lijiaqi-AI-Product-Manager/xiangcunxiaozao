/** 业务错误：带 HTTP 状态码和一句给人看的中文 */
export class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 423 | 500, message: string) {
    super(message);
  }
}

export type Clock = () => Date;

/** 门店时区的营业日（YYYY-MM-DD），取餐号按它每天归零 */
export function businessDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 极简事件广播：新订单 / 订单状态变化 → 老板端实时推送 */
export class EventBus<T> {
  private listeners = new Set<(e: T) => void>();
  on(fn: (e: T) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(e: T) {
    for (const fn of this.listeners) fn(e);
  }
}
