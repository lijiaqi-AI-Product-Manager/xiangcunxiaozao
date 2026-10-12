import { readConfig, assertConfig } from './config.js';
import { openDb, } from './db.js';
import { buildApp } from './app.js';
import { startBackupScheduler } from './scripts/backup.js';

function main(): void {
  const config = readConfig();
  assertConfig(config); // 缺令牌直接拒启，防止裸奔上线

  const db = openDb();
  const app = buildApp({ db, adminToken: config.adminToken, kitchenToken: config.kitchenToken });

  const server = app.listen(config.port, () => {
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        msg: `湘村小灶后端已启动 :${config.port}（${config.env}）`,
        dataDir: config.dataDir,
      })
    );
  });

  // 每日自动备份（未配置 GitHub 备份仓则自动跳过）
  startBackupScheduler(db);

  // 优雅退出：Zeabur 重新部署/重启容器时先落盘再退
  const shutdown = (sig: string) => {
    console.log(JSON.stringify({ t: new Date().toISOString(), msg: `收到${sig}，正在安全关闭` }));
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
