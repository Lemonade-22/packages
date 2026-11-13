#!/bin/sh
#
# 连通性探测：逐个站点发 HEAD 请求，输出 "key|ok|毫秒" 或 "key|fail|错误"。
# 前端拿 stdout 解析后填表。honk 本身没有这类 RPC，用脚本最直接。
set -u

SITES="baidu https://www.baidu.com/
bilibili https://www.bilibili.com/
jd https://www.jd.com/
google https://www.google.com/
github https://github.com/
youtube https://www.youtube.com/"

printf '%s\n' "$SITES" | while IFS=' ' read -r key url; do
	[ -n "$key" ] || continue

	# curl -w 输出总耗时（秒），转成毫秒
	if out="$(curl -sS -o /dev/null -w '%{time_total}' \
			--connect-timeout 5 --max-time 8 "$url" 2>&1)"; then
		ms="$(awk -v t="$out" 'BEGIN { printf "%d", t * 1000 }')"
		echo "$key|ok|$ms"
	else
		err="$(printf '%s' "$out" | tr '|\n' '  ' | cut -c1-60)"
		echo "$key|fail|$err"
	fi
done