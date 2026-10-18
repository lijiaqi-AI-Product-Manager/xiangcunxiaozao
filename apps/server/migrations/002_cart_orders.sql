-- 购物车（23号 §2：以服务器为准，前端只做展示）与订单（21号 §4 状态机）
-- 状态流转规则同样写进数据库：代码写错也走不出非法状态。

CREATE TABLE carts (
  id          TEXT PRIMARY KEY,   -- 同时作为「这台手机」的身份（一机一车，24号 #8）
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE cart_items (
  cart_id   TEXT NOT NULL REFERENCES carts(id),
  dish_uid  TEXT NOT NULL,
  qty       INTEGER NOT NULL CHECK (qty > 0 AND qty <= 99),
  added_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (cart_id, dish_uid)
);

CREATE TABLE orders (
  id              TEXT PRIMARY KEY,
  business_date   TEXT NOT NULL,                 -- 门店时区的营业日，取餐号每天从 1 开始
  pickup_no       INTEGER NOT NULL CHECK (pickup_no > 0),
  device_id       TEXT NOT NULL,
  table_no        TEXT NOT NULL CHECK (length(trim(table_no)) > 0),
  payment_method  TEXT NOT NULL CHECK (length(payment_method) > 0),
  note            TEXT,
  total_sen       INTEGER NOT NULL CHECK (total_sen >= 0),
  status          TEXT NOT NULL CHECK (status IN ('pending', 'cooking', 'done', 'cancelled')),
  cancel_reason   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (business_date, pickup_no)
);
CREATE INDEX orders_by_day ON orders(business_date, status);
CREATE INDEX orders_by_device ON orders(device_id, created_at);

-- 下单那一刻的菜名和价格存快照：以后改价、改名都不影响历史订单
CREATE TABLE order_items (
  order_id   TEXT NOT NULL REFERENCES orders(id),
  line       INTEGER NOT NULL,
  dish_uid   TEXT NOT NULL,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  price_sen  INTEGER NOT NULL CHECK (price_sen >= 0),
  qty        INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (order_id, line)
);

-- 每次状态变化留一条记录：谁、什么时候、从哪到哪、为什么
CREATE TABLE order_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  reason       TEXT,
  operator     TEXT NOT NULL,
  at           TEXT NOT NULL
);

CREATE TRIGGER orders_status_flow BEFORE UPDATE OF status ON orders
WHEN NOT (
  OLD.status = NEW.status
  OR (OLD.status = 'pending' AND NEW.status IN ('cooking', 'cancelled'))
  OR (OLD.status = 'cooking' AND NEW.status IN ('done', 'cancelled'))
)
BEGIN SELECT RAISE(ABORT, 'illegal order status transition'); END;

CREATE TRIGGER orders_cancel_needs_reason BEFORE UPDATE OF status ON orders
WHEN NEW.status = 'cancelled' AND (NEW.cancel_reason IS NULL OR length(trim(NEW.cancel_reason)) = 0)
BEGIN SELECT RAISE(ABORT, 'cancel requires a reason'); END;

CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders
BEGIN SELECT RAISE(ABORT, 'orders cannot be deleted'); END;

CREATE TRIGGER order_items_frozen_update BEFORE UPDATE ON order_items
BEGIN SELECT RAISE(ABORT, 'order_items are immutable'); END;

CREATE TRIGGER order_items_frozen_delete BEFORE DELETE ON order_items
BEGIN SELECT RAISE(ABORT, 'order_items are immutable'); END;

-- 小型键值设置（等待时长参数等）
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- 老板端登录：只存令牌的哈希
CREATE TABLE admin_sessions (
  token_hash  TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- 密码错误计数（老板登录 / 会员密码共用，24号 #4：连错 5 次锁 15 分钟）
CREATE TABLE login_attempts (
  scope         TEXT PRIMARY KEY,
  failed        INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT
);
