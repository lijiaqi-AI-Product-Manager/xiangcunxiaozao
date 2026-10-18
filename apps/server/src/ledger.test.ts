import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupNow } from './backup.ts';
import { openDb, type DB } from './db.ts';

let db: DB;
const add = (amount: number, after: number, key: string, type = 'recharge') =>
  db.prepare(`INSERT INTO ledger_entries (member_id, type, amount_sen, balance_after_sen, operator, idempotency_key)
              VALUES ('m1', ?, ?, ?, 'test', ?)`).run(type, amount, after, key);
const balance = () => (db.prepare(`SELECT balance_sen FROM members WHERE id = 'm1'`).get() as { balance_sen: number }).balance_sen;

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare(`INSERT INTO members (id, member_no) VALUES ('m1', '0001')`).run();
});
afterEach(() => db.close());

describe('储值账本：数据库层面的硬规则', () => {
  it('充值后余额随流水同步', () => {
    add(10000, 10000, 'k1');
    add(-2500, 7500, 'k2', 'consume');
    expect(balance()).toBe(7500);
  });
  it('流水禁止修改', () => {
    add(10000, 10000, 'k1');
    expect(() => db.prepare('UPDATE ledger_entries SET amount_sen = 1').run()).toThrow(/append-only/);
  });
  it('流水禁止删除', () => {
    add(10000, 10000, 'k1');
    expect(() => db.prepare('DELETE FROM ledger_entries').run()).toThrow(/append-only/);
  });
  it('「变动后余额」算错的流水被拒绝，余额不变', () => {
    add(10000, 10000, 'k1');
    expect(() => add(-2500, 9999, 'k2', 'consume')).toThrow(/mismatch/);
    expect(balance()).toBe(10000);
  });
  it('扣成负数被拒绝，整笔回滚', () => {
    add(1000, 1000, 'k1');
    expect(() => add(-2000, -1000, 'k2', 'consume')).toThrow();
    expect(balance()).toBe(1000);
    expect(db.prepare('SELECT COUNT(*) FROM ledger_entries').pluck().get()).toBe(1);
  });
  it('同一防重码只入账一次', () => {
    add(10000, 10000, 'same');
    expect(() => add(10000, 20000, 'same')).toThrow(/UNIQUE/);
    expect(balance()).toBe(10000);
  });
  it('会员不可删除', () => {
    expect(() => db.prepare(`DELETE FROM members WHERE id = 'm1'`).run()).toThrow(/cannot be deleted/);
  });
});

describe('本地快照备份', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'backup-test-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('备份文件能打开，且包含备份前写入的流水', async () => {
    add(10000, 10000, 'k1');
    const file = await backupNow(db, dir);
    expect(existsSync(file)).toBe(true);
    const copy = openDb(file);
    expect(copy.prepare('SELECT balance_sen FROM members').pluck().get()).toBe(10000);
    copy.close();
  });
});
