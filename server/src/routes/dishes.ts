import { Router } from 'express';
import type { AppDeps } from '../types.js';
import { makeAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/errors.js';
import { parsePriceToCents } from '../utils/money.js';

interface DishRow {
  id: number;
  name: string;
  description: string;
  price_cents: number;
  image_path: string;
  category: string;
  sort_order: number;
  is_active: number;
  animation_key: string;
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
  });
  const adminView = (d: DishRow) => ({ ...publicView(d), sort_order: d.sort_order, is_active: d.is_active });

  // 顾客菜单（只要在售的）
  r.get('/', (_req, res) => {
    const rows = db
      .prepare(`SELECT * FROM dishes WHERE is_active = 1 ORDER BY sort_order, id`)
      .all() as DishRow[];
    res.json(rows.map(publicView));
  });

  // 老板：全量菜品（含下架的）
  r.get('/all', auth.admin, (_req, res) => {
    const rows = db.prepare(`SELECT * FROM dishes ORDER BY sort_order, id`).all() as DishRow[];
    res.json(rows.map(adminView));
  });

  // 老板：新增菜品
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

    db.prepare(
      `UPDATE dishes SET name=?, description=?, price_cents=?, category=?, animation_key=?,
       sort_order=?, is_active=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`
    ).run(name, description, price, category, animationKey, sortOrder, isActive, id);
    res.json(adminView(db.prepare('SELECT * FROM dishes WHERE id = ?').get(id) as DishRow));
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
