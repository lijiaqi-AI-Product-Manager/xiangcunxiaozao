#!/bin/bash
# 本地启动冒烟：合成老库 → 迁移 → SERVE_STATIC 启动 → 路由验证
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOOT=/tmp/xczboot
rm -rf "$BOOT" && mkdir -p "$BOOT/data/uploads" "$BOOT/backups"

python3 - << 'PYEOF'
import sqlite3, struct
db = sqlite3.connect('/tmp/xczboot/data/xcz.db')
c = db.cursor()
c.executescript('''
CREATE TABLE dishes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL, image_path TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, is_deleted INTEGER NOT NULL DEFAULT 0, animation_key TEXT NOT NULL DEFAULT '', avoid_options TEXT NOT NULL DEFAULT '[]', monthly_sold_override INTEGER, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, card_no TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', balance_cents INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '');
CREATE TABLE member_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, card_no TEXT NOT NULL, action TEXT NOT NULL, amount_cents INTEGER NOT NULL, balance_after INTEGER NOT NULL, order_no TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', at TEXT NOT NULL DEFAULT '');
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT NOT NULL UNIQUE, client_id TEXT UNIQUE, table_no TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', total_cents INTEGER NOT NULL, discount_cents INTEGER NOT NULL DEFAULT 0, payment_method TEXT NOT NULL DEFAULT '', paid_at TEXT, source TEXT NOT NULL DEFAULT 'customer', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', confirmed_at TEXT, served_at TEXT, rejected_at TEXT, cancelled_at TEXT, voided_at TEXT, cancel_reason TEXT NOT NULL DEFAULT '');
CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, dish_id INTEGER NOT NULL, dish_name TEXT NOT NULL, unit_price_cents INTEGER NOT NULL, qty INTEGER NOT NULL);
''')
c.execute("INSERT INTO dishes (name, price_cents, image_path, category, is_active) VALUES ('招牌手打柠檬茶', 1190, '/uploads/L01_zhaopai_v2.png', '手打柠檬茶', 1)")
c.execute("INSERT INTO members (card_no, balance_cents) VALUES ('100001', 7000)")
c.execute("INSERT INTO member_logs (card_no, action, amount_cents, balance_after, at) VALUES ('100001','topup',10000,10000,'2026-10-15T02:00:00.000Z')")
c.execute("INSERT INTO member_logs (card_no, action, amount_cents, balance_after, at) VALUES ('100001','consume',-3000,7000,'2026-10-16T03:00:00.000Z')")
c.execute("INSERT INTO orders (order_no, table_no, status, total_cents, payment_method, created_at, served_at) VALUES ('XCZ-BOOT-1','12','served',3000,'member','2026-10-18T05:00:00.000Z','2026-10-18T05:10:00.000Z')")
c.execute("INSERT INTO order_items (order_id, dish_id, dish_name, unit_price_cents, qty) VALUES (1,1,'招牌手打柠檬茶',1190,2)")
db.commit(); db.close()
png = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00'
open('/tmp/xczboot/data/uploads/L01_zhaopai_v2.png','wb').write(png)
print('合成老库+假图OK')
PYEOF

cd "$ROOT"
BRAND=xiangcun DB_PATH="$BOOT/data/app.db" UPLOAD_DIR="$BOOT/data/uploads" \
LEGACY_DB_PATH="$BOOT/data/xcz.db" BACKUP_DIR="$BOOT/backups" API_PORT=8899 \
SERVE_STATIC=1 ADMIN_TOKEN=boot-test-token-123 \
nohup node --import tsx/esm apps/server/src/main-zeabur.ts > "$BOOT/server.log" 2>&1 &
echo "$!" > "$BOOT/pid"
sleep 7
echo "=== 启动日志 ==="; cat "$BOOT/server.log"
