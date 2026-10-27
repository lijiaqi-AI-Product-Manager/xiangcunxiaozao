-- 加菜 / 并单（P2-6）
--
-- 场景：一桌人吃到一半，想再加两瓶柠檬茶。
-- 改之前只能重新下一单 —— 桌上多出一个取餐号，结账要合并两张单，后厨也得多看一张票。
--
-- 设计上先想清楚一件事：**钱怎么算**。
-- 一张单的钱（total_sen）在系统里是「下单那一刻的价」；退款按行退、账本只增不删；
-- order_items 还有触发器禁止 UPDATE/DELETE（迁移 002，有意为之：已经下给后厨的菜不能被悄悄改掉）。
-- 如果让加菜往同一张单里追加行、改 total_sen，那日结单、看板、退款分摊比例全都要重新定义
-- 「这张单当时是多少钱」，等于把已经稳定的账务推倒重来。
--
-- 所以加菜的做法是：**另开一张子单，钱各记各的，对外看起来是一张**。
--   • 子单自己是一张完整订单：自己的明细、自己的付款与退款（每一笔钱都算得清、退得掉）
--   • 子单不占取餐号，客人手上始终只有一个号；显示成「018+1」（018 号单第 1 次加菜）
--   • 老板端和顾客端按 parent_order_id 把父子单收成一组，合计就是「这一桌一共多少」
--
-- 数据库层面为什么这么写：
--   orders.pickup_no 有 CHECK (pickup_no > 0) 和表级 UNIQUE(business_date, pickup_no)，
--   两者都不能改（表级约束在 SQLite 里无法 DROP，改就得重建表；而 orders 是 append-only，
--   重建要先删数据，触发器会拦；何况还有三个表挂着外键）。
--   所以取餐号这一列**原样不动**：子单照样写一个号，但那个号不会被任何人看到——
--   显示用的是 parent_order_id 指向的父单号（`pickupNoOf` 见 orders.ts）。
--   子单写入时取当天最大号 + 1，只为满足约束，接口层一律返回父单的号。

ALTER TABLE orders ADD COLUMN parent_order_id TEXT REFERENCES orders(id);

-- 加菜的时间点：老板端要能说「这桌 19:20 又加了两个菜」
ALTER TABLE orders ADD COLUMN added_at TEXT;

-- 第几次加菜（1、2、3…）。主单为 NULL
ALTER TABLE orders ADD COLUMN add_seq INTEGER;

CREATE INDEX IF NOT EXISTS orders_by_parent ON orders(parent_order_id) WHERE parent_order_id IS NOT NULL;

-- 一笔加菜只能加一次：同一张父单的第 N 次加菜只能有一行。
-- 顾客手抖点两下、或者网络重试，都靠这条索引兜住（和 007 的幂等键是同一个思路）。
CREATE UNIQUE INDEX IF NOT EXISTS orders_add_seq ON orders (parent_order_id, add_seq) WHERE parent_order_id IS NOT NULL;

-- 父子关系不能自指：自己当自己的父单会让「收成一组」无限递归
CREATE TRIGGER orders_sub_not_self BEFORE INSERT ON orders
WHEN NEW.parent_order_id = NEW.id
BEGIN SELECT RAISE(ABORT, 'order cannot be its own parent'); END;

-- 子单必须带 add_seq（上面那个唯一索引靠它区分「第几次」）
CREATE TRIGGER orders_sub_needs_seq BEFORE INSERT ON orders
WHEN NEW.parent_order_id IS NOT NULL AND NEW.add_seq IS NULL
BEGIN SELECT RAISE(ABORT, 'add-dish order needs add_seq'); END;
