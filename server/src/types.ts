import type { DB } from './db.js';
import type { EventEmitter } from 'node:events';

/** 应用依赖：业务代码全部从这里拿 db/令牌/事件总线，不直接读环境变量（便于测试注入） */
export interface AppDeps {
  db: DB;
  adminToken: string;
  kitchenToken: string;
  bus: EventEmitter;
  limits?: { orderPerMin?: number; globalPerMin?: number };
}
