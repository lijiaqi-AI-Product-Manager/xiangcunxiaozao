-- 下单幂等键：顾客网络一抖就重试，不能变成两张单
--
-- 原来的问题：orders 表只有 UNIQUE(business_date, pickup_no)，没有请求幂等键。
-- 顾客点「提交订单」→ 服务端建单成功、取餐号已分配、厨房已打印 → 响应在路上丢了 →
-- 顾客看到「网络连接失败」→ 再点一次 → 因为购物车已被清空，得到「购物车是空的」，
-- 以为没下单成功，跑到柜台投诉。而单其实已经在后厨了。
--
-- 修法：前端每次提交带一个 requestId（失败重试时复用同一个），
-- 服务端见到重复的 requestId 就直接返回第一次那张单，不再建第二张。
-- 存的是「设备号:请求编号」，同一台设备重复提交才算重复；
-- 不加设备号的话，两台设备恰好撞了同一个 id 会被误判成重复（虽然概率极低）。

ALTER TABLE orders ADD COLUMN request_key TEXT;

-- 局部唯一索引：老的订单 request_key 为 NULL，不参与唯一约束，历史数据不受影响
CREATE UNIQUE INDEX IF NOT EXISTS orders_request_key ON orders (request_key) WHERE request_key IS NOT NULL;
