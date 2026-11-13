#!/bin/sh
#
# 检测 honk 自带面板（doona）是否可用。
#
# honk 的 UI 有两种来源：
#   ui: 'embedded'  由二进制内嵌（需要 native-ui feature）
#   ui: '/path'     指向含 index.html 的本地目录
# 二者都挂在 native API 那个端口上，所以直接探 HTTP 最准。
#
# 输出 "状态|详情"，前端据此渲染。
set -u

PORT="$(uci -q get honk.infra.native_api_port)"
[ -n "$PORT" ] || PORT="9527"
BASE="http://127.0.0.1:${PORT}"

# 1. API 都没在听，后面不用问了
if ! curl -sf --connect-timeout 2 --max-time 3 "$BASE/api" >/dev/null 2>&1; then
	echo "noapi|"
	exit 0
fi

# 2. 探根路径。UI 可用时是 200，或者 307 跳到一个真实地址
code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 3 "$BASE/" 2>/dev/null)"
loc="$(curl -s -o /dev/null -w '%{redirect_url}' --connect-timeout 2 --max-time 3 "$BASE/" 2>/dev/null)"

case "$code" in
	200)
		lanip="$(uci -q get network.lan.ipaddr)"
		[ -n "$lanip" ] || lanip="127.0.0.1"
		echo "ok|http://${lanip}:${PORT}/"
		;;
	307|301|302)
		if [ -n "$loc" ]; then
			lanip="$(uci -q get network.lan.ipaddr)"
			[ -n "$lanip" ] || lanip="127.0.0.1"
			echo "ok|http://${lanip}:${PORT}/"
		else
			# 307 但没有 Location：二进制没带 native-ui，ui 配置被忽略
			echo "nobuiltin|$code"
		fi
		;;
	*)
		echo "nobuiltin|$code"
		;;
esac
