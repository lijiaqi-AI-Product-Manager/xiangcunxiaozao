import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { AppDeps } from '../types.js';
import { makeAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/errors.js';
import { MENU_SEED } from '../data/menu-seed.js';
import { parsePriceToCents } from '../utils/money.js';
import { monthlySold } from '../services/orders.js';

interface DishRow {
  id: number;
  name: string;
  description: string;
  price_cents: number;
  image_path: string;
  category: string;
  sort_order: number;
  is_active: number;
  is_deleted: number;
  animation_key: string;
  avoid_options: string;
  monthly_sold_override: number | null;
  created_at: string;
  updated_at: string;
}

const clean = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);

export default function dishesRoutes(deps: AppDeps): Router {
  const r = Router();
  const { db } = deps;
  const auth = makeAuth(deps.adminToken, deps.kitchenToken);

  const publicView = (d: DishRow) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    price_cents: d.price_cents,
    image_path: d.image_path,
    category: d.category,
    animation_key: d.animation_key,
    avoid_options: safeParseAvoid(d.avoid_options),
    monthly_sold: monthlySold(db, d.id, d.monthly_sold_override),
  });
  function safeParseAvoid(v: string): string[] {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a.map(String).slice(0, 12) : [];
    } catch {
      return [];
    }
  }
  const adminView = (d: DishRow) => ({
    ...publicView(d),
    sort_order: d.sort_order,
    is_active: d.is_active,
    is_deleted: d.is_deleted === 1,
    monthly_sold_override: d.monthly_sold_override,
  });

  // 顾客菜单（只要在售的）
  r.get('/', (_req, res) => {
    const rows = db
      .prepare(`SELECT * FROM dishes WHERE is_active = 1 AND is_deleted = 0 ORDER BY sort_order, id`)
      .all() as DishRow[];
    res.json(rows.map(publicView));
  });

  // 老板：全量菜品（含下架的）
  r.get('/all', auth.admin, (_req, res) => {
    const rows = db.prepare(`SELECT * FROM dishes ORDER BY sort_order, id`).all() as DishRow[];
    res.json(rows.map(adminView));
  });

  // 老板：新增菜品
  // 全菜单种子（04文案库v1.0唯一权威源）：按菜名精确upsert + 清理名单外菜品（软删保账）
  r.post('/seed', auth.admin, (req, res) => {
    if (req.body?.confirm !== 'SEED_V1') throw new HttpError(400, '请传 confirm=SEED_V1 防误触');
    let inserted = 0, updated = 0;
    for (const d of MENU_SEED) {
      const exist = (
        db.prepare('SELECT id FROM dishes WHERE name = ? AND is_deleted = 0').get(d.name) as { id: number } | undefined
      );
      if (exist) {
        db.prepare(
          `UPDATE dishes SET description=?, price_cents=?, category=?, animation_key=?,
           avoid_options=?, is_active=1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`
        ).run(d.desc, d.price_cents, d.category, d.code, JSON.stringify(d.avoid), exist.id);
        updated++;
      } else {
        db.prepare(
          `INSERT INTO dishes(name, description, price_cents, category, animation_key, avoid_options, sort_order)
           VALUES(?,?,?,?,?,?,?)`
        ).run(d.name, d.desc, d.price_cents, d.category, d.code, JSON.stringify(d.avoid), MENU_SEED.indexOf(d));
        inserted++;
      }
    }
    // 名单外的在售菜品全部软删（测试菜清场，账目不动）
    const names = MENU_SEED.map((d) => d.name);
    const placeholders = names.map(() => '?').join(',');
    const hid = db
      .prepare(`UPDATE dishes SET is_deleted=1, is_active=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE is_deleted=0 AND name NOT IN (${placeholders})`)
      .run(...names).changes;
    res.json({ ok: true, total: MENU_SEED.length, inserted, updated, hidden: hid });
  });

  r.post('/', auth.admin, (req, res) => {
    const name = clean(req.body?.name, 50);
    if (!name) throw new HttpError(400, '菜名不能为空');
    const price = parsePriceToCents(req.body?.price);
    const description = clean(req.body?.description, 300);
    const category = clean(req.body?.category, 20) || '招牌';
    const animationKey = clean(req.body?.animation_key, 40);
    const sortOrder = Number.isInteger(req.body?.sort_order) ? Number(req.body.sort_order) : 0;

    const info = db
      .prepare(
        `INSERT INTO dishes(name, description, price_cents, category, animation_key, sort_order)
         VALUES(?, ?, ?, ?, ?, ?)`
      )
      .run(name, description, price, category, animationKey, sortOrder);
    const row = db.prepare('SELECT * FROM dishes WHERE id = ?').get(info.lastInsertRowid) as DishRow;
    res.status(201).json(adminView(row));
  });

  // 老板：改价/改名/改描述/排序（历史订单金额不受影响——下单时已快照）
  r.put('/:id', auth.admin, (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM dishes WHERE id = ?').get(id) as DishRow | undefined;
    if (!row) throw new HttpError(404, '菜品不存在');

    const name = req.body?.name !== undefined ? clean(req.body.name, 50) : row.name;
    if (!name) throw new HttpError(400, '菜名不能为空');
    const price = req.body?.price !== undefined ? parsePriceToCents(req.body.price) : row.price_cents;
    const description =
      req.body?.description !== undefined ? clean(req.body.description, 300) : row.description;
    const category = req.body?.category !== undefined ? clean(req.body.category, 20) : row.category;
    const animationKey =
      req.body?.animation_key !== undefined ? clean(req.body.animation_key, 40) : row.animation_key;
    const sortOrder =
      req.body?.sort_order !== undefined && Number.isInteger(req.body.sort_order)
        ? Number(req.body.sort_order)
        : row.sort_order;
    const isActive =
      req.body?.is_active !== undefined ? (req.body.is_active ? 1 : 0) : row.is_active;
    let avoid = safeParseAvoid(row.avoid_options);
    if (req.body && req.body.avoid_options !== undefined) {
      const raw = Array.isArray(req.body.avoid_options) ? req.body.avoid_options : [];
      avoid = raw.map((x: unknown) => String(x).trim().slice(0, 12)).filter(Boolean).slice(0, 12);
    }
    const imagePath = req.body?.image_path !== undefined ? clean(req.body.image_path, 200) : row.image_path;
    let override: number | null = row.monthly_sold_override;
    if (req.body && req.body.monthly_sold_override !== undefined) {
      const v = req.body.monthly_sold_override;
      if (v === null || v === '') {
        override = null;
      } else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 9_999_999) throw new HttpError(400, '月售覆盖值非法');
        override = Math.round(n);
      }
    }

    db.prepare(
      `UPDATE dishes SET name=?, description=?, price_cents=?, category=?, animation_key=?,
       sort_order=?, is_active=?, avoid_options=?, monthly_sold_override=?, image_path=?,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`
    ).run(name, description, price, category, animationKey, sortOrder, isActive, JSON.stringify(avoid), override, imagePath, id);
    res.json(adminView(db.prepare('SELECT * FROM dishes WHERE id = ?').get(id) as DishRow));
  });

  // 老板：删除菜品（有历史订单→软删保账，无订单→物理删除）
  r.delete('/:id', auth.admin, (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM dishes WHERE id = ?').get(id) as DishRow | undefined;
    if (!row) throw new HttpError(404, '菜品不存在');
    const used = (
      db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE dish_id = ?').get(id) as { n: number }
    ).n;
    if (used > 0) {
      db.prepare(
        `UPDATE dishes SET is_deleted = 1, is_active = 0,
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      ).run(id);
      return res.json({ deleted: true, soft: true, reason: `有 ${used} 条历史订单引用，已软删除（账目保留）` });
    }
    db.prepare('DELETE FROM dishes WHERE id = ?').run(id);
    res.json({ deleted: true, soft: false });
  });

  // 老板：上传菜品图（base64 JSON，存持久卷 /data/uploads，列表页+详情页展示）
  r.post('/:id/image', auth.admin, (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT id FROM dishes WHERE id = ?').get(id) as { id: number } | undefined;
    if (!row) throw new HttpError(404, '菜品不存在');
    const b64 = String(req.body?.image ?? '');
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(b64);
    if (!m) throw new HttpError(400, '图片格式应为 jpeg/png/webp 的 base64 dataURL');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 32) throw new HttpError(400, '图片内容为空');
    if (buf.length > 2 * 1024 * 1024) throw new HttpError(413, '图片超过 2MB，请压缩后再传');
    // 魔数校验（防伪图片名上传任意文件）
    const hex = buf.subarray(0, 4).toString('hex');
    const ok = (m[1] === 'jpeg' && hex.startsWith('ffd8')) || (m[1] === 'png' && hex === '89504e47') || (m[1] === 'webp' && hex.startsWith('5249'));
    if (!ok) throw new HttpError(400, '图片内容与格式不符');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const dir = path.join(deps.dataDir ?? path.join(process.cwd(), 'data'), 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const fname = `dish-${id}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(dir, fname), buf);
    const rel = `/uploads/${fname}`;
    db.prepare(
      `UPDATE dishes SET image_path=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`
    ).run(rel, id);
    res.status(201).json({ ok: true, image_path: rel });
  });

  // 老板：上下架切换
  r.post('/:id/toggle', auth.admin, (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM dishes WHERE id = ?').get(id) as DishRow | undefined;
    if (!row) throw new HttpError(404, '菜品不存在');
    db.prepare(
      `UPDATE dishes SET is_active = ?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`
    ).run(row.is_active === 1 ? 0 : 1, id);
    res.json(adminView(db.prepare('SELECT * FROM dishes WHERE id = ?').get(id) as DishRow));
  });

  return r;
}
