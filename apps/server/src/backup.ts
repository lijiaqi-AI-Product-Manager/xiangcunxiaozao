import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.ts';

/**
 * 本地快照备份：用 SQLite 官方在线备份接口拷一份完整数据库，营业中也能安全执行。
 * 这是「服务器和对象存储定下来之前」的兜底；正式环境由 Litestream 实时复制（deploy/litestream.yml）。
 */
export async function backupNow(db: DB, dir: string, keep = 144): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `snapshot-${stamp}.db`);
  await db.backup(file);
  const snapshots = readdirSync(dir).filter((f) => f.startsWith('snapshot-') && f.endsWith('.db')).sort();
  for (const old of snapshots.slice(0, Math.max(0, snapshots.length - keep))) rmSync(join(dir, old));
  return file;
}

export function scheduleBackups(db: DB, dir: string, everyMinutes: number, log: (msg: string) => void) {
  const run = () =>
    backupNow(db, dir)
      .then((f) => log(`备份完成：${f}`))
      .catch((e: unknown) => log(`备份失败：${e instanceof Error ? e.message : String(e)}`));
  void run();
  return setInterval(run, everyMinutes * 60_000);
}
