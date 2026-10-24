#!/usr/bin/env bash
# 把 server/web 下的网页版（PWA）资源同步到自己的同步服务器（NAS / VPS 均可）。
#
# 为什么需要单独同步：桌面安装包是打包在 app 里的，网页版是服务器上的一份静态文件，
# 改了 index.html / styles.css / app.js / sw.js 之后必须重新拷过去，否则用户打开网页还是旧界面。
#
# 用法：
#   ./deploy-web.sh 用户@主机 [/远端路径] [SSH端口]
# 例：
#   ./deploy-web.sh zjkx@192.168.1.10 /vol1/simplenote-sync/web 2580
#
# 全程只输一次密码：先建一条 SSH 长连接（ControlMaster），后面的拷贝复用这条连接。
# 不写死任何密码 / 内网地址，避免仓库里出现个人信息。

set -euo pipefail

TARGET="${1:?用法: ./deploy-web.sh 用户@主机 [远端路径] [端口]}"
REMOTE_DIR="${2:-/vol1/simplenote-sync/web}"
PORT="${3:-22}"

HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="$HERE/web"
SOCK="/tmp/easynote-deploy-$$.sock"

FILES=(index.html styles.css app.js sw.js manifest.webmanifest icon-192.png icon-512.png apple-touch-icon.png)

echo "==> 连接 $TARGET:$PORT（这一步会要你输一次密码）"
ssh -p "$PORT" -o ControlMaster=yes -o ControlPath="$SOCK" -o ControlPersist=120 -fnN "$TARGET"
trap 'ssh -p "$PORT" -o ControlPath="$SOCK" -O exit "$TARGET" >/dev/null 2>&1 || true' EXIT

echo "==> 上传到 $REMOTE_DIR"
for f in "${FILES[@]}"; do
  if [ -f "$WEB/$f" ]; then
    scp -P "$PORT" -o ControlPath="$SOCK" "$WEB/$f" "$TARGET:$REMOTE_DIR/$f" >/dev/null
    echo "  ✓ $f"
  else
    echo "  - 跳过（本地没有）$f"
  fi
done

echo "==> 校验"
ssh -p "$PORT" -o ControlPath="$SOCK" "$TARGET" "ls -l $REMOTE_DIR"
echo "完成。浏览器强制刷新一次（Cmd/Ctrl+Shift+R）即可看到新界面；已装的 PWA 会自动更新。"
