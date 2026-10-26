#!/usr/bin/env bash
# 把 server/web 下的网页版（PWA）资源同步到自己的同步服务器（NAS / VPS 均可）。
#
# 为什么需要单独同步：桌面安装包是打包在 app 里的，网页版是服务器上的一份静态文件，
# 改了 index.html / styles.css / app.js / sw.js 之后必须重新拷过去，否则用户打开网页还是旧界面。
#
# 用法：
#   ./deploy-web.sh 用户@主机 [远端路径] [SSH端口]
# 例：
#   ./deploy-web.sh me@192.168.1.10 /vol1/simplenote-sync/web 2580
#
# 全程只输一次密码：先建一条 SSH 长连接（ControlMaster），后面的拷贝复用这条连接。
# 不写死任何密码 / 内网地址，避免仓库里出现个人信息。

# 万一被 sh / zsh 直接执行（例如 source 或者文件权限被改），自动切回 bash 再来一遍
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

TARGET="${1:?用法: ./deploy-web.sh 用户@主机 [远端路径] [端口]}"
REMOTE_DIR="${2:-/vol1/simplenote-sync/web}"
PORT="${3:-22}"

HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="${HERE}/web"
SOCK="/tmp/easynote-deploy-$$.sock"

FILES=(index.html styles.css app.js shared/core.js sw.js manifest.webmanifest icon-192.png icon-512.png apple-touch-icon.png)

SSH_OPTS=(-o "ControlPath=${SOCK}" -o RequestTTY=no)

cleanup() {
  ssh -p "${PORT}" "${SSH_OPTS[@]}" -O exit "${TARGET}" >/dev/null 2>&1 || true
  rm -f "${SOCK}" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> 连接 ${TARGET} 端口 ${PORT}（这里会要你输一次密码）"
ssh -p "${PORT}" -o ControlMaster=yes -o "ControlPath=${SOCK}" -o ControlPersist=180 -fnN "${TARGET}"

echo "==> 上传到 ${REMOTE_DIR}"
ssh -p "${PORT}" "${SSH_OPTS[@]}" "${TARGET}" "mkdir -p '${REMOTE_DIR}/shared'"
failed=0
for f in "${FILES[@]}"; do
  if [ -f "${WEB}/${f}" ]; then
    if scp -P "${PORT}" "${SSH_OPTS[@]}" "${WEB}/${f}" "${TARGET}:${REMOTE_DIR}/${f}" >/dev/null 2>&1; then
      local_size=$(wc -c < "${WEB}/${f}" | tr -d ' ')
      printf '  ok   %-22s %s bytes\n' "${f}" "${local_size}"
    else
      printf '  FAIL %-22s\n' "${f}"
      failed=$((failed + 1))
    fi
  else
    printf '  --   %-22s 本地没有，跳过\n' "${f}"
  fi
done

if [ "${failed}" -ne 0 ]; then
  echo "有 ${failed} 个文件上传失败，请检查远端路径是否可写。" >&2
  exit 1
fi

echo "==> 远端目录"
ssh -p "${PORT}" "${SSH_OPTS[@]}" "${TARGET}" "ls -l '${REMOTE_DIR}'"

echo
echo "完成。浏览器按 Cmd/Ctrl + Shift + R 强刷一次即可看到新界面；"
echo "已经装到主屏的 PWA 会在下次打开时自动更新（Service Worker 是网络优先）。"
