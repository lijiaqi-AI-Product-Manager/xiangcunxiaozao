import { Router } from 'express';
import type { AppDeps } from '../types.js';
import { makeAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/errors.js';
import { formatRM } from '../utils/money.js';

interface MemberRow {
  id: number;
  card_no: string;
  name: string;
  balance_cents: number;
  is_active: number;
  note: string;
  created_at: string;
}

function logM(
  db: AppDeps['db'],
  cardNo: string,
  action: string,
  amount: number,
  balanceAfter: number,
  detail: string
): void {
  db.prepare(
    `INSERT INTO member_logs(card_no, action, amount_cents, balance_after, detail)
     VALUES(?, ?, ?, ?, ?)`
  ).run(cardNo, action, amount, balanceAfter, detail.slice(0, 200));
}

/** 会员卡管理：建卡/充值/调整/停启用——全部老板权限，流水全程留痕 */
export default function membersRoutes(deps: AppDeps): Router {
  const r = Router();
  const { db } = deps;
  const auth = makeAuth(deps.adminToken, deps.kitchenToken).admin;

  // 公开：按卡号查余额+近期记录（顾客端"我的"页绑定用；卡号由老板发放，随机性即凭证）
  r.get('/lookup', (_req, res) => {
    const card = String(_req.query.card_no ?? '').trim();
    if (!card || card.length < 2 || card.length > 32) throw new HttpError(400, '卡号格式不对');
    const m = db.prepare('SELECT card_no, name, balance_cents, is_active FROM members WHERE card_no = ?').get(card) as
      | { card_no: string; name: string; balance_cents: number; is_active: number }
      | undefined;
    if (!m) throw new HttpError(404, '没有这张卡，请找老板确认卡号');
    const recent = db
      .prepare(`SELECT action, amount_cents, balance_after, order_no, at FROM member_logs WHERE card_no = ? ORDER BY id DESC LIMIT 5`)
      .all(card) as { action: string; amount_cents: number; balance_after: number; order_no: string; at: string }[];
    res.json({
      card_no: m.card_no,
      name: m.name,
      balance_cents: m.balance_cents,
      balance_rm: formatRM(m.balance_cents),
      is_active: m.is_active === 1,
      recent: recent.map((r) => ({
        action: r.action,
        amount_cents: r.amount_cents,
        amount_rm: formatRM(Math.abs(r.amount_cents)),
        sign: r.amount_cents >= 0 ? '+' : '-',
        order_no: r.order_no,
        at: r.at,
      })),
    });
  });

  r.get('/', auth, (_req, res) => {
    const rows = db
      .prepare(`SELECT * FROM members ORDER BY id DESC LIMIT 500`)
      .all() as MemberRow[];
    res.json(
      rows.map((m) => ({
        card_no: m.card_no,
        name: m.name,
        balance_cents: m.balance_cents,
        balance_rm: formatRM(m.balance_cents),
        is_active: m.is_active === 1,
        note: m.note,
        created_at: m.created_at,
      }))
    );
  });

  r.post('/', auth, (req, res) => {
    const card = String(req.body?.card_no ?? '').trim();
    const name = String(req.body?.name ?? '').slice(0, 40);
    const note = String(req.body?.note ?? '').slice(0, 200);
    if (!/^[A-Za-z0-9\-]{2,32}$/.test(card)) {
      throw new HttpError(400, '卡号需2-32位字母/数字/短横线');
    }
    const exists = db.prepare(`SELECT id FROM members WHERE card_no = ?`).get(card);
    if (exists) throw new HttpError(409, `卡号已存在: ${card}`);
    db.prepare(`INSERT INTO members(card_no, name, note) VALUES(?, ?, ?)`).run(card, name, note);
    logM(db, card, 'create', 0, 0, name ? `建卡（${name}）` : '建卡');
    res.status(201).json({ card_no: card, balance_cents: 0 });
  });

  // 充值（只加不减，金额必须为正）
  r.post('/:cardNo/topup', auth, (req, res) => {
    const card = String(req.params.cardNo);
    const amount = Math.round(Number(req.body?.amount_cents));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_00) {
      throw new HttpError(400, '充值金额需在 RM 0.01 - 100,000 之间');
    }
    const tx = db.transaction(() => {
      const m = db.prepare('SELECT * FROM members WHERE card_no = ?').get(card) as MemberRow | undefined;
      if (!m) throw new HttpError(404, `会员卡不存在: ${card}`);
      const after = m.balance_cents + amount;
      db.prepare('UPDATE members SET balance_cents = ? WHERE id = ?').run(after, m.id);
      logM(db, card, 'topup', amount, after, `充值 ${formatRM(amount)}`);
      return { m, after };
    });
    const { m, after } = tx();
    res.json({ card_no: card, name: m.name, balance_cents: after, balance_rm: formatRM(after) });
  });

  // 人工调整（可正可负，负向必须留原因；余额不得为负）
  r.post('/:cardNo/adjust', auth, (req, res) => {
    const card = String(req.params.cardNo);
    const amount = Math.round(Number(req.body?.amount_cents));
    const reason = String(req.body?.reason ?? '').trim();
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100_000_00) {
      throw new HttpError(400, '调整金额非法');
    }
    if (amount < 0 && !reason) throw new HttpError(400, '扣减余额必须填写原因');
    const tx = db.transaction(() => {
      const m = db.prepare('SELECT * FROM members WHERE card_no = ?').get(card) as MemberRow | undefined;
      if (!m) throw new HttpError(404, `会员卡不存在: ${card}`);
      const after = m.balance_cents + amount;
      if (after < 0) throw new HttpError(400, `调整后余额为负（当前 ${formatRM(m.balance_cents)}）`);
      db.prepare('UPDATE members SET balance_cents = ? WHERE id = ?').run(after, m.id);
      logM(db, card, 'adjust', amount, after, `${reason || '调整'} ${formatRM(amount)}`);
      return { m, after };
    });
    const { m, after } = tx();
    res.json({ card_no: card, name: m.name, balance_cents: after, balance_rm: formatRM(after) });
  });

  // 停用/启用
  r.post('/:cardNo/toggle', auth, (req, res) => {
    const card = String(req.params.cardNo);
    const m = db.prepare('SELECT * FROM members WHERE card_no = ?').get(card) as MemberRow | undefined;
    if (!m) throw new HttpError(404, `会员卡不存在: ${card}`);
    const next = m.is_active === 1 ? 0 : 1;
    db.prepare('UPDATE members SET is_active = ? WHERE id = ?').run(next, m.id);
    logM(db, card, next ? 'enable' : 'disable', 0, m.balance_cents, next ? '启用' : '停用');
    res.json({ card_no: card, is_active: next === 1 });
  });

  r.get('/:cardNo/logs', auth, (req, res) => {
    res.json(
      db
        .prepare(`SELECT action, amount_cents, balance_after, order_no, detail, at
                  FROM member_logs WHERE card_no = ? ORDER BY id DESC LIMIT 100`)
        .all(String(req.params.cardNo))
    );
  });

  return r;
}
