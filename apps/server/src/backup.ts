import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.ts';

/**
 * 本地快照备份：用 SQLite 官方在线备份接口拷一份完整数据库，营业中也能安全执行。
 * 这是「服务器和对象存储定下来之前」的兜底；正式环境由 Litestream 实时复制（deploy/litestream.yml）。
 *
 * 保留策略是分层的（见 pruneSnapshots）：只留 24 小时的话，周一发现「上周五改错了一个价格」就回不去了。
 */
export async function backupNow(db: DB, dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const stamp = stampOf(new Date());
  const file = join(dir, `snapshot-${stamp}.db`);
  await db.backup(file);
  return file;
}

const stampOf = (d: Date) => d.toISOString().replace(/[:.]/g, '-');

/** 返回一个「把时刻换算成门店日期字符串」的函数。用 sv-SE 是因为它固定输出 YYYY-MM-DD，不用自己拼。 */
function dayKeyFn(timeZone: string): (d: Date) => string {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (d: Date) => fmt.format(d);
}

/** 从文件名里取回时间；取不到就返回 null（不是本程序写的文件，不参与清理） */
function timeOf(file: string): Date | null {
  const m = file.match(/^snapshot-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z\.db$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

/**
 * 分层保留：最近 24 小时每 10 分钟一份、最近 7 天每小时一份、最近 30 天每天一份。
 * 其余删掉。快照很小（180 KB 量级），三档合计约 60 MB，换来「一个月内任何一天都能回滚」。
 *
 * timeZone 用来决定「一天」从哪一刻算起。必须传门店时区，不能用 UTC：
 * 吉隆坡比 UTC 快 8 小时，按 UTC 分日的话，凌晨 0~8 点打的快照会被归到「昨天」，
 * 同一天的备份被拆成两组、多删掉一组，老板回滚时也会发现「今天的备份在昨天的名字里」。
 */
export function pruneSnapshots(dir: string, timeZone = 'UTC', nowMs = Date.now()): number {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.startsWith('snapshot-') && f.endsWith('.db'));
  } catch {
    return 0;
  }
  const now = nowMs;
  const dayOf = dayKeyFn(timeZone);
  const ranked = names
    .map((name) => ({ name, at: timeOf(name) }))
    .filter((x): x is { name: string; at: Date } => x.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime()); // 新的在前

  const keepSet = new Set<string>();
  const hourTaken = new Set<string>();
  const dayTaken = new Set<string>();
  for (const { name, at } of ranked) {
    const ageH = (now - at.getTime()) / 3600000;
    if (ageH <= 24) { keepSet.add(name); continue; }   // 第一档：近 24 小时全留（约 144 份）
    if (ageH <= 24 * 7) {
      const bucket = `h${Math.floor(at.getTime() / 3600000)}`; // 第二档：近 7 天每小时留最新一份
      if (!hourTaken.has(bucket)) { hourTaken.add(bucket); keepSet.add(name); }
      continue;
    }
    if (ageH <= 24 * 30) {
      const bucket = dayOf(at);                                // 第三档：近 30 天每天留最新一份（按门店时区）
      if (!dayTaken.has(bucket)) { dayTaken.add(bucket); keepSet.add(name); }
    }
  }
  // 兜底：目录里明明有 snapshot-*.db，却一份的时间都解析不出来——说明命名规则变了或被改过。
  // 这时候保一份，别把老板仅有的备份清空。
  if (ranked.length === 0 && names.length > 0) keepSet.add([...names].sort().at(-1)!);

  let removed = 0;
  // 只删「时间确认已经过期」的文件。解析不出时间的（旧版本格式、老板手动拷进来的）
  // 一律不动——宁可多占几百 KB，也不能把可能是唯一一份备份的文件删掉。
  for (const { name } of ranked) {
    if (keepSet.has(name)) continue;
    try { rmSync(join(dir, name)); removed += 1; } catch { /* 删不掉就算了，下次再删 */ }
  }
  return removed;
}

/** 等价的旧行为（只按份数留），保留给需要固定份数的场景 */
export function pruneByCount(dir: string, keep: number): number {
  const names = readdirSync(dir).filter((f) => f.startsWith('snapshot-') && f.endsWith('.db')).sort();
  let removed = 0;
  for (const old of names.slice(0, Math.max(0, names.length - keep))) {
    rmSync(join(dir, old));
    removed += 1;
  }
  return removed;
}

export function scheduleBackups(db: DB, dir: string, everyMinutes: number, log: (msg: string) => void, timeZone = 'UTC') {
  const run = async () => {
    try {
      const file = await backupNow(db, dir);
      const removed = pruneSnapshots(dir, timeZone);
      log(`备份完成：${file}${removed ? `（清理旧快照 ${removed} 份）` : ''}`);
    } catch (e: unknown) {
      log(`备份失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  void run();
  return setInterval(() => { void run(); }, everyMinutes * 60_000);
}

/** 备份目录当前占用（老板端「打印设置」旁边的运维信息用得到） */
export function backupStats(dir: string): { count: number; bytes: number; oldest: string | null; newest: string | null } {
  try {
    const names = readdirSync(dir).filter((f) => f.startsWith('snapshot-') && f.endsWith('.db')).sort();
    let bytes = 0;
    for (const n of names) { try { bytes += statSync(join(dir, n)).size; } catch { /* 跳过 */ } }
    return { count: names.length, bytes, oldest: names[0] ?? null, newest: names[names.length - 1] ?? null };
  } catch {
    return { count: 0, bytes: 0, oldest: null, newest: null };
  }
}
