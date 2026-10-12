# Zeabur 部署手册（高斯专用，明早按此操作）

> 前提：代码已由 08 号推送到你的 GitHub 私有仓库 `xiangcunxiaozao`。
> 全程约 10 分钟。任何一步和手册对不上，截图发我。

## 第一步：创建项目并部署服务（约4分钟）

1. 打开 [zeabur.com](https://zeabur.com)，登录
2. 左侧点 **Servers** → 点你的服务器 **Tencent Singapore 2C 2GB**
3. 点上方 **Projects** 选项卡 → **Create Project**（或在项目列表里 New Project）
4. 项目名填 `xiangcunxiaozao` → 确认创建
5. 进入项目 → **Add Service**（或 Create Service）→ 选 **Git / GitHub**
6. 首次会要求授权：点 **Configure GitHub** → 勾选 `xiangcunxiaozao` 仓库 → Save
7. 回到 Zeabur，选中 `xiangcunxiaozao` 仓库 → 确认
8. 部署目标如果让你选，选**你的腾讯新加坡服务器**（不要选 Serverless）
9. Zeabur 会自动构建（拉代码 → docker build → 跑起来），状态从 Deploying 变 **Running** 即成功

## 第二步：挂持久卷（防止重启丢数据，约2分钟）

1. 进入服务详情 → **Volumes**（存储/卷）选项卡
2. **Add Volume / Mount Volume**
3. 挂载路径填：`/data`
4. 保存。如服务重启属正常现象

## 第三步：配环境变量（约2分钟）

进入服务 → **Variables / Environment Variables**，逐条添加（值由 08 号单独发你，勿外传）：

| 变量名 | 说明 |
|---|---|
| ADMIN_TOKEN | 老板后台令牌 |
| KITCHEN_TOKEN | 后厨接单页令牌 |
| BACKUP_GITHUB_TOKEN | 每日备份用（08 号配好再填） |
| BACKUP_GITHUB_REPO | 备份仓库名（08 号配好再填） |

保存后服务会自动重启，此时数据卷已挂好，重启不丢数据。

## 第四步：绑定域名（部署成功后做，约3分钟）

1. 服务详情 → **Networking / Domains** 选项卡
2. **Add Domain** → 选 **Custom Domain** → 输入 `xiangcunxiaozao.com`
3. Zeabur 会显示一条 **CNAME 记录值**（形如 `xxx.zeabur.app` 或 A 记录 IP）——截图发 08 号，由 08 号给出你在域名注册商处的解析步骤
4. 同时给后厨页加一个内部域名或直接用 Zeabur 默认域名

## 验收标准（D1 完成 definition）

- [ ] `https://xiangcunxiaozao.com` 打开看到湘村小灶品牌页
- [ ] `/healthz` 返回 `{"ok":true,...}`
- [ ] 重启服务后访问 `/healthz` 依然正常（数据卷生效）
- [ ] 服务日志里没有红色报错
