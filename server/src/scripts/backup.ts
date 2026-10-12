import fs from 'node:fs';
import type { DB } from '../db.js';
import { readConfig } from '../config.js';
import { dbPath } from './dbpath.js';

/**
 * 每日自动备份：VACUUM INTO 出一致性快照 → base64 推到 GitHub 私有仓（Contents API）。
 * - 不依赖容器里有 git
 * - 只保留最近 N 份，自动清理
 * - 备份时间：每天吉隆坡 03:30（打烊后、日切前）
 */

async function gh<T>(api: string, init?: RequestInit): Promise<T> {
  const cfg = readConfig().backup;
  const res = await fetch(`https://api.github.com${api}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'xcz-backup',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function backupNow(db: DB): Promise<string> {
  const cfg = readConfig().backup;
  if (!cfg.githubToken || !cfg.githubRepo) throw new Error('未配置备份仓库');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = `${dbPath()}.bak-${stamp}`;
  db.prepare('VACUUM INTO ?').run(tmp);
  const content = fs.readFileSync(tmp).toString('base64');
  fs.unlinkSync(tmp);

  const path = `backups/${stamp}.db`;
  await gh(`/repos/${cfg.githubRepo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message: `backup ${stamp}`, content }),
  });

  // 只保留最近 N 份
  const files = await gh<{ name: string; sha: string }[]>(
    `/repos/${cfg.githubRepo}/contents/backups`
  );
  const sorted = files
    .filter((f) => f.name.endsWith('.db'))
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const f of sorted.slice(cfg.keep)) {
    await gh(`/repos/${cfg.githubRepo}/contents/backups/${f.name}`, {
      method: 'DELETE',
      body: JSON.stringify({ message: `prune ${f.name}`, sha: f.sha }),
    });
  }
  return path;
}

export function startBackupScheduler(db: DB): void {
  const cfg = readConfig().backup;
  if (!cfg.githubToken || !cfg.githubRepo) {
    console.log(JSON.stringify({ t: new Date().toISOString(), msg: '未配置备份仓库，自动备份关闭' }));
    return;
  }
  const run = async () => {
    try {
      const p = await backupNow(db);
      console.log(JSON.stringify({ t: new Date().toISOString(), msg: `备份成功 → ${p}` }));
    } catch (e) {
      console.error(
        JSON.stringify({ t: new Date().toISOString(), msg: '备份失败', err: String(e) })
      );
    }
  };
  const scheduleNext = () => {
    // 吉隆坡 03:30 = UTC 19:30（马来西亚无夏令时，固定换算）
    const now = new Date();
    const next = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 19, 30, 0)
    );
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      await run();
      scheduleNext();
    }, next.getTime() - now.getTime()).unref?.();
  };
  scheduleNext();
  console.log(JSON.stringify({ t: new Date().toISOString(), msg: '自动备份已开启（每日吉隆坡03:30）' }));
}
