-- 打印留痕：每一张纸（成功或失败）都记一笔
--
-- 为什么必须落库：打印机没开、纸卡了、断网——这些都会让"单下了、纸没出"。
-- 只写日志文件，老板根本看不到；落库之后「打印设置」页能直接列出
-- 「哪一单、哪台机器、什么时候、失败原因」，缺纸补打才有依据。

CREATE TABLE IF NOT EXISTS print_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,              -- receipt / label
  order_no TEXT NOT NULL,            -- 单号（月日-取餐号）
  ok INTEGER NOT NULL,               -- 1 成功 / 0 失败
  attempts INTEGER NOT NULL,
  pages INTEGER NOT NULL,
  error TEXT,
  at TEXT NOT NULL,
  -- 同一单同一目标的重打次数，用于老板端显示"已重打 2 次"
  reprint INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_at ON print_jobs (at DESC);
CREATE INDEX IF NOT EXISTS idx_print_jobs_order ON print_jobs (order_no, target);
