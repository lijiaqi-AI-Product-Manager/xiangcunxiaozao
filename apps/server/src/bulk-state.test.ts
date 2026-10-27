// 批量改状态：老板一次收拾一整类菜（夜里收档全下架 / 第二天全上架）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminDish, Menu } from '@pkg/contract';
import { createApp } from './app.ts';
import { openDb, type DB } from './db.ts';

const PASSWORD = 'test-password-123';

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
/** 带管理员身份的 GET（req 只有在传了 body 时才带 token，GET 会被当成匿名请求） */
const adminGetJson = async (path: string) =>
  (await api.request(path, { headers: { authorization: `Bearer ${admin}` } })).json();
const bulk = (uids: unknown, state: unknown) => req('/api/admin/dishes/bulk-state', { body: { uids, state }, admin: true });
const changes = (uid: string) =>
  db.prepare("SELECT old_value, new_value FROM dish_changes WHERE dish_uid = ? AND field = 'state' ORDER BY id").all(uid) as
    { old_value: string; new_value: string }[];

beforeEach(async () => {
  db = openDb(':memory:');
  now = new Date('2026-10-17T04:00:00Z'); // 吉隆坡 12:00
  dir = mkdtempSync(join(tmpdir(), 'xc-bulk-'));
  api = createApp(db, resolve('brands', process.env.BRAND!), { adminPassword: PASSWORD, uploadDir: dir, clock: () => now }).app;
  admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 挑几道「本期在店内售卖」的菜（配送费这类 orderable=false 的不能参与批量） */
async function pickSellable(n: number): Promise<string[]> {
  const all = AdminDish.array().parse(await adminGetJson('/api/admin/dishes'));
  return all.filter((d) => d.sellable).slice(0, n).map((d) => d.uid);
}

describe('批量改状态', () => {
  it('一次把 5 道菜下架：全部变成下架，顾客菜单里一道都不剩', async () => {
    const uids = await pickSellable(5);
    const r = await bulk(uids, 'off');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { dishes: AdminDish[]; changed: number };
    expect(body.changed).toBe(5);
    for (const uid of uids) expect(body.dishes.find((d) => d.uid === uid)?.state).toBe('off');

    const menu = Menu.parse(await (await req('/api/menu')).json());
    for (const uid of uids) expect(menu.dishes.some((d) => d.uid === uid)).toBe(false);
  });

  it('本来就是「在售」的再点「在售」：不算改动、不写日志（否则日志全是噪音）', async () => {
    const uids = await pickSellable(3);
    db.prepare('DELETE FROM dish_changes').run();
    const body = (await (await bulk(uids, 'on')).json()) as { changed: number };
    expect(body.changed).toBe(0);
    for (const uid of uids) expect(changes(uid)).toEqual([]);
  });

  it('改过的每一道都留一条日志：谁、从什么改成什么', async () => {
    const [a, b] = await pickSellable(2) as [string, string];
    await bulk([a, b], 'off');
    expect(changes(a!)).toEqual([{ old_value: 'on', new_value: 'off' }]);
    expect(changes(b!)).toEqual([{ old_value: 'on', new_value: 'off' }]);
    const who = db.prepare("SELECT operator FROM dish_changes WHERE dish_uid = ? AND field = 'state'").pluck().get(a);
    expect(who).toBe('admin'); // 没在页面上选名字时 operatorOf 给的就是 admin
  });

  it('署了名的改动记的是那个名字（批量也一样，别把日志记成一堆 admin）', async () => {
    const [uid] = await pickSellable(1) as [string];
    await api.request('/api/admin/dishes/bulk-state', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}`, 'x-operator': 'Azhen' },
      body: JSON.stringify({ uids: [uid], state: 'off' }),
    });
    expect(db.prepare("SELECT operator FROM dish_changes WHERE dish_uid = ? AND field = 'state'").pluck().get(uid)).toBe('Azhen');
  });

  it('今日售罄：顾客照常看得到、标售罄；第二个营业日自动恢复在售', async () => {
    const [uid] = await pickSellable(1) as [string];
    await bulk([uid], 'soldout');
    const menu = Menu.parse(await (await req('/api/menu')).json());
    expect(menu.dishes.find((d) => d.uid === uid)?.soldOut).toBe(true);

    // 第二天中午。老板端的登录令牌 12 小时后过期，跳 24 小时必须重新登录——
    // 这不是 bug，是设计（令牌过期本来就该重登），测试照实重登一次。
    now = new Date('2026-10-18T04:00:00Z');
    admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
    const list = AdminDish.array().parse(await adminGetJson('/api/admin/dishes'));
    expect(list.find((d) => d.uid === uid)?.state).toBe('on');
  });

  it('混进不卖的菜（配送费）：跳过它，不报错，也不悄悄算进改动数', async () => {
    const all = AdminDish.array().parse(await adminGetJson('/api/admin/dishes'));
    const notSellable = all.find((d) => !d.sellable);
    const sellable = await pickSellable(2);
    const body = (await (await bulk([...sellable, notSellable?.uid, 'no-such-dish'], 'off')).json()) as { changed: number; skipped: number };
    expect(body.changed).toBe(2);
    expect(body.skipped).toBe(notSellable ? 2 : 1); // 不卖的 + 不存在的
  });

  it('同一个 uid 传两次只改一次，日志也只有一条', async () => {
    const [uid] = await pickSellable(1) as [string];
    const body = (await (await bulk([uid, uid, uid], 'off')).json()) as { changed: number };
    expect(body.changed).toBe(1);
    expect(changes(uid)).toHaveLength(1);
  });

  it('参数不对一律 400，而且一道菜都不许动', async () => {
    const [uid] = await pickSellable(1) as [string];
    expect((await bulk('not-an-array', 'off')).status).toBe(400);
    expect((await bulk([], 'off')).status).toBe(400);
    expect((await bulk([uid], 'half')).status).toBe(400);
    expect((await bulk([uid, 123], 'off')).status).toBe(400);
    expect((await bulk([uid, 'bad uid!'], 'off')).status).toBe(400);
    expect((await bulk(Array.from({ length: 501 }, (_, i) => `d${i}`), 'off')).status).toBe(400);
    expect(changes(uid)).toEqual([]);
  });

  it('没登录调不动（批量接口比单道菜危险，权限一模一样地卡住）', async () => {
    const [uid] = await pickSellable(1) as [string];
    const r = await req('/api/admin/dishes/bulk-state', { body: { uids: [uid], state: 'off' } });
    expect(r.status).toBe(401);
    expect(changes(uid)).toEqual([]);
  });
});
