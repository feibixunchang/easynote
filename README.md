# 简易笔记（Simplenote 风格 · 中文版）

一个高度还原 [Simplenote](https://simplenote.com/) 界面与交互的**纯中文**笔记软件，Windows 端优先。数据保存在本机浏览器（localStorage），无需账号、无需联网。

## 功能

- **三栏布局**：左侧标签/搜索/回收站，中间笔记列表，右侧编辑器
- **全中文界面与字体**：PingFang SC / 微软雅黑 等中文优先字体
- **即时搜索**：按标题、正文、标签过滤
- **标签**：在正文中使用 `#标签` 语法自动归类，侧栏展示
- **置顶**：把重要笔记固定在列表顶部
- **Markdown**：工具栏 M↓ 开启，👁 实时预览
- **回收站**：软删除、可恢复、可永久删除
- **深色模式**：侧栏一键切换，记忆偏好
- **字体自定义**：「设置」中可选择系统已安装字体显示（Electron 下自动枚举 Windows 已装字体；浏览器下提供常用中文字体清单 + 自定义输入），并可选字号（小/中/大/特大）
- **排序**：按修改时间 / 创建时间 / 标题
- **导入 / 导出**：JSON 备份，便于迁移
- **快捷键**：`Ctrl/Cmd + N` 新建笔记，`Esc` 关闭弹窗
- **云同步账号**：侧栏「☁ 云同步」可注册/登录，笔记在你的多台设备间自动同步。采用本地优先策略——不登录、服务端离线都能正常记录，联网后自动补传；冲突按修改时间后写覆盖

## 使用方式

### 方式一：直接打开（最简单）
双击 `index.html`，用任意浏览器打开即可使用（Windows 上等价于本地软件）。

### 方式二：打包为桌面程序（Windows / macOS / Linux）
需要 [Node.js](https://nodejs.org/) 20+：

```bash
cd easynote
npm install                 # 安装 electron 与 electron-builder
npm start                  # 以桌面窗口方式运行
npm run dist:win           # 打包 Windows 安装包（nsis，输出 dist/ 下 .exe）
npm run dist:mac           # 打包 macOS 安装包（dmg）
npm run dist:linux         # 打包 Linux 安装包（AppImage + deb）
```

> 跨平台说明：在 Windows 上只能打包 Windows 安装包；macOS / Linux 安装包需在对应系统上执行上述命令，
> 或在仓库中打一个 `v*` 标签触发 `.github/workflows/build.yml`（GitHub Actions）自动并行产出三端安装包。

### 方式三：开启云同步（多设备）
云同步需要一个后端服务（`server/` 目录，纯 Node.js，无需数据库）：

```bash
cd server
npm install
npm start                  # 默认监听 http://localhost:3000
```

然后在客户端的「☁ 云同步」里填写服务端地址（默认 `http://localhost:3000`），注册/登录后，笔记即自动同步。
想让多台不同网络的设备同步，把 `server/` 部署到一台有公网 IP 的服务器，并把客户端地址改为该公网地址即可。

## 文件结构

| 文件 | 说明 |
| --- | --- |
| `index.html` | 应用结构 |
| `styles.css` | Simplenote 风格样式 + 深色模式 |
| `app.js` | 全部业务逻辑、本地持久化、账号与同步 |
| `main.js` | Electron 主进程（外壳，含系统字体枚举） |
| `preload.js` | Electron 预加载脚本（向渲染进程暴露字体枚举接口） |
| `package.json` | 运行 / 三端打包配置 |
| `server/` | 云同步服务端（Express + JWT + 文件存储） |
| `.github/workflows/build.yml` | GitHub Actions 三端自动打包工作流 |

## 已知范围

- v1.1 已内置**可选**的云同步账号体系（自带可自托管的服务端），默认仍是本地优先，不强制联网
- 数据保存在本机；云同步开启后同时保存在你的服务端，建议仍定期「导出备份」
- macOS / Linux 安装包无法在 Windows 机器上直接生成，请按上文方式二在对应系统或 CI 中构建
