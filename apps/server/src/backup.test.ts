// 备份保留策略：这是「误操作之后唯一能回滚的东西」，却一直没有任何测试。
// 它删文件——一旦删错，老板想回滚上周五的价格就回不去了。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneSnapshots } from './backup.ts';

const MY = 'Asia/Kuala_Lumpur';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

/** 建一个临时备份目录，按给定的 ISO 时刻造假快照文件（内容无所谓，只看文件名） */
function makeDir(stamps: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'xc-backup-'));
  dirs.push(dir);
  for (const s of stamps) {
    writeFileSync(join(dir, `snapshot-${s.replace(/[:.]/g, '-')}.db`), 'x');
  }
  return dir;
}

/** 造一个「距现在 n 小时前」的时间戳字符串（保留毫秒和 Z，跟真实文件名一致） */
function hoursAgo(n: number, base = Date.now()): string {
  return new Date(base - n * 3600_000).toISOString();
}

describe('备份保留策略', () => {
  it('近 24 小时的一份都不删', () => {
    const stamps = [0.2, 1, 5, 12, 23.5].map((h) => hoursAgo(h));
    const dir = makeDir(stamps);
    expect(pruneSnapshots(dir, MY)).toBe(0);
  });

  it('近 7 天每小时只留最新一份', () => {
    // 同一小时里的三份，留最新；跨三小时共 9 份 → 只剩 3 份
    const base = Date.now();
    const stamps: string[] = [];
    for (const h of [30, 30 + 1 / 60, 30 + 2 / 60]) stamps.push(hoursAgo(h, base)); // 30 小时前那一小时内 3 份
    for (const h of [60, 60 + 1 / 60]) stamps.push(hoursAgo(h, base));
    for (const h of [100, 100 + 1 / 60]) stamps.push(hoursAgo(h, base));
    const dir = makeDir(stamps);
    const removed = pruneSnapshots(dir, MY);
    expect(removed).toBe(4); // 8 份 → 4 份
  });

  it('超过 30 天的全删', () => {
    const dir = makeDir([hoursAgo(24 * 45), hoursAgo(24 * 60)]);
    expect(pruneSnapshots(dir, MY)).toBe(2);
  });

  it('「一天」按门店时区算：按 UTC 会多留一份，按吉隆坡只留最新一份', () => {
    // 造两份都落在「8~30 天档」里的快照，它们在 UTC 下是两天、在吉隆坡是同一天。
    // 吉隆坡 = UTC+8：UTC 10-19 16:30 → 吉隆坡 10-20 00:30；UTC 10-20 15:30 → 吉隆坡 10-20 23:30。
    // 这两份在库里都属于吉隆坡的 10-20（同一天），第三档只该留最新那份。
    const late = '2026-10-20T15:30:00.000Z';  // 吉隆坡 10-20 23:30
    const early = '2026-10-19T16:30:00.000Z'; // 吉隆坡 10-20 00:30
    const fakeNow = Date.parse('2026-11-05T00:00:00.000Z'); // 都过了 15 天左右，落在 8~30 天档

    const dir = makeDir([late, early]);
    // 按吉隆坡分日：同一天 → 只留 1 份
    expect(pruneSnapshots(dir, MY, fakeNow)).toBe(1);

    const dir2 = makeDir([late, early]);
    // 按 UTC 分日：被当成两天 → 两份都留（这就是修复前的行为，会多留无用的快照）
    expect(pruneSnapshots(dir2, 'UTC', fakeNow)).toBe(0);
  });

  it('时间解析失败的文件不参与清理，也不被误删', () => {
    const dir = makeDir([hoursAgo(24 * 40)]);
    writeFileSync(join(dir, 'snapshot-不是时间戳.db'), 'x');
    writeFileSync(join(dir, '别的东西.txt'), 'x');
    const removed = pruneSnapshots(dir, MY);
    expect(removed).toBe(1); // 只有那份过期的被删
    // 认不出的文件保持原样（它们不是本程序写的，可能是老板手动放的）
    expect(() => pruneSnapshots(dir, MY)).not.toThrow();
  });

  it('目录为空 / 不存在都不报错', () => {
    expect(pruneSnapshots('/tmp/这个目录不存在-xc', MY)).toBe(0);
    expect(pruneSnapshots(makeDir([]), MY)).toBe(0);
  });
});
