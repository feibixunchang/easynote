# 简易笔记（Simplenote 风格 · 中文版）

一个高度还原 [Simplenote](https://simplenote.com/) 界面与交互的**纯中文**笔记软件。
提供 **Windows / macOS / Linux** 三端桌面版（Electron），**iOS / Android** 移动端（Capacitor），
也可直接在浏览器里打开 `index.html` 使用。
本地优先：数据默认保存在本机，无需账号、无需联网即可记录。
**五端同一账号实时同步**：电脑上记的笔记，手机上自动显示（反之亦然）。

## ✨ 功能特性

- **三栏布局**：左侧标签 / 搜索 / 回收站，中间笔记列表，右侧编辑器
- **全中文界面**，中文优先字体（PingFang SC / 微软雅黑 等）
- **即时搜索**：按标题、正文、标签过滤
- **标签**：正文用 `#标签` 语法自动归类，侧栏展示
- **置顶 / 颜色标签**：重要笔记置顶、按颜色归类
- **Markdown 预览**：工具栏 `M↓` 开启，`👁` 实时预览
- **插入图片**：`🖼` 选图后插入。默认**内嵌进笔记**（自动等比缩放到最长边 ≤1600px），换电脑 / 移动原图都不受影响；也可在「设置」里改为**引用原文件路径**（笔记更小，原图丢失时会提示）
- **外链图片一键修复**：早期版本或「引用路径」模式插入的图片只在本机可见；设置里的「一键修复」会把本机还能找到原图的引用批量转成内嵌，同步后所有设备都能显示
- **插入链接**：`🔗` 弹窗填写「链接地址 + 显示文字」，回车确认；先选中文字再插入可把选中文字变成链接，预览里点击用默认浏览器打开
- **插入文本元素**：`文` 快速插入引用块 / 代码块 / 分隔线 / 当前日期时间
- **右键粘贴修复**：右键「粘贴」经主进程读系统剪贴板，跨应用复制也能正常粘入
- **单实例**：整个系统只运行一个窗口，重复打开只聚焦已有窗口
- **托盘常驻（可配置）**：默认关闭窗口缩到托盘后台继续同步；「设置 → 关闭主窗口时」可改为**直接退出程序**（Linux 默认直接退出，因为很多发行版托盘区不显示图标）。第一次缩到托盘会弹一次系统通知说明怎么恢复
- **回收站**：软删除、可恢复、可永久删除（带墓碑，防止同步时被还原）。列表支持**勾选 + 全选**，可**批量恢复 / 批量永久删除 / 清空回收站**，侧栏显示条数徽标；每条显示"已删除几天"；删除后提示条上可直接**撤销**；可选**自动清理**（7 / 30 / 90 天，默认关闭）。移动端同样支持勾选与批量恢复 / 删除
- **历史版本**：编辑过程中自动留快照（同一笔记 10 分钟一条、最多 20 条，含内嵌大图的笔记不记录），右键或「更多」菜单打开可预览、可**一键回滚**；只存在本机，不参与云同步
- **同步诊断**：账号弹窗里点「同步诊断」，逐项检查服务端可达性、令牌有效性、待推送积压与体积、增量游标、本地存储占用，出问题直接告诉你该改哪里，报告可一键复制
- **深色模式**：一键切换 / 跟随系统，记忆偏好
- **字体与字号自定义**：「设置」里选择系统已安装字体 + 字号
- **排序**：按修改时间 / 创建时间 / 标题
- **导入 / 导出**：JSON 整库备份（导入按笔记 id 合并，重复导入不会产生重复笔记）；单条笔记可**导出为 .md 文件**，也可**直接导入 .md / .txt**（一个文件一条笔记，可多选，内容原样保留，导出再导入无损可逆）
- **近实时云同步**：登录后每 3 秒增量同步一轮，一台设备改完其他设备随即显示；离线可用，联网自动补传
- **快捷键**：`Ctrl/Cmd + N` 新建、`Ctrl/Cmd + F` 搜索、`Ctrl/Cmd + ,` 设置、`Ctrl/Cmd + A` 回收站全选、`Alt + ↑/↓` 上下条笔记、`Esc` 关弹窗 / 清空搜索；确认弹窗支持 `Esc` 取消、`Enter` 确认
- **应用内自动更新**：启动后自动检查新版，侧栏横幅点「下载」→ 多镜像自动测速选最快 → **显示下载进度百分比** → 下载完自动关掉旧客户端并安装（托盘右键菜单里也有同一入口）

## 📥 下载安装（推荐）

到 [**Releases 页面**](https://github.com/feibixunchang/easynote/releases) 下载对应平台的最新安装包：

| 平台 | 安装包 | 说明 |
| --- | --- | --- |
| 🍎 macOS（Intel + Apple 芯片通用） | `easynote-<版本>.dmg` | 打开 dmg，把「简易笔记」拖进「应用程序」 |
| 🪟 Windows | `easynote-Setup-<版本>.exe` | 双击安装向导安装 |
| 🐧 Linux | `easynote-<版本>-x86_64.AppImage` / `easynote-<版本>-amd64.deb` | AppImage 加可执行权限即可运行；deb 用 `sudo dpkg -i` 安装 |
| 🤖 Android | `easynote-mobile-v<版本>-android.apk` | 下载后用手机打开，允许「安装未知应用」即可 |
| 🍎 iOS | `easynote-mobile-v<版本>-ios-unsigned.ipa` | 未签名 IPA，需在 Mac 上重签名或侧载，见 [移动端说明](#-移动端ios--android) |

> 桌面端最新版：<https://github.com/feibixunchang/easynote/releases/latest>
> 移动端版本：<https://github.com/feibixunchang/easynote/releases>（找 `mobile-v*` 标签的 Release）

> 🐧 **Linux deb 说明**：v1.2.6 起修复了 Deepin 25 等系统上 `dpkg` 报「Invalid cross-device link」导致安装失败的问题（deb 内图标不再使用硬链接条目）；CI 每次发布前也会自检，含硬链接条目的 deb 会被拒绝发布。

### ⚠️ macOS 首次打开可能被 Gatekeeper 拦截

CI 没有苹果开发者证书，产物是 **ad-hoc 签名**。从浏览器下载后首次打开若被拦，**右键点应用图标 →「打开」→ 再点一次「打开」**即可，之后都能正常启动。
（在本机重新打包一次可完全绕开此步骤，见下文「从源码构建」。）

## 🚀 快速上手

1. 启动后点左侧「＋」或按 `Ctrl/Cmd + N` 新建笔记，直接输入即可自动保存。
2. **插入图片**：点工具栏 `🖼` → 选图片 → 再点 `👁`（预览）查看。默认**内嵌保存**（换电脑也看得到）；想省体积可在「⚙ 设置 → 插入图片方式」改为**引用原文件路径**（原图被移动 / 删除后会显示失败提示）。
3. **跨设备看不到图？**：如果图片是用「引用路径」插入的（或老版本插入的），只有存图的那台电脑能显示。打开「⚙ 设置 → 外链图片修复 → 一键修复」，会把本机还能找到原图的引用全部转成内嵌，保存并同步后其他设备即可显示（侧栏出现黄色横幅时说明检测到了外链图片）。
4. **插入链接**：点工具栏 `🔗` → 在弹窗里粘贴链接、填显示文字 → 回车 / 点「插入」→ `👁` 预览里出现可点击链接。
5. **Markdown 预览**：点工具栏 `M↓` 开启本笔记的 Markdown，再点 `👁` 预览（插入图片 / 链接时会自动帮你开启）。
6. **深色模式 / 主题 / 字体 / 图片插入方式 / WebDAV 导出**：左下角「🌙 深色模式」「⚙ 设置」。
7. **导出 / 导入备份**：左下角「⬇ 导出备份」「⬆ 导入备份」。

## 📱 移动端（iOS / Android）

`mobile/` 目录是与桌面端**功能完全一致**的 Capacitor 应用：同一套同步协议、同一个账号，
电脑和手机的笔记实时互相同步。界面与 **Simplenote iOS 一致**：主页面只有搜索栏 + 笔记列表 + 右下角新建按钮，
**笔记 / 回收站 / 设置 收纳在左侧抽屉菜单里**（点顶栏 ☰ 或从屏幕左边缘右滑拉出），不放底部 Tab 栏；
平板与折叠屏（宽 ≥720px）自动切换双栏；深色模式、安全区（刘海 / 手势条）均已适配。

- **功能对齐桌面端**：笔记 / 回收站 / 标签 / 颜色标签 / 置顶 / 搜索 / Markdown 预览 /
  插入图片（拍照 📷 / 相册 🖼，自动压缩后内嵌）/ 插入链接 / 导出备份 / 深色模式 /
  3 秒增量云同步 / 更新检查。
- **交互按手机习惯调整**：长按笔记弹出底部操作面板（置顶 / 颜色 / 回收站 / 更多），
  **删除笔记会先弹窗二次确认**（回收站里「清空回收站」同样要确认），返回键优先返回列表，
  切到后台再回来会自动同步。
- **Android**：Release 页面下载 APK 直接安装（需允许「安装未知应用」）；
  内网 HTTP 同步服务器已允许（`usesCleartextTraffic`）。
- **iOS**：云端没有苹果开发者证书，产物为**未签名 IPA**，iPhone 不能直接安装。**推荐用 Xcode 在 Mac 上签名安装**（苹果原生通道、最稳，免费 Apple ID 即可，签名 7 天有效）：
  1. 在 Mac 装好 [Xcode](https://developer.apple.com/xcode/)（App Store 约 15GB，首次启动需装组件并同意许可）；
  2. 打开 `mobile/ios/App/App.xcodeproj`；
  3. **Xcode → Settings → Accounts** 登录你的 Apple ID（免费账号会显示为「Personal Team」）；
  4. 选中 **TARGETS → App → Signing & Capabilities**，Team 选你的 Personal Team（已默认勾选「自动签名」）；
  5. iPhone 开启**开发者模式**（设置 → 隐私与安全性 → 开发者模式，需重启）并信任本 Mac；
  6. 顶部设备选你的 iPhone，按 `⌘ R` 运行；装好后到 **设置 → 通用 → VPN 与设备管理** 信任开发者即可打开。
  - 免费签名 **7 天有效**，到期重连 Mac 再 `⌘ R` 一次即可续签。
  - 完整截图级步骤见 **[xcode-tutorial.html](./xcode-tutorial.html)**。
  - 不想装 Xcode 的备选：**AltStore / Sideloadly 侧载**——下载 Release 里的 `easynote-mobile-v*-ios-unsigned.ipa` 用工具导入并签名（详见 [sideloadly-tutorial.html](./sideloadly-tutorial.html)，注意 2FA 需用应用专用密码）。

> 移动端版本号独立计数：桌面端 tag 为 `v1.2.12`，移动端 tag 为 `mobile-v1.0.9`。
> 两边更新检查只认自己的标签，互不打扰。

## 🔔 更新提示

- 软件**启动几秒后自动检查**一次新版，之后每 6 小时检查一次（检查失败会 10 分钟后自动重试）；发现新版本会在**左侧栏弹出横幅**（显示新版本号 + 「下载」按钮），点击即打开下载页。
- 也可以**手动检查**：点击侧栏左上角的**版本号徽标**（如 `v1.2.6`）——结果会明确显示：`发现新版本` / `✓ 已是最新版本` / `检查更新失败`（失败时可点横幅上的「重试」）。
- 检查走**多渠道兜底**：GitHub API（releases 列表）→ releases 页面重定向 → releases.atom，任一通道成功即可（API 有每小时限额，国内网络下备用通道更稳）。
- 桌面端只认纯 semver 标签（`v1.2.9` / `1.2.9` / `1.2`），移动端的 `mobile-v*` 标签会被忽略；移动端反过来只认 `mobile-v*`——两边更新互不打扰。
- 由于没有开发者证书，暂不支持"一键自动升级"，采用「检测到新版 → 提示 → 前往下载页手动装」的方式。

## 💾 笔记数据保存在哪里

数据**默认只存在本机**（浏览器的 localStorage，随软件用户目录走）：

| 平台 | 数据目录 |
| --- | --- |
| macOS | `~/Library/Application Support/easynote/`（Local Storage/leveldb 内） |
| Windows | `%APPDATA%\easynote\`（即 `C:\Users\你\AppData\Roaming\easynote\`） |
| Linux | `~/.config/easynote/` |

三种方式可以把数据带到其他设备：

1. **云同步（推荐）**：登录自建同步服务后，三端自动同步（含内嵌图片）；
2. **导出 / 导入备份**：左下角「⬇ 导出备份」生成一个 JSON 文件，在另一台设备「⬆ 导入备份」；
3. **WebDAV 导出**：设置里填写 WebDAV 服务器，导出为一个 JSON + 每条笔记一个 Markdown 文件。

> 注意：卸载软件不会自动删除上面的目录，重装后笔记还在；确定不需要了再手动删除。

## 🛠 从源码构建

需要 [Node.js](https://nodejs.org/) 20+：

```bash
cd easynote
npm install
npm start                   # 以桌面窗口方式运行
npm run dist:win            # 打包 Windows .exe
npm run dist:mac            # 打包 macOS .dmg（universal）
npm run dist:linux          # 打包 Linux AppImage + deb
```

> 在 Mac 上本地打包可绕开 Gatekeeper：`bash build-mac-local.sh`。
> 三端并行自动构建：给仓库打一个 `v*` 标签并推送，即触发 `.github/workflows/build.yml`（GitHub Actions），
> 三个平台各自打包后聚合成一个 Release。

移动端（iOS / Android）本地构建：

```bash
cd mobile
npm install
npm run sync                # 把 www 同步进原生工程
npm run build:android       # 生成 android/app/build/outputs/apk/debug/app-debug.apk
npm run build:ios           # 同步 iOS 工程后用 Xcode 打开 mobile/ios/App/App.xcodeproj 运行
```

> 移动端自动构建：推送 `mobile-v*` 标签触发 `.github/workflows/mobile.yml`，
> 云端产出 Android APK（可直接安装）与 iOS 未签名 IPA（需自行签名）。

## ☁ 云同步（可选）

云同步需要一个后端服务（`server/` 目录，纯 Node.js，无需数据库）：

```bash
cd server
npm install
npm start                   # 默认监听 http://localhost:3000
```

然后在客户端「☁ 云同步」里填写服务端地址，注册 / 登录后笔记即自动同步。
本地优先：不登录、服务端离线都能正常记录，联网后自动补传；冲突按修改时间后写覆盖。

**近实时同步**：登录后客户端每 3 秒同步一轮——本地改动停手约 0.8 秒即推送，其他设备下一轮自动拉取显示，
无需手动点「立即同步」。轮询走增量协议（只传改动过的笔记），没有改动时每轮请求只有几十字节；
窗口缩到托盘也照常同步。老版本服务端不支持增量时会自动退化为全量轮询，功能不受影响。

### 🐳 网页版 / Docker 一键部署（浏览器访问，多端同账户实时同步）

除了桌面端和移动端，服务端还能**顺带托管一个网页版**：部署后浏览器打开 `http://<你的主机IP>:3050/`
就是完整的「简易笔记」，登录同一个账户，笔记与桌面 / 移动端**实时互通**——适合临时用别人电脑、
平板 / Chromebook 等不方便装客户端的场景。

- **最简（fnOS 共享文件夹）**：把 `server/` 整目录复制到 NAS 共享文件夹（如 `/vol1/simplenote-sync/`），
  用 `node:20-alpine` 镜像 bind mount 到 `/app` 跑 `npm start` 即可；服务端会自动托管网页版（需带上 `server/web/`）。
- **自包含镜像**：仓库根目录自带 `Dockerfile` + `docker-compose.yml`，在包含 `server/`、`index.html`、
  `app.js`、`styles.css` 的目录执行 `docker compose up -d --build`，自动构建并运行
  `easynote-server:latest`（默认端口 3050，数据用卷持久化）。
- 详细步骤见 **[server/README.md](./server/README.md)**（含网页版说明、飞牛 NAS 三种部署方式、外网访问）。

> 网页版以「当前访问地址」作为同步服务器，所以 `http://nas.local:3050/` 里记的笔记会实时同步到手机 App。

**更新网页版文件**：桌面安装包里的界面是打包进去的，网页版是服务器上的一份静态文件，
两者互不影响。仓库更新后如果想让网页版也用到新界面（例如新的回收站批量操作），
把 `server/web/` 里的 `index.html`、`styles.css`、`app.js`、`sw.js`（及图标）重新拷到服务器的
`web/` 目录即可，可用仓库自带脚本：

```bash
./server/deploy-web.sh 用户@主机 /vol1/simplenote-sync/web 2580   # 只需输一次密码
```

拷完浏览器强制刷新一次（`Ctrl/Cmd + Shift + R`）；已添加到主屏的 PWA 会自动更新。

**更新服务端 `server.js`**（Docker 部署）：换服务端代码比换静态文件危险（语法错会让服务直接起不来），
所以用另一个脚本，流程是「上传 → 容器内 `node --check` → 通过才重启，失败自动回滚」，
全程不碰 `data/`：

```bash
./server/deploy-server.sh 用户@主机 /vol1/simplenote-sync 2580 simplenote-zh-sync
```

更新完在客户端「云同步 → 同步诊断」里应当能看到服务端版本号。

### ⚠️ 同步报错排查（413 / 同步失败）

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `笔记内容过大，服务器拒绝接收（413）` | 一键修复后图片以 base64 内嵌进笔记，整批笔记可能达数 MB，超过服务端请求体上限（老版本服务端默认只有 100kb） | 把服务端 `server/server.js` 换成 **v1.2.7 及以上**版本（默认上限 100mb，也可用 `BODY_LIMIT` 环境变量调整）并重启；数据目录 `data/` 不用动 |
| `无法连接服务器 …` | 地址填错 / 服务端没启动 / 不在同一局域网 | 见上文「云同步」与服务端 README |
| `登录已过期，请重新登录` | 令牌过期（30 天）或服务端换了 `JWT_SECRET` | 在客户端重新登录 |
| 修复后其他设备仍看不到图 | 只在一台设备上修了；或缺原文件的设备修不出那张图 | 在**存有原文件**的那台电脑上重新点「一键修复」并确保同步成功，其他设备再拉取 |

> 服务端前面若挂了 Nginx 等反向代理，413 也可能来自代理：请在代理配置里加 `client_max_body_size 100m;`。

## 📁 文件结构

| 文件 | 说明 |
| --- | --- |
| `index.html` | 应用结构 |
| `styles.css` | Simplenote 风格样式 + 深色模式 |
| `app.js` | 全部业务逻辑、本地持久化、账号与同步、更新提示 |
| `main.js` | Electron 主进程（窗口 / 托盘 / 剪贴板 / 选图 / 更新检查 / WebDAV） |
| `preload.js` | Electron 预加载脚本（向渲染进程安全暴露接口） |
| `package.json` | 运行 / 三端打包配置 |
| `build/` | 应用图标、托盘图标、macOS ad-hoc 签名钩子 `afterSign.js`、Linux 解硬链接钩子 `afterPack.js` |
| `build-mac-local.sh` | 在 Mac 上本地打包，绕开 Gatekeeper 拦截 |
| `mobile/` | 移动端（iOS / Android）Capacitor 工程：`www/` 为手机 UI 源码，`android/`、`ios/` 为原生工程，`tools/gen-icons.js` 生成图标与启动图 |
| `server/` | 云同步服务端（Express + JWT + 文件存储） |
| `.github/workflows/build.yml` | GitHub Actions 三端自动打包工作流（tag `v*`） |
| `.github/workflows/mobile.yml` | GitHub Actions 移动端打包工作流（tag `mobile-v*`） |
| `xcode-tutorial.html` | iOS 用 Xcode 签名安装「简易笔记」的截图级教程（推荐方案） |
| `sideloadly-tutorial.html` | iOS 侧载（Sideloadly / AltStore）备选方案截图级教程 |
| `server/web/` | 浏览器版客户端静态资源（index.html / app.js / styles.css 的副本，由服务端同源托管，打开 `http://<host>:<PORT>/` 即用） |
| `Dockerfile` / `docker-compose.yml` / `.dockerignore` | 一键构建「服务端 + 网页版」Docker 镜像，详见 [server/README.md](./server/README.md) |

## 已知范围

- 数据默认只保存在本机；开启云同步后同时保存在你的服务端，建议仍定期「导出备份」
- 图片为**内嵌保存**（base64），笔记体积会变大一些，换来的是"换设备 / 移动原图也照常显示"
- macOS / Linux 安装包无法在 Windows 机器上直接生成，请按上文在对应系统或 CI 中构建
