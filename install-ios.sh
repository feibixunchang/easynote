#!/usr/bin/env bash
# 简易笔记 · iOS 真机一键构建 + 安装（Face ID 修复版）
# 注意：本脚本必须在【用户自己的终端】运行，不要交给智能体执行——
#       智能体沙箱会阻断 xcodebuild 的 SPM 包解析（sandbox-exec），无法编译。
#
# 用法：
#   1) 用数据线把 iPhone 连到这台 Mac，信任电脑（首次连接会在手机上点「信任」）。
#   2) 在终端执行：bash install-ios.sh
#   3) 装好后到 iPhone “简易笔记 → 设置” 开启面容解锁，锁屏/冷启验证 Face ID。
#
# 排错：App 内生物识别日志以 [bio] 开头（含 PluginHeaders / check / auth），
#       若 check:false 说明原生插件没编进来；若 auth 调用失败看拒绝原因。
#       找不到设备时脚本会回退到已知 UDID；若仍连不上，先确认数据线/信任。

set -euo pipefail

# 定位到仓库 mobile 目录（脚本放在仓库根）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${SCRIPT_DIR}/mobile"

# —— 让 npm / node 在非交互 bash 子shell 里也能找到 ——
# 很多人的 node 来自 nvm 或 Homebrew，只在交互式 .zshrc 里注入 PATH；
# 用 `bash install-ios.sh` 起的非交互 bash 继承不到，会报 npm: command not found。
if ! command -v npm >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh" || true
  fi
  if ! command -v npm >/dev/null 2>&1; then
    shopt -s nullglob
    for d in "$HOME/.workbuddy/binaries/node/versions"/*/bin "$HOME/.nvm/versions/node"/*/bin /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.fnm"/*/bin; do
      if [ -x "$d/npm" ]; then
        export PATH="$d:$PATH"
        break
      fi
    done
    shopt -u nullglob
  fi
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "错误：找不到 npm。请先安装 Node.js（https://nodejs.org）或 nvm，再重跑本脚本。" >&2
  exit 1
fi
echo "使用 node: $(command -v node) | npm: $(command -v npm)"

# 提前探测已连接的实体设备 UDID（用于构建目标与安装目标一致）
echo "== [0/4] 探测已连接的 iPhone =="
UDID="$(xcrun devicectl list devices 2>/dev/null | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}' | head -1 || true)"
if [ -z "${UDID:-}" ]; then
  UDID="00008101-001134493C44001E"
  echo "未自动探测到设备，回退到已知 UDID: ${UDID}（请确保手机已连接并信任）"
else
  echo "目标设备 UDID: ${UDID}"
fi

echo "== [1/4] 安装依赖（含 @aparajita/capacitor-biometric-auth 原生插件）=="
npm install

echo "== [2/4] 同步 Capacitor iOS 工程（拷贝修复后的 web 资源 + 重生 Package.swift）=="
npx cap sync ios

echo "== [3/4] 构建 Debug 真机包（针对设备 ${UDID}，自动签名）=="
# Xcode 工程在 mobile/ios/App/App.xcodeproj，构建须切到 mobile/ios
cd "${SCRIPT_DIR}/mobile/ios"
rm -rf App/build-ios
xcodebuild \
  -IDEPackageSupportDisableManifestSandbox=1 \
  -IDEPackageSupportDisablePluginExecutionSandbox=1 \
  -project App/App.xcodeproj \
  -scheme App \
  -configuration Debug \
  -destination "platform=iOS,id=${UDID}" \
  -derivedDataPath App/build-ios \
  DEVELOPMENT_TEAM=6B8ND5JK75 \
  CODE_SIGN_STYLE=Automatic \
  build

APP_PATH="$(find App/build-ios -name 'App.app' -type d | head -1)"
if [ -z "${APP_PATH:-}" ]; then
  echo "构建失败：未找到 App.app" >&2
  exit 1
fi
echo "构建产物: ${APP_PATH}"

echo "== [4/4] 安装到 iPhone（${UDID}）=="
xcrun devicectl device install app --device "${UDID}" "${APP_PATH}"
xcrun devicectl device process launch --device "${UDID}" com.feibixunchang.easynote || \
  echo "(若上面 launch 报错，多半是 App 已在运行，直接到 iPhone 上手动打开即可)"

echo ""
echo "完成。请在 iPhone 上打开“简易笔记”，进入设置开启面容解锁并验证 Face ID。"
echo "若 Face ID 仍未生效，打开设置页看一眼 [bio] 开头的日志："
echo "  - PluginHeaders 含 BiometricAuthNative 且 check:true / auth:true → 原生已就绪，看系统弹窗是否被取消；"
echo "  - check:false → 原生插件没编进包（重跑本脚本确认 npm install 拉到了 @aparajita 包）。"
