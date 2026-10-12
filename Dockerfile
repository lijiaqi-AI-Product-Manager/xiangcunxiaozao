# 湘村小灶点单系统 —— 生产镜像
# 构建：docker build -t xcz .（在仓库根目录执行）

# ---------- 构建阶段：编译 TypeScript ----------
FROM node:24-slim AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
COPY server/tests ./tests
RUN npm run build && npm prune --omit=dev

# ---------- 运行阶段：最小化生产镜像 ----------
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist/src ./server/dist/src
COPY server/package.json ./server/
COPY web ./web

# SQLite 数据库与上传图片都落在 /data，Zeabur 上把持久卷挂到这个路径
ENV DATA_DIR=/data
# Zeabur 网络端口配置为 8080，容器监听对齐（本地开发不受影响：无env时默认3000）
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/dist/src/index.js"]
