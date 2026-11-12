#!/bin/sh
#
# 更新 geo 规则文件。honk 只认 v2ray 的 .dat 格式（protobuf）。
#
#   geoip.dat   <- Loyalsoldier/geoip         （含 cn、private）
#   geosite.dat <- Loyalsoldier/v2ray-rules-dat（含 geolocation-cn、
#                 category-ads-all 等 honk 用到的分类）
#
# 这两个都由 dae 系工具直接吃，不需要再转换。
set -u

GEO_DIR="$(uci -q get honk.infra.geo_asset_dir)"
[ -n "$GEO_DIR" ] || GEO_DIR="/usr/share/honk/geo"

GEOIP_URL="https://github.com/Loyalsoldier/geoip/releases/latest/download/geoip.dat"
GEOSITE_URL="https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat"

mkdir -p "$GEO_DIR" || { echo "cannot create $GEO_DIR"; exit 1; }

failed=0

fetch() {
	url="$1"
	out="$2"
	tmp="$out.tmp"

	echo "fetching $(basename "$out")"
	if ! curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 180 \
			-o "$tmp" "$url"; then
		echo "  download failed"
		rm -f "$tmp"
		failed=$((failed + 1))
		return 1
	fi

	size="$(wc -c < "$tmp" 2>/dev/null || echo 0)"
	if [ "$size" -lt 1024 ]; then
		echo "  rejected: only $size bytes, looks like an error page"
		rm -f "$tmp"
		failed=$((failed + 1))
		return 1
	fi

	# .dat 是 protobuf，头几个字节能认出格式；防止拿到 HTML 404 页
	if head -c 15 "$tmp" 2>/dev/null | grep -qi '<!doctype\|<html'; then
		echo "  rejected: got HTML instead of binary"
		rm -f "$tmp"
		failed=$((failed + 1))
		return 1
	fi

	mv "$tmp" "$out"
	echo "  ok: $size bytes -> $out"
}

fetch "$GEOIP_URL" "$GEO_DIR/geoip.dat"
fetch "$GEOSITE_URL" "$GEO_DIR/geosite.dat"

if [ "$failed" -gt 0 ]; then
	echo "done with $failed failure(s)"
	exit 1
fi

echo "all geo assets updated"
