#!/usr/bin/env bash
# ============================================================
# 三端一致性守卫（桌面 / 移动 / 网页版）
# ------------------------------------------------------------
# 背景：本仓库有三份前端副本：
#   1) 桌面端（Electron）      : ./app.js          （+ index.html / styles.css）
#   2) 移动端（Capacitor/iOS 安卓）: ./mobile/www/app.js
#   3) 网页版（服务器托管）      : ./server/web/app.js
# 它们历史上有过"各自修改、互不同步"的问题：在桌面修了 bug，手机端却没修。
#
# 这个脚本做两件事：
#   A. 巡检「协议 / 同步核心」相关标识是否三端都存在——少一个就报错退出（非 0）。
#      以后任何人只改一端，CI 或本地跑一下就会立刻发现漏改。
#   B. 打印三端差异概览（行数 / 独有行数），供人工评估分叉程度。
#
# 用法：bash tools/parity-check.sh
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

DESKTOP="app.js"
MOBILE="mobile/www/app.js"
WEB="server/web/app.js"

FILES=("$DESKTOP" "$MOBILE" "$WEB")
NAMES=("桌面端" "移动端" "网页版")

fail=0
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then echo "✗ 找不到 $f"; fail=1; fi
done
[ "$fail" -ne 0 ] && exit 1

# ---------- A. 协议 / 同步核心标识：三端必须都有 ----------
# 这些是"跨端契约"：任何一端缺了，多端同步就会出问题（丢改动 / 复活已删笔记 / 冲突丢失）。
TOKENS=(
  "SINCE_KEY"                 # 增量游标存储键
  "PUSHED_KEY"                # 各笔记已推送时间（避免重复推送 / 丢推送）
  "PURGE_KEY"                 # 墓碑（永久删除）本地记录
  "TOTAL_KEY"                 # 服务端笔记总数（用于"缩水恢复"）
  "/api/notes/sync"           # 同步接口
  "/api/notes/purge"          # 永久删除上报
  "isValidNoteId"             # 笔记 id 合法性校验（防原型污染）
  "extractTags"               # 标签提取（共享核心）
  "mergeIncoming"             # 同步合并 + 冲突副本（共享核心）
  "mergeNotes"                # 合并服务端增量
  "applySyncResponse"         # 应用同步响应
  "notesToPush"               # 计算待推送
  "markPushedAfterRound"      # 确认已推送
  "recoverFromShrink"         # 服务端数据缩水恢复
  "filterPurged"              # 用墓碑过滤已删笔记
  "purgeOnServer"             # 上报永久删除
)

echo "== A. 协议/同步核心一致性 =="
for t in "${TOKENS[@]}"; do
  miss=""
  for i in "${!FILES[@]}"; do
    if ! grep -q -- "$t" "${FILES[$i]}" 2>/dev/null; then miss="$miss ${NAMES[$i]}"; fi
  done
  if [ -n "$miss" ]; then
    echo "  ✗ $t  → 缺失:$miss"
    fail=1
  else
    printf '  ✓ %-22s 三端齐全\n' "$t"
  fi
done

# ---------- A2. 共享核心必须包含纯函数（三端共用）----------
echo ""
echo "== A2. 共享核心纯函数 =="
CORE_FUNCS=("isValidNoteId" "extractTags" "mergeIncoming" "makeConflictCopy" "noteTitle" "noteSnippet" "searchText" "isImageOnly")
for t in "${CORE_FUNCS[@]}"; do
  if grep -q "function $t(" shared/core.js 2>/dev/null; then
    printf '  ✓ %-16s 已在 shared/core.js\n' "$t"
  else
    echo "  ✗ $t 未在 shared/core.js 中定义"
    fail=1
  fi
done

# ---------- B. 网页版应与桌面端 app.js 完全一致（它是构建产物） ----------
echo ""
echo "== B. 网页版 app.js 是否与桌面端一致 =="
if diff -q "$DESKTOP" "$WEB" >/dev/null 2>&1; then
  echo "  ✓ server/web/app.js 与桌面端 app.js 完全一致"
else
  echo "  ✗ server/web/app.js 与桌面端 app.js 不一致（网页版应由桌面端复制生成：cp app.js server/web/app.js）"
  fail=1
fi

# ---------- C. 差异概览（仅供参考） ----------
echo ""
echo "== C. 三端差异概览（人工评估分叉程度） =="
for i in "${!FILES[@]}"; do
  printf '  %-8s %s 行 / %s 字节\n' "${NAMES[$i]}" "$(wc -l < "${FILES[$i]}" | tr -d ' ')" "$(wc -c < "${FILES[$i]}" | tr -d ' ')"
done
only_d=$(diff "$DESKTOP" "$MOBILE" 2>/dev/null | grep -c "^<")
only_m=$(diff "$DESKTOP" "$MOBILE" 2>/dev/null | grep -c "^>")
echo "  桌面 vs 移动：桌面独有 ${only_d} 行，移动独有 ${only_m} 行"
echo "  （这两端仍有大量历史分叉，属已知技术债；同步/协议相关逻辑已由上面 A 强制对齐）"

# ---------- D. 共享核心 shared/core.js（纯函数唯一来源） ----------
echo ""
echo "== D. 共享核心 shared/core.js =="
CORE="shared/core.js"
if [ -f "$CORE" ]; then
  for d in mobile/www/shared/core.js server/web/shared/core.js; do
    if [ -f "$d" ] && diff -q "$CORE" "$d" >/dev/null 2>&1; then
      echo "  ✓ $d 与 shared/core.js 一致"
    else
      echo "  ✗ $d 缺失或与 shared/core.js 不一致（运行 bash tools/build-shared.sh）"
      fail=1
    fi
  done
  for h in index.html mobile/www/index.html server/web/index.html; do
    if grep -q 'shared/core.js' "$h"; then
      echo "  ✓ $h 已引入 shared/core.js"
    else
      echo "  ✗ $h 未引入 shared/core.js（必须排在 app.js 之前）"
      fail=1
    fi
  done
else
  echo "  ✗ 找不到 shared/core.js"
  fail=1
fi

# platform.js（平台适配层）同样三端一致
# lock.js（密码解锁）同样三端一致
if [ -f "shared/lock.js" ]; then
  for d in mobile/www/shared/lock.js server/web/shared/lock.js; do
    if [ -f "$d" ] && diff -q "shared/lock.js" "$d" >/dev/null 2>&1; then
      echo "  ✓ $d 与 shared/lock.js 一致"
    else
      echo "  ✗ $d 缺失或与 shared/lock.js 不一致（运行 bash tools/build-shared.sh）"
      fail=1
    fi
  done
  for h in index.html mobile/www/index.html server/web/index.html; do
    if grep -q 'shared/lock.js' "$h"; then
      echo "  ✓ $h 已引入 shared/lock.js"
    else
      echo "  ✗ $h 未引入 shared/lock.js（必须排在 app.js 之前）"
      fail=1
    fi
  done
else
  echo "  ✗ 找不到 shared/lock.js"
  fail=1
fi

if [ -f "shared/platform.js" ]; then
  for d in mobile/www/shared/platform.js server/web/shared/platform.js; do
    if [ -f "$d" ] && diff -q "shared/platform.js" "$d" >/dev/null 2>&1; then
      echo "  ✓ $d 与 shared/platform.js 一致"
    else
      echo "  ✗ $d 缺失或与 shared/platform.js 不一致（运行 bash tools/build-shared.sh）"
      fail=1
    fi
  done
  for h in index.html mobile/www/index.html server/web/index.html; do
    if grep -q 'shared/platform.js' "$h"; then
      echo "  ✓ $h 已引入 shared/platform.js"
    else
      echo "  ✗ $h 未引入 shared/platform.js（必须排在 app.js 之前）"
      fail=1
    fi
  done
else
  echo "  ✗ 找不到 shared/platform.js"
  fail=1
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "✅ 一致性检查通过"
else
  echo "❌ 一致性检查未通过：请把缺失的逻辑补齐到三端（协议改动必须三端同改）"
fi
exit "$fail"
