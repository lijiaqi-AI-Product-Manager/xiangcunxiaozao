# 湘村小灶点单系统

马来西亚吉隆坡湖南菜馆的扫码点单系统：顾客手机点餐 → 后厨实时接单 → 老板后台对账。

## 技术栈

- **后端**：Node.js 24 + Express + SQLite（better-sqlite3）+ TypeScript
- **前端**：纯静态页（顾客点单 / 后厨接单 / 老板后台），由后端直接托管
- **部署**：Docker 单容器，数据落 `/data` 持久卷，Zeabur Compute（腾讯新加坡 2C2G）

## 财务红线（改代码前必读）

1. 金额**一律整数分**（sen），任何浮点运算进 `utils/money.ts` 之外的金额代码都是 bug
2. 订单创建在**单事务**内完成，订单+明细要么都在要么都不在
3. 下单金额**服务端按数据库现价计算**，前端传的总价一律不信任
4. `order_items` 冗余菜品名和单价快照——改价不影响历史账
5. 订单号 = 吉隆坡日期 + 当日流水（`20261012-0007`），事务内原子自增
6. `client_id` 幂等去重，断网重试不会重复下单
7. 测试不过不准部署：`cd server && npm test`

## 目录结构

```
├── Dockerfile            # 生产镜像（构建 TS + 托管 web/）
├── web/                  # 前端静态页（占位页，D3 起替换为点单应用）
├── server/
│   ├── src/
│   │   ├── index.ts      # 入口：启动/优雅退出/备份调度
│   │   ├── app.ts        # Express 组装（依赖注入）
│   │   ├── db.ts         # SQLite 连接与建表
│   │   ├── config.ts     # 环境变量读取与启动校验
│   │   ├── routes/       # dishes / orders / reports / health
│   │   ├── services/     # orders.ts 订单核心逻辑（事务/幂等/状态机）
│   │   ├── middleware/   # 鉴权 / 限流 / 日志 / 错误
│   │   ├── utils/        # money(金额) / time(KL时区) / orderNo(流水号)
│   │   └── scripts/      # backup(每日GitHub备份) / seed(冒烟数据)
│   └── tests/            # 财务单测：金额精度/并发/幂等/快照/持久性
└── docs/                 # 部署与运维手册
```

## 本地开发

```bash
cd server
npm install
ADMIN_TOKEN=dev-admin-token-123456 KITCHEN_TOKEN=dev-kitchen-token-123456 npm run dev
# → http://localhost:3000/healthz
npm test        # 财务单测全绿才能部署
```

## 环境变量

见 `.env.example`。生产必填：`ADMIN_TOKEN`、`KITCHEN_TOKEN`（≥16位随机串）。
可选：`BACKUP_GITHUB_TOKEN` + `BACKUP_GITHUB_REPO` 开启每日自动备份（吉隆坡 03:30）。

## API 一览（v0.1）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /healthz | 公开 | 健康检查 |
| GET | /api/dishes | 公开 | 在售菜单 |
| GET | /api/dishes/all | admin | 全量菜品 |
| POST | /api/dishes | admin | 新增菜品 |
| PUT | /api/dishes/:id | admin | 改名/改价/改描述/排序 |
| POST | /api/dishes/:id/toggle | admin | 上下架 |
| POST | /api/orders | 公开 | 下单（幂等） |
| GET | /api/orders/:orderNo | 公开 | 查单状态 |
| GET | /api/orders | admin/kitchen | 订单列表（默认今天） |
| POST | /api/orders/:orderNo/confirm | kitchen | 后厨确认接单 |
| POST | /api/orders/:orderNo/serve | kitchen | 上桌 |
| POST | /api/orders/:orderNo/cancel | admin | 取消（仅待接单，需原因） |
| GET | /api/reports/daily | admin | 日报 |
