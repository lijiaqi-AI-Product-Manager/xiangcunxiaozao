-- 逐菜辣度 + 菜品级备注（P1-9）
--
-- 原来的痛点：一桌三个人，有人要不辣有人要特辣。结算页只能选一次辣度，
-- 写进整单备注「辣度：微辣；其中干锅花菜不要辣」，靠后厨看备注记。
-- 湖南菜馆这是每天都会发生的事，不是边角需求。
--
-- 做法：把「辣度」和「备注」挂到购物车**行**上，同一种菜不同辣度算两行。
-- 不改 menu.json 的 spice 字段（那里仍是 z.null()，v1 定的是备注制，不动它），
-- 辣度选项直接取 brand.spiceOptions 那五档。

-- 购物车行主键从「一辆车一道菜」放宽到「一辆车一行」：
-- 因为「剁椒鱼 一份微辣 + 一份特辣」必须是两行，价格、后厨、打印都按行走。
CREATE TABLE cart_items_new (
  id        TEXT NOT NULL,
  cart_id   TEXT NOT NULL REFERENCES carts(id),
  dish_uid  TEXT NOT NULL,
  qty       INTEGER NOT NULL CHECK (qty > 0 AND qty <= 99),
  -- 这一行的辣度（brand.spiceOptions 里的值），空串表示没选/这道菜不涉及辣度
  spice     TEXT NOT NULL DEFAULT '',
  -- 这一行的备注（「不要香菜」「打包」），空串表示没有
  note      TEXT NOT NULL DEFAULT '',
  added_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (id)
);

-- 老数据原样搬过去：每行生成一个新 id，辣度/备注留空，行为跟以前完全一样
INSERT INTO cart_items_new (id, cart_id, dish_uid, qty, added_at)
  SELECT lower(hex(randomblob(16))), cart_id, dish_uid, qty, added_at FROM cart_items;

DROP TABLE cart_items;
ALTER TABLE cart_items_new RENAME TO cart_items;

-- 同一辆车里「同一道菜 + 同一辣度 + 同一备注」只能有一行：顾客连点两下加号应该变成数量 2，
-- 而不是冒出两行「剁椒鱼 微辣」。这种「恰好重复」的重置交给这一条唯一索引管。
CREATE UNIQUE INDEX cart_items_same on cart_items (cart_id, dish_uid, spice, note);
CREATE INDEX cart_items_cart on cart_items (cart_id);

-- 订单明细也留一份辣度和备注，后厨小票和老板端都从这里读
ALTER TABLE order_items ADD COLUMN spice TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN note TEXT NOT NULL DEFAULT '';
