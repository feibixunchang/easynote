#!/usr/bin/env bash
# ============================================================
# 网页版「产物化」：把桌面端 app.js（共享逻辑的唯一来源）同步到 server/web/
# ------------------------------------------------------------
# 为什么需要：网页版 app.js 与桌面端本应完全一致（网页版是桌面前端的一份产物）。
# 以前靠手工复制，容易忘 → 出现「桌面修好了、网页还是旧代码」。
# 现在统一由本脚本生成，并由 tools/parity-check.sh 在 CI 里强制校验。
#
# 用法：
#   bash tools/build-web.sh              # 只在 app.js 有变化时同步（并自动升 SW 缓存版本）
#   bash tools/build-web.sh --bump-sw    # 强制升一次 Service Worker 缓存版本
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

# 先同步共享核心（网页版需要自己的那份 shared/core.js）
if [ -x tools/build-shared.sh ]; then bash tools/build-shared.sh >/dev/null 2>&1 || true; fi

SRC="app.js"
DEST="server/web/app.js"
SW="server/web/sw.js"
BUMP_FORCE=0
if [ "${1:-}" = "--bump-sw" ]; then
  BUMP_FORCE=1
fi

bump_sw() {
  local cur new
  cur="$(grep -oE 'easynote-web-v[0-9]+' "$SW" 2>/dev/null | head -1 | grep -oE '[0-9]+$' || true)"
  if [ -z "${cur:-}" ]; then
    echo "== sw.js 未找到 CACHE 版本号，跳过"
    return 0
  fi
  new=$((cur + 1))
  perl -pi -e "s/easynote-web-v$cur/easynote-web-v$new/" "$SW"
  echo "== sw.js 缓存版本：v$cur → v$new（已装 PWA 下次打开即取新代码）"
}

changed=0
if diff -q "$SRC" "$DEST" >/dev/null 2>&1; then
  echo "== app.js 与网页版已一致，无需同步"
else
  cp "$SRC" "$DEST"
  changed=1
  echo "== 已同步 app.js → $DEST（$(wc -c < "$DEST" | tr -d ' ') 字节）"
fi

if [ "$changed" -eq 1 ] || [ "$BUMP_FORCE" -eq 1 ]; then
  bump_sw
fi

echo ""
echo "== 平台差异检查（预期内，仅供确认）=="
for f in index.html styles.css; do
  if diff -q "$f" "server/web/$f" >/dev/null 2>&1; then
    echo "   $f   与桌面端一致"
  else
    echo "   $f   与桌面端不同（网页版 PWA 定制，属预期）"
  fi
done

echo ""
if bash tools/parity-check.sh >/dev/null 2>&1; then
  echo "== 三端一致性守卫通过 ✓"
else
  echo "== ⚠ 三端一致性守卫未通过，请运行 bash tools/parity-check.sh 查看详情"
  exit 1
fi
