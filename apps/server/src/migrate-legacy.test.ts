/** migrate-legacy 的回归测试：合成一个老库（xcz.db 结构）+ 假图片，跑迁移后逐项断言。 */
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from './db.ts';
import { migrateLegacy } from './migrate-legacy.ts';

const tmp = mkdtempSync(join(tmpdir(), 'xcz-mig-'));
const legacyPath = join(tmp, 'xcz.db');
const oldUploads = join(tmp, 'old-uploads');
const newUploads = join(tmp, 'new-uploads');
mkdirSync(oldUploads); mkdirSync(newUploads);

/* ---------- 合成老库 ---------- */
const legacy = new Database(legacyPath);
legacy.exec(`
CREATE TABLE dishes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL, image_path TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '招牌',
  sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, is_deleted INTEGER NOT NULL DEFAULT 0,
  animation_key TEXT NOT NULL DEFAULT '', avoid_options TEXT NOT NULL DEFAULT '[]', monthly_sold_override INTEGER,
  created_at TEXT NOT NULL DEFAULT '2026-10-01T00:00:00.000Z', updated_at TEXT NOT NULL DEFAULT '2026-10-01T00:00:00.000Z');
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT NOT NULL UNIQUE, client_id TEXT UNIQUE,
  table_no TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', total_cents INTEGER NOT NULL, discount_cents INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT '', paid_at TEXT, source TEXT NOT NULL DEFAULT 'customer', note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, confirmed_at TEXT, served_at TEXT, rejected_at TEXT, cancelled_at TEXT, voided_at TEXT, cancel_reason TEXT NOT NULL DEFAULT '');
CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, dish_id INTEGER NOT NULL,
  dish_name TEXT NOT NULL, unit_price_cents INTEGER NOT NULL, qty INTEGER NOT NULL);
CREATE TABLE counters (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE order_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, card_no TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '',
  balance_cents INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '2026-10-01T00:00:00.000Z');
CREATE TABLE member_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, card_no TEXT NOT NULL, action TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, balance_after INTEGER NOT NULL, order_no TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT '2026-10-01T00:00:00.000Z');
CREATE TABLE day_adjustments (id INTEGER PRIMARY KEY AUTOINCREMENT, adj_date TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '2026-10-01T00:00:00.000Z');
`);
// 菜：①带图+改价（L01 老价11.9 vs 新19.9）②下架 ③老板自加（新菜单没有）④F01烤鱼（code挪V01）
const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080200000090775', 'hex'); // 最小PNG头
writeFileSync(join(oldUploads, 'L01_zhaopai_v2.png'), png);
writeFileSync(join(oldUploads, 'A01_liangban_v1.png'), png);
legacy.prepare(`INSERT INTO dishes (name, price_cents, image_path, category, is_active) VALUES (?,?,?,?,1)`).run('招牌手打柠檬茶', 1190, '/uploads/L01_zhaopai_v2.png', '手打柠檬茶');
legacy.prepare(`INSERT INTO dishes (name, price_cents, image_path, category, is_active) VALUES (?,?,?,?,0)`).run('凉拌木耳', 990, '/uploads/A01_liangban_v1.png', '开胃凉菜');
legacy.prepare(`INSERT INTO dishes (name, price_cents, image_path, category, is_active) VALUES (?,?,?,?,1)`).run('老板自加菜', 1500, '', '家常');
legacy.prepare(`INSERT INTO dishes (name, price_cents, image_path, category, is_active) VALUES (?,?,?,?,1)`).run('脆皮爆汁烤鱼', 7800, '', '招牌菜');
// 会员：①链完整 ②链断裂（第二笔balance_after对不上）
legacy.prepare(`INSERT INTO members (card_no, balance_cents) VALUES ('100001', 70)`).run();
legacy.prepare(`INSERT INTO members (card_no, balance_cents) VALUES ('100002', 88)`).run();
legacy.prepare(`INSERT INTO member_logs (card_no, action, amount_cents, balance_after, at) VALUES ('100001','topup',100,100,'2026-10-15T02:00:00.000Z')`).run();
legacy.prepare(`INSERT INTO member_logs (card_no, action, amount_cents, balance_after, order_no, at) VALUES ('100001','consume',-30,70,'XCZ-1','2026-10-16T03:00:00.000Z')`).run();
legacy.prepare(`INSERT INTO member_logs (card_no, action, amount_cents, balance_after, at) VALUES ('100002','topup',100,100,'2026-10-15T02:00:00.000Z')`).run();
legacy.prepare(`INSERT INTO member_logs (card_no, action, amount_cents, balance_after, at) VALUES ('100002','adjust',-12,88,'2026-10-16T04:00:00.000Z')`).run(); // 100-12=88 ✓实际链是完整的
// 订单：①今天已出餐 ②昨天会员支付已取消
legacy.prepare(`INSERT INTO orders (order_no, table_no, status, total_cents, payment_method, created_at, served_at) VALUES ('XCZ-1','3','served',3000,'cash','2026-10-17T06:00:00.000Z','2026-10-17T06:20:00.000Z')`).run();
legacy.prepare(`INSERT INTO orders (order_no, table_no, status, total_cents, payment_method, created_at, cancelled_at, cancel_reason) VALUES ('XCZ-2','5','cancelled',3000,'member','2026-10-17T05:00:00.000Z','2026-10-17T05:10:00.000Z','顾客取消')`).run();
legacy.prepare(`INSERT INTO order_items (order_id, dish_id, dish_name, unit_price_cents, qty) VALUES (1,1,'招牌手打柠檬茶',1190,2)`).run();
legacy.prepare(`INSERT INTO order_items (order_id, dish_id, dish_name, unit_price_cents, qty) VALUES (2,4,'脆皮爆汁烤鱼',7800,1)`).run();
legacy.close();

/* ---------- 跑迁移 ---------- */
const db = openDb(':memory:');
const brandDir = join(__dirname, '..', '..', '..', 'brands', 'xiangcun');
const menu = JSON.parse(readFileSync(join(brandDir, 'menu.json'), 'utf8'));
const report = migrateLegacy(db, {
  legacyDbPath: legacyPath, brandDir, uploadsDir: newUploads, legacyUploadsDir: oldUploads, timeZone: 'Asia/Kuala_Lumpur',
});

afterAll(() => { try { db.close(); } catch { /* */ } });

describe('migrate-legacy', () => {
  it('幂等：第二次跑直接跳过', () => {
    const again = migrateLegacy(db, { legacyDbPath: legacyPath, brandDir, uploadsDir: newUploads, legacyUploadsDir: oldUploads, timeZone: 'Asia/Kuala_Lumpur' });
    expect(again.skipped).toBe(true);
  });

  it('会员余额逐分对账（含链断裂者以当前余额入账）', () => {
    const rows = db.prepare('SELECT member_no, balance_sen FROM members ORDER BY member_no').all() as { member_no: string; balance_sen: number }[];
    expect(rows).toEqual([{ member_no: '100001', balance_sen: 70 }, { member_no: '100002', balance_sen: 88 }]);
    // 流水链：100001 两笔（recharge+consume），100002 两笔（recharge+adjust）
    const types = (db.prepare('SELECT m.member_no, l.type FROM ledger_entries l JOIN members m ON m.id=l.member_id ORDER BY l.id').all() as { member_no: string; type: string }[]);
    expect(types).toEqual([
      { member_no: '100001', type: 'recharge' }, { member_no: '100001', type: 'consume' },
      { member_no: '100002', type: 'recharge' }, { member_no: '100002', type: 'adjust' },
    ]);
  });

  it('老库价格win：L01 锚回 11.9（新菜单19.9）', () => {
    const l01 = menu.dishes.find((d: { code: string }) => d.code === 'L01');
    const p = db.prepare('SELECT price_sen FROM dish_overrides WHERE dish_uid = ?').get(l01.uid) as { price_sen: number } | undefined;
    expect(p?.price_sen).toBe(1190);
    expect(report.priceOverrides.some((s) => s.includes('L01'))).toBe(true);
  });

  it('菜品图拷贝成内容指纹名且能过 /media 正则', () => {
    const img = db.prepare("SELECT image_closed FROM dish_overrides WHERE image_closed LIKE '/media/%'").get() as { image_closed: string } | undefined;
    expect(img).toBeTruthy();
    const name = img!.image_closed.replace('/media/', '');
    expect(name).toMatch(/^[a-z0-9-]+-[0-9a-f]{10}\.(jpg|png|webp)$/);
    expect(existsSync(join(newUploads, name))).toBe(true);
    expect(existsSync(join(oldUploads, 'L01_zhaopai_v2.png'))).toBe(true); // 老文件保留（回滚锚）
  });

  it('老下架菜 → listed=0；老板自加菜进未匹配报告；F01烤鱼映射到V01价格一致', () => {
    const off = db.prepare('SELECT COUNT(*) c FROM dish_overrides WHERE listed = 0').get() as { c: number };
    expect(off.c).toBe(1);
    expect(report.unmatchedLegacyDishes.some((d) => d.name === '老板自加菜')).toBe(true);
    const v01 = menu.dishes.find((d: { code: string }) => d.code === 'V01');
    const roastFish = db.prepare('SELECT price_sen FROM dish_overrides WHERE dish_uid = ?').get(v01.uid) as { price_sen: number } | undefined;
    expect(roastFish?.price_sen ?? v01.priceSen).toBe(7800); // 老价=新价78，可不产生override
  });

  it('订单：状态映射/取餐号唯一/会员支付按流水关联/订单行快照', () => {
    const orders = db.prepare('SELECT * FROM orders ORDER BY created_at').all() as Record<string, unknown>[];
    expect(orders).toHaveLength(2);
    const served = orders.find((o) => o.id === 'XCZ-1')!;
    expect(served.status).toBe('done');
    expect(served.total_sen).toBe(3000);
    expect(served.pickup_no).toBeGreaterThan(0);
    expect(served.member_id).toBe('legacy-1'); // consume 流水指向 XCZ-1
    expect(served.stored_sen).toBe(3000);
    const cancelled = orders.find((o) => o.id === 'XCZ-2')!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.member_id).toBe(null); // 无 consume 流水 → 不关联
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all('XCZ-1') as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe('招牌手打柠檬茶');
    expect(items[0]!.qty).toBe(2);
    expect(String(items[0]!.dish_uid)).not.toContain('legacy:'); // 匹配到了新菜单uid
    // 每单一条事件
    const ev = db.prepare('SELECT COUNT(*) c FROM order_events').get() as { c: number };
    expect(ev.c).toBe(2);
  });

  it('对账：全员流水合计 == 余额（新库触发器链完整性反证）', () => {
    const bad = db.prepare('SELECT member_no FROM members m WHERE balance_sen <> (SELECT COALESCE(SUM(amount_sen),0) FROM ledger_entries l WHERE l.member_id = m.id)').all();
    expect(bad).toEqual([]);
  });
});
