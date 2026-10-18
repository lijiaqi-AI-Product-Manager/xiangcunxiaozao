/**
 * 老系统（xcz.db）→ 新系统（app.db）一次性数据迁移。
 *
 * 设计约束（对应新库数据库防线，全部已演算）：
 * - ledger_entries 有 append-only 触发器：只 INSERT，禁 UPDATE/DELETE
 * - ledger_check_balance 触发器：balance_after_sen 必须 == 当前余额 + amount_sen
 *   → 先在纯 JS 校验老流水链，链完整则按序插入保历史；链断裂则退化为单条 import 入账
 * - members.id 是 TEXT：用 'legacy-<老id>'
 * - 幂等：settings 表写 legacy_migrated_at 标记，重复启动直接跳过
 * - 全量单事务：任何一步失败全部回滚并抛错（部署宁可起不来，不能错账）
 *
 * 迁移范围：
 *   1. 会员 + 流水（储值余额是真实的钱，零容错）
 *   2. 菜品管理层：老库在售价 win（试营业价格连续性）、老板传的菜品图（拷贝成内容指纹名）、下架状态
 *   3. 订单历史 + 订单行（取餐号按营业日重排合成；会员支付按流水反查关联）
 * 不迁移（记录在报告）：老 settings、day_adjustments（新系统无对应表，数据仍在老库文件可查）
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { businessDate } from './support.ts';

type DB = Database.Database;

export interface MigrationReport {
  members: number;
  ledgerEntries: number;
  chainBrokenMembers: number;
  orders: number;
  orderItems: number;
  photosCopied: number;
  priceOverrides: string[];
  unlisted: string[];
  unmatchedLegacyDishes: { name: string; priceSen: number }[];
  notes: string[];
  skipped?: boolean;
}

interface MenuDish { uid: string; code: string; name: string; priceSen: number }
interface LegacyDish { id: number; name: string; price_cents: number; image_path: string; is_active: number }

export function migrateLegacy(
  db: DB,
  opts: { legacyDbPath: string; uploadsDir: string; brandDir: string; timeZone: string; legacyUploadsDir?: string },
): MigrationReport {
  const report: MigrationReport = {
    members: 0, ledgerEntries: 0, chainBrokenMembers: 0, orders: 0, orderItems: 0,
    photosCopied: 0, priceOverrides: [], unlisted: [], unmatchedLegacyDishes: [], notes: [],
  };
  if (!existsSync(opts.legacyDbPath)) { report.skipped = true; report.notes.push('老库不存在，跳过迁移'); return report; }

  const done = db.prepare("SELECT value FROM settings WHERE key = 'legacy_migrated_at'").pluck().get() as string | undefined;
  if (done) { report.skipped = true; report.notes.push(`已于 ${done} 迁移过，跳过`); return report; }

  const legacy = new Database(opts.legacyDbPath, { readonly: true });
  const menu = JSON.parse(readFileSync(join(opts.brandDir, 'menu.json'), 'utf8')) as { dishes: MenuDish[] };
  const codeMap = JSON.parse(readFileSync(join(opts.brandDir, 'legacy', 'menu-codes.json'), 'utf8')) as {
    alias: Record<string, string>;
    nameToCode: Record<string, string>;
  };
  const byCode = new Map(menu.dishes.map((d) => [d.code, d]));
  const byName = new Map(menu.dishes.map((d) => [d.name, d]));
  const resolveCode = (name: string): MenuDish | undefined => {
    let code = codeMap.nameToCode[name] ?? (byName.get(name)?.code);
    if (!code) return undefined;
    code = codeMap.alias[code] ?? code; // F01 → V01（烤鱼挪进招牌专区）
    return byCode.get(code);
  };

  const tx = db.transaction(() => {
    /* ---------- 1. 会员 + 流水（储值余额，零容错） ---------- */
    interface OldMember { id: number; card_no: string; balance_cents: number; created_at: string }
    interface OldLog { id: number; card_no: string; action: string; amount_cents: number; balance_after: number; order_no: string; detail: string; at: string }
    const oldMembers = legacy.prepare('SELECT * FROM members ORDER BY id').all() as OldMember[];
    const logsByCard = new Map<string, OldLog[]>();
    for (const l of legacy.prepare('SELECT * FROM member_logs ORDER BY id').all() as OldLog[]) {
      const arr = logsByCard.get(l.card_no) ?? [];
      arr.push(l);
      logsByCard.set(l.card_no, arr);
    }
    const TYPE: Record<string, string> = { topup: 'recharge', 充值: 'recharge', consume: 'consume', 消费: 'consume', refund: 'refund', 退款: 'refund', adjust: 'adjust', 调整: 'adjust' };
    const insLedger = db.prepare(
      'INSERT INTO ledger_entries (member_id, created_at, type, amount_sen, balance_after_sen, operator, note, order_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

    for (const m of oldMembers) {
      const memberId = `legacy-${m.id}`;
      db.prepare('INSERT INTO members (id, member_no, phone, pin_hash, balance_sen, created_at) VALUES (?, ?, NULL, NULL, 0, ?)')
        .run(memberId, m.card_no, m.created_at);
      report.members++;

      const logs = logsByCard.get(m.card_no) ?? [];
      let running = 0;
      const chainOk = logs.length > 0 && logs.every((l) => { running += l.amount_cents; return running === l.balance_after; });
      if (chainOk) {
        for (const l of logs) {
          insLedger.run(memberId, l.at, TYPE[l.action] ?? 'import', l.amount_cents, l.balance_after, 'legacy-import',
            (l.detail || l.action).slice(0, 200), l.order_no || null, `legacy-log-${l.id}`);
          report.ledgerEntries++;
        }
      } else {
        if (m.balance_cents !== 0) {
          insLedger.run(memberId, new Date().toISOString(), 'import', m.balance_cents, m.balance_cents, 'legacy-import',
            '老系统迁移：按余额一次性入账', null, `legacy-balance-${m.id}`);
          report.ledgerEntries++;
        }
        if (logs.length > 0) report.chainBrokenMembers++;
      }
    }

    /* ---------- 2. 菜品管理层（价格连续性 / 老板图 / 下架） ---------- */
    const insOverride = db.prepare(
      'INSERT INTO dish_overrides (dish_uid, listed, price_sen, image_closed, sold_out_date, updated_at) VALUES (?, ?, ?, ?, NULL, ?) ' +
      'ON CONFLICT(dish_uid) DO UPDATE SET listed = excluded.listed, price_sen = excluded.price_sen, image_closed = excluded.image_closed, updated_at = excluded.updated_at');
    const legacyDishes = legacy.prepare('SELECT id, name, price_cents, image_path, is_active FROM dishes WHERE is_deleted = 0').all() as LegacyDish[];

    for (const d of legacyDishes) {
      const dish = resolveCode(d.name);
      if (!dish) { report.unmatchedLegacyDishes.push({ name: d.name, priceSen: d.price_cents }); continue; }
      const price = d.price_cents !== dish.priceSen ? d.price_cents : null;
      if (price !== null) report.priceOverrides.push(`${dish.code} ${d.name}: 菜单 ${dish.priceSen / 100} → 沿用老库 ${d.price_cents / 100}`);
      let image: string | null = null;
      if (d.image_path) {
        const src = join(opts.legacyUploadsDir ?? opts.uploadsDir, basename(d.image_path));
        if (existsSync(src)) {
          const buf = readFileSync(src);
          const ext = (src.toLowerCase().match(/\.(jpe?g|png|webp)$/)?.[1] ?? 'png').replace('jpeg', 'jpg');
          const slug = dish.code.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'dish';
          const newName = `${slug}-${createHash('sha256').update(buf).digest('hex').slice(0, 10)}.${ext}`;
          const dst = join(opts.uploadsDir, newName);
          if (!existsSync(dst)) copyFileSync(src, dst);
          image = `/media/${newName}`;
          report.photosCopied++;
        }
      }
      const listed = d.is_active === 1 ? 1 : 0;
      if (listed === 0) report.unlisted.push(`${dish.code} ${d.name}`);
      if (price !== null || image !== null || listed === 0) {
        insOverride.run(dish.uid, listed, price, image, new Date().toISOString());
      }
    }

    /* ---------- 3. 订单历史 ---------- */
    interface OldOrder { id: number; order_no: string; client_id: string | null; table_no: string; status: string; total_cents: number; discount_cents: number; payment_method: string; note: string; created_at: string; confirmed_at: string | null; served_at: string | null; cancelled_at: string | null; rejected_at: string | null; voided_at: string | null; cancel_reason: string }
    interface OldItem { order_id: number; dish_name: string; unit_price_cents: number; qty: number }
    const STATUS: Record<string, string> = { pending: 'pending', confirmed: 'cooking', served: 'done', cancelled: 'cancelled', rejected: 'cancelled', voided: 'cancelled' };
    const oldOrders = legacy.prepare('SELECT * FROM orders ORDER BY id').all() as OldOrder[];
    const itemsByOrder = new Map<number, OldItem[]>();
    for (const it of legacy.prepare('SELECT * FROM order_items').all() as OldItem[]) {
      const arr = itemsByOrder.get(it.order_id) ?? [];
      arr.push(it);
      itemsByOrder.set(it.order_id, arr);
    }
    const memberPay = new Map<string, string>();
    for (const l of legacy.prepare("SELECT card_no, order_no FROM member_logs WHERE action IN ('consume','消费') AND order_no != ''").all() as { card_no: string; order_no: string }[]) {
      memberPay.set(l.order_no, l.card_no);
    }
    const memberIdByNo = new Map(oldMembers.map((m) => [m.card_no, `legacy-${m.id}`]));
    const pickupSeen = new Map<string, number>();
    const insOrder = db.prepare(
      'INSERT INTO orders (id, business_date, pickup_no, device_id, table_no, payment_method, note, total_sen, status, cancel_reason, created_at, updated_at, member_id, stored_sen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insItem = db.prepare('INSERT INTO order_items (order_id, line, dish_uid, code, name, price_sen, qty) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insEvent = db.prepare('INSERT INTO order_events (order_id, from_status, to_status, reason, operator, at) VALUES (?, NULL, ?, ?, ?, ?)');

    for (const o of oldOrders) {
      const day = businessDate(new Date(o.created_at), opts.timeZone);
      const pickup = (pickupSeen.get(day) ?? 0) + 1;
      pickupSeen.set(day, pickup);
      const status = STATUS[o.status] ?? 'done';
      const payCard = memberPay.get(o.order_no);
      const memberId = payCard ? memberIdByNo.get(payCard) ?? null : null;
      const stored = memberId ? Math.max(0, o.total_cents - o.discount_cents) : 0;
      insOrder.run(o.order_no, day, pickup, o.client_id ?? `legacy-${o.id}`, o.table_no || '-',
        o.payment_method || 'cash', o.note || null, o.total_cents - o.discount_cents, status,
        o.cancel_reason || null, o.created_at, o.served_at ?? o.cancelled_at ?? o.rejected_at ?? o.confirmed_at ?? o.created_at, memberId, stored);
      report.orders++;
      let line = 0;
      for (const it of itemsByOrder.get(o.id) ?? []) {
        line++;
        const dish = resolveCode(it.dish_name) ?? byName.get(it.dish_name);
        insItem.run(o.order_no, line, dish?.uid ?? `legacy:${it.dish_name}`, dish?.code ?? 'LEGACY', it.dish_name, it.unit_price_cents, it.qty);
        report.orderItems++;
      }
      insEvent.run(o.order_no, o.status, '老系统迁移', 'legacy-import', o.created_at);
    }

    /* ---------- 4. 收尾标记 ---------- */
    db.prepare("INSERT INTO settings (key, value) VALUES ('legacy_migrated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(new Date().toISOString());
    report.notes.push('老 settings / day_adjustments 未迁移（新系统无对应表，数据仍在老库文件中，回滚或审计时可查）');
  });
  tx();
  legacy.close();
  return report;
}
