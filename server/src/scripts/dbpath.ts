import path from 'node:path';
import { readConfig } from '../config.js';

/** 数据库文件绝对路径（备份脚本用；独立小文件避免与 openDb 的循环依赖） */
export function dbPath(): string {
  const c = readConfig();
  return path.join(c.dataDir, c.dbFile);
}
