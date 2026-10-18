import { randomUUID } from 'node:crypto';
import type { Cart, Dish } from '@pkg/contract';
import type { DB } from './db.ts';
import { HttpError, UUID, type Clock } from './support.ts';

/**
 * 购物车以服务器为准（23号定律2）：每次增减都写数据库，前端回到前台/断网恢复时整车拉齐。
 * 价格永远按当前菜单现算，不信任前端传来的价格。
 */
export class CartService {
  constructor(private db: DB, private dishes: () => Map<string, Dish>, private clock: Clock) {}

  /** 拿到一辆车：传来的编号合法就沿用（没有就按这个编号新建），否则发一个新编号 */
  ensure(id: string | null | undefined): string {
    const cartId = id && UUID.test(id) ? id.toLowerCase() : randomUUID();
    this.db.prepare('INSERT OR IGNORE INTO carts (id, created_at, updated_at) VALUES (?, ?, ?)').run(cartId, this.now(), this.now());
    return cartId;
  }

  view(cartId: string): Cart {
    const row = this.db.prepare('SELECT updated_at FROM carts WHERE id = ?').get(cartId) as { updated_at: string } | undefined;
    if (!row) throw new HttpError(404, '购物车不存在，请刷新页面');
    const items = this.db.prepare('SELECT dish_uid, qty FROM cart_items WHERE cart_id = ? ORDER BY added_at, dish_uid').all(cartId) as { dish_uid: string; qty: number }[];
    const menu = this.dishes();
    const lines = items.map((it) => {
      const d = menu.get(it.dish_uid);
      const price = d?.priceSen ?? null;
      const reason = !d || price === null ? ('off' as const) : d.soldOut ? ('soldout' as const) : null;
      return {
        dishUid: it.dish_uid, code: d?.code ?? '', name: d?.name ?? '已下架的菜品', priceSen: price, qty: it.qty,
        subtotalSen: price === null ? 0 : price * it.qty, available: reason === null, unavailableReason: reason,
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

  /** 把某道菜的数量设成 qty（0 = 移除） */
  setQty(cartId: string, dishUid: string, qty: number) {
    if (!Number.isInteger(qty) || qty < 0 || qty > 99) throw new HttpError(400, '数量需在 0 到 99 之间');
    this.mustExist(cartId);
    this.db.transaction(() => {
      if (qty === 0) {
        this.db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND dish_uid = ?').run(cartId, dishUid);
      } else {
        const d = this.dishes().get(dishUid);
        if (!d) throw new HttpError(404, '这道菜暂时不能点');
        // 今日售罄：不能再加；已经在车里的可以减少或移除
        const had = (this.db.prepare('SELECT qty FROM cart_items WHERE cart_id = ? AND dish_uid = ?').pluck().get(cartId, dishUid) as number | undefined) ?? 0;
        if (d.soldOut && qty > had) throw new HttpError(409, `「${d.name}」今日已售罄`);
        this.db.prepare(`INSERT INTO cart_items (cart_id, dish_uid, qty, added_at) VALUES (?, ?, ?, ?)
                         ON CONFLICT (cart_id, dish_uid) DO UPDATE SET qty = excluded.qty`).run(cartId, dishUid, qty, this.now());
      }
      this.touch(cartId);
    })();
  }

  /** 往车里加若干份（「再来一单」用）；已下架或今日售罄的菜跳过，返回跳过的菜名 */
  addMany(cartId: string, items: { dishUid: string; name: string; qty: number }[]): string[] {
    this.mustExist(cartId);
    const skipped: string[] = [];
    this.db.transaction(() => {
      for (const it of items) {
        const d = this.dishes().get(it.dishUid);
        if (!d || d.soldOut) { skipped.push(it.name); continue; }
        this.db.prepare(`INSERT INTO cart_items (cart_id, dish_uid, qty, added_at) VALUES (?, ?, ?, ?)
                         ON CONFLICT (cart_id, dish_uid) DO UPDATE SET qty = min(99, qty + excluded.qty)`).run(cartId, it.dishUid, Math.min(99, it.qty), this.now());
      }
      this.touch(cartId);
    })();
    return skipped;
  }

  clear(cartId: string) {
    this.mustExist(cartId);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cartId);
      this.touch(cartId);
    })();
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
