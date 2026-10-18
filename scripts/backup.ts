// 手动立即备份一次：npm run backup
import { resolve } from 'node:path';
import { backupNow } from '../apps/server/src/backup.ts';
import { openDb } from '../apps/server/src/db.ts';

const dbPath = process.env.DB_PATH;
const dir = process.env.BACKUP_DIR;
if (!dbPath || !dir) throw new Error('缺少 DB_PATH 或 BACKUP_DIR（见根目录 .env）');
const db = openDb(resolve(dbPath));
console.log(`备份完成：${await backupNow(db, resolve(dir))}`);
db.close();
