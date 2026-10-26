#!/usr/bin/env bash
# ============================================================
# 一键质量检查（本地版 CI）
# ------------------------------------------------------------
# 等价于 .github/workflows/qa.yml 里跑的检查，可在提交前本地自测：
#   1) 语法检查（三端前端 + 桌面主进程 + 服务端）
#   2) 服务端同步回归测试（server/test-sync.js）
#   3) 三端一致性守卫（tools/parity-check.sh）
#
# 用法：bash tools/qa.sh
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

fail=0

echo "== 1/3 语法检查 =="
for f in app.js mobile/www/app.js server/web/app.js shared/core.js main.js preload.js updater.js server/server.js server/test-sync.js tools/test-core.js; do
  if node --check "$f" >/dev/null 2>&1; then
    echo "   ✓ $f"
  else
    echo "   ✗ $f"
    node --check "$f"
    fail=1
  fi
done

echo ""
echo "== 2/3 服务端同步回归测试 =="
if (cd server && node test-sync.js | tail -3); then
  echo "   ✓ 通过"
else
  echo "   ✗ 未通过"
  fail=1
fi

echo ""
echo "== 3/3 三端一致性守卫 =="
if bash tools/parity-check.sh | tail -3; then
  echo "   ✓ 通过"
else
  echo "   ✗ 未通过"
  fail=1
fi

echo ""
echo "== 共享核心单元测试 =="
if node tools/test-core.js | tail -3; then
  echo "   ✓ 通过"
else
  echo "   ✗ 未通过"
  fail=1
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "✅ 全部检查通过，可以提交"
else
  echo "❌ 有检查未通过，请先修复"
fi
exit "$fail"
