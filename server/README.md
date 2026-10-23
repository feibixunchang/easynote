# 简易笔记 · 云同步服务端

为「简易笔记」客户端提供账号注册/登录与跨设备笔记同步能力。
纯 Node.js 实现，无需数据库，数据以文件形式保存在 `data/` 目录。

## 网页版（浏览器客户端，与桌面/移动端实时同步）

服务端从 v1.2.12 起会**顺带托管一个网页版客户端**：它与桌面端、移动端是同一套代码（同一套同步引擎），
部署后浏览器打开 `http://<你的主机IP>:<PORT>/` 就是完整的「简易笔记」网页版。

- **同源同端口**：网页版由服务端在 `WEB_DIR`（默认 `server/web`，可用 `WEB_ROOT` 环境变量覆盖）下直接提供，
  不需要额外起一个 Web 服务器，**和同步接口共用同一个地址、同一个端口**。
- **同一个账户**：网页版登录的是同一个 `data/`，你在桌面端 / 移动端注册的账号直接登录即可，
  **笔记数据完全互通**——电脑上记的、手机上记的、网页版记的，三端实时互相显示。
- **零配置**：只要 `server/web/` 目录存在（Docker 镜像 / `Dockerfile` 已内置；从源码跑则把仓库根目录的
  `index.html` / `app.js` / `styles.css` 复制进 `server/web/` 即可），服务端启动后自动提供，无需任何额外设置。
- **适用场景**：临时用别人的电脑记一笔、平板 / Chromebook 等不方便装客户端的设备、或者就想在浏览器里用。

> 浏览器版会自动以「当前访问地址」作为同步服务器地址（即 `location.origin`），
> 所以你在 A 电脑的浏览器里打开 `http://nas.local:3050/` 记的笔记，会实时同步到 B 手机的 App 里。
> 网页版会自动隐藏「服务端地址」设置项（因为地址就取自当前域名）。

## 同步协议（增量）

客户端登录后每 3 秒同步一轮，走**增量协议**：

- `POST /api/notes/sync`：请求体 `{ notes: <改动过的笔记>, since: <上次同步位置> }`。
  服务端按 `modifiedDate` 后写覆盖合并，只返回 `since` 之后有变化的笔记，并带上
  `serverTime`（服务端当前时间，客户端用它校准下一轮的 `since`）和 `total`（笔记总数，
  客户端发现总数变少会触发全量恢复）。
- `GET /api/notes?since=<时间戳>`：只返回该时刻之后有变化的笔记（含删除墓碑）。
- 不带 `since` 时返回全部笔记——兼容旧客户端，也是首次同步 / 数据恢复的路径。

> 多设备时钟可能不一致：客户端拉取时会自动把 `since` 回退 5 分钟重复拉取一小段，
> 合并按修改时间判新，重复数据无副作用。

## 运行（本地开发）

```bash
cd server
npm install
npm start
# 默认监听 0.0.0.0:3000，本机与局域网设备均可访问
```

Windows 也可直接双击 `start-win.bat`。

启动后命令行会显示（列出所有可用地址，同 Wi-Fi 的设备用「局域网」地址即可）：

```
简易笔记云同步服务已启动
本机访问：http://localhost:3000
其他设备请用下面的「局域网地址」登录：
   http://192.168.1.100:3000    （局域网，同WiFi设备可直接访问）
   http://100.98.132.34:3000    （虚拟网卡/VPN 地址，通常用于跨网远程）
监听地址：0.0.0.0:3000（0.0.0.0 表示所有网卡，局域网均可访问）
```

> ⚠️ 之前 Mac 连不上，常见原因有两个：① 服务端此前只监听 `127.0.0.1`（已修复为 `0.0.0.0`）；② 地址填错了——
> 请优先填 **192.168.x.x / 10.x.x** 这种「局域网」地址，不要填 **100.x** 开头的 VPN/虚拟网卡地址（除非两台设备都装了同一 VPN）。
> 查看本机真实局域网地址：在 Windows 运行 `ipconfig`，看「以太网/WLAN」下面的「IPv4 地址」。

## Windows 与 Mac 局域网同步步骤

1. **Windows 端开启服务端**
   - 双击 `start-win.bat`，保持黑色窗口开启（最小化即可，不能关闭）。
   - 记录窗口里显示的「局域网访问」地址，例如 `http://192.168.1.5:3000`。

2. **放行防火墙**
   - Windows 首次运行时，系统会弹出「是否允许 Node.js 通过防火墙」，请选择「允许」。
   - 如果没有弹窗或 Mac 仍连不上：
     - 按 `Win + R`，输入 `wf.msc` 打开防火墙高级设置。
     - 入站规则 → 新建规则 → 端口 → TCP → 输入 `3000` → 允许连接 → 名称填「简易笔记同步服务」。
     - 或临时关闭防火墙测试（测试完请重新开启）。

3. **Mac 端连接**
   - 打开「简易笔记」→ 左侧栏「云同步」。
   - 服务端地址填 Windows 的局域网 IP，例如 `http://192.168.1.5:3000`。
   - 用户名、密码与 Windows 端注册的账号一致，点击「登录」。
   - 登录成功后，Mac 会自动拉取 Windows 上的全部笔记，并把 Mac 本地已有笔记推送到服务端。

4. **排查连不上的常见原因**
   - Windows 与 Mac 不在同一路由器/同一网段（检查 IP 前两段是否相同）。
   - Windows 防火墙拦截了 3000 端口（按上面步骤放行）。
   - 地址漏写 `http://`，或末尾多加了 `/`。
   - `start-win.bat` 黑框被关闭，导致服务端停止。

## 部署到公网（随时随地多端同步）

把 `server/` 目录上传到任意一台有公网 IP 的服务器、云主机、VPS，或家里的 NAS（配合内网穿透/端口映射），安装依赖并 `npm start`，再在客户端「云同步」里把「服务端地址」填为该服务器的公网地址（如 `https://notes.example.com`）即可。

| 环境变量 | 说明 | 示例 |
|---|---|---|
| `JWT_SECRET` | 令牌密钥，建议 32 位以上随机字符串 | `JWT_SECRET=your-long-random-string` |
| `PORT` | 监听端口 | `PORT=3000` |
| `HOST` | 监听网卡，默认 `0.0.0.0`（所有网卡） | `HOST=0.0.0.0` |
| `BODY_LIMIT` | 请求体上限，默认 `100mb`。客户端「一键修复」会把图片转成 base64 内嵌进笔记，同步时整批笔记可能达数 MB~数十 MB；若同步报 413「请求体过大」，保持默认值或调大此项即可 | `BODY_LIMIT=200mb` |

```bash
JWT_SECRET="一段足够长的随机字符串" PORT=3000 npm start
```

> ⚠️ **同步报 413「服务器返回错误 (413)」怎么办？**
> 这是请求体超过上限导致的（默认 100kb 的老版本服务端最常见）。本版已默认放到 100mb，升级方法：
> 1. 用新版 `server/server.js` 覆盖 NAS/服务器上的旧文件（数据目录 `data/` 不用动，笔记和账号都在里面）；
> 2. 重启服务（Docker：`docker compose restart`，或重新 `npm start`）；
> 3. 若服务端前面还有 Nginx 等反向代理，记得同时调大代理的请求体限制（Nginx 加 `client_max_body_size 100m;`），否则 413 会来自代理而不是 Node。

## 在飞牛 NAS 上部署（7×24 常开）

飞牛 NAS 基于 Linux，推荐用 Docker 长期稳定运行。

### 方式一：拷贝 `server/` 目录 + bind mount（最省事，适合 fnOS 共享文件夹）

把本仓库 `server/` 目录**整个**复制到一个共享文件夹（如 `/vol1/simplenote-sync/`），
然后用 `node:20-alpine` 镜像把该目录 bind mount 到容器的 `/app` 直接跑：

```yaml
# 放在 /vol1/simplenote-sync/docker-compose.yml
version: "3"
services:
  simplenote-sync:
    image: node:20-alpine
    container_name: simplenote-zh-sync
    restart: unless-stopped
    ports:
      - "3050:3050"
    environment:
      - PORT=3050
      - HOST=0.0.0.0
      - JWT_SECRET=请替换为足够长的随机字符串
    volumes:
      - ./data:/app/data        # 账户与笔记持久化（绝不可删）
    working_dir: /app
    command: ["sh", "-c", "npm install && npm start"]
```

> ⚠️ 升级到「带网页版」的服务端时：把新版的 `server/server.js` 和**整个 `server/web/` 目录**
> 一起覆盖进 `/vol1/simplenote-sync/` 即可（`data/` 不用动）。重启容器后，
> 浏览器打开 `http://<NAS局域网IP>:3050/` 就是网页版，与桌面 / 移动端同一个账户实时同步。

在 NAS 终端（或文件管理器里打开该目录的终端）执行：

```bash
docker compose up -d
```

容器会自动安装依赖并常驻运行。NAS 重启后会自动拉起。
数据保存在 `./data` 目录，备份时直接拷贝该目录即可。

### 方式二：飞牛「项目」/终端直接跑 Node

1. 在「应用中心」安装「终端」或使用 SSH。
2. 安装 Node.js（飞牛应用商店若有 Node 容器直接用；否则用 Docker 的 node:20 镜像）。
3. 把 `server/` 上传到 NAS 目录，执行：
   ```bash
   cd /path/to/server
   JWT_SECRET="随机字符串" npm start
   ```
4. 需要开机自启的话，用 Docker 方式更省心。

### 方式三：一键构建镜像（仓库自带 `Dockerfile` + `docker-compose.yml`，适合全新部署）

仓库根目录已提供自包含镜像方案：把 `Dockerfile` 与 `docker-compose.yml` 放到一个目录，
连同 `server/`、`index.html`、`app.js`、`styles.css` 一起，`docker compose up -d` 即可
自动构建 `easynote-server:latest`（内置网页版，默认端口 3050，数据用命名卷 `easynote-data` 持久化）。

```bash
# 该目录下需包含：Dockerfile、docker-compose.yml、server/、index.html、app.js、styles.css
docker compose up -d --build
```

如需迁移旧数据，把仓库 `docker-compose.yml` 里那行 `easynote-data:/app/data` 换成
`- /vol1/simplenote-sync/data:/app/data` 即可直接挂你原来的数据目录（账户与笔记原样保留）。
记得先把 `docker-compose.yml` 里的 `JWT_SECRET` 改成一段只有你知道的随机长字符串。

### 让外网能访问（三种常见做法）

- **路由器端口映射（最省事）**：在路由器把 NAS 局域网 IP 的 3000 端口映射到公网，客户端填 `http://你的公网IP:3000`。注意公网 IP 变动可用 ddns。
- **飞牛内置/第三方内网穿透**：如飞牛的远程访问或 frp、cpolar、ngrok 等，拿到一个公网域名填到客户端。
- **反向代理 + HTTPS（推荐）**：用 Nginx/Caddy 反代到 `localhost:3000`，并申请证书，客户端填 `https://notes.example.com`。这样传输加密更安全。

> 安全提示：公网部署务必设置 `JWT_SECRET`，不要用默认密钥；建议加 HTTPS 与访问控制。
