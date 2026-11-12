#!/bin/sh
#
# 下载广告域名列表到 /etc/honk/adblock.list。
#
# honk 的 DNS 规则读的是本地文件，不会自己联网，所以拉取这一步必须外置。
# 下载来的列表格式五花八门（AdGuard 语法、hosts、纯域名），这里统一过滤成
# 一行一个纯域名——生成器只认这个。
set -u

SRC="$(uci -q get honk.infra.ad_block_source)"
URL="$(uci -q get honk.infra.ad_block_url)"
FILE="$(uci -q get honk.infra.ad_block_file)"
[ -n "$FILE" ] || FILE="/etc/honk/adblock.list"

case "$SRC" in
  anti-ad) URL="https://anti-ad.net/domains.txt" ;;
  adrules) URL="https://adrules.top/adblock.txt" ;;
  custom) : ;;
  *)
    echo "no source selected (ad_block_source=$SRC)"
    exit 1
    ;;
esac

[ -n "$URL" ] || { echo "custom source selected but ad_block_url is empty"; exit 1; }

TMP="/tmp/honk-adblock.$$"
trap 'rm -f "$TMP"' EXIT

echo "fetching $URL"
curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$TMP" "$URL" || {
  echo "download failed" >&2
  exit 1
}

# 统一过滤：去注释、去 AdGuard 语法、去 hosts 行首 IP，只留纯域名
grep -vE '^[[:space:]]*(#|!|\[)' "$TMP" \
  | grep -vE '^(@@|/)' \
  | sed -e 's/\r$//' \
        -e 's/^||//' \
        -e 's/\^.*$//' \
        -e 's/^[0-9.]*[[:space:]]\+//' \
        -e 's/^\*\.//' \
        -e 's/^[[:space:]]*//' \
        -e 's/[[:space:]].*$//' \
  | grep -E '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' \
  | grep -v '^localhost$' \
  | sort -u > "$FILE"

N="$(wc -l < "$FILE")"
echo "wrote $N domains to $FILE"

if [ "$N" -eq 0 ]; then
  echo "result is empty; check the source format" >&2
  exit 1
fi
