import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DishState, HHMM, normalizeStoreInfo, StoreInfo, TODAY_MAX, type AdminDish, type Dish, type Menu, type StoreStatus, type TodaySignature } from '@pkg/contract';
import type { DB } from './db.ts';
import { businessDate, HttpError, type Clock } from './support.ts';

interface OverrideRow {
  dish_uid: string; listed: number | null; price_sen: number | null; image_closed: string | null; sold_out_date: string | null;
}

/**
 * 菜单 = menu.json（批准稿，只读）+ 老板后台的改动（在售/今日售罄/下架、改价、图片）。
 * 每次都现算，改完立即生效；下单时价格存快照，改价不影响历史订单。
 */
export class MenuService {
  constructor(private db: DB, private base: Menu, private timeZone: string, private clock: Clock) {}

  private overrides(): Map<string, OverrideRow> {
    const rows = this.db.prepare('SELECT dish_uid, listed, price_sen, image_closed, sold_out_date FROM dish_overrides').all() as OverrideRow[];
    return new Map(rows.map((r) => [r.dish_uid, r]));
  }

  /** 老板端：全部菜品（含下架的），带三态和菜单原价 */
  adminDishes(): AdminDish[] {
    const ov = this.overrides();
    const today = businessDate(this.clock(), this.timeZone);
    return this.base.dishes.map((d) => {
      const o = ov.get(d.uid);
      const listed = o?.listed === null || o?.listed === undefined ? d.orderable : o.listed === 1;
      const soldOut = listed && o?.sold_out_date === today; // 「今日」售罄：过了营业日自动失效
      return {
        ...d,
        priceSen: o?.price_sen ?? d.priceSen,
        images: { ...d.images, closed: o?.image_closed ?? d.images.closed },
        orderable: d.orderable && listed, // 配送费这类本来就不卖的，上架也不卖
        soldOut,
        state: (!listed ? 'off' : soldOut ? 'soldout' : 'on') as DishState,
        listed,
        sellable: d.orderable,
        basePriceSen: d.priceSen,
        imageUploaded: Boolean(o?.image_closed),
      };
    });
  }

  /** 顾客端菜单：在售 + 今日售罄（售罄的照常显示、置灰）；下架的不给 */
  customerMenu(): Menu {
    const dishes: Dish[] = this.adminDishes().filter((d) => d.orderable)
      .map(({ listed: _l, sellable: _s, basePriceSen: _b, state: _st, imageUploaded: _u, ...d }) => d);
    return { ...this.base, dishes };
  }

  /** 顾客菜单里的菜（含售罄）。购物车据此判断「已下架」还是「今日售罄」 */
  listedMap(): Map<string, Dish> {
    return new Map(this.customerMenu().dishes.map((d) => [d.uid, d]));
  }

  /** 三态切换（28号 #5）：在售 / 今日售罄 / 下架 */
  setState(uid: string, state: unknown, operator: string): AdminDish {
    const parsed = DishState.safeParse(state);
    if (!parsed.success) throw new HttpError(400, '状态只能是在售、今日售罄或下架');
    const before = this.dish(uid);
    if (!before.sellable) throw new HttpError(400, '这一项本期不在店内售卖，不能切换状态');
    const now = this.clock().toISOString();
    const today = businessDate(this.clock(), this.timeZone);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO dish_overrides (dish_uid, listed, sold_out_date, updated_at) VALUES (?, ?, ?, ?)
                       ON CONFLICT (dish_uid) DO UPDATE SET listed = excluded.listed, sold_out_date = excluded.sold_out_date, updated_at = excluded.updated_at`)
        .run(uid, parsed.data === 'off' ? 0 : 1, parsed.data === 'soldout' ? today : null, now);
      this.db.prepare("INSERT INTO dish_changes (dish_uid, field, old_value, new_value, operator, at) VALUES (?, 'state', ?, ?, ?, ?)")
        .run(uid, before.state, parsed.data, operator, now);
    })();
    return this.dish(uid);
  }

  setPrice(uid: string, priceSen: unknown, operator: string): AdminDish {
    if (typeof priceSen !== 'number' || !Number.isInteger(priceSen) || priceSen <= 0 || priceSen > 100_000) {
      throw new HttpError(400, '价格需大于 0，且不超过 RM 1,000');
    }
    const before = this.dish(uid);
    this.write(uid, 'price_sen', priceSen, String(before.priceSen), String(priceSen), operator);
    return this.dish(uid);
  }

  setImage(uid: string, path: string, operator: string): AdminDish {
    const before = this.dish(uid);
    this.write(uid, 'image_closed', path, before.images.closed, path, operator);
    return this.dish(uid);
  }

  dish(uid: string): AdminDish {
    const d = this.adminDishes().find((x) => x.uid === uid);
    if (!d) throw new HttpError(404, '找不到这道菜');
    return d;
  }

  /**
   * 删除老板上传的图（34号 A）：传错图时的退路。删除后回到导入单里的图；导入单也没有图，就回到「成品图上线中」占位。
   * 删除写进改动日志（谁、何时、删的是哪张）；图片文件本身留在磁盘上不动，日志里的路径永远能找回原图。
   */
  clearImage(uid: string, operator: string): AdminDish {
    const before = this.dish(uid);
    if (!before.imageUploaded) throw new HttpError(400, '这道菜没有在后台上传过图片，不用删除');
    this.write(uid, 'image_closed', null, before.images.closed, null, operator);
    return this.dish(uid);
  }

  /**
   * 54号 §2.2 今日招牌（点单页顶部大画 + 收起后的横幅卡，同一份数据）：只存菜品 ID 列表，存在 settings 表里（不改表结构）。
   * 顾客端只拿到还在菜单上的菜（下架的自动不出现）；图、菜名、价格从菜单现读。
   */
  today(forCustomer: boolean): TodaySignature {
    const raw = this.db.prepare("SELECT value FROM settings WHERE key = 'home.today'").pluck().get() as string | undefined;
    let ids: string[] = [];
    try { ids = raw ? (JSON.parse(raw) as unknown[]).filter((v): v is string => typeof v === 'string') : []; } catch { ids = []; }
    const known = forCustomer ? this.listedMap() : new Map(this.base.dishes.map((d) => [d.uid, d]));
    return { dishes: ids.filter((id) => known.has(id)).slice(0, TODAY_MAX) };
  }

  setToday(input: unknown): TodaySignature {
    const ids = (input as { dishes?: unknown } | null)?.dishes;
    if (!Array.isArray(ids) || !ids.every((v) => typeof v === 'string')) throw new HttpError(400, '今日招牌格式不对');
    if (ids.length > TODAY_MAX) throw new HttpError(400, `今日招牌最多 ${TODAY_MAX} 道`);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, '今日招牌里有重复的菜');
    for (const id of ids) {
      const d = this.base.dishes.find((x) => x.uid === id);
      if (!d) throw new HttpError(400, '找不到这道菜');
      if (!d.orderable) throw new HttpError(400, `「${d.name}」本期不在店内售卖，不能设为今日招牌`);
    }
    if (ids.length) this.db.prepare("INSERT INTO settings (key, value) VALUES ('home.today', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(ids));
    else this.db.prepare("DELETE FROM settings WHERE key = 'home.today'").run();
    return this.today(false);
  }

  private write(uid: string, column: 'price_sen' | 'image_closed', value: number | string | null, oldV: string | null, newV: string | null, operator: string) {
    const field = column === 'price_sen' ? 'price' : 'image';
    const now = this.clock().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO dish_overrides (dish_uid, ${column}, updated_at) VALUES (?, ?, ?)
                       ON CONFLICT (dish_uid) DO UPDATE SET ${column} = excluded.${column}, updated_at = excluded.updated_at`).run(uid, value, now);
      this.db.prepare('INSERT INTO dish_changes (dish_uid, field, old_value, new_value, operator, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(uid, field, oldV, newV, operator, now);
    })();
  }
}

/* ---------------- 图片上传（21号 §3.2：四项排查，失败必须返回可读错误） ---------------- */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // ① 大小上限 5MB

const SIGNATURES: { ext: string; test: (b: Uint8Array) => boolean }[] = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v) },
  { ext: 'webp', test: (b) => String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP' },
];

export class ImageStore {
  /** ③ 存储路径：启动时就检查能不能写，不等老板上传时才发现 */
  readonly problem: string | null;

  constructor(private dir: string) {
    let problem: string | null = null;
    try {
      mkdirSync(dir, { recursive: true });
      // 探针文件名带进程号和随机数：两个服务同时启动也不会互删对方的探针
      const probe = join(dir, `.write-test-${process.pid}-${randomBytes(4).toString('hex')}`);
      writeFileSync(probe, 'ok');
      rmSync(probe);
      accessSync(dir, constants.R_OK | constants.W_OK);
    } catch (e) {
      problem = `图片存储目录不可写（${dir}）：${e instanceof Error ? e.message : String(e)}`;
      console.error(problem);
    }
    this.problem = problem;
  }

  /** 保存一张菜品图，返回给前端用的地址 /media/<文件名> */
  save(uid: string, bytes: Uint8Array): string {
    if (this.problem) throw new HttpError(500, '图片存储目录不可写，请联系技术人员处理（上传未保存）');
    if (bytes.length === 0) throw new HttpError(400, '没有收到图片文件');
    if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(400, `图片太大（${(bytes.length / 1048576).toFixed(1)}MB），请压缩到 5MB 以内`);
    // ② 格式白名单：看文件内容的开头字节判断，不信文件后缀名
    const kind = SIGNATURES.find((s) => s.test(bytes));
    if (!kind) throw new HttpError(400, '只支持 JPG、PNG、WebP 格式的图片');
    const name = `${uid}-${createHash('sha256').update(bytes).digest('hex').slice(0, 10)}.${kind.ext}`;
    try {
      writeFileSync(join(this.dir, name), bytes);
    } catch {
      // ④ 异常捕获：写盘失败也返回可读的话，不让服务崩
      throw new HttpError(500, '图片保存失败（磁盘写入出错），请稍后再试');
    }
    return `/media/${name}`;
  }
}

/* ---------------- 营业状态 ---------------- */

export class StoreHours {
  constructor(private db: DB, private timeZone: string, private clock: Clock) {}

  status(): StoreStatus {
    const paused = this.get('store.paused') === '1';
    const openAt = this.get('store.openAt');
    const closeAt = this.get('store.closeAt');
    if (paused) return { open: false, reason: 'paused', openAt, closeAt };
    if (openAt && closeAt && !this.withinHours(openAt, closeAt)) return { open: false, reason: 'outside-hours', openAt, closeAt };
    return { open: true, reason: null, openAt, closeAt };
  }

  /** 老板端：手动暂停/恢复接单，设置营业时间（两个都空 = 不按时间限制） */
  update(input: { paused?: unknown; openAt?: unknown; closeAt?: unknown }): StoreStatus {
    if (input.paused !== undefined) {
      if (typeof input.paused !== 'boolean') throw new HttpError(400, '暂停接单参数不对');
      this.put('store.paused', input.paused ? '1' : '0');
    }
    if (input.openAt !== undefined || input.closeAt !== undefined) {
      const o = input.openAt === '' || input.openAt === null ? null : input.openAt;
      const c = input.closeAt === '' || input.closeAt === null ? null : input.closeAt;
      if ((o === null) !== (c === null)) throw new HttpError(400, '开门和打烊时间要么都填，要么都不填');
      if (o !== null && (typeof o !== 'string' || typeof c !== 'string' || !HHMM.test(o) || !HHMM.test(c) || o === c)) {
        throw new HttpError(400, '时间格式应为 HH:MM，且开门和打烊不能相同');
      }
      this.put('store.openAt', o as string | null);
      this.put('store.closeAt', c as string | null);
    }
    return this.status();
  }

  /** 支持跨夜：17:00–02:00 表示晚上 5 点到次日凌晨 2 点 */
  private withinHours(openAt: string, closeAt: string): boolean {
    const now = new Intl.DateTimeFormat('en-GB', { timeZone: this.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(this.clock());
    return openAt < closeAt ? now >= openAt && now < closeAt : now >= openAt || now < closeAt;
  }

  private get(key: string): string | null {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined) ?? null;
  }
  private put(key: string, value: string | null) {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}

/* ---------------- 门店信息（58号 任务4） ---------------- */

/**
 * 地址 / 电话 / 营业时间 / WhatsApp：老板端填的存在 settings 表（键 store.info），不改表结构。
 * 老板端没填过（从没保存）时，用品牌配置里的同名字段兜底；保存过就以老板端为准（清空也算填过）。
 */
export class StoreInfoStore {
  constructor(private db: DB, private fallback: Pick<StoreInfo, 'address' | 'phone' | 'hours'>) {}

  get(): StoreInfo {
    const raw = this.db.prepare("SELECT value FROM settings WHERE key = 'store.info'").pluck().get() as string | undefined;
    if (raw !== undefined) {
      try {
        const v = StoreInfo.safeParse(JSON.parse(raw));
        if (v.success) return v.data;
      } catch { /* 坏数据当没填过 */ }
    }
    return { address: this.fallback.address, phone: this.fallback.phone, hours: this.fallback.hours, whatsapp: null };
  }

  set(input: unknown): StoreInfo {
    const r = normalizeStoreInfo(input);
    if (!r.ok) throw new HttpError(400, r.message);
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('store.info', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(r.value));
    return this.get();
  }
}
