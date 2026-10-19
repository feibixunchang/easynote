# 简易笔记 · 服务端 + 网页版 一体镜像
# 同一容器同时提供：REST 同步 API（/api/*）+ 浏览器版客户端（同源 / 静态托管）
FROM node:20-alpine

WORKDIR /app

# 先装依赖（利用 Docker 层缓存，改代码不会重装 npm 包）
COPY server/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# 服务端代码
COPY server/ ./

# 浏览器版 UI：复用桌面端 web 代码（index.html / app.js / styles.css）
COPY index.html app.js styles.css ./web/

ENV PORT=3050
ENV JWT_SECRET=change-me-to-a-random-long-string
ENV BODY_LIMIT=100mb

EXPOSE 3050

# 数据持久化目录：容器外挂卷到 /app/data 即可保留账户与笔记
VOLUME ["/app/data"]

CMD ["node", "server.js"]
