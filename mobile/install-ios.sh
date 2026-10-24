#!/bin/bash
# 一键把「简易笔记」iOS 最新版编译并安装到已连接的 iPhone（自签真机）
#
# 用法：
#   bash mobile/install-ios.sh              # 自动找已连接的可安装 iPhone
#   bash mobile/install-ios.sh <UDID>       # 指定设备
#   bash mobile/install-ios.sh --list       # 只看当前识别到的设备（排查用）
#   bash mobile/install-ios.sh --dry-run    # 只同步网页资源 + 检查环境，不编译不安装
#
# 前置：iPhone 用数据线连上 Mac，手机上点过「信任此电脑」。
# 说明：这是「自签真机」方式；免费 Apple ID 签的 App 7 天过期，到期重跑本脚本即可。
#       若不方便连数据线，可用 Sideloadly 侧载 Releases 里的 unsigned ipa。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

say() { printf '%s\n' "$*"; }

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

if [ ! -d mobile/ios/App ]; then
  say "✗ 当前目录不是 easynote 仓库根目录（找不到 mobile/ios/App）"
  exit 1
fi

# ---------------------------------------------------------------- 0. 找 node
# 本机平时可能没装 node（WorkBuddy 自带的 node 不在登录 PATH 里），
# 没有 node 时 cap CLI 跑不了，会自动退化成直接拷贝网页资源。
if ! command -v node >/dev/null 2>&1; then
  for d in "$HOME"/.workbuddy/binaries/node/versions/*/bin /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$d/node" ]; then
      export PATH="$d:$PATH"
      say "==> 使用 $d 里的 node（$(node -v 2>/dev/null)）"
      break
    fi
  done
fi

# ---------------------------------------------------------------- 1. 版本号
# 不能用 node 读 package.json（本机可能没有 node），改用 sed
VER="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' mobile/package.json 2>/dev/null | head -1)"
[ -z "$VER" ] && VER="未知"
say ">>> 简易笔记 iOS 版：$VER"

# ------------------------------------------------------- 参数（--list 要尽早就返回）
UDID=""
DRY=0
for arg in "$@"; do
  case "$arg" in
    -l|--list)
      say "当前 devicectl 识别到的设备："
      xcrun devicectl list devices 2>/dev/null || true
      exit 0
      ;;
    -n|--dry-run) DRY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) UDID="$arg" ;;
  esac
done

# --------------------------------------------------- 2. 同步网页资源到 iOS
# 关键：mobile/ios/App/App/public 是 mobile/www 的副本（被 gitignore）。
# 不同步的话，装到手机上跑的还是旧网页资源（上次装的代码）。
PUB="mobile/ios/App/App/public"
sync_web() {
  if [ -x mobile/node_modules/.bin/cap ] && command -v node >/dev/null 2>&1; then
    say "==> 同步网页资源到 iOS（cap copy ios）..."
    if ( cd mobile && ./node_modules/.bin/cap copy ios >/dev/null 2>&1 ); then
      return 0
    fi
    say "   （cap copy 失败，改用直接拷贝）"
  fi
  # 回退：直接拷贝。只覆盖不删除，保留 Capacitor 注入的 cordova.js 等文件。
  say "==> 同步网页资源到 iOS（直接拷贝 mobile/www → $PUB）..."
  mkdir -p "$PUB" || return 1
  cp -R mobile/www/. "$PUB"/ || return 1
  return 0
}

if ! sync_web; then
  say "✗ 同步网页资源失败，请检查 $PUB 是否可写"
  exit 1
fi

if [ "$VER" != "未知" ] && ! grep -q "APP_VERSION = \"$VER\"" "$PUB/app.js" 2>/dev/null; then
  say "✗ 同步校验失败：$PUB/app.js 里的 APP_VERSION 不是 $VER（装上去会是旧代码）"
  exit 1
fi

# ---------------------------------------------------------------- 3. 找设备
# devicectl 的 State 会随连接方式变化：available (paired) / connected / unavailable …
# 之前只认 available，插着线显示 connected 时就找不到设备了 —— 这里放宽并排除无效状态。
list_devices() {
  xcrun devicectl list devices 2>/dev/null || true
}

find_udid() {
  list_devices | awk '
    /\(UDID\)/ && !/simulated/ && !/unavailable/ && !/disconnected/ && !/shutdown/ {
      for (i = 1; i <= NF; i++) if ($i == "(UDID)") { print $(i - 1); exit }
    }'
}

if [ -z "$UDID" ]; then
  UDID="$(find_udid)"
  # 刚插上的设备偶尔要一两秒才出现，再给一次机会
  if [ -z "$UDID" ]; then sleep 2; UDID="$(find_udid)"; fi
fi

if [ -z "$UDID" ]; then
  say "✗ 没找到可安装的 iPhone。devicectl 现在看到的是："
  list_devices
  say ""
  say "常见原因："
  say "  1) 数据线只充电不传输 → 换线或换 USB 口"
  say "  2) 手机上没点「信任此电脑」→ 拔插一次会再弹，点信任"
  say "  3) 手机锁屏且刚重启过 → 解锁后重跑"
  say "  4) 状态是 unavailable / pairing → 先在手机上确认信任"
  say ""
  say "  不方便连数据线时，可用 Sideloadly 侧载："
  say "    1) 到 Releases 下载 easynote-mobile-vX.Y.Z-ios-unsigned.ipa"
  say "       https://github.com/feibixunchang/easynote/releases"
  say "    2) 用 Sideloadly + 你的 Apple ID 签名安装（详见 sideloadly-tutorial.html）"
  exit 1
fi
say "==> 目标设备 UDID: $UDID"

if [ "$DRY" = "1" ]; then
  say "==> --dry-run：网页资源已同步，环境检查通过（未编译、未安装）"
  exit 0
fi

# ------------------------------------------------------------ 4. 编译 + 安装
# 编译缓存先清干净，避免上次残留导致诡异失败
rm -rf /tmp/easynote-dd

cd mobile/ios/App || exit 1

say "==> 1/3 编译 iOS 真机包（首次约 1-3 分钟）..."
xcodebuild -project App.xcodeproj -scheme App \
  -destination "id=$UDID" \
  -configuration Debug \
  -derivedDataPath /tmp/easynote-dd \
  -allowProvisioningUpdates \
  build
BUILD_RC=$?
if [ $BUILD_RC -ne 0 ]; then
  say ""
  say "✗ 编译失败（退出码 $BUILD_RC）。常见原因："
  say "  · Xcode 没有登录 Apple ID → Xcode → Settings → Accounts 添加"
  say "  · 手机没在 Xcode 里注册过设备 → 打开 App.xcodeproj，选你的手机跑一次"
  say "  · 签名团队不对 → Signing & Capabilities 里选自己的 Team"
  exit 1
fi

APP="/tmp/easynote-dd/Build/Products/Debug-iphoneos/App.app"
if [ ! -d "$APP" ]; then
  say "✗ 编译产物不存在：$APP"
  exit 1
fi

say "==> 2/3 安装到手机..."
if ! xcrun devicectl device install app --device "$UDID" "$APP"; then
  say "✗ 安装失败。若提示 device locked，请先解锁手机再重跑。"
  exit 1
fi

say "==> 3/3 启动 App..."
xcrun devicectl device process launch --device "$UDID" com.feibixunchang.easynote || true

say ""
say "✅ 完成！去手机桌面找「简易笔记」图标（版本 $VER）。"
say "   （首次打开若提示「未受信任的开发者」：设置 → 通用 → VPN 与设备管理 → 开发者 App → 信任）"
say "   （免费 Apple ID 签的 App 7 天过期，到期重跑本脚本即可）"
