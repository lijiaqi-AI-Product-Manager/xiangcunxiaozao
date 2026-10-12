import type { DB } from './db.js';

/** 应用依赖：业务代码全部从这里拿 db 和令牌，不直接读环境变量（便于测试注入） */
export interface AppDeps {
  db: DB;
  adminToken: string;
  kitchenToken: string;
  limits?: { orderPerMin?: number; globalPerMin?: number };
}
