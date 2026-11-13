#!/bin/sh
# beta.6 native API adapter. Each request stays below LuCI's RPC deadline.
set -u
PORT="$(cat /var/run/honk/api-port 2>/dev/null)"
[ -n "$PORT" ] || PORT="$(uci -q get honk.infra.native_api_port)"
[ -n "$PORT" ] || PORT=9527
case "$PORT" in *[!0-9]*) exit 1 ;; esac
BASE="http://127.0.0.1:$PORT/api/v1"
request() { curl --fail-with-body -sS --connect-timeout 2 --max-time 8 "$@"; }
id() {
 case "${1:-}" in ''|*[!a-zA-Z0-9_-]*) echo '{"error":{"message":"Invalid resource ID"}}'; exit 1 ;; esac
}
case "${1:-}" in
 nodes|providers)
  if [ -n "${2:-}" ]; then
   request --get --data-urlencode 'limit=100' --data-urlencode "cursor=$2" "$BASE/$1"
  else
   request "$BASE/$1?limit=100"
  fi ;;
 groups|runtime|config) request "$BASE/$1" ;;
 group) id "${2:-}"; request "$BASE/groups/$2" ;;
 operation) id "${2:-}"; request "$BASE/operations/$2" ;;
 provider-refresh) id "${2:-}"; request -X POST "$BASE/providers/$2/refresh" ;;
 probe) request -H 'Content-Type: application/json' --data-binary "$2" "$BASE/probes" ;;
 select)
  id "${2:-}"
  request -X PUT -H 'Content-Type: application/json' --data-binary "$3" "$BASE/groups/$2/selection" ;;
 clear-selection) id "${2:-}"; request -X DELETE "$BASE/groups/$2/selection?network=both" ;;
 reload) request -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/operations/reload" ;;
 validate)
  ucode -e 'import { readfile } from "fs"; const text = readfile(ARGV[0]); if (text === null) exit(1); print(sprintf("%J", {mode:"full",sources:[{id:"candidate",content:text}]}));' "$2" |
   request -H 'Content-Type: application/json' --data-binary @- "$BASE/config/validate" ;;
 *) echo '{"error":{"message":"Unknown honk API operation"}}'; exit 1 ;;
esac
