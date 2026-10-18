-- P2 第四批：今日售罄、混合支付、按菜品行部分退款

-- ---------- 今日售罄（28号 #5）：只对某一个营业日有效，第二天自动恢复在售 ----------
ALTER TABLE dish_overrides ADD COLUMN sold_out_date TEXT;

-- 改动留痕表要能记「售罄」：SQLite 不能直接改 CHECK，按官方做法重建表（数据原样搬过去）
CREATE TABLE dish_changes_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dish_uid   TEXT NOT NULL,
  field      TEXT NOT NULL CHECK (field IN ('listed', 'price', 'image', 'state')),
  old_value  TEXT,
  new_value  TEXT,
  operator   TEXT NOT NULL,
  at         TEXT NOT NULL
);
INSERT INTO dish_changes_new (id, dish_uid, field, old_value, new_value, operator, at)
  SELECT id, dish_uid, field, old_value, new_value, operator, at FROM dish_changes;
DROP TABLE dish_changes;
ALTER TABLE dish_changes_new RENAME TO dish_changes;
CREATE TRIGGER dish_changes_append_only_u BEFORE UPDATE ON dish_changes
BEGIN SELECT RAISE(ABORT, 'dish_changes is append-only'); END;
CREATE TRIGGER dish_changes_append_only_d BEFORE DELETE ON dish_changes
BEGIN SELECT RAISE(ABORT, 'dish_changes is append-only'); END;

-- ---------- 混合支付（28号 §三-1）：储值付了多少；其余由 payment_method 那种方式付 ----------
ALTER TABLE orders ADD COLUMN stored_sen INTEGER NOT NULL DEFAULT 0 CHECK (stored_sen >= 0);
-- 已有的纯储值订单：储值金额 = 订单总额
UPDATE orders SET stored_sen = total_sen WHERE payment_method = 'stored-value';

-- ---------- 部分退款（28号 §三-2/3）：按菜品行退，每次退款一条记录，只增不删 ----------
CREATE TABLE order_refunds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  line         INTEGER NOT NULL,
  qty          INTEGER NOT NULL CHECK (qty > 0),
  amount_sen   INTEGER NOT NULL CHECK (amount_sen > 0),
  stored_sen   INTEGER NOT NULL CHECK (stored_sen >= 0),   -- 其中原路退回储值的部分
  counter_sen  INTEGER NOT NULL CHECK (counter_sen >= 0),  -- 其中要在柜台退还的部分（现金/电子）
  reason       TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  operator     TEXT NOT NULL,
  at           TEXT NOT NULL,
  request_key  TEXT NOT NULL UNIQUE,                        -- 防重码：老板手抖点两下只退一次
  CHECK (stored_sen + counter_sen = amount_sen),
  FOREIGN KEY (order_id, line) REFERENCES order_items(order_id, line)
);
CREATE INDEX refunds_by_order ON order_refunds(order_id);
CREATE TRIGGER order_refunds_no_update BEFORE UPDATE ON order_refunds
BEGIN SELECT RAISE(ABORT, 'order_refunds is append-only'); END;
CREATE TRIGGER order_refunds_no_delete BEFORE DELETE ON order_refunds
BEGIN SELECT RAISE(ABORT, 'order_refunds is append-only'); END;

-- 同一行累计退的份数不能超过下单份数（28号 §三-3：测试必须覆盖）——数据库也把关
CREATE TRIGGER order_refunds_qty_cap BEFORE INSERT ON order_refunds
WHEN NEW.qty + COALESCE((SELECT SUM(qty) FROM order_refunds WHERE order_id = NEW.order_id AND line = NEW.line), 0)
     > (SELECT qty FROM order_items WHERE order_id = NEW.order_id AND line = NEW.line)
BEGIN SELECT RAISE(ABORT, 'refund qty exceeds ordered qty'); END;

-- 「待柜台退还」：非储值部分的退款，老板在柜台办完后标记
-- resolution：refunded = 已退给顾客；not-collected = 当初没收到钱，无需退
CREATE TABLE counter_refunds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  refund_id    INTEGER REFERENCES order_refunds(id),  -- 来自部分退款；整单取消时为空
  method       TEXT NOT NULL,
  amount_sen   INTEGER NOT NULL CHECK (amount_sen > 0),
  created_at   TEXT NOT NULL,
  resolution   TEXT CHECK (resolution IS NULL OR resolution IN ('refunded', 'not-collected')),
  resolved_at  TEXT,
  resolved_by  TEXT
);
-- 只允许「从待处理 → 已处理」一次，处理后不能再改；记录不能删
CREATE TRIGGER counter_refunds_resolve_once BEFORE UPDATE ON counter_refunds
WHEN OLD.resolution IS NOT NULL
  OR NEW.order_id IS NOT OLD.order_id OR NEW.refund_id IS NOT OLD.refund_id
  OR NEW.method IS NOT OLD.method OR NEW.amount_sen IS NOT OLD.amount_sen OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'counter_refunds can only be resolved once'); END;
CREATE TRIGGER counter_refunds_no_delete BEFORE DELETE ON counter_refunds
BEGIN SELECT RAISE(ABORT, 'counter_refunds cannot be deleted'); END;
