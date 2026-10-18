-- 会员登录、储值支付、对账（P2 第二批）

-- 储值支付的订单记下是哪位会员付的，取消时原路退回
ALTER TABLE orders ADD COLUMN member_id TEXT REFERENCES members(id);

-- 顾客端会员登录：只存令牌的哈希
CREATE TABLE member_sessions (
  token_hash  TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL REFERENCES members(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- 每次对账的结果：流水合计 ≠ 当前余额 的会员会被列出来
CREATE TABLE reconcile_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  checked     INTEGER NOT NULL,
  mismatches  TEXT NOT NULL   -- JSON 数组
);
