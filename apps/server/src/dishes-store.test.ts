// 菜品管理（上下架/改价/图片上传四项防崩）+ 营业时间与打烊停单 + 重启后数据不丢
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminDish, Cart, Menu, Order, StoreStatus } from '@pkg/contract';
import { createApp } from './app.ts';
import { openDb, type DB } from './db.ts';

const PASSWORD = 'test-password-123';
// 一张真实的 1×1 像素 PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

let db: DB;
let now: Date;
let dir: string;
let api: ReturnType<typeof createApp>['app'];
let admin: string;

const req = (path: string, init: { body?: unknown; admin?: boolean } = {}) =>
  api.request(path, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(init.admin ? { authorization: `Bearer ${admin}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const upload = (uid: string, bytes: Uint8Array, name = 'a.png') => {
  const form = new FormData();
  form.append('file', new File([bytes], name));
  return api.request(`/api/admin/dishes/${uid}/image`, { method: 'POST', headers: { authorization: `Bearer ${admin}` }, body: form });
};
const msg = async (r: Response) => String(((await r.json()) as { message?: string }).message);
const customerMenu = async () => Menu.parse(await (await req('/api/menu')).json());

function build(uploadDir: string) {
  api = createApp(db, resolve('brands', process.env.BRAND!), { adminPassword: PASSWORD, uploadDir, clock: () => now }).app;
}
async function order(dishUid: string) {
  const cart = Cart.parse(await (await req('/api/cart/refresh', { body: {} })).json());
  await req('/api/cart/update', { body: { cartId: cart.id, dishUid, qty: 1 } });
  return req('/api/order/submit', { body: { cartId: cart.id, tableNo: '8', paymentMethod: 'cash' } });
}

beforeEach(async () => {
  db = openDb(':memory:');
  now = new Date('2026-10-17T04:00:00Z'); // 吉隆坡 12:00
  dir = mkdtempSync(join(tmpdir(), 'xc-upload-'));
  build(dir);
  admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('上下架', () => {
  it('下架后顾客菜单里没有、购物车标「已下架」、不能下单；重新上架恢复', async () => {
    const cart = Cart.parse(await (await req('/api/cart/refresh', { body: {} })).json());
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'e01', qty: 1 } });
    await req('/api/admin/dishes/e01/state', { body: { state: 'off' }, admin: true });
    expect((await customerMenu()).dishes.some((d) => d.uid === 'e01')).toBe(false);
    const c = Cart.parse(await (await req('/api/cart/refresh', { body: { cartId: cart.id } })).json());
    expect(c.lines[0]).toMatchObject({ dishUid: 'e01', available: false });
    const r = await req('/api/order/submit', { body: { cartId: cart.id, tableNo: '1', paymentMethod: 'cash' } });
    expect(r.status).toBe(409);
    expect(await msg(r)).toContain('已下架');
    await req('/api/admin/dishes/e01/state', { body: { state: 'on' }, admin: true });
    expect((await customerMenu()).dishes.some((d) => d.uid === 'e01')).toBe(true);
  });
  it('老板端能看到下架的菜，顾客端看不到', async () => {
    await req('/api/admin/dishes/b02/state', { body: { state: 'off' }, admin: true });
    const all = (await (await req('/api/admin/dishes', { admin: true })).json()) as AdminDish[];
    expect(all.find((d) => d.uid === 'b02')).toMatchObject({ listed: false, orderable: false });
  });
});

describe('改价', () => {
  it('新订单按新价；已下的订单价格不变（快照）；改动留痕', async () => {
    const before = Order.parse(await (await order('c03')).json());
    expect(before.totalSen).toBe(2500);
    const r = await req('/api/admin/dishes/c03/price', { body: { priceSen: 2800 }, admin: true });
    expect(AdminDish.parse(await r.json())).toMatchObject({ priceSen: 2800, basePriceSen: 2500 });
    const after = Order.parse(await (await order('c03')).json());
    expect(after.totalSen).toBe(2800);
    expect(Order.parse(await (await req(`/api/order/${before.id}`)).json()).totalSen).toBe(2500);
    expect(db.prepare("SELECT old_value, new_value FROM dish_changes WHERE dish_uid = 'c03' AND field = 'price'").get()).toEqual({ old_value: '2500', new_value: '2800' });
    expect(() => db.prepare('DELETE FROM dish_changes').run()).toThrow(/append-only/);
  });
  it('价格必须大于 0、不超过 RM 1,000', async () => {
    expect((await req('/api/admin/dishes/c03/price', { body: { priceSen: 0 }, admin: true })).status).toBe(400);
    expect((await req('/api/admin/dishes/c03/price', { body: { priceSen: 100_001 }, admin: true })).status).toBe(400);
  });
});

describe('图片上传：四项防崩（大小 / 格式 / 存储路径 / 异常），失败都有可读提示', () => {
  it('正常 PNG：保存成功，顾客菜单用新图，图片能访问', async () => {
    const r = await upload('e01', PNG);
    expect(r.status).toBe(200);
    const d = AdminDish.parse(await r.json());
    expect(d.images.closed).toMatch(/^\/media\/e01-[0-9a-f]{10}\.png$/);
    expect((await customerMenu()).dishes.find((x) => x.uid === 'e01')?.images.closed).toBe(d.images.closed);
    const img = await api.request(d.images.closed!);
    expect(img.headers.get('content-type')).toBe('image/png');
  });
  it('① 超过 5MB：拒绝并提示压缩', async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    big.set(PNG);
    const r = await upload('e01', big);
    expect(r.status).toBe(413);
    expect(await msg(r)).toContain('5MB');
  });
  it('② 改了后缀的假图片：按文件内容识别，拒绝', async () => {
    const r = await upload('e01', new TextEncoder().encode('this is not an image'), 'fake.jpg');
    expect(r.status).toBe(400);
    expect(await msg(r)).toBe('只支持 JPG、PNG、WebP 格式的图片');
  });
  it('③ 存储目录不可写：返回可读错误，服务不崩，菜单不变', async () => {
    const notADir = join(dir, 'a-file');
    writeFileSync(notADir, 'x');
    build(join(notADir, 'uploads')); // 目录建在一个文件下面 → 必然失败
    const r = await upload('e01', PNG);
    expect(r.status).toBe(500);
    expect(await msg(r)).toContain('图片存储目录不可写');
    expect((await customerMenu()).dishes.find((x) => x.uid === 'e01')?.images.closed).toBeNull();
    expect((await req('/api/health')).status).toBe(200);
  });
  it('④ 没选文件 / 菜不存在：都是可读提示', async () => {
    const empty = await api.request('/api/admin/dishes/e01/image', { method: 'POST', headers: { authorization: `Bearer ${admin}` }, body: new FormData() });
    expect(await msg(empty)).toBe('没有收到图片文件');
    expect((await upload('no-such-dish', PNG)).status).toBe(404);
  });
  it('没登录不能上传', async () => {
    const form = new FormData();
    form.append('file', new File([PNG], 'a.png'));
    expect((await api.request('/api/admin/dishes/e01/image', { method: 'POST', body: form })).status).toBe(401);
  });
});

describe('菜品图：老板传一次，点单页小格子和详情页大图都有（2026-10-26）', () => {
  const uploadBoth = (uid: string, main: Uint8Array, thumb: Uint8Array) => {
    const form = new FormData();
    form.append('file', new File([main], 'a.png'));
    form.append('thumb', new File([thumb], 'a-thumb.png'));
    return api.request(`/api/admin/dishes/${uid}/image`, { method: 'POST', headers: { authorization: `Bearer ${admin}` }, body: form });
  };

  it('一次上传，两处拿到同一道菜的图：大图 = images.closed，小格子 = images.thumb，而且小图确实是小图', async () => {
    // 小图换个内容（末尾补一个字节），这样两个文件名不会撞在一起，能确认用的不是同一份文件
    const small = new Uint8Array([...PNG, 0x00]);
    const d = AdminDish.parse(await (await uploadBoth('e01', PNG, small)).json());
    expect(d.images.closed).toMatch(/^\/media\/e01-[0-9a-f]{10}\.png$/);
    expect(d.images.thumb).toMatch(/^\/media\/e01-[0-9a-f]{10}-thumb\.png$/);
    expect(d.images.thumb).not.toBe(d.images.closed);

    // 顾客端菜单里两处都在（顾客端拿不到「是不是上传的」这种后台字段，但图必须有）
    const menu = await customerMenu();
    const dish = menu.dishes.find((x) => x.uid === 'e01')!;
    expect(dish.images.closed).toBe(d.images.closed);
    expect(dish.images.thumb).toBe(d.images.thumb);

    // 两个地址都真的能取到图，而且 Content-Type 正确（小图文件名过 /media 的白名单正则）
    const main = await req(d.images.closed!);
    expect(main.status).toBe(200);
    expect(main.headers.get('content-type')).toBe('image/png');
    const thumb = await req(d.images.thumb!);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/png');
  });

  it('旧客户端只传主图：小格子退回用主图，不会空着', async () => {
    const d = AdminDish.parse(await (await upload('e02', PNG)).json());
    expect(d.images.closed).not.toBeNull();
    expect(d.images.thumb).toBe(d.images.closed);
    expect((await customerMenu()).dishes.find((x) => x.uid === 'e02')?.images.thumb).toBe(d.images.closed);
  });

  it('换图时小图跟着换；换的新图没带小图，就退回用新大图（不会继续显示上一张的小图）', async () => {
    const first = AdminDish.parse(await (await uploadBoth('e01', PNG, new Uint8Array([...PNG, 0x01]))).json());
    expect(first.images.thumb).not.toBe(first.images.closed);
    const second = AdminDish.parse(await (await upload('e01', new Uint8Array([...PNG, 0x02]))).json());
    expect(second.images.closed).not.toBe(first.images.closed);
    expect(second.images.thumb).toBe(second.images.closed); // 不是 first.images.thumb
  });

  it('小图不是图片 / 太大：小图丢掉，主图照存，老板不会因为一张小图看不到大图', async () => {
    const form = new FormData();
    form.append('file', new File([PNG], 'a.png'));
    form.append('thumb', new File([new TextEncoder().encode('not an image')], 'bad.png'));
    const r = await api.request('/api/admin/dishes/e03/image', { method: 'POST', headers: { authorization: `Bearer ${admin}` }, body: form });
    expect(r.status).toBe(200);
    const d = AdminDish.parse(await r.json());
    expect(d.images.closed).not.toBeNull();
    expect(d.images.thumb).toBe(d.images.closed);
  });

  it('删图把小图一起删掉，恢复占位时两处都没有图', async () => {
    const d = AdminDish.parse(await (await uploadBoth('e01', PNG, new Uint8Array([...PNG, 0x03]))).json());
    expect(d.images.thumb).not.toBeNull();
    const cleared = AdminDish.parse(await (await req('/api/admin/dishes/e01/image/clear', { body: {}, admin: true })).json());
    expect(cleared.images.closed).toBeNull();
    expect(cleared.images.thumb).toBeNull();
    expect((await customerMenu()).dishes.find((x) => x.uid === 'e01')?.images.thumb).toBeNull();
  });

  it('/media 只放行「菜品编号-指纹[-thumb].扩展名」这一种文件名，其它一律 404（防目录穿越）', async () => {
    for (const bad of ['../package.json', 'e01-0123456789.js', 'e01-0123456789-thumb.svg', 'e01-x.svg']) {
      expect((await req(`/media/${encodeURIComponent(bad)}`)).status).toBe(404);
    }
  });
});

describe('删除图片，恢复占位（34号 A）', () => {
  it('删掉上传的图：顾客端回到占位；改动日志记下删的是哪张；原图文件还在', async () => {
    const up = AdminDish.parse(await (await upload('e01', PNG)).json());
    expect(up.imageUploaded).toBe(true);
    const r = await req('/api/admin/dishes/e01/image/clear', { body: {}, admin: true });
    expect(r.status).toBe(200);
    expect(AdminDish.parse(await r.json())).toMatchObject({ imageUploaded: false, images: { closed: null } });
    expect((await customerMenu()).dishes.find((x) => x.uid === 'e01')?.images.closed).toBeNull();
    const log = db.prepare("SELECT old_value, new_value FROM dish_changes WHERE dish_uid = 'e01' AND field = 'image' ORDER BY id").all();
    expect(log).toEqual([{ old_value: null, new_value: up.images.closed }, { old_value: up.images.closed, new_value: null }]);
    expect(readdirSync(join(dir))).toContain(up.images.closed!.replace('/media/', ''));
  });
  it('没上传过图的菜不能删，给可读提示；没登录不能删', async () => {
    const r = await req('/api/admin/dishes/e01/image/clear', { body: {}, admin: true });
    expect(r.status).toBe(400);
    expect(await msg(r)).toBe('这道菜没有在后台上传过图片，不用删除');
    expect((await req('/api/admin/dishes/e01/image/clear', { body: {} })).status).toBe(401);
  });
  it('顾客端菜单不带「是不是上传的图」这种后台字段', async () => {
    await upload('e01', PNG);
    const raw = (await (await req('/api/menu')).json()) as { dishes: Record<string, unknown>[] };
    expect(raw.dishes.find((d) => d.uid === 'e01')).not.toHaveProperty('imageUploaded');
  });
});

describe('营业时间与打烊停单', () => {
  const status = async () => StoreStatus.parse(await (await req('/api/store/status')).json());
  it('默认营业；老板暂停接单后不能下单，恢复后可以', async () => {
    expect((await status()).open).toBe(true);
    await req('/api/admin/store', { body: { paused: true }, admin: true });
    expect(await status()).toMatchObject({ open: false, reason: 'paused' });
    const r = await order('e01');
    expect(r.status).toBe(409);
    expect(await msg(r)).toBe('本店暂停接单，请稍后再来');
    await req('/api/admin/store', { body: { paused: false }, admin: true });
    expect((await order('e01')).status).toBe(201);
  });
  it('跨夜营业 17:00–02:00：中午打烊，凌晨 0:30 营业', async () => {
    await req('/api/admin/store', { body: { openAt: '17:00', closeAt: '02:00' }, admin: true });
    expect(await status()).toMatchObject({ open: false, reason: 'outside-hours' }); // 吉隆坡 12:00
    expect(await msg(await order('e01'))).toBe('本店已打烊，营业时间 17:00–02:00');
    now = new Date('2026-10-17T16:30:00Z'); // 吉隆坡 00:30
    expect((await status()).open).toBe(true);
  });
  it('暂停接单时告诉顾客大概多久恢复（P2-9）', async () => {
    // 默认 15 分钟
    await req('/api/admin/store', { body: { paused: true }, admin: true });
    const a = await status();
    expect(a.pauseMinutes).toBe(15);
    // 吉隆坡 12:00 暂停 → 12:15 恢复
    expect(Date.parse(a.resumeAt!)).toBe(now.getTime() + 15 * 60_000);

    // 老板改成 40 分钟，恢复时刻跟着变
    await req('/api/admin/store', { body: { paused: false }, admin: true });
    await req('/api/admin/store', { body: { paused: true, pauseMinutes: 40 }, admin: true });
    const b = await status();
    expect(b.pauseMinutes).toBe(40);
    expect(Date.parse(b.resumeAt!)).toBe(now.getTime() + 40 * 60_000);

    // 恢复营业后不再挂倒计时
    await req('/api/admin/store', { body: { paused: false }, admin: true });
    expect(await status()).toMatchObject({ open: true, pauseMinutes: null, resumeAt: null });
  });

  it('暂停时长填得离谱直接拒掉（别让顾客看到「预计 9999 分钟」）', async () => {
    expect((await req('/api/admin/store', { body: { paused: true, pauseMinutes: 0 }, admin: true })).status).toBe(400);
    expect((await req('/api/admin/store', { body: { paused: true, pauseMinutes: 999 }, admin: true })).status).toBe(400);
    expect((await req('/api/admin/store', { body: { paused: true, pauseMinutes: -5 }, admin: true })).status).toBe(400);
  });

  it('营业时间格式检查', async () => {
    expect((await req('/api/admin/store', { body: { openAt: '9:00', closeAt: '22:00' }, admin: true })).status).toBe(400);
    expect((await req('/api/admin/store', { body: { openAt: '11:00' }, admin: true })).status).toBe(400);
    expect((await req('/api/admin/store', { body: { openAt: '', closeAt: '' }, admin: true })).status).toBe(200);
  });
});

describe('服务器重启后数据不丢', () => {
  it('同一个数据库文件关掉再打开：订单、迁移都在，迁移不会重复执行', async () => {
    const file = join(dir, 'restart.db');
    const a = openDb(file);
    a.prepare("INSERT INTO settings (key, value) VALUES ('probe', 'kept')").run();
    a.close();
    const b = openDb(file);
    expect(b.prepare("SELECT value FROM settings WHERE key = 'probe'").pluck().get()).toBe('kept');
    const migrationFiles = readdirSync(join(import.meta.dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')).length;
    expect(b.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(migrationFiles);
    b.close();
  });
});
