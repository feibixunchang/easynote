#!/bin/bash
# 在 Mac 上本地打包 macOS 版（彻底绕开 Gatekeeper / XProtect 拦截）
#
# 为什么需要这个脚本：
#   GitHub Actions 上没有苹果开发者证书，打出来的 .app 只是「ad-hoc 签名」
#   （有 CodeDirectory、但没有 CMS 签名、没有 entitlements、没有公证票据）。
#   这种包从浏览器下载后，macOS 15+ 的 Gatekeeper 会直接拦截并移到废纸篓，
#   xattr -cr 也不一定救得回来。而在本机亲手打包出来的应用不带任何隔离标记，
#   Gatekeeper / XProtect 根本不会介入，100% 能打开。
#
# 用法（只需一次）：
#   cd 客户端源码
#   bash build-mac-local.sh
# 产物：dist/easynote-<版本>.dmg  （通用包，Intel + Apple 芯片都能用）

set -e
cd "$(dirname "$0")"

echo "==> 检查 Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装：https://nodejs.org （选 LTS 20+）"
  echo "或用 Homebrew：  brew install node"
  exit 1
fi
node -v

echo "==> 检查 Xcode 命令行工具（macOS 打包 dmg 必需）"
if ! xcode-select -p >/dev/null 2>&1; then
  echo "正在触发安装，请在弹出窗口点「安装」…"
  xcode-select --install || true
  echo "装完命令行工具后重新运行本脚本"
  exit 1
fi

echo "==> 安装依赖（首次较慢）"
npm ci

echo "==> 开始打包 macOS 通用包"
npm run dist:mac:local

echo ""
echo "=============================================="
echo "完成！安装包在 dist/ 目录："
ls -lh dist/*.dmg
echo ""
echo "双击 dist/*.dmg → 把「简易笔记」拖进「应用程序」→ 直接打开，不会有任何拦截。"
echo "=============================================="
