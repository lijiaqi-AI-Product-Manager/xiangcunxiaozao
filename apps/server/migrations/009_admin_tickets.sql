-- 一次性推送票据（P3-4）
-- EventSource 带不了请求头，令牌只能塞进 URL，会留在日志/历史里。
-- 改成：令牌换一张 30 秒、用一次就失效的票，日志里留下的是废票。
CREATE TABLE IF NOT EXISTS admin_tickets (
  ticket_hash TEXT PRIMARY KEY,
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_tickets_exp ON admin_tickets (expires_at);
