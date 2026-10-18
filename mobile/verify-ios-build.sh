#!/bin/bash
# 验证 iOS 工程能否正常编译
#
# 背景：在本机 WorkBuddy 的 Bash 沙箱里，`xcodebuild` 任何命令都会卡在
#   "sandbox-exec: sandbox_apply: Operation not permitted"（不允许嵌套沙箱），
#   所以这里改用 `swift build --disable-sandbox` 针对 iOS 编译本地 SPM 包
#   （Capacitor 核心 + 全部 @capacitor 插件）作为编译验证。
#   完整 App（含 AppDelegate/SceneDelegate）的编译与签名安装，请按 xcode-tutorial.html
#   在 Xcode 图形界面里 ⌘R 进行。
#
# 用法：bash verify-ios-build.sh
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/ios/App/CapApp-SPM"

if ! command -v swift >/dev/null 2>&1; then
  echo "✗ 未检测到 swift，请先安装 Xcode，并在 Xcode → Settings → Locations 选中它"
  exit 1
fi

SDK="$(xcrun --sdk iphoneos --show-sdk-path 2>/dev/null || true)"
if [ -z "$SDK" ]; then
  echo "✗ 找不到 iPhoneOS SDK，请确认 Xcode 已安装并完成首次启动（安装组件/同意许可）"
  exit 1
fi

echo ">>> iPhoneOS SDK: $SDK"
echo ">>> 以 iOS 目标编译 Capacitor 核心 + 全部插件（关沙箱、禁钥匙串凭据）"
GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/true \
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \
swift build --disable-sandbox --sdk "$SDK" --triple arm64-apple-ios15.0

echo
echo "✓ 编译通过。真机签名安装请按 xcode-tutorial.html 在 Xcode 里 ⌘R。"
