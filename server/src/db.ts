import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readConfig } from './config.js';

export type DB = Database.Database;

/**
 * 表设计原则（财务红线）：
 * 1. 金额一律整数“分”（马来西亚 sen，1 RM = 100 sen），杜绝浮点误差
 * 2. 时间一律 UTC ISO 字符串，报表按吉隆坡时区聚合
 * 3. order_items 冗余存 dish_name + unit_price_cents 快照——菜品改名/改价/下架
 *    不影响历史订单的账面数据
 * 4. orders.client_id 唯一约束——顾客端重复提交幂等去重，防止重复收单
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS dishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0 AND price_cents <= 10000000),
  image_path TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '招牌',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  animation_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  client_id TEXT UNIQUE,
  table_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'served', 'cancelled')),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  confirmed_at TEXT,
  served_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  dish_id INTEGER NOT NULL,
  dish_name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  qty INTEGER NOT NULL CHECK (qty > 0 AND qty <= 99),
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_dish_id ON order_items(dish_id);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** 打开（必要时创建）数据库并初始化表结构 */
export function openDb(dbPath?: string): DB {
  const file =
    dbPath ?? path.join(readConfig().dataDir, readConfig().dbFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL'); // 断电安全：写一半的事务不会损坏库
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}
