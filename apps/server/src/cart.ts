import { randomUUID } from 'node:crypto';
import type { Cart, Dish } from '@pkg/contract';
import type { DB } from './db.ts';
import { HttpError, UUID, type Clock } from './support.ts';

/**
 * 购物车以服务器为准（23号定律2）：每次增减都写数据库，前端回到前台/断网恢复时整车拉齐。
 * 价格永远按当前菜单现算，不信任前端传来的价格。
 *
 * 行的粒度（P1-9）：一行 = 一道菜 + 一个辣度 + 一条备注。
 * 「剁椒鱼 微辣」和「剁椒鱼 特辣」是两行，各有自己的数量和价格；
 * 同菜同辣度同备注连点两下加号仍然是同一行、数量变成 2（唯一索引保证不会冒出两行）。
 * 所以所有改数量的操作都认**行 id**，不再认 dishUid。
 */

/** 辣度 / 备注的长度上限：辣度是选项值（很短），备注给顾客手写，40 字够用且小票折得下 */
const NOTE_MAX = 40;
const SPICE_MAX = 20;

export interface LineInput {
  dishUid: string;
  qty: number;
  spice?: string;
  note?: string;
}

const clean = (s: string | null | undefined, max: number): string =>
  (s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

export class CartService {
  constructor(private db: DB, private dishes: () => Map<string, Dish>, private clock: Clock, private spiceOptions: () => string[] = () => []) {}

  /** 拿到一辆车：传来的编号合法就沿用（没有就按这个编号新建），否则发一个新编号 */
  ensure(id: string | null | undefined): string {
    const cartId = id && UUID.test(id) ? id.toLowerCase() : randomUUID();
    this.db.prepare('INSERT OR IGNORE INTO carts (id, created_at, updated_at) VALUES (?, ?, ?)').run(cartId, this.now(), this.now());
    return cartId;
  }

  view(cartId: string): Cart {
    const row = this.db.prepare('SELECT updated_at FROM carts WHERE id = ?').get(cartId) as { updated_at: string } | undefined;
    if (!row) throw new HttpError(404, '购物车不存在，请刷新页面');
    const items = this.db
      .prepare('SELECT id, dish_uid, qty, spice, note FROM cart_items WHERE cart_id = ? ORDER BY added_at, dish_uid, spice, note')
      .all(cartId) as { id: string; dish_uid: string; qty: number; spice: string; note: string }[];
    const menu = this.dishes();
    const lines = items.map((it) => {
      const d = menu.get(it.dish_uid);
      const price = d?.priceSen ?? null;
      const reason = !d || price === null ? ('off' as const) : d.soldOut ? ('soldout' as const) : null;
      return {
        id: it.id,
        dishUid: it.dish_uid,
        code: d?.code ?? '',
        name: d?.name ?? '已下架的菜品',
        priceSen: price,
        qty: it.qty,
        subtotalSen: price === null ? 0 : price * it.qty,
        spice: it.spice,
        note: it.note,
        available: reason === null,
        unavailableReason: reason,
      };
    });
    return {
      id: cartId,
      lines,
      count: lines.reduce((n, l) => n + l.qty, 0),
      totalSen: lines.reduce((n, l) => n + l.subtotalSen, 0),
      updatedAt: row.updated_at,
    };
  }

  /**
   * 加一道菜（可带辣度和备注）。
   * 同样的「菜 + 辣度 + 备注」已经在车里 → 数量累加，不新开一行。
   */
  add(cartId: string, input: LineInput): string {
    const qty = this.checkQty(input.qty);
    this.mustExist(cartId);
    const d = this.dishes().get(input.dishUid);
    if (!d) throw new HttpError(404, '这道菜暂时不能点');
    if (d.soldOut) throw new HttpError(409, `「${d.name}」今日已售罄`);
    const spice = this.checkSpice(input.spice);
    const note = clean(input.note, NOTE_MAX);

    return this.db.transaction(() => {
      const exist = this.db
        .prepare('SELECT id, qty FROM cart_items WHERE cart_id = ? AND dish_uid = ? AND spice = ? AND note = ?')
        .get(cartId, input.dishUid, spice, note) as { id: string; qty: number } | undefined;
      if (exist) {
        const next = Math.min(99, exist.qty + qty);
        this.checkSoldOutCap(d, next, exist.qty);
        this.db.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').run(next, exist.id);
        this.touch(cartId);
        return exist.id;
      }
      const id = randomUUID();
      this.checkSoldOutCap(d, qty, 0);
      this.db
        .prepare('INSERT INTO cart_items (id, cart_id, dish_uid, qty, spice, note, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, cartId, input.dishUid, qty, spice, note, this.now());
      this.touch(cartId);
      return id;
    })();
  }

  /** 改某一行的数量（0 = 把这一行删掉）。只认行 id，不认菜 */
  setQty(cartId: string, lineId: string, qty: number): void {
    const q = this.checkQty(qty, true);
    this.mustExist(cartId);
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT dish_uid, qty FROM cart_items WHERE id = ? AND cart_id = ?').get(lineId, cartId) as
        | { dish_uid: string; qty: number }
        | undefined;
      if (!row) throw new HttpError(404, '这一行已经不在购物车里了，刷新看看');
      if (q === 0) {
        this.db.prepare('DELETE FROM cart_items WHERE id = ?').run(lineId);
      } else {
        const d = this.dishes().get(row.dish_uid);
        if (d) this.checkSoldOutCap(d, q, row.qty);
        this.db.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').run(q, lineId);
      }
      this.touch(cartId);
    })();
  }

  /** 改某一行的辣度/备注。改完如果和另一行「撞了」（同菜同辣度同备注），两行合并 */
  setLine(cartId: string, lineId: string, patch: { spice?: string; note?: string }): void {
    this.mustExist(cartId);
    this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT dish_uid, qty, spice, note FROM cart_items WHERE id = ? AND cart_id = ?')
        .get(lineId, cartId) as { dish_uid: string; qty: number; spice: string; note: string } | undefined;
      if (!row) throw new HttpError(404, '这一行已经不在购物车里了，刷新看看');
      const spice = patch.spice === undefined ? row.spice : this.checkSpice(patch.spice);
      const note = patch.note === undefined ? row.note : clean(patch.note, NOTE_MAX);
      const twin = this.db
        .prepare('SELECT id, qty FROM cart_items WHERE cart_id = ? AND dish_uid = ? AND spice = ? AND note = ? AND id <> ?')
        .get(cartId, row.dish_uid, spice, note, lineId) as { id: string; qty: number } | undefined;
      if (twin) {
        // 改完跟另一行一模一样 → 合成一行，数量相加。留着两行一样的没有意义，后厨看着也乱
        this.db.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').run(Math.min(99, twin.qty + row.qty), twin.id);
        this.db.prepare('DELETE FROM cart_items WHERE id = ?').run(lineId);
      } else {
        this.db.prepare('UPDATE cart_items SET spice = ?, note = ? WHERE id = ?').run(spice, note, lineId);
      }
      this.touch(cartId);
    })();
  }

  /** 删除某一行 */
  removeLine(cartId: string, lineId: string): void {
    this.mustExist(cartId);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM cart_items WHERE id = ? AND cart_id = ?').run(lineId, cartId);
      this.touch(cartId);
    })();
  }

  /** 兼容老接口：按 dishUid 设数量（同菜多行时取数量最大的那一行，删则全删） */
  setQtyByDish(cartId: string, dishUid: string, qty: number): void {
    const q = this.checkQty(qty, true);
    this.mustExist(cartId);
    this.db.transaction(() => {
      const rows = this.db.prepare('SELECT id, qty FROM cart_items WHERE cart_id = ? AND dish_uid = ? ORDER BY qty DESC').all(cartId, dishUid) as { id: string; qty: number }[];
      if (q === 0) {
        this.db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND dish_uid = ?').run(cartId, dishUid);
      } else if (rows.length === 0) {
        this.add(cartId, { dishUid, qty: q });
      } else {
        const d = this.dishes().get(dishUid);
        if (d) this.checkSoldOutCap(d, q, rows[0]!.qty);
        this.db.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').run(q, rows[0]!.id);
      }
      this.touch(cartId);
    })();
  }

  /** 往车里加若干份（「再来一单」用）；已下架或今日售罄的菜跳过，返回跳过的菜名 */
  addMany(cartId: string, items: { dishUid: string; name: string; qty: number; spice?: string; note?: string }[]): string[] {
    this.mustExist(cartId);
    const skipped: string[] = [];
    for (const it of items) {
      const d = this.dishes().get(it.dishUid);
      if (!d || d.soldOut) {
        skipped.push(it.name);
        continue;
      }
      try {
        this.add(cartId, { dishUid: it.dishUid, qty: it.qty, spice: it.spice, note: it.note });
      } catch {
        skipped.push(it.name);
      }
    }
    return skipped;
  }

  clear(cartId: string) {
    this.mustExist(cartId);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cartId);
      this.touch(cartId);
    })();
  }

  private checkQty(qty: number, allowZero = false): number {
    if (!Number.isInteger(qty) || qty < (allowZero ? 0 : 1) || qty > 99) throw new HttpError(400, allowZero ? '数量需在 0 到 99 之间' : '数量需在 1 到 99 之间');
    return qty;
  }

  /** 辣度必须是 brand.spiceOptions 里的值；空串表示没选。不认识的辣度直接拒绝，别让后厨收到「超微辣」 */
  private checkSpice(spice: string | null | undefined): string {
    const v = clean(spice, SPICE_MAX);
    if (!v) return '';
    const opts = this.spiceOptions();
    if (opts.length === 0) return v; // 没配辣度选项的店，原样存着（不至于用不了）
    if (!opts.includes(v)) throw new HttpError(400, `辣度只能选：${opts.join(' / ')}`);
    return v;
  }

  /** 今日售罄：已经在车里的可以减少或删除，但不能往上加 */
  private checkSoldOutCap(d: Dish, next: number, was: number) {
    if (d.soldOut && next > was) throw new HttpError(409, `「${d.name}」今日已售罄`);
  }

  private mustExist(cartId: string) {
    if (!this.db.prepare('SELECT 1 FROM carts WHERE id = ?').get(cartId)) throw new HttpError(404, '购物车不存在，请刷新页面');
  }
  private touch(cartId: string) {
    this.db.prepare('UPDATE carts SET updated_at = ? WHERE id = ?').run(this.now(), cartId);
  }
  private now() {
    return this.clock().toISOString();
  }
}
