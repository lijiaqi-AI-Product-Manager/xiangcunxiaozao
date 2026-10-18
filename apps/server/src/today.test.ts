// 54号 §2.2 今日招牌：老板端配置哪几道菜上点单页顶部大画（按顺序），顾客端只读；存在已有的 settings 表里，不改表结构
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TodaySignature } from '@pkg/contract';
import { createApp } from './app.ts';
import { openDb, type DB } from './db.ts';

const PASSWORD = 'test-password-123';
let db: DB;
let dir: string;
let api: ReturnType<typeof createApp>['app'];
let admin: string;

const req = (path: string, init: { body?: unknown; admin?: boolean } = {}) =>
  api.request(path, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(init.admin ? { authorization: `Bearer ${admin}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const today = async (path = '/api/store/today') => TodaySignature.parse(await (await req(path, { admin: path.includes('admin') })).json()).dishes;
const set = (dishes: unknown) => req('/api/admin/today', { body: { dishes }, admin: true });
const msg = async (r: Response) => String(((await r.json()) as { message?: string }).message);

beforeEach(async () => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'xc-today-'));
  api = createApp(db, resolve('brands', process.env.BRAND!), { adminPassword: PASSWORD, uploadDir: dir, clock: () => new Date('2026-10-18T04:00:00Z') }).app;
  admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('今日招牌', () => {
  it('没配置时是空的（点单页顶部就只有门店框）', async () => {
    expect(await today()).toEqual([]);
  });

  it('老板设了几道，顾客端按同样顺序拿到；清空后恢复为空', async () => {
    expect((await set(['e06', 'e01', 'v01'])).status).toBe(200);
    expect(await today()).toEqual(['e06', 'e01', 'v01']);
    expect(await today('/api/admin/today')).toEqual(['e06', 'e01', 'v01']);
    await set([]);
    expect(await today()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM settings WHERE key = 'home.today'").pluck().get()).toBe(0);
  });

  it('只存菜品 ID：改价后顾客端菜单里的价格自动跟着变，不另存一份价格', async () => {
    await set(['e01']);
    await req('/api/admin/dishes/e01/price', { body: { priceSen: 5200 }, admin: true });
    const menu = (await (await req('/api/menu')).json()) as { dishes: { uid: string; priceSen: number }[] };
    expect(await today()).toEqual(['e01']);
    expect(menu.dishes.find((d) => d.uid === 'e01')!.priceSen).toBe(5200);
  });

  it('下架的菜顾客端不出现，老板端仍保留（重新上架就回来）', async () => {
    await set(['e01', 'e06']);
    await req('/api/admin/dishes/e01/state', { body: { state: 'off' }, admin: true });
    expect(await today()).toEqual(['e06']);
    expect(await today('/api/admin/today')).toEqual(['e01', 'e06']);
    await req('/api/admin/dishes/e01/state', { body: { state: 'on' }, admin: true });
    expect(await today()).toEqual(['e01', 'e06']);
  });

  it('拦住：不存在的菜、本期不卖的、重复的、超过 5 道、格式不对', async () => {
    expect(await msg(await set(['nope']))).toBe('找不到这道菜');
    const notSold = (await (await req('/api/admin/dishes', { admin: true })).json() as { uid: string; sellable: boolean }[]).find((d) => !d.sellable)!;
    expect(await msg(await set([notSold.uid]))).toContain('本期不在店内售卖');
    expect(await msg(await set(['e01', 'e01']))).toBe('今日招牌里有重复的菜');
    expect(await msg(await set(['e01', 'e02', 'e03', 'e04', 'e05', 'e06']))).toBe('今日招牌最多 5 道');
    expect((await set('e01')).status).toBe(400);
    expect(await today()).toEqual([]);
  });

  it('要先登录老板端才能改', async () => {
    const r = await api.request('/api/admin/today', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dishes: ['e01'] }) });
    expect(r.status).toBe(401);
  });
});
