-- 会员与储值账本（21号 §4：余额只减不删，每笔变动必有流水）
-- 账本规则写在数据库里，而不是只写在代码里：就算代码出错，数据库也会拒绝。

CREATE TABLE members (
  id              TEXT PRIMARY KEY,
  member_no       TEXT NOT NULL UNIQUE,
  phone           TEXT,
  pin_hash        TEXT,                      -- P2 实现：4 位密码只存哈希
  pin_failed      INTEGER NOT NULL DEFAULT 0, -- 24号 #4：连错 5 次锁 15 分钟
  pin_locked_until TEXT,
  balance_sen     INTEGER NOT NULL DEFAULT 0 CHECK (balance_sen >= 0),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE ledger_entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id         TEXT NOT NULL REFERENCES members(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  type              TEXT NOT NULL CHECK (type IN ('recharge', 'consume', 'adjust', 'refund', 'import')),
  amount_sen        INTEGER NOT NULL CHECK (amount_sen <> 0),  -- 正数入账，负数扣款
  balance_after_sen INTEGER NOT NULL,
  operator          TEXT NOT NULL,                              -- 谁做的：老板账号 / system / import:<批次>
  note              TEXT,
  order_id          TEXT,
  idempotency_key   TEXT NOT NULL UNIQUE                        -- 防重码：同一操作重复提交只入账一次
);
CREATE INDEX ledger_by_member ON ledger_entries(member_id, id);

-- 流水只追加：禁止修改、禁止删除。记错了就再记一笔反向流水（红字冲销）。
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only: UPDATE forbidden'); END;

CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only: DELETE forbidden'); END;

-- 每笔流水写入时，「变动后余额」必须等于「原余额 + 本笔金额」，否则拒绝
CREATE TRIGGER ledger_check_balance BEFORE INSERT ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger balance_after mismatch')
  WHERE NEW.balance_after_sen <> (SELECT balance_sen FROM members WHERE id = NEW.member_id) + NEW.amount_sen;
END;

-- 流水落地后同步余额（与流水在同一事务里；余额变负会被 CHECK 拒绝，整笔回滚）
CREATE TRIGGER ledger_apply_balance AFTER INSERT ON ledger_entries
BEGIN
  UPDATE members SET balance_sen = NEW.balance_after_sen WHERE id = NEW.member_id;
END;

-- 会员不允许删除（删了流水就成孤儿）
CREATE TRIGGER members_no_delete BEFORE DELETE ON members
BEGIN SELECT RAISE(ABORT, 'members cannot be deleted'); END;
