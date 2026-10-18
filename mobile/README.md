# 简易笔记 · 移动端（iOS / Android）

与桌面端（macOS / Windows / Linux）**功能完全一致**的 Capacitor 8 应用：
同一套云同步协议、同一个账号，电脑与手机的笔记实时互相同步。

## 特性

- **功能对齐桌面端**：笔记 / 回收站 / 标签 / 颜色标签 / 置顶 / 搜索 / Markdown 预览 /
  插入图片（拍照 / 相册，自动等比压缩到最长边 ≤1600px 后内嵌）/ 插入链接 / 导出备份 /
  深色模式 / 字体字号 / 3 秒增量云同步 / 更新检查（只认 `mobile-v*` 标签）。
- **响应式界面**：手机为单栏（列表 / 编辑器 / 设置 + 底部导航 + 悬浮新建按钮）；
  宽 ≥720px（平板 / 折叠屏展开）自动切换双栏；适配安全区（刘海 / 手势条）与横屏。
- **手机习惯交互**：长按笔记弹出底部操作面板；系统返回键优先返回列表；
  切后台再回来自动同步。

## 目录结构

| 目录 | 说明 |
| --- | --- |
| `www/` | 手机 UI 源码（index.html / styles.css / app.js），本地存储键与同步协议和桌面端一致 |
| `android/` | Android 原生工程（`com.feibixunchang.easynote`，minSdk 24 / target 36，已允许内网 HTTP） |
| `ios/` | iOS 原生工程（Capacitor 8 SPM 方案，无需 CocoaPods；已放行 ATS 与相机 / 相册权限） |
| `resources/` | 图标 / 启动图源文件（1024 图标 + 2732 启动图） |
| `tools/gen-icons.js` | 用 pngjs 从源文件生成各平台图标与启动图（无需 sharp） |

## 本地开发

需要 Node.js 20+；iOS 另需 macOS + Xcode 16+，Android 另需 JDK 21 + Android SDK 36。

```bash
npm install
npm run sync                # 把 www/ 拷贝进原生工程（改完 www 后都要执行）
npm run build:android       # Gradle 构建 debug APK → android/app/build/outputs/apk/debug/app-debug.apk
npm run build:ios           # 同步 iOS 工程，再用 Xcode 打开 ios/App/App.xcodeproj 运行
```

真机调试：Android 用 `npm run android` 打开 Android Studio 运行；
iOS 用 `npm run ios` 打开 Xcode，登录 Apple ID 后选择自己的 iPhone 运行。

## 发布

推送 `mobile-v<版本>` 标签即触发 `.github/workflows/mobile.yml`：

```bash
# 发版前记得同步版本号（三处都要改）：
#   mobile/package.json 的 version
#   mobile/www/app.js 里的 APP_VERSION
#   android/app/build.gradle 的 versionName / versionCode、ios pbxproj 的 MARKETING_VERSION / CURRENT_PROJECT_VERSION
git tag mobile-v1.0.2 && git push origin mobile-v1.0.2
```

CI 会产出：

- **Android**：可直接安装的 debug APK（无需签名证书）；
- **iOS**：未签名 IPA（云端无苹果证书，需在 Mac 上用 **Xcode 签名安装**，详见主 README「移动端」一节；
  不想装 Xcode 也可用 AltStore / Sideloadly 侧载）。

## 云同步

设置 → 账号里填写同步服务器地址（如 `http://192.168.1.100:3000`）与账号密码，
与桌面端共用同一个服务端（仓库 `server/` 目录）。未登录也能正常记笔记，联网后自动补传。
