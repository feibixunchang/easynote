# 简易笔记 · 云同步服务端

为「简易笔记」客户端提供账号注册/登录与跨设备笔记同步能力。
纯 Node.js 实现，无需数据库，数据以文件形式保存在 `data/` 目录。

## 运行（本地开发）

```bash
cd server
npm install
npm start
# 默认监听 http://localhost:3000
```

Windows 也可直接双击 `start-win.bat`。

## 部署（让多台设备真正跨端同步）

把 `server/` 目录上传到任意一台有公网 IP 的服务器（或云函数/容器），安装依赖并 `npm start`，
再在客户端「云同步」里把「服务端地址」填为该服务器的公网地址（如 `https://notes.example.com`）即可。

生产环境务必设置环境变量 `JWT_SECRET`（令牌密钥）与 `PORT`（端口）：

```bash
JWT_SECRET="一段足够长的随机字符串" PORT=3000 npm start
```

## 接口说明

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/register` | 注册 `{username,password}` → 返回 `{token,username}` |
| POST | `/api/login` | 登录 `{username,password}` → 返回 `{token,username}` |
| GET  | `/api/notes` | 拉取当前用户全部笔记（需 `Authorization: Bearer <token>`） |
| POST | `/api/notes/sync` | 推送并合并笔记，返回完整集合（冲突按 `modifiedDate` 后写覆盖） |

> 客户端采用「本地优先」策略：无论是否登录、服务端是否在线，都能正常记录笔记；
> 登录后编辑会自动同步，离线时本地保留，联网后自动补传。
