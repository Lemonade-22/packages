#!/bin/sh
#
# 下载广告域名列表到 /etc/honk/adblock.list。
#
# honk 的 DNS 规则读的是本地文件，不会自己联网，所以拉取这一步必须外置。
# 下载来的列表格式五花八门（AdGuard 语法、hosts、纯域名），这里统一过滤成
# 一行一个纯域名——生成器只认这个。
set -u

FILE="$(uci -q get honk.infra.ad_block_file)"
[ -n "$FILE" ] || FILE="/etc/honk/adblock.list"

# ad_block_source 是 UCI list，每项一个 URL。geosite.dat 表示用内置分类，
# 不需要下载，跳过；取第一个真正的 URL。
TMP="/tmp/honk-adblock.$$"
NEW="$FILE.new.$$"
trap 'rm -f "$TMP" "$TMP.part" "$NEW"' EXIT
mkdir -p "$(dirname "$FILE")" || exit 1
: > "$TMP"
count=0
for src in $(uci -q get honk.infra.ad_block_source); do
 case "$src" in
  geosite.dat|geosite) continue ;;
  http://*|https://*|file://*) ;;
  *) echo "unsupported source" >&2; exit 1 ;;
 esac
 echo "fetching source $((count + 1))"
 curl -fsSL --retry 2 --retry-delay 2 --connect-timeout 15 --max-time 120 -o "$TMP.part" "$src" || exit 1
 cat "$TMP.part" >> "$TMP"
 printf '\n' >> "$TMP"
 count=$((count + 1))
done
[ "$count" -gt 0 ] || { echo "no downloadable source configured" >&2; exit 1; }

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
  | sort -u > "$NEW"

N="$(wc -l < "$NEW")"
echo "wrote $N domains to $FILE"

if [ "$N" -eq 0 ]; then
  echo "result is empty; check the source format" >&2
  exit 1
fi
mv "$NEW" "$FILE" || exit 1
