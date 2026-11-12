#!/bin/sh
#
# 封装 honk 原生 API。前端不直接发 HTTP —— 那样要处理认证和 CORS，
# 而且 rpcd 的 acl 只管 fs.exec，不管 fetch。
#
#   honk-api.sh nodes              列出节点及其测量
#   honk-api.sh groups             列出组及其健康状态
#   honk-api.sh probe <json>       主动探测
#   honk-api.sh select <组> <json> 设置组的 TCP/UDP 选择
#
# 输出原样透传 JSON，解析交给前端。
set -u

PORT="$(uci -q get honk.infra.native_api_port)"
[ -n "$PORT" ] || PORT="9527"
BASE="http://127.0.0.1:${PORT}/api/v1"

CURL_OPTS="-fsS --connect-timeout 3 --max-time 20"

cmd="${1:-}"

case "$cmd" in
	nodes)
		curl $CURL_OPTS "$BASE/nodes"
		;;
	groups)
		curl $CURL_OPTS "$BASE/groups"
		;;
	group)
		[ -n "${2:-}" ] || { echo '{"error":"missing group id"}'; exit 1; }
		curl $CURL_OPTS "$BASE/groups/${2}"
		;;
	probe)
		[ -n "${2:-}" ] || { echo '{"error":"missing json body"}'; exit 1; }
		curl $CURL_OPTS -X POST -H 'Content-Type: application/json' \
			-d "${2}" "$BASE/probes"
		;;
	select)
		[ -n "${2:-}" ] && [ -n "${3:-}" ] || {
			echo '{"error":"usage: select <group> <json>"}'
			exit 1
		}
		curl $CURL_OPTS -X PUT -H 'Content-Type: application/json' \
			-d "${3}" "$BASE/groups/${2}/selection"
		;;
	runtime)
		curl $CURL_OPTS "$BASE/runtime?detail=summary"
		;;
	*)
		echo '{"error":"usage: honk-api.sh nodes|groups|group <id>|probe <json>|select <group> <json>|runtime"}'
		exit 1
		;;
esac
