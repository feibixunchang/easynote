#!/usr/bin/env bash
# 更新「云同步服务端」的 server.js（Docker 部署，例如飞牛 / 群晖上的 node 容器）。
#
# 为什么单独一个脚本：服务端跑在容器里，改的是宿主机上被 bind mount 进容器的那份文件，
# 所以流程必须是「传文件 → 容器内语法检查 → 通过才重启」，语法错就自动回滚，
# 避免重启后服务起不来（数据在 data/ 下，脚本绝不碰 data/）。
#
# 用法：
#   ./deploy-server.sh 用户@主机 [远端目录] [SSH端口] [容器名]
# 例：
#   ./deploy-server.sh me@192.168.1.10 /vol1/simplenote-sync 2580 simplenote-zh-sync
#
# 只输一次密码（ControlMaster 复用连接）。

if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

TARGET="${1:?用法: ./deploy-server.sh 用户@主机 [远端目录] [端口] [容器名]}"
REMOTE_DIR="${2:-/vol1/simplenote-sync}"
PORT="${3:-22}"
CONTAINER="${4:-simplenote-zh-sync}"

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${HERE}/server.js"
SOCK="/tmp/easynote-server-$$.sock"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="server.js.bak-${STAMP}"

SSH=(ssh -p "${PORT}" -o "ControlPath=${SOCK}" -o RequestTTY=no)

cleanup() {
  "${SSH[@]}" -O exit "${TARGET}" >/dev/null 2>&1 || true
  rm -f "${SOCK}" 2>/dev/null || true
}
trap cleanup EXIT

[ -f "${SRC}" ] || { echo "✗ 找不到 ${SRC}"; exit 1; }

echo "==> 连接 ${TARGET} 端口 ${PORT}（这里会要你输一次密码）"
ssh -p "${PORT}" -o ControlMaster=yes -o "ControlPath=${SOCK}" -o ControlPersist=180 -fnN "${TARGET}"

echo "==> 上传 server.js"
scp -P "${PORT}" -o "ControlPath=${SOCK}" "${SRC}" "${TARGET}:${REMOTE_DIR}/server.js.new" >/dev/null

echo "==> 备份现有版本为 ${BACKUP}"
"${SSH[@]}" "${TARGET}" "cd '${REMOTE_DIR}' && cp -f server.js '${BACKUP}' && ls -l server.js '${BACKUP}'"

echo "==> 切换到新版本"
"${SSH[@]}" "${TARGET}" "cd '${REMOTE_DIR}' && mv -f server.js.new server.js"

echo "==> 容器内语法检查"
if "${SSH[@]}" "${TARGET}" "docker exec '${CONTAINER}' node --check /app/server.js"; then
  echo "    ✓ 语法通过"
else
  echo "    ✗ 语法检查失败，回滚到 ${BACKUP}" >&2
  "${SSH[@]}" "${TARGET}" "cd '${REMOTE_DIR}' && mv -f '${BACKUP}' server.js"
  echo "    已回滚，服务未重启（仍是旧版本）。" >&2
  exit 1
fi

echo "==> 重启容器 ${CONTAINER}"
"${SSH[@]}" "${TARGET}" "docker restart '${CONTAINER}' >/dev/null && sleep 2 && docker ps --filter name='${CONTAINER}' --format '{{.Status}}'"

echo "==> 健康检查"
INNER_PORT="$("${SSH[@]}" "${TARGET}" "docker exec '${CONTAINER}' printenv PORT 2>/dev/null || echo 3000" | tr -d '\r')"
INNER_PORT="${INNER_PORT:-3000}"
if "${SSH[@]}" "${TARGET}" "docker exec '${CONTAINER}' wget -qO- 'http://127.0.0.1:${INNER_PORT}/api/health' 2>/dev/null || docker exec '${CONTAINER}' curl -fsS 'http://127.0.0.1:${INNER_PORT}/api/health'"; then
  echo ""
  echo "完成。客户端「同步诊断」里能看到服务端版本号，即表示已生效。"
else
  echo "⚠ 健康检查没拿到响应，请手动确认：docker logs --tail 30 ${CONTAINER}" >&2
  exit 1
fi
