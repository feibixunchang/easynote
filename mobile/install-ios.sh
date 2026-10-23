#!/bin/bash
# 一键把「简易笔记」iOS 最新版编译并安装到已连接的 iPhone（自签真机）
#
# 用法：
#   bash mobile/install-ios.sh            # 自动找已连接并配对的可安装 iPhone
#   bash mobile/install-ios.sh <UDID>     # 指定设备
#
# 前置：iPhone 用数据线连上 Mac，手机上点过「信任此电脑」。
# 说明：这是「自签真机」方式，与 pagevault 等自托管 App 的装机方式一致；
#       免费 Apple ID 签的 App 7 天过期，到期重跑本脚本即可。
#       若不方便连数据线，可用 Sideloadly 侧载 Releases 里的 unsigned ipa。
set -euo pipefail

# 定位到仓库根（脚本位于 mobile/ 下）
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -d mobile/ios/App ]; then
  echo "✗ 当前目录不是 easynote 仓库根目录（找不到 mobile/ios/App）"
  exit 1
fi

VER=$(node -e "try{console.log(require('./mobile/package.json').version)}catch(e){console.log('未知')}" 2>/dev/null || echo "未知")
echo ">>> 简易笔记 iOS 版：$VER"

# 1) 同步网页资源到 iOS 工程（有本地 capacitor cli 才做，失败不阻断）
#    关键：mobile/ios/App/App/public 是 www 的副本（且被 gitignore），
#    不同步的话装到手机上就是旧的网页资源。
if [ -d mobile/node_modules/@capacitor/cli ] && command -v npx >/dev/null 2>&1; then
  echo "==> 同步网页资源到 iOS（cap copy ios）..."
  ( cd mobile && npx cap copy ios >/dev/null 2>&1 ) || echo "   （cap copy 跳过，使用已有 public/）"
else
  echo "==> 未找到本地 @capacitor/cli，跳过 cap copy（如需请先 npm i）"
fi

# 2) 找设备
UDID="${1:-}"
if [ -z "$UDID" ]; then
  UDID=$(xcrun devicectl list devices 2>/dev/null | awk '/physical/ && /available/ {for(i=1;i<=NF;i++) if($i=="(UDID)") {print $(i-1); exit}}')
fi
if [ -z "$UDID" ]; then
  echo "✗ 没找到已连接并配对的可安装 iPhone。"
  echo "  请用数据线连上 iPhone，手机上点「信任此电脑」，再重跑本脚本。"
  echo ""
  echo "  不方便连数据线时，可用 Sideloadly 侧载："
  echo "    1) 到 Releases 下载 easynote-mobile-vX.Y.Z-ios-unsigned.ipa"
  echo "       https://github.com/feibixunchang/easynote/releases"
  echo "    2) 用 Sideloadly + 你的 Apple ID 签名安装（详见 sideloadly-tutorial.html）"
  exit 1
fi
echo "==> 目标设备 UDID: $UDID"

# 编译缓存先清干净，避免上次残留导致诡异失败
rm -rf /tmp/easynote-dd

cd mobile/ios/App

# 3) 编译（自动签名）
echo "==> 1/3 编译 iOS 真机包（首次约 1-3 分钟）..."
xcodebuild -project App.xcodeproj -scheme App \
  -destination "id=$UDID" \
  -configuration Debug \
  -derivedDataPath /tmp/easynote-dd \
  -allowProvisioningUpdates \
  build

APP="/tmp/easynote-dd/Build/Products/Debug-iphoneos/App.app"
if [ ! -d "$APP" ]; then
  echo "✗ 编译产物不存在：$APP"
  exit 1
fi

# 4) 安装
echo "==> 2/3 安装到手机..."
xcrun devicectl device install app --device "$UDID" "$APP"

# 5) 启动
echo "==> 3/3 启动 App..."
xcrun devicectl device process launch --device "$UDID" com.feibixunchang.easynote || true

echo ""
echo "✅ 完成！去手机桌面找「简易笔记」图标（版本 $VER）。"
echo "   （首次打开若提示「未受信任的开发者」：设置 → 通用 → VPN 与设备管理 → 开发者 App → 信任）"
echo "   （免费 Apple ID 签的 App 7 天过期，到期重跑本脚本即可）"
