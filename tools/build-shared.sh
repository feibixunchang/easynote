#!/usr/bin/env bash
# ============================================================
# 共享核心「产物化」：shared/core.js → 移动端 / 网页版目录
# ------------------------------------------------------------
# shared/core.js 是三端共用的纯函数唯一来源。移动端与网页版各自需要一份
# 位于自己的静态目录里（打包/部署时才带得上），本脚本负责复制并校验一致。
#
# 用法：bash tools/build-shared.sh
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

# 共享核心 + 平台适配层：两份都要复制到移动端与网页版目录
SRCS=("shared/core.js" "shared/platform.js")
DIRS=("mobile/www/shared" "server/web/shared")

for SRC in "${SRCS[@]}"; do
  if [ ! -f "$SRC" ]; then
    echo "✗ 找不到 $SRC"
    exit 1
  fi
  NAME="$(basename "$SRC")"
  for DIR in "${DIRS[@]}"; do
    DEST="$DIR/$NAME"
    mkdir -p "$DIR"
    if diff -q "$SRC" "$DEST" >/dev/null 2>&1; then
      echo "== $DEST 已是最新"
    else
      cp "$SRC" "$DEST"
      echo "== 已同步 $SRC -> $DEST"
    fi
  done
done

fail=0
for SRC in "${SRCS[@]}"; do
  NAME="$(basename "$SRC")"
  for DIR in "${DIRS[@]}"; do
    DEST="$DIR/$NAME"
    if ! diff -q "$SRC" "$DEST" >/dev/null 2>&1; then
      echo "✗ $DEST 与 $SRC 不一致"
      fail=1
    fi
  done
done

if [ "$fail" -eq 0 ]; then
  echo "== 共享核心 / 平台适配层 三端一致 ✓"
else
  echo "== ❌ 产物不一致"
fi
exit "$fail"
