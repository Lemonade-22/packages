#!/bin/sh
#
# 输出 "<state>|<版本>"，前端据此渲染顶部的运行状态横幅。
#   running  进程在跑
#   stopped  装了但没启动
#   missing  找不到 honk-core
set -u

BIN=""
for p in /usr/bin/honk-core /usr/sbin/honk-core /usr/bin/honk; do
	[ -x "$p" ] && BIN="$p" && break
done

if [ -z "$BIN" ]; then
	echo "missing|"
	exit 0
fi

# 只取纯版本号（去掉 "honk-core " 前缀），前端统一拼前缀，避免出现重复
VER="$($BIN --version 2>/dev/null | head -n 1 | tr -d '\r' | sed 's/^[^ ]* *//')"

if pgrep -f "$(basename "$BIN")" >/dev/null 2>&1; then
	echo "running|$VER"
else
	echo "stopped|$VER"
fi