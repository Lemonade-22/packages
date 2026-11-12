#!/bin/sh
#
# 下载订阅并解析成 honk 节点。
#
# 支持：
#   1. 纯链接列表（一行一个 vless:// vmess:// ss:// ssr:// ...）
#   2. base64 包一层的同款列表（v2ray 系订阅常见）
#   3. Clash YAML（proxies: 列表）——用 awk 抽字段拼回 URI
#
# BusyBox 没编 base64，用 openssl 解。
set -u

CONF="honk"
PROTO="(vless|vmess|trojan|hysteria2?|tuic|ss|ssr|anytls|juicity|socks5)"

sections="$(uci show "$CONF" 2>/dev/null | sed -n "s/^$CONF\.\([^.=]*\)=subscription$/\1/p")"
[ -n "$sections" ] || { echo "no subscriptions configured"; exit 1; }

b64decode() {
	command -v openssl >/dev/null 2>&1 || return 1
	openssl base64 -d -A < "$1" 2>/dev/null
}

total=0
for s in $sections; do
	[ "$(uci -q get "$CONF.$s.enabled")" = "1" ] || { echo "skip $s: disabled"; continue; }

	url="$(uci -q get "$CONF.$s.url")"
	tag="$(uci -q get "$CONF.$s.tag")"
	[ -n "$url" ] || { echo "skip $s: no url"; continue; }
	[ -n "$tag" ] || tag="$s"

	tmp="/tmp/honk-sub.$$"
	links="$tmp.links"

	echo "fetching $url"
	if ! curl -fsSL --retry 2 --retry-delay 1 --connect-timeout 15 -o "$tmp" "$url"; then
		echo "  download failed"
		rm -f "$tmp"
		continue
	fi

	: > "$links"

	if grep -qE "$PROTO://" "$tmp" 2>/dev/null; then
		echo "  format: plain links"
		grep -oE "$PROTO://[^[:space:]]+" "$tmp" >> "$links" 2>/dev/null || true
	elif grep -qE '^(proxies|Proxy):' "$tmp" 2>/dev/null; then
		echo "  format: clash yaml"
		awk -v RS='\n' '
		/^ *- *name:/ { n=$0; sub(/^ *- *name: */, "", n); gsub(/"/, "", n); name=n }
		/^ +type:/    { t=$0; sub(/^ +type: */, "", t); gsub(/"/, "", t); type=t }
		/^ +server:/  { v=$0; sub(/^ +server: */, "", v); gsub(/"/, "", v); server=v }
		/^ +port:/    { v=$0; sub(/^ +port: */, "", v); gsub(/"/, "", v); port=v }
		/^ +cipher:/  { v=$0; sub(/^ +cipher: */, "", v); gsub(/"/, "", v); cipher=v }
		/^ +password:/{ v=$0; sub(/^ +password: */, "", v); gsub(/"/, "", v); password=v }
		/^ +servername:/ { v=$0; sub(/^ +servername: */, "", v); gsub(/"/, "", v); sni=v }
		/^ *- *\{/ && server != "" {
			if (type == "ss")
				printf "ss://%s:%s@%s:%s#%s\n", cipher, password, server, port, name
			else if (type == "trojan")
				printf "trojan://%s@%s:%s?sni=%s#%s\n", password, server, port, sni, name
			server=""; type=""; port=""; cipher=""; password=""; sni=""; name=""
		}' "$tmp" >> "$links" 2>/dev/null || true
	else
		if b64decode "$tmp" > "$tmp.dec" && grep -qE "$PROTO://" "$tmp.dec" 2>/dev/null; then
			echo "  format: base64"
			grep -oE "$PROTO://[^[:space:]]+" "$tmp.dec" >> "$links" 2>/dev/null || true
		else
			echo "  unrecognised format, nothing imported"
			rm -f "$tmp" "$tmp.dec"
			continue
		fi
	fi

	removed=0
	for n in $(uci show "$CONF" 2>/dev/null | sed -n "s/^$CONF\.\([^.=]*\)=node$/\1/p"); do
		nm="$(uci -q get "$CONF.$n.name")"
		case "$nm" in
			"$tag"/*) uci -q delete "$CONF.$n"; removed=$((removed + 1)) ;;
		esac
	done
	[ "$removed" -gt 0 ] && echo "  removed $removed old nodes"

	idx=0
	while IFS= read -r link; do
		[ -n "$link" ] || continue
		idx=$((idx + 1))
		sid="sub_${s}_${idx}"
		uci -q delete "$CONF.$sid"
		uci set "$CONF.$sid=node"
		uci -q set "$CONF.$sid.enabled=1"
		uci -q set "$CONF.$sid.name=${tag}/${idx}"
		uci -q set "$CONF.$sid.uri=$link"
	done < "$links"

	echo "  imported $idx nodes"
	total=$((total + idx))
	rm -f "$tmp" "$links" "$tmp.dec"
done

uci commit "$CONF"
echo "done: $total nodes imported"
