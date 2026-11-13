#!/bin/sh
#
# 检测 honk 可用的 Web 面板，并给出入口地址。
#
# 两种来源：
#   doona      挂在 native API 端口上（ui: '/usr/share/doona' 或内嵌）
#   zashboard  基于 Clash API 的第三方面板，独立目录 + 独立端口
#
# 输出 "类型|地址"，前端据此渲染成可点链接。
set -u

# 有些固件里 ipaddr 带掩码（192.168.10.1/24），拼 URL 前要剥掉
LANIP="$(uci -q get network.lan.ipaddr | sed 's|/.*||')"
[ -n "$LANIP" ] || LANIP="127.0.0.1"

API_PORT="$(uci -q get honk.infra.native_api_port)"
[ -n "$API_PORT" ] || API_PORT="9527"

# ---------- doona ----------
# 装了本地目录，或者二进制内嵌（ui: 'embedded'），都挂在 native API 端口
DOONA_DIR="/usr/share/doona"
if [ -f "$DOONA_DIR/index.html" ]; then
	# 只有 API 在跑，UI 才真的能打开
	if curl -sf --connect-timeout 2 --max-time 3 "http://127.0.0.1:${API_PORT}/api" >/dev/null 2>&1; then
		code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 3 \
			"http://127.0.0.1:${API_PORT}/" 2>/dev/null)"
		case "$code" in
			200|301|302|307)
				echo "doona|http://${LANIP}:${API_PORT}/ui/"
				exit 0
				;;
		esac
		echo "doona-installed|"
		exit 0
	fi
	echo "doona-installed|"
	exit 0
fi

# ---------- zashboard / metacubexd / yacd ----------
# 这些都是 Clash API 面板，目录和端口各不相同，按常见位置找
CLASH_PORT=""
CLASH_CFG="$(uci -q get honk.infra.clash_api_port)"
[ -n "$CLASH_CFG" ] && CLASH_PORT="$CLASH_CFG"
[ -n "$CLASH_PORT" ] || CLASH_PORT="9090"

for entry in \
	"/usr/share/zashboard:zashboard" \
	"/www/zashboard:zashboard" \
	"/usr/share/metacubexd:metacubexd" \
	"/www/metacubexd:metacubexd" \
	"/usr/share/yacd:yacd"
do
	dir="${entry%%:*}"
	name="${entry##*:}"
	if [ -f "$dir/index.html" ]; then
		echo "${name}|http://${LANIP}:${CLASH_PORT}/ui/"
		exit 0
	fi
done

# ---------- 都没装 ----------
# 区分一下：API 通说明只是没面板，API 不通说明 honk 都没跑
if curl -sf --connect-timeout 2 --max-time 3 "http://127.0.0.1:${API_PORT}/api" >/dev/null 2>&1; then
	echo "nopanel|"
else
	echo "noapi|"
fi