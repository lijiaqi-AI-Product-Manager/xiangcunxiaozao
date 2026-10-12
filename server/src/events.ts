import { EventEmitter } from 'node:events';

/** 订单事件载荷：后厨页/老板后台实时刷新的唯一下游 */
export interface OrderEvent {
  type: 'order:new' | 'order:status';
  order_no: string;
  table_no: string;
  status: string;
  total_rm: string;
  note: string;
  created_at: string;
  items: { dish_name: string; qty: number }[];
}

/** 每个应用实例一个独立总线（避免测试间监听器残留） */
export function makeBus(): EventEmitter {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  return bus;
}
