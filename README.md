# 餐厅点单系统

一套代码，换一份「店铺配置」就能给另一家餐厅用。当前配置：`brands/` 下的第一家店（由根目录 `.env` 的 `BRAND` 指定）。

顾客扫桌上二维码点单 → 老板端实时收单、出餐 → 会员储值、对账、数据看板。后端一个 Node 进程，数据库是一个 SQLite 文件。

## 现状（2026-10-18）

- 代码全部在 `main`（标签 `p5-closeout`）；**还没上生产**——服务器、域名、对象存储待定。
- 会员体系新功能（等级 / 成长值 / 权益）挂起；前端视觉冻结，未决项见 `docs/交接/前端冻结清单.md`。

## 先读这几份

| 文档 | 写给谁 |
| --- | --- |
| [`docs/交接/系统架构一页纸.md`](docs/交接/系统架构一页纸.md) | 想快速看懂系统的人：模块图、接口清单、技术栈、已知限制 |
| [`docs/交接/部署与回滚手册.md`](docs/交接/部署与回滚手册.md) | 部署 / 运维的人：现状架构、部署步骤、验证清单、回滚、常见故障 |
| [`docs/交接/老板使用手册.md`](docs/交接/老板使用手册.md) | 老板：今日招牌、菜品、看板、门店信息、会员怎么用 |
| [`docs/交接/前端冻结清单.md`](docs/交接/前端冻结清单.md) | 解冻时：所有未决的前端项 |

## 目录（每个文件夹是干什么的）

| 文件夹 | 用途 |
| --- | --- |
| `apps/customer` | 顾客端：手机扫桌码点单 |
| `apps/admin` | 老板端：订单、菜品、会员、看板、门店信息 |
| `apps/server` | 后端：收订单、管账本、存数据库 |
| `packages/contract` | 数据契约：菜品/订单/账本的格式规矩，前后端共用 |
| `packages/ui-kit` | 公共零件：菜品图占位、请求出错提示、店铺配置注入 |
| `brands/<店>/` | 一家店的全部信息：店名、配色、菜单、问答、字体、原始文档 |
| `scripts/` | 导入菜单、数据校验、产品化 / 色彩检查、字体裁剪、图片压缩、备份、演示版导出 |
| `e2e/` | 真浏览器端到端测试（独立测试数据库），同时产出验收截图 |
| `deploy/` | 上线用的配置（Litestream 实时备份模板） |

## 常用命令

```bash
npm ci
```

```bash
npm run check
```

```bash
npm run dev:server
```

```bash
npm run dev:customer
```

```bash
npm run dev:admin
```

```bash
npm run e2e
```

```bash
npm run build:demo
```

- `npm ci`：严格按 `package-lock.json` 安装（和测试时版本完全一致）；改依赖时才用 `npm install`
- `check`：依赖安全审计（中危及以上不过）+ 产品化检查（代码里不许有店名、不许散写色值、时间走门店时区）+ 色彩检查 + 数据校验 + 类型检查 + 单元测试
- `e2e`：用真浏览器把点单闭环走一遍（独立测试数据库），每步截图存进 `docs/screenshots/`
- `build:demo`：把顾客端导出成不连数据库的演示版静态网页（`apps/customer/dist-demo/`）
- `import:menu`：把 `brands/<店>/source/` 里的原始文档转成 `menu.json` / `faq.json`，并生成校验报告 `reports/validation.md`
- 顾客端 http://localhost:5173/?table=12（`table` 是桌号，正式环境由桌上二维码带入），老板端 http://localhost:5174

## 环境说明

- 第一次使用：把 `.env.example` 复制成 `.env`，填上 `ADMIN_PASSWORD`（老板端密码，至少 8 位）。`.env` 不进 git。
- 需要 Node.js 22 以上。
- npm 11 默认拦截安装脚本，本项目已在 `package.json` 的 `allowScripts` 里放行 esbuild 和 better-sqlite3 两个包。
- 内部包用路径别名引用（不依赖 npm 的软链接），在虚拟化的 Windows 目录里也能运行。
- 改动走 GitHub 私有仓库的 PR（推送后生效），`main` 只通过合并更新。
