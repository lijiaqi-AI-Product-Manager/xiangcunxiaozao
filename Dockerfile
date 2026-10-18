# 正式部署（Zeabur / 任意能跑 Docker 的服务器）：一个容器 = 后端接口 + 顾客端（/）+ 老板端（/admin/）
# 数据库、上传图、备份都在 /data（Zeabur 上要挂一个持久化硬盘到 /data，否则重新部署会丢数据）
# 必须在平台上设置的环境变量：ADMIN_PASSWORD（老板端密码，至少 8 位，只在平台后台填，不进代码）
FROM node:22-bookworm-slim
WORKDIR /srv/app

COPY package.json package-lock.json ./
COPY apps/customer/package.json apps/customer/
COPY apps/admin/package.json apps/admin/
COPY apps/server/package.json apps/server/
COPY packages/contract/package.json packages/contract/
COPY packages/ui-kit/package.json packages/ui-kit/
RUN npm ci --no-audit --no-fund

COPY . .
ENV BRAND=xiangcun
RUN npm run build -w @app/customer && ADMIN_BASE=/admin/ npm run build -w @app/admin

ENV NODE_ENV=production \
    SERVE_STATIC=1 \
    API_PORT=8080 \
    DB_PATH=/data/app.db \
    UPLOAD_DIR=/data/uploads \
    BACKUP_DIR=/data/backups \
    BACKUP_EVERY_MINUTES=10
EXPOSE 8080
CMD ["npx", "tsx", "apps/server/src/main.ts"]
