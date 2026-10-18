// 58号 任务4 门店信息：地址 / 电话 / 营业时间 / WhatsApp，老板端编辑，顾客端只读；存在已有的 settings 表里，不改表结构
// 号码、地址都是测试假数据（全 0），不是门店真实信息
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeStoreInfo, parseHours, StoreInfo, telLink, whatsappLink } from '@pkg/contract';
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
const info = async (path = '/api/store/info') => StoreInfo.parse(await (await req(path, { admin: path.includes('admin') })).json());
const set = (body: unknown) => req('/api/admin/store-info', { body, admin: true });
const msg = async (r: Response) => String(((await r.json()) as { message?: string }).message);

beforeEach(async () => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'xc-info-'));
  api = createApp(db, resolve('brands', process.env.BRAND!), { adminPassword: PASSWORD, uploadDir: dir, clock: () => new Date('2026-10-18T04:00:00Z') }).app;
  admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('门店信息', () => {
  it('没填过时用品牌配置兜底（现在都是空），不编造', async () => {
    expect(await info()).toEqual({ address: null, phone: null, hours: null, whatsapp: null });
  });

  it('老板填了四项，顾客端拿到整理后的样子；营业时间可分段', async () => {
    const r = await set({ address: '  测试地址   1 号 ', phone: '03-0000 0000', hours: '11:00-15:00, 17:00 ~ 22:00', whatsapp: '+60 10-000 0000' });
    expect(r.status).toBe(200);
    const want = { address: '测试地址 1 号', phone: '03-0000 0000', hours: '11:00–15:00，17:00–22:00', whatsapp: '+60 10-000 0000' };
    expect(await info()).toEqual(want);
    expect(await info('/api/admin/store-info')).toEqual(want);
  });

  it('清空某一项就是不显示（不回退到「待提供」），其他项不受影响', async () => {
    await set({ address: '测试地址', phone: '03-0000 0000', hours: '17:00-02:00', whatsapp: '' });
    await set({ address: '测试地址', phone: '', hours: '17:00-02:00', whatsapp: null });
    expect(await info()).toEqual({ address: '测试地址', phone: null, hours: '17:00–02:00', whatsapp: null });
  });

  it('拦住看不懂的输入，原来的不被覆盖', async () => {
    await set({ phone: '03-0000 0000' });
    expect(await msg(await set({ phone: '打电话' }))).toContain('电话号码格式不对');
    expect(await msg(await set({ whatsapp: '010-000 0000' }))).toContain('以 + 开头');
    expect(await msg(await set({ hours: '中午到晚上' }))).toContain('看不懂');
    expect(await msg(await set({ hours: '25:00-26:00' }))).toContain('看不懂');
    expect(await msg(await set({ hours: '10:00-10:00' }))).toContain('不能相同');
    expect(await msg(await set({ hours: '1:00-2:00,3:00-4:00,5:00-6:00,7:00-8:00,9:00-10:00' }))).toContain('最多分 4 段');
    expect(await msg(await set({ address: '地'.repeat(121) }))).toContain('地址太长');
    expect(await msg(await set({ address: 12 }))).toContain('地址格式不对');
    expect((await info()).phone).toBe('03-0000 0000');
  });

  it('要先登录老板端才能改；顾客端不能写', async () => {
    const r = await api.request('/api/admin/store-info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '03-0000 0000' }) });
    expect(r.status).toBe(401);
    expect((await req('/api/store/info', { body: { phone: '03-0000 0000' } })).status).toBe(404);
    expect(await info()).toEqual({ address: null, phone: null, hours: null, whatsapp: null });
  });

  it('存在 settings 表的一个键里，不加表', async () => {
    await set({ hours: '11:00-22:00' });
    expect(db.prepare("SELECT COUNT(*) FROM settings WHERE key = 'store.info'").pluck().get()).toBe(1);
  });
});

describe('门店信息小工具', () => {
  it('营业时间补零、统一写法', () => {
    expect(parseHours('9:30-14:00；17:00—21:30')).toEqual({ ok: true, value: '09:30–14:00，17:00–21:30' });
    expect(parseHours('11:00至22:00')).toEqual({ ok: true, value: '11:00–22:00' });
  });
  it('拨号、WhatsApp 链接只留数字', () => {
    expect(telLink('03-0000 0000')).toBe('tel:0300000000');
    expect(whatsappLink('+60 10-000 0000')).toBe('https://wa.me/60100000000');
    expect(whatsappLink(null)).toBeNull();
  });
  it('全空提交就是四项都不填', () => {
    expect(normalizeStoreInfo({ address: ' ', phone: '', hours: null })).toEqual({ ok: true, value: { address: null, phone: null, hours: null, whatsapp: null } });
  });
});
