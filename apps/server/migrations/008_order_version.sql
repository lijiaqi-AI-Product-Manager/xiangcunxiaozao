-- 并发保护：两台设备（前台 iPad + 老板手机）同时改一张单时，后到的不能把先到的悄悄覆盖
--
-- 原来的问题：UPDATE orders SET status = ? WHERE id = ?，谁后到谁赢，而且没有任何提示。
--   · 前台刚把单拖进「制作中」，老板同时在手机点了「取消」——两个操作都合法，最终状态取决于时序，
--     而两台设备的界面各自显示不同的结果，谁也不知道哪个是真的。
--
-- 修法：订单带一个自增的 version。改状态时要求「版本还是我看到的那一版」，
-- 对不上就返回 409「这单刚被别的设备改过」，前端提示并刷新。
-- 这是乐观锁，不加锁、不占数据库连接，单店场景完全够用。

ALTER TABLE orders ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- 已有的订单从 0 开始，不需要回填
CREATE INDEX IF NOT EXISTS orders_version ON orders (id, version);
