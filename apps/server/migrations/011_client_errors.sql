-- 前端错误上报（P3-8）
--
-- 线上出问题时老板只会说「打不开」，没有任何技术线索。
-- 接 Sentry 这种服务对这个规模是过度的（要账号、要联网、要看英文后台），
-- 一张表 + 老板端一页就够：真出事时能看到「哪个页面、哪行代码、哪台手机、什么时候」。
CREATE TABLE IF NOT EXISTS client_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 哪个端：customer 顾客扫码页 / admin 老板端
  app         TEXT NOT NULL,
  message     TEXT NOT NULL,
  -- 出错的文件和行号（浏览器给的，可能为空）
  source      TEXT,
  lineno      INTEGER,
  colno       INTEGER,
  -- 堆栈前几行，够定位就行，不存全文（体积不可控）
  stack       TEXT,
  -- 浏览器 UA：至少能区分「安卓微信」和「iPad Safari」
  ua          TEXT,
  url         TEXT,
  -- 同一个错误反复发生时只更新这一列，不刷屏
  hits        INTEGER NOT NULL DEFAULT 1,
  first_at    TEXT NOT NULL,
  last_at     TEXT NOT NULL
);

-- 查「最近最烦人的错误」用
CREATE INDEX IF NOT EXISTS client_errors_last ON client_errors (last_at);
