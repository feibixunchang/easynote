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

SRC="shared/core.js"
DESTS=("mobile/www/shared/core.js" "server/web/shared/core.js")

[ -f "$SRC" ] || { echo "✗ 找不到 $SRC"; exit 1; }

for d in "${DESTS[@]}"; do
  mkdir -p "$(dirname "$d")"
  if diff -q "$SRC" "$d" >/dev/null 2>&1; then
    echo "== $d 已是最新"
  else
    cp "$SRC" "$d"
    echo "== 已同步 $SRC → $d"
  fi
done

fail=0
for d in "${DESTS[@]}"; do
  if ! diff -q "$SRC" "$d" >/dev/null 2>&1; then
    echo "✗ $d 与 $SRC 不一致"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "== 共享核心三端一致 ✓"
else
  echo "== ❌ 共享核心三端不一致"
fi
exit "$fail"
