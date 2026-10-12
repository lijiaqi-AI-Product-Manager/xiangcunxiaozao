import path from 'node:path';

export interface BackupConfig {
  githubToken: string;
  githubRepo: string; // owner/repo
  keep: number;
}

export interface Config {
  env: string;
  port: number;
  dataDir: string;
  dbFile: string;
  webDir: string;
  adminToken: string;
  kitchenToken: string;
  backup: BackupConfig;
}

const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/** 每次启动读取环境变量（业务代码通过依赖注入拿值，不直接读 env） */
export function readConfig(): Config {
  return {
    env: process.env.NODE_ENV ?? 'development',
    port: num(process.env.PORT, 3000),
    dataDir: process.env.DATA_DIR ?? path.join(process.cwd(), 'data'),
    dbFile: process.env.DB_FILE ?? 'xcz.db',
    webDir: process.env.WEB_DIR ?? path.join(process.cwd(), 'web'),
    adminToken: process.env.ADMIN_TOKEN ?? '',
    kitchenToken: process.env.KITCHEN_TOKEN ?? '',
    backup: {
      githubToken: process.env.BACKUP_GITHUB_TOKEN ?? '',
      githubRepo: process.env.BACKUP_GITHUB_REPO ?? '',
      keep: num(process.env.BACKUP_KEEP, 14),
    },
  };
}

/** 启动前硬校验：缺了直接拒启，防止裸奔上线 */
export function assertConfig(c: Config): void {
  const missing: string[] = [];
  if (c.adminToken.length < 16) missing.push('ADMIN_TOKEN（至少16位随机串）');
  if (c.kitchenToken.length < 16) missing.push('KITCHEN_TOKEN（至少16位随机串）');
  if (missing.length > 0) {
    throw new Error(
      `配置不完整，拒绝启动：${missing.join('、')}。请在 Zeabur 服务的环境变量中设置后重启。`
    );
  }
}
